'use strict'

/**
 * Handoff by reference, with an enforced per-role budget and a visible
 * truncation marker.
 *
 * Today the build phase joins every builder's full output with separators and
 * interpolates that whole blob into all four verify-lens prompts. Three builders
 * into four lenses means the same text is re-sent four times, and each lens's
 * findings then fan out to refuters with the criteria re-attached.
 *
 * The failure mode is the bad one: an overflowing window produces a truncated or
 * degraded answer that is indistinguishable from a considered one. Nothing
 * measures it, so a lens that silently saw half the implementation reports a
 * clean verdict.
 *
 * So builders return a manifest — a summary, a file list, a diff ref — and each
 * lens reads what it needs. Every verifier already holds `Read`, `Grep` and
 * `Glob`, so no new tool grant is required.
 *
 * **The truncation marker is the whole point.** A budget that truncates silently
 * is worse than no budget, because it manufactures exactly the confident-but-
 * partial verdict this exists to prevent. When the brief must be cut, it says so,
 * names the files it dropped, and tells the lens to go and read them.
 */

/** Per-role brief budgets, in characters. */
const LENS_BUDGETS = {
  review: 24_000,
  qa: 32_000,
  security: 24_000,
  performance: 16_000,
}

const DEFAULT_BUDGET = 24_000
const SUMMARY_CAP = 2_000

/**
 * JSON Schema fragment for a builder's return value. Builders return this
 * instead of prose, which is what makes the by-reference handoff possible.
 */
const BUILD_MANIFEST_SCHEMA = {
  type: 'object',
  required: ['summary', 'filesChanged', 'criteriaAddressed'],
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string', maxLength: SUMMARY_CAP,
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
    planGaps: {
      type: 'array', items: { type: 'string' },
      description: 'Decisions the plan left open that you needed and did NOT make yourself — an interface, a data shape, a behavior. Escalated back to planning rather than improvised at build tier.',
    },
  },
}

function clamp(s, n) {
  s = String(s ?? '')
  if (s.length <= n) return s
  // n <= 1 must be handled explicitly. `s.slice(0, n - 1)` with n = 0 is
  // `s.slice(0, -1)` — JS negative-index slicing, which returns everything but
  // the LAST CHARACTER instead of an empty string. That made the budget report
  // `truncated: true` and then not truncate, which is the silent-partial-brief
  // failure this module exists to prevent, produced by the prevention mechanism.
  if (n <= 0) return ''
  if (n === 1) return '…'
  return s.slice(0, n - 1).trimEnd() + '…'
}

/** Cap a joined path list so the marker cannot outgrow the budget it announces. */
function joinCapped(paths, max) {
  const out = []
  let used = 0
  for (const p of paths) {
    if (used + p.length + 2 > max) {
      out.push(`…and ${paths.length - out.length} more`)
      break
    }
    out.push(p)
    used += p.length + 2
  }
  return out.join(', ')
}

/**
 * @param {object} m
 * @param {{includeFiles?: boolean, includeDetails?: boolean, clamped?: string[]}} opts
 *   `clamped` collects the labels of builders whose summary had to be cut, so the
 *   caller can announce it. Enforcing SUMMARY_CAP silently would be the same
 *   defect as a silent budget truncation, one layer down — a builder that wrote
 *   200 KB would have 198 KB dropped and nothing anywhere would say so.
 *   `includeDetails: false` reduces notAddressed and planGaps to counts: both
 *   survive elsewhere (the return value; the plan.insufficient gate).
 */
function renderManifest(m, { includeFiles = true, includeDetails = true, clamped = null } = {}) {
  const lines = []
  if (m.label) lines.push(`### ${m.label}`)
  const summary = String(m.summary ?? '')
  if (summary.length > SUMMARY_CAP && clamped) clamped.push(m.label || '(unlabelled)')
  lines.push(clamp(summary, SUMMARY_CAP))
  if (m.diffRef) lines.push(`\nDiff: \`${m.diffRef}\``)
  if (includeFiles && Array.isArray(m.filesChanged) && m.filesChanged.length) {
    lines.push('\nFiles changed:')
    for (const f of m.filesChanged) lines.push(`  - ${f.path} (${f.role})`)
  }
  if (Array.isArray(m.criteriaAddressed) && m.criteriaAddressed.length) {
    lines.push(`\nCriteria addressed: ${m.criteriaAddressed.join(', ')}`)
  }
  if (Array.isArray(m.notAddressed) && m.notAddressed.length) {
    if (includeDetails) {
      lines.push('\nDeliberately NOT addressed:')
      for (const n of m.notAddressed) lines.push(`  - ${n.id}: ${n.why}`)
    } else {
      lines.push(`\nDeliberately NOT addressed: ${m.notAddressed.map(n => n.id).join(', ')} (reasons cut for the budget)`)
    }
  }
  if (Array.isArray(m.planGaps) && m.planGaps.length) {
    if (includeDetails) {
      lines.push('\nPlan gaps escalated (decisions the builder did NOT make):')
      for (const g of m.planGaps) lines.push(`  - ${g}`)
    } else {
      lines.push(`\nPlan gaps escalated: ${m.planGaps.length} (cut for the budget; every one is in the run's BLOCKED plan.insufficient gate)`)
    }
  }
  return lines.join('\n')
}

/**
 * Build one lens's brief from the build-phase manifests.
 *
 * @param {object} opts
 * @param {Array<object>} opts.manifests   one per builder
 * @param {string} opts.lens               key into LENS_BUDGETS
 * @param {string} [opts.criteria]         the acceptance criteria text, always kept
 * @param {number} [opts.budget]           override, in characters
 * @param {string} [opts.changeRef]        how to see the WHOLE change (e.g. a git
 *                                         command), always kept
 * @returns {{text: string, chars: number, truncated: boolean, omittedFiles: string[]}}
 *
 * Trimming order is deliberate, and it is the opposite of the first version.
 * That one dropped the file list first, on the theory that a lens can recover
 * it with Glob; on the first live run the lenses did not, and code review,
 * security and performance never looked at two of the files the change was
 * about. A path costs ~50 characters and is the one thing a lens cannot work
 * without, so it goes LAST: first the notAddressed/planGaps detail (kept
 * elsewhere), then the summaries, and the file list only past 40% of the budget
 * — with every path that did not fit still named in the marker. The criteria
 * and the route to the whole change are never trimmed.
 */
function buildBrief({ manifests = [], lens, criteria = '', budget, changeRef = '' }) {
  const cap = budget ?? LENS_BUDGETS[lens] ?? DEFAULT_BUDGET
  const route = changeRef ? `## The whole change\n${changeRef}\n\n` : ''
  const head = (criteria ? `## Acceptance criteria\n${criteria}\n\n` : '') + route +
    (criteria || route ? '## Implementation\n' : '')

  // One consolidated, de-duplicated file list, so three builders that touched
  // the same file name it once.
  const seen = new Set()
  const fileLines = []
  for (const m of manifests) {
    for (const f of (m.filesChanged || [])) {
      if (!f || !f.path || seen.has(f.path)) continue
      seen.add(f.path)
      fileLines.push({ path: f.path, line: `  - ${f.path} (${f.role}) — ${m.label || 'builder'}` })
    }
  }
  // The file list: `keptN` lines shown, the rest named in the marker. Whole
  // lines only — a path is never cut mid-name (code review round 7, S4).
  const title = fileLines.length
    ? `\n\n## Files changed (${fileLines.length}, all builders) — read each one before concluding\n`
    : ''
  const filesTextOf = n => (fileLines.length ? title + fileLines.slice(0, n).map(x => x.line).join('\n') : '')
  const omittedOf = n => fileLines.slice(n).map(x => x.path)
  let keptN = 0
  {
    const room = Math.floor(cap * 0.4) - title.length
    let used = 0
    for (const x of fileLines) {
      if (used + x.line.length + 1 > room) break
      keptN++
      used += x.line.length + 1
    }
  }

  const clamped = []
  let detailsCut = false
  let summariesCut = false
  let body = manifests.map(m => renderManifest(m, { includeFiles: false, clamped })).join('\n\n')
  if (head.length + body.length + filesTextOf(keptN).length > cap) {
    // Step 1: the notAddressed reasons and the plan-gap texts go to counts.
    detailsCut = true
    body = manifests.map(m => renderManifest(m, { includeFiles: false, includeDetails: false })).join('\n\n')
  }

  const howToRead = `\n Read the changed files directly — with Read, Grep or Glob${route ? ', or through "The whole change" above' : ''} —` +
    ` before concluding, and state in your verdict that your brief was truncated.]`
  const markerOf = n => {
    const omitted = omittedOf(n)
    if (!omitted.length && !clamped.length && !detailsCut && !summariesCut) return ''
    const parts = [`\n\n[TRUNCATED — this brief is a PARTIAL account of the implementation.`]
    if (clamped.length) {
      parts.push(
        ` The summary from ${clamped.join(', ')} exceeded the ${SUMMARY_CAP}-character` +
        ` per-builder cap and was cut mid-text.`)
    }
    if (detailsCut) {
      parts.push(` To stay within a ${cap}-character budget, each builder's notAddressed reasons and plan-gap texts were reduced to counts.`)
    }
    if (summariesCut) {
      parts.push(` The builder summaries were cut mid-text to fit the ${cap}-character budget.`)
    }
    if (omitted.length) {
      parts.push(
        ` ${n ? 'The file list above is cut.' : 'The file list did not fit at all.'} Also changed, not listed above (${omitted.length}):` +
        ` ${joinCapped(omitted, Math.floor(cap * 0.15))}`)
    }
    parts.push(howToRead)
    return parts.join('')
  }
  const total = () => head.length + body.length + filesTextOf(keptN).length + markerOf(keptN).length

  // Step 2: only if it STILL does not fit, cut the summaries — and say so.
  if (total() > cap) {
    summariesCut = true
    body = clamp(body, Math.max(0, cap - head.length - filesTextOf(keptN).length - markerOf(keptN).length))
  }
  // Step 3: whole file lines, from the end, each one then named in the marker.
  while (keptN > 0 && total() > cap) keptN--

  let text = head + body + filesTextOf(keptN) + markerOf(keptN)

  // POST-CONDITION. The invariant this module exists to hold is `chars <= cap`.
  // The head (criteria and the route to the whole change) is never dropped, so a
  // cap smaller than the head is honoured as "head plus the marker" and the
  // marker says the brief is partial — the one case where the length may exceed
  // `cap`, reported as overBudget rather than hidden.
  if (text.length > cap && body) {
    summariesCut = true
    body = clamp(body, Math.max(0, cap - head.length - filesTextOf(keptN).length - markerOf(keptN).length))
    text = head + body + filesTextOf(keptN) + markerOf(keptN)
  }

  const omitted = omittedOf(keptN)
  const truncated = omitted.length > 0 || clamped.length > 0 || detailsCut || summariesCut
  return {
    text,
    chars: text.length,
    truncated,
    omittedFiles: omitted,
    // True when even head+marker alone exceed the budget. The caller can see
    // that the cap was unsatisfiable rather than inferring it from a length.
    overBudget: text.length > cap,
    budget: cap,
  }
}

/**
 * Per-agent handoff record for the phase artifact, so a degraded lens is visible
 * after the fact instead of being indistinguishable from a considered one.
 */
function handoffRecord(brief, manifests) {
  return {
    chars: brief.chars,
    truncated: brief.truncated,
    omittedFiles: brief.omittedFiles,
    files: manifests.flatMap(m => (m.filesChanged || []).map(f => f.path)),
    diffRefs: manifests.map(m => m.diffRef).filter(Boolean),
  }
}

module.exports = {
  LENS_BUDGETS, DEFAULT_BUDGET, SUMMARY_CAP,
  BUILD_MANIFEST_SCHEMA, buildBrief, renderManifest, handoffRecord,
}
