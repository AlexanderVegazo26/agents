'use strict'

/**
 * Integration tests for the WIRING — CHG-16, CHG-18, CHG-19, CHG-20, CHG-22.
 *
 *     node sdlc-suite/workflows/_wiring.test.js
 *     node sdlc-suite/workflows/_wiring.test.js --src <dir>   # run against other copies
 *
 * No test framework: this repository has no package.json, so adding one would be
 * a new runtime dependency for every adopter. The exit code is the result.
 *
 * WHAT THIS TESTS, AND WHAT IT CANNOT
 * -----------------------------------
 * `_policy.test.js`, `_state.test.js`, `_failure.test.js` and `_brief.test.js`
 * test the modules. This file tests that the six workflows actually CALL them
 * and use what comes back — the seam that a module test cannot see.
 *
 * Each workflow is executed inside a replica of the host's Workflow-tool
 * sandbox: a `node:vm` context built from a null-prototype object carrying only
 * {log, phase, console, budget, setTimeout, clearTimeout} plus
 * {agent, parallel, pipeline, workflow, args}, with `Math.random()`,
 * `Date.now()` and argless `new Date()` shimmed to throw, and the body wrapped
 * in the same `(async () => {'use strict'; … })()`. That recipe was read out of
 * the shipped Claude Code binary (2.1.258) rather than recalled, and it means an
 * accidental `require`, `process` or `Date.now()` anywhere in the wiring fails
 * these tests rather than failing silently in production.
 *
 * The bridge steps are NOT stubbed away. The stub extracts the Node script the
 * workflow generated, writes it, and RUNS it — against the real `_policy.js`,
 * `_state.js`, `_failure.js` and `_brief.js`, in a real temporary working
 * directory. So the run directories, manifests, outcome records and briefs
 * asserted below are files that were actually produced.
 *
 * PROVEN BY EXECUTION: control flow, prompt construction, the payload shapes
 * the workflows hand the modules, the module results they get back, and every
 * file written under `.claude/runs/`.
 *
 * NOT PROVEN HERE — stated so nobody reads a green run as more than it is: that
 * a real language model, standing where the stub stands, transcribes the bridge
 * script and returns its stdout verbatim. That hop cannot be executed without a
 * live CLI, and its failure mode is exactly why every caller in the workflows
 * degrades in the safe direction instead of trusting the reply.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { execFileSync } = require('child_process')

const argv = process.argv.slice(2)
const srcFlag = argv.indexOf('--src')
const SRC = srcFlag >= 0 ? path.resolve(argv[srcFlag + 1]) : __dirname

// Modules always come from THIS directory, even when --src points elsewhere:
// the point of a fault-injection run is to test other workflow copies against
// the same modules, not to test other modules.
const policyMod = require('./_policy.js')
const briefMod = require('./_brief.js')
const POLICY_JSON = path.join(__dirname, '..', 'autonomy.json')
const RESOLVED = policyMod.loadPolicy({ explicitPath: POLICY_JSON })
const GATE_TABLE = policyMod.gateTableForPrompt(RESOLVED)

let passed = 0
const failures = []
function test(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') return r.then(
      () => { passed++; console.log(`  pass  ${name}`) },
      e => { failures.push(name); console.error(`  FAIL  ${name}\n        ${e && e.message}`) },
    )
    passed++
    console.log(`  pass  ${name}`)
  } catch (e) {
    failures.push(name)
    console.error(`  FAIL  ${name}\n        ${e && e.message}`)
  }
  return Promise.resolve()
}

// --------------------------------------------------------------------------
// The sandbox replica.
// --------------------------------------------------------------------------

// Read out of the shipped binary. `new Date(x)` with arguments still works;
// `new Date()`, bare `Date()` and `Date.now()` do not, and neither does
// `Math.random()`.
const DETERMINISM_SHIM = `(() => {
  const ERR = 'unavailable in workflow scripts (breaks resume)';
  Math.random = function random() { throw new Error(ERR) };
  const RealDate = Date;
  RealDate.now = function now() { throw new Error(ERR) };
  function ShimDate(...a) {
    if (!new.target) throw new Error(ERR);
    if (a.length === 0) throw new Error(ERR);
    return new RealDate(...a);
  }
  ShimDate.prototype = RealDate.prototype;
  ShimDate.parse = RealDate.parse;
  ShimDate.UTC = RealDate.UTC;
  ShimDate.now = RealDate.now;   // the throwing one, so Date.now() throws rather than being absent
  globalThis.Date = ShimDate;
})()`

function parallelImpl(thunks) {
  return Promise.all([...thunks].map(t => Promise.resolve().then(() => t()).catch(() => null)))
}

function pipelineImpl(items, ...stages) {
  return Promise.all([...items].map(async (item, i) => {
    let cur = item
    for (const stage of stages) {
      try {
        cur = await stage(cur, item, i)
      } catch (e) {
        return null
      }
    }
    return cur
  }))
}

const BRIDGE_RE = /--- BEGIN ([^\n]+) ---\n([\s\S]*?)\n--- END \1 ---/

/**
 * Execute the Node script a bridge prompt carries, in `cwd`, against the real
 * modules. This is the stand-in for the language model, and it is deliberately
 * the most literal possible reading of the instruction the prompt gives.
 */
function runBridge(prompt, cwd) {
  const m = prompt.match(BRIDGE_RE)
  if (!m) return { ok: false, error: 'no bridge script found between the markers' }
  const rel = m[1]
  // Exactly what the prompt tells the bridge agent to do: resolve a relative
  // path against the working directory, and take an absolute one as given.
  const file = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, m[2], 'utf8')
  try {
    const stdout = execFileSync(process.execPath, [file], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, result: stdout }
  } catch (e) {
    return { ok: false, error: String((e && e.stderr) || (e && e.message) || e) }
  }
}

/**
 * Run one workflow script under the sandbox replica.
 *
 * @param {string} file        workflow filename, resolved under SRC
 * @param {object} opts
 * @param {object} opts.args   the `args` global, JSON-cloned into the context
 * @param {string} opts.cwd    working directory for the bridge subprocesses
 * @param {(prompt, opts) => any} opts.onAgent  canned results for non-bridge agents
 * @param {boolean} [opts.noBridge]  make every bridge step fail, as if the
 *                                   modules could not be reached at all
 */
async function runScript(file, { args, cwd, onAgent, noBridge = false }) {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8')
    .replace(/^export\s+const\s+meta\s*=/m, 'const meta =')
  const script = new vm.Script(`(async () => {'use strict';\n${src}\n})()`, { filename: file })

  const calls = []
  const logs = []

  const ctx = {
    __proto__: null,
    log: m => { logs.push(String(m)) },
    phase: () => {},
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
  }
  vm.createContext(ctx, { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(DETERMINISM_SHIM, ctx)

  const agentImpl = async (prompt, opts) => {
    const o = opts || {}
    const label = String(o.label || '')
    calls.push({ prompt: String(prompt), label, opts: JSON.parse(JSON.stringify(o)) })
    if (label.startsWith('bridge:')) {
      return noBridge ? { ok: false, error: 'bridge disabled for this scenario' } : runBridge(String(prompt), cwd)
    }
    return onAgent(String(prompt), o, cwd)
  }

  for (const [k, v] of Object.entries({
    agent: agentImpl,
    parallel: parallelImpl,
    pipeline: pipelineImpl,
    workflow: () => Promise.reject(new Error('nesting is limited to one level')),
  })) {
    Object.defineProperty(ctx, k, { value: v, writable: true, enumerable: true, configurable: true })
  }
  const encoded = JSON.stringify(JSON.stringify(args === undefined ? null : args))
  Object.defineProperty(ctx, 'args', {
    value: args === undefined ? undefined : vm.runInContext(`JSON.parse(${encoded})`, ctx),
    writable: true, enumerable: true, configurable: true,
  })

  let result = null
  let thrown = null
  try {
    result = await script.runInContext(ctx)
  } catch (e) {
    thrown = e
  }
  return {
    // JSON-cloned: cross-realm objects have a different Object.prototype, which
    // makes deepStrictEqual fail for reasons that have nothing to do with the code.
    result: result === undefined ? undefined : JSON.parse(JSON.stringify(result)),
    thrown, calls, logs,
    nonBridgePrompts: calls.filter(c => !c.label.startsWith('bridge:')).map(c => c.prompt),
  }
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wiring-${tag}-`))
}

function runDirs(cwd) {
  const root = path.join(cwd, '.claude', 'runs')
  try {
    // Deliberately NOT filtering anything out. `_state.js` listRuns() filters
    // only on isDirectory(), so any directory the wiring leaves under
    // .claude/runs/ becomes a phantom run for CHG-23's distiller — a test that
    // skipped it would be working around that defect instead of catching it.
    return fs.readdirSync(root)
      .filter(n => fs.statSync(path.join(root, n)).isDirectory())
      .map(n => path.join(root, n))
  } catch (e) {
    return []
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// --------------------------------------------------------------------------
// Canned agent results.
// --------------------------------------------------------------------------

const BLOCKED_TEXT = [
  'Recommendation: GO, with one gate outstanding.',
  '',
  'BLOCKED — act.deploy',
  '  Action withheld: shipping v2 to production',
  '  Why gated: act.deploy is not pre-authorized in the policy supplied to this run',
  '  Prepared: release notes drafted, all five gates classified, rollback rehearsed',
  '  Unblocks: a human confirming go/no-go',
  '  Authorize by: setting preAuthorized.act.deploy in autonomy.json',
].join('\n')

const REQS = {
  criteria: [{ id: 'AC-1', text: 'the export button produces a CSV' }, { id: 'AC-2', text: 'an empty export is refused' }],
  assumptions: ['UTF-8 is acceptable'],
  openQuestions: ['does the CSV need a BOM?'],
  surfaces: ['backend', 'frontend'],
}

function manifest(label, files, summary) {
  return {
    summary: summary || `${label} did the work; read the files for the detail.`,
    filesChanged: files.map(p => ({ path: p, role: 'implementation' })),
    diffRef: 'HEAD~1..HEAD',
    criteriaAddressed: ['AC-1'],
    notAddressed: [{ id: 'AC-2', why: 'covered by the data surface, not this one' }],
  }
}

const BACKEND_FILES = ['src/export.ts', 'src/csv.ts']
const FRONTEND_FILES = ['ui/ExportButton.tsx']

function featureAgents(overrides = {}) {
  return (prompt, opts) => {
    const label = opts.label
    if (label in overrides) {
      const v = overrides[label]
      if (typeof v === 'function') return v(prompt, opts)
      return v
    }
    if (label === 'requirements') return REQS
    if (label === 'ux-spec') return 'UX spec: one button, five states.'
    if (label === 'architecture') return 'Architecture: no new service; Tier 1.'
    if (label === 'build:backend') return manifest('build:backend', BACKEND_FILES)
    if (label === 'build:frontend') return manifest('build:frontend', FRONTEND_FILES)
    if (label && label.startsWith('verify:')) {
      return { verdict: 'one finding', findings: [{ severity: 'Should Fix', summary: `${label} found something`, evidence: 'src/export.ts:12' }] }
    }
    if (label && label.startsWith('refute:')) return { refuted: true, reasoning: 'not substantiated on re-read' }
    if (label === 'readiness') return BLOCKED_TEXT
    if (label === 'docs') return 'Release notes drafted.'
    return `stub result for ${label}`
  }
}

// ==========================================================================

async function main() {
  console.log(`workflow sources: ${SRC}`)
  console.log(`policy resolved from: ${RESOLVED.source} (degraded=${RESOLVED.degraded})\n`)

  const WORKFLOWS = [
    'sdlc-feature.js', 'independent-review.js', 'registry-audit.js',
    'release-readiness.js', 'system-archaeology.js', 'persona-qa-sweep.js',
  ]

  // ------------------------------------------------------------------ CHG-16
  console.log('CHG-16 — the resolved gate table reaches every agent prompt')

  const featureCwd = tmpdir('feature')
  const feature = await runScript('sdlc-feature.js', {
    cwd: featureCwd,
    args: { initiative: 'add a CSV export', policy: POLICY_JSON },
    onAgent: featureAgents(),
  })

  await test('sdlc-feature runs to completion inside the sandbox replica', () => {
    assert.strictEqual(feature.thrown, null, feature.thrown && feature.thrown.message)
    assert.strictEqual(feature.result.status, 'completed')
  })

  await test('every non-bridge prompt carries the resolved gate table verbatim', () => {
    assert.ok(feature.nonBridgePrompts.length >= 8, `only ${feature.nonBridgePrompts.length} agent prompts`)
    const missing = feature.nonBridgePrompts.filter(p => !p.includes(GATE_TABLE))
    assert.strictEqual(missing.length, 0, `${missing.length} prompt(s) lack the gate table, e.g.:\n${(missing[0] || '').slice(0, 200)}`)
  })

  await test('the injected table names the pre-authorized gates, not a file to go and read', () => {
    const p = feature.nonBridgePrompts[0]
    assert.ok(p.includes('Pre-authorized'), 'no pre-authorized list in the prompt')
    assert.ok(p.includes('NOT pre-authorized: '), 'no denied list in the prompt')
    assert.ok(!/find (the )?policy file|locate .*autonomy\.json/i.test(p.slice(0, GATE_TABLE.length + 50)),
      'the prompt sends the agent looking for the policy instead of stating it')
  })

  await test('policySource and degraded are on the return', () => {
    assert.strictEqual(feature.result.degraded, false)
    assert.strictEqual(feature.result.policySource, RESOLVED.source)
  })

  // ------------------------------------------------------------------ CHG-16
  console.log('\nCHG-16 — blockedGates is an ARRAY from the reducer, not a string')

  await test('blockedGates is an array, and specifically not a string instruction', () => {
    assert.ok(Array.isArray(feature.result.blockedGates),
      `blockedGates is ${typeof feature.result.blockedGates}: ${JSON.stringify(feature.result.blockedGates).slice(0, 160)}`)
    assert.notStrictEqual(typeof feature.result.blockedGates, 'string')
  })

  await test('the reducer parsed the BLOCKED entry an agent emitted, with its fields', () => {
    const g = feature.result.blockedGates.find(x => x.gate === 'act.deploy')
    assert.ok(g, `no act.deploy entry in ${JSON.stringify(feature.result.blockedGates)}`)
    assert.ok(g.prepared && g.prepared.includes('release notes drafted'), `prepared not populated: ${JSON.stringify(g)}`)
    assert.ok(g.actionWithheld && g.actionWithheld.includes('production'))
  })

  await test('the parsed entries equal what _policy.js itself produces on the same text', () => {
    const direct = policyMod.collectBlockedGates([BLOCKED_TEXT])
    const fromRun = feature.result.blockedGates.filter(g => g.gate === 'act.deploy')
    assert.deepStrictEqual(fromRun, direct)
  })

  await test('blockedGatesComplete is true when the reducer ran', () => {
    assert.strictEqual(feature.result.blockedGatesComplete, true)
  })

  // ------------------------------------------------------------- CHG-18 / 22
  console.log('\nCHG-18 / CHG-22 — a run directory, and an outcome record')

  await test('a run directory was written, with a manifest and one artifact per phase', () => {
    const dirs = runDirs(featureCwd)
    assert.strictEqual(dirs.length, 1, `expected one run directory, found ${dirs.length}`)
    const files = fs.readdirSync(dirs[0])
    assert.ok(files.includes('manifest.json'), files.join(', '))
    assert.ok(files.includes('outcome.json'), files.join(', '))
    const phases = files.filter(f => /^phase-\d+-/.test(f))
    assert.strictEqual(phases.length, 5, `expected 5 phase artifacts, got ${phases.join(', ')}`)
  })

  await test('the manifest names the phases complete and has nothing left to resume from', () => {
    const m = readJson(path.join(runDirs(featureCwd)[0], 'manifest.json'))
    assert.deepStrictEqual(m.phases.map(p => p.title), ['Requirements', 'Design', 'Build', 'Verify', 'Readiness'])
    assert.ok(m.phases.every(p => p.status === 'complete'))
    assert.strictEqual(m.resumableFrom, null)
    assert.strictEqual(m.status, 'completed')
  })

  await test('outcome.json carries the status, the refutations with why, and the blocked gates', () => {
    const o = readJson(path.join(runDirs(featureCwd)[0], 'outcome.json'))
    assert.strictEqual(o.status, 'completed')
    assert.ok(Array.isArray(o.refutations) && o.refutations.length === 4, `${o.refutations.length} refutations`)
    assert.ok(o.refutations.every(r => r.why), 'a refutation lost its reasoning')
    assert.deepStrictEqual(o.blockedGates, feature.result.blockedGates,
      'the written record and the returned object disagree')
  })

  await test('outcome.json reports no phase as resumed on a fresh run', () => {
    // Reopening the recorder out-of-process marks every completed phase as
    // resumed. If the close step did not correct that, every fresh run would
    // claim it replayed itself from cache.
    const o = readJson(path.join(runDirs(featureCwd)[0], 'outcome.json'))
    assert.deepStrictEqual(o.resumedPhases, [])
  })

  await test('phase durations are real wall clock, not the bridge subprocess', () => {
    const o = readJson(path.join(runDirs(featureCwd)[0], 'outcome.json'))
    const vals = Object.values(o.durationsMs)
    assert.strictEqual(vals.length, 5, JSON.stringify(o.durationsMs))
    assert.ok(vals.every(v => typeof v === 'number' && v >= 0))
    assert.ok(o.totalMs >= vals.reduce((a, b) => a + b, 0) - 50,
      `totalMs ${o.totalMs} is smaller than the phases it contains (${JSON.stringify(o.durationsMs)})`)
  })

  // ------------------------------------------------------------------ CHG-20
  console.log('\nCHG-20 — handoff by reference: a manifest, not concatenated prose')

  await test('every builder is given BUILD_MANIFEST_SCHEMA, byte-equal to the module\'s', () => {
    const builders = feature.calls.filter(c => c.label.startsWith('build:'))
    assert.ok(builders.length >= 2, `${builders.length} builders`)
    for (const b of builders) {
      assert.deepStrictEqual(b.opts.schema, JSON.parse(JSON.stringify(briefMod.BUILD_MANIFEST_SCHEMA)),
        `${b.label} was not given the module's manifest schema`)
    }
  })

  await test('each verify prompt contains exactly what buildBrief() produces for that lens', () => {
    const manifests = [
      { label: 'build:backend', ...manifest('build:backend', BACKEND_FILES) },
      { label: 'build:frontend', ...manifest('build:frontend', FRONTEND_FILES) },
    ]
    const criteria = REQS.criteria.map(c => `${c.id}: ${c.text}`).join('\n')
    for (const lens of ['review', 'qa', 'security', 'performance']) {
      const expected = briefMod.buildBrief({ manifests, lens, criteria })
      const call = feature.calls.find(c => c.label === `verify:${lens}`)
      assert.ok(call, `no verify:${lens} call`)
      assert.ok(call.prompt.includes(expected.text),
        `verify:${lens} did not receive the buildBrief() text`)
    }
  })

  await test('no verify prompt carries a concatenation of builder objects', () => {
    // `built.filter(Boolean).join('\\n\\n---\\n\\n')` over manifest objects is
    // literally "[object Object]" — the signature of the replaced code path.
    for (const c of feature.calls.filter(x => x.label.startsWith('verify:'))) {
      assert.ok(!c.prompt.includes('[object Object]'), `${c.label} carries a stringified object blob`)
    }
  })

  await test('briefChars and truncated are recorded per verify agent', () => {
    const h = feature.result.verifyHandoff
    assert.ok(Array.isArray(h) && h.length === 4, JSON.stringify(h))
    for (const rec of h) {
      assert.strictEqual(typeof rec.briefChars, 'number')
      assert.strictEqual(typeof rec.truncated, 'boolean')
      assert.strictEqual(rec.briefSource, 'buildBrief', `${rec.label} did not come from buildBrief`)
      assert.strictEqual(rec.bridgeIntegrity, true, `${rec.label} brief size disagreed with the builder`)
    }
  })

  await test('the phase artifact on disk records the same handoff', () => {
    const dir = runDirs(featureCwd)[0]
    const f = fs.readdirSync(dir).find(n => /^phase-\d+-verify\.json$/.test(n))
    assert.ok(f, fs.readdirSync(dir).join(', '))
    const a = readJson(path.join(dir, f))
    assert.ok(Array.isArray(a.handoff) && a.handoff.length === 4, JSON.stringify(a.handoff))
  })

  // ------------------------------------------------------ CHG-20 truncation
  console.log('\nCHG-20 — an over-budget brief truncates VISIBLY')

  const bigCwd = tmpdir('big')
  const bigFiles = Array.from({ length: 40 }, (_, i) => `src/generated/module-${i}.ts`)
  const big = await runScript('sdlc-feature.js', {
    cwd: bigCwd,
    args: { initiative: 'a very large change', policy: POLICY_JSON },
    onAgent: featureAgents({
      'build:backend': manifest('build:backend', bigFiles, 'X'.repeat(200000)),
      'build:frontend': manifest('build:frontend', bigFiles, 'Y'.repeat(200000)),
    }),
  })

  await test('every lens brief is inside its own budget from LENS_BUDGETS', () => {
    for (const rec of big.result.verifyHandoff) {
      const lens = rec.label.replace('verify:', '')
      const cap = briefMod.LENS_BUDGETS[lens]
      assert.ok(typeof cap === 'number', `no budget for ${lens}`)
      assert.ok(rec.briefChars <= cap, `${rec.label}: ${rec.briefChars} chars exceeds the ${cap} budget`)
    }
  })

  await test('the per-lens budget is applied by lens key, not one hardcoded cap', () => {
    // NOT asserted by comparing brief sizes: with at most three builders,
    // `_brief.js`'s 2000-character per-builder SUMMARY_CAP binds long before
    // any of the four budgets does, so all four briefs come out the same size
    // even though four different budgets were applied. Measured, not assumed —
    // qa and performance both came back at the same length on this fixture.
    // What the wiring owes is that each lens's OWN key reaches `buildBrief`,
    // which is what selects its budget inside the module.
    const call = big.calls.find(c => c.label === 'bridge:brief')
    assert.ok(call, 'no brief bridge step ran')
    assert.ok(/buildBrief\(\{ manifests: manifests, lens: lens, criteria: criteria \}\)/.test(call.prompt),
      'the generated script does not pass the lens through to buildBrief')
    for (const k of ['review', 'qa', 'security', 'performance']) {
      assert.ok(call.prompt.includes(`"${k}"`), `lens ${k} was not passed to the brief builder`)
    }
  })

  await test('a truncated brief says so, in the brief, and names what it dropped', () => {
    for (const rec of big.result.verifyHandoff) {
      assert.strictEqual(rec.truncated, true, `${rec.label} was not marked truncated`)
    }
    for (const c of big.calls.filter(x => x.label.startsWith('verify:'))) {
      assert.ok(c.prompt.includes('TRUNCATED'), `${c.label} was cut with no marker`)
      assert.ok(/PARTIAL account of the implementation/.test(c.prompt), `${c.label} marker does not say it is partial`)
    }
  })

  // ------------------------------------------------------------------ CHG-19
  console.log('\nCHG-19 — a breaker check at each phase boundary')

  const breakCwd = tmpdir('breaker')
  const broke = await runScript('sdlc-feature.js', {
    cwd: breakCwd,
    args: { initiative: 'a change whose verify lenses all die', policy: POLICY_JSON },
    // Three of the four lenses return nothing. `agent()` gives the script null
    // with no stderr and no exit code, so this is the only failure signal a
    // Workflow-tool script ever receives.
    // The architecture agent emits an autonomy gate in an EARLIER phase, so the
    // assertions below can tell "the breaker entry was added" apart from "the
    // breaker replaced everything that was already there".
    onAgent: featureAgents({
      architecture: `Architecture: Tier 1, no new service.\n\n${BLOCKED_TEXT}`,
      'verify:review': null, 'verify:qa': null, 'verify:security': null,
    }),
  })

  await test('three null agent results in one phase trip the breaker', () => {
    assert.ok(Array.isArray(broke.result.breakerTripped) && broke.result.breakerTripped.length >= 1,
      `breakerTripped is ${JSON.stringify(broke.result.breakerTripped)}`)
  })

  await test('a tripped breaker STOPS the run — it does not merely log the trip', () => {
    // The failure this catches: a breaker that records the trip and then lets
    // the next phase run has not opened the circuit. release-manager would
    // produce a readiness recommendation from one of four verify lenses, with
    // nothing in its prompt saying the other three had died.
    assert.strictEqual(broke.result.status, 'stopped', JSON.stringify(broke.result).slice(0, 300))
    assert.ok(/Breaker tripped in phase "Verify"/.test(broke.result.reason), broke.result.reason)
    const after = broke.calls.filter(c => c.label === 'readiness' || c.label === 'docs')
    assert.strictEqual(after.length, 0, `the phase after the trip still ran: ${after.map(c => c.label).join(', ')}`)
  })

  await test('a breaker stop is "stopped", not "crashed", and is not re-thrown', () => {
    assert.strictEqual(broke.thrown, null, broke.thrown && broke.thrown.message)
    const o = readJson(path.join(runDirs(breakCwd)[0], 'outcome.json'))
    assert.strictEqual(o.status, 'stopped')
    assert.deepStrictEqual(o.phasesCompleted, ['Requirements', 'Design', 'Build', 'Verify'])
  })

  await test('the tripped breaker escapes through the blocked-gate channel', () => {
    const e = broke.result.blockedGates.find(g => String(g.gate).startsWith('breaker.'))
    assert.ok(e, `no breaker entry among ${JSON.stringify(broke.result.blockedGates.map(g => g.gate))}`)
    assert.ok(e.actionWithheld.includes('Verify'), `the entry does not name the phase: ${e.actionWithheld}`)
    assert.ok(/\d+ consecutive/.test(e.whyGated), e.whyGated)
    assert.ok(e.unblocks && e.unblocks.includes('Verify'), 'a tripped breaker with no path back is not actionable')
    // The autonomy gate an EARLIER phase emitted must still be there — a
    // breaker trip must not displace the gate it arrived alongside.
    assert.ok(broke.result.blockedGates.some(g => g.gate === 'act.deploy'),
      'the breaker entry crowded out the gate an earlier phase emitted')
  })

  await test('every failed attempt is on failures.jsonl with its class', () => {
    const dir = runDirs(breakCwd)[0]
    const lines = fs.readFileSync(path.join(dir, 'failures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.strictEqual(lines.length, 3, `${lines.length} failure records`)
    assert.ok(lines.every(l => l.phase === 'Verify' && l.class && l.strategyNext), JSON.stringify(lines[0]))
  })

  await test('two failures in a phase do NOT trip it — the threshold is real', () => {
    // Without this the previous three assertions pass against a breaker that
    // fires on the first failure, which is a different (and wrong) design.
    return runScript('sdlc-feature.js', {
      cwd: tmpdir('twofail'),
      args: { initiative: 'two lenses die', policy: POLICY_JSON },
      onAgent: featureAgents({ 'verify:review': null, 'verify:qa': null }),
    }).then(r => {
      assert.strictEqual(r.result.breakerTripped, null,
        `breaker tripped on two failures: ${JSON.stringify(r.result.breakerTripped)}`)
    })
  })

  // ------------------------------------------------------------------ resume
  console.log('\nCHG-18 — resume replays the prefix instead of re-running it')

  const firstRunId = feature.result.runId
  await test('the run id came back on the return', () => {
    assert.ok(firstRunId && /^\d{8}T\d{6}Z-sdlc-feature-[0-9a-f]{4}$/.test(firstRunId), String(firstRunId))
  })

  const resumed = await runScript('sdlc-feature.js', {
    cwd: featureCwd,
    args: { initiative: 'add a CSV export', policy: POLICY_JSON, resume: firstRunId },
    onAgent: (prompt, opts) => {
      throw new Error(`agent "${opts.label}" ran during a resume of a fully-recorded run`)
    },
  })

  await test('a resumed run re-executes no agent for a completed phase', () => {
    assert.strictEqual(resumed.thrown, null, resumed.thrown && resumed.thrown.message)
    const ran = resumed.calls.filter(c => !c.label.startsWith('bridge:'))
    assert.strictEqual(ran.length, 0, `these agents ran again: ${ran.map(c => c.label).join(', ')}`)
  })

  await test('the replayed acceptance criteria are byte-identical to the first run', () => {
    assert.deepStrictEqual(resumed.result.requirements, feature.result.requirements)
    assert.deepStrictEqual(resumed.result.resumedPhases,
      ['Requirements', 'Design', 'Build', 'Verify', 'Readiness'])
  })

  await test('a blocked gate does not vanish across a resume', () => {
    // The gate was emitted by an agent that did not run this time. If replayed
    // artifacts were not fed to the reducer, the resumed run would report a
    // clean sheet for a run that had a deploy blocked.
    assert.deepStrictEqual(resumed.result.blockedGates, feature.result.blockedGates)
  })

  await test('the bridge scratch script lives inside the run directory', () => {
    // Two workflows in one repository would otherwise write and execute the
    // same scratch file — and a shared `_bridge/` directory under
    // `.claude/runs/` would itself read as a run whose id is `_bridge`.
    const c = resumed.calls.find(x => x.label === 'bridge:close')
    assert.ok(c, 'no close bridge step ran')
    assert.strictEqual(runDirs(featureCwd).length, 1, 'a phantom run directory appeared under .claude/runs/')
    // Separator-agnostic: on Windows the run directory arrives with
    // backslashes and only the suffix this code appends is a forward slash.
    // Node's fs accepts the mix, and the run above proves it — this assertion
    // must not fail merely for being on the wrong platform.
    assert.ok(c.prompt.includes(`${firstRunId}/bridge/`),
      `the close script is not inside the run directory:\n${(c.prompt.match(/BEGIN [^\n]+/) || [''])[0]}`)
  })

  await test('resume that cannot reach the recorder REFUSES rather than starting fresh', () => {
    // The dangerous degradation is the quiet one: a resume that silently
    // becomes a new run loses the phases a second time, unwatched.
    return runScript('sdlc-feature.js', {
      cwd: tmpdir('noresume'),
      args: { initiative: 'x', resume: '20260101T000000Z-sdlc-feature-dead' },
      onAgent: featureAgents(),
    }).then(r => {
      assert.strictEqual(r.result.status, 'stopped', JSON.stringify(r.result).slice(0, 200))
      assert.ok(/refus/i.test(r.result.reason), r.result.reason)
    })
  })

  // -------------------------------------------------------- degraded policy
  console.log('\nCHG-16 — with no reachable policy, every gate reads denied')

  const degradedCwd = tmpdir('degraded')
  const degraded = await runScript('sdlc-feature.js', {
    cwd: degradedCwd,
    args: { initiative: 'add a CSV export' },   // no policy path, so no bridge
    onAgent: featureAgents(),
  })

  await test('degraded is true and the prompts say so', () => {
    assert.strictEqual(degraded.result.degraded, true)
    assert.strictEqual(degraded.result.policySource, null)
    for (const p of degraded.nonBridgePrompts) {
      assert.ok(p.includes('AUTONOMY POLICY — DEGRADED'), 'a prompt omitted the degraded notice')
      assert.ok(p.includes('Treat EVERY gate as NOT pre-authorized'), 'the degraded notice does not deny the gates')
    }
  })

  await test('a run that could not collect its blocked gates says so, rather than returning []', () => {
    assert.ok(Array.isArray(degraded.result.blockedGates))
    assert.strictEqual(degraded.result.blockedGatesComplete, false)
    const e = degraded.result.blockedGates.find(g => g.gate === 'reporting.blockedGatesUncollected')
    assert.ok(e, `an empty array here would read as "no gate was hit": ${JSON.stringify(degraded.result.blockedGates)}`)
  })

  await test('with the bridge unreachable the verify brief is still the manifest, never prose', () => {
    for (const rec of degraded.result.verifyHandoff) {
      assert.strictEqual(rec.briefSource, 'manifest-unbudgeted')
    }
    for (const c of degraded.calls.filter(x => x.label.startsWith('verify:'))) {
      assert.ok(!c.prompt.includes('[object Object]'), `${c.label} fell back to concatenated prose`)
      assert.ok(c.prompt.includes('"filesChanged"'), `${c.label} did not receive the manifest`)
    }
  })

  // --------------------------------------------------------------- CHG-22 crash
  console.log('\nCHG-22 — a crashed run still produces an outcome')

  const crashCwd = tmpdir('crash')
  const crashed = await runScript('independent-review.js', {
    cwd: crashCwd,
    args: { target: 'the working tree', policy: POLICY_JSON },
    onAgent: (prompt, opts) => {
      const l = opts.label
      if (l === 'merge') throw new Error('the merger died mid-phase')
      if (l && l.startsWith('review:')) {
        return { findings: [{ severity: 'Must Fix', summary: `${l} finding`, evidence: 'a.ts:1' }] }
      }
      if (l && l.startsWith('refute:')) return { refuted: false, reasoning: 'stands up' }
      return `stub for ${l}`
    },
  })

  await test('the crash is re-thrown to the caller, not swallowed by the finally path', () => {
    assert.ok(crashed.thrown, 'a crashed run returned normally')
    assert.ok(/merger died/.test(crashed.thrown.message), crashed.thrown.message)
  })

  await test('outcome.json exists with status "crashed" and the phases that did complete', () => {
    const dirs = runDirs(crashCwd)
    assert.strictEqual(dirs.length, 1)
    const o = readJson(path.join(dirs[0], 'outcome.json'))
    assert.strictEqual(o.status, 'crashed')
    assert.deepStrictEqual(o.phasesCompleted, ['Review'])
    assert.ok(/merger died/.test(o.error), o.error)
    assert.strictEqual(o.resumableFrom, 'Merge')
  })

  // --------------------------------------------------- CHG-18 writtenTo
  console.log('\nCHG-18 — writtenTo reports observed paths, not a literal')

  const archCwd = tmpdir('arch')
  fs.mkdirSync(path.join(archCwd, '.claude', 'discovery'), { recursive: true })
  fs.writeFileSync(path.join(archCwd, '.claude', 'discovery', 'prd.md'), '# as-built\n', 'utf8')

  function archAgents(prdOverride) {
    return (prompt, opts, cwd) => {
      const l = opts.label
      if (l === 'detect-stack') return { determined: { lang: 'ts' }, undetermined: ['queue'], authLocated: true }
      if (l === 'prd') {
        if (prdOverride !== undefined) return prdOverride
        return { prd: '# as-built PRD', filesWritten: ['.claude/discovery/prd.md', '.claude/discovery/evidence-matrix.md'] }
      }
      if (l === 'observe-artifacts') {
        // A real observation, not a canned one: read the paths out of the
        // prompt and check the filesystem the workflow is actually running in.
        const paths = [...prompt.matchAll(/^- (.+)$/gm)].map(m => m[1])
        const found = paths.filter(p => fs.existsSync(path.join(cwd, p)))
        return { found, notFound: paths.filter(p => !found.includes(p)) }
      }
      return `stub for ${l}`
    }
  }

  const arch = await runScript('system-archaeology.js', {
    cwd: archCwd,
    args: { scope: 'the app', policy: POLICY_JSON },
    onAgent: archAgents(),
  })

  await test('writtenTo lists only the path that exists on disk', () => {
    assert.deepStrictEqual(arch.result.writtenTo, ['.claude/discovery/prd.md'])
  })

  await test('the artifact-existence check is an agent too, and gets the gate table', () => {
    // This path only runs when the PRD agent claims it wrote something, so the
    // uniform per-workflow assertion above never reaches it.
    const c = arch.calls.find(x => x.label === 'observe-artifacts')
    assert.ok(c, 'the existence check never ran')
    assert.ok(c.prompt.includes(GATE_TABLE), 'observe-artifacts was not given the gate table')
    const missing = arch.nonBridgePrompts.filter(x => !x.includes(GATE_TABLE))
    assert.strictEqual(missing.length, 0, `${missing.length} prompt(s) in this path lack the gate table`)
  })

  await test('a claimed-but-absent artifact is reported as claimedNotFound', () => {
    assert.deepStrictEqual(arch.result.claimedNotFound, ['.claude/discovery/evidence-matrix.md'])
    assert.strictEqual(arch.result.writtenToVerified, true)
  })

  await test('an unverifiable check reports nothing observed, never the claim', () => {
    const cwd2 = tmpdir('arch-unverified')
    return runScript('system-archaeology.js', {
      cwd: cwd2,
      args: { scope: 'the app', policy: POLICY_JSON },
      onAgent: (prompt, opts) => {
        const l = opts.label
        if (l === 'detect-stack') return { determined: {}, undetermined: [], authLocated: true }
        if (l === 'prd') return { prd: '# prd', filesWritten: ['.claude/discovery/prd.md'] }
        if (l === 'observe-artifacts') return null
        return `stub for ${l}`
      },
    }).then(r => {
      assert.deepStrictEqual(r.result.writtenTo, [])
      assert.strictEqual(r.result.writtenToVerified, false)
    })
  })

  // ------------------------------------------------------- the other four
  console.log('\nAll six workflows — the same wiring, asserted uniformly')

  const OTHERS = [
    {
      file: 'independent-review.js',
      args: { target: 'the working tree', policy: POLICY_JSON },
      onAgent: (p, o) => {
        const l = o.label
        if (l && l.startsWith('review:')) return { findings: [{ severity: 'Nit', summary: `${l} finding`, evidence: 'a.ts:1' }] }
        if (l && l.startsWith('refute:')) return { refuted: false, reasoning: 'stands up' }
        if (l === 'merge') return BLOCKED_TEXT
        return `stub for ${l}`
      },
      phases: ['Review', 'Merge'],
    },
    {
      file: 'registry-audit.js',
      args: { root: '.claude', policy: POLICY_JSON },
      onAgent: (p, o) => {
        const l = o.label
        if (l && l.startsWith('audit:')) {
          return { findings: [{ id: `F-${l}`, severity: 'LOW', summary: 'x', path: 'a.md', evidence: 'a.md:1' }] }
        }
        if (l && l.startsWith('verify:')) return { confirmed: true, reasoning: 'checked' }
        if (l === 'report') return BLOCKED_TEXT
        return `stub for ${l}`
      },
      phases: ['Dimensions', 'Report'],
    },
    {
      file: 'release-readiness.js',
      args: { release: 'v2', policy: POLICY_JSON },
      onAgent: (p, o) => {
        const l = o.label
        if (l && l.startsWith('gate:')) return { gate: l, status: 'Confirmed', evidence: 'checked' }
        if (l === 'recommendation') return BLOCKED_TEXT
        return `stub for ${l}`
      },
      phases: ['Gates', 'Synthesize'],
    },
    {
      file: 'system-archaeology.js',
      args: { scope: 'the app', policy: POLICY_JSON },
      onAgent: (p, o, cwd) => {
        const l = o.label
        if (l === 'detect-stack') return { determined: {}, undetermined: [], authLocated: true }
        if (l === 'prd') return { prd: BLOCKED_TEXT, filesWritten: [] }
        if (l === 'observe-artifacts') return { found: [], notFound: [] }
        return `stub for ${l}`
      },
      phases: ['Detect', 'Excavate', 'Cross-check', 'Synthesize'],
    },
    {
      file: 'persona-qa-sweep.js',
      args: { target: 'http://localhost:3000', env: 'staging', policy: POLICY_JSON },
      onAgent: (p, o) => {
        const l = o.label
        if (l === 'discover') {
          return {
            personas: [
              { id: 'admin', status: 'confirmed', forbidden: ['/billing'] },
              { id: 'member', status: 'confirmed', forbidden: [] },
            ],
            ambiguities: [], undetermined: [],
          }
        }
        if (l && l.startsWith('probe:')) return { leaks: [], ambiguous: [] }
        if (l === 'triage') return BLOCKED_TEXT
        return `stub for ${l}`
      },
      phases: ['Discover', 'Explore', 'Probe', 'Report'],
    },
  ]

  for (const w of OTHERS) {
    const cwd = tmpdir(w.file.replace('.js', ''))
    const r = await runScript(w.file, { cwd, args: w.args, onAgent: w.onAgent })

    await test(`${w.file}: runs clean and injects the gate table into every prompt`, () => {
      assert.strictEqual(r.thrown, null, r.thrown && r.thrown.message)
      assert.strictEqual(r.result.status, 'completed', JSON.stringify(r.result).slice(0, 300))
      assert.ok(r.nonBridgePrompts.length > 0, 'no agents ran at all')
      const missing = r.nonBridgePrompts.filter(p => !p.includes(GATE_TABLE))
      assert.strictEqual(missing.length, 0, `${missing.length} of ${r.nonBridgePrompts.length} prompts lack the gate table`)
    })

    await test(`${w.file}: blockedGates is a reducer-produced array carrying act.deploy`, () => {
      assert.ok(Array.isArray(r.result.blockedGates), `blockedGates is ${typeof r.result.blockedGates}`)
      assert.notStrictEqual(typeof r.result.blockedGates, 'string')
      assert.strictEqual(r.result.blockedGatesComplete, true)
      const g = r.result.blockedGates.find(x => x.gate === 'act.deploy')
      assert.ok(g && g.prepared, `no parsed act.deploy entry: ${JSON.stringify(r.result.blockedGates)}`)
    })

    await test(`${w.file}: records a run directory, every phase, and an outcome`, () => {
      const dirs = runDirs(cwd)
      assert.strictEqual(dirs.length, 1, `${dirs.length} run directories`)
      const m = readJson(path.join(dirs[0], 'manifest.json'))
      assert.deepStrictEqual(m.phases.map(p => p.title), w.phases)
      const o = readJson(path.join(dirs[0], 'outcome.json'))
      assert.strictEqual(o.status, 'completed')
      assert.deepStrictEqual(o.blockedGates, r.result.blockedGates)
      assert.strictEqual(r.result.outcomeRecorded, true)
      assert.strictEqual(r.result.runId, m.runId)
    })
  }

  await test('persona-qa-sweep with no target stops before opening a run', () => {
    const cwd = tmpdir('notarget')
    return runScript('persona-qa-sweep.js', {
      cwd, args: { policy: POLICY_JSON },
      onAgent: (p, o) => { throw new Error(`agent ${o.label} ran without a target`) },
    }).then(r => {
      assert.strictEqual(r.result.status, 'stopped')
      assert.ok(Array.isArray(r.result.blockedGates), 'even a refused invocation returns the array shape')
      assert.strictEqual(runDirs(cwd).length, 0, 'an invalid invocation should not create a run directory')
    })
  })

  // -------------------------------------------------- source-level guarantees
  console.log('\nSource-level checks (read, not executed)')

  await test('no workflow still returns the blockedGates INSTRUCTION string', () => {
    for (const f of WORKFLOWS) {
      const s = fs.readFileSync(path.join(SRC, f), 'utf8')
      assert.ok(!/Collect every "BLOCKED/.test(s), `${f} still tells the reader to collect the entries`)
    }
  })

  await test('system-archaeology no longer hardcodes the discovery paths as a return value', () => {
    // Block comments are stripped first. The replaced literal is quoted inside
    // the doc comment that explains why it was replaced, and a scan that
    // matches its own explanation is a scan that can never go green.
    const s = fs.readFileSync(path.join(SRC, 'system-archaeology.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/writtenTo:\s*\[\s*'\.claude\/discovery/.test(s), 'the literal writtenTo list is still there')
  })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.error(`FAILED: ${failures.join(' | ')}`)
    process.exitCode = 1
  }
}

main().catch(e => {
  console.error(`harness error: ${(e && e.stack) || e}`)
  process.exitCode = 1
})
