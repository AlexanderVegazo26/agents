export const meta = {
  name: 'persona-qa-sweep',
  description: 'Derive real end-user personas from code evidence, explore the app as each one, then probe authorization boundaries between every persona pair',
  whenToUse: 'Role-based testing of a user-facing application. Requires a non-production target — pass it as args.target. Never point this at production.',
  phases: [
    { title: 'Discover', detail: 'persona-discovery derives personas from code with path:line provenance' },
    { title: 'Explore', detail: 'one persona-runner session per confirmed persona' },
    { title: 'Probe', detail: 'boundary-prober across ordered persona pairs' },
    { title: 'Journeys', detail: 'journey-orchestrator runs multi-actor flows, if any were supplied' },
    { title: 'Report', detail: 'qa-engineer triages everything into one verdict' },
  ],
}

const target = args?.target
const env = args?.env ?? 'non-production'

if (!target) {
  return {
    status: 'stopped',
    reason: 'No target supplied. persona-runner and boundary-prober both require an explicit non-production target and refuse to default — asking is the correct behavior here, not guessing.',
  }
}

const PERSONA_SCHEMA = {
  type: 'object',
  required: ['personas', 'ambiguities', 'undetermined'],
  properties: {
    personas: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status', 'forbidden'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          status: { type: 'string', enum: ['confirmed', 'candidate', 'rejected'] },
          provenanceCount: { type: 'number' },
          forbidden: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    ambiguities: { type: 'array', items: { type: 'string' } },
    undetermined: { type: 'array', items: { type: 'string' } },
  },
}

// ---------------------------------------------------------------------------
// Phase 1 — Discover. Evidence-derived, not guessed from the product category.
// ---------------------------------------------------------------------------
phase('Discover')
const discovery = await agent(
  `Derive the end-user personas this application actually implements. Every persona needs path:line provenance — a persona with none does not get written. Require two independent source types before marking one confirmed; never promote a candidate on your own judgment.

Emit specs conforming to personas-schema-template.yaml, which ships with the sdlc-suite:exploration-charter skill — load that skill to read the schema rather than constructing a path to it. Report ambiguous capability entries as the high-value output they are, not as a gap to fill by guessing. State explicitly what you could not determine.`,
  { agentType: 'sdlc-suite:persona-discovery', label: 'discover', schema: PERSONA_SCHEMA },
)

if (!discovery?.personas?.length) {
  return { status: 'stopped', reason: 'No personas derived from code evidence.', discovery }
}

const confirmed = discovery.personas.filter(p => p.status === 'confirmed')
const candidates = discovery.personas.filter(p => p.status === 'candidate')
log(`${confirmed.length} confirmed personas, ${candidates.length} candidates (candidates are NOT explored — they need a human call first)`)

if (confirmed.length > 12) {
  return {
    status: 'stopped',
    reason: `${confirmed.length} personas exceeds persona-discovery's own stop condition of 12 — that indicates splitting on the wrong axis. Stopping rather than fanning out a wrong decomposition across dozens of agents.`,
    discovery,
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — Explore. One isolated session per confirmed persona.
// Only confirmed personas are explored; candidates await a human decision.
// ---------------------------------------------------------------------------
phase('Explore')
const sessions = await parallel(
  confirmed.map(p => () =>
    agent(
      `Explore ${target} in the ${env} environment as persona "${p.id}".

Adopt the persona's behavior model as constraints on HOW you act, not just what you check — a novice+sloppy persona takes wrong turns and submits bad input; a keyboard-only persona never uses a pointer. Stay inside its anti_goals. Use its own session_isolation_key; never reuse another persona's session.

Charter: pursue this persona's ranked jobs and report where it cannot complete them. Record an abandonment as a finding, including where it gave up and why. Synthetic data only. Refuse and stop if the target resolves to production.

Do NOT probe anything in this persona's forbidden list — record it and leave it to boundary-prober.`,
      { agentType: 'sdlc-suite:persona-runner', label: `explore:${p.id}`, phase: 'Explore' },
    ),
  ),
)

const sessionsByPersona = confirmed.map((p, i) => ({ persona: p.id, session: sessions[i] })).filter(s => s.session)

// ---------------------------------------------------------------------------
// Phase 3 — Probe. Ordered pairs: reach A's resources while authenticated as B.
// Barrier is genuine here — the probe matrix needs the full persona set and the
// resource identifiers the explore phase discovered.
// ---------------------------------------------------------------------------
phase('Probe')
const pairs = []
for (const a of confirmed) {
  for (const b of confirmed) {
    if (a.id !== b.id) pairs.push({ owner: a, actor: b })
  }
}
log(`${pairs.length} ordered persona pairs to probe`)

const probes = await parallel(
  pairs.map(({ owner, actor }) => () =>
    agent(
      `Probe authorization between personas on ${target} (${env}).

Attempt to reach persona "${owner.id}"'s resources while authenticated as persona "${actor.id}". Probe BOTH layers — an action hidden in ${actor.id}'s UI but reachable at its API is a finding, and usually the most serious class here. Cover horizontal (peer resource, same role) as well as vertical escalation, plus identifier substitution, direct navigation, stale-session reuse, and unauthenticated access.

Resources ${owner.id} must deny to others: ${owner.forbidden.join(', ') || '(none listed — report this as an unactionable spec gap rather than inventing identifiers)'}

Resource identifiers discovered during exploration:
${sessionsByPersona.map(s => `[${s.persona}] ${s.session}`).join('\n').slice(0, 4000)}

Use security-engineer's severity scale. Report an ambiguous cell as an unmade product decision, not a bug. Read-oriented probes only — no destructive probe against another persona's resource from inside this workflow.`,
      {
        agentType: 'sdlc-suite:boundary-prober',
        label: `probe:${actor.id}->${owner.id}`,
        phase: 'Probe',
        schema: {
          type: 'object',
          required: ['leaks', 'ambiguous'],
          properties: {
            leaks: {
              type: 'array',
              items: {
                type: 'object',
                required: ['severity', 'resource', 'evidence'],
                properties: {
                  severity: { type: 'string' },
                  resource: { type: 'string' },
                  evidence: { type: 'string' },
                  layer: { type: 'string' },
                  kind: { type: 'string' },
                },
              },
            },
            ambiguous: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    ).then(r => (r ? { actor: actor.id, owner: owner.id, ...r } : null)),
  ),
)

const probeResults = probes.filter(Boolean)
const leaks = probeResults.flatMap(p => (p.leaks ?? []).map(l => ({ ...l, actor: p.actor, owner: p.owner })))
const ambiguous = [...new Set(probeResults.flatMap(p => p.ambiguous ?? []))]
log(`${leaks.length} authorization leaks, ${ambiguous.length} unresolved ambiguous cells`)

// ---------------------------------------------------------------------------
// Phase 4 — Journeys. Multi-actor flows spanning personas, if any were supplied.
// journey-orchestrator delegates each step to persona-runner itself, so this is
// a nested orchestration: workflow -> journey-orchestrator -> persona-runner.
// Skipped entirely when no journeys are given — a journey can't be invented from
// the persona list without guessing at the business process.
// ---------------------------------------------------------------------------
const requestedJourneys = Array.isArray(args?.journeys) ? args.journeys : []
let journeyResults = []

if (requestedJourneys.length) {
  phase('Journeys')
  log(`${requestedJourneys.length} multi-actor journeys to run`)
  journeyResults = (
    await parallel(
      requestedJourneys.map((j, i) => () =>
        agent(
          `Run this multi-actor journey on ${target} (${env}): ${typeof j === 'string' ? j : JSON.stringify(j)}

Available personas: ${confirmed.map(p => p.id).join(', ')}

Maintain the journey ledger as the ONLY state channel between personas — artifact identifiers and observable facts, never credentials or session state. Delegate each step to persona-runner under a step-scoped charter, each with its own isolated identity.

After every handoff, verify from the RECEIVING persona's own view. A sender-side confirmation is not evidence of delivery. Also check negative propagation: personas outside the journey must not observe the artifact.

On a failed handoff, record exactly which one broke, preserve the ledger, and halt — do not skip ahead or fabricate the missing state.`,
          { agentType: 'sdlc-suite:journey-orchestrator', label: `journey:${i + 1}`, phase: 'Journeys' },
        ),
      ),
    )
  ).filter(Boolean)
} else {
  log('No journeys supplied — skipping the multi-actor phase rather than inventing a business process')
}

// ---------------------------------------------------------------------------
// Phase 5 — Report. qa-engineer owns final triage; the explorers only report.
// ---------------------------------------------------------------------------
phase('Report')
const verdict = await agent(
  `Triage this persona sweep into one verdict. The explorers reported what happened; the bug / bad-test / flake / environment classification is yours, per your §10 — do not treat their severity ratings as finished triage verdicts.

Rank authorization leaks by blast radius: cross-tenant > cross-user > cross-role > UI-only inconsistency. Keep security-engineer's severity scale for those and the persona-impact scale for usability findings, labeled so they don't get conflated.

Include a "what was NOT tested" section: candidate personas were deliberately not explored, and unresolved ambiguous cells are unmade product decisions rather than defects.

EXPLORATION SESSIONS:
${sessionsByPersona.map(s => `### ${s.persona}\n${s.session}`).join('\n\n').slice(0, 8000)}

AUTHORIZATION LEAKS:
${JSON.stringify(leaks, null, 2)}

AMBIGUOUS CELLS (need a product decision, not a fix):
${ambiguous.join('\n') || '(none)'}

MULTI-ACTOR JOURNEY RESULTS:
${journeyResults.length ? journeyResults.join('\n\n---\n\n').slice(0, 6000) : '(no journeys supplied — this coverage gap belongs in the "what was NOT tested" section)'}`,
  { agentType: 'sdlc-suite:qa-engineer', label: 'triage', phase: 'Report' },
)

return {
  target,
  env,
  personas: { confirmed: confirmed.map(p => p.id), candidatesAwaitingDecision: candidates.map(p => p.id) },
  authorizationLeaks: leaks,
  journeys: { requested: requestedJourneys.length, results: journeyResults },
  ambiguousCapabilities: ambiguous,
  undeterminedByDiscovery: discovery.undetermined,
  verdict,
  humanDecisionRequired: [
    ...candidates.map(p => `Promote or reject candidate persona "${p.id}" — persona-discovery will not self-promote.`),
    ...ambiguous.map(a => `Resolve ambiguous capability: ${a}`),
  ],
}
