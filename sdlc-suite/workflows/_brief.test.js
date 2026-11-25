'use strict'

/**
 * Tests for _brief.js — CHG-20's two required fault injections.
 *
 * The assertion that matters is not "the brief fits the budget". Any truncation
 * satisfies that, including a silent one. It is that when the brief IS cut, the
 * cut is announced, the omitted files are named, and the lens is told to go and
 * read them — because a silently-truncated brief manufactures exactly the
 * confident-but-partial verdict this change exists to prevent.
 */

const assert = require('assert')
const b = require('./_brief.js')

let passed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`  pass  ${name}`) }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1 }
}

const manifest = (label, nFiles, summaryLen = 300) => ({
  label,
  summary: 'x'.repeat(summaryLen),
  diffRef: 'HEAD~1..HEAD',
  filesChanged: Array.from({ length: nFiles }, (_, i) => ({
    path: `src/${label}-${i}.ts`, role: i === 0 ? 'test' : 'implementation',
  })),
  criteriaAddressed: ['AC-1', 'AC-3'],
  notAddressed: [{ id: 'AC-4', why: 'needs the schema change in the next slice' }],
})

console.log('the normal case — a brief that fits is not touched')

test('a small brief is not truncated and carries the file list', () => {
  const r = b.buildBrief({ manifests: [manifest('backend', 3)], lens: 'review', criteria: 'AC-1 …' })
  assert.strictEqual(r.truncated, false)
  assert.deepStrictEqual(r.omittedFiles, [])
  assert.ok(r.text.includes('src/backend-0.ts'))
  assert.ok(!r.text.includes('TRUNCATED'))
})

test('the acceptance criteria are always present — every finding traces to them', () => {
  const r = b.buildBrief({ manifests: [manifest('backend', 2)], lens: 'qa', criteria: 'AC-7 export as CSV' })
  assert.ok(r.text.includes('AC-7 export as CSV'))
})

test('notAddressed survives into the brief — the gap must be visible to the lens', () => {
  const r = b.buildBrief({ manifests: [manifest('backend', 2)], lens: 'review' })
  assert.ok(r.text.includes('AC-4'))
  assert.ok(r.text.includes('needs the schema change'))
})

test('each lens gets its own budget', () => {
  assert.strictEqual(b.LENS_BUDGETS.qa, 32_000)
  assert.strictEqual(b.LENS_BUDGETS.performance, 16_000)
  assert.notStrictEqual(b.LENS_BUDGETS.qa, b.LENS_BUDGETS.performance)
})

console.log('\nFAULT 1 — 40 changed files and a 200 KB summary')

test('every lens brief stays within budget', () => {
  const huge = {
    label: 'backend',
    summary: 'y'.repeat(200_000),
    diffRef: 'HEAD~1..HEAD',
    filesChanged: Array.from({ length: 40 }, (_, i) => ({ path: `src/f${i}.ts`, role: 'implementation' })),
    criteriaAddressed: ['AC-1'],
  }
  for (const lens of Object.keys(b.LENS_BUDGETS)) {
    const r = b.buildBrief({ manifests: [huge], lens, criteria: 'AC-1 …' })
    assert.ok(r.chars <= b.LENS_BUDGETS[lens],
      `${lens}: ${r.chars} chars exceeds its ${b.LENS_BUDGETS[lens]} budget`)
  }
})

test('a truncated brief CONTAINS THE MARKER and names the omitted files', () => {
  // The assertion that matters. Fitting the budget is trivially satisfiable by
  // silent truncation; being told about it is not.
  const huge = {
    label: 'backend',
    summary: 'y'.repeat(200_000),
    diffRef: 'HEAD~1..HEAD',
    filesChanged: Array.from({ length: 40 }, (_, i) => ({ path: `src/f${i}.ts`, role: 'implementation' })),
    criteriaAddressed: ['AC-1'],
  }
  const r = b.buildBrief({ manifests: [huge], lens: 'performance', criteria: 'AC-1 …' })
  assert.strictEqual(r.truncated, true)
  assert.ok(r.text.includes('TRUNCATED'), 'the marker must be present')
  assert.ok(r.text.includes('PARTIAL'), 'the marker must say what was lost')
  assert.ok(r.text.includes('cut mid-text'), 'and name which builder was cut')
  assert.ok(r.text.includes('Read the changed files directly'),
    'the marker must tell the lens what to do about it')
  assert.ok(r.text.includes('state in your verdict that your brief was truncated'),
    'and require the lens to disclose it downstream')
})

test('the per-builder summary cap is ANNOUNCED, never applied silently', () => {
  // Regression guard. The first implementation clamped every summary to
  // SUMMARY_CAP inside renderManifest and returned truncated:false, so a builder
  // that wrote 200 KB had 198 KB dropped and nothing anywhere said so — the same
  // silent-truncation defect this module exists to prevent, one layer down.
  const m = { label: 'backend', summary: 'y'.repeat(50_000), filesChanged: [], criteriaAddressed: [] }
  const r = b.buildBrief({ manifests: [m], lens: 'qa' })   // 32k budget: fits easily
  assert.strictEqual(r.truncated, true, 'clamping the summary IS truncation')
  assert.ok(r.text.includes('backend'), 'the marker names which builder was cut')
})

test('THE budget invariant: chars <= cap, across the dimension it is stated over', () => {
  // This assertion used to exist only on the 40-file fixture, where the marker
  // stays small, `room` is comfortably positive, and the `clamp(body, 0)` path is
  // never reached — so the module could violate its central contract while the
  // suite stayed green. `qa-techniques`: a fixture defines the test's blind spot,
  // so vary the dimension the invariant is stated over. That dimension is FILE
  // COUNT, not summary size.
  //
  // Measured against the pre-fix code: 900 files / performance returned 19,236
  // chars against a 16,000 cap while reporting `truncated: true`.
  for (const lens of Object.keys(b.LENS_BUDGETS)) {
    for (const nFiles of [0, 1, 40, 200, 900, 4000]) {
      for (const sumLen of [10, 1_000, 200_000]) {
        const m = {
          label: 'backend', summary: 'x'.repeat(sumLen), diffRef: 'HEAD~1..HEAD',
          filesChanged: Array.from({ length: nFiles },
            (_, i) => ({ path: `src/some/deeper/path/backend-${i}.ts`, role: 'implementation' })),
          criteriaAddressed: ['AC-1'],
        }
        const r = b.buildBrief({ manifests: [m], lens, criteria: 'AC-1 export as CSV' })
        assert.ok(r.chars <= b.LENS_BUDGETS[lens],
          `${lens} / ${nFiles} files / ${sumLen}-char summary: ${r.chars} > ${b.LENS_BUDGETS[lens]}`)
      }
    }
  }
})

test('a cut is always announced — no combination truncates silently', () => {
  for (const nFiles of [0, 1, 900]) {
    for (const sumLen of [10, 200_000]) {
      const m = {
        label: 'backend', summary: 'x'.repeat(sumLen), filesChanged:
          Array.from({ length: nFiles }, (_, i) => ({ path: `src/f${i}.ts`, role: 'implementation' })),
        criteriaAddressed: [],
      }
      const full = b.buildBrief({ manifests: [m], lens: 'qa' })
      // If anything was dropped, the marker must be present. The converse — a
      // marker with nothing dropped — would be noise, and is covered by the
      // "a small brief is not truncated" case above.
      if (full.truncated) {
        assert.ok(full.text.includes('TRUNCATED'),
          `${nFiles} files / ${sumLen} chars: truncated but no marker`)
      }
    }
  }
})

test('clamp handles n <= 1 — the negative-index slice that caused the overrun', () => {
  // `s.slice(0, n - 1)` with n = 0 is `s.slice(0, -1)`: everything but the last
  // character, not an empty string. That single expression is why the budget
  // silently failed to apply.
  const r = b.buildBrief({
    manifests: [{ label: 'x', summary: 'y'.repeat(5_000), filesChanged: [], criteriaAddressed: [] }],
    lens: 'performance', criteria: 'z'.repeat(15_900), budget: 16_000,
  })
  assert.ok(r.chars <= 16_000 || r.overBudget,
    'either it fits, or overBudget says plainly that the cap was unsatisfiable')
})

test('the file list is dropped BEFORE any summary is cut', () => {
  // A lens can recover a file list with Glob. It cannot recover a builder's
  // reasoning from anywhere, so reasoning is the last thing to go.
  // 900 files x ~30 chars overruns the 16k performance budget on the list alone,
  // while the 1,000-char summary is under the 2,000 per-builder cap.
  const m = manifest('backend', 900, 1_000)
  const r = b.buildBrief({ manifests: [m], lens: 'performance' })
  assert.strictEqual(r.truncated, true)
  assert.strictEqual(r.omittedFiles.length, 900, 'the file list went first')
  assert.ok(r.text.includes('x'.repeat(1_000)), 'the whole summary survived the file-list drop')
})

test('many builders with many files still fit, and every builder keeps its summary', () => {
  // 12 builders x 33 files: the file list alone is ~20k characters. Before the
  // step-2 marker capped it, this returned 21,108 chars against the 16,000
  // performance budget with every summary clamped away and only paths left.
  const ms = Array.from({ length: 12 }, (_, i) => ({
    label: `builder-${i}`,
    summary: `summary-of-builder-${i} ` + 'x'.repeat(1_900),
    filesChanged: Array.from({ length: 33 }, (_, j) => ({
      path: `src/module_${i}/very/deep/path/component_file_${j}.ts`, role: 'implementation',
    })),
    criteriaAddressed: ['AC-1'],
  }))
  const r = b.buildBrief({ manifests: ms, lens: 'performance', criteria: 'AC-1 thing' })
  assert.ok(r.chars <= 16_000, `12 builders / 396 files: ${r.chars} chars > 16000 budget`)
  assert.strictEqual(r.overBudget, false, 'the cap is satisfiable, so overBudget must be false')
  assert.strictEqual(r.truncated, true)
  assert.strictEqual(r.omittedFiles.length, 396)
  assert.ok(r.text.includes('Omitted files (396)'), 'the marker must still count the omitted files')
  assert.ok(r.text.includes('summary-of-builder-0'),
    'the first builder summary must survive; the brief held only paths')
})

test('omitted files are named individually, not counted', () => {
  const m = manifest('backend', 60, 500)
  const r = b.buildBrief({ manifests: [m], lens: 'performance' })
  if (r.truncated) {
    assert.ok(r.text.includes('src/backend-0.ts'), 'a reader must be able to go and read them')
    assert.ok(r.omittedFiles.includes('src/backend-59.ts'))
  }
})

console.log('\nFAULT 2 — the by-reference path is what makes truncation survivable')

test('the brief always carries a diff ref, even when truncated', () => {
  // This is what a lens follows when its brief was cut. Without it, truncation
  // is just lost information.
  const m = manifest('backend', 300, 60_000)
  const r = b.buildBrief({ manifests: [m], lens: 'performance' })
  assert.strictEqual(r.truncated, true)
  assert.ok(r.text.includes('HEAD~1..HEAD') || r.omittedFiles.length > 0,
    'the lens must have some route back to the real change')
})

test('handoffRecord captures chars and truncated so a degraded lens is visible later', () => {
  const ms = [manifest('backend', 40, 40_000)]
  const brief = b.buildBrief({ manifests: ms, lens: 'performance' })
  const rec = b.handoffRecord(brief, ms)
  assert.strictEqual(typeof rec.chars, 'number')
  assert.strictEqual(rec.truncated, brief.truncated)
  assert.ok(rec.files.length === 40)
  assert.deepStrictEqual(rec.diffRefs, ['HEAD~1..HEAD'])
})

test('three builders are all represented, not just the first', () => {
  const ms = [manifest('backend', 2), manifest('frontend', 2), manifest('database', 2)]
  const r = b.buildBrief({ manifests: ms, lens: 'qa', criteria: 'AC-1' })
  for (const l of ['backend', 'frontend', 'database']) {
    assert.ok(r.text.includes(`### ${l}`), `${l} missing from the brief`)
  }
})

test('an empty build phase produces a brief, not a crash', () => {
  const r = b.buildBrief({ manifests: [], lens: 'review', criteria: 'AC-1' })
  assert.strictEqual(r.truncated, false)
  assert.ok(r.text.includes('AC-1'))
})

console.log('\nthe schema is the contract that makes any of this possible')

test('the build manifest schema forbids extra keys and caps the summary', () => {
  const s = b.BUILD_MANIFEST_SCHEMA
  assert.strictEqual(s.additionalProperties, false)
  assert.strictEqual(s.properties.summary.maxLength, b.SUMMARY_CAP)
  assert.deepStrictEqual(s.required, ['summary', 'filesChanged', 'criteriaAddressed'])
})

console.log('\nproperties — seeded random manifests (deterministic: same seed, same cases)')

// mulberry32: tiny seeded PRNG, so a failure names a seed + case that reproduces.
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('buildBrief holds its contract over 400 seeded random build phases', () => {
  const SEED = 20261107
  const r = rng(SEED)
  const pick = a => a[Math.floor(r() * a.length)]
  const lenses = [...Object.keys(b.LENS_BUDGETS), 'unknown-lens']
  for (let i = 0; i < 400; i++) {
    const nBuilders = Math.floor(r() * 6)
    const manifests = Array.from({ length: nBuilders }, (_, k) => ({
      label: `builder-${k}`,
      summary: 'x'.repeat(pick([0, 50, 1_999, 2_000, 2_001, 9_000, 60_000])),
      diffRef: r() < 0.8 ? `HEAD~${k + 1}..HEAD` : undefined,
      filesChanged: Array.from({ length: pick([0, 1, 7, 60, 400, 1500]) },
        (_, j) => ({ path: `src/b${k}/mod-${j}.ts`, role: 'implementation' })),
      criteriaAddressed: ['AC-1'],
    }))
    const criteria = 'c'.repeat(pick([0, 20, 900, 5_000, 40_000]))
    const lens = pick(lenses)
    const budget = r() < 0.25 ? pick([0, 1, 300, 4_000, 100_000]) : undefined
    const out = b.buildBrief({ manifests, lens, criteria, budget })
    const ctx = `seed ${SEED} case ${i}: ${nBuilders} builders, lens ${lens}, budget ${budget}, ` +
      `criteria ${criteria.length} chars -> ${out.chars} chars`
    const cap = budget ?? b.LENS_BUDGETS[lens] ?? b.DEFAULT_BUDGET

    assert.strictEqual(out.budget, cap, `${ctx}: budget reported ${out.budget}, expected ${cap}`)
    assert.strictEqual(out.chars, out.text.length, `${ctx}: chars ${out.chars} != text.length`)
    assert.ok(out.chars <= cap || out.overBudget,
      `${ctx}: over the ${cap} cap without overBudget`)
    if (criteria) assert.ok(out.text.includes(criteria), `${ctx}: acceptance criteria were cut`)
    assert.strictEqual(out.text.includes('[TRUNCATED'), out.truncated,
      `${ctx}: marker present=${out.text.includes('[TRUNCATED')} but truncated=${out.truncated}`)
    if (out.omittedFiles.length) {
      assert.ok(out.text.includes(`(${out.omittedFiles.length})`),
        `${ctx}: ${out.omittedFiles.length} files omitted but the marker does not count them`)
    }
    for (const m of manifests) {
      if (m.summary.length > b.SUMMARY_CAP) {
        assert.ok(out.truncated, `${ctx}: ${m.label} summary > cap but truncated=false`)
        if (!out.overBudget) {
          assert.ok(out.text.includes(m.label),
            `${ctx}: ${m.label}'s ${m.summary.length}-char summary was clamped but no part of the ` +
            'brief names it (step-2 marker dropped the step-1 clamp note)')
        }
      }
      if (!out.truncated) {
        assert.ok(out.text.includes(`### ${m.label}`), `${ctx}: ${m.label} missing from an untruncated brief`)
        for (const f of m.filesChanged) {
          assert.ok(out.text.includes(f.path), `${ctx}: ${f.path} missing from an untruncated brief`)
        }
      }
    }
  }
})

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`)
