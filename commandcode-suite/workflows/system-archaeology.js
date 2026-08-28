#!/usr/bin/env node
'use strict'
/**
 * system-archaeology — reverse-engineer an undocumented system: derive who uses
 * it and what it does from code evidence in parallel, cross-check the two, and
 * synthesize an as-built PRD. Produces evidence, never a recommendation.
 *
 * Usage: node workflows/system-archaeology.js "the billing subsystem" [--observe-target http://localhost:8080]
 * Env:   CMDC_BIN, CMDC_MODEL, CMDC_AGENT_TIMEOUT_MS
 */
const { log, phase, runAgent, parallel } = require('./_runner')

function parseArgs(argv) {
  const out = { scope: 'the whole application', observeTarget: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--observe-target') out.observeTarget = argv[++i]
    else out.scope = argv.slice(i).join(' ')
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const scope = args.scope
// Dynamic observation is opt-in and must name a non-production target. Absent
// one, this runs static-only and says so — it never guesses at a safe target.
const observeTarget = args.observeTarget

const STACK_SCHEMA = {
  type: 'object',
  required: ['determined', 'undetermined', 'authLocated'],
  properties: {
    determined: { type: 'object', additionalProperties: true },
    undetermined: { type: 'array', items: { type: 'string' } },
    authLocated: { type: 'boolean' },
  },
}

async function main() {
  log(`scope: ${scope}`)

  // ---- Phase 1 — Detect. Establish stack and scope before reading anything
  // domain-specific. ----
  phase('Detect')
  const stack = await runAgent({
    name: 'product-archaeologist',
    schema: STACK_SCHEMA,
    task: `Detect the stack for ${scope}: language, framework, auth mechanism, data layer, API style, test tooling, deployment shape. Read manifests, lockfiles, and config — do not infer from the repo name or directory layout.

Record what you found AND what you could not determine. If the auth mechanism cannot be located, say so explicitly: both downstream agents treat that as a stop condition.`,
  })

  if (!stack) {
    console.log(JSON.stringify({ status: 'stopped', reason: 'Stack detection produced no result — nothing downstream can proceed on evidence.' }, null, 2))
    return
  }
  if (stack.authLocated === false) {
    console.log(JSON.stringify({
      status: 'stopped',
      reason: 'Auth mechanism could not be located. This is persona-discovery\'s explicit stop condition, and it also undermines product-archaeologist\'s permission-rule extraction. Stopping rather than producing a roster and capability map that both rest on a guess.',
      stack,
    }, null, 2))
    return
  }
  log(`stack detected; ${stack.undetermined.length} aspects undetermined`)

  // ---- Phase 2 — Excavate. The two archaeology agents answer different
  // questions from the same codebase and are genuinely independent — running
  // them in parallel is not just faster, it keeps each from anchoring on the
  // other's framing. ----
  phase('Excavate')
  const [personas, asBuilt] = await parallel([
    () =>
      runAgent({
        name: 'persona-discovery',
        task: `Derive the end-user personas this application actually implements, for ${scope}.

Every persona needs path:line provenance; two independent source types before confirmed; never self-promote a candidate. Derive the capability envelope from authorization code, not from role names. Ambiguous entries are your highest-value output — do not empty that list by guessing.

Stack context: ${JSON.stringify(stack.determined)}`,
      }),
    () =>
      runAgent({
        name: 'product-archaeologist',
        task: `Extract what this application actually does, for ${scope}: capability inventory, business rules, data model, integration surface, non-functional baseline, and gap/pain-point evidence.

Every claim needs a citation. Assign confirmed/candidate/rejected per item and never silently promote. Flag any rule that looks like an off-by-one or an inconsistency as a POSSIBLE DEFECT rather than asserting it as deliberate design.

${observeTarget
  ? `Dynamic observation is permitted against this NON-PRODUCTION target only: ${observeTarget}. Read-only and non-mutating exclusively — no migrations, no datastore writes, no state-changing calls. Cite what you ran, where, and what you saw. If that target resolves to production, stop.`
  : `NO observation target was supplied, so this is STATIC EVIDENCE ONLY. Do not start the application or run its suite against an unknown target. State this coverage limitation plainly in your output rather than under-covering behavioral confirmation silently.`}

Do NOT recommend what a better version should be. Describe what exists.

Stack context: ${JSON.stringify(stack.determined)}`,
      }),
  ])

  if (!asBuilt) {
    console.log(JSON.stringify({ status: 'stopped', reason: 'Capability extraction produced no result.', stack, personas }, null, 2))
    return
  }

  // ---- Phase 3 — Cross-check. Genuine barrier: the mismatch analysis needs
  // BOTH the roster and the capability inventory in hand. ----
  phase('Cross-check')
  const mismatches = await runAgent({
    name: 'product-archaeologist',
    task: `Cross-check these two independently-derived evidence sets, plus any existing requirements under .claude/memory/<project>/requirements/.

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
  })

  // ---- Phase 4 — Synthesize. PRD first, then a handoff brief that stays
  // strictly non-prescriptive. ----
  phase('Synthesize')
  const prd = await runAgent({
    name: 'product-archaeologist',
    task: `Synthesize the as-built PRD per prd-synthesis's nine-section structure and write it to .claude/discovery/prd.md, with the citation appendix at .claude/discovery/evidence-matrix.md.

The one rule: this describes what EXISTS. Not one sentence about what should change. If a reader can't tell whether a sentence is a discovered fact or your preference, rewrite it.

Section 8, "what could not be determined", is mandatory and must include: ${stack.undetermined.join(', ') || 'nothing from stack detection'}${observeTarget ? '' : ', plus the fact that NO dynamic observation was performed at all'}.

AS-BUILT EVIDENCE:
${asBuilt}

CROSS-CHECK FINDINGS:
${mismatches ?? '(none produced)'}

PERSONAS:
${personas ?? '(none)'}`,
  })

  const handoff = await runAgent({
    name: 'product-archaeologist',
    task: `Read the as-built PRD below and write a short handoff brief naming what each downstream agent most needs from it, and what remains an OPEN QUESTION for them rather than an answer.

Address: product-manager (what's worth carrying forward), product-analyst (what becomes new numbered requirements), solution-architect (what data-model and debt reality a rebuild must reckon with), ux-designer (which discovered interaction patterns to weigh keeping).

Critically: frame every item as a question or an input, never as a recommendation. You are equipping their decision, not making it. Any possible-defect flags belong to qa-engineer as hypotheses to verify, not as confirmed bugs.

PRD:
${prd}`,
  })

  const report = {
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
  console.log(JSON.stringify(report, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
