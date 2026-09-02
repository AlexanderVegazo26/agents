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
    { title: 'Runtime', detail: 'bridge steps that reach the recorder and the policy loader' },
  ],
}

// ===========================================================================
// RUNTIME WIRING — CHG-16 (policy + blocked-gate reducer), CHG-18 (run
// directory + resume), CHG-19 (breaker), CHG-20 (handoff by reference),
// CHG-22 (outcome record).
//
// WHY THIS IS A BRIDGE AND NOT AN IMPORT
// -------------------------------------
// A Workflow-tool script runs inside a `node:vm` context whose globals are an
// explicit allowlist built on a null-prototype object: agent, parallel,
// pipeline, workflow, phase, log, args, budget, setTimeout, clearTimeout,
// console. There is no `require`, no `module`, no `process` and no `fs`, and
// `Math.random()`, `Date.now()` and argless `new Date()` are replaced with
// functions that throw so resume stays deterministic. Measured against the
// shipped Claude Code binary (2.1.258), not recalled.
//
// So none of `_policy.js`, `_state.js`, `_failure.js` or `_brief.js` can be
// called in this process — not just `_state.js`. They are reached through a
// BRIDGE AGENT: a mechanical, low-effort step that writes a fully-formed Node
// script — generated here, so the agent decides nothing — runs it, and returns
// its stdout verbatim.
//
// THE LIMITATION, STATED RATHER THAN PAPERED OVER
// -----------------------------------------------
// A language model sits on that wire. A bridge step can be skipped, garbled or
// refused, and nothing here can prove otherwise from inside the sandbox. So
// every caller degrades in the SAFE direction: the policy reads DEGRADED (every
// gate not pre-authorized), the verify brief falls back to the manifest itself
// and never to concatenated prose, a run that cannot be recorded says so rather
// than reporting a record it does not have, and a blocked-gate collection that
// could not run reports itself as a blocked gate instead of an empty array.
// ===========================================================================

const WORKFLOW = 'persona-qa-sweep'

const BRIDGE_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    result: { type: 'string' },
    error: { type: 'string' },
  },
}

function parentDir(p) {
  const s = String(p)
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i < 0 ? null : s.slice(0, i)
}

// `${CLAUDE_PLUGIN_ROOT}` is expanded by the command layer before Workflow is
// invoked. If it arrives unexpanded it is a literal, nothing resolves, and the
// correct reading is "no policy" — not "open a file called ${CLAUDE_PLUGIN_ROOT}".
function resolvedPath(v) {
  return typeof v === 'string' && v && !v.includes('${') ? v : null
}

// The bridge writes and runs a script that requires modules out of this
// directory, so it is a code-execution input and not merely a path. It comes
// from the command layer, which is trusted — but validate the shape anyway, so
// a mistyped or traversing argument fails closed instead of sourcing the
// platform's runtime modules from somewhere unintended.
function runtimeDirOf(v) {
  const p = resolvedPath(v)
  if (!p || p.includes('..')) return null
  // Reject UNC and protocol-relative roots. Security review demonstrated that
  // a `\\host\share\workflows` or `//host/share/workflows` value passed the
  // `..`-and-tail check, and `path.join` preserves a UNC prefix intact — so on
  // Windows the bridge would `require` `_policy.js` over SMB, and the gate table
  // it returns is prefixed to every downstream agent prompt. The platform's own
  // modules never live on a share, so this rejects no legitimate value.
  //
  // This validates SHAPE only. A vm-sandboxed script has no `process`, no `fs`
  // and no plugin root, so it has no trusted anchor and cannot check LOCATION.
  // That limit is real: the durable fix is for the command layer to pass
  // `runtimeDir` explicitly instead of letting one argument select two things.
  if (/^(\\\\|\/\/)/.test(p)) return null
  return /[\\/]workflows[\\/]?$/.test(p) ? p.replace(/[\\/]+$/, '') : null
}

// `resume` names a directory the recorder reads phase artifacts out of, and
// those artifacts are replayed into downstream prompts carrying the authority of
// "this is what your own earlier phases produced". Security review showed
// `../../../outside/planted` resolving to an attacker-authored run whose
// acceptance criteria were then adopted wholesale, and a manifest-supplied
// `artifact` path reading an arbitrary JSON file into agent context. A run id is
// a single path segment; anything else is rejected here, and `_state.js`
// enforces containment independently on its side.
function resumeIdOf(v) {
  const p = resolvedPath(v)
  if (!p) return null
  if (p.includes('..') || p.includes('/') || p.includes('\\')) return null
  return p
}

const POLICY_PATH = resolvedPath(args?.policy)
const RUNTIME_DIR =
  runtimeDirOf(args?.runtimeDir) ||
  (POLICY_PATH && parentDir(POLICY_PATH) ? runtimeDirOf(`${parentDir(POLICY_PATH)}/workflows`) : null)
const RESUME_ID = resumeIdOf(args?.resume)
const RECORDING = args?.record !== false

const REQUIRE_HEAD = `const path = require('path')\nconst DIR = ${JSON.stringify(RUNTIME_DIR)}\n`

// Declared before `bridge()` uses it: the policy step runs at module scope,
// before the run is opened, so a later `let` would put this in the temporal
// dead zone and the very first bridge call would throw.
let RUN = null            // { runId, dir, resumed: { phaseTitle: artifact } }
let bridgeCalls = 0

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-60)
}

/**
 * Run one module call out-of-process. Returns the module's own JSON result, or
 * null when the bridge could not run — never a plausible-looking substitute.
 *
 * The scratch script lives INSIDE the run directory, for two reasons. Two
 * workflows running in one repository would otherwise write and execute the
 * same `_bridge/<op>-<n>.js` and could each run the other's script; and a
 * shared `_bridge/` directory under `.claude/runs/` is itself a directory
 * there, so `listRuns()` would hand the distiller a run whose id is `_bridge`.
 *
 * Only the policy step runs before the run directory exists, and this sandbox
 * has no clock and no randomness to name it with, so that one is keyed on the
 * workflow and the policy path and written as a FILE directly under
 * `.claude/runs/` — a file, so `listRuns()` skips it. Two runs colliding there
 * are generating byte-identical scripts, which makes the collision harmless
 * rather than merely unlikely.
 */
async function bridge(op, source) {
  if (!RUNTIME_DIR) return null
  const file = RUN
    ? `${RUN.dir}/bridge/${op}-${++bridgeCalls}.js`
    : `.claude/runs/pre-${slug(`${WORKFLOW}-${POLICY_PATH || 'no-policy'}`)}-${op}-${++bridgeCalls}.js`
  const out = await agent(
    `Mechanical bridge step. You are a transcriber, not an author, and you take no autonomous decision here — no autonomy gate applies to this step. Do exactly these three things and nothing else. Do not edit, improve, shorten or re-derive the script. Do not read the modules it requires. Do not summarise, re-key or pretty-print its output.

1. Write the block between the two markers below, byte for byte, to ${file} — creating parent directories if they do not exist. If that path is relative, resolve it against your working directory first; the Write tool needs an absolute path.
2. Run it: node "${file}"
3. Return ok=true with that process's stdout in "result", VERBATIM — it is already JSON. If the command exits non-zero, or writes nothing to stdout, return ok=false and put stderr in "error".

--- BEGIN ${file} ---
${source}
--- END ${file} ---`,
    { agentType: 'general-purpose', label: `bridge:${op}`, phase: 'Runtime', effort: 'low', schema: BRIDGE_SCHEMA },
  )
  if (!out || out.ok !== true || typeof out.result !== 'string' || !out.result.trim()) {
    log(`bridge:${op} did not run${out && out.error ? ` — ${out.error}` : ''}`)
    return null
  }
  try {
    return JSON.parse(out.result)
  } catch (e) {
    log(`bridge:${op} returned output that is not JSON — treating the module as unreachable`)
    return null
  }
}

// --------------------------------------------------------------------------
// CHG-16 — the resolved gate table, injected as explicit text.
// --------------------------------------------------------------------------
const DEGRADED_TABLE = [
  'AUTONOMY POLICY — DEGRADED.',
  'Reason: this workflow could not reach the policy loader to resolve a policy file.',
  'Treat EVERY gate as NOT pre-authorized, including all decide.* gates.',
  'State this degraded status at the top of your result. Do not present it as a',
  'deliberate lockdown — it is an unresolved policy, and the difference matters.',
].join('\n')

const POLICY = await (async () => {
  const r = await bridge('policy', `${REQUIRE_HEAD}const p = require(path.join(DIR, '_policy.js'))
const r = p.loadPolicy({ explicitPath: ${JSON.stringify(POLICY_PATH)} })
process.stdout.write(JSON.stringify({ gateTable: p.gateTableForPrompt(r), source: r.source, degraded: r.degraded, errors: r.errors }))`)
  return r && typeof r.gateTable === 'string' && r.gateTable
    ? r
    : { gateTable: DEGRADED_TABLE, source: null, degraded: true, errors: ['the policy bridge did not run'] }
})()

if (POLICY.degraded) {
  log(`AUTONOMY POLICY DEGRADED — ${POLICY.errors.join('; ') || 'no policy file resolved'}. Every gate reads not-authorized.`)
} else {
  log(`autonomy policy resolved from ${POLICY.source}`)
}

/**
 * Prefix the resolved gate table to an agent prompt.
 *
 * The agent is TOLD the answer rather than sent to find a file. The
 * autonomy-policy skill warns that `${CLAUDE_PLUGIN_ROOT}` does not expand in
 * skill text, so an agent asked to locate the policy itself may simply fail to
 * — and then, correctly per the skill, treat every gate as denied.
 */
function withPolicy(prompt) {
  return `${POLICY.gateTable}\n\n---\n\n${prompt}`
}

// --------------------------------------------------------------------------
// CHG-18 / CHG-19 / CHG-22 — run directory, resume, breaker, outcome record.
// --------------------------------------------------------------------------
const REPLAYED = []       // phase titles actually served from the resume cache
const OUTPUTS = []        // every agent result, for the CHG-16 reducer
const BREAKER_ENTRIES = []

/** Remember an agent result so the blocked-gate reducer can scan it later. */
function keep(v) {
  OUTPUTS.push(v)
  return v
}

async function openRun(firstPhase) {
  if (!RECORDING || !RUNTIME_DIR) {
    if (RESUME_ID) {
      return { fatal: `resume "${RESUME_ID}" was requested but the runtime modules are not reachable — args carried no usable policy or runtimeDir path. Refusing to start a fresh run in its place.` }
    }
    log('run recording is off — this run produces no run directory and no outcome record')
    return null
  }
  const r = await bridge('open', `${REQUIRE_HEAD}const s = require(path.join(DIR, '_state.js'))
const run = s.openRun({ workflow: ${JSON.stringify(WORKFLOW)}, args: ${JSON.stringify(args ?? null)}, cwd: process.cwd(), resumeFrom: ${JSON.stringify(RESUME_ID)} })
const resumed = {}
for (const t of run.resumedPhases) resumed[t] = run.resumed(t)
run.startPhase(${JSON.stringify(firstPhase)})
process.stdout.write(JSON.stringify({ runId: run.runId, dir: run.dir, resumed: resumed }))`)
  if (!r || !r.runId) {
    // A failed READ during resume must never degrade into a fresh run — that is
    // how three phases get lost twice, the second time unwatched. A failed OPEN
    // on a fresh run costs only the record, so that one continues.
    if (RESUME_ID) {
      return { fatal: `cannot resume "${RESUME_ID}": the state bridge returned no run. Refusing to start a fresh run in its place — re-run without resume if that is what you want.` }
    }
    log('run recording unavailable — continuing without a run directory')
    return null
  }
  RUN = r
  log(`run ${r.runId} -> ${r.dir}`)
  return r
}

/**
 * Close out a phase: write its artifact, append any failures, re-fold the
 * breaker over the run's whole failure log, and mark the next phase as the one
 * to resume from.
 *
 * WHERE THE BREAKER STATE LIVES, AND WHY.
 * `sdlc-suite/workflows/` has no shared runner module, so CHG-19's "breaker
 * check at each phase boundary" has nothing in-process to hold state. It lives
 * in the RUN DIRECTORY — `failures.jsonl` — and is re-folded through
 * `_failure.js`'s `Breaker` at every boundary. Deliberately not in this script:
 * an in-memory counter dies with the process, so a resumed run would walk
 * straight back into the same environmental fact the breaker exists to stop.
 *
 * The classifier has exactly one input here. `agent()` hands this script `null`
 * with no stderr, exit code or message, and the host already retried, so
 * `classify({})` is called with nothing and every failure lands on its
 * conservative fallback class. The breaker is therefore "N null returns in one
 * phase" — that is all it can be from inside the sandbox, and it is not dressed
 * up as more.
 */
async function recordPhase(title, artifact, nextPhase, failedLabels) {
  if (!RUN) return { tripped: false, entry: null }
  const r = await bridge('phase', `${REQUIRE_HEAD}const s = require(path.join(DIR, '_state.js'))
const f = require(path.join(DIR, '_failure.js'))
const run = s.openRun({ workflow: ${JSON.stringify(WORKFLOW)}, cwd: process.cwd(), resumeFrom: ${JSON.stringify(RUN.runId)} })
const done = run.manifest.phases
// A fresh process starts its own clock at zero, so the recorder would time the
// bridge subprocess instead of the phase. The real boundary is already on disk.
const prevIso = done.length ? (run._cache.get(done[done.length - 1].title) || {}).completedAt : run.manifest.startedAt
run._phaseStartMs = Date.parse(prevIso || run.manifest.startedAt)
run.completePhase(${JSON.stringify(title)}, ${JSON.stringify(artifact)})
const cls = f.classify({})
for (const label of ${JSON.stringify(failedLabels || [])}) {
  run.recordFailure({ label: label, phase: ${JSON.stringify(title)}, class: cls, attempt: 1, of: 1,
    detail: 'agent() returned no result - skipped, blocked, or gave up after the host runtime retried',
    strategyNext: 'no further attempt is available to the workflow script; the host runtime owns retry' })
}
const breaker = new f.Breaker()
for (const rec of run.readFailures()) breaker.record(rec.phase, rec.class || cls)
if (${JSON.stringify(nextPhase)}) run.startPhase(${JSON.stringify(nextPhase)})
process.stdout.write(JSON.stringify({ tripped: breaker.isTripped(${JSON.stringify(title)}), info: breaker.trippedInfo(${JSON.stringify(title)}), entry: breaker.asBlockedEntry(${JSON.stringify(title)}) }))`)
  if (!r) return { tripped: false, entry: null }
  if (r.tripped && r.info) log(`BREAKER TRIPPED in "${title}" — ${r.info.count} x ${r.info.class}`)
  return r
}

function replayed(title) {
  if (!RUN || !RUN.resumed || !(title in RUN.resumed)) return null
  if (!REPLAYED.includes(title)) REPLAYED.push(title)
  return RUN.resumed[title]
}

/**
 * Run a phase, or replay it from the run cache when resuming.
 *
 * `fn` returns the phase artifact: `{ agents: [{label, result}], ... }`. That
 * shape is what `--resume` replays, so anything a later phase needs has to be
 * inside it.
 */
async function runPhase(title, next, fn) {
  const cached = replayed(title)
  if (cached) {
    log(`phase "${title}" replayed from run ${RUN.runId} — no agent ran`)
    for (const a of cached.agents || []) keep(a.result)
    return cached
  }
  phase(title)
  const artifact = await fn()
  for (const a of artifact.agents || []) keep(a.result)
  // A phase whose agents feed a second pipeline stage must report its own
  // failures in `artifact.failed`: the stage's OUTPUT is what lands in
  // `agents`, and a lens that returned null still produces an empty array
  // there, so deriving failures from the artifact alone silently sees none.
  const failed = Array.isArray(artifact.failed)
    ? artifact.failed
    : (artifact.agents || []).filter(a => a.result === null || a.result === undefined).map(a => a.label)
  const b = await recordPhase(title, artifact, next, failed)
  if (b.entry) BREAKER_ENTRIES.push(b.entry)
  if (b.tripped) {
    // Stop the chain — do not merely log the trip. A breaker that records a
    // trip and then lets the next phase run has not opened the circuit: here
    // that meant release-manager producing a readiness recommendation from one
    // of four verify lenses, with nothing in its prompt saying three had died.
    //
    // Deliberately a plain sentinel object rather than an Error: the top-level
    // handler must be able to tell a decision this workflow made from a genuine
    // crash, and must not re-throw this one.
    throw { breakerStop: true, title, entry: b.entry }
  }
  return artifact
}

function agentResult(artifact, label) {
  const a = ((artifact && artifact.agents) || []).find(x => x && x.label === label)
  return a ? a.result : null
}

/**
 * CHG-16 — `blockedGates` is a REDUCER over the phase artifacts, not a string
 * telling the reader to go and collect the entries themselves.
 */
async function collectBlockedGates() {
  // Pure prefilter, not a reimplementation of the reducer: every entry the
  // regex can match contains the literal token BLOCKED, so dropping values that
  // do not cannot change the result. It only keeps the bridge payload small.
  const candidates = OUTPUTS.filter(v => {
    try { return JSON.stringify(v ?? '').includes('BLOCKED') } catch (e) { return true }
  })
  if (!candidates.length) return { gates: [], complete: true }
  const r = await bridge('blocked-gates', `${REQUIRE_HEAD}const p = require(path.join(DIR, '_policy.js'))
process.stdout.write(JSON.stringify(p.collectBlockedGates(${JSON.stringify(candidates)})))`)
  if (Array.isArray(r)) return { gates: r, complete: true }
  // An empty array here would read as "no gate was hit", which is the exact
  // disappearance the reducer exists to prevent. Report the failure as a gate.
  return {
    complete: false,
    gates: [{
      gate: 'reporting.blockedGatesUncollected',
      actionWithheld: 'collecting the BLOCKED entries this run produced',
      whyGated: `${candidates.length} phase output(s) contain a BLOCKED marker but the reducer could not be run, so they were not parsed`,
      prepared: 'the raw phase outputs are in the run directory when recording was available',
      unblocks: 'read the phase artifacts directly, or re-run with the runtime modules reachable',
      authorizeBy: 'not an authorization gate — a reporting failure',
    }],
  }
}

async function closeRun(summary) {
  if (!RUN) return null
  return bridge('close', `${REQUIRE_HEAD}const s = require(path.join(DIR, '_state.js'))
const run = s.openRun({ workflow: ${JSON.stringify(WORKFLOW)}, cwd: process.cwd(), resumeFrom: ${JSON.stringify(RUN.runId)} })
// A fresh process makes the recorder's own clock start now; the run's real
// start is already in the manifest.
run._startMs = Date.parse(run.manifest.startedAt)
// Reopening marks every completed phase as resumed. Only the phases this run
// actually replayed from cache were — reporting the rest would be a false claim
// inside the record whose whole job is to be trustworthy afterwards.
run.resumedPhases = new Set(${JSON.stringify(REPLAYED)})
process.stdout.write(JSON.stringify(run.close(${JSON.stringify(summary)})))`)
}

const target = args?.target
const env = args?.env ?? 'non-production'

// Checked before a run is opened: a missing target is an invalid invocation,
// not a run that happened and stopped, and there is nothing about it worth
// recording in a run directory.
if (!target) {
  return {
    status: 'stopped',
    reason: 'No target supplied. persona-runner and boundary-prober both require an explicit non-production target and refuse to default — asking is the correct behavior here, not guessing.',
    blockedGates: [],
    blockedGatesComplete: true,
    policySource: POLICY.source,
    degraded: POLICY.degraded,
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

// ===========================================================================
// The workflow itself. Wrapped so that every exit — a stop, a crash, or a clean
// finish — still reaches the outcome record. Deliberately NOT a
// `finally { return }`: returning from a finally swallows the thrown error and
// a crashed run would report success.
// ===========================================================================
let status = 'crashed'
let thrown = null
let result = null

async function runWorkflow() {
  const opened = await openRun('Discover')
  if (opened && opened.fatal) {
    status = 'stopped'
    return { status: 'stopped', reason: opened.fatal }
  }

  // -------------------------------------------------------------------------
  // Phase 1 — Discover. Evidence-derived, not guessed from the product category.
  // -------------------------------------------------------------------------
  const discoverArtifact = await runPhase('Discover', 'Explore', async () => {
    const discovery = await agent(
      withPolicy(`Derive the end-user personas this application actually implements. Every persona needs path:line provenance — a persona with none does not get written. Require two independent source types before marking one confirmed; never promote a candidate on your own judgment.

Emit specs conforming to personas-schema-template.yaml, which ships with the sdlc-suite:exploration-charter skill — load that skill to read the schema rather than constructing a path to it. Report ambiguous capability entries as the high-value output they are, not as a gap to fill by guessing. State explicitly what you could not determine.`),
      { agentType: 'sdlc-suite:persona-discovery', label: 'discover', phase: 'Discover', schema: PERSONA_SCHEMA },
    )
    return { agents: [{ label: 'discover', result: discovery }] }
  })

  const discovery = agentResult(discoverArtifact, 'discover')

  if (!discovery?.personas?.length) {
    status = 'stopped'
    return { status: 'stopped', reason: 'No personas derived from code evidence.', discovery }
  }

  const confirmed = discovery.personas.filter(p => p.status === 'confirmed')
  const candidates = discovery.personas.filter(p => p.status === 'candidate')
  log(`${confirmed.length} confirmed personas, ${candidates.length} candidates (candidates are NOT explored — they need a human call first)`)

  if (confirmed.length > 12) {
    status = 'stopped'
    return {
      status: 'stopped',
      reason: `${confirmed.length} personas exceeds persona-discovery's own stop condition of 12 — that indicates splitting on the wrong axis. Stopping rather than fanning out a wrong decomposition across dozens of agents.`,
      discovery,
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2 — Explore. One isolated session per confirmed persona.
  // Only confirmed personas are explored; candidates await a human decision.
  // -------------------------------------------------------------------------
  const exploreArtifact = await runPhase('Explore', 'Probe', async () => {
    const sessions = await parallel(
      confirmed.map(p => () =>
        agent(
          withPolicy(`Explore ${target} in the ${env} environment as persona "${p.id}".

Adopt the persona's behavior model as constraints on HOW you act, not just what you check — a novice+sloppy persona takes wrong turns and submits bad input; a keyboard-only persona never uses a pointer. Stay inside its anti_goals. Use its own session_isolation_key; never reuse another persona's session.

Charter: pursue this persona's ranked jobs and report where it cannot complete them. Record an abandonment as a finding, including where it gave up and why. Synthetic data only. Refuse and stop if the target resolves to production.

Do NOT probe anything in this persona's forbidden list — record it and leave it to boundary-prober.`),
          { agentType: 'sdlc-suite:persona-runner', label: `explore:${p.id}`, phase: 'Explore' },
        ),
      ),
    )
    return { agents: confirmed.map((p, i) => ({ label: `explore:${p.id}`, result: sessions[i] })) }
  })

  const sessionsByPersona = confirmed
    .map(p => ({ persona: p.id, session: agentResult(exploreArtifact, `explore:${p.id}`) }))
    .filter(s => s.session)

  // -------------------------------------------------------------------------
  // Phase 3 — Probe. Ordered pairs: reach A's resources while authenticated as B.
  // Barrier is genuine here — the probe matrix needs the full persona set and
  // the resource identifiers the explore phase discovered.
  // -------------------------------------------------------------------------
  const pairs = []
  for (const a of confirmed) {
    for (const b of confirmed) {
      if (a.id !== b.id) pairs.push({ owner: a, actor: b })
    }
  }
  log(`${pairs.length} ordered persona pairs to probe`)

  const requestedJourneys = Array.isArray(args?.journeys) ? args.journeys : []

  const probeArtifact = await runPhase('Probe', requestedJourneys.length ? 'Journeys' : 'Report', async () => {
    const probes = await parallel(
      pairs.map(({ owner, actor }) => () =>
        agent(
          withPolicy(`Probe authorization between personas on ${target} (${env}).

Attempt to reach persona "${owner.id}"'s resources while authenticated as persona "${actor.id}". Probe BOTH layers — an action hidden in ${actor.id}'s UI but reachable at its API is a finding, and usually the most serious class here. Cover horizontal (peer resource, same role) as well as vertical escalation, plus identifier substitution, direct navigation, stale-session reuse, and unauthenticated access.

Resources ${owner.id} must deny to others: ${owner.forbidden.join(', ') || '(none listed — report this as an unactionable spec gap rather than inventing identifiers)'}

Resource identifiers discovered during exploration:
${sessionsByPersona.map(s => `[${s.persona}] ${s.session}`).join('\n').slice(0, 4000)}

Use security-engineer's severity scale. Report an ambiguous cell as an unmade product decision, not a bug. Read-oriented probes only — no destructive probe against another persona's resource from inside this workflow.`),
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
    return { agents: pairs.map(({ owner, actor }, i) => ({ label: `probe:${actor.id}->${owner.id}`, result: probes[i] })) }
  })

  const probeResults = (probeArtifact.agents || []).map(a => a.result).filter(Boolean)
  const leaks = probeResults.flatMap(p => (p.leaks ?? []).map(l => ({ ...l, actor: p.actor, owner: p.owner })))
  const ambiguous = [...new Set(probeResults.flatMap(p => p.ambiguous ?? []))]
  log(`${leaks.length} authorization leaks, ${ambiguous.length} unresolved ambiguous cells`)

  // -------------------------------------------------------------------------
  // Phase 4 — Journeys. Multi-actor flows spanning personas, if any were
  // supplied. journey-orchestrator delegates each step to persona-runner
  // itself, so this is a nested orchestration. Skipped entirely when no
  // journeys are given — a journey can't be invented from the persona list
  // without guessing at the business process.
  // -------------------------------------------------------------------------
  let journeyResults = []

  if (requestedJourneys.length) {
    const journeyArtifact = await runPhase('Journeys', 'Report', async () => {
      log(`${requestedJourneys.length} multi-actor journeys to run`)
      const runs = await parallel(
        requestedJourneys.map((j, i) => () =>
          agent(
            withPolicy(`Run this multi-actor journey on ${target} (${env}): ${typeof j === 'string' ? j : JSON.stringify(j)}

Available personas: ${confirmed.map(p => p.id).join(', ')}

Maintain the journey ledger as the ONLY state channel between personas — artifact identifiers and observable facts, never credentials or session state. Delegate each step to persona-runner under a step-scoped charter, each with its own isolated identity.

After every handoff, verify from the RECEIVING persona's own view. A sender-side confirmation is not evidence of delivery. Also check negative propagation: personas outside the journey must not observe the artifact.

On a failed handoff, record exactly which one broke, preserve the ledger, and halt — do not skip ahead or fabricate the missing state.`),
            { agentType: 'sdlc-suite:journey-orchestrator', label: `journey:${i + 1}`, phase: 'Journeys' },
          ),
        ),
      )
      return { agents: requestedJourneys.map((j, i) => ({ label: `journey:${i + 1}`, result: runs[i] })) }
    })
    journeyResults = (journeyArtifact.agents || []).map(a => a.result).filter(Boolean)
  } else {
    log('No journeys supplied — skipping the multi-actor phase rather than inventing a business process')
  }

  // -------------------------------------------------------------------------
  // Phase 5 — Report. qa-engineer owns final triage; the explorers only report.
  // -------------------------------------------------------------------------
  const reportArtifact = await runPhase('Report', null, async () => {
    const verdict = await agent(
      withPolicy(`Triage this persona sweep into one verdict. The explorers reported what happened; the bug / bad-test / flake / environment classification is yours, per your §10 — do not treat their severity ratings as finished triage verdicts.

Rank authorization leaks by blast radius: cross-tenant > cross-user > cross-role > UI-only inconsistency. Keep security-engineer's severity scale for those and the persona-impact scale for usability findings, labeled so they don't get conflated.

Include a "what was NOT tested" section: candidate personas were deliberately not explored, and unresolved ambiguous cells are unmade product decisions rather than defects.

EXPLORATION SESSIONS:
${sessionsByPersona.map(s => `### ${s.persona}\n${s.session}`).join('\n\n').slice(0, 8000)}

AUTHORIZATION LEAKS:
${JSON.stringify(leaks, null, 2)}

AMBIGUOUS CELLS (need a product decision, not a fix):
${ambiguous.join('\n') || '(none)'}

MULTI-ACTOR JOURNEY RESULTS:
${journeyResults.length ? journeyResults.join('\n\n---\n\n').slice(0, 6000) : '(no journeys supplied — this coverage gap belongs in the "what was NOT tested" section)'}`),
      { agentType: 'sdlc-suite:qa-engineer', label: 'triage', phase: 'Report' },
    )
    return { agents: [{ label: 'triage', result: verdict }] }
  })

  status = 'completed'
  return {
    target,
    env,
    personas: { confirmed: confirmed.map(p => p.id), candidatesAwaitingDecision: candidates.map(p => p.id) },
    authorizationLeaks: leaks,
    journeys: { requested: requestedJourneys.length, results: journeyResults },
    ambiguousCapabilities: ambiguous,
    undeterminedByDiscovery: discovery.undetermined,
    verdict: agentResult(reportArtifact, 'triage'),
    humanDecisionRequired: [
      ...candidates.map(p => `Promote or reject candidate persona "${p.id}" — persona-discovery will not self-promote.`),
      ...ambiguous.map(a => `Resolve ambiguous capability: ${a}`),
    ],
  }
}

try {
  result = await runWorkflow()
} catch (e) {
  // A tripped breaker is a decision this workflow made, not a crash: it stops
  // the phases that depend on the failing one and records why. Anything else is
  // a genuine error, and is re-thrown once the outcome record is written.
  if (e && e.breakerStop === true) {
    status = 'stopped'
    result = {
      status: 'stopped',
      reason: `Breaker tripped in phase "${e.title}": ${e.entry.whyGated} Phases depending on it were not run.`,
    }
  } else {
    thrown = e
  }
}

let blocked = { gates: [], complete: false }
let outcome = null
try {
  blocked = await collectBlockedGates()
  outcome = await closeRun({
    status,
    findings: { confirmed: 0, refuted: 0, byLens: {} },
    refutations: [],
    blockedGates: [...blocked.gates, ...BREAKER_ENTRIES],
    error: thrown ? String((thrown && thrown.message) || thrown) : null,
  })
} catch (e) {
  // Never let a failure to WRITE the record replace the failure that caused it.
  log(`could not complete the outcome record: ${(e && e.message) || e}`)
}

if (thrown) throw thrown

return {
  ...(result || {}),
  status,
  runId: RUN ? RUN.runId : null,
  runDir: RUN ? RUN.dir : null,
  outcomeRecorded: !!outcome,
  resumedPhases: [...REPLAYED],
  // Every BLOCKED entry any agent emitted survives to this top level as a
  // parsed ARRAY, not as an instruction to the reader to go and collect them.
  blockedGates: [...blocked.gates, ...BREAKER_ENTRIES],
  blockedGatesComplete: blocked.complete,
  breakerTripped: BREAKER_ENTRIES.length ? BREAKER_ENTRIES : null,
  policySource: POLICY.source,
  degraded: POLICY.degraded,
}
