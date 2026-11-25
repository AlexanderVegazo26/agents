#!/usr/bin/env node
'use strict'
/**
 * sdlc-feature — run a feature end-to-end through the SDLC agent suite:
 * requirements, design, build, independent verification, release readiness.
 * Produces recommendations only — never deploys.
 *
 * Usage: node workflows/sdlc-feature.js "Add CSV export to the reporting dashboard"
 * Env:   CMDC_BIN, CMDC_MODEL, CMDC_AGENT_TIMEOUT_MS
 */
const { log, phase, runAgent, runGit, parallel, pipeline, withWorktree, mergeBranches } = require('./_runner')

const initiative = process.argv.slice(2).join(' ') || 'No initiative supplied — report this and stop.'

const CRITERIA_SCHEMA = {
  type: 'object',
  required: ['criteria', 'assumptions', 'openQuestions', 'surfaces'],
  properties: {
    criteria: {
      type: 'array',
      items: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    surfaces: { type: 'array', items: { type: 'string', enum: ['backend', 'frontend', 'data'] } },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings', 'verdict'],
  properties: {
    verdict: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'summary', 'evidence'],
        properties: {
          severity: { type: 'string' },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          needsExecution: { type: 'boolean' },
        },
      },
    },
  },
}

const REFUTE_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reasoning'],
  properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
}

async function main() {
  log(`initiative: ${initiative}`)

  // ---- Phase 1 — Requirements. Everything downstream traces to these IDs. ----
  phase('Requirements')
  const reqs = await runAgent({
    name: 'product-analyst',
    schema: CRITERIA_SCHEMA,
    task: `Convert this initiative into implementation-ready requirements: ${initiative}

Produce numbered, stable acceptance-criterion IDs — every downstream agent in this workflow traces against them, so an unstable ID breaks the whole run. Record assumptions as numbered/traceable/risk-rated per your §4. Do not invent a success metric that wasn't given; label any proposal as proposed-not-confirmed.

Also classify which implementation surfaces this genuinely touches (backend / frontend / data) so the build phase only spawns the specialists actually needed.`,
  })

  if (!reqs || !reqs.criteria?.length) {
    console.log(JSON.stringify({
      status: 'stopped',
      reason: 'product-analyst produced no acceptance criteria. Nothing downstream can trace against anything — this is a stop condition, not a reason to proceed on inference.',
      openQuestions: reqs?.openQuestions ?? [],
    }, null, 2))
    return
  }

  const criteriaText = reqs.criteria.map(c => `${c.id}: ${c.text}`).join('\n')
  log(`${reqs.criteria.length} acceptance criteria; surfaces: ${reqs.surfaces.join(', ') || 'none classified'}`)

  // ---- Phase 2 — Design. UX and architecture are genuinely independent
  // inputs, and both must land before build starts — a legitimate barrier. ----
  phase('Design')
  const needsUx = reqs.surfaces.includes('frontend')
  const designThunks = []
  if (needsUx) {
    designThunks.push(() =>
      runAgent({
        name: 'ux-designer',
        task: `Produce the UX specification for these requirements:\n${criteriaText}\n\nSpecify every interactive state — initial, loading, empty, success, error, permission-denied, degraded. State accessibility requirements as checkable targets (a WCAG level, a contrast ratio, a touch-target size), not aspirations; ui-engineer owns turning them into measured values. Flag any gap back rather than inventing behavior.`,
      }),
    )
  }
  designThunks.push(() =>
    runAgent({
      name: 'solution-architect',
      task: `Assess the architecture for these requirements:\n${criteriaText}\n\nDecide the tier per your §2 — if this is Tier 1, say so and keep it short rather than manufacturing an ADR. Define NFRs as measurable numbers, never "scalable" or "fast". Flag anything that constrains the UX so it can be reconciled before build rather than mid-implementation.`,
    }),
  )
  const designs = await parallel(designThunks)

  const uxSpec = needsUx ? designs[0] : null
  const architecture = needsUx ? designs[1] : designs[0]

  // ---- Phase 3 — Build. One specialist per surface actually touched. ----
  phase('Build')
  const BUILDERS = {
    backend: {
      name: 'software-engineer',
      brief: `Implement the backend/application changes. Stay inside scope — collect anything else you notice as "noticed but didn't touch".`,
    },
    frontend: {
      name: 'ui-engineer',
      brief: `Implement the frontend against the UX specification, state-for-state. Do not invent a state the spec omitted — flag the gap.\n\nUX SPEC:\n${uxSpec ?? '(none produced)'}`,
    },
    data: {
      name: 'database-engineer',
      brief: `Design and implement the schema/migration in Build mode. Rollback design is yours; rollback *rehearsal* is qa-engineer's to execute independently — hand it off as a hypothesis, not a confirmed result.`,
    },
  }

  // Each builder works in its own worktree on its own branch; withWorktree
  // commits what it leaves behind, so the work survives the worktree. A
  // builder that throws (or whose work could not be committed) is recorded,
  // not allowed to take the other surfaces down with it.
  const buildTargets = reqs.surfaces.filter(s => BUILDERS[s])
  const built = await parallel(
    buildTargets.map(surface => async () => {
      const builder = BUILDERS[surface]
      try {
        const run = await withWorktree(async wt => runAgent({
          name: builder.name,
          cwd: wt,
          task: `${builder.brief}\n\nACCEPTANCE CRITERIA (trace to these IDs):\n${criteriaText}\n\nARCHITECTURE CONTEXT:\n${architecture ?? '(none)'}\n\nReport honestly per your reporting section: distinguish verified / believed / assumed, and name any criterion you did not address.`,
        }), { label: `build-${surface}` })
        return { surface, ...run }
      } catch (err) {
        log(`build:${surface} failed: ${err.message}`)
        return { surface, value: null, error: err.message }
      }
    }),
  )

  const builds = built.map(b => ({
    surface: b.surface,
    branch: b.branch ?? null,
    commit: b.commit ?? null,
    changed: b.changed ?? null,
    isolated: b.isolated ?? null,
    reported: b.value != null,
    ...(b.error ? { error: b.error } : {}),
    ...(b.note ? { note: b.note } : {}),
  }))
  const implementation = built
    .filter(b => b.value != null)
    .map(b => `[${b.surface}] ${typeof b.value === 'string' ? b.value : JSON.stringify(b.value)}`)
    .join('\n\n---\n\n')
  const isolated = built.some(b => b.isolated)
  // Only a build that both reported and changed files is merged. A branch
  // from a builder that crashed mid-way is kept and listed, never merged.
  const toMerge = built.filter(b => b.value != null && b.changed && b.branch).map(b => b.branch)
  if (!implementation || (isolated && !toMerge.length)) {
    console.log(JSON.stringify({
      status: 'stopped',
      reason: !implementation
        ? 'No build surface produced an implementation.'
        : 'No builder changed any file, so there is nothing to verify — a self-report of work is not the work.',
      requirements: reqs,
      builds,
      implementation: implementation || null,
    }, null, 2))
    return
  }

  // ---- Phases 4 and 5 run against the change itself. In a git repository
  // the builders' branches are merged onto one integration branch, in its own
  // worktree, and every verifier runs THERE: before 2026-11-13 the verifiers
  // ran in the caller's tree, which never contained the change, and so could
  // only "verify" the builders' self-reports. The integration branch is kept
  // for the human merge decision; the caller's working tree is never touched.
  const integration = await withWorktree(async (dir, { isolated: inWorktree }) => {
    let base = null
    if (inWorktree) {
      base = String(runGit(['rev-parse', 'HEAD'], dir).stdout || '').trim()
      const merged = mergeBranches(dir, toMerge)
      if (!merged.ok) return { stopped: { status: 'stopped', reason: `The builders' branches do not merge cleanly (${merged.branch}): ${merged.error}`, requirements: reqs, builds } }
    }
    const where = inWorktree
      ? `THE CHANGE IS CHECKED OUT IN YOUR WORKING DIRECTORY (${dir}). \`git diff ${base}..HEAD\` shows all of it. Read, run and test it there — the builders' reports below are claims to check, not evidence.`
      : `This is not a git repository: the builders edited the working directory (${dir}) in place. Read, run and test the change there — the builders' reports below are claims to check, not evidence.`
    return { assessed: await verifyAndAssess({ cwd: dir, where }) }
  }, { label: 'integration' })

  if (integration.value.stopped) {
    console.log(JSON.stringify(integration.value.stopped, null, 2))
    return
  }
  const { confirmed, refuted, readiness, docs } = integration.value.assessed

  const change = integration.isolated
    ? { branch: integration.branch, commit: integration.commit, base: integration.base, builds }
    : { branch: null, note: integration.note, builds }

  const report = {
    initiative,
    requirements: reqs,
    design: { ux: uxSpec, architecture },
    surfacesBuilt: reqs.surfaces,
    change,
    findings: { confirmed, refutedCount: refuted.length },
    readinessRecommendation: readiness,
    documentation: docs,
    humanDecisionRequired: [
      'Release go/no-go — release-manager recommends, it never commits.',
      ...(change.branch ? [`Merge decision — the change is on branch ${change.branch}; nothing was merged into your working tree.`] : []),
      ...reqs.openQuestions,
    ],
    blockedGates:
      'Collect every "BLOCKED — <gate>" entry from the phase outputs above. Empty means no gate was hit, not that gates were skipped.',
  }
  console.log(JSON.stringify(report, null, 2))

  async function verifyAndAssess({ cwd, where }) {
    // ---- Phase 4 — Verify. Four independent evidentiary bases on the same
    // change. Deliberately NOT a barrier per lens: each lens pipelines straight
    // into its own adversarial check, so a slow lens doesn't hold up a fast one. ----
    phase('Verify')
    const LENSES = [
      {
        key: 'review',
        name: 'code-reviewer',
        brief: `Review by reading. Form your independent expectation from the criteria BEFORE reading the diff (your §4 contamination guard), then state if it changed. Never inherit the implementer's self-report.`,
      },
      {
        key: 'qa',
        name: 'qa-engineer',
        brief: `Verify by executing. Re-run any claimed verification yourself — a "tests pass" report is a hypothesis until you run it this session. Label every claim Verified / Falsified / Unverified / Untestable, and include the "what was NOT tested" section.`,
      },
      {
        key: 'security',
        name: 'security-engineer',
        brief: `Review mode — findings and direction, no rewrites. Classify Critical/High/Medium/Low/Informational. No finding without a plausible attack path; no security theater.`,
      },
      {
        key: 'performance',
        name: 'performance-engineer',
        brief: `Trace the target BEFORE measuring current behavior (your §3). If no target exists, say so and propose one labeled proposed-not-confirmed. No claim without a number.`,
      },
    ]

    const verified = await pipeline(
      LENSES,
      lens =>
        runAgent({
          name: lens.name,
          schema: FINDINGS_SCHEMA,
          cwd,
          task: `${lens.brief}\n\n${where}\n\nACCEPTANCE CRITERIA:\n${criteriaText}\n\nBUILDER REPORTS (claims, not evidence):\n${implementation}`,
        }),
      // Adversarially verify each finding from a different lens than produced it.
      (result, lens) =>
        result?.findings?.length
          ? parallel(
              result.findings.map(f => async () => {
                const v = await runAgent({
                  name: 'code-reviewer',
                  effort: 'low',
                  cwd,
                  schema: REFUTE_SCHEMA,
                  task: `Try to REFUTE this finding. Default to refuted=true if you cannot substantiate it from actual evidence.\n\n${where}\n\nFINDING (${f.severity}): ${f.summary}\nEVIDENCE CLAIMED: ${f.evidence}\n\nCriteria for context:\n${criteriaText}`,
                })
                return { ...f, lens: lens.key, refuted: v?.refuted !== false, why: v?.reasoning }
              }),
            )
          : [],
    )

    const allFindings = verified.flat().filter(Boolean)
    const confirmed = allFindings.filter(f => !f.refuted)
    const refuted = allFindings.filter(f => f.refuted)
    log(`${confirmed.length} findings survived cross-check, ${refuted.length} refuted`)

    // ---- Phase 5 — Readiness. Recommendation only. No deploy authority. ----
    phase('Readiness')
    const [readiness, docs] = await parallel([
      () =>
        runAgent({
          name: 'release-manager',
          cwd,
          task: `Assess release readiness from this evidence. Classify each gate Confirmed / Claimed-not-verified / Missing / N-A — do not upgrade a claim to Confirmed because it sounds reasonable.

Produce a RECOMMENDATION for human confirmation. You do not hold deploy authority and this workflow cannot grant it.

If this is an unattended run, load the autonomy-policy skill and reproduce every BLOCKED gate entry from the evidence below verbatim in your output, each with what was prepared so a human can execute it in one step. Do not drop a blocked gate because the recommendation is otherwise a Go.

CONFIRMED FINDINGS:\n${JSON.stringify(confirmed, null, 2)}

OPEN ASSUMPTIONS / QUESTIONS FROM REQUIREMENTS:\n${[...reqs.assumptions, ...reqs.openQuestions].join('\n') || '(none)'}`,
        }),
      () =>
        runAgent({
          name: 'technical-writer',
          cwd,
          task: `Draft the user-facing documentation and release notes for this change. Verify every behavioral claim against the actual implementation, not the requirement text — label anything you could not verify as Unverified rather than asserting or omitting it.

${where}\n\nCRITERIA:\n${criteriaText}\n\nBUILDER REPORTS (claims, not evidence):\n${implementation}`,
        }),
    ])

    return { confirmed, refuted, readiness, docs }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
