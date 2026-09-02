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

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`)
