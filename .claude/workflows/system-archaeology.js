export const meta = {
  name: 'system-archaeology',
  description: 'Reverse-engineer an undocumented system: derive who uses it and what it does from code evidence in parallel, cross-check the two, and synthesize an as-built PRD',
  whenToUse: 'Planning a rebuild or replatform of a system with no reliable documentation, or onboarding onto one. Produces evidence, never a recommendation about what to change.',
  phases: [
    { title: 'Detect', detail: 'establish stack and scope before reading anything domain-specific' },
    { title: 'Excavate', detail: 'persona-discovery (who) and product-archaeologist (what) in parallel' },
    { title: 'Cross-check', detail: 'capability/persona and requirement/implementation mismatches' },
    { title: 'Synthesize', detail: 'as-built PRD, then a downstream handoff brief' },
  ],
}

const scope = typeof args === 'string' ? args : args?.scope ?? 'the whole application'
// Dynamic observation is opt-in and must name a non-production target. Absent
// one, this runs static-only and says so — it never guesses at a safe target.
const observeTarget = args?.observeTarget ?? null

phase('Detect')
const stack = await agent(
  `Detect the stack for ${scope}: language, framework, auth mechanism, data layer, API style, test tooling, deployment shape. Read manifests, lockfiles, and config — do not infer from the repo name or directory layout.

Record what you found AND what you could not determine. If the auth mechanism cannot be located, say so explicitly: both downstream agents treat that as a stop condition.`,
  { agentType: 'product-archaeologist', label: 'detect-stack', schema: {
      type: 'object',
      required: ['determined', 'undetermined', 'authLocated'],
      properties: {
        determined: { type: 'object', additionalProperties: true },
        undetermined: { type: 'array', items: { type: 'string' } },
        authLocated: { type: 'boolean' },
      },
    } },
)

if (!stack) {
  return { status: 'stopped', reason: 'Stack detection produced no result — nothing downstream can proceed on evidence.' }
}
if (stack.authLocated === false) {
  return {
    status: 'stopped',
    reason: 'Auth mechanism could not be located. This is persona-discovery\'s explicit stop condition, and it also undermines product-archaeologist\'s permission-rule extraction. Stopping rather than producing a roster and capability map that both rest on a guess.',
    stack,
  }
}
log(`stack detected; ${stack.undetermined.length} aspects undetermined`)

// ---------------------------------------------------------------------------
// Excavate. The two archaeology agents answer different questions from the same
// codebase and are genuinely independent — running them in parallel is not just
// faster, it keeps each from anchoring on the other's framing.
// ---------------------------------------------------------------------------
phase('Excavate')
const [personas, asBuilt] = await parallel([
  () =>
    agent(
      `Derive the end-user personas this application actually implements, for ${scope}.

Every persona needs path:line provenance; two independent source types before confirmed; never self-promote a candidate. Derive the capability envelope from authorization code, not from role names. Ambiguous entries are your highest-value output — do not empty that list by guessing.

Stack context: ${JSON.stringify(stack.determined)}`,
      { agentType: 'persona-discovery', label: 'who', phase: 'Excavate' },
    ),
  () =>
    agent(
      `Extract what this application actually does, for ${scope}: capability inventory, business rules, data model, integration surface, non-functional baseline, and gap/pain-point evidence.

Every claim needs a citation. Assign confirmed/candidate/rejected per item and never silently promote. Flag any rule that looks like an off-by-one or an inconsistency as a POSSIBLE DEFECT rather than asserting it as deliberate design.

${observeTarget
  ? `Dynamic observation is permitted against this NON-PRODUCTION target only: ${observeTarget}. Read-only and non-mutating exclusively — no migrations, no datastore writes, no state-changing calls. Cite what you ran, where, and what you saw. If that target resolves to production, stop.`
  : `NO observation target was supplied, so this is STATIC EVIDENCE ONLY. Do not start the application or run its suite against an unknown target. State this coverage limitation plainly in your output rather than under-covering behavioral confirmation silently.`}

Do NOT recommend what a better version should be. Describe what exists.

Stack context: ${JSON.stringify(stack.determined)}`,
      { agentType: 'product-archaeologist', label: 'what', phase: 'Excavate' },
    ),
])

if (!asBuilt) {
  return { status: 'stopped', reason: 'Capability extraction produced no result.', stack, personas }
}

// ---------------------------------------------------------------------------
// Cross-check. Genuine barrier: the mismatch analysis needs BOTH the roster and
// the capability inventory in hand, plus any existing product-analyst requirements.
// ---------------------------------------------------------------------------
phase('Cross-check')
const mismatches = await agent(
  `Cross-check these two independently-derived evidence sets, plus any existing requirements under .claude/memory/<project>/requirements/.

Report four mismatch classes as FINDINGS. Do not silently reconcile any of them — a disagreement between what the code implements and what was ever specified is the single most valuable output of this run:
1. A capability no persona can reach (orphaned, admin-only, or dead).
2. A persona whose jobs-to-be-done have no corresponding capability.
3. An implemented capability with no product requirement.
4. A requirement with no implementation trace.

Also list every capability still at candidate status. If more than roughly half are candidates, say so plainly — that means the evidence sources are too sparse to trust the picture, and it is product-archaeologist's own stop condition.

PERSONAS (who):
${personas ?? '(persona-discovery produced no roster — treat every capability as unmapped and say so)'}

AS-BUILT (what):
${asBuilt}`,
  { agentType: 'product-archaeologist', label: 'cross-check', phase: 'Cross-check' },
)

// ---------------------------------------------------------------------------
// Synthesize. PRD first, then a handoff brief that stays strictly non-prescriptive.
// ---------------------------------------------------------------------------
phase('Synthesize')
const prd = await agent(
  `Synthesize the as-built PRD per prd-synthesis's nine-section structure and write it to .claude/discovery/prd.md, with the citation appendix at .claude/discovery/evidence-matrix.md.

The one rule: this describes what EXISTS. Not one sentence about what should change. If a reader can't tell whether a sentence is a discovered fact or your preference, rewrite it.

Section 8, "what could not be determined", is mandatory and must include: ${stack.undetermined.join(', ') || 'nothing from stack detection'}${observeTarget ? '' : ', plus the fact that NO dynamic observation was performed at all'}.

AS-BUILT EVIDENCE:
${asBuilt}

CROSS-CHECK FINDINGS:
${mismatches ?? '(none produced)'}

PERSONAS:
${personas ?? '(none)'}`,
  { agentType: 'product-archaeologist', label: 'prd', phase: 'Synthesize' },
)

const handoff = await agent(
  `Read the as-built PRD below and write a short handoff brief naming what each downstream agent most needs from it, and what remains an OPEN QUESTION for them rather than an answer.

Address: product-manager (what's worth carrying forward), product-analyst (what becomes new numbered requirements), solution-architect (what data-model and debt reality a rebuild must reckon with), ux-designer (which discovered interaction patterns to weigh keeping).

Critically: frame every item as a question or an input, never as a recommendation. You are equipping their decision, not making it. Any possible-defect flags belong to qa-engineer as hypotheses to verify, not as confirmed bugs.

PRD:
${prd}`,
  { agentType: 'product-archaeologist', label: 'handoff', phase: 'Synthesize' },
)

return {
  scope,
  observationMode: observeTarget ? `dynamic (non-production: ${observeTarget})` : 'static evidence only',
  stackUndetermined: stack.undetermined,
  personas,
  asBuiltPrd: prd,
  crossCheckFindings: mismatches,
  downstreamHandoff: handoff,
  writtenTo: ['.claude/discovery/prd.md', '.claude/discovery/evidence-matrix.md'],
  note:
    'EVIDENCE ONLY. This workflow deliberately produces no recommendation about what a rebuild should keep, cut, or improve — that is product-manager, product-analyst, solution-architect, and ux-designer, downstream, with a human confirming prioritization.',
}
