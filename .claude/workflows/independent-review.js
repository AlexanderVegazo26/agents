export const meta = {
  name: 'independent-review',
  description: 'Review a change through four independent evidentiary bases in parallel, adversarially cross-check every finding, then merge into one ranked report',
  whenToUse: 'A completed change (branch, PR, or diff) that needs review deeper than one pass. Pass the target as args — a branch name, path list, or "working tree".',
  phases: [
    { title: 'Review', detail: 'code-reviewer, qa-engineer, security-engineer, performance-engineer in parallel' },
    { title: 'Cross-check', detail: 'each finding handed to a refuter from a different lens' },
    { title: 'Merge', detail: 'dedupe and rank surviving findings by blast radius' },
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

const WORKFLOW = 'independent-review'

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

const target = typeof args === 'string' ? args : args?.target ?? 'the current working tree'

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
    agentType: 'code-reviewer',
    refuter: 'qa-engineer',
    brief:
      'Review by reading. Apply your §4 requirement-tracing contamination guard: form the expectation of correct behavior BEFORE reading the diff, then state explicitly if it changed and why. Assign severity (Must Fix / Should Fix / Nit) and confidence (High / Medium / Low) per your §7. Mark any finding that only execution can settle.',
  },
  {
    key: 'behavior',
    agentType: 'qa-engineer',
    refuter: 'code-reviewer',
    brief:
      'Verify by executing. Never inherit a "tests pass" claim you did not run this session. Label every claim Verified / Falsified / Unverified / Untestable. Load the hazard skills where they apply — concurrency-and-thread-safety, caching-and-invalidation, datetime-correctness — rather than naming a failure mode generically.',
  },
  {
    key: 'security',
    agentType: 'security-engineer',
    refuter: 'code-reviewer',
    brief:
      'Review mode: findings and direction only, no rewrites. Every finding needs a plausible attack path, affected component, realistic conditions, and meaningful impact. A theoretical weakness with no realistic impact is Informational, not High — do not produce security theater.',
  },
  {
    key: 'performance',
    agentType: 'performance-engineer',
    refuter: 'qa-engineer',
    brief:
      'Trace the target before measuring (your §3) — the current baseline is not the requirement. No claim without a number; label each Measured / Modeled / Assumed / Unknown. Do not run load tests against anything shared or production-adjacent from inside this workflow.',
  },
]

/**
 * CHG-20, applied where this workflow actually fans IN.
 *
 * There is no build phase here, so there is no builder prose to stop
 * concatenating. The unbounded handoff in this workflow is the Merge prompt,
 * which took `JSON.stringify(survived)` of every surviving finding from four
 * lenses. `buildBrief()` bounds it, and — the part that matters — says so in
 * the text when it has to cut, instead of silently handing the merger a partial
 * set it cannot tell from a complete one.
 *
 * Findings are mapped onto the manifest shape `_brief.js` renders: one manifest
 * per lens, its `summary` the lens's findings, its `filesChanged` the files
 * those findings cite, so the merger can go and read them.
 */
async function mergeBrief(survived, lensKeys) {
  const manifests = lensKeys
    .map(key => {
      const forLens = survived.filter(f => f.lens === key)
      if (!forLens.length) return null
      return {
        label: key,
        summary: forLens
          .map(f => `[${f.severity}] ${f.summary}\n  evidence: ${f.evidence}\n  cross-check: ${f.crossCheck}`)
          .join('\n'),
        filesChanged: [...new Set(forLens.map(f => f.file).filter(Boolean))].map(p => ({
          path: p, role: 'implementation',
        })),
        criteriaAddressed: [],
      }
    })
    .filter(Boolean)

  const fallbackText = JSON.stringify(survived, null, 2)
  const fallback = () => ({
    text: fallbackText, chars: fallbackText.length, truncated: false, omittedFiles: [],
    briefSource: 'findings-unbudgeted',
  })

  if (!manifests.length) return fallback()

  const r = await bridge('brief', `${REQUIRE_HEAD}const b = require(path.join(DIR, '_brief.js'))
const manifests = ${JSON.stringify(manifests)}
const br = b.buildBrief({ manifests: manifests, lens: 'review' })
process.stdout.write(JSON.stringify({ text: br.text, chars: br.chars, truncated: br.truncated, omittedFiles: br.omittedFiles, briefSource: 'buildBrief' }))`)

  if (!r || typeof r.text !== 'string') {
    log('brief bridge unavailable — the merge prompt carries every finding, unbudgeted')
    return fallback()
  }
  return r
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
let findingCounts = { confirmed: 0, refuted: 0, byLens: {} }
let refutations = []
let handoff = null

async function runWorkflow() {
  const opened = await openRun('Review')
  if (opened && opened.fatal) {
    status = 'stopped'
    return { status: 'stopped', reason: opened.fatal }
  }

  // A lens that produced nothing is invisible in the pipeline's OUTPUT — its
  // cross-check stage turns a null lens result into an empty findings array.
  // The breaker would then never see the failure it exists to count.
  const lensFailures = []

  const reviewArtifact = await runPhase('Review', 'Merge', async () => {
    const perLens = await pipeline(
      LENSES,
      lens =>
        agent(withPolicy(`Review ${target}. ${lens.brief}`), {
          agentType: lens.agentType,
          label: `review:${lens.key}`,
          phase: 'Review',
          schema: FINDINGS_SCHEMA,
        }).then(r => {
          if (r === null || r === undefined) lensFailures.push(`review:${lens.key}`)
          return r
        }),
      // Cross-check immediately per lens — no barrier, so a slow lens doesn't gate a fast one.
      (result, lens) =>
        result?.findings?.length
          ? parallel(
              result.findings.map(f => () =>
                agent(
                  withPolicy(`Attempt to REFUTE this finding using your own evidentiary basis, which is deliberately different from the one that produced it. Default to refuted=true when you cannot substantiate it from actual evidence in the code or from execution.

FINDING (${f.severity}) in ${f.file ?? 'unspecified'}${f.line ? ':' + f.line : ''}
${f.summary}
CLAIMED EVIDENCE: ${f.evidence}`),
                  {
                    agentType: lens.refuter,
                    label: `refute:${lens.key}`,
                    phase: 'Cross-check',
                    effort: 'low',
                    schema: VERDICT_SCHEMA,
                  },
                ).then(v => ({
                  ...f,
                  lens: lens.key,
                  // No verdict returned (agent died / stopped) is treated as unrefuted
                  // but explicitly flagged, rather than silently dropped either way.
                  refuted: v ? v.refuted : false,
                  crossCheck: v ? v.reasoning : 'refuter produced no verdict — finding is UNVERIFIED, not confirmed',
                })),
              ),
            )
          : [],
    )
    return {
      agents: LENSES.map((l, i) => ({ label: `review:${l.key}`, result: perLens[i] })),
      failed: lensFailures,
    }
  })

  const all = (reviewArtifact.agents || []).flatMap(a => a.result || []).filter(Boolean)
  const survived = all.filter(f => !f.refuted)
  log(`${all.length} raw findings, ${survived.length} survived cross-check`)

  findingCounts = {
    confirmed: survived.length,
    refuted: all.length - survived.length,
    byLens: LENSES.reduce((acc, l) => {
      acc[l.key] = all.filter(f => f.lens === l.key).length
      return acc
    }, {}),
  }
  refutations = all.map(f => ({
    lens: f.lens, severity: f.severity, summary: f.summary, refuted: f.refuted === true, why: f.crossCheck ?? null,
  }))

  if (!survived.length) {
    status = 'completed'
    return {
      target,
      findings: [],
      summary: `No findings survived adversarial cross-check across ${LENSES.length} independent lenses. ${all.length} candidate findings were refuted.`,
      refutedForAudit: all,
    }
  }

  const brief = await mergeBrief(survived, LENSES.map(l => l.key))
  // Measured on the text this script actually interpolates, never on the
  // bridge's self-report — a mismatch means the brief changed in transit.
  handoff = {
    label: 'merge',
    briefChars: brief.text.length,
    truncated: brief.truncated === true,
    omittedFiles: brief.omittedFiles || [],
    briefSource: brief.briefSource,
    bridgeIntegrity: brief.chars === brief.text.length,
  }
  if (brief.truncated) log('merge brief was TRUNCATED to its budget — the merger is told so in the brief')

  const mergeArtifact = await runPhase('Merge', null, async () => {
    const merged = await agent(
      withPolicy(`Deduplicate and rank these cross-checked findings into one report.

Rules:
- Two lenses reporting the same underlying defect is a STRONGER signal, not a duplicate to delete — merge them and say both methods agreed.
- Rank by blast radius and reversibility, not by which lens found it.
- Security findings keep security-engineer's Critical/High/Medium/Low/Informational scale; everything else uses Must Fix / Should Fix / Nit. Never blend the two scales without labeling which is in use.
- Any finding whose cross-check says "no verdict" is reported as Unverified, never as confirmed.

FINDINGS (a BRIEF, by reference — read any cited file yourself before concluding, and if the brief says it was truncated, say so in your report):
${brief.text}`),
      { agentType: 'code-reviewer', label: 'merge', phase: 'Merge' },
    )
    return { agents: [{ label: 'merge', result: merged }], handoff: [handoff] }
  })

  status = 'completed'
  return {
    target,
    lensesRun: LENSES.map(l => l.key),
    findings: survived,
    report: agentResult(mergeArtifact, 'merge'),
    mergeHandoff: handoff,
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
  // Every BLOCKED entry any agent emitted survives to this top level as a
  // parsed ARRAY. A blocked gate that vanishes because the rest of the run
  // looked clean is a reporting failure.
  blockedGates: [...blocked.gates, ...BREAKER_ENTRIES],
  blockedGatesComplete: blocked.complete,
  breakerTripped: BREAKER_ENTRIES.length ? BREAKER_ENTRIES : null,
  policySource: POLICY.source,
  degraded: POLICY.degraded,
}
