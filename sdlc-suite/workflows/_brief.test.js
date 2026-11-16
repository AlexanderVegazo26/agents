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

test('planGaps survive into the brief — an escalated decision must be visible to the lens', () => {
  const m = { ...manifest('backend', 1), planGaps: ['plan.md does not say whether export is sync or async'] }
  const r = b.buildBrief({ manifests: [m], lens: 'review' })
  assert.ok(r.text.includes('Plan gaps escalated'))
  assert.ok(r.text.includes('sync or async'))
  const none = b.buildBrief({ manifests: [manifest('backend', 1)], lens: 'review' })
  assert.ok(!none.text.includes('Plan gaps escalated'), 'no gap section when the builder raised none')
})

test('the manifest schema admits planGaps as an optional string array', () => {
  const s = b.BUILD_MANIFEST_SCHEMA
  assert.deepStrictEqual(s.properties.planGaps.items, { type: 'string' })
  assert.ok(!s.required.includes('planGaps'))
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

test('the file list goes LAST — details and summaries are cut before any path', () => {
  // The first version dropped the file list first ("a lens can recover it with
  // Glob"). On the first live run the lenses did not, and code review, security
  // and performance never read table-assigner.ts or availability.ts — two of the
  // files the change was about. A realistic HU: 3 builders, 33 files, long
  // plan gaps and notAddressed reasons, 28 long criteria.
  const gaps = Array.from({ length: 6 }, (_, i) => `OD-${i}: ${'a decision the plan left open '.repeat(8)}`)
  const ms = ['backend', 'frontend', 'data'].map((l, k) => ({
    label: `build:${l}`, summary: 's'.repeat(1_900), diffRef: 'git diff 3f03357',
    filesChanged: Array.from({ length: 11 }, (_, i) => ({ path: `apps/${l}/src/lib/services/file-${k}-${i}.ts`, role: 'implementation' })),
    criteriaAddressed: ['HU16-AC-01'],
    notAddressed: [{ id: 'HU16-AC-20', why: 'w'.repeat(400) }],
    planGaps: gaps,
  }))
  const criteria = Array.from({ length: 28 }, (_, i) => `HU16-AC-${i}: ${'c'.repeat(380)}`).join('\n')
  for (const lens of Object.keys(b.LENS_BUDGETS)) {
    const r = b.buildBrief({ manifests: ms, lens, criteria, changeRef: 'git diff 3f03357 --stat; git status --short' })
    assert.deepStrictEqual(r.omittedFiles, [], `${lens}: a path was dropped while details or summaries could still go`)
    for (const m of ms) for (const f of m.filesChanged) assert.ok(r.text.includes(f.path), `${lens}: ${f.path} missing`)
    assert.ok(r.text.includes('git diff 3f03357 --stat'), `${lens}: the route to the whole change was cut`)
    assert.ok(r.chars <= b.LENS_BUDGETS[lens] || r.overBudget, `${lens}: ${r.chars} > budget`)
    if (r.truncated) assert.ok(r.text.includes('TRUNCATED'), `${lens}: cut without a marker`)
  }
})

test('a big head never cuts a path mid-name: every changed file is listed whole or reported omitted', () => {
  // Code review round 7, S4: with ~11 K of criteria and 80 files, the final
  // clamp cut the file list mid-path and reported nothing omitted.
  const criteria = Array.from({ length: 28 }, (_, i) => `HU16-AC-${i}: ${'c'.repeat(380)}`).join('\n')
  for (const nFiles of [55, 80, 200]) {
    const m = { label: 'build:backend', summary: 's'.repeat(1_900), filesChanged: Array.from({ length: nFiles }, (_, i) => ({ path: `apps/api/src/lib/services/zones-${i}.ts`, role: 'implementation' })), criteriaAddressed: [] }
    for (const lens of Object.keys(b.LENS_BUDGETS)) {
      const r = b.buildBrief({ manifests: [m], lens, criteria, changeRef: 'git diff abc --stat' })
      assert.ok(r.chars <= b.LENS_BUDGETS[lens] || r.overBudget, `${lens}/${nFiles}: over budget`)
      for (const f of m.filesChanged) {
        const listed = r.text.includes(`  - ${f.path} (`)
        const reported = r.omittedFiles.includes(f.path)
        assert.ok(listed !== reported, `${lens}/${nFiles}: ${f.path} is ${listed ? 'both listed and reported omitted' : 'neither listed nor reported omitted'}`)
      }
      if (r.omittedFiles.length) assert.ok(r.text.includes('Also changed, not listed above'), `${lens}/${nFiles}: files dropped without a word`)
    }
  }
})

test('when even the file list cannot fit, every dropped path is still named', () => {
  const m = manifest('backend', 900, 1_000)
  const r = b.buildBrief({ manifests: [m], lens: 'performance' })
  assert.strictEqual(r.truncated, true)
  assert.ok(r.omittedFiles.length > 0 && r.omittedFiles.length < 900, 'part of the list is kept, the rest named')
  assert.ok(r.text.includes(r.omittedFiles[0]), 'the first dropped path is named in the marker')
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

console.log(`\n${passed} passed, exit ${process.exitCode || 0}`)
