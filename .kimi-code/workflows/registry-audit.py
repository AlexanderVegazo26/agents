#!/usr/bin/env python3
"""Re-run the .claude registry audit as a repeatable check.

Equivalent to .claude/workflows/registry-audit.js.
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
- findings: array of {id, severity: "BLOCKER"|"HIGH"|"MEDIUM"|"LOW", summary, path, line?, evidence, recommendation?}
"""


VERDICT_SCHEMA_HINT = """
Return a JSON object with:
- confirmed: boolean
- reasoning: string
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Registry audit workflow")
    parser.add_argument("--root", default=".claude", help="Registry root directory")
    parser.add_argument("--timeout", type=int, default=3600, help="Agent timeout in seconds")
    args = parser.parse_args()

    root = args.root
    timeout = args.timeout

    DIMENSIONS = [
        {
            "key": "schema",
            "brief": f"""Validate every agent and skill under {root}.
- Agent frontmatter parses; name is kebab-case, unique, matches filename stem.
- Any tool listed in `tools:` is a real tool name, and is least-privilege for the agent's stated job. Flag write/exec granted to an agent whose description claims read-only.
- Any agent whose body instructs delegating to another agent must declare `Agent(<name>)` in tools — a prose delegation instruction with no Agent grant is unimplementable.
- Skills have name + description, and description carries explicit negative scope (\"Do NOT use for...\").
- Every referenced sibling file, template, and path actually resolves on disk.""",
        },
        {
            "key": "orphans",
            "brief": f"""Find unreachable artifacts under {root}.
- A skill named in backticks by NO agent body is an orphan: skills do not reliably description-auto-match inside a subagent, so an unnamed skill cannot be relied on to load.
- An agent referenced by no other agent and named in no workflow is an orphan.
- Any agent, skill, or file referenced BY NAME that does not exist is a dangling reference.
Report exact counts, and list every orphan by name — do not summarize as \"a few\".""",
        },
        {
            "key": "overlap",
            "brief": f"""Analyze overlap under {root} from artifact BODIES, not names.
Classify each overlapping pair MERGE / SPLIT / DELINEATE / DEMOTE.
Critically: a pair that already states its own boundary in its own text is CORRECTLY DELINEATED — report it as fine, not as a finding. Only flag genuine near-duplicate content. Prefer recommending deletion or merging over addition; a smaller sharper registry is the goal. Do not manufacture overlap to pad the report.""",
        },
        {
            "key": "agnosticism",
            "brief": f"""Audit {root} for hardcoded stack coupling.
Flag: absolute paths, paths containing a username, vendor CLIs, cloud providers, CI systems, package managers, shell-specific syntax, client/tenant/employer names, secrets or tokens (report location, REDACT the value).
Distinguish coupled-by-accident from coupled-by-purpose: a skill that is legitimately ABOUT a named tool, or a stack-DETECTION table that names tools as examples of what to detect, is correct as written and is not a finding.""",
        },
        {
            "key": "consistency",
            "brief": f"""Check cross-artifact consistency under {root}.
- Do two agents describe the same boundary between them differently? (e.g. one claims it owns decisions the other also claims.)
- Is a memory path, section citation (§N), or evidence-classification vocabulary referenced inconsistently across agents?
- Does any agent cite a section number in another agent that does not exist or means something else there?
These silent disagreements are the highest-value findings in a mature registry.""",
        },
    ]

    # ---------------------------------------------------------------------------
    # Phase 1 — Dimensions
    # ---------------------------------------------------------------------------
    phase("Dimensions")

    dimension_tasks = []
    for dim in DIMENSIONS:
        dimension_tasks.append(lambda d=dim: agent(
            f"""You are auditing a Claude Code agent/skill registry, read-only. Do not modify any file.\n\n{d['brief']}\n\nEvery finding MUST carry path:line evidence. If you cannot cite evidence, DROP the finding — do not infer, extrapolate, or fill gaps with plausible defaults. Report what is genuinely fine as fine. A short honest audit beats a long padded one.\n\n{FINDINGS_SCHEMA_HINT}""",
            "code-reviewer",
            f"audit:{d['key']}",
            timeout,
        ))

    dimension_results = parallel(dimension_tasks)

    # ---------------------------------------------------------------------------
    # Phase 2 — Verify
    # ---------------------------------------------------------------------------
    phase("Verify")

    all_findings = []
    verify_tasks = []

    for result, dim in zip(dimension_results, DIMENSIONS):
        if not result.success:
            continue
        findings_data = extract_json(result.output)
        if not findings_data or not findings_data.get("findings"):
            continue
        for f in findings_data["findings"]:
            f["dimension"] = dim["key"]
            all_findings.append(f)
            verify_tasks.append(lambda f=f: agent(
                f"""Verify this audit finding by reading the cited file yourself. Set confirmed=false if the evidence does not actually support the claim, if the cited path or line does not exist, or if the \"problem\" is intentional and correct as written.\n\nBe skeptical: audit agents over-report. Default to confirmed=false when uncertain.\n\nFINDING [{f.get('severity', 'unknown')}] {f.get('id', 'unknown')}: {f.get('summary', '')}\nCITED AT: {f.get('path', 'unknown')}{':' + str(f['line']) if f.get('line') else ''}\nCLAIMED EVIDENCE: {f.get('evidence', '')}\n\n{VERDICT_SCHEMA_HINT}""",
                "code-reviewer",
                f"verify:{f.get('id', 'unknown')}",
                timeout,
            ))

    verify_results = parallel(verify_tasks)

    confirmed = []
    dropped = []
    for finding, verify_result in zip(all_findings, verify_results):
        if not verify_result.success:
            finding["confirmed"] = False
            finding["verifyNote"] = "verifier produced no result"
            dropped.append(finding)
            continue
        verdict = extract_json(verify_result.output)
        if verdict and verdict.get("confirmed") is True:
            finding["confirmed"] = True
            finding["verifyNote"] = verdict.get("reasoning", "")
            confirmed.append(finding)
        else:
            finding["confirmed"] = False
            finding["verifyNote"] = verdict.get("reasoning", "") if verdict else "no verdict"
            dropped.append(finding)

    log(f"{len(confirmed)} findings confirmed, {len(dropped)} dropped on verification")

    # ---------------------------------------------------------------------------
    # Phase 3 — Report
    # ---------------------------------------------------------------------------
    phase("Report")

    by_severity = lambda s: [f for f in confirmed if f.get("severity") == s]

    report_result = agent(
        f"""Write the audit register from these VERIFIED findings only.\n\nLead with the count of BLOCKER findings. Group by severity. Every entry: id, severity, path:line, impact, concrete fix. Then a short \"verified clean\" section listing what was checked and found genuinely fine — that section is not filler, it is what makes the findings trustworthy.\n\nNote explicitly that {len(dropped)} candidate findings were dropped because verification could not substantiate them.\n\nVERIFIED FINDINGS:\n{format_findings(confirmed)}""",
        "code-reviewer",
        "report",
        timeout,
    )

    report = report_result.output if report_result.success else ""

    output = {
        "root": root,
        "totals": {
            "blocker": len(by_severity("BLOCKER")),
            "high": len(by_severity("HIGH")),
            "medium": len(by_severity("MEDIUM")),
            "low": len(by_severity("LOW")),
            "droppedOnVerification": len(dropped),
        },
        "findings": confirmed,
        "report": report,
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
