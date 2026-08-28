#!/usr/bin/env node
'use strict'
/**
 * persona-qa-sweep — derive real end-user personas from code evidence, explore
 * the app as each one, then probe authorization boundaries between every
 * persona pair. Requires a non-production target.
 *
 * Usage: node workflows/persona-qa-sweep.js --target http://localhost:3000 [--env staging] [--journeys "J1" --journeys "J2"]
 * Env:   CMDC_BIN, CMDC_MODEL, CMDC_AGENT_TIMEOUT_MS
 */
const { log, phase, runAgent, parallel } = require('./_runner')

function parseArgs(argv) {
  const out = { target: null, env: 'non-production', journeys: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') out.target = argv[++i]
    else if (a === '--env') out.env = argv[++i]
    else if (a === '--journeys') out.journeys.push(argv[++i])
    else if (!a.startsWith('--') && out.target === null) out.target = a // positional fallback
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const target = args.target
const env = args.env

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

const PROBE_SCHEMA = {
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
}

async function main() {
  if (!target) {
    console.log(JSON.stringify({
      status: 'stopped',
      reason: 'No target supplied. persona-runner and boundary-prober both require an explicit non-production target and refuse to default — asking is the correct behavior here, not guessing.',
    }, null, 2))
    return
  }
  log(`target: ${target} (env: ${env})`)

  // ---- Phase 1 — Discover. Evidence-derived, not guessed. ----
  phase('Discover')
  const discovery = await runAgent({
    name: 'persona-discovery',
    schema: PERSONA_SCHEMA,
    task: `Derive the end-user personas this application actually implements. Every persona needs path:line provenance — a persona with none does not get written. Require two independent source types before marking one confirmed; never promote a candidate on your own judgment.

Emit specs conforming to the personas-schema-template shipped with the exploration-charter skill — load that skill to read the schema rather than constructing a path to it. Report ambiguous capability entries as the high-value output they are, not as a gap to fill by guessing. State explicitly what you could not determine.`,
  })

  if (!discovery?.personas?.length) {
    console.log(JSON.stringify({ status: 'stopped', reason: 'No personas derived from code evidence.', discovery }, null, 2))
    return
  }

  const confirmed = discovery.personas.filter(p => p.status === 'confirmed')
  const candidates = discovery.personas.filter(p => p.status === 'candidate')
  log(`${confirmed.length} confirmed personas, ${candidates.length} candidates (candidates are NOT explored — they need a human call first)`)

  if (confirmed.length > 12) {
    console.log(JSON.stringify({
      status: 'stopped',
      reason: `${confirmed.length} personas exceeds persona-discovery's own stop condition of 12 — that indicates splitting on the wrong axis. Stopping rather than fanning out a wrong decomposition across dozens of agents.`,
      discovery,
    }, null, 2))
    return
  }

  // ---- Phase 2 — Explore. One isolated session per confirmed persona. ----
  phase('Explore')
  const sessions = await parallel(
    confirmed.map(p => () =>
      runAgent({
        name: 'persona-runner',
        task: `Explore ${target} in the ${env} environment as persona "${p.id}".

Adopt the persona's behavior model as constraints on HOW you act, not just what you check — a novice+sloppy persona takes wrong turns and submits bad input; a keyboard-only persona never uses a pointer. Stay inside its anti_goals. Use its own session_isolation_key; never reuse another persona's session.

Charter: pursue this persona's ranked jobs and report where it cannot complete them. Record an abandonment as a finding, including where it gave up and why. Synthetic data only. Refuse and stop if the target resolves to production.

Do NOT probe anything in this persona's forbidden list — record it and leave it to boundary-prober.`,
      }),
    ),
  )

  const sessionsByPersona = confirmed.map((p, i) => ({ persona: p.id, session: sessions[i] })).filter(s => s.session)

  // ---- Phase 3 — Probe. Ordered pairs: reach A's resources while
  // authenticated as B. Barrier is genuine here — the probe matrix needs the
  // full persona set and the resource identifiers exploration discovered. ----
  phase('Probe')
  const pairs = []
  for (const a of confirmed) {
    for (const b of confirmed) {
      if (a.id !== b.id) pairs.push({ owner: a, actor: b })
    }
  }
  log(`${pairs.length} ordered persona pairs to probe`)

  const probes = await parallel(
    pairs.map(({ owner, actor }) => async () => {
      const r = await runAgent({
        name: 'boundary-prober',
        schema: PROBE_SCHEMA,
        task: `Probe authorization between personas on ${target} (${env}).

Attempt to reach persona "${owner.id}"'s resources while authenticated as persona "${actor.id}". Probe BOTH layers — an action hidden in ${actor.id}'s UI but reachable at its API is a finding, and usually the most serious class here. Cover horizontal (peer resource, same role) as well as vertical escalation, plus identifier substitution, direct navigation, stale-session reuse, and unauthenticated access.

Resources ${owner.id} must deny to others: ${owner.forbidden.join(', ') || '(none listed — report this as an unactionable spec gap rather than inventing identifiers)'}

Resource identifiers discovered during exploration:
${sessionsByPersona.map(s => `[${s.persona}] ${s.session}`).join('\n').slice(0, 4000)}

Use security-engineer's severity scale. Report an ambiguous cell as an unmade product decision, not a bug. Read-oriented probes only — no destructive probe against another persona's resource from inside this workflow.`,
      })
      return r ? { actor: actor.id, owner: owner.id, ...r } : null
    }),
  )

  const probeResults = probes.filter(Boolean)
  const leaks = probeResults.flatMap(p => (p.leaks ?? []).map(l => ({ ...l, actor: p.actor, owner: p.owner })))
  const ambiguous = [...new Set(probeResults.flatMap(p => p.ambiguous ?? []))]
  log(`${leaks.length} authorization leaks, ${ambiguous.length} unresolved ambiguous cells`)

  // ---- Phase 4 — Journeys. Multi-actor flows, only if supplied. Skipped
  // entirely when none are given — a journey can't be invented without guessing
  // at the business process. ----
  const requestedJourneys = args.journeys
  let journeyResults = []

  if (requestedJourneys.length) {
    phase('Journeys')
    log(`${requestedJourneys.length} multi-actor journeys to run`)
    journeyResults = (
      await parallel(
        requestedJourneys.map((j, i) => () =>
          runAgent({
            name: 'journey-orchestrator',
            task: `Run this multi-actor journey on ${target} (${env}): ${j}

Available personas: ${confirmed.map(p => p.id).join(', ')}

Maintain the journey ledger as the ONLY state channel between personas — artifact identifiers and observable facts, never credentials or session state. Delegate each step to persona-runner under a step-scoped charter, each with its own isolated identity.

After every handoff, verify from the RECEIVING persona's own view. A sender-side confirmation is not evidence of delivery. Also check negative propagation: personas outside the journey must not observe the artifact.

On a failed handoff, record exactly which one broke, preserve the ledger, and halt — do not skip ahead or fabricate the missing state.`,
          }),
        ),
      )
    ).filter(Boolean)
  } else {
    log('No journeys supplied — skipping the multi-actor phase rather than inventing a business process')
  }

  // ---- Phase 5 — Report. qa-engineer owns final triage. ----
  phase('Report')
  const verdict = await runAgent({
    name: 'qa-engineer',
    task: `Triage this persona sweep into one verdict. The explorers reported what happened; the bug / bad-test / flake / environment classification is yours, per your §10 — do not treat their severity ratings as finished triage verdicts.

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
  })

  const report = {
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
  console.log(JSON.stringify(report, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
