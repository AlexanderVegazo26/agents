export const meta = {
  name: 'independent-review',
  description: 'Review a change through four independent evidentiary bases in parallel, adversarially cross-check every finding, then merge into one ranked report',
  whenToUse: 'A completed change (branch, PR, or diff) that needs review deeper than one pass. Pass the target as args — a branch name, path list, or "working tree".',
  phases: [
    { title: 'Review', detail: 'code-reviewer, qa-engineer, security-engineer, performance-engineer in parallel' },
    { title: 'Cross-check', detail: 'each finding handed to a refuter from a different lens' },
    { title: 'Merge', detail: 'dedupe and rank surviving findings by blast radius' },
  ],
}

const target = typeof args === 'string' ? args : args?.target ?? 'the current working tree'

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'summary', 'evidence'],
        properties: {
          severity: { type: 'string' },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          needsExecution: { type: 'boolean' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reasoning'],
  properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
}

// Four lenses, each with a genuinely different evidentiary basis — reading,
// executing, attack-path reasoning, and measurement. Overlap between them is a
// signal (two independent methods agreeing), not duplicated work.
const LENSES = [
  {
    key: 'correctness',
    agentType: 'sdlc-suite:code-reviewer',
    refuter: 'qa-engineer',
    brief:
      'Review by reading. Apply your §4 requirement-tracing contamination guard: form the expectation of correct behavior BEFORE reading the diff, then state explicitly if it changed and why. Assign severity (Must Fix / Should Fix / Nit) and confidence (High / Medium / Low) per your §7. Mark any finding that only execution can settle.',
  },
  {
    key: 'behavior',
    agentType: 'sdlc-suite:qa-engineer',
    refuter: 'code-reviewer',
    brief:
      'Verify by executing. Never inherit a "tests pass" claim you did not run this session. Label every claim Verified / Falsified / Unverified / Untestable. Load the hazard skills where they apply — concurrency-and-thread-safety, caching-and-invalidation, datetime-correctness — rather than naming a failure mode generically.',
  },
  {
    key: 'security',
    agentType: 'sdlc-suite:security-engineer',
    refuter: 'code-reviewer',
    brief:
      'Review mode: findings and direction only, no rewrites. Every finding needs a plausible attack path, affected component, realistic conditions, and meaningful impact. A theoretical weakness with no realistic impact is Informational, not High — do not produce security theater.',
  },
  {
    key: 'performance',
    agentType: 'sdlc-suite:performance-engineer',
    refuter: 'qa-engineer',
    brief:
      'Trace the target before measuring (your §3) — the current baseline is not the requirement. No claim without a number; label each Measured / Modeled / Assumed / Unknown. Do not run load tests against anything shared or production-adjacent from inside this workflow.',
  },
]

phase('Review')
const perLens = await pipeline(
  LENSES,
  lens =>
    agent(`Review ${target}. ${lens.brief}`, {
      agentType: lens.agentType,
      label: `review:${lens.key}`,
      phase: 'Review',
      schema: FINDINGS_SCHEMA,
    }),
  // Cross-check immediately per lens — no barrier, so a slow lens doesn't gate a fast one.
  (result, lens) =>
    result?.findings?.length
      ? parallel(
          result.findings.map(f => () =>
            agent(
              `Attempt to REFUTE this finding using your own evidentiary basis, which is deliberately different from the one that produced it. Default to refuted=true when you cannot substantiate it from actual evidence in the code or from execution.

FINDING (${f.severity}) in ${f.file ?? 'unspecified'}${f.line ? ':' + f.line : ''}
${f.summary}
CLAIMED EVIDENCE: ${f.evidence}`,
              {
                agentType: lens.refuter,
                label: `refute:${lens.key}`,
                phase: 'Cross-check',
                effort: 'low',
                schema: VERDICT_SCHEMA,
              },
            ).then(v => ({
              ...f,
              lens: lens.key,
              // No verdict returned (agent died / stopped) is treated as unrefuted
              // but explicitly flagged, rather than silently dropped either way.
              refuted: v ? v.refuted : false,
              crossCheck: v ? v.reasoning : 'refuter produced no verdict — finding is UNVERIFIED, not confirmed',
            })),
          ),
        )
      : [],
)

const all = perLens.flat().filter(Boolean)
const survived = all.filter(f => !f.refuted)
log(`${all.length} raw findings, ${survived.length} survived cross-check`)

if (!survived.length) {
  return {
    target,
    findings: [],
    summary: `No findings survived adversarial cross-check across ${LENSES.length} independent lenses. ${all.length} candidate findings were refuted.`,
    refutedForAudit: all,
  }
}

phase('Merge')
const merged = await agent(
  `Deduplicate and rank these cross-checked findings into one report.

Rules:
- Two lenses reporting the same underlying defect is a STRONGER signal, not a duplicate to delete — merge them and say both methods agreed.
- Rank by blast radius and reversibility, not by which lens found it.
- Security findings keep security-engineer's Critical/High/Medium/Low/Informational scale; everything else uses Must Fix / Should Fix / Nit. Never blend the two scales without labeling which is in use.
- Any finding whose cross-check says "no verdict" is reported as Unverified, never as confirmed.

FINDINGS:
${JSON.stringify(survived, null, 2)}`,
  { agentType: 'sdlc-suite:code-reviewer', label: 'merge', phase: 'Merge' },
)

return { target, lensesRun: LENSES.map(l => l.key), findings: survived, report: merged }
