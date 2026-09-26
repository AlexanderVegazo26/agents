export const meta = {
  name: 'registry-audit',
  description: 'Re-run the .claude registry audit as a repeatable check: schema validation, orphan detection, overlap analysis, and tech-agnosticism, with every finding adversarially verified',
  whenToUse: 'After adding or changing agents/skills, to confirm the registry has not regressed. This is the audit in .claude/audit/ turned into a rerunnable script.',
  phases: [
    { title: 'Dimensions', detail: 'one auditor per audit dimension, in parallel' },
    { title: 'Verify', detail: 'each finding adversarially checked before it is reported' },
    { title: 'Report', detail: 'merge into a ranked register' },
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

const WORKFLOW = 'registry-audit'
// >>> RUNTIME BLOCK — generated from _runtime.block.js by tools/runtime_block.py; do not hand-edit >>>

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
  // Any two leading separators, in any mix: `/\host\share` passed the old
  // `\\\\|//` test and `path.win32.join` still produced a UNC path from it.
  if (/^[\\/]{2}/.test(p)) return null
  // Absolute only — a drive root or `/`. A relative value resolves against the
  // CONSUMING repo's working directory, so `.claude/workflows` made the bridge
  // `require` a `_policy.js` the reviewed repository wrote, and hand back any
  // gate table it liked. The command layer always passes an absolute
  // `${CLAUDE_PLUGIN_ROOT}/workflows`, so this rejects no legitimate value.
  if (!/^([A-Za-z]:[\\/]|\/)/.test(p)) return null
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

// Two policy arguments, because they mean two different things:
//   `policy`        — an EXPLICIT policy the invoker imposes. It is INTERSECTED
//                     with the repo's own file (a gate needs both), so an
//                     invoker can run stricter than the repo, never looser.
//   `policyDefault` — the plugin's shipped default, which every command passes.
//                     A FALLBACK: the repo's `.claude/autonomy.json` overrides it.
// Before the split, the commands passed the default as `policy`, so it beat the
// repo file and silently re-enabled every gate a repo had locked down.
const POLICY_PATH = resolvedPath(args?.policy)
const POLICY_DEFAULT_PATH = resolvedPath(args?.policyDefault)
const ANY_POLICY_PATH = POLICY_PATH || POLICY_DEFAULT_PATH
const RUNTIME_DIR =
  runtimeDirOf(args?.runtimeDir) ||
  (ANY_POLICY_PATH && parentDir(ANY_POLICY_PATH) ? runtimeDirOf(`${parentDir(ANY_POLICY_PATH)}/workflows`) : null)
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
const r = p.loadPolicy({ explicitPath: ${JSON.stringify(POLICY_PATH)}, defaultPath: ${JSON.stringify(POLICY_DEFAULT_PATH)} })
const actGranted = Object.keys(r.gates.act).filter(k => r.gates.act[k] === true)
process.stdout.write(JSON.stringify({ gateTable: p.gateTableForPrompt(r), source: r.source, degraded: r.degraded, errors: r.errors, actGranted: actGranted }))`)
  return r && typeof r.gateTable === 'string' && r.gateTable
    ? r
    : { gateTable: DEGRADED_TABLE, source: null, degraded: true, errors: ['the policy bridge did not run'], actGranted: [] }
})()

if (POLICY.degraded) {
  log(`AUTONOMY POLICY DEGRADED — ${POLICY.errors.join('; ') || 'no policy file resolved'}. Every gate reads not-authorized.`)
} else {
  log(`autonomy policy resolved from ${POLICY.source}`)
}
if (Array.isArray(POLICY.actGranted) && POLICY.actGranted.length) {
  log(`act.* gates GRANTED by ${POLICY.source}: ${POLICY.actGranted.join(', ')}`)
}

// Learnings travel on their OWN bridge step, never on the policy one. The
// policy bridge's output is the gate table every later agent is handed; carrying
// repository-authored free text through the same ungated transcriber, in the
// same JSON, would let a learning's text reach the one agent that controls it.
// A learnings failure therefore cannot touch the policy, and vice versa.
const LEARNING_SET = await (async () => {
  const r = await bridge('learnings', `${REQUIRE_HEAD}const l = require(path.join(DIR, '_learnings.js'))
const got = l.loadLearnings({ dirs: l.defaultDirs({ cwd: process.cwd(), runtimeDir: DIR }), cwd: process.cwd() })
// Repo-local lessons: signals recurring in THIS repo's recent runs, unratified,
// handed back on the next run with no human gate because they never leave it.
const repo = ${JSON.stringify(args?.repoLessons !== false)} ? l.loadRepoLessons({ cwd: process.cwd() }) : { entries: [], runsRead: 0 }
const all = got.entries.concat(repo.entries)
process.stdout.write(JSON.stringify({ byAgent: l.promptBlocksByAgent(all), sources: got.sources, skipped: got.skipped, repoRunsRead: repo.runsRead, repoLessons: repo.entries.length }))`)
  if (r && r.byAgent && typeof r.byAgent === 'object') return { ...r, error: null }
  return {
    byAgent: {}, sources: [], skipped: [],
    error: RUNTIME_DIR ? 'the learnings bridge did not run' : 'the runtime modules are unreachable',
  }
})()

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
// Learnings in, retries out — the two halves of "learn from the last run" and
// "heal this one", at the one call site every specialist agent goes through.
// --------------------------------------------------------------------------
const LEARNINGS = LEARNING_SET.byAgent || {}
const LEARNINGS_LOADED = []   // [{label, agentType, ids}] — lands in outcome.json
const RETRIES = []            // [{label, phase, agentType, attempts, recovered}]
const AGENT_TYPES = {}        // label -> agentType, so failure records can name the agent
const NULL_RESULTS = []       // labels of dispatches that ended with no result, in order
const REQUIRED_MISSING = []   // required deliverables that came back null
const RETRY_ENABLED = args?.retry !== false

if (LEARNING_SET.error) {
  log(`learnings could not be loaded — ${LEARNING_SET.error}. Agents run without prior-run lessons.`)
} else if (Object.keys(LEARNINGS).length) {
  log(`learnings loaded for: ${Object.keys(LEARNINGS).join(', ')}`)
}
if (LEARNING_SET.repoLessons) {
  log(`${LEARNING_SET.repoLessons} unratified repo-local lesson(s) from the last ${LEARNING_SET.repoRunsRead} run(s) of this repository`)
}
// A malformed or untracked learning that was refused is named, never silently
// absent — "it did not load" and "there was nothing to load" must differ.
for (const s of LEARNING_SET.skipped || []) log(`learning SKIPPED — ${s}`)

function learningsBlockFor(agentType) {
  const name = String(agentType || '').replace(/^.*:/, '')
  return (name && LEARNINGS[name]) || LEARNINGS['*'] || null
}

/**
 * Dispatch a specialist agent: prefix the ratified learnings that name it, and
 * re-dispatch ONCE when it returns nothing.
 *
 * WHY ONE RETRY, AND WHY IT IS REWRITTEN
 * `agent()` returns null with no stderr, no exit code and no message — after the
 * host has already applied its own transport retries. So this cannot classify
 * the failure, and does not pretend to. What it can do is the one thing the
 * host's retry cannot: change the request. The retry names the previous empty
 * result and restates the output contract, which is `_failure.js`'s BAD_INPUT
 * strategy (retry with the conformance failure named) — the only class whose
 * second attempt is designed to differ from the first. A second identical
 * request is what the taxonomy calls not self-healing, so there is no third.
 *
 * The retry is deterministic (no clock, no randomness), so resume stays exact.
 * `args.retry === false` turns it off for a run that must not spend twice, and
 * `retry: false` in a call's opts turns it off for that call — used for agents
 * that MUTATE (builders, repairs): a null from one of those may follow a partial
 * edit, and a second attempt on top of it is not a clean retry. A user who
 * deliberately skips an agent also produces a null; that cannot be told apart
 * from a failure here, so a skipped read-only agent is asked once more.
 *
 * LEARNINGS GO AFTER THE GATE TABLE, NEVER BEFORE IT. The autonomy-policy skill
 * tells an agent that a prompt BEGINNING `AUTONOMY POLICY —` is authoritative;
 * prefixing learnings ahead of it broke that rule and — security review showed —
 * let a learning's text forge a second policy block that sat in front of the
 * real one. The table stays first; learnings follow it as fenced data.
 */
async function dispatch(prompt, opts) {
  const { retry: retryThisCall = true, ...o } = opts || {}
  const label = String(o.label || '')
  AGENT_TYPES[label] = o.agentType || null
  const lb = learningsBlockFor(o.agentType)
  let full = prompt
  if (lb && lb.text) {
    const head = `${POLICY.gateTable}\n\n---\n\n`
    full = prompt.startsWith(head)
      ? `${head}${lb.text}\n\n---\n\n${prompt.slice(head.length)}`
      : `${prompt}\n\n---\n\n${lb.text}`
    if (lb.ids && lb.ids.length && !LEARNINGS_LOADED.some(x => x.label === label)) {
      LEARNINGS_LOADED.push({ label, agentType: o.agentType || null, ids: lb.ids })
    }
  }
  const first = await agent(full, o)
  if (first !== null && first !== undefined) return first
  if (!RETRY_ENABLED || !retryThisCall) {
    RETRIES.push({ label, phase: o.phase || null, agentType: o.agentType || null, attempts: 1, recovered: false })
    NULL_RESULTS.push(label)
    return first
  }
  log(`${label} returned no result — re-dispatching once with the output contract restated`)
  const second = await agent(`${full}

---
A previous attempt at this exact task returned NO result — nothing reached the workflow. That is the failure being corrected. Complete the task and return the required output${o.schema ? ', conforming exactly to the schema you were given' : ''}. If you genuinely cannot, return that as your result and say why — an explained refusal is usable, silence is not.`,
  { ...o, label: `${label} (retry)` })
  const recovered = second !== null && second !== undefined
  RETRIES.push({ label, phase: o.phase || null, agentType: o.agentType || null, attempts: 2, recovered })
  if (recovered) log(`${label} recovered on retry`)
  else NULL_RESULTS.push(label)
  return second
}

/**
 * Mark a result the workflow cannot honestly finish without — the readiness
 * recommendation, the merged review, the report. A run whose terminal agent
 * returned nothing used to report `completed` with the deliverable null; it is
 * now `incomplete`, with a gate naming what is missing.
 */
function requireResult(label, value) {
  if (value === null || value === undefined) REQUIRED_MISSING.push(label)
  return value
}

function repoLessonsLoaded() {
  return LEARNINGS_LOADED
    .map(x => ({ label: x.label, ids: (x.ids || []).filter(id => /^REPO-/.test(id)) }))
    .filter(x => x.ids.length)
}

function attemptsFor(label) {
  const r = RETRIES.filter(x => x.label === label).pop()
  return r ? r.attempts : 1
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
// A genuine resume is a new attempt, so the breaker below folds only this
// attempt's failures and a fixed-then-resumed run does not re-trip on old ones.
if (${JSON.stringify(RESUME_ID)}) run.beginAttempt()
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
 * up as more. Each record does name the agent and how many attempts
 * `dispatch()` made, so the distiller can address a recurring failure to the
 * agent that produced it rather than to a generic orchestrator.
 *
 * A TRIPPED PHASE IS FAILED, NOT COMPLETE. Marking it complete first meant a
 * resume replayed it from cache — one lens of four — and reported `completed`.
 * It is now `failPhase`d, so a resume re-executes it; and the breaker folds only
 * the current attempt's failures, so a resume after the cause is fixed does not
 * re-trip on the attempt it already recovered from.
 */
async function recordPhase(title, artifact, nextPhase, failedLabels) {
  if (!RUN) return { tripped: false, entry: null }
  const failed = (failedLabels || []).map(label => ({
    label, agentType: AGENT_TYPES[label] || null, attempts: attemptsFor(label),
  }))
  const r = await bridge('phase', `${REQUIRE_HEAD}const s = require(path.join(DIR, '_state.js'))
const f = require(path.join(DIR, '_failure.js'))
const run = s.openRun({ workflow: ${JSON.stringify(WORKFLOW)}, cwd: process.cwd(), resumeFrom: ${JSON.stringify(RUN.runId)} })
const done = run.manifest.phases.filter(p => p.status === 'complete')
// A fresh process starts its own clock at zero, so the recorder would time the
// bridge subprocess instead of the phase. The real boundary is already on disk.
const prevIso = done.length ? (run._cache.get(done[done.length - 1].title) || {}).completedAt : run.manifest.startedAt
run._phaseStartMs = Date.parse(prevIso || run.manifest.startedAt)
const title = ${JSON.stringify(title)}
const cls = f.classify({})
for (const x of ${JSON.stringify(failed)}) {
  run.recordFailure({ label: x.label, agentType: x.agentType, phase: title, class: cls, attempt: x.attempts, of: x.attempts,
    detail: 'agent() returned no result - skipped, blocked, or gave up after the host runtime retried',
    strategyNext: x.attempts > 1 ? 'the workflow re-dispatched once with the output contract restated and it still returned nothing'
                                 : 'no further attempt was made by the workflow script; the host runtime owns transport retry' })
}
const breaker = new f.Breaker()
for (const rec of run.readFailures()) {
  if ((rec.epoch || 1) === run.attempt) breaker.record(rec.phase, rec.class || cls)
}
const tripped = breaker.isTripped(title)
if (tripped) {
  run.failPhase(title, 'breaker tripped: ' + JSON.stringify(breaker.trippedInfo(title)))
} else {
  run.completePhase(title, ${JSON.stringify(artifact)})
  if (${JSON.stringify(nextPhase)}) run.startPhase(${JSON.stringify(nextPhase)})
}
process.stdout.write(JSON.stringify({ tripped: tripped, info: breaker.trippedInfo(title), entry: breaker.asBlockedEntry(title) }))`)
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
 *
 * `uiTitle` is the `meta.phases` title shown to the user when it differs from
 * the recorded one — a repair loop records `Repair 1`, `Repair 2` so each round
 * resumes independently, while both display under the one declared `Repair`.
 */
async function runPhase(title, next, fn, uiTitle) {
  const cached = replayed(title)
  if (cached) {
    log(`phase "${title}" replayed from run ${RUN.runId} — no agent ran`)
    for (const a of cached.agents || []) keep(a.result)
    // The phase's learnings and retry ledger replay with it. Without this a
    // resumed run's outcome.json said the lens that got LRN-x in attempt 1 got
    // no learnings at all — the exposure record effectiveness is measured on.
    const led = cached._ledger || {}
    for (const x of led.learningsLoaded || []) {
      if (!LEARNINGS_LOADED.some(y => y.label === x.label)) LEARNINGS_LOADED.push(x)
    }
    for (const x of led.retries || []) RETRIES.push(x)
    return cached
  }
  phase(uiTitle || title)
  const ll0 = LEARNINGS_LOADED.length
  const rt0 = RETRIES.length
  const nl0 = NULL_RESULTS.length
  const artifact = await fn()
  artifact._ledger = { learningsLoaded: LEARNINGS_LOADED.slice(ll0), retries: RETRIES.slice(rt0) }
  for (const a of artifact.agents || []) keep(a.result)
  // Every dispatch in this phase that ended null — including refuters and
  // verifiers, whose null used to reach neither failures.jsonl nor the breaker,
  // so a run where cross-checking never happened looked healthy. A phase whose
  // agents feed a second pipeline stage may also report failures in
  // `artifact.failed`; those are merged, not double-counted.
  const nulls = NULL_RESULTS.slice(nl0)
  const declared = Array.isArray(artifact.failed)
    ? artifact.failed
    : (artifact.agents || []).filter(a => a.result === null || a.result === undefined).map(a => a.label)
  const failed = [...nulls, ...declared.filter(l => !nulls.includes(l))]
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

/**
 * The self-improvement loop's own failure, as a gate that cannot vanish.
 *
 * A run whose runtime was unreachable completed its phases and recorded nothing
 * — no outcome, no failures, no learnings in or out. Before this it returned
 * `status: 'completed'` with `outcomeRecorded: false` buried in the payload, and
 * four of six commands produced exactly that on every invocation because they
 * passed `args` as a bare string. Measured: zero run directories, ever.
 */
function runtimeGates(outcome) {
  const out = []
  if (!RUNTIME_DIR) {
    out.push({
      gate: 'runtime.unreachable',
      actionWithheld: 'recording this run, loading learnings from prior runs, and the cross-phase breaker',
      whyGated: 'args carried no usable runtimeDir or policy path (a bare-string args, or an unexpanded ${CLAUDE_PLUGIN_ROOT}), so the runtime modules could not be reached — this run can neither learn nor be learned from',
      prepared: 'the phases themselves ran, with every autonomy gate read as NOT pre-authorized',
      unblocks: 'invoke the workflow with args as an OBJECT carrying runtimeDir: "<plugin root>/workflows"',
      authorizeBy: 'not an authorization gate — a wiring failure',
    })
  } else if (RECORDING && !outcome) {
    out.push({
      gate: 'runtime.outcomeUnrecorded',
      actionWithheld: 'writing outcome.json for this run',
      whyGated: RUN ? 'the close bridge step did not run, so the run directory has no outcome' : 'the run directory could not be opened',
      prepared: 'the phase results are in this return value',
      unblocks: 'check that node runs in this environment and .claude/runs/ is writable, then re-run',
      authorizeBy: 'not an authorization gate — a recording failure',
    })
  }
  return out
}

/**
 * Run the workflow body and ALWAYS reach the outcome record — on a stop, a
 * crash, or a clean finish. Shared, because six hand-kept copies of this tail
 * had already drifted apart in the fields they recorded.
 *
 * Deliberately NOT a `finally { return }`: returning from a finally swallows the
 * thrown error and a crashed run would report success.
 *
 * Reads and writes the host workflow's `status`; `extras()` supplies the
 * workflow's own findings, refutations and repair record at close time.
 */
async function finishRun(body, extras = () => ({})) {
  let result = null
  let thrown = null
  try {
    result = await body()
  } catch (e) {
    // A tripped breaker is a decision this workflow made, not a crash: it stops
    // the phases that depend on the failing one and records why. Anything else
    // is a genuine error, and is re-thrown once the outcome record is written.
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

  // `completed` is a claim about the run, so it is withheld when the run cannot
  // back it. A run that could not reach its runtime recorded nothing and learned
  // nothing; a run whose terminal agent returned nothing has no deliverable.
  // Both used to read `completed`, and an orchestrator reading `status` saw a
  // clean run. They are `incomplete`, each with a gate saying why.
  const requiredGates = REQUIRED_MISSING.map(label => ({
    gate: 'run.deliverableMissing',
    actionWithheld: `reporting this run as completed`,
    whyGated: `the required result "${label}" came back empty, after one retry`,
    prepared: 'every earlier phase result is in this return value and the run directory',
    // A RE-RUN, not a resume: one null is below the breaker threshold, so the
    // phase was recorded complete with the empty result, and a resume would
    // replay that emptiness from cache (code review N2).
    unblocks: `re-run the workflow — a resume would replay the completed phase, empty deliverable included`,
    authorizeBy: 'not an authorization gate — a missing deliverable',
  }))
  if (status === 'completed' && (!RUNTIME_DIR || REQUIRED_MISSING.length)) status = 'incomplete'

  let blocked = { gates: [], complete: false }
  let outcome = null
  let x = {}
  try { x = extras() || {} } catch (e) { log(`could not collect the run's own record: ${(e && e.message) || e}`) }
  try {
    blocked = await collectBlockedGates()
    outcome = await closeRun({
      status,
      findings: x.findings || { confirmed: 0, refuted: 0, byLens: {} },
      refutations: x.refutations || [],
      blockedGates: [...blocked.gates, ...BREAKER_ENTRIES, ...requiredGates, ...runtimeGates(true)],
      error: thrown ? String((thrown && thrown.message) || thrown) : null,
      learningsLoaded: LEARNINGS_LOADED,
      repoLessonsLoaded: repoLessonsLoaded(),
      learningsSkipped: LEARNING_SET.skipped || [],
      learningsError: LEARNING_SET.error || null,
      policyDegraded: POLICY.degraded === true,
      actGranted: POLICY.actGranted || [],
      retries: RETRIES,
      repairRounds: x.repairRounds || null,
    })
  } catch (e) {
    // Never let a failure to WRITE the record replace the failure that caused it.
    log(`could not complete the outcome record: ${(e && e.message) || e}`)
  }

  if (thrown) throw thrown

  const allGates = [...blocked.gates, ...BREAKER_ENTRIES, ...requiredGates, ...runtimeGates(outcome)]
  return {
    ...(result || {}),
    status,
    // Stated first-class, not buried: any act.* gate the resolved policy
    // grants, and the file that granted it. A repo's own .claude/autonomy.json
    // can grant these, so a reader must be able to see that it did.
    actGranted: POLICY.actGranted || [],
    selfHealDisabled: !RUNTIME_DIR,
    runId: RUN ? RUN.runId : null,
    runDir: RUN ? RUN.dir : null,
    outcomeRecorded: !!outcome,
    resumedPhases: [...REPLAYED],
    // Unattended runs defer gates rather than halting (see the autonomy-policy
    // skill). Every BLOCKED entry any agent emitted survives to this top level
    // as a parsed ARRAY — a blocked gate that vanishes because the rest of the
    // run looked clean is a reporting failure.
    blockedGates: allGates,
    blockedGatesComplete: blocked.complete,
    breakerTripped: BREAKER_ENTRIES.length ? BREAKER_ENTRIES : null,
    learningsLoaded: LEARNINGS_LOADED,
    // First-class, like actGranted: which agents were steered by UNRATIFIED
    // repo-local lessons no human reviewed (security review).
    repoLessonsLoaded: repoLessonsLoaded(),
    learningsSkipped: LEARNING_SET.skipped || [],
    learningsError: LEARNING_SET.error || null,
    retries: RETRIES,
    ...(x.repairRounds ? { repairRounds: x.repairRounds } : {}),
    policySource: POLICY.source,
    degraded: POLICY.degraded,
  }
}
// <<< RUNTIME BLOCK <<<

// Accept a bare string like the other five workflows do — args arrives JSON-encoded often
// enough that reading only args.root silently audits '.claude' instead of the root you named.
const root =
  (typeof args === 'string' && args.trim()) ||
  (() => { try { return JSON.parse(args)?.root } catch (e) { return null } })() ||
  args?.root ||
  '.claude'
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
- Any tool listed in \`tools:\` is a real tool name, and is least-privilege for the agent's stated job. Flag write/exec granted to an agent whose description claims read-only.
- Any agent whose body instructs delegating to another agent must declare \`Agent(<name>)\` in tools — a prose delegation instruction with no Agent grant is unimplementable.
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

// ===========================================================================
// The workflow itself. Wrapped so that every exit — a stop, a crash, or a clean
// finish — still reaches the outcome record. Deliberately NOT a
// `finally { return }`: returning from a finally swallows the thrown error and
// a crashed run would report success.
// ===========================================================================
let status = 'crashed'
let findingCounts = { confirmed: 0, refuted: 0, byLens: {} }
let refutations = []

async function runWorkflow() {
  const opened = await openRun('Dimensions')
  if (opened && opened.fatal) {
    status = 'stopped'
    return { status: 'stopped', reason: opened.fatal }
  }

  // A dimension that produced nothing is invisible in the pipeline's OUTPUT —
  // its verify stage turns a null auditor result into an empty findings array.
  // The breaker would then never see the failure it exists to count.
  const dimFailures = []

  const dimArtifact = await runPhase('Dimensions', 'Report', async () => {
    const results = await pipeline(
      DIMENSIONS,
      d =>
        dispatch(
          withPolicy(`You are auditing a Claude Code agent/skill registry, read-only. Do not modify any file.

${d.brief}

Every finding MUST carry path:line evidence. If you cannot cite evidence, DROP the finding — do not infer, extrapolate, or fill gaps with plausible defaults. Report what is genuinely fine as fine. A short honest audit beats a long padded one.`),
          { agentType: 'general-purpose', label: `audit:${d.key}`, phase: 'Dimensions', schema: FINDINGS_SCHEMA },
        ).then(r => {
          if (r === null || r === undefined) dimFailures.push(`audit:${d.key}`)
          return r
        }),
      // Verify each finding immediately rather than waiting for all dimensions.
      (result, d) =>
        result?.findings?.length
          ? parallel(
              result.findings.map(f => () =>
                dispatch(
                  withPolicy(`Verify this audit finding by reading the cited file yourself. Set confirmed=false if the evidence does not actually support the claim, if the cited path or line does not exist, or if the "problem" is intentional and correct as written.

Be skeptical: audit agents over-report. Default to confirmed=false when uncertain.

FINDING [${f.severity}] ${f.id}: ${f.summary}
CITED AT: ${f.path}${f.line ? ':' + f.line : ''}
CLAIMED EVIDENCE: ${f.evidence}`),
                  {
                    agentType: 'general-purpose',
                    label: `verify:${f.id}`,
                    phase: 'Verify',
                    effort: 'low',
                    schema: {
                      type: 'object',
                      required: ['confirmed', 'reasoning'],
                      properties: { confirmed: { type: 'boolean' }, reasoning: { type: 'string' } },
                    },
                  },
                // A verifier that returned nothing has not DISconfirmed the finding.
                // Dropping it on a null verdict made a dead verifier indistinguishable
                // from a clean registry. It is kept, flagged unverified.
                ).then(v => (v === null || v === undefined
                  ? { ...f, dimension: d.key, confirmed: true, unverified: true, verifyNote: null }
                  : { ...f, dimension: d.key, confirmed: v.confirmed === true, verifyNote: v.reasoning })),
              ),
            )
          : [],
    )
    return {
      agents: DIMENSIONS.map((d, i) => ({ label: `audit:${d.key}`, result: results[i] })),
      failed: dimFailures,
    }
  })

  const all = (dimArtifact.agents || []).flatMap(a => a.result || []).filter(Boolean)
  const confirmed = all.filter(f => f.confirmed)
  const dropped = all.filter(f => !f.confirmed)
  log(`${confirmed.length} findings confirmed, ${dropped.length} dropped on verification`)

  findingCounts = {
    confirmed: confirmed.length,
    refuted: dropped.length,
    byLens: DIMENSIONS.reduce((acc, d) => {
      acc[d.key] = all.filter(f => f.dimension === d.key).length
      return acc
    }, {}),
  }
  refutations = all.map(f => ({
    lens: f.dimension, severity: f.severity, summary: f.summary, refuted: !f.confirmed, why: f.verifyNote ?? null,
  }))

  const bySeverity = s => confirmed.filter(f => f.severity === s)

  const reportArtifact = await runPhase('Report', null, async () => {
    const report = await dispatch(
      withPolicy(`Write the audit register from these VERIFIED findings only.

Lead with the count of BLOCKER findings. Group by severity. Every entry: id, severity, path:line, impact, concrete fix. Then a short "verified clean" section listing what was checked and found genuinely fine — that section is not filler, it is what makes the findings trustworthy.

Note explicitly that ${dropped.length} candidate findings were dropped because verification could not substantiate them.

VERIFIED FINDINGS:
${JSON.stringify(confirmed.filter(f => !f.unverified), null, 2)}

UNVERIFIED FINDINGS — the verifier returned nothing, so these were neither confirmed nor dismissed. Report them in their own section as open and unchecked, never as verified:
${JSON.stringify(confirmed.filter(f => f.unverified), null, 2)}`),
      { agentType: 'general-purpose', label: 'report', phase: 'Report' },
    )
    return { agents: [{ label: 'report', result: report }] }
  })

  status = 'completed'
  return {
    root,
    totals: {
      blocker: bySeverity('BLOCKER').length,
      high: bySeverity('HIGH').length,
      medium: bySeverity('MEDIUM').length,
      low: bySeverity('LOW').length,
      droppedOnVerification: dropped.length,
    },
    findings: confirmed,
    report: requireResult('report', agentResult(reportArtifact, 'report')),
  }
}

// Every exit — stop, crash or clean finish — reaches the outcome record,
// the retry and learnings ledger, and the blocked-gate reducer. See
// finishRun() in the runtime block.
return await finishRun(runWorkflow, () => ({ findings: findingCounts, refutations }))
