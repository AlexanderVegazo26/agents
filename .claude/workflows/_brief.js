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
 * @param {{includeFiles?: boolean, clamped?: string[]}} opts
 *   `clamped` collects the labels of builders whose summary had to be cut, so the
 *   caller can announce it. Enforcing SUMMARY_CAP silently would be the same
 *   defect as a silent budget truncation, one layer down — a builder that wrote
 *   200 KB would have 198 KB dropped and nothing anywhere would say so.
 */
function renderManifest(m, { includeFiles = true, clamped = null } = {}) {
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
    lines.push('\nDeliberately NOT addressed:')
    for (const n of m.notAddressed) lines.push(`  - ${n.id}: ${n.why}`)
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
 * @returns {{text: string, chars: number, truncated: boolean, omittedFiles: string[]}}
 *
 * Trimming order is deliberate. The file LIST is dropped before any summary is
 * cut, because a lens can recover a file list with `Glob` but cannot recover a
 * builder's reasoning from anywhere. The criteria are never trimmed: they are
 * what every finding is traced against.
 */
function buildBrief({ manifests = [], lens, criteria = '', budget }) {
  const cap = budget ?? LENS_BUDGETS[lens] ?? DEFAULT_BUDGET
  const head = criteria ? `## Acceptance criteria\n${criteria}\n\n## Implementation\n` : ''

  let omitted = []
  const clamped = []
  let body = manifests.map(m => renderManifest(m, { clamped })).join('\n\n')

  if (head.length + body.length > cap) {
    // Step 1: drop the per-builder file lists, keeping every summary.
    omitted = manifests.flatMap(m => (m.filesChanged || []).map(f => f.path))
    body = manifests.map(m => renderManifest(m, { includeFiles: false })).join('\n\n')
  }

  let truncated = omitted.length > 0 || clamped.length > 0
  let marker = ''

  if (truncated) {
    const parts = [`\n\n[TRUNCATED — this brief is a PARTIAL account of the implementation.`]
    if (clamped.length) {
      parts.push(
        ` The summary from ${clamped.join(', ')} exceeded the ${SUMMARY_CAP}-character` +
        ` per-builder cap and was cut mid-text.`)
    }
    if (omitted.length) {
      // The omitted list is capped at a fraction of the budget. Uncapped, it
      // grew without bound in the number of changed files and could exceed the
      // whole budget on its own — worst exactly when the brief matters most.
      parts.push(
        ` The file list was omitted to stay within a ${cap}-character budget.\n` +
        ` Omitted (${omitted.length}): ${joinCapped(omitted, Math.floor(cap * 0.25))}`)
    }
    parts.push(
      `\n Read the changed files directly — with Read, Grep or Glob — before` +
      ` concluding, and state in your verdict that your brief was truncated.]`)
    marker = parts.join('')
  }

  // Step 2: only if it STILL does not fit, cut the summaries — and say so.
  if (head.length + body.length + marker.length > cap) {
    const room = Math.max(0, cap - head.length - marker.length - 400)
    body = clamp(body, room)
    truncated = true
    marker =
      `\n\n[TRUNCATED: this brief exceeded its ${cap}-character budget and the ` +
      `builder summaries were cut mid-text.\n` +
      (omitted.length ? ` Omitted files: ${omitted.join(', ')}\n` : '') +
      ` You are seeing a PARTIAL account of the implementation. Read the changed ` +
      `files directly before concluding, and state in your verdict that your brief ` +
      `was truncated.]`
  }

  let text = head + body + marker

  // POST-CONDITION. The invariant this module exists to hold is `chars <= cap`,
  // and until this existed nothing enforced it: `buildBrief` computed a budget,
  // announced a truncation, and could still return 19,236 characters against a
  // 16,000 cap. An invariant with no post-condition is a comment.
  //
  // The head (acceptance criteria) is never dropped — every finding traces to
  // it — so a cap smaller than the head is honoured as "head plus the marker",
  // and the marker says the brief is partial. That is the one case where the
  // returned length may exceed `cap`, and it is reported rather than hidden.
  if (text.length > cap) {
    const keep = Math.max(0, cap - head.length - marker.length)
    text = head + clamp(body, keep) + marker
    truncated = true
  }

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
