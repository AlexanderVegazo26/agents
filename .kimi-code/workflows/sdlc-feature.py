#!/usr/bin/env python3
"""Run a feature end-to-end through the SDLC agent suite.

Equivalent to .claude/workflows/sdlc-feature.js.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from runner import (
    AgentResult,
    agent,
    extract_json,
    format_findings,
    log,
    parallel,
    phase,
)


CRITERIA_SCHEMA_HINT = """
Return a JSON object with:
- criteria: array of {id, text}
- assumptions: array of strings
- openQuestions: array of strings
- surfaces: array of "backend" | "frontend" | "data"
"""


FINDINGS_SCHEMA_HINT = """
Return a JSON object with:
- verdict: string
- findings: array of {severity, summary, evidence, file?, line?, needsExecution?}
"""


VERDICT_SCHEMA_HINT = """
Return a JSON object with:
- refuted: boolean
- reasoning: string
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="SDLC feature workflow")
    parser.add_argument("initiative", help="The initiative to build")
    parser.add_argument("--timeout", type=int, default=3600, help="Agent timeout in seconds")
    args = parser.parse_args()

    initiative = args.initiative
    timeout = args.timeout

    # ---------------------------------------------------------------------------
    # Phase 1 — Requirements
    # ---------------------------------------------------------------------------
    phase("Requirements")
    reqs_result = agent(
        f"""Convert this initiative into implementation-ready requirements: {initiative}

Produce numbered, stable acceptance-criterion IDs — every downstream agent in this workflow traces against them, so an unstable ID breaks the whole run. Record assumptions as numbered/traceable/risk-rated per your §4. Do not invent a success metric that wasn't given; label any proposal as proposed-not-confirmed.

Also classify which implementation surfaces this genuinely touches (backend / frontend / data) so the build phase only spawns the specialists actually needed.

{CRITERIA_SCHEMA_HINT}""",
        "product-analyst",
        "requirements",
        timeout,
    )

    if not reqs_result.success:
        log(f"product-analyst failed: {reqs_result.error}")
        return 1

    reqs = extract_json(reqs_result.output)
    if not reqs or not reqs.get("criteria"):
        log("product-analyst produced no acceptance criteria")
        print(json.dumps({
            "status": "stopped",
            "reason": "product-analyst produced no acceptance criteria",
            "openQuestions": reqs.get("openQuestions", []) if reqs else [],
        }, indent=2))
        return 1

    criteria = reqs["criteria"]
    assumptions = reqs.get("assumptions", [])
    open_questions = reqs.get("openQuestions", [])
    surfaces = reqs.get("surfaces", [])

    criteria_text = "\n".join(f"{c['id']}: {c['text']}" for c in criteria)
    log(f"{len(criteria)} acceptance criteria; surfaces: {', '.join(surfaces) or 'none classified'}")

    # ---------------------------------------------------------------------------
    # Phase 2 — Design
    # ---------------------------------------------------------------------------
    phase("Design")
    needs_ux = "frontend" in surfaces

    design_tasks = []
    if needs_ux:
        design_tasks.append(lambda: agent(
            f"""Produce the UX specification for these requirements:\n{criteria_text}\n\nSpecify every interactive state — initial, loading, empty, success, error, permission-denied, degraded. State accessibility requirements as checkable targets (a WCAG level, a contrast ratio, a touch-target size), not aspirations; ui-engineer owns turning them into measured values. Flag any gap back rather than inventing behavior.""",
            "ux-designer",
            "ux-spec",
            timeout,
        ))

    design_tasks.append(lambda: agent(
        f"""Assess the architecture for these requirements:\n{criteria_text}\n\nDecide the tier per your §2 — if this is Tier 1, say so and keep it short rather than manufacturing an ADR. Define NFRs as measurable numbers, never "scalable" or "fast". Flag anything that constrains the UX so it can be reconciled before build rather than mid-implementation.""",
        "solution-architect",
        "architecture",
        timeout,
    ))

    design_results = parallel(design_tasks)
    ux_spec = design_results[0].output if needs_ux and design_results[0].success else None
    architecture = design_results[-1].output if design_results[-1].success else None

    # ---------------------------------------------------------------------------
    # Phase 3 — Build
    # ---------------------------------------------------------------------------
    phase("Build")

    BUILDERS = {
        "backend": ("software-engineer", "Implement the backend/application changes. Stay inside scope — collect anything else you notice as \"noticed but didn't touch\"."),
        "frontend": ("ui-engineer", f"Implement the frontend against the UX specification, state-for-state. Do not invent a state the spec omitted — flag the gap.\n\nUX SPEC:\n{ux_spec or '(none produced)'}"),
        "data": ("database-engineer", "Design and implement the schema/migration in Build mode. Rollback design is yours; rollback *rehearsal* is qa-engineer's to execute independently — hand it off as a hypothesis, not a confirmed result."),
    }

    build_tasks = []
    for surface in surfaces:
        if surface not in BUILDERS:
            continue
        agent_name, brief = BUILDERS[surface]
        build_tasks.append(lambda s=surface, a=agent_name, b=brief: agent(
            f"{b}\n\nACCEPTANCE CRITERIA (trace to these IDs):\n{criteria_text}\n\nARCHITECTURE CONTEXT:\n{architecture or '(none)'}\n\nReport honestly per your reporting section: distinguish verified / believed / assumed, and name any criterion you did not address.",
            a,
            f"build:{s}",
            timeout,
        ))

    build_results = parallel(build_tasks)
    implementation = "\n\n---\n\n".join(r.output for r in build_results if r.success and r.output)

    if not implementation:
        log("No build surface produced an implementation")
        print(json.dumps({
            "status": "stopped",
            "reason": "No build surface produced an implementation",
            "requirements": reqs,
        }, indent=2))
        return 1

    # ---------------------------------------------------------------------------
    # Phase 4 — Verify
    # ---------------------------------------------------------------------------
    phase("Verify")

    LENSES = [
        ("review", "code-reviewer", "Review by reading. Form your independent expectation from the criteria BEFORE reading the diff (your §4 contamination guard), then state if it changed. Never inherit the implementer's self-report."),
        ("qa", "qa-engineer", "Verify by executing. Re-run any claimed verification yourself — a \"tests pass\" report is a hypothesis until you run it this session. Label every claim Verified / Falsified / Unverified / Untestable, and include the \"what was NOT tested\" section."),
        ("security", "security-engineer", "Review mode — findings and direction, no rewrites. Classify Critical/High/Medium/Low/Informational. No finding without a plausible attack path; no security theater."),
        ("performance", "performance-engineer", "Trace the target BEFORE measuring current behavior (your §3). If no target exists, say so and propose one labeled proposed-not-confirmed. No claim without a number."),
    ]

    verify_tasks = []
    for key, agent_name, brief in LENSES:
        verify_tasks.append(lambda k=key, a=agent_name, b=brief: agent(
            f"{b}\n\nACCEPTANCE CRITERIA:\n{criteria_text}\n\nIMPLEMENTATION UNDER REVIEW:\n{implementation}\n\n{FINDINGS_SCHEMA_HINT}",
            a,
            f"verify:{k}",
            timeout,
        ))

    verify_results = parallel(verify_tasks)

    # Cross-check each finding with a refuter from a different lens
    all_findings = []
    refute_tasks = []

    for result, (key, _, _) in zip(verify_results, LENSES):
        if not result.success:
            continue
        findings_data = extract_json(result.output)
        if not findings_data or not findings_data.get("findings"):
            continue
        for f in findings_data["findings"]:
            f["lens"] = key
            all_findings.append(f)
            refute_tasks.append(lambda f=f: agent(
                f"""Try to REFUTE this finding. Default to refuted=true if you cannot substantiate it from actual evidence.\n\nFINDING ({f.get('severity', 'unknown')}): {f.get('summary', '')}\nEVIDENCE CLAIMED: {f.get('evidence', '')}\n\nCriteria for context:\n{criteria_text}\n\n{VERDICT_SCHEMA_HINT}""",
                "code-reviewer",
                f"refute:{key}",
                timeout,
            ))

    refute_results = parallel(refute_tasks)

    confirmed = []
    refuted = []
    for finding, refute_result in zip(all_findings, refute_results):
        if not refute_result.success:
            finding["refuted"] = False
            finding["crossCheck"] = "refuter produced no verdict — finding is UNVERIFIED, not confirmed"
            confirmed.append(finding)
            continue
        verdict = extract_json(refute_result.output)
        if verdict and verdict.get("refuted") is True:
            finding["refuted"] = True
            finding["why"] = verdict.get("reasoning", "")
            refuted.append(finding)
        else:
            finding["refuted"] = False
            finding["crossCheck"] = verdict.get("reasoning", "") if verdict else "no verdict"
            confirmed.append(finding)

    log(f"{len(confirmed)} findings survived cross-check, {len(refuted)} refuted")

    # ---------------------------------------------------------------------------
    # Phase 5 — Readiness
    # ---------------------------------------------------------------------------
    phase("Readiness")

    readiness_tasks = [
        lambda: agent(
            f"""Assess release readiness from this evidence. Classify each gate Confirmed / Claimed-not-verified / Missing / N-A — do not upgrade a claim to Confirmed because it sounds reasonable.\n\nProduce a RECOMMENDATION for human confirmation. You do not hold deploy authority and this workflow cannot grant it.\n\nCONFIRMED FINDINGS:\n{format_findings(confirmed)}\n\nOPEN ASSUMPTIONS / QUESTIONS FROM REQUIREMENTS:\n{chr(10).join(assumptions + open_questions) or '(none)'}""",
            "release-manager",
            "readiness",
            timeout,
        ),
        lambda: agent(
            f"""Draft the user-facing documentation and release notes for this change. Verify every behavioral claim against the actual implementation, not the requirement text — label anything you could not verify as Unverified rather than asserting or omitting it.\n\nCRITERIA:\n{criteria_text}\n\nIMPLEMENTATION:\n{implementation}""",
            "technical-writer",
            "docs",
            timeout,
        ),
    ]

    readiness_results = parallel(readiness_tasks)
    readiness = readiness_results[0].output if readiness_results[0].success else ""
    docs = readiness_results[1].output if len(readiness_results) > 1 and readiness_results[1].success else ""

    # ---------------------------------------------------------------------------
    # Final output
    # ---------------------------------------------------------------------------
    output = {
        "initiative": initiative,
        "requirements": reqs,
        "design": {"ux": ux_spec, "architecture": architecture},
        "surfacesBuilt": surfaces,
        "findings": {"confirmed": confirmed, "refutedCount": len(refuted)},
        "readinessRecommendation": readiness,
        "documentation": docs,
        "humanDecisionRequired": [
            "Release go/no-go — release-manager recommends, it never commits.",
            *open_questions,
        ],
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
