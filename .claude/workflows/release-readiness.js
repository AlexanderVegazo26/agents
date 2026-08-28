export const meta = {
  name: 'release-readiness',
  description: 'Collect every release gate in parallel from the agent that owns it, then have release-manager synthesize an evidence-classified go/no-go recommendation',
  whenToUse: 'Before a production release. Produces a RECOMMENDATION for human confirmation — it deliberately cannot deploy, and no gate result upgrades a claim to Confirmed on its own.',
  phases: [
    { title: 'Gates', detail: 'engineering, quality, security, operations, performance gates in parallel' },
    { title: 'Synthesize', detail: 'release-manager classifies each gate and recommends' },
  ],
}

const release = typeof args === 'string' ? args : args?.release ?? 'the pending release on the current branch'

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
    agentType: 'solution-architect',
    brief:
      'Architectural sign-off for this release. Was a Tier 2+ structural decision in play, and does the implementation follow the intended design? Scope this to architectural alignment only — code review is code-reviewer\'s, not yours to redo.',
  },
  {
    key: 'quality',
    agentType: 'qa-engineer',
    brief:
      'Quality gate. Report what you have actually Verified this session versus what is Unverified or Untestable. Do not let "the implementer said tests pass" become Confirmed — that is Claimed-not-verified unless you ran it. Include what was not tested and the risk that leaves.',
  },
  {
    key: 'security',
    agentType: 'security-engineer',
    brief:
      'Security gate. Map findings to blocking vs non-blocking per your §4: Critical/High block, Medium is Should-Fix, Low/Informational do not block alone. Give a clear blocking read, not a raw finding list. You document risk acceptance; you never accept it on anyone\'s behalf.',
  },
  {
    key: 'operations',
    agentType: 'site-reliability',
    brief:
      'Operations readiness. Monitoring exists, dashboards exist, alerts exist AND are owned, rollback signals defined. Report as Confirmed/Missing per item, not a vague impression. Include current error-budget state — a service that has already burned its budget for the period is evidence for slowing velocity.',
  },
  {
    key: 'rollback',
    agentType: 'database-engineer',
    brief:
      'Data-layer reversibility. Is there a real path back — for schema, data, and config? A rollback plan that has not been rehearsed is Claimed-not-verified, not Confirmed. Say plainly which it is; qa-engineer executes the rehearsal, not you.',
  },
]

phase('Gates')
const gates = await parallel(
  GATES.map(g => () =>
    agent(`Assess your gate for: ${release}\n\n${g.brief}`, {
      agentType: g.agentType,
      label: `gate:${g.key}`,
      phase: 'Gates',
      schema: GATE_SCHEMA,
    }).then(r => (r ? { ...r, key: g.key, owner: g.agentType } : { key: g.key, owner: g.agentType, gate: g.key, status: 'Missing', evidence: 'Gate agent produced no result — treated as Missing, never as passing.' })),
  ),
)

const blocking = gates.filter(g => g.status === 'Missing' || (g.blockers ?? []).length)
const unverified = gates.filter(g => g.status === 'Claimed-not-verified')
log(`${gates.filter(g => g.status === 'Confirmed').length}/${gates.length} gates Confirmed; ${unverified.length} claimed-not-verified; ${blocking.length} blocking`)

phase('Synthesize')
const recommendation = await agent(
  `Produce a release readiness recommendation for: ${release}

GATE RESULTS:
${JSON.stringify(gates, null, 2)}

Rules you already hold, restated because this run is automated and nobody is watching each step:
- A gate with no result is Missing, never "probably fine".
- Claimed-not-verified is not Confirmed. Do not upgrade it because the claim sounds plausible or the release is wanted.
- Name explicitly what evidence is absent and what risk shipping without it accepts.
- Produce a RECOMMENDATION for a human to confirm. You do not hold deploy authority, and neither does this workflow.`,
  { agentType: 'release-manager', label: 'recommendation', phase: 'Synthesize' },
)

return {
  release,
  gates,
  gatesConfirmed: gates.filter(g => g.status === 'Confirmed').map(g => g.key),
  gatesBlocking: blocking.map(g => g.key),
  gatesClaimedNotVerified: unverified.map(g => g.key),
  recommendation,
  authority:
    'RECOMMENDATION ONLY. This workflow has no deploy authority and cannot grant it. A human confirms go/no-go.',
}
