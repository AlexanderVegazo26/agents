'use strict'

/**
 * Tests for _policy.js. Run with `node sdlc-suite/workflows/_policy.test.js`.
 *
 * No test framework: this repository has no package.json, so adding one would be
 * a new runtime dependency for every adopter. Exit code is the result.
 *
 * Each block corresponds to one of CHG-16's three required fault injections. Two
 * of them were shown to fail before the code existed; the third — the end-of-input
 * case in `endOfInput` below — caught a real bug in the first implementation,
 * where `\Z` (which JavaScript does not have) matched a literal `Z` and a BLOCKED
 * entry at the end of a phase output was never captured. That is exactly the
 * disappearing-gate failure the reducer exists to prevent, so it stays asserted.
 */

const assert = require('assert')
const path = require('path')
const p = require('./_policy.js')

const POLICY = path.join(__dirname, '..', 'autonomy.json')

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  pass  ${name}`)
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`)
    process.exitCode = 1
  }
}

console.log('validate() — unknown keys are errors, not silent absences')

test('the shipped autonomy.json validates clean', () => {
  const policy = JSON.parse(require('fs').readFileSync(POLICY, 'utf8'))
  assert.deepStrictEqual(p.validate(policy), [])
})

test('an act-class typo is rejected and the near-miss named', () => {
  const bad = {
    mode: 'unattended',
    preAuthorized: { decide: {}, act: { deploi: false } },
    onBlocked: 'record-and-continue',
    escalation: { channel: 'return' },
  }
  const errs = p.validate(bad)
  assert.ok(errs.some(e => e.includes('deploi')), errs.join(' | '))
  assert.ok(errs.some(e => e.includes('did you mean deploy')), errs.join(' | '))
})

test('a decide-class typo is rejected — this is the one that fails UNSAFE', () => {
  // Absence reads as "not authorized". On act.* that is safe. On decide.*, where
  // five gates are meant to be ON, a typo silently revokes standing authorization
  // and the run reports itself blocked with no way to tell that from a lockdown.
  const bad = {
    mode: 'unattended',
    preAuthorized: { decide: { roadmapCommitt: true }, act: {} },
    onBlocked: 'record-and-continue',
    escalation: { channel: 'return' },
  }
  assert.ok(p.validate(bad).some(e => e.includes('roadmapCommitt')))
})

test('a non-boolean gate value is rejected', () => {
  const bad = {
    mode: 'unattended',
    preAuthorized: { decide: { roadmapCommit: 'yes' }, act: {} },
    onBlocked: 'record-and-continue',
    escalation: { channel: 'return' },
  }
  assert.ok(p.validate(bad).some(e => e.includes('must be a boolean')))
})

test('a bad enum value is rejected', () => {
  const bad = {
    mode: 'yolo',
    preAuthorized: { decide: {}, act: {} },
    onBlocked: 'record-and-continue',
    escalation: { channel: 'return' },
  }
  assert.ok(p.validate(bad).some(e => e.includes('mode must be one of')))
})

console.log('\nloadPolicy() — no policy means degraded, never "authorized"')

test('no resolvable policy => degraded, every gate false', () => {
  const r = p.loadPolicy({ explicitPath: '/nonexistent/a.json', cwd: '/nonexistent' })
  assert.strictEqual(r.degraded, true)
  assert.strictEqual(r.source, null)
  const all = Object.values(r.gates.decide).concat(Object.values(r.gates.act))
  assert.ok(all.length === 14 && all.every(v => v === false))
})

test('an INVALID policy also degrades — it does not fall back to permissive', () => {
  const fs = require('fs'), os = require('os')
  const f = path.join(os.tmpdir(), `autonomy-invalid-${process.pid}.json`)
  fs.writeFileSync(f, JSON.stringify({ mode: 'unattended', preAuthorized: { decide: { nope: true }, act: {} }, onBlocked: 'halt', escalation: {} }))
  try {
    const r = p.loadPolicy({ explicitPath: f })
    assert.strictEqual(r.degraded, true)
    assert.ok(r.errors.length > 0)
    assert.ok(Object.values(r.gates.act).every(v => v === false))
  } finally { fs.unlinkSync(f) }
})

test('the shipped policy resolves to 5 decide on, 0 act on', () => {
  const r = p.loadPolicy({ explicitPath: POLICY })
  assert.strictEqual(r.degraded, false)
  assert.strictEqual(Object.values(r.gates.decide).filter(Boolean).length, 5)
  assert.strictEqual(Object.values(r.gates.act).filter(Boolean).length, 0)
})

test('the degraded prompt says so, and says it is not a lockdown', () => {
  const text = p.gateTableForPrompt(p.loadPolicy({ explicitPath: '/nope', cwd: '/nope' }))
  assert.ok(text.includes('DEGRADED'))
  assert.ok(text.includes('deliberate lockdown'))
})

console.log('\ncollectBlockedGates() — a reducer, not an instruction to the reader')

const FULL = `Verify prose above.

BLOCKED — act.destructiveMigration
  Action withheld: dropping the legacy exports table
  Why gated:       irreversible; no verified backup after 2026-08-01
  Prepared:        migration 0042 dry-run against a restored snapshot;
                   rollback at db/rollback/0042.sql
  Unblocks:        the index rebuild in phase 5
  Authorize by:    setting preAuthorized.act.destructiveMigration

Prose after.`

test('one entry, gate parsed, prepared populated across a wrapped line', () => {
  const got = p.collectBlockedGates([FULL, 'a clean phase'])
  assert.strictEqual(got.length, 1)
  assert.strictEqual(got[0].gate, 'act.destructiveMigration')
  assert.ok(got[0].prepared.includes('rollback at db/rollback/0042.sql'))
  assert.ok(got[0].unblocks.includes('index rebuild'))
})

test('endOfInput: an entry that is the LAST thing in an output is still captured', () => {
  // Regression guard. The first implementation used `\Z`, which JavaScript does
  // not support — it matched a literal `Z`, so this entry terminated nowhere and
  // was dropped entirely. A gate vanishing from a run that otherwise looks clean
  // is the exact outcome the autonomy-policy skill forbids.
  const got = p.collectBlockedGates(['BLOCKED — act.deploy\n  Prepared: artifact built'])
  assert.strictEqual(got.length, 1)
  assert.strictEqual(got[0].prepared, 'artifact built')
})

test('hyphen and en-dash variants are caught too', () => {
  // An agent mistyping the dash must not make a gate disappear.
  assert.strictEqual(p.collectBlockedGates(['BLOCKED - act.deploy\n  Prepared: x\n']).length, 1)
  assert.strictEqual(p.collectBlockedGates(['BLOCKED – act.deploy\n  Prepared: x\n']).length, 1)
})

test('empty input is an empty array, not an error', () => {
  assert.deepStrictEqual(p.collectBlockedGates([]), [])
  assert.deepStrictEqual(p.collectBlockedGates(undefined), [])
})

test('the same gate with the same withheld action dedupes across phases', () => {
  const one = 'BLOCKED — act.deploy\n  Action withheld: ship v2\n'
  assert.strictEqual(p.collectBlockedGates([one, one]).length, 1)
})

test('the same gate with DIFFERENT withheld actions stays two entries', () => {
  const got = p.collectBlockedGates([
    'BLOCKED — act.deploy\n  Action withheld: ship api\n',
    'BLOCKED — act.deploy\n  Action withheld: ship web\n',
  ])
  assert.strictEqual(got.length, 2)
})

test('prose mentioning the word is not a false positive', () => {
  assert.strictEqual(
    p.collectBlockedGates(['The run was not blocked. No BLOCKED entries were produced.']).length, 0)
})

test('a non-string phase output (an object result) is still scanned', () => {
  // Second regression guard. The first implementation called JSON.stringify on a
  // non-string, which escapes a real newline into two characters, so the multiline
  // block stopped matching and the gate vanished. Agents here return
  // schema-validated OBJECTS far more often than raw strings, so this was the
  // common case, not the edge case.
  const got = p.collectBlockedGates([{ verdict: 'BLOCKED — act.grantAccess\n  Prepared: role drafted' }])
  assert.strictEqual(got.length, 1)
  assert.strictEqual(got[0].gate, 'act.grantAccess')
})

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`)
