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
  const none = p.loadPolicy({ cwd: '/nonexistent' })
  assert.strictEqual(none.degraded, true)
  assert.strictEqual(none.source, null)
  // A missing EXPLICIT path is degraded too, and says which path was missing.
  const r = p.loadPolicy({ explicitPath: '/nonexistent/a.json', cwd: '/nonexistent' })
  assert.strictEqual(r.degraded, true)
  assert.ok(r.errors.some(e => /does not exist/.test(e)), JSON.stringify(r.errors))
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

// Precedence. The shipped autonomy.json says "copy this file to a consuming repo
// as .claude/autonomy.json to override" — so the repo's own file must win over
// the plugin default the command layer passes as `policy`. Measured before the
// fix: repo roadmapCommit=false + explicit plugin path => true. Once every
// command passes that path (R1), the old order would override a repo's lockdown
// on EVERY run, so this is the gate for the args fix.
function withRepoPolicy(mutate, fn) {
  const fs = require('fs'), os = require('os')
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-prec-'))
  const repo = JSON.parse(fs.readFileSync(POLICY, 'utf8'))
  mutate(repo)
  fs.mkdirSync(path.join(cwd, '.claude'))
  fs.writeFileSync(path.join(cwd, '.claude', 'autonomy.json'), JSON.stringify(repo))
  try { fn(cwd) } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
}

test('a repo .claude/autonomy.json wins over the plugin DEFAULT', () => {
  withRepoPolicy(r => { r.preAuthorized.decide.roadmapCommit = false }, cwd => {
    const r = p.loadPolicy({ defaultPath: POLICY, cwd })
    assert.strictEqual(r.source, path.join(cwd, '.claude', 'autonomy.json'))
    assert.strictEqual(r.gates.decide.roadmapCommit, false)
  })
})

test('explicit and repo INTERSECT — an invoker can run stricter than the repo', () => {
  withRepoPolicy(r => { r.preAuthorized.act.deploy = true }, cwd => {
    const r = p.loadPolicy({ explicitPath: POLICY, defaultPath: POLICY, cwd })
    assert.deepStrictEqual(r.sources, [POLICY, path.join(cwd, '.claude', 'autonomy.json')])
    assert.strictEqual(r.gates.act.deploy, false)
  })
})

test('...and never looser: a permissive explicit policy cannot lift a repo lockdown (R2)', () => {
  withRepoPolicy(r => { r.preAuthorized.decide.roadmapCommit = false }, cwd => {
    // The shipped default grants roadmapCommit. Passed under the OLD `policy`
    // name, it used to override the repo's `false`.
    const r = p.loadPolicy({ explicitPath: POLICY, cwd })
    assert.strictEqual(r.gates.decide.roadmapCommit, false)
  })
})

test('an explicit policy path that does not exist degrades — it does not fall through to the repo', () => {
  withRepoPolicy(r => { r.preAuthorized.act.deploy = true }, cwd => {
    const r = p.loadPolicy({ explicitPath: path.join(cwd, 'typo-autonomy.json'), cwd })
    assert.strictEqual(r.degraded, true)
    assert.strictEqual(r.gates.act.deploy, false)
  })
})

test('an INVALID repo policy degrades — it never falls through to the permissive default', () => {
  withRepoPolicy(r => { r.preAuthorized.act.deploi = true }, cwd => {
    const r = p.loadPolicy({ defaultPath: POLICY, cwd })
    assert.strictEqual(r.degraded, true)
    assert.ok(Object.values(r.gates.decide).every(v => v === false))
  })
})

test('an UNREADABLE repo policy (a directory) degrades rather than falling through', () => {
  const fs = require('fs'), os = require('os')
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-dir-'))
  fs.mkdirSync(path.join(cwd, '.claude', 'autonomy.json'), { recursive: true })
  try {
    const r = p.loadPolicy({ defaultPath: POLICY, cwd })
    assert.strictEqual(r.degraded, true, `source ${r.source}`)
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

test('with no repo policy, the default is the fallback', () => {
  const r = p.loadPolicy({ defaultPath: POLICY, cwd: '/nonexistent' })
  assert.strictEqual(r.source, POLICY)
  assert.strictEqual(r.degraded, false)
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

test('CRLF entries keep their fields, and two distinct CRLF deploys stay two gates', () => {
  // A Windows agent (or a CLI that writes CRLF) produced `{ gate }` with every
  // field dropped: `(.*)$` in parseFields stopped at the `\r`. With
  // actionWithheld gone the dedupe key collapsed two distinct deploys into one.
  const entry = a => `BLOCKED — act.deploy\r\n  Action withheld: ${a}\r\n  Why gated:       prod\r\n`
  const got = p.collectBlockedGates([entry('ship api'), entry('ship web')])
  assert.deepStrictEqual(got, [
    { gate: 'act.deploy', actionWithheld: 'ship api', whyGated: 'prod' },
    { gate: 'act.deploy', actionWithheld: 'ship web', whyGated: 'prod' },
  ], `CRLF entries parsed as ${JSON.stringify(got)}`)
  assert.deepStrictEqual(p.parseFields('\r\n  Prepared: x\r\n    y\r\n'), { prepared: 'x y' },
    'parseFields on a CRLF block')
})

test('an indented BLOCKED header after another entry starts a new entry instead of vanishing', () => {
  // Agents indent whole blocks. The second header read as a continuation of the
  // first entry, so act.sendEmail vanished and its action overwrote act.deploy's.
  const got = p.collectBlockedGates([
    '  BLOCKED — act.deploy\n    Action withheld: ship api\n  BLOCKED — act.sendEmail\n    Action withheld: mail all users\n',
  ])
  assert.deepStrictEqual(got, [
    { gate: 'act.deploy', actionWithheld: 'ship api' },
    { gate: 'act.sendEmail', actionWithheld: 'mail all users' },
  ], `indented entries parsed as ${JSON.stringify(got)}`)
})

// mulberry32: tiny seeded PRNG, so a failure names a seed + run that reproduces.
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('collectBlockedGates recovers every entry over 500 seeded random phase-output sets — no gate or field vanishes', () => {
  const SEED = 20261108
  const r = rng(SEED)
  const pick = a => a[Math.floor(r() * a.length)]
  const GATES_POOL = ['act.deploy', 'act.destructiveMigration', 'act.grantAccess', 'act.sendEmail', 'spend.over_budget']
  // The documented labels (the model's own copy, not FIELD_MAP) and casings an agent produces.
  const LABELS = { actionWithheld: 'Action withheld', whyGated: 'Why gated', prepared: 'Prepared',
    unblocks: 'Unblocks', authorizeBy: 'Authorize by' }
  const recase = s => pick([s, s.toLowerCase(), s.toUpperCase()])
  const WORDS = ['ship', 'v2.4.0', 'to', 'production', 'rollback', 'takes', '20', 'min', 'users.legacy', 'RELEASE.md']
  const phrase = () => Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(WORDS)).join(' ')
  const PROSE = ['All checks green.', 'Migration plan written.', 'Notes follow:', 'The run was not blocked here.']
  let checkedEntries = 0
  let crlfSets = 0

  for (let run = 0; run < 500; run++) {
    const eol = pick(['\n', '\r\n', '\r\n', '\r'])
    if (eol !== '\n') crlfSets++
    const expected = []
    const outputs = []
    const nOutputs = 1 + Math.floor(r() * 3)
    let uid = 0
    for (let o = 0; o < nOutputs; o++) {
      const lines = []
      if (r() < 0.7) lines.push(pick(PROSE))
      const nEntries = Math.floor(r() * 3)
      for (let e = 0; e < nEntries; e++) {
        const gate = pick(GATES_POOL)
        // A unique withheld action, so only the deliberate repeats below dedupe.
        const fields = { actionWithheld: `${phrase()} #${run}-${uid++}` }
        for (const k of Object.keys(LABELS).slice(1)) if (r() < 0.6) fields[k] = phrase()
        lines.push(`${pick(['', ' ', '\t'])}${recase('BLOCKED')}${pick(['', ' ', '\t'])}${pick(['—', '–', '-'])}` +
          `${pick([' ', '  ', '\t'])}${gate}${pick(['', ' ', '\t'])}`)
        const want = { gate }
        for (const [k, v] of Object.entries(fields)) {
          const wrap = r() < 0.25 ? phrase() : null
          lines.push(`${pick(['  ', '    ', '\t'])}${recase(LABELS[k])}:${pick(['', ' ', '       '])}${v}`)
          if (wrap) lines.push(`${pick(['  ', '                   '])}${wrap}`)
          want[k] = wrap ? `${v} ${wrap}` : v
        }
        expected.push(want)
        if (r() < 0.5) lines.push(pick(PROSE))
      }
      let text = lines.join(eol)
      if (r() < 0.5) text += eol
      // The shapes agents return: a raw string or a schema object, sometimes nested.
      outputs.push(pick([
        () => text,
        () => ({ verdict: 'Go', notes: text }),
        () => ({ result: { items: [text] } }),
        () => [text],
      ])())
    }
    // A phase that repeats an earlier entry verbatim adds no new gate.
    if (expected.length && r() < 0.3) {
      const dup = pick(expected)
      const rep = [`BLOCKED — ${dup.gate}`, ...Object.entries(dup).filter(([k]) => k !== 'gate')
        .map(([k, v]) => `  ${LABELS[k]}: ${v}`)].join(eol)
      outputs.push({ notes: rep })
    }

    const got = p.collectBlockedGates(outputs)
    assert.deepStrictEqual(got, expected,
      `seed ${SEED} run ${run} (eol ${JSON.stringify(eol)}): outputs ${JSON.stringify(outputs)}`)
    checkedEntries += expected.length
  }
  assert.ok(checkedEntries >= 500, `only ${checkedEntries} entries generated over 500 runs`)
  assert.ok(crlfSets >= 200, `only ${crlfSets} of 500 runs used CR/CRLF line endings`)
})

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`)
