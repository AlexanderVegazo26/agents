'use strict'

/**
 * Tests for _state.js. Run with `node sdlc-suite/workflows/_state.test.js`.
 *
 * Covers CHG-18's three required fault injections:
 *   1. kill the process mid-phase -> manifest shows the completed prefix and
 *      names the phase to resume from;
 *   2. resume -> no agent runs for the replayed prefix and the artifacts are
 *      byte-identical to the first run's;
 *   3. make the runs directory unwritable -> the workflow COMPLETES and logs that
 *      recording failed, rather than aborting.
 *
 * Plus CHG-22's two: a crashed run still writes outcome.json, and a run with zero
 * findings writes one with empty arrays rather than skipping it.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { openRun, listRuns, pruneRuns } = require('./_state.js')

let passed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`  pass  ${name}`) }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.stack.split('\n').slice(0, 3).join('\n        ')}`); process.exitCode = 1 }
}

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'runstate-'))
  fs.mkdirSync(path.join(d, '.claude', 'runs'), { recursive: true })
  return d
}
const quiet = () => {}

console.log('run directory and phase artifacts')

test('opening a run creates the directory and a manifest', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'sdlc-feature', args: 'add a health endpoint', cwd, logger: quiet })
  assert.ok(fs.existsSync(path.join(run.dir, 'manifest.json')))
  const m = JSON.parse(fs.readFileSync(path.join(run.dir, 'manifest.json'), 'utf8'))
  assert.strictEqual(m.workflow, 'sdlc-feature')
  assert.strictEqual(m.status, 'running')
  assert.match(m.runId, /^\d{8}T\d{6}Z-sdlc-feature-[0-9a-f]{4}$/)
})

test('completePhase writes a numbered artifact and updates the manifest', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'sdlc-feature', cwd, logger: quiet })
  run.startPhase('Requirements')
  run.completePhase('Requirements', { agents: [{ label: 'requirements', result: { criteria: ['AC-1'] } }] })
  const files = fs.readdirSync(run.dir).sort()
  assert.ok(files.includes('phase-1-requirements.json'), files.join(','))
  const m = JSON.parse(fs.readFileSync(path.join(run.dir, 'manifest.json'), 'utf8'))
  assert.deepStrictEqual(m.phases, [{ title: 'Requirements', status: 'complete', artifact: 'phase-1-requirements.json' }])
  assert.strictEqual(m.resumableFrom, null)
})

test('startPhase sets resumableFrom BEFORE the phase runs, so a crash is recoverable', () => {
  // The ordering is the whole point. Setting it after the phase would leave a
  // killed run pointing at the wrong place.
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'sdlc-feature', cwd, logger: quiet })
  run.startPhase('Requirements')
  run.completePhase('Requirements', {})
  run.startPhase('Design')
  const m = JSON.parse(fs.readFileSync(path.join(run.dir, 'manifest.json'), 'utf8'))
  assert.strictEqual(m.resumableFrom, 'Design')
})

console.log('\nFAULT 1 + 2 — kill mid-phase, then resume')

test('a SIGKILLed run leaves a manifest naming the phase to resume from', () => {
  const cwd = tmpRepo()
  const script = path.join(cwd, 'crash.js')
  fs.writeFileSync(script, `
    const { openRun } = require(${JSON.stringify(path.join(__dirname, '_state.js'))})
    const run = openRun({ workflow: 'sdlc-feature', args: 'demo', cwd: ${JSON.stringify(cwd)}, logger: () => {} })
    run.startPhase('Requirements'); run.completePhase('Requirements', { agents: [{ label: 'req', result: { criteria: ['AC-1','AC-2'] } }] })
    run.startPhase('Design');       run.completePhase('Design',       { agents: [{ label: 'ux',  result: { flows: 2 } }] })
    run.startPhase('Build');        run.completePhase('Build',        { agents: [{ label: 'be',  result: { files: ['a.ts'] } }] })
    run.startPhase('Verify')
    process.kill(process.pid, 'SIGKILL')      // die mid-Verify
  `)
  try { execFileSync(process.execPath, [script], { stdio: 'ignore' }) } catch { /* expected */ }

  const runs = listRuns(cwd)
  assert.strictEqual(runs.length, 1)
  const m = JSON.parse(fs.readFileSync(path.join(runs[0].dir, 'manifest.json'), 'utf8'))
  assert.deepStrictEqual(m.phases.map(p => `${p.title}:${p.status}`),
    ['Requirements:complete', 'Design:complete', 'Build:complete'])
  assert.strictEqual(m.resumableFrom, 'Verify')
  assert.strictEqual(m.status, 'running')      // never closed — correct for a kill
})

test('resuming replays the prefix from cache, byte-identical, and runs no agent', () => {
  const cwd = tmpRepo()
  let agentCalls = 0
  const fakeAgent = () => { agentCalls++; return { criteria: ['AC-1', 'AC-2'] } }

  const first = openRun({ workflow: 'sdlc-feature', args: 'demo', cwd, logger: quiet })
  first.startPhase('Requirements')
  first.completePhase('Requirements', { agents: [{ label: 'req', result: first.resumed('Requirements') ?? fakeAgent() }] })
  first.startPhase('Design')
  first.completePhase('Design', { agents: [{ label: 'ux', result: { flows: 2 } }] })
  first.startPhase('Verify')          // crash here, never completed
  const firstArtifact = fs.readFileSync(path.join(first.dir, 'phase-1-requirements.json'), 'utf8')
  assert.strictEqual(agentCalls, 1)

  const second = openRun({ workflow: 'sdlc-feature', args: 'demo', cwd, resumeFrom: first.runId, logger: quiet })
  const replayed = second.resumed('Requirements') ?? fakeAgent()
  assert.strictEqual(agentCalls, 1, 'the agent must NOT have run again for a cached phase')
  assert.ok(second.wasResumed('Requirements'))
  assert.ok(second.wasResumed('Design'))
  assert.ok(!second.wasResumed('Verify'))
  assert.deepStrictEqual(replayed.agents[0].result.criteria, ['AC-1', 'AC-2'])
  assert.strictEqual(
    fs.readFileSync(path.join(second.dir, 'phase-1-requirements.json'), 'utf8'), firstArtifact,
    'the replayed artifact must be byte-identical to the first run\'s')
})

test('resume FAILS CLOSED when the prior run is unreadable — never a silent fresh run', () => {
  const cwd = tmpRepo()
  assert.throws(
    () => openRun({ workflow: 'sdlc-feature', cwd, resumeFrom: 'nope-does-not-exist', logger: quiet }),
    /cannot resume/)
  assert.strictEqual(listRuns(cwd).length, 0, 'a failed resume must not create a new run directory')
})

test('resume FAILS CLOSED when a phase is marked complete but its artifact is gone', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'sdlc-feature', cwd, logger: quiet })
  run.startPhase('Requirements'); run.completePhase('Requirements', { agents: [] })
  fs.unlinkSync(path.join(run.dir, 'phase-1-requirements.json'))
  assert.throws(
    () => openRun({ workflow: 'sdlc-feature', cwd, resumeFrom: run.runId, logger: quiet }),
    /marked complete but/)
})

test('resume refuses a path that escapes the runs root', () => {
  // Security review (2026-09-02) demonstrated `../../../outside/planted`
  // resolving to an attacker-authored run directory whose phase artifacts were
  // then replayed into downstream prompts carrying the authority of "this is
  // what your own earlier phases produced", and `RUN.dir` becoming that
  // directory so every later bridge script was written and executed from it.
  const cwd = tmpRepo()
  const outside = path.join(cwd, 'outside', 'planted')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'manifest.json'), JSON.stringify({
    runId: 'planted-run', workflow: 'sdlc-feature', startedAt: new Date().toISOString(),
    phases: [{ title: 'Requirements', status: 'complete', artifact: 'phase-1-requirements.json' }],
  }))
  fs.writeFileSync(path.join(outside, 'phase-1-requirements.json'), JSON.stringify({
    agents: [{ result: { criteria: [{ id: 'AC-1', text: 'ATTACKER-AUTHORED' }] } }],
  }))
  for (const bad of ['../../outside/planted', outside, '..\\..\\outside\\planted']) {
    assert.throws(
      () => openRun({ workflow: 'sdlc-feature', cwd, resumeFrom: bad, logger: quiet }),
      /resolves outside|cannot resume/,
      `escape not rejected: ${bad}`)
  }
})

test('resume refuses a manifest whose artifact name is a path', () => {
  // `ph.artifact` is read out of the manifest, so on a resume it is
  // attacker-influenced input rather than our own output. Review showed
  // `"artifact": "../secrets.json"` reading an unrelated JSON file into the
  // replayed phase, and from there into every downstream prompt.
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'sdlc-feature', cwd, logger: quiet })
  run.startPhase('Requirements')
  run.completePhase('Requirements', { agents: [] })
  fs.writeFileSync(path.join(cwd, 'secrets.json'), JSON.stringify({ apiKey: 'SENSITIVE' }))
  const mf = path.join(run.dir, 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
  m.phases[0].artifact = '../../../secrets.json'
  fs.writeFileSync(mf, JSON.stringify(m))
  assert.throws(
    () => openRun({ workflow: 'sdlc-feature', cwd, resumeFrom: run.runId, logger: quiet }),
    /not a plain filename/)
})

test('resume refuses a run belonging to a different workflow', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'sdlc-feature', cwd, logger: quiet })
  run.close({ status: 'completed' })
  assert.throws(
    () => openRun({ workflow: 'release-readiness', cwd, resumeFrom: run.runId, logger: quiet }),
    /not "release-readiness"/)
})

console.log('\nFAULT 3 — an unwritable run directory must not abort the run')

test('write failures are logged and collected; the run still completes', () => {
  const cwd = tmpRepo()
  const logged = []
  const run = openRun({ workflow: 'sdlc-feature', cwd, logger: m => logged.push(m) })
  // Simulate the disk going away mid-run: remove the directory the recorder holds.
  fs.rmSync(run.dir, { recursive: true, force: true })
  fs.writeFileSync(run.dir, 'not a directory')      // make any write fail hard

  run.startPhase('Design')
  run.completePhase('Design', { agents: [{ label: 'ux', result: {} }] })   // must not throw
  run.recordFailure({ label: 'x', class: 'tool', attempt: 1 })              // must not throw
  const outcome = run.close({ status: 'completed' })                        // must not throw

  assert.ok(run.recordingErrors.length > 0, 'recording errors must be collected')
  assert.ok(logged.some(m => /recording failed/.test(m)), 'the failure must be logged, not swallowed')
  assert.ok(outcome.recordingErrors.length > 0,
    'the outcome must carry recordingErrors — a plausible-looking record that is quietly incomplete is worse than none')
})

console.log('\nCHG-22 — outcome.json')

test('a crashed run still writes outcome.json with the phases that did complete', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'sdlc-feature', cwd, logger: quiet })
  run.startPhase('Requirements'); run.completePhase('Requirements', { agents: [] })
  run.startPhase('Verify')
  try {
    throw new Error('verify blew up')
  } catch (e) {
    run.failPhase('Verify', e.message)
    run.close({ status: 'crashed', error: e })
  }
  const o = JSON.parse(fs.readFileSync(path.join(run.dir, 'outcome.json'), 'utf8'))
  assert.strictEqual(o.status, 'crashed')
  assert.deepStrictEqual(o.phasesCompleted, ['Requirements'])
  assert.strictEqual(o.resumableFrom, 'Verify')
  assert.match(o.error, /verify blew up/)
})

test('a run with zero findings still writes outcome.json, with empty arrays', () => {
  // "This lens found nothing on this kind of change" is a signal the distiller
  // reads. Skipping the file would delete it.
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'independent-review', cwd, logger: quiet })
  const o = run.close({ status: 'completed' })
  assert.ok(fs.existsSync(path.join(run.dir, 'outcome.json')))
  assert.deepStrictEqual(o.refutations, [])
  assert.deepStrictEqual(o.blockedGates, [])
  assert.deepStrictEqual(o.findings, { confirmed: 0, refuted: 0, byLens: {} })
})

test('outcome summarises failures by class and carries blocked gates', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'sdlc-feature', cwd, logger: quiet })
  run.recordFailure({ label: 'a', class: 'tool', attempt: 1 })
  run.recordFailure({ label: 'b', class: 'tool', attempt: 2 })
  run.recordFailure({ label: 'c', class: 'auth', attempt: 1 })
  const o = run.close({ status: 'completed', blockedGates: [{ gate: 'act.deploy', prepared: 'artifact built' }] })
  assert.deepStrictEqual(o.failures.sort((x, y) => x.class.localeCompare(y.class)),
    [{ class: 'auth', count: 1 }, { class: 'tool', count: 2 }])
  assert.strictEqual(o.blockedGates[0].gate, 'act.deploy')
  assert.strictEqual(run.readFailures().length, 3)
})

test('close is idempotent', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'sdlc-feature', cwd, logger: quiet })
  const a = run.close({ status: 'completed' })
  const b = run.close({ status: 'crashed' })
  assert.strictEqual(a, b, 'a second close must not overwrite the first')
})

console.log('\npruning')

test('pruneRuns removes only runs older than the cutoff', () => {
  const cwd = tmpRepo()
  const old = openRun({ workflow: 'w', cwd, now: new Date(Date.now() - 40 * 86400_000), logger: quiet })
  old.close({ status: 'completed' })
  const fresh = openRun({ workflow: 'w', cwd, logger: quiet })
  fresh.close({ status: 'completed' })
  const removed = pruneRuns(30, cwd)
  assert.deepStrictEqual(removed, [old.runId])
  assert.strictEqual(listRuns(cwd).length, 1)
})

test('pruneRuns leaves a run with an unreadable manifest alone rather than guessing', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'w', cwd, now: new Date(Date.now() - 40 * 86400_000), logger: quiet })
  run.close({ status: 'completed' })
  fs.writeFileSync(path.join(run.dir, 'manifest.json'), '{ broken')
  assert.deepStrictEqual(pruneRuns(30, cwd), [])
  assert.strictEqual(listRuns(cwd).length, 1)
})

console.log('\nattempts — a resume is a new attempt, and failures carry theirs')

test('a fresh run is attempt 1; beginAttempt on a resume makes it 2 and persists', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'w', cwd, logger: quiet })
  assert.strictEqual(run.attempt, 1)
  const again = openRun({ workflow: 'w', cwd, resumeFrom: run.runId, logger: quiet })
  assert.strictEqual(again.attempt, 1, 'reopening alone must not start an attempt')
  again.beginAttempt()
  const third = openRun({ workflow: 'w', cwd, resumeFrom: run.runId, logger: quiet })
  assert.strictEqual(third.attempt, 2)
})

test('every failure record is stamped with the attempt that produced it', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'w', cwd, logger: quiet })
  run.recordFailure({ label: 'a', phase: 'Verify', class: 'tool' })
  run.beginAttempt()
  run.recordFailure({ label: 'b', phase: 'Verify', class: 'tool' })
  assert.deepStrictEqual(run.readFailures().map(f => f.epoch), [1, 2])
})

test('a phase that failed and then completes appears once, as complete', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'w', cwd, logger: quiet })
  run.completePhase('Build', { agents: [] })
  run.failPhase('Verify', 'breaker tripped')
  run.completePhase('Verify', { agents: [] })
  const m = JSON.parse(fs.readFileSync(path.join(run.dir, 'manifest.json'), 'utf8'))
  assert.deepStrictEqual(m.phases.map(p => `${p.title}:${p.status}`), ['Build:complete', 'Verify:complete'])
})

test('close() records attempt, learningsLoaded, retries and repairRounds', () => {
  const cwd = tmpRepo()
  const run = openRun({ workflow: 'w', cwd, logger: quiet })
  const o = run.close({
    status: 'completed',
    learningsLoaded: [{ label: 'verify:qa', ids: ['LRN-0001'] }],
    retries: [{ label: 'verify:qa', attempts: 2, recovered: true }],
    repairRounds: { rounds: 1, max: 2 },
  })
  assert.strictEqual(o.attempt, 1)
  assert.deepStrictEqual(o.learningsLoaded, [{ label: 'verify:qa', ids: ['LRN-0001'] }])
  assert.strictEqual(o.retries[0].recovered, true)
  assert.deepStrictEqual(o.repairRounds, { rounds: 1, max: 2 })
})

console.log('\nproperty: seeded attempt sequences driven like the workflow bridge')

// mulberry32: tiny seeded PRNG, so a failure names a seed + run that reproduces.
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Distinct slugs on purpose: two titles sharing a slug is not a real workflow.
const TITLE_POOL = ['Requirements', 'Design', 'Build', 'Verify', 'Release', 'Review',
  'Discover', 'Merge', 'Build & Test', 'Verify (4 lenses)']

/**
 * Each step reopens the run from disk, exactly as the workflows' `openRun`,
 * `recordPhase` and `closeRun` bridges do (one fresh process per boundary), so
 * the property covers the on-disk protocol rather than one in-memory object.
 * The reference model is the contract in `_state.js`'s header: completed phases
 * form a prefix, a resume replays exactly that prefix with the bytes it wrote,
 * and `resumableFrom` names the first phase that still has to run.
 */
function runScenario(seed, runIdx) {
  const rand = rng(seed + runIdx)
  const pick = n => Math.floor(rand() * n)
  const pool = TITLE_POOL.slice()
  const titles = []
  for (let n = 2 + pick(5); titles.length < n;) titles.push(pool.splice(pick(pool.length), 1)[0])

  const cwd = tmpRepo()
  const trace = []
  const where = () => `seed ${seed} run ${runIdx}, phases ${JSON.stringify(titles)}, steps: ${trace.join(' > ')}`
  const reopen = runId => openRun({ workflow: 'w', cwd, resumeFrom: runId, logger: quiet })
  const readManifest = runId =>
    JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'runs', runId, 'manifest.json'), 'utf8'))

  // Model state.
  const done = []            // completed prefix, in order
  const written = {}         // title -> the token its completion wrote
  let resumableFrom = null   // first phase that still has to run, once one started
  let attempts = 0
  let runId = null

  try {
    for (let a = 0; a < 4 && done.length < titles.length; a++) {
      // --- open (the `openRun` bridge)
      let run
      if (runId === null) {
        run = openRun({ workflow: 'w', cwd, logger: quiet })
        runId = run.runId
      } else {
        run = reopen(runId)
        run.beginAttempt()
      }
      attempts++
      trace.push(`open#${attempts}`)
      assert.deepStrictEqual([...run.resumedPhases].sort(), done.slice().sort(),
        `resume must replay exactly the completed prefix; ${where()}`)
      for (const t of done) {
        assert.strictEqual(run.resumed(t) && run.resumed(t).token, written[t],
          `resumed("${t}") must return the artifact its completion wrote; ${where()}`)
      }
      run.startPhase(titles[0])
      if (done.length === 0) resumableFrom = titles[0]

      // --- phases, from the first one the prefix does not cover
      let stop = null
      for (let i = done.length; i < titles.length && !stop; i++) {
        const title = titles[i]
        const next = titles[i + 1] || null
        const r = rand()
        if (r < 0.6) {
          const token = `a${attempts}-p${i}-${pick(1e6)}`
          const b = reopen(runId)   // the `recordPhase` bridge
          b.completePhase(title, { agents: [{ label: title, result: token }], token })
          if (next) b.startPhase(next)
          done.push(title)
          written[title] = token
          resumableFrom = next
          trace.push(`complete ${title}`)
        } else if (r < 0.8) {
          reopen(runId).failPhase(title, 'breaker tripped')   // the chain stops here
          resumableFrom = title
          stop = 'stopped'
          trace.push(`trip ${title}`)
        } else {
          stop = 'crashed'
          trace.push(`crash in ${title}`)
        }
      }

      // --- close (the `closeRun` bridge), skipped when the process was killed
      const killed = stop === 'crashed' && rand() < 0.5
      if (!killed) {
        const c = reopen(runId)
        c.resumedPhases = new Set()
        const status = stop || 'completed'
        const o = c.close({ status })
        trace.push(`close ${status}`)
        assert.deepStrictEqual(o.phasesCompleted, done,
          `outcome.phasesCompleted must be the completed prefix in order; ${where()}`)
        assert.strictEqual(o.resumableFrom, resumableFrom,
          `outcome.resumableFrom must name the first phase still to run; ${where()}`)
        assert.strictEqual(o.attempt, attempts, `outcome.attempt; ${where()}`)
        assert.strictEqual(readManifest(runId).status, status, `manifest.status after close; ${where()}`)
      } else {
        trace.push('killed')
      }

      // --- what is on disk after every attempt
      const m = readManifest(runId)
      const ts = m.phases.map(p => p.title)
      assert.strictEqual(new Set(ts).size, ts.length, `a title appears once in manifest.phases ${JSON.stringify(ts)}; ${where()}`)
      assert.deepStrictEqual(m.phases.filter(p => p.status === 'complete').map(p => p.title), done,
        `manifest's complete phases must be the completed prefix; ${where()}`)
      assert.strictEqual(m.resumableFrom, resumableFrom, `manifest.resumableFrom; ${where()}`)
      assert.strictEqual(m.attempt, attempts, `manifest.attempt; ${where()}`)
      const dir = path.join(cwd, '.claude', 'runs', runId)
      const artifacts = m.phases.filter(p => p.status === 'complete').map(p => p.artifact)
      assert.strictEqual(new Set(artifacts).size, artifacts.length,
        `every complete phase has its own artifact file ${JSON.stringify(artifacts)}; ${where()}`)
      // The documented layout: phase-1-requirements.json, phase-2-design.json, ...
      // A phase that tripped and later completed keeps its place in the sequence.
      const slugOf = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      assert.deepStrictEqual(artifacts, done.map((t, i) => `phase-${i + 1}-${slugOf(t)}.json`),
        `artifacts must be numbered 1..n in phase order; ${where()}`)
      const onDisk = fs.readdirSync(dir).filter(n => /^phase-.*\.json$/.test(n)).sort()
      assert.deepStrictEqual(onDisk, artifacts.slice().sort(),
        `phase files on disk must be exactly the complete phases' artifacts; ${where()}`)
      for (const p of m.phases.filter(q => q.status === 'complete')) {
        const art = JSON.parse(fs.readFileSync(path.join(dir, p.artifact), 'utf8'))
        assert.strictEqual(art.phase, p.title, `${p.artifact} names its phase; ${where()}`)
        assert.strictEqual(art.token, written[p.title], `${p.artifact} holds what "${p.title}" wrote; ${where()}`)
        assert.ok(art.durationMs >= 0, `${p.artifact} durationMs ${art.durationMs} >= 0; ${where()}`)
      }
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { completedAll: done.length === titles.length, attempts }
}

test('300 seeded runs: resume replays the completed prefix and resumableFrom names the next phase', () => {
  const seed = Number(process.env.STATE_PROPERTY_SEED || 20261108)
  let finished = 0, resumedRuns = 0
  for (let i = 0; i < 300; i++) {
    const r = runScenario(seed, i)
    if (r.completedAll) finished++
    if (r.attempts > 1) resumedRuns++
  }
  // The generator must actually reach both endings, or the property proves little.
  assert.ok(finished >= 30, `only ${finished} of 300 runs completed every phase (seed ${seed})`)
  assert.ok(resumedRuns >= 100, `only ${resumedRuns} of 300 runs were resumed (seed ${seed})`)
})

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`)
