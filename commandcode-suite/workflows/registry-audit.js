#!/usr/bin/env node
'use strict'
/**
 * registry-audit — re-run the registry audit as a repeatable check: schema
 * validation, orphan detection, overlap analysis, and tech-agnosticism, with
 * every finding adversarially verified. Audits the commandcode-suite by
 * default; pass a different root as the first argument.
 *
 * Usage: node workflows/registry-audit.js [registry root, defaults to this suite]
 * Env:   CMDC_BIN, CMDC_MODEL, CMDC_AGENT_TIMEOUT_MS
 */
const { SUITE_ROOT, log, phase, runAgent, parallel, pipeline } = require('./_runner')

// Accept a bare string like the other workflows do. The port's own suite is the
// default root — this audits the port, not the project you happen to be in.
const root = process.argv.slice(2).join(' ').trim() || SUITE_ROOT
log(`auditing registry root: ${root}`)

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'severity', 'summary', 'path', 'evidence'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'] },
          summary: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'number' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
  },
}

// The dimensions mirror the phases of the original audit. Each one is a
// read-only pass with an explicit "no evidence, no finding" instruction —
// the failure mode of an automated audit is padding, not missing things.
const DIMENSIONS = [
  {
    key: 'schema',
    brief: `Validate every agent and skill under ${root}.
- Agent frontmatter parses; name is kebab-case, unique, matches filename stem.
- Any tool listed in \`tools:\` is a real Command Code tool name, and is least-privilege for the agent's stated job. Flag write/exec granted to an agent whose description claims read-only.
- Any agent whose body instructs delegating to another agent must be able to do so — in Command Code the delegation mechanism is the task tool dispatching by subagent name, so the referenced agent must exist under agents/ or be a built-in (general, explore, plan, review). A prose delegation instruction with no reachable target is unimplementable.
- Skills have name + description, and description carries explicit negative scope ("Do NOT use for...").
- Every referenced sibling file, template, and path actually resolves on disk.`,
  },
  {
    key: 'orphans',
    brief: `Find unreachable artifacts under ${root}.
- A skill named in backticks by NO agent body is an orphan: skills do not reliably description-auto-match inside a subagent, so an unnamed skill cannot be relied on to load.
- An agent referenced by no other agent and named in no workflow is an orphan.
- Any agent, skill, or file referenced BY NAME that does not exist is a dangling reference.
Report exact counts, and list every orphan by name — do not summarize as "a few".`,
  },
  {
    key: 'overlap',
    brief: `Analyze overlap under ${root} from artifact BODIES, not names.
Classify each overlapping pair MERGE / SPLIT / DELINEATE / DEMOTE.
Critically: a pair that already states its own boundary in its own text is CORRECTLY DELINEATED — report it as fine, not as a finding. Only flag genuine near-duplicate content. Prefer recommending deletion or merging over addition; a smaller sharper registry is the goal. Do not manufacture overlap to pad the report.`,
  },
  {
    key: 'agnosticism',
    brief: `Audit ${root} for hardcoded stack coupling.
Flag: absolute paths, paths containing a username, vendor CLIs, cloud providers, CI systems, package managers, shell-specific syntax, client/tenant/employer names, secrets or tokens (report location, REDACT the value).
Distinguish coupled-by-accident from coupled-by-purpose: a skill that is legitimately ABOUT a named tool, or a stack-DETECTION table that names tools as examples of what to detect, is correct as written and is not a finding.`,
  },
  {
    key: 'consistency',
    brief: `Check cross-artifact consistency under ${root}.
- Do two agents describe the same boundary between them differently? (e.g. one claims it owns decisions the other also claims.)
- Is a memory path, section citation (§N), or evidence-classification vocabulary referenced inconsistently across agents?
- Does any agent cite a section number in another agent that does not exist or means something else there?
These silent disagreements are the highest-value findings in a mature registry.`,
  },
]

async function main() {
  // ---- Dimensions. ----
  phase('Dimensions')
  const results = await pipeline(
    DIMENSIONS,
    d =>
      runAgent({
        name: 'general',
        schema: FINDINGS_SCHEMA,
        task: `You are auditing a Command Code agent/skill registry, read-only. Do not modify any file.

${d.brief}

Every finding MUST carry path:line evidence. If you cannot cite evidence, DROP the finding — do not infer, extrapolate, or fill gaps with plausible defaults. Report what is genuinely fine as fine. A short honest audit beats a long padded one.`,
      }),
    // Verify each finding immediately rather than waiting for all dimensions.
    (result, d) =>
      result?.findings?.length
        ? parallel(
            result.findings.map(f => async () => {
              const v = await runAgent({
                name: 'general',
                effort: 'low',
                schema: {
                  type: 'object',
                  required: ['confirmed', 'reasoning'],
                  properties: { confirmed: { type: 'boolean' }, reasoning: { type: 'string' } },
                },
                task: `Verify this audit finding by reading the cited file yourself. Set confirmed=false if the evidence does not actually support the claim, if the cited path or line does not exist, or if the "problem" is intentional and correct as written.

Be skeptical: audit agents over-report. Default to confirmed=false when uncertain.

FINDING [${f.severity}] ${f.id}: ${f.summary}
CITED AT: ${f.path}${f.line ? ':' + f.line : ''}
CLAIMED EVIDENCE: ${f.evidence}`,
              })
              return { ...f, dimension: d.key, confirmed: v?.confirmed === true, verifyNote: v?.reasoning }
            }),
          )
        : [],
  )

  const all = results.flat().filter(Boolean)
  const confirmed = all.filter(f => f.confirmed)
  const dropped = all.filter(f => !f.confirmed)
  log(`${confirmed.length} findings confirmed, ${dropped.length} dropped on verification`)

  const bySeverity = s => confirmed.filter(f => f.severity === s)

  // ---- Report. ----
  phase('Report')
  const report = await runAgent({
    name: 'general',
    task: `Write the audit register from these VERIFIED findings only.

Lead with the count of BLOCKER findings. Group by severity. Every entry: id, severity, path:line, impact, concrete fix. Then a short "verified clean" section listing what was checked and found genuinely fine — that section is not filler, it is what makes the findings trustworthy.

Note explicitly that ${dropped.length} candidate findings were dropped because verification could not substantiate them.

VERIFIED FINDINGS:
${JSON.stringify(confirmed, null, 2)}`,
  })

  console.log(JSON.stringify({
    root,
    totals: {
      blocker: bySeverity('BLOCKER').length,
      high: bySeverity('HIGH').length,
      medium: bySeverity('MEDIUM').length,
      low: bySeverity('LOW').length,
      droppedOnVerification: dropped.length,
    },
    findings: confirmed,
    report,
  }, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
