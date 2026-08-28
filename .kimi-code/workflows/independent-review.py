#!/usr/bin/env python3
"""Review a change through four independent evidentiary bases in parallel.

Equivalent to .claude/workflows/independent-review.js.
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
)


FINDINGS_SCHEMA_HINT = """
Return a JSON object with:
- findings: array of {severity, summary, evidence, file?, line?, needsExecution?}
"""


VERDICT_SCHEMA_HINT = """
Return a JSON object with:
- refuted: boolean
- reasoning: string
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Independent review workflow")
    parser.add_argument("target", nargs="?", default="the current working tree", help="Review target (branch, PR, diff, or working tree)")
    parser.add_argument("--timeout", type=int, default=3600, help="Agent timeout in seconds")
    args = parser.parse_args()

    target = args.target
    timeout = args.timeout

    LENSES = [
        {
            "key": "correctness",
            "agent": "code-reviewer",
            "refuter": "qa-engineer",
            "brief": "Review by reading. Apply your §4 requirement-tracing contamination guard: form the expectation of correct behavior BEFORE reading the diff, then state explicitly if it changed and why. Assign severity (Must Fix / Should Fix / Nit) and confidence (High / Medium / Low) per your §7. Mark any finding that only execution can settle.",
        },
        {
            "key": "behavior",
            "agent": "qa-engineer",
            "refuter": "code-reviewer",
            "brief": "Verify by executing. Never inherit a \"tests pass\" claim you did not run this session. Label every claim Verified / Falsified / Unverified / Untestable. Load the hazard skills where they apply — concurrency-and-thread-safety, caching-and-invalidation, datetime-correctness — rather than naming a failure mode generically.",
        },
        {
            "key": "security",
            "agent": "security-engineer",
            "refuter": "code-reviewer",
            "brief": "Review mode: findings and direction only, no rewrites. Every finding needs a plausible attack path, affected component, realistic conditions, and meaningful impact. A theoretical weakness with no realistic impact is Informational, not High — do not produce security theater.",
        },
        {
            "key": "performance",
            "agent": "performance-engineer",
            "refuter": "qa-engineer",
            "brief": "Trace the target before measuring (your §3) — the current baseline is not the requirement. No claim without a number; label each Measured / Modeled / Assumed / Unknown. Do not run load tests against anything shared or production-adjacent from inside this workflow.",
        },
    ]

    # ---------------------------------------------------------------------------
    # Phase 1 — Review
    # ---------------------------------------------------------------------------
    phase("Review")

    review_tasks = []
    for lens in LENSES:
        review_tasks.append(lambda l=lens: agent(
            f"Review {target}. {l['brief']}\n\n{FINDINGS_SCHEMA_HINT}",
            l["agent"],
            f"review:{l['key']}",
            timeout,
        ))

    review_results = parallel(review_tasks)

    # ---------------------------------------------------------------------------
    # Phase 2 — Cross-check
    # ---------------------------------------------------------------------------
    phase("Cross-check")

    all_findings = []
    refute_tasks = []

    for result, lens in zip(review_results, LENSES):
        if not result.success:
            continue
        findings_data = extract_json(result.output)
        if not findings_data or not findings_data.get("findings"):
            continue
        for f in findings_data["findings"]:
            f["lens"] = lens["key"]
            all_findings.append((f, lens["refuter"]))
            refute_tasks.append(lambda f=f, r=lens["refuter"]: agent(
                f"""Attempt to REFUTE this finding using your own evidentiary basis, which is deliberately different from the one that produced it. Default to refuted=true when you cannot substantiate it from actual evidence in the code or from execution.\n\nFINDING ({f.get('severity', 'unknown')}) in {f.get('file', 'unspecified')}{':' + str(f['line']) if f.get('line') else ''}\n{f.get('summary', '')}\nCLAIMED EVIDENCE: {f.get('evidence', '')}\n\n{VERDICT_SCHEMA_HINT}""",
                r,
                f"refute:{lens['key']}",
                timeout,
            ))

    refute_results = parallel(refute_tasks)

    survived = []
    for (finding, _), refute_result in zip(all_findings, refute_results):
        if not refute_result.success:
            finding["refuted"] = False
            finding["crossCheck"] = "refuter produced no verdict — finding is UNVERIFIED, not confirmed"
            survived.append(finding)
            continue
        verdict = extract_json(refute_result.output)
        if verdict and verdict.get("refuted") is True:
            finding["refuted"] = True
            finding["crossCheck"] = verdict.get("reasoning", "")
        else:
            finding["refuted"] = False
            finding["crossCheck"] = verdict.get("reasoning", "") if verdict else "no verdict"
            survived.append(finding)

    log(f"{len(all_findings)} raw findings, {len(survived)} survived cross-check")

    if not survived:
        output = {
            "target": target,
            "findings": [],
            "summary": f"No findings survived adversarial cross-check across {len(LENSES)} independent lenses. {len(all_findings)} candidate findings were refuted.",
            "refutedForAudit": [f for f, _ in all_findings],
        }
        print(json.dumps(output, indent=2, ensure_ascii=False))
        return 0

    # ---------------------------------------------------------------------------
    # Phase 3 — Merge
    # ---------------------------------------------------------------------------
    phase("Merge")

    merge_result = agent(
        f"""Deduplicate and rank these cross-checked findings into one report.\n\nRules:\n- Two lenses reporting the same underlying defect is a STRONGER signal, not a duplicate to delete — merge them and say both methods agreed.\n- Rank by blast radius and reversibility, not by which lens found it.\n- Security findings keep security-engineer's Critical/High/Medium/Low/Informational scale; everything else uses Must Fix / Should Fix / Nit. Never blend the two scales without labeling which is in use.\n- Any finding whose cross-check says \"no verdict\" is reported as Unverified, never as confirmed.\n\nFINDINGS:\n{format_findings(survived)}""",
        "code-reviewer",
        "merge",
        timeout,
    )

    merged = merge_result.output if merge_result.success else ""

    output = {
        "target": target,
        "lensesRun": [l["key"] for l in LENSES],
        "findings": survived,
        "report": merged,
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
