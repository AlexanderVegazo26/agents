export const meta = {
  name: 'sdlc-feature',
  description: 'Run a feature end-to-end through the SDLC agent suite: requirements, design, build, independent verification, release readiness',
  whenToUse: 'A feature or change large enough to warrant the full lifecycle. Pass the initiative description as args. Produces recommendations only — never deploys.',
  phases: [
    { title: 'Requirements', detail: 'product-analyst converts the initiative into numbered acceptance criteria' },
    { title: 'Design', detail: 'ux-designer and solution-architect in parallel' },
    { title: 'Build', detail: 'software-engineer / ui-engineer / database-engineer as the change requires' },
    { title: 'Verify', detail: 'code-reviewer, qa-engineer, security-engineer, performance-engineer independently' },
    { title: 'Cross-check', detail: 'every finding handed to a refuter before it is reported' },
    { title: 'Repair', detail: 'the builder fixes confirmed blocking findings in its own change — at most 2 rounds' },
    { title: 'Re-verify', detail: 'only the lenses that raised a blocking finding re-check the repair, then the refuter' },
    { title: 'Readiness', detail: 'release-manager synthesizes gates; technical-writer drafts docs' },
    { title: 'Runtime', detail: 'bridge steps that reach the recorder, the policy loader and the brief builder' },
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

const WORKFLOW = 'sdlc-feature'
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

// ---------------------------------------------------------------------------
// The initiative under development. Pass a string or {initiative, paths} object.
// ---------------------------------------------------------------------------
const initiative =
  typeof args === 'string' ? args : args?.initiative ?? 'No initiative supplied — report this and stop.'

const CRITERIA_SCHEMA = {
  type: 'object',
  required: ['criteria', 'assumptions', 'openQuestions', 'surfaces'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    // Which implementation surfaces the change actually touches. Drives Build fan-out.
    surfaces: {
      type: 'array',
      items: { type: 'string', enum: ['backend', 'frontend', 'data'] },
    },
  },
}

// CHG-20 — builders return a MANIFEST, not prose. This literal is a verbatim
// copy of `BUILD_MANIFEST_SCHEMA` in `_brief.js`, because a workflow script
// cannot require it. `_wiring.test.js` deep-equals the two, so the copy cannot
// drift from the module without a test failure.
const BUILD_MANIFEST_SCHEMA = {
  type: 'object',
  required: ['summary', 'filesChanged', 'criteriaAddressed'],
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string', maxLength: 2000,
      description: 'What you did and why, in at most 2000 characters. Not a diff — the reviewer can read the diff.',
    },
    filesChanged: {
      type: 'array',
      items: {
        type: 'object', required: ['path', 'role'], additionalProperties: false,
        properties: {
          path: { type: 'string' },
          role: { enum: ['implementation', 'test', 'config', 'docs', 'generated'] },
        },
      },
    },
    diffRef: {
      type: 'string',
      description: 'How a reader reaches the change: a git range such as HEAD~1..HEAD, or a worktree path.',
    },
    criteriaAddressed: {
      type: 'array', items: { type: 'string' },
      description: 'Acceptance criterion ids this work satisfies, e.g. AC-1.',
    },
    notAddressed: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'why'], additionalProperties: false,
        properties: { id: { type: 'string' }, why: { type: 'string' } },
      },
      description: 'Criteria deliberately NOT addressed, and why. Making the gap explicit is what stops it being discovered as a defect later.',
    },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings', 'verdict'],
  properties: {
    verdict: { type: 'string' },
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

// Per-lens brief budgets live in `_brief.js`'s LENS_BUDGETS, keyed by these
// same lens keys. They are deliberately NOT duplicated here: a second copy of a
// budget table is a second thing to drift.
const LENSES = [
  {
    key: 'review',
    agentType: 'code-reviewer',
    brief: 'Review by reading. Form your independent expectation from the criteria BEFORE reading the diff (your §4 contamination guard), then state if it changed. Never inherit the implementer\'s self-report.',
  },
  {
    key: 'qa',
    agentType: 'qa-engineer',
    brief: 'Verify by executing. Re-run any claimed verification yourself — a "tests pass" report is a hypothesis until you run it this session. Label every claim Verified / Falsified / Unverified / Untestable, and include the "what was NOT tested" section.',
  },
  {
    key: 'security',
    agentType: 'security-engineer',
    brief: 'Review mode — findings and direction, no rewrites. Classify Critical/High/Medium/Low/Informational. No finding without a plausible attack path; no security theater.',
  },
  {
    key: 'performance',
    agentType: 'performance-engineer',
    brief: 'Trace the target BEFORE measuring current behavior (your §3). If no target exists, say so and propose one labeled proposed-not-confirmed. No claim without a number.',
  },
]

/**
 * CHG-20 — one budgeted brief per lens, built from the build manifests.
 *
 * The fallback when the bridge cannot run is the manifest itself, NOT the old
 * concatenation of every builder's full output. Losing the budget is a
 * degradation; going back to re-sending three builders' prose into four lenses
 * would be a regression to the defect this change removes.
 */
async function buildBriefs(manifests, criteria, lensKeys) {
  const fallbackText =
    `## Acceptance criteria\n${criteria}\n\n## Implementation (build manifest — budget not applied)\n${JSON.stringify(manifests, null, 2)}`
  const fallback = () => {
    const out = {}
    for (const k of lensKeys) {
      out[k] = {
        text: fallbackText, chars: fallbackText.length, truncated: false, omittedFiles: [],
        handoff: {
          chars: fallbackText.length, truncated: false, omittedFiles: [],
          files: manifests.flatMap(m => ((m && m.filesChanged) || []).map(f => f.path)),
          diffRefs: manifests.map(m => m && m.diffRef).filter(Boolean),
        },
        briefSource: 'manifest-unbudgeted',
      }
    }
    return out
  }

  const r = await bridge('brief', `${REQUIRE_HEAD}const b = require(path.join(DIR, '_brief.js'))
const manifests = ${JSON.stringify(manifests)}
const criteria = ${JSON.stringify(criteria)}
const out = {}
for (const lens of ${JSON.stringify(lensKeys)}) {
  const br = b.buildBrief({ manifests: manifests, lens: lens, criteria: criteria })
  out[lens] = { text: br.text, chars: br.chars, truncated: br.truncated, omittedFiles: br.omittedFiles,
                handoff: b.handoffRecord(br, manifests), briefSource: 'buildBrief' }
}
process.stdout.write(JSON.stringify(out))`)

  if (!r) {
    log('brief bridge unavailable — each lens receives the build manifest itself, unbudgeted')
    return fallback()
  }
  for (const k of lensKeys) {
    if (!r[k] || typeof r[k].text !== 'string') {
      log('brief bridge returned an incomplete result — falling back to the unbudgeted manifest')
      return fallback()
    }
  }
  return r
}

/**
 * Hand every finding a lens raised to an independent refuter.
 *
 * Shared by Verify and by each repair round's re-verification, so a finding
 * raised after a fix is held to exactly the standard the original was.
 */
function refuteFindings(result, lensKey, criteriaText, phaseLabel = 'Cross-check') {
  if (!result?.findings?.length) return []
  return parallel(
    result.findings.map(f => () =>
      dispatch(
        withPolicy(`Try to REFUTE this finding. Default to refuted=true if you cannot substantiate it from actual evidence.

FINDING (${f.severity}): ${f.summary}
EVIDENCE CLAIMED: ${f.evidence}

Criteria for context:\n${criteriaText}`),
        {
          agentType: 'code-reviewer',
          label: `refute:${lensKey}`,
          phase: phaseLabel,
          effort: 'low',
          schema: {
            type: 'object',
            required: ['refuted', 'reasoning'],
            properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
          },
        },
      // A refuter that returned nothing has NOT refuted the finding. This used
      // to read `v?.refuted !== false`, so a dead refuter deleted every finding
      // it was handed: four null refuters -> zero confirmed and zero failure
      // records. independent-review already did the opposite; now both keep
      // the finding, flagged.
      ).then(v => (v === null || v === undefined
        ? { ...f, lens: lensKey, refuted: false, unverified: true, why: null }
        : { ...f, lens: lensKey, refuted: v.refuted === true, why: v.reasoning })),
    ),
  )
}

// ---------------------------------------------------------------------------
// The repair loop — detect, repair, independently re-verify, record.
// ---------------------------------------------------------------------------
// The single most repeated human process in this repository's history was
// "act on review, then re-review" (6a746ad, 10ad72f, 652f983, 8951c41), and no
// workflow did it. A confirmed Must-Fix finding went straight to readiness as
// a No-Go and waited for a person to re-run the whole lifecycle.
//
// Bounded at MAX_REPAIR_ROUNDS. The builder that wrote the change fixes it, in
// the change's own location; ONLY the lenses that raised a surviving blocking
// finding re-verify, and their new findings go through the same refuter. The
// builder never certifies its own repair — ROUTING.md's rule, enforced here by
// construction. An exhausted loop becomes a blocked gate, not a silent No-Go.
const MAX_REPAIR_ROUNDS = 2
const BLOCKING_RE = /must[\s-]?fix|critical|blocker|\bhigh\b/i

// An UNVERIFIED finding (its refuter returned nothing) is kept, never dropped —
// but it is not sent to a builder under the words "independent reviewers
// confirmed", because nobody did. It goes to readiness in its own section.
function isBlocking(f) {
  return !!f && !f.refuted && !f.unverified && BLOCKING_RE.test(String(f.severity || ''))
}

// Findings are compared by content, not object identity: a replayed phase
// hands back fresh objects, and a repair round must still recognise the
// finding it was sent to fix.
function findingKey(f) {
  return JSON.stringify([f.lens, f.severity, f.summary, f.file || null, f.line || null])
}

// ===========================================================================
// The workflow itself. Wrapped so that every exit — a stop, a crash, or a
// clean finish — still reaches the outcome record. Deliberately NOT a
// `finally { return }`: returning from a finally swallows the thrown error and
// a crashed run would report success.
// ===========================================================================
let status = 'crashed'
let findingCounts = { confirmed: 0, refuted: 0, byLens: {} }
let refutations = []
let repairRounds = null

async function runWorkflow() {
  const opened = await openRun('Requirements')
  if (opened && opened.fatal) {
    status = 'stopped'
    return { status: 'stopped', reason: opened.fatal }
  }

  // -------------------------------------------------------------------------
  // Phase 1 — Requirements. Everything downstream traces to these IDs.
  // -------------------------------------------------------------------------
  const reqArtifact = await runPhase('Requirements', 'Design', async () => {
    const reqs = await dispatch(
      withPolicy(`Convert this initiative into implementation-ready requirements: ${initiative}

Produce numbered, stable acceptance-criterion IDs — every downstream agent in this workflow traces against them, so an unstable ID breaks the whole run. Record assumptions as numbered/traceable/risk-rated per your §4. Do not invent a success metric that wasn't given; label any proposal as proposed-not-confirmed.

Also classify which implementation surfaces this genuinely touches (backend / frontend / data) so the build phase only spawns the specialists actually needed.`),
      { agentType: 'product-analyst', label: 'requirements', phase: 'Requirements', schema: CRITERIA_SCHEMA },
    )
    return { agents: [{ label: 'requirements', result: reqs }] }
  })

  const reqs = agentResult(reqArtifact, 'requirements')

  if (!reqs || !reqs.criteria?.length) {
    status = 'stopped'
    return {
      status: 'stopped',
      reason: 'product-analyst produced no acceptance criteria. Nothing downstream can trace against anything — this is a stop condition, not a reason to proceed on inference.',
      openQuestions: reqs?.openQuestions ?? [],
    }
  }

  const criteriaText = reqs.criteria.map(c => `${c.id}: ${c.text}`).join('\n')
  log(`${reqs.criteria.length} acceptance criteria; surfaces: ${reqs.surfaces.join(', ') || 'none classified'}`)

  // -------------------------------------------------------------------------
  // Phase 2 — Design. UX and architecture are genuinely independent inputs, and
  // both must land before build starts, so this is a legitimate barrier.
  // -------------------------------------------------------------------------
  const needsUx = reqs.surfaces.includes('frontend')
  const designArtifact = await runPhase('Design', 'Build', async () => {
    const designs = await parallel(
      [
        needsUx &&
          (() =>
            dispatch(
              withPolicy(`Produce the UX specification for these requirements:\n${criteriaText}\n\nSpecify every interactive state — initial, loading, empty, success, error, permission-denied, degraded. State accessibility requirements as checkable targets (a WCAG level, a contrast ratio, a touch-target size), not aspirations; ui-engineer owns turning them into measured values. Flag any gap back rather than inventing behavior.`),
              { agentType: 'ux-designer', label: 'ux-spec', phase: 'Design' },
            )),
        () =>
          dispatch(
            withPolicy(`Assess the architecture for these requirements:\n${criteriaText}\n\nDecide the tier per your §2 — if this is Tier 1, say so and keep it short rather than manufacturing an ADR. Define NFRs as measurable numbers, never "scalable" or "fast". Flag anything that constrains the UX so it can be reconciled before build rather than mid-implementation.`),
            { agentType: 'solution-architect', label: 'architecture', phase: 'Design' },
          ),
      ].filter(Boolean),
    )
    return {
      agents: [
        ...(needsUx ? [{ label: 'ux-spec', result: designs[0] }] : []),
        { label: 'architecture', result: needsUx ? designs[1] : designs[0] },
      ],
    }
  })

  const uxSpec = needsUx ? agentResult(designArtifact, 'ux-spec') : null
  const architecture = agentResult(designArtifact, 'architecture')

  // -------------------------------------------------------------------------
  // Phase 3 — Build. One specialist per surface actually touched. Each returns
  // a MANIFEST (CHG-20), so the verify phase can hand off by reference.
  // -------------------------------------------------------------------------
  const BUILDERS = {
    backend: {
      agentType: 'software-engineer',
      brief: 'Implement the backend/application changes. Stay inside scope — collect anything else you notice as "noticed but didn\'t touch".',
    },
    frontend: {
      agentType: 'ui-engineer',
      brief: `Implement the frontend against the UX specification, state-for-state. Do not invent a state the spec omitted — flag the gap.\n\nUX SPEC:\n${uxSpec ?? '(none produced)'}`,
    },
    data: {
      agentType: 'database-engineer',
      brief: 'Design and implement the schema/migration in Build mode. Rollback design is yours; rollback *rehearsal* is qa-engineer\'s to execute independently — hand it off as a hypothesis, not a confirmed result.',
    },
  }

  const surfaces = reqs.surfaces.filter(s => BUILDERS[s])
  const buildArtifact = await runPhase('Build', 'Verify', async () => {
    const built = await parallel(
      surfaces.map(surface => () =>
        dispatch(
          withPolicy(`${BUILDERS[surface].brief}

ACCEPTANCE CRITERIA (trace to these IDs):\n${criteriaText}

ARCHITECTURE CONTEXT:\n${architecture ?? '(none)'}

Report a BUILD MANIFEST, not prose. The reviewers that follow you read the code themselves — your summary is at most 2000 characters and exists to tell them what to look at and why, never to reproduce the diff. List every file you changed with its role, give a diffRef a reader can reach the change through (a git range, or the worktree path you were given), and name the criteria you addressed. Any criterion you did not address goes in notAddressed with the reason — an omission that is written down is a decision; one that is not is a defect found later.`),
          // retry: false — a builder mutates a worktree; see dispatch().
          { agentType: BUILDERS[surface].agentType, label: `build:${surface}`, phase: 'Build', isolation: 'worktree', schema: BUILD_MANIFEST_SCHEMA, retry: false },
        ),
      ),
    )
    return { agents: surfaces.map((s, i) => ({ label: `build:${s}`, result: built[i] })) }
  })

  const manifests = surfaces
    .map(s => {
      const m = agentResult(buildArtifact, `build:${s}`)
      return m ? { label: `build:${s}`, ...m } : null
    })
    .filter(Boolean)

  if (!manifests.length) {
    status = 'stopped'
    return { status: 'stopped', reason: 'No build surface produced an implementation manifest.', requirements: reqs }
  }

  // -------------------------------------------------------------------------
  // Phase 4 — Verify. Four independent evidentiary bases on the same change,
  // each handed a BUDGETED BRIEF built from the manifests rather than the
  // concatenated output of every builder.
  // -------------------------------------------------------------------------
  const briefs = await buildBriefs(manifests, criteriaText, LENSES.map(l => l.key))
  const handoffs = []
  // A lens that produced nothing is invisible in the pipeline's OUTPUT — its
  // refute stage turns a null lens result into an empty findings array. The
  // breaker would then never see the failure that it exists to count.
  const lensFailures = []

  const verifyArtifact = await runPhase('Verify', 'Readiness', async () => {
    const verified = await pipeline(
      LENSES,
      lens => {
        const b = briefs[lens.key]
        const text = b.text
        // briefChars is measured on the text this script actually interpolated,
        // never on the bridge's self-report. A mismatch means the value changed
        // in transit, and that is worth knowing about explicitly.
        handoffs.push({
          label: `verify:${lens.key}`,
          briefChars: text.length,
          truncated: b.truncated === true,
          omittedFiles: b.omittedFiles || [],
          briefSource: b.briefSource,
          bridgeIntegrity: b.chars === text.length,
        })
        if (b.chars !== text.length) {
          log(`verify:${lens.key} brief size disagrees with the builder (${b.chars} vs ${text.length}) — the brief may have been altered in transit`)
        }
        if (b.truncated) {
          log(`verify:${lens.key} brief was TRUNCATED to its budget — the lens is told so in the brief`)
        }
        return dispatch(
          withPolicy(`${lens.brief}

${text}

The section above is a BRIEF, by reference. It is not the diff. Read the changed files yourself with Read / Grep / Glob before concluding, and if the brief says it was truncated, say so in your verdict.`),
          { agentType: lens.agentType, label: `verify:${lens.key}`, phase: 'Verify', schema: FINDINGS_SCHEMA },
        ).then(r => {
          if (r === null || r === undefined) lensFailures.push(`verify:${lens.key}`)
          return r
        })
      },
      // Adversarially verify each finding from a different lens than produced it.
      (result, lens) => refuteFindings(result, lens.key, criteriaText),
    )
    return {
      agents: LENSES.map((l, i) => ({ label: `verify:${l.key}`, result: verified[i] })),
      handoff: handoffs,
      failed: lensFailures,
    }
  })

  const allFindings = (verifyArtifact.agents || []).flatMap(a => a.result || []).filter(Boolean)
  let confirmed = allFindings.filter(f => !f.refuted)
  const refuted = allFindings.filter(f => f.refuted)
  log(`${confirmed.length} findings survived cross-check, ${refuted.length} refuted`)

  // CHG-22 — the refutation reasoning is the most informative thing the run
  // produces, and it is what used to be unrecoverable an hour later. Set before
  // the repair loop, which appends each re-verification's own.
  refutations = allFindings.map(f => ({
    lens: f.lens, severity: f.severity, summary: f.summary, refuted: f.refuted === true, why: f.why ?? null,
  }))

  // -------------------------------------------------------------------------
  // Phase 4b — Repair. Bounded; see MAX_REPAIR_ROUNDS above.
  // -------------------------------------------------------------------------
  repairRounds = { max: MAX_REPAIR_ROUNDS, rounds: [], outcome: 'not-needed' }
  const seenFindings = [...allFindings]   // every finding any lens raised, all rounds
  let open = confirmed.filter(isBlocking)
  if (open.length && args?.repair === false) repairRounds.outcome = 'disabled'
  for (let k = 1; open.length && args?.repair !== false && k <= MAX_REPAIR_ROUNDS; k++) {
    const target = open
    const lensKeys = [...new Set(target.map(f => f.lens))]
    // Each finding goes to the builder(s) whose manifest names its file — paths
    // normalised, since a lens may cite `./src/x.ts` or an absolute path for a
    // manifest's `src/x.ts` — and a finding no manifest owns goes to every
    // builder. Per finding, not per set: one matching finding must not route
    // another surface's finding to the wrong builder.
    const normPath = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
    const owns = (m, f) => !!f.file && (m.filesChanged || []).some(x => {
      const a = normPath(x.path)
      const b = normPath(f.file)
      // A suffix match only when the shorter path still names a directory: a
      // manifest's root-level `index.ts` must not own a finding in `ui/index.ts`.
      const [short, long] = a.length <= b.length ? [a, b] : [b, a]
      return a === b || (short.includes('/') && long.endsWith(`/${short}`))
    })
    const ownersOf = f => {
      const o = manifests.filter(m => owns(m, f))
      return o.length ? o : manifests
    }
    const fixers = manifests.filter(m => target.some(f => ownersOf(f).includes(m)))
    const findingsFor = m => target.filter(f => ownersOf(f).includes(m))
    const surfaceOf = m => String(m.label).replace(/^build:/, '')

    const repairArtifact = await runPhase(`Repair ${k}`, `Re-verify ${k}`, async () => {
      const fixed = await parallel(fixers.map(m => () =>
        dispatch(
          withPolicy(`REPAIR, round ${k} of ${MAX_REPAIR_ROUNDS}. Independent reviewers confirmed the blocking findings below against the change you built. Fix them.

Work on YOUR ORIGINAL CHANGE, where it already lives — ${m.diffRef ? `reach it through: ${m.diffRef}` : 'the worktree or branch you built it in'}. Do not start from a fresh checkout: the change is not there, and a fix applied to the wrong tree fixes nothing. Stay inside the findings' scope; anything else you notice goes in your summary as noticed-but-not-touched.

A finding you believe is wrong is not yours to dismiss — say so in notAddressed with the evidence, and the independent lens that raised it will re-check. You do not certify this repair; the lens re-verifies it after you.

FINDINGS TO FIX:
${JSON.stringify(findingsFor(m).map(f => ({ lens: f.lens, severity: f.severity, summary: f.summary, evidence: f.evidence, file: f.file, line: f.line })), null, 2)}

YOUR ORIGINAL BUILD MANIFEST:
${JSON.stringify(m, null, 2)}

ACCEPTANCE CRITERIA:
${criteriaText}

Report a BUILD MANIFEST of the repair, with the same rules as the build: every file you changed, a diffRef, and criteriaAddressed.`),
          // retry: false — a repair MUTATES the change. A null after a partial
          // edit is not something a second attempt on top of it can cleanly fix.
          { agentType: BUILDERS[surfaceOf(m)].agentType, label: `repair:${surfaceOf(m)}`, phase: 'Repair', schema: BUILD_MANIFEST_SCHEMA, retry: false },
        ),
      ))
      return { agents: fixers.map((m, i) => ({ label: `repair:${surfaceOf(m)}`, result: fixed[i] })) }
    }, 'Repair')

    const repairManifests = (repairArtifact.agents || []).filter(a => a.result).map(a => ({ label: a.label, ...a.result }))
    if (!repairManifests.length) {
      repairRounds.rounds.push({ round: k, lenses: lensKeys, fixers: fixers.map(m => m.label), targeted: target.length, remaining: target.length, note: 'no builder produced a repair manifest' })
      break
    }

    const reverifyFailed = []
    const reArtifact = await runPhase(`Re-verify ${k}`, 'Readiness', async () => {
      const reLenses = LENSES.filter(l => lensKeys.includes(l.key))
      const out = await pipeline(
        reLenses,
        lens => dispatch(
          withPolicy(`${lens.brief}

RE-VERIFICATION, round ${k} of ${MAX_REPAIR_ROUNDS}. A builder has attempted to fix the blocking findings below, which your lens raised and an independent refuter confirmed. Decide INDEPENDENTLY whether each one is actually fixed: read the changed files yourself — the repair manifest is the builder's claim, not evidence. Report every finding that is still present, at its real severity, and any new defect the repair introduced. A finding you have shown to be fixed is not reported again; a finding you could not check is reported as still present, with why.

FINDINGS TO RE-CHECK:
${JSON.stringify(target.filter(f => f.lens === lens.key).map(f => ({ severity: f.severity, summary: f.summary, evidence: f.evidence, file: f.file, line: f.line })), null, 2)}

REPAIR MANIFEST(S):
${JSON.stringify(repairManifests, null, 2)}

ORIGINAL BUILD MANIFEST(S):
${JSON.stringify(manifests, null, 2)}

ACCEPTANCE CRITERIA:
${criteriaText}`),
          { agentType: lens.agentType, label: `reverify:${lens.key}`, phase: 'Re-verify', schema: FINDINGS_SCHEMA },
        ).then(r => {
          if (r === null || r === undefined) reverifyFailed.push(`reverify:${lens.key}`)
          return r
        }),
        (result, lens) => refuteFindings(result, lens.key, criteriaText, 'Re-verify'),
      )
      return {
        agents: reLenses.map((l, i) => ({ label: `reverify:${l.key}`, result: out[i] })),
        failed: reverifyFailed,
        deadLenses: reverifyFailed.map(x => x.replace(/^reverify:/, '')),
      }
    }, 'Re-verify')

    const reFindings = (reArtifact.agents || []).flatMap(a => a.result || []).filter(Boolean)
    // A re-verifier that returned nothing has certified nothing. Its lens's
    // findings stay open rather than reading as "fixed" by silence — the same
    // rule as the null refuter, one level up.
    const dead = new Set(reArtifact.deadLenses || [])
    const stillOpenUnchecked = target.filter(f => dead.has(f.lens))
    for (const f of stillOpenUnchecked) f.repairUnverified = true
    // Replace ONLY the findings this round targeted, and only for lenses that
    // actually re-checked them. Everything else the lens confirmed — its Should
    // Fix and Low findings, which the re-verifier was never shown — stays.
    // Dropping a re-verified lens's findings wholesale erased independently
    // confirmed findings on every successful repair (code review + QA, D1).
    const replaced = new Set(target.filter(f => !dead.has(f.lens)).map(findingKey))
    const kept = confirmed.filter(f => !replaced.has(findingKey(f)))
    const keptKeys = new Set(kept.map(findingKey))
    confirmed = kept.concat(reFindings.filter(f => !f.refuted && !keptKeys.has(findingKey(f))))
    seenFindings.push(...reFindings)
    for (const f of reFindings) {
      refutations.push({ lens: f.lens, severity: f.severity, summary: f.summary, refuted: f.refuted === true, why: f.why ?? null })
    }
    // In RE-verification a blocking finding stays open unless it was refuted —
    // even if its refuter died. The lens has positively said "still present";
    // a second agent's silence does not overrule that, and treating it as
    // unverified here let the loop report `closed` on a defect the re-verifier
    // had just re-confirmed (code review N1).
    open = [
      ...reFindings.filter(f => !f.refuted && BLOCKING_RE.test(String(f.severity || ''))),
      ...stillOpenUnchecked,
    ]
    repairRounds.rounds.push({
      round: k, lenses: lensKeys, fixers: fixers.map(m => m.label),
      targeted: target.length, remaining: open.length, deadReverifiers: [...dead],
      // Per lens, so a lens that closed while another exhausted is never
      // reported as churn (improve.py reads this).
      openLenses: [...new Set(open.map(f => f.lens))],
    })
    log(`repair round ${k}: ${target.length} blocking finding(s) targeted, ${open.length} still open`)
  }
  if (repairRounds.rounds.length) repairRounds.outcome = open.length ? 'exhausted' : 'closed'
  if (repairRounds.outcome === 'exhausted') {
    // Through the same reducer as every autonomy gate, so it cannot vanish from
    // a run whose other phases look clean.
    keep([
      'BLOCKED — repair.exhausted',
      `  Action withheld: declaring the change fixed after ${repairRounds.rounds.length} bounded repair round(s)`,
      `  Why gated: ${open.length} blocking finding(s) survived independent re-verification: ${open.map(f => `[${f.lens}] ${f.summary}`).join('; ').slice(0, 600)}`,
      '  Prepared: every round\'s repair manifest and re-verification is in the run directory',
      '  Unblocks: a human or a fresh sdlc-feature run addressing the named findings',
      '  Authorize by: not an authorization gate — the repair loop is bounded by design',
    ].join('\n'))
  }

  // After repair, and every count from the same final state: `confirmed` is
  // what survived the last re-verification; `refuted` and `byLens` include each
  // re-verification's findings, so the three numbers agree with one another.
  const verified = confirmed.filter(f => !f.unverified)
  const unverified = confirmed.filter(f => f.unverified)
  findingCounts = {
    confirmed: verified.length,
    unverified: unverified.length,
    refuted: seenFindings.filter(f => f.refuted).length,
    byLens: LENSES.reduce((acc, l) => {
      acc[l.key] = seenFindings.filter(f => f.lens === l.key).length
      return acc
    }, {}),
  }

  // -------------------------------------------------------------------------
  // Phase 5 — Readiness. Recommendation only. No deploy authority here.
  // -------------------------------------------------------------------------
  const readinessArtifact = await runPhase('Readiness', null, async () => {
    const [readiness, docs] = await parallel([
      () =>
        dispatch(
          withPolicy(`Assess release readiness from this evidence. Classify each gate Confirmed / Claimed-not-verified / Missing / N-A — do not upgrade a claim to Confirmed because it sounds reasonable.

Produce a RECOMMENDATION for human confirmation. You do not hold deploy authority and this workflow cannot grant it.

The autonomy policy in force is stated at the top of this prompt — you do not need to go and find it. Reproduce every BLOCKED gate entry from the evidence below verbatim in your output, each with what was prepared so a human can execute it in one step. Do not drop a blocked gate because the recommendation is otherwise a Go.

CONFIRMED FINDINGS (an independent refuter checked each; after the bounded repair loop):\n${JSON.stringify(verified, null, 2)}

UNVERIFIED FINDINGS — raised by a lens, but the refuter returned NOTHING, so no one has confirmed or dismissed them. Treat each as open and classify it Claimed-not-verified, never Confirmed:\n${JSON.stringify(unverified, null, 2)}

REPAIR LOOP RECORD — blocking findings the builder repaired and an independent lens re-verified:\n${JSON.stringify(repairRounds, null, 2)}

OPEN ASSUMPTIONS / QUESTIONS FROM REQUIREMENTS:\n${[...reqs.assumptions, ...reqs.openQuestions].join('\n') || '(none)'}`),
          { agentType: 'release-manager', label: 'readiness', phase: 'Readiness' },
        ),
      () =>
        dispatch(
          withPolicy(`Draft the user-facing documentation and release notes for this change. Verify every behavioral claim against the actual implementation, not the requirement text — label anything you could not verify as Unverified rather than asserting or omitting it.

CRITERIA:\n${criteriaText}

IMPLEMENTATION (build manifest — read the listed files rather than assuming their contents):\n${JSON.stringify(manifests, null, 2)}`),
          { agentType: 'technical-writer', label: 'docs', phase: 'Readiness' },
        ),
    ])
    return { agents: [{ label: 'readiness', result: readiness }, { label: 'docs', result: docs }] }
  })

  status = 'completed'
  return {
    initiative,
    requirements: reqs,
    design: { ux: uxSpec, architecture },
    surfacesBuilt: surfaces,
    buildManifests: manifests,
    verifyHandoff: (verifyArtifact.handoff && verifyArtifact.handoff.length) ? verifyArtifact.handoff : handoffs,
    // `confirmed` keeps every surviving finding, unverified ones flagged, so a
    // consumer that reads only this list still sees them; `unverified` names
    // the subset no refuter checked.
    findings: { confirmed, unverified, refutedCount: findingCounts.refuted },
    readinessRecommendation: requireResult('readiness', agentResult(readinessArtifact, 'readiness')),
    documentation: agentResult(readinessArtifact, 'docs'),
    humanDecisionRequired: [
      'Release go/no-go — release-manager recommends, it never commits.',
      ...reqs.openQuestions,
    ],
  }
}

// Every exit — stop, crash or clean finish — reaches the outcome record,
// the retry and learnings ledger, and the blocked-gate reducer. See
// finishRun() in the runtime block.
return await finishRun(runWorkflow, () => ({ findings: findingCounts, refutations, repairRounds }))
