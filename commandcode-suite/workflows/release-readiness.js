#!/usr/bin/env node
'use strict'
/**
 * release-readiness — collect every release gate in parallel from the agent
 * that owns it, then have release-manager synthesize an evidence-classified
 * go/no-go recommendation. Produces a RECOMMENDATION only.
 *
 * Usage: node workflows/release-readiness.js "release 2.4.0"
 * Env:   CMDC_BIN, CMDC_MODEL, CMDC_AGENT_TIMEOUT_MS
 */
const { log, phase, runAgent, parallel } = require('./_runner')

const release = process.argv.slice(2).join(' ') || 'the pending release on the current branch'

const GATE_SCHEMA = {
  type: 'object',
  required: ['gate', 'status', 'evidence'],
  properties: {
    gate: { type: 'string' },
    // Mirrors release-manager's own vocabulary so nothing needs translating.
    status: { type: 'string', enum: ['Confirmed', 'Claimed-not-verified', 'Missing', 'N/A'] },
    evidence: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

// Each gate is answered by the agent that actually owns it. None of them can
// declare the release ready — they report evidence; release-manager classifies.
const GATES = [
  {
    key: 'engineering',
    name: 'solution-architect',
    brief:
      'Architectural sign-off for this release. Was a Tier 2+ structural decision in play, and does the implementation follow the intended design? Scope this to architectural alignment only — code review is code-reviewer\'s, not yours to redo.',
  },
  {
    key: 'quality',
    name: 'qa-engineer',
    brief:
      'Quality gate. Report what you have actually Verified this session versus what is Unverified or Untestable. Do not let "the implementer said tests pass" become Confirmed — that is Claimed-not-verified unless you ran it. Include what was not tested and the risk that leaves.',
  },
  {
    key: 'security',
    name: 'security-engineer',
    brief:
      'Security gate. Map findings to blocking vs non-blocking per your §4: Critical/High block, Medium is Should-Fix, Low/Informational do not block alone. Give a clear blocking read, not a raw finding list. You document risk acceptance; you never accept it on anyone\'s behalf.',
  },
  {
    key: 'operations',
    name: 'site-reliability',
    brief:
      'Operations readiness. Monitoring exists, dashboards exist, alerts exist AND are owned, rollback signals defined. Report as Confirmed/Missing per item, not a vague impression. Include current error-budget state — a service that has already burned its budget for the period is evidence for slowing velocity.',
  },
  {
    key: 'rollback',
    name: 'database-engineer',
    brief:
      'Data-layer reversibility. Is there a real path back — for schema, data, and config? A rollback plan that has not been rehearsed is Claimed-not-verified, not Confirmed. Say plainly which it is; qa-engineer executes the rehearsal, not you.',
  },
]

async function main() {
  log(`release: ${release}`)

  // ---- Gates. ----
  phase('Gates')
  const gates = await parallel(
    GATES.map(g => async () => {
      const r = await runAgent({
        name: g.name,
        schema: GATE_SCHEMA,
        task: `Assess your gate for: ${release}\n\n${g.brief}`,
      })
      return r
        ? { ...r, key: g.key, owner: g.name }
        : { key: g.key, owner: g.name, gate: g.key, status: 'Missing', evidence: 'Gate agent produced no result — treated as Missing, never as passing.' }
    }),
  )

  const blocking = gates.filter(g => g.status === 'Missing' || (g.blockers ?? []).length)
  const unverified = gates.filter(g => g.status === 'Claimed-not-verified')
  log(`${gates.filter(g => g.status === 'Confirmed').length}/${gates.length} gates Confirmed; ${unverified.length} claimed-not-verified; ${blocking.length} blocking`)

  // ---- Synthesize. ----
  phase('Synthesize')
  const recommendation = await runAgent({
    name: 'release-manager',
    task: `Produce a release readiness recommendation for: ${release}

GATE RESULTS:
${JSON.stringify(gates, null, 2)}

Rules you already hold, restated because this run is automated and nobody is watching each step:
- A gate with no result is Missing, never "probably fine".
- Claimed-not-verified is not Confirmed. Do not upgrade it because the claim sounds plausible or the release is wanted.
- Name explicitly what evidence is absent and what risk shipping without it accepts.
- Produce a RECOMMENDATION for a human to confirm. You do not hold deploy authority, and neither does this workflow.`,
  })

  const report = {
    release,
    gates,
    gatesConfirmed: gates.filter(g => g.status === 'Confirmed').map(g => g.key),
    gatesBlocking: blocking.map(g => g.key),
    gatesClaimedNotVerified: unverified.map(g => g.key),
    recommendation,
    authority:
      'RECOMMENDATION ONLY. This workflow has no deploy authority and cannot grant it. A human confirms go/no-go.',
  }
  console.log(JSON.stringify(report, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
