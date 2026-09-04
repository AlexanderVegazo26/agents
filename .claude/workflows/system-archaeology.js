export const meta = {
  name: 'system-archaeology',
  description: 'Reverse-engineer an undocumented system: derive who uses it and what it does from code evidence in parallel, cross-check the two, and synthesize an as-built PRD',
  whenToUse: 'Planning a rebuild or replatform of a system with no reliable documentation, or onboarding onto one. Produces evidence, never a recommendation about what to change.',
  phases: [
    { title: 'Detect', detail: 'establish stack and scope before reading anything domain-specific' },
    { title: 'Excavate', detail: 'persona-discovery (who) and product-archaeologist (what) in parallel' },
    { title: 'Cross-check', detail: 'capability/persona and requirement/implementation mismatches' },
    { title: 'Synthesize', detail: 'as-built PRD, then a downstream handoff brief' },
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

const WORKFLOW = 'system-archaeology'

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

const scope = typeof args === 'string' ? args : args?.scope ?? 'the whole application'
// Dynamic observation is opt-in and must name a non-production target. Absent
// one, this runs static-only and says so — it never guesses at a safe target.
const observeTarget = args?.observeTarget ?? null

const STACK_SCHEMA = {
  type: 'object',
  required: ['determined', 'undetermined', 'authLocated'],
  properties: {
    determined: { type: 'object', additionalProperties: true },
    undetermined: { type: 'array', items: { type: 'string' } },
    authLocated: { type: 'boolean' },
  },
}

// The PRD agent is asked to write two files. What it CLAIMS to have written is
// a claim, and this workflow used to print those two paths as a hardcoded
// literal — a positive assertion about artifacts, unconditioned on anything.
// It now reports what it claims, and a separate step checks the filesystem.
const PRD_SCHEMA = {
  type: 'object',
  required: ['prd', 'filesWritten'],
  properties: {
    prd: { type: 'string' },
    filesWritten: {
      type: 'array', items: { type: 'string' },
      description: 'Every path you actually wrote, repository-relative. List only files you wrote; an empty list is a valid and honest answer.',
    },
  },
}

const EXISTENCE_SCHEMA = {
  type: 'object',
  required: ['found', 'notFound'],
  properties: {
    found: { type: 'array', items: { type: 'string' } },
    notFound: { type: 'array', items: { type: 'string' } },
  },
}

/**
 * CHG-18 — `writtenTo` reports paths that were OBSERVED, and a path an agent
 * claimed but did not produce is reported as `claimedNotFound`.
 *
 * The old line was `writtenTo: ['.claude/discovery/prd.md',
 * '.claude/discovery/evidence-matrix.md']` — a hardcoded list literal, so the
 * field advertised two files that nothing in the workflow ever checked for.
 * That is worse than absent state: it is exactly the "artifacts over
 * assertions" failure the routing policy names.
 *
 * If the checker itself does not return, the answer is `writtenTo: []` with
 * `writtenToVerified: false` — never the claim promoted to an observation.
 */
async function observePaths(claimed) {
  const paths = [...new Set((claimed || []).filter(p => typeof p === 'string' && p.trim()))]
  if (!paths.length) return { found: [], notFound: [], verified: true }
  const r = await agent(
    withPolicy(`Check which of these paths exist on disk right now, relative to the repository root. Read-only: do not create, move or modify anything, and do not create a missing file to make the list come out even.

Use one command per path or a single test, for example: ls -la <path>

PATHS:
${paths.map(p => `- ${p}`).join('\n')}

Return every path that exists in "found" and every path that does not in "notFound". Every path above must appear in exactly one of the two lists.`),
    { agentType: 'general-purpose', label: 'observe-artifacts', phase: 'Synthesize', effort: 'low', schema: EXISTENCE_SCHEMA },
  )
  if (!r || !Array.isArray(r.found)) {
    log('artifact existence check produced no result — reporting no observed paths rather than the agent\'s claim')
    return { found: [], notFound: [], verified: false, claimed: paths }
  }
  const found = r.found.filter(p => paths.includes(p))
  const notFound = paths.filter(p => !found.includes(p))
  return { found, notFound, verified: true }
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
  const opened = await openRun('Detect')
  if (opened && opened.fatal) {
    status = 'stopped'
    return { status: 'stopped', reason: opened.fatal }
  }

  const detectArtifact = await runPhase('Detect', 'Excavate', async () => {
    const stack = await agent(
      withPolicy(`Detect the stack for ${scope}: language, framework, auth mechanism, data layer, API style, test tooling, deployment shape. Read manifests, lockfiles, and config — do not infer from the repo name or directory layout.

Record what you found AND what you could not determine. If the auth mechanism cannot be located, say so explicitly: both downstream agents treat that as a stop condition.`),
      { agentType: 'product-archaeologist', label: 'detect-stack', phase: 'Detect', schema: STACK_SCHEMA },
    )
    return { agents: [{ label: 'detect-stack', result: stack }] }
  })

  const stack = agentResult(detectArtifact, 'detect-stack')

  if (!stack) {
    status = 'stopped'
    return { status: 'stopped', reason: 'Stack detection produced no result — nothing downstream can proceed on evidence.' }
  }
  if (stack.authLocated === false) {
    status = 'stopped'
    return {
      status: 'stopped',
      reason: 'Auth mechanism could not be located. This is persona-discovery\'s explicit stop condition, and it also undermines product-archaeologist\'s permission-rule extraction. Stopping rather than producing a roster and capability map that both rest on a guess.',
      stack,
    }
  }
  log(`stack detected; ${stack.undetermined.length} aspects undetermined`)

  // -------------------------------------------------------------------------
  // Excavate. The two archaeology agents answer different questions from the
  // same codebase and are genuinely independent — running them in parallel is
  // not just faster, it keeps each from anchoring on the other's framing.
  // -------------------------------------------------------------------------
  const excavateArtifact = await runPhase('Excavate', 'Cross-check', async () => {
    const [personas, asBuilt] = await parallel([
      () =>
        agent(
          withPolicy(`Derive the end-user personas this application actually implements, for ${scope}.

Every persona needs path:line provenance; two independent source types before confirmed; never self-promote a candidate. Derive the capability envelope from authorization code, not from role names. Ambiguous entries are your highest-value output — do not empty that list by guessing.

Stack context: ${JSON.stringify(stack.determined)}`),
          { agentType: 'persona-discovery', label: 'who', phase: 'Excavate' },
        ),
      () =>
        agent(
          withPolicy(`Extract what this application actually does, for ${scope}: capability inventory, business rules, data model, integration surface, non-functional baseline, and gap/pain-point evidence.

Every claim needs a citation. Assign confirmed/candidate/rejected per item and never silently promote. Flag any rule that looks like an off-by-one or an inconsistency as a POSSIBLE DEFECT rather than asserting it as deliberate design.

${observeTarget
  ? `Dynamic observation is permitted against this NON-PRODUCTION target only: ${observeTarget}. Read-only and non-mutating exclusively — no migrations, no datastore writes, no state-changing calls. Cite what you ran, where, and what you saw. If that target resolves to production, stop.`
  : `NO observation target was supplied, so this is STATIC EVIDENCE ONLY. Do not start the application or run its suite against an unknown target. State this coverage limitation plainly in your output rather than under-covering behavioral confirmation silently.`}

Do NOT recommend what a better version should be. Describe what exists.

Stack context: ${JSON.stringify(stack.determined)}`),
          { agentType: 'product-archaeologist', label: 'what', phase: 'Excavate' },
        ),
    ])
    return { agents: [{ label: 'who', result: personas }, { label: 'what', result: asBuilt }] }
  })

  const personas = agentResult(excavateArtifact, 'who')
  const asBuilt = agentResult(excavateArtifact, 'what')

  if (!asBuilt) {
    status = 'stopped'
    return { status: 'stopped', reason: 'Capability extraction produced no result.', stack, personas }
  }

  // -------------------------------------------------------------------------
  // Cross-check. Genuine barrier: the mismatch analysis needs BOTH the roster
  // and the capability inventory, plus any existing product-analyst requirements.
  // -------------------------------------------------------------------------
  const crossArtifact = await runPhase('Cross-check', 'Synthesize', async () => {
    const mismatches = await agent(
      withPolicy(`Cross-check these two independently-derived evidence sets, plus any existing requirements under .claude/memory/<project>/requirements/.

Report four mismatch classes as FINDINGS. Do not silently reconcile any of them — a disagreement between what the code implements and what was ever specified is the single most valuable output of this run:
1. A capability no persona can reach (orphaned, admin-only, or dead).
2. A persona whose jobs-to-be-done have no corresponding capability.
3. An implemented capability with no product requirement.
4. A requirement with no implementation trace.

Also list every capability still at candidate status. If more than roughly half are candidates, say so plainly — that means the evidence sources are too sparse to trust the picture, and it is product-archaeologist's own stop condition.

PERSONAS (who):
${personas ?? '(persona-discovery produced no roster — treat every capability as unmapped and say so)'}

AS-BUILT (what):
${asBuilt}`),
      { agentType: 'product-archaeologist', label: 'cross-check', phase: 'Cross-check' },
    )
    return { agents: [{ label: 'cross-check', result: mismatches }] }
  })

  const mismatches = agentResult(crossArtifact, 'cross-check')

  // -------------------------------------------------------------------------
  // Synthesize. PRD first, then a handoff brief that stays non-prescriptive,
  // then an OBSERVATION of what was actually written.
  // -------------------------------------------------------------------------
  const synthArtifact = await runPhase('Synthesize', null, async () => {
    const prd = await agent(
      withPolicy(`Synthesize the as-built PRD per prd-synthesis's nine-section structure and write it to .claude/discovery/prd.md, with the citation appendix at .claude/discovery/evidence-matrix.md.

The one rule: this describes what EXISTS. Not one sentence about what should change. If a reader can't tell whether a sentence is a discovered fact or your preference, rewrite it.

Section 8, "what could not be determined", is mandatory and must include: ${stack.undetermined.join(', ') || 'nothing from stack detection'}${observeTarget ? '' : ', plus the fact that NO dynamic observation was performed at all'}.

Return the PRD text AND the exact list of paths you wrote. If you could not write a file, leave it out of that list rather than reporting the path you intended — the list is checked against the filesystem afterwards.

AS-BUILT EVIDENCE:
${asBuilt}

CROSS-CHECK FINDINGS:
${mismatches ?? '(none produced)'}

PERSONAS:
${personas ?? '(none)'}`),
      { agentType: 'product-archaeologist', label: 'prd', phase: 'Synthesize', schema: PRD_SCHEMA },
    )

    const prdText = prd ? prd.prd : null
    const observed = await observePaths(prd ? prd.filesWritten : [])

    const handoff = await agent(
      withPolicy(`Read the as-built PRD below and write a short handoff brief naming what each downstream agent most needs from it, and what remains an OPEN QUESTION for them rather than an answer.

Address: product-manager (what's worth carrying forward), product-analyst (what becomes new numbered requirements), solution-architect (what data-model and debt reality a rebuild must reckon with), ux-designer (which discovered interaction patterns to weigh keeping).

Critically: frame every item as a question or an input, never as a recommendation. You are equipping their decision, not making it. Any possible-defect flags belong to qa-engineer as hypotheses to verify, not as confirmed bugs.

PRD:
${prdText ?? '(the PRD agent produced no text)'}`),
      { agentType: 'product-archaeologist', label: 'handoff', phase: 'Synthesize' },
    )

    return {
      agents: [{ label: 'prd', result: prd }, { label: 'handoff', result: handoff }],
      artifacts: observed,
    }
  })

  const prd = agentResult(synthArtifact, 'prd')
  const observed = synthArtifact.artifacts || { found: [], notFound: [], verified: false }
  if (observed.notFound && observed.notFound.length) {
    log(`${observed.notFound.length} path(s) were claimed as written but do not exist: ${observed.notFound.join(', ')}`)
  }

  status = 'completed'
  return {
    scope,
    observationMode: observeTarget ? `dynamic (non-production: ${observeTarget})` : 'static evidence only',
    stackUndetermined: stack.undetermined,
    personas,
    asBuiltPrd: prd ? prd.prd : null,
    crossCheckFindings: mismatches,
    downstreamHandoff: agentResult(synthArtifact, 'handoff'),
    // Observed on disk, not asserted. `claimedNotFound` is a path the agent
    // said it wrote and that is not there.
    writtenTo: observed.found || [],
    claimedNotFound: observed.notFound || [],
    writtenToVerified: observed.verified === true,
    note:
      'EVIDENCE ONLY. This workflow deliberately produces no recommendation about what a rebuild should keep, cut, or improve — that is product-manager, product-analyst, solution-architect, and ux-designer, downstream, with a human confirming prioritization.',
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
