export const meta = {
  name: 'sdlc-feature',
  description: 'Run a feature end-to-end through the SDLC agent suite: requirements, design, build, independent verification, release readiness',
  whenToUse: 'A feature or change large enough to warrant the full lifecycle. Pass the initiative description as args. Produces recommendations only — never deploys.',
  phases: [
    { title: 'Requirements', detail: 'product-analyst converts the initiative into numbered acceptance criteria' },
    { title: 'Design', detail: 'ux-designer and solution-architect in parallel' },
    { title: 'Build', detail: 'software-engineer / ui-engineer / database-engineer as the change requires' },
    { title: 'Verify', detail: 'code-reviewer, qa-engineer, security-engineer, performance-engineer independently' },
    { title: 'Cross-check', detail: 'every finding handed to a refuter before it is reported' },
    { title: 'Readiness', detail: 'release-manager synthesizes gates; technical-writer drafts docs' },
  ],
}

// ---------------------------------------------------------------------------
// The initiative under development. Pass a string or {initiative, paths} object.
// ---------------------------------------------------------------------------
const initiative =
  typeof args === 'string' ? args : args?.initiative ?? 'No initiative supplied — report this and stop.'

const CRITERIA_SCHEMA = {
  type: 'object',
  required: ['criteria', 'assumptions', 'openQuestions', 'surfaces'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    // Which implementation surfaces the change actually touches. Drives Build fan-out.
    surfaces: {
      type: 'array',
      items: { type: 'string', enum: ['backend', 'frontend', 'data'] },
    },
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

// ---------------------------------------------------------------------------
// Phase 1 — Requirements. Everything downstream traces to these IDs.
// ---------------------------------------------------------------------------
phase('Requirements')
const reqs = await agent(
  `Convert this initiative into implementation-ready requirements: ${initiative}

Produce numbered, stable acceptance-criterion IDs — every downstream agent in this workflow traces against them, so an unstable ID breaks the whole run. Record assumptions as numbered/traceable/risk-rated per your §4. Do not invent a success metric that wasn't given; label any proposal as proposed-not-confirmed.

Also classify which implementation surfaces this genuinely touches (backend / frontend / data) so the build phase only spawns the specialists actually needed.`,
  { agentType: 'sdlc-suite:product-analyst', label: 'requirements', schema: CRITERIA_SCHEMA },
)

if (!reqs || !reqs.criteria?.length) {
  return {
    status: 'stopped',
    reason: 'product-analyst produced no acceptance criteria. Nothing downstream can trace against anything — this is a stop condition, not a reason to proceed on inference.',
    openQuestions: reqs?.openQuestions ?? [],
  }
}

const criteriaText = reqs.criteria.map(c => `${c.id}: ${c.text}`).join('\n')
log(`${reqs.criteria.length} acceptance criteria; surfaces: ${reqs.surfaces.join(', ') || 'none classified'}`)

// ---------------------------------------------------------------------------
// Phase 2 — Design. UX and architecture are genuinely independent inputs, and
// both must land before build starts, so this is a legitimate barrier.
// ---------------------------------------------------------------------------
phase('Design')
const needsUx = reqs.surfaces.includes('frontend')
const designs = await parallel(
  [
    needsUx &&
      (() =>
        agent(
          `Produce the UX specification for these requirements:\n${criteriaText}\n\nSpecify every interactive state — initial, loading, empty, success, error, permission-denied, degraded. State accessibility requirements as checkable targets (a WCAG level, a contrast ratio, a touch-target size), not aspirations; ui-engineer owns turning them into measured values. Flag any gap back rather than inventing behavior.`,
          { agentType: 'sdlc-suite:ux-designer', label: 'ux-spec', phase: 'Design' },
        )),
    () =>
      agent(
        `Assess the architecture for these requirements:\n${criteriaText}\n\nDecide the tier per your §2 — if this is Tier 1, say so and keep it short rather than manufacturing an ADR. Define NFRs as measurable numbers, never "scalable" or "fast". Flag anything that constrains the UX so it can be reconciled before build rather than mid-implementation.`,
        { agentType: 'sdlc-suite:solution-architect', label: 'architecture', phase: 'Design' },
      ),
  ].filter(Boolean),
)

const uxSpec = needsUx ? designs[0] : null
const architecture = needsUx ? designs[1] : designs[0]

// ---------------------------------------------------------------------------
// Phase 3 — Build. One specialist per surface actually touched.
// ---------------------------------------------------------------------------
phase('Build')
const BUILDERS = {
  backend: {
    agentType: 'sdlc-suite:software-engineer',
    brief: 'Implement the backend/application changes. Stay inside scope — collect anything else you notice as "noticed but didn\'t touch".',
  },
  frontend: {
    agentType: 'sdlc-suite:ui-engineer',
    brief: `Implement the frontend against the UX specification, state-for-state. Do not invent a state the spec omitted — flag the gap.\n\nUX SPEC:\n${uxSpec ?? '(none produced)'}`,
  },
  data: {
    agentType: 'sdlc-suite:database-engineer',
    brief: 'Design and implement the schema/migration in Build mode. Rollback design is yours; rollback *rehearsal* is qa-engineer\'s to execute independently — hand it off as a hypothesis, not a confirmed result.',
  },
}

const built = await parallel(
  reqs.surfaces
    .filter(s => BUILDERS[s])
    .map(surface => () =>
      agent(
        `${BUILDERS[surface].brief}\n\nACCEPTANCE CRITERIA (trace to these IDs):\n${criteriaText}\n\nARCHITECTURE CONTEXT:\n${architecture ?? '(none)'}\n\nReport honestly per your reporting section: distinguish verified / believed / assumed, and name any criterion you did not address.`,
        { agentType: BUILDERS[surface].agentType, label: `build:${surface}`, phase: 'Build', isolation: 'worktree' },
      ),
    ),
)

const implementation = built.filter(Boolean).join('\n\n---\n\n')
if (!implementation) {
  return { status: 'stopped', reason: 'No build surface produced an implementation.', requirements: reqs }
}

// ---------------------------------------------------------------------------
// Phase 4 — Verify. Four independent evidentiary bases on the same change.
// Deliberately NOT a barrier per lens: each lens pipelines straight into its
// own adversarial check, so a slow lens doesn't hold up a fast one.
// ---------------------------------------------------------------------------
phase('Verify')
const LENSES = [
  {
    key: 'review',
    agentType: 'sdlc-suite:code-reviewer',
    brief: 'Review by reading. Form your independent expectation from the criteria BEFORE reading the diff (your §4 contamination guard), then state if it changed. Never inherit the implementer\'s self-report.',
  },
  {
    key: 'qa',
    agentType: 'sdlc-suite:qa-engineer',
    brief: 'Verify by executing. Re-run any claimed verification yourself — a "tests pass" report is a hypothesis until you run it this session. Label every claim Verified / Falsified / Unverified / Untestable, and include the "what was NOT tested" section.',
  },
  {
    key: 'security',
    agentType: 'sdlc-suite:security-engineer',
    brief: 'Review mode — findings and direction, no rewrites. Classify Critical/High/Medium/Low/Informational. No finding without a plausible attack path; no security theater.',
  },
  {
    key: 'performance',
    agentType: 'sdlc-suite:performance-engineer',
    brief: 'Trace the target BEFORE measuring current behavior (your §3). If no target exists, say so and propose one labeled proposed-not-confirmed. No claim without a number.',
  },
]

const verified = await pipeline(
  LENSES,
  lens =>
    agent(
      `${lens.brief}\n\nACCEPTANCE CRITERIA:\n${criteriaText}\n\nIMPLEMENTATION UNDER REVIEW:\n${implementation}`,
      { agentType: lens.agentType, label: `verify:${lens.key}`, phase: 'Verify', schema: FINDINGS_SCHEMA },
    ),
  // Adversarially verify each finding from a different lens than produced it.
  (result, lens) =>
    result?.findings?.length
      ? parallel(
          result.findings.map(f => () =>
            agent(
              `Try to REFUTE this finding. Default to refuted=true if you cannot substantiate it from actual evidence.\n\nFINDING (${f.severity}): ${f.summary}\nEVIDENCE CLAIMED: ${f.evidence}\n\nCriteria for context:\n${criteriaText}`,
              {
                agentType: 'sdlc-suite:code-reviewer',
                label: `refute:${lens.key}`,
                phase: 'Cross-check',
                effort: 'low',
                schema: {
                  type: 'object',
                  required: ['refuted', 'reasoning'],
                  properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
                },
              },
            ).then(v => ({ ...f, lens: lens.key, refuted: v?.refuted !== false, why: v?.reasoning })),
          ),
        )
      : [],
)

const allFindings = verified.flat().filter(Boolean)
const confirmed = allFindings.filter(f => !f.refuted)
const refuted = allFindings.filter(f => f.refuted)
log(`${confirmed.length} findings survived cross-check, ${refuted.length} refuted`)

// ---------------------------------------------------------------------------
// Phase 5 — Readiness. Recommendation only. This workflow has no deploy authority.
// ---------------------------------------------------------------------------
phase('Readiness')
const [readiness, docs] = await parallel([
  () =>
    agent(
      `Assess release readiness from this evidence. Classify each gate Confirmed / Claimed-not-verified / Missing / N-A — do not upgrade a claim to Confirmed because it sounds reasonable.

Produce a RECOMMENDATION for human confirmation. You do not hold deploy authority and this workflow cannot grant it.

If this is an unattended run, load \`sdlc-suite:autonomy-policy\` and reproduce every BLOCKED gate entry from the evidence below verbatim in your output, each with what was prepared so a human can execute it in one step. Do not drop a blocked gate because the recommendation is otherwise a Go.

CONFIRMED FINDINGS:\n${JSON.stringify(confirmed, null, 2)}

OPEN ASSUMPTIONS / QUESTIONS FROM REQUIREMENTS:\n${[...reqs.assumptions, ...reqs.openQuestions].join('\n') || '(none)'}`,
      { agentType: 'sdlc-suite:release-manager', label: 'readiness', phase: 'Readiness' },
    ),
  () =>
    agent(
      `Draft the user-facing documentation and release notes for this change. Verify every behavioral claim against the actual implementation, not the requirement text — label anything you could not verify as Unverified rather than asserting or omitting it.

CRITERIA:\n${criteriaText}\n\nIMPLEMENTATION:\n${implementation}`,
      { agentType: 'sdlc-suite:technical-writer', label: 'docs', phase: 'Readiness' },
    ),
])

return {
  initiative,
  requirements: reqs,
  design: { ux: uxSpec, architecture },
  surfacesBuilt: reqs.surfaces,
  findings: { confirmed, refutedCount: refuted.length },
  readinessRecommendation: readiness,
  documentation: docs,
  humanDecisionRequired: [
    'Release go/no-go — release-manager recommends, it never commits.',
    ...reqs.openQuestions,
  ],
  // Unattended runs defer gates rather than halting (see the autonomy-policy skill).
  // Every BLOCKED entry any agent emitted must survive to this top level — a blocked
  // gate that vanishes because the rest of the run looked clean is a reporting failure.
  blockedGates:
    'Collect every "BLOCKED — <gate>" entry from the phase outputs above. Empty means no gate was hit, not that gates were skipped.',
}
