'use strict'

/**
 * Tests for _failure.js. Run with `node sdlc-suite/workflows/_failure.test.js`.
 *
 * Implements CHG-19's verification table, one case per injected fault, asserting
 * attempt counts from the failure records rather than from the return value.
 *
 * The auth row is the one that matters, and it asserts **exactly 1** attempt. A
 * test asserting "retries are bounded" passes trivially against code that retries
 * three times — which is the behaviour this change exists to prevent.
 */

const assert = require('assert')
const f = require('./_failure.js')

let passed = 0
function test(name, fn) {
  const r = fn()
  const done = () => { passed++; console.log(`  pass  ${name}`) }
  const fail = e => { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1 }
  if (r && typeof r.then === 'function') return r.then(done, fail)
  try { done() } catch (e) { fail(e) }
}

/** Collects what would go to failures.jsonl. */
function harness() {
  const records = []
  return {
    records,
    onFailure: r => records.push(r),
    sleep: async () => {},          // no real waiting
    rand: () => 0.5,                // deterministic backoff
  }
}

function thrower(times, err) {
  let n = 0
  return async () => { n++; if (n <= times) throw err(); return `ok after ${n}` }
}

const e = (msg, extra = {}) => Object.assign(new Error(msg), extra)

async function main() {
  console.log('classify() — the class must be inferable from what the boundary produced')

  await test('401 is auth, not transient', () =>
    assert.strictEqual(f.classify({ stderr: 'HTTP 401 Unauthorized' }), f.Failure.AUTH))

  await test('a 401 arriving over HTTP is STILL auth — order matters', () => {
    // Without AUTH ordered before TRANSIENT, the generic network pattern would
    // swallow this and retry it three times.
    assert.strictEqual(
      f.classify({ stderr: 'network error: request failed with status 401' }), f.Failure.AUTH)
  })

  await test('429 and 503 are transient', () => {
    assert.strictEqual(f.classify({ stderr: 'HTTP 429 rate limit exceeded' }), f.Failure.TRANSIENT)
    assert.strictEqual(f.classify({ stderr: 'upstream returned 503' }), f.Failure.TRANSIENT)
  })

  await test('a missing binary is tool', () => {
    assert.strictEqual(f.classify({ stderr: "spawn kimi ENOENT" }), f.Failure.TOOL)
    assert.strictEqual(f.classify({ stderr: "'cmdc' is not recognized" }), f.Failure.TOOL)
    assert.strictEqual(f.classify({ code: 127, stderr: '' }), f.Failure.TOOL)
  })

  await test('unparseable output is bad_input', () =>
    assert.strictEqual(f.classify({ stdout: 'not json', stderr: 'Unexpected token o in JSON' }),
      f.Failure.BAD_INPUT))

  await test('a non-repo cwd is env_drift', () =>
    assert.strictEqual(f.classify({ stderr: 'fatal: not a git repository' }), f.Failure.ENV_DRIFT))

  await test('a timeout is transient regardless of text', () =>
    assert.strictEqual(f.classify({ timedOut: true, stderr: '' }), f.Failure.TRANSIENT))

  await test('an UNRECOGNISED failure falls back to tool, not transient', () => {
    // Deliberate: string-matching CLI output is brittle and will misclassify.
    // Retrying once on an unknown failure is safer than retrying three times.
    assert.strictEqual(f.classify({ stderr: 'something nobody predicted' }), f.Failure.TOOL)
  })

  console.log('\nCHG-19 verification table — attempt counts read from the failure records')

  await test('KIMI_BIN=/nonexistent -> class tool, exactly 2 attempts, phase stopped', async () => {
    const h = harness()
    const r = await f.withRetry(thrower(99, () => e('spawn /nonexistent ENOENT')),
      { label: 'build', phase: 'Build', ...h })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.class, f.Failure.TOOL)
    assert.strictEqual(r.attempts, 2, `expected 2 attempts, got ${r.attempts}`)
    assert.strictEqual(h.records.length, 2)
    assert.strictEqual(r.stop, 'phase')
  })

  await test('CLI exiting 401 -> class auth, exactly ONE attempt, escalated immediately', async () => {
    // THE row that matters. Exactly 1, not "bounded".
    const h = harness()
    const r = await f.withRetry(thrower(99, () => e('HTTP 401 Unauthorized')),
      { label: 'verify:security', phase: 'Verify', ...h })
    assert.strictEqual(r.class, f.Failure.AUTH)
    assert.strictEqual(r.attempts, 1, `auth must NOT be retried; got ${r.attempts} attempts`)
    assert.strictEqual(h.records.length, 1, 'exactly one failure record')
    assert.strictEqual(r.escalate, true)
    assert.match(h.records[0].strategyNext, /escalate/)
  })

  await test('stub returning bad JSON -> bad_input, 3 attempts, prompt differs each time', async () => {
    const h = harness()
    const prompts = []
    const r = await f.withRetry(async ({ previousFailure }) => {
      prompts.push(f.rewritePrompt('BASE PROMPT', previousFailure))
      throw e('failed to parse: Unexpected token n in JSON')
    }, { label: 'requirements', phase: 'Requirements', ...h })
    assert.strictEqual(r.class, f.Failure.BAD_INPUT)
    assert.strictEqual(r.attempts, 3)
    assert.strictEqual(prompts[0], 'BASE PROMPT', 'the first attempt carries the original prompt')
    assert.ok(prompts[1].includes('failed to conform'), 'the retry names the conformance failure')
    assert.notStrictEqual(prompts[0], prompts[1], 'the prompt must actually differ')
    assert.strictEqual(prompts[1], prompts[2], 'same failure -> same rewrite; only the attempt count differs')
  })

  await test('a slow stub past a short timeout -> transient, 3 attempts, delays increasing', async () => {
    const h = harness()
    const delays = []
    const r = await f.withRetry(async () => { throw Object.assign(new Error('timed out'), { timedOut: true }) },
      { label: 'x', phase: 'Verify', ...h, sleep: async ms => delays.push(ms) })
    assert.strictEqual(r.class, f.Failure.TRANSIENT)
    assert.strictEqual(r.attempts, 3)
    assert.strictEqual(delays.length, 2, 'a delay before each retry, not after the last failure')
    assert.ok(delays[1] > delays[0], `backoff must grow: ${delays.join(' -> ')}`)
  })

  await test('one agent exhausting its own 3 bad_input retries does NOT trip the breaker', async () => {
    // The breaker counts calls that gave up, not attempts. Counting attempts would
    // make BAD_INPUT's designed 3-retry policy trip a threshold-of-3 breaker on
    // the very first failing agent, so the two settings would contradict.
    const h = harness()
    const breaker = new f.Breaker()
    await f.withRetry(async () => { throw e('schema validation failed') },
      { label: 'solo', phase: 'Verify', breaker, ...h })
    assert.strictEqual(h.records.length, 3, 'three attempts were recorded')
    assert.ok(!breaker.isTripped('Verify'), 'but that is one failing agent, not three')
  })

  await test('three agents all returning bad JSON -> breaker trips with class and count', async () => {
    const h = harness()
    const breaker = new f.Breaker()
    for (const label of ['a', 'b', 'c']) {
      await f.withRetry(async () => { throw e('schema validation failed') },
        { label, phase: 'Verify', breaker, ...h })
    }
    assert.ok(breaker.isTripped('Verify'))
    assert.deepStrictEqual(breaker.trippedInfo('Verify'), { class: f.Failure.BAD_INPUT, count: 3 })
  })

  await test('cwd outside a git repository -> env_drift, run stops, 1 attempt', async () => {
    const h = harness()
    const r = await f.withRetry(thrower(99, () => e('fatal: not a git repository')),
      { label: 'build', phase: 'Build', ...h })
    assert.strictEqual(r.class, f.Failure.ENV_DRIFT)
    assert.strictEqual(r.attempts, 1)
    assert.strictEqual(r.stop, 'run')
  })

  console.log('\nthe breaker is per-class and per-phase, on purpose')

  await test('three failures of DIFFERENT classes do not trip it', async () => {
    const h = harness()
    const breaker = new f.Breaker()
    for (const msg of ['HTTP 401', 'schema failed', 'fatal: not a git repository']) {
      await f.withRetry(async () => { throw e(msg) }, { label: 'x', phase: 'Verify', breaker, ...h })
    }
    assert.ok(!breaker.isTripped('Verify'),
      'three different diagnoses are not one systematic problem')
  })

  await test('a phase breaker does not stop a different phase', async () => {
    const h = harness()
    const breaker = new f.Breaker()
    for (const l of ['a', 'b', 'c']) {
      await f.withRetry(async () => { throw e('HTTP 401') }, { label: l, phase: 'Verify', breaker, ...h })
    }
    assert.ok(breaker.isTripped('Verify'))
    assert.ok(!breaker.isTripped('Build'), 'phases that do not depend on it continue')
  })

  await test('once tripped, further calls in that phase are skipped without running fn', async () => {
    const h = harness()
    const breaker = new f.Breaker()
    for (const l of ['a', 'b', 'c']) {
      await f.withRetry(async () => { throw e('HTTP 401') }, { label: l, phase: 'Verify', breaker, ...h })
    }
    let ran = false
    const r = await f.withRetry(async () => { ran = true; return 'x' },
      { label: 'd', phase: 'Verify', breaker, ...h })
    assert.strictEqual(ran, false, 'the breaker must prevent the call, not just record it')
    assert.strictEqual(r.skipped, true)
  })

  await test('a tripped breaker renders as a blocked-gate entry so it cannot vanish', () => {
    const breaker = new f.Breaker()
    for (let i = 0; i < 3; i++) breaker.record('Verify', f.Failure.AUTH)
    const entry = breaker.asBlockedEntry('Verify')
    assert.strictEqual(entry.gate, 'breaker.auth')
    assert.match(entry.whyGated, /one environmental fact/)
    assert.ok(entry.prepared && entry.unblocks)
  })

  console.log('\nthe happy path still works')

  await test('a call that succeeds on the first attempt records no failure', async () => {
    const h = harness()
    const r = await f.withRetry(async () => 'fine', { label: 'x', phase: 'P', ...h })
    assert.deepStrictEqual([r.ok, r.value, r.attempts, h.records.length], [true, 'fine', 1, 0])
  })

  await test('a transient failure that clears on retry succeeds and records the attempt', async () => {
    const h = harness()
    const r = await f.withRetry(thrower(1, () => e('ECONNRESET')), { label: 'x', phase: 'P', ...h })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.attempts, 2)
    assert.strictEqual(h.records.length, 1, 'the recovered attempt is still recorded')
  })

  console.log(`\n${passed} passed, exit ${process.exitCode || 0}`)
}

main()
