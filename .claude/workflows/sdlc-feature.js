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
const RESUME_ID = resolvedPath(args?.resume)
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

// ===========================================================================
// The workflow itself. Wrapped so that every exit — a stop, a crash, or a
// clean finish — still reaches the outcome record. Deliberately NOT a
// `finally { return }`: returning from a finally swallows the thrown error and
// a crashed run would report success.
// ===========================================================================
let status = 'crashed'
let thrown = null
let result = null
let findingCounts = { confirmed: 0, refuted: 0, byLens: {} }
let refutations = []

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
    const reqs = await agent(
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
            agent(
              withPolicy(`Produce the UX specification for these requirements:\n${criteriaText}\n\nSpecify every interactive state — initial, loading, empty, success, error, permission-denied, degraded. State accessibility requirements as checkable targets (a WCAG level, a contrast ratio, a touch-target size), not aspirations; ui-engineer owns turning them into measured values. Flag any gap back rather than inventing behavior.`),
              { agentType: 'ux-designer', label: 'ux-spec', phase: 'Design' },
            )),
        () =>
          agent(
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
        agent(
          withPolicy(`${BUILDERS[surface].brief}

ACCEPTANCE CRITERIA (trace to these IDs):\n${criteriaText}

ARCHITECTURE CONTEXT:\n${architecture ?? '(none)'}

Report a BUILD MANIFEST, not prose. The reviewers that follow you read the code themselves — your summary is at most 2000 characters and exists to tell them what to look at and why, never to reproduce the diff. List every file you changed with its role, give a diffRef a reader can reach the change through (a git range, or the worktree path you were given), and name the criteria you addressed. Any criterion you did not address goes in notAddressed with the reason — an omission that is written down is a decision; one that is not is a defect found later.`),
          { agentType: BUILDERS[surface].agentType, label: `build:${surface}`, phase: 'Build', isolation: 'worktree', schema: BUILD_MANIFEST_SCHEMA },
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
        return agent(
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
      (result, lens) =>
        result?.findings?.length
          ? parallel(
              result.findings.map(f => () =>
                agent(
                  withPolicy(`Try to REFUTE this finding. Default to refuted=true if you cannot substantiate it from actual evidence.

FINDING (${f.severity}): ${f.summary}
EVIDENCE CLAIMED: ${f.evidence}

Criteria for context:\n${criteriaText}`),
                  {
                    agentType: 'code-reviewer',
                    label: `refute:${lens.key}`,
                    phase: 'Cross-check',
                    effort: 'low',
                    schema: {
                      type: 'object',
                      required: ['refuted', 'reasoning'],
                      properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
                    },
                  },
                ).then(v => ({ ...f, lens: lens.key, refuted: v?.refuted !== false, why: v?.reasoning })),
              ),
            )
          : [],
    )
    return {
      agents: LENSES.map((l, i) => ({ label: `verify:${l.key}`, result: verified[i] })),
      handoff: handoffs,
      failed: lensFailures,
    }
  })

  const allFindings = (verifyArtifact.agents || []).flatMap(a => a.result || []).filter(Boolean)
  const confirmed = allFindings.filter(f => !f.refuted)
  const refuted = allFindings.filter(f => f.refuted)
  log(`${confirmed.length} findings survived cross-check, ${refuted.length} refuted`)

  findingCounts = {
    confirmed: confirmed.length,
    refuted: refuted.length,
    byLens: LENSES.reduce((acc, l) => {
      acc[l.key] = allFindings.filter(f => f.lens === l.key).length
      return acc
    }, {}),
  }
  // CHG-22 — the refutation reasoning is the most informative thing the run
  // produces, and it is what used to be unrecoverable an hour later.
  refutations = allFindings.map(f => ({
    lens: f.lens, severity: f.severity, summary: f.summary, refuted: f.refuted === true, why: f.why ?? null,
  }))

  // -------------------------------------------------------------------------
  // Phase 5 — Readiness. Recommendation only. No deploy authority here.
  // -------------------------------------------------------------------------
  const readinessArtifact = await runPhase('Readiness', null, async () => {
    const [readiness, docs] = await parallel([
      () =>
        agent(
          withPolicy(`Assess release readiness from this evidence. Classify each gate Confirmed / Claimed-not-verified / Missing / N-A — do not upgrade a claim to Confirmed because it sounds reasonable.

Produce a RECOMMENDATION for human confirmation. You do not hold deploy authority and this workflow cannot grant it.

The autonomy policy in force is stated at the top of this prompt — you do not need to go and find it. Reproduce every BLOCKED gate entry from the evidence below verbatim in your output, each with what was prepared so a human can execute it in one step. Do not drop a blocked gate because the recommendation is otherwise a Go.

CONFIRMED FINDINGS:\n${JSON.stringify(confirmed, null, 2)}

OPEN ASSUMPTIONS / QUESTIONS FROM REQUIREMENTS:\n${[...reqs.assumptions, ...reqs.openQuestions].join('\n') || '(none)'}`),
          { agentType: 'release-manager', label: 'readiness', phase: 'Readiness' },
        ),
      () =>
        agent(
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
    findings: { confirmed, refutedCount: refuted.length },
    readinessRecommendation: agentResult(readinessArtifact, 'readiness'),
    documentation: agentResult(readinessArtifact, 'docs'),
    humanDecisionRequired: [
      'Release go/no-go — release-manager recommends, it never commits.',
      ...reqs.openQuestions,
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
    findings: findingCounts,
    refutations,
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
  // Unattended runs defer gates rather than halting (see the autonomy-policy
  // skill). Every BLOCKED entry any agent emitted survives to this top level as
  // a parsed ARRAY — a blocked gate that vanishes because the rest of the run
  // looked clean is a reporting failure, and an instruction to the reader to go
  // and collect them is not a collection.
  blockedGates: [...blocked.gates, ...BREAKER_ENTRIES],
  blockedGatesComplete: blocked.complete,
  breakerTripped: BREAKER_ENTRIES.length ? BREAKER_ENTRIES : null,
  policySource: POLICY.source,
  degraded: POLICY.degraded,
}
