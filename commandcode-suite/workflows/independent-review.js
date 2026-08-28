#!/usr/bin/env node
'use strict'
/**
 * independent-review — review a change through four independent evidentiary
 * bases in parallel, adversarially cross-check every finding, then merge into
 * one ranked report.
 *
 * Usage: node workflows/independent-review.js "the diff on feature/checkout-v2"
 * Env:   CMDC_BIN, CMDC_MODEL, CMDC_AGENT_TIMEOUT_MS
 */
const { log, phase, runAgent, parallel, pipeline } = require('./_runner')

const target = process.argv.slice(2).join(' ') || 'the current working tree'

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
    name: 'code-reviewer',
    refuter: 'qa-engineer',
    brief:
      'Review by reading. Apply your §4 requirement-tracing contamination guard: form the expectation of correct behavior BEFORE reading the diff, then state explicitly if it changed and why. Assign severity (Must Fix / Should Fix / Nit) and confidence (High / Medium / Low) per your §7. Mark any finding that only execution can settle.',
  },
  {
    key: 'behavior',
    name: 'qa-engineer',
    refuter: 'code-reviewer',
    brief:
      'Verify by executing. Never inherit a "tests pass" claim you did not run this session. Label every claim Verified / Falsified / Unverified / Untestable. Load the hazard skills where they apply — concurrency-and-thread-safety, caching-and-invalidation, datetime-correctness — rather than naming a failure mode generically.',
  },
  {
    key: 'security',
    name: 'security-engineer',
    refuter: 'code-reviewer',
    brief:
      'Review mode: findings and direction only, no rewrites. Every finding needs a plausible attack path, affected component, realistic conditions, and meaningful impact. A theoretical weakness with no realistic impact is Informational, not High — do not produce security theater.',
  },
  {
    key: 'performance',
    name: 'performance-engineer',
    refuter: 'qa-engineer',
    brief:
      'Trace the target before measuring (your §3) — the current baseline is not the requirement. No claim without a number; label each Measured / Modeled / Assumed / Unknown. Do not run load tests against anything shared or production-adjacent from inside this workflow.',
  },
]

async function main() {
  log(`review target: ${target}`)

  // ---- Review + per-lens cross-check — no barrier, so a slow lens doesn't
  // gate a fast one (mirrors the original pipeline). ----
  phase('Review')
  const perLens = await pipeline(
    LENSES,
    lens =>
      runAgent({
        name: lens.name,
        schema: FINDINGS_SCHEMA,
        task: `Review ${target}. ${lens.brief}`,
      }),
    // Cross-check immediately per lens.
    (result, lens) =>
      result?.findings?.length
        ? parallel(
            result.findings.map(f => async () => {
              const v = await runAgent({
                name: lens.refuter,
                effort: 'low',
                schema: VERDICT_SCHEMA,
                task: `Attempt to REFUTE this finding using your own evidentiary basis, which is deliberately different from the one that produced it. Default to refuted=true when you cannot substantiate it from actual evidence in the code or from execution.

FINDING (${f.severity}) in ${f.file ?? 'unspecified'}${f.line ? ':' + f.line : ''}
${f.summary}
CLAIMED EVIDENCE: ${f.evidence}`,
              })
              return {
                ...f,
                lens: lens.key,
                // No verdict returned (agent died / stopped) is treated as
                // unrefuted but explicitly flagged, rather than silently dropped.
                refuted: v ? v.refuted : false,
                crossCheck: v ? v.reasoning : 'refuter produced no verdict — finding is UNVERIFIED, not confirmed',
              }
            }),
          )
        : [],
  )

  const all = perLens.flat().filter(Boolean)
  const survived = all.filter(f => !f.refuted)
  log(`${all.length} raw findings, ${survived.length} survived cross-check`)

  if (!survived.length) {
    console.log(JSON.stringify({
      target,
      findings: [],
      summary: `No findings survived adversarial cross-check across ${LENSES.length} independent lenses. ${all.length} candidate findings were refuted.`,
      refutedForAudit: all,
    }, null, 2))
    return
  }

  // ---- Merge. ----
  phase('Merge')
  const merged = await runAgent({
    name: 'code-reviewer',
    task: `Deduplicate and rank these cross-checked findings into one report.

Rules:
- Two lenses reporting the same underlying defect is a STRONGER signal, not a duplicate to delete — merge them and say both methods agreed.
- Rank by blast radius and reversibility, not by which lens found it.
- Security findings keep security-engineer's Critical/High/Medium/Low/Informational scale; everything else uses Must Fix / Should Fix / Nit. Never blend the two scales without labeling which is in use.
- Any finding whose cross-check says "no verdict" is reported as Unverified, never as confirmed.

FINDINGS:
${JSON.stringify(survived, null, 2)}`,
  })

  console.log(JSON.stringify({ target, lensesRun: LENSES.map(l => l.key), findings: survived, report: merged }, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
