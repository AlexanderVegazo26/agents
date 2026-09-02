#!/usr/bin/env python3
"""Reverse-engineer an undocumented system.

Equivalent to .claude/workflows/system-archaeology.js.
"""

from __future__ import annotations

import argparse
import json
import sys

from runner import (
    AgentResult,
    agent,
    extract_json,
    format_findings,
    log,
    parallel,
    phase,
    write_file,
)


STACK_SCHEMA_HINT = """
Return a JSON object with:
- determined: object with stack details
- undetermined: array of strings
- authLocated: boolean
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="System archaeology workflow")
    parser.add_argument("scope", nargs="?", default="the whole application", help="Scope to analyze")
    parser.add_argument("--observe-target", help="Non-production observation target")
    parser.add_argument("--timeout", type=int, default=3600, help="Agent timeout in seconds")
    args = parser.parse_args()

    scope = args.scope
    observe_target = args.observe_target
    timeout = args.timeout

    # ---------------------------------------------------------------------------
    # Phase 1 — Detect
    # ---------------------------------------------------------------------------
    phase("Detect")

    stack_result = agent(
        f"""Detect the stack for {scope}: language, framework, auth mechanism, data layer, API style, test tooling, deployment shape. Read manifests, lockfiles, and config — do not infer from the repo name or directory layout.\n\nRecord what you found AND what you could not determine. If the auth mechanism cannot be located, say so explicitly: both downstream agents treat that as a stop condition.\n\n{STACK_SCHEMA_HINT}""",
        "product-archaeologist",
        "detect-stack",
        timeout,
    )

    if not stack_result.success:
        log(f"Stack detection failed: {stack_result.error}")
        print(json.dumps({"status": "stopped", "reason": "Stack detection produced no result."}, indent=2))
        return 1

    stack = extract_json(stack_result.output)
    if not stack:
        log("Stack detection produced no structured result")
        print(json.dumps({"status": "stopped", "reason": "Stack detection produced no structured result."}, indent=2))
        return 1

    if stack.get("authLocated") is False:
        print(json.dumps({
            "status": "stopped",
            "reason": "Auth mechanism could not be located. This is persona-discovery's explicit stop condition, and it also undermines product-archaeologist's permission-rule extraction. Stopping rather than producing a roster and capability map that both rest on a guess.",
            "stack": stack,
        }, indent=2))
        return 1

    log(f"stack detected; {len(stack.get('undetermined', []))} aspects undetermined")

    # ---------------------------------------------------------------------------
    # Phase 2 — Excavate
    # ---------------------------------------------------------------------------
    phase("Excavate")

    excavate_tasks = [
        lambda: agent(
            f"""Derive the end-user personas this application actually implements, for {scope}.\n\nEvery persona needs path:line provenance; two independent source types before confirmed; never self-promote a candidate. Derive the capability envelope from authorization code, not from role names. Ambiguous entries are your highest-value output — do not empty that list by guessing.\n\nStack context: {json.dumps(stack.get('determined', {}))}""",
            "persona-discovery",
            "who",
            timeout,
        ),
        lambda: agent(
            f"""Extract what this application actually does, for {scope}: capability inventory, business rules, data model, integration surface, non-functional baseline, and gap/pain-point evidence.\n\nEvery claim needs a citation. Assign confirmed/candidate/rejected per item and never silently promote. Flag any rule that looks like an off-by-one or an inconsistency as a POSSIBLE DEFECT rather than asserting it as deliberate design.\n\n{f'Dynamic observation is permitted against this NON-PRODUCTION target only: {observe_target}. Read-only and non-mutating exclusively — no migrations, no datastore writes, no state-changing calls. Cite what you ran, where, and what you saw. If that target resolves to production, stop.' if observe_target else 'NO observation target was supplied, so this is STATIC EVIDENCE ONLY. Do not start the application or run its suite against an unknown target. State this coverage limitation plainly in your output rather than under-covering behavioral confirmation silently.'}\n\nDo NOT recommend what a better version should be. Describe what exists.\n\nStack context: {json.dumps(stack.get('determined', {}))}""",
            "product-archaeologist",
            "what",
            timeout,
        ),
    ]

    excavate_results = parallel(excavate_tasks)
    personas = excavate_results[0].output if excavate_results[0].success else None
    as_built = excavate_results[1].output if excavate_results[1].success else None

    if not as_built:
        log("Capability extraction produced no result")
        print(json.dumps({
            "status": "stopped",
            "reason": "Capability extraction produced no result.",
            "stack": stack,
            "personas": personas,
        }, indent=2))
        return 1

    # ---------------------------------------------------------------------------
    # Phase 3 — Cross-check
    # ---------------------------------------------------------------------------
    phase("Cross-check")

    mismatches_result = agent(
        f"""Cross-check these two independently-derived evidence sets, plus any existing requirements under .claude/memory/<project>/requirements/.\n\nReport four mismatch classes as FINDINGS. Do not silently reconcile any of them — a disagreement between what the code implements and what was ever specified is the single most valuable output of this run:\n1. A capability no persona can reach (orphaned, admin-only, or dead).\n2. A persona whose jobs-to-be-done have no corresponding capability.\n3. An implemented capability with no product requirement.\n4. A requirement with no implementation trace.\n\nAlso list every capability still at candidate status. If more than roughly half are candidates, say so plainly — that means the evidence sources are too sparse to trust the picture, and it is product-archaeologist's own stop condition.\n\nPERSONAS (who):\n{personas or '(persona-discovery produced no roster — treat every capability as unmapped and say so)'}\n\nAS-BUILT (what):\n{as_built}""",
        "product-archaeologist",
        "cross-check",
        timeout,
    )

    mismatches = mismatches_result.output if mismatches_result.success else None

    # ---------------------------------------------------------------------------
    # Phase 4 — Synthesize
    # ---------------------------------------------------------------------------
    phase("Synthesize")

    prd_result = agent(
        f"""Synthesize the as-built PRD per prd-synthesis's nine-section structure and write it to .claude/discovery/prd.md, with the citation appendix at .claude/discovery/evidence-matrix.md.\n\nThe one rule: this describes what EXISTS. Not one sentence about what should change. If a reader can't tell whether a sentence is a discovered fact or your preference, rewrite it.\n\nSection 8, \"what could not be determined\", is mandatory and must include: {', '.join(stack.get('undetermined', [])) or 'nothing from stack detection'}{'' if observe_target else ', plus the fact that NO dynamic observation was performed at all'}.\n\nAS-BUILT EVIDENCE:\n{as_built}\n\nCROSS-CHECK FINDINGS:\n{mismatches or '(none produced)'}\n\nPERSONAS:\n{personas or '(none)'}""",
        "product-archaeologist",
        "prd",
        timeout,
    )

    prd = prd_result.output if prd_result.success else ""

    handoff_result = agent(
        f"""Read the as-built PRD below and write a short handoff brief naming what each downstream agent most needs from it, and what remains an OPEN QUESTION for them rather than an answer.\n\nAddress: product-manager (what's worth carrying forward), product-analyst (what becomes new numbered requirements), solution-architect (what data-model and debt reality a rebuild must reckon with), ux-designer (which discovered interaction patterns to weigh keeping).\n\nCritically: frame every item as a question or an input, never as a recommendation. You are equipping their decision, not making it. Any possible-defect flags belong to qa-engineer as hypotheses to verify, not as confirmed bugs.\n\nPRD:\n{prd}""",
        "product-archaeologist",
        "handoff",
        timeout,
    )

    handoff = handoff_result.output if handoff_result.success else ""

    output = {
        "scope": scope,
        "observationMode": f"dynamic (non-production: {observe_target})" if observe_target else "static evidence only",
        "stackUndetermined": stack.get("undetermined", []),
        "personas": personas,
        "asBuiltPrd": prd,
        "crossCheckFindings": mismatches,
        "downstreamHandoff": handoff,
        # NOT a list of files that exist. It is what the PRD agent was ASKED to
        # write, reported as an unverified claim rather than as an observation.
        #
        # This field used to be a hardcoded list literal, unconditioned on
        # anything: a positive assertion that two artifacts had been produced,
        # emitted identically whether or not they had. That is the "artifacts
        # over assertions" failure the routing policy names.
        #
        # The canonical sdlc-suite/workflows/system-archaeology.js now checks the
        # filesystem and reports observed paths plus claimedNotFound. This port
        # does not carry that wiring yet, so it states the weaker true thing
        # instead of the stronger false one.
        "writtenToVerified": False,
        "writtenToClaimed": [".claude/discovery/prd.md", ".claude/discovery/evidence-matrix.md"],
        "writtenTo": [],
        "note": "EVIDENCE ONLY. This workflow deliberately produces no recommendation about what a rebuild should keep, cut, or improve — that is product-manager, product-analyst, solution-architect, and ux-designer, downstream, with a human confirming prioritization.",
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
