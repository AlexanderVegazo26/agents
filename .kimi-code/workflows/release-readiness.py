#!/usr/bin/env python3
"""Collect every release gate in parallel from the agent that owns it.

Equivalent to .claude/workflows/release-readiness.js.
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


GATE_SCHEMA_HINT = """
Return a JSON object with:
- gate: string
- status: "Confirmed" | "Claimed-not-verified" | "Missing" | "N/A"
- evidence: string
- blockers: array of strings
- notes: string
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Release readiness workflow")
    parser.add_argument("release", nargs="?", default="the pending release on the current branch", help="Release name, branch, or tag")
    parser.add_argument("--timeout", type=int, default=3600, help="Agent timeout in seconds")
    args = parser.parse_args()

    release = args.release
    timeout = args.timeout

    GATES = [
        {
            "key": "engineering",
            "agent": "solution-architect",
            "brief": "Architectural sign-off for this release. Was a Tier 2+ structural decision in play, and does the implementation follow the intended design? Scope this to architectural alignment only — code review is code-reviewer's, not yours to redo.",
        },
        {
            "key": "quality",
            "agent": "qa-engineer",
            "brief": "Quality gate. Report what you have actually Verified this session versus what is Unverified or Untestable. Do not let \"the implementer said tests pass\" become Confirmed — that is Claimed-not-verified unless you ran it. Include what was not tested and the risk that leaves.",
        },
        {
            "key": "security",
            "agent": "security-engineer",
            "brief": "Security gate. Map findings to blocking vs non-blocking per your §4: Critical/High block, Medium is Should-Fix, Low/Informational do not block alone. Give a clear blocking read, not a raw finding list. You document risk acceptance; you never accept it on anyone's behalf.",
        },
        {
            "key": "operations",
            "agent": "site-reliability",
            "brief": "Operations readiness. Monitoring exists, dashboards exist, alerts exist AND are owned, rollback signals defined. Report as Confirmed/Missing per item, not a vague impression. Include current error-budget state — a service that has already burned its budget for the period is evidence for slowing velocity.",
        },
        {
            "key": "rollback",
            "agent": "database-engineer",
            "brief": "Data-layer reversibility. Is there a real path back — for schema, data, and config? A rollback plan that has not been rehearsed is Claimed-not-verified, not Confirmed. Say plainly which it is; qa-engineer executes the rehearsal, not you.",
        },
    ]

    # ---------------------------------------------------------------------------
    # Phase 1 — Gates
    # ---------------------------------------------------------------------------
    phase("Gates")

    gate_tasks = []
    for gate in GATES:
        gate_tasks.append(lambda g=gate: agent(
            f"Assess your gate for: {release}\n\n{g['brief']}\n\n{GATE_SCHEMA_HINT}",
            g["agent"],
            f"gate:{g['key']}",
            timeout,
        ))

    gate_results = parallel(gate_tasks)

    gates = []
    for result, gate in zip(gate_results, GATES):
        if not result.success:
            gates.append({
                "key": gate["key"],
                "owner": gate["agent"],
                "gate": gate["key"],
                "status": "Missing",
                "evidence": "Gate agent produced no result — treated as Missing, never as passing.",
            })
            continue
        gate_data = extract_json(result.output)
        if not gate_data:
            gates.append({
                "key": gate["key"],
                "owner": gate["agent"],
                "gate": gate["key"],
                "status": "Missing",
                "evidence": "Gate agent produced no structured result — treated as Missing.",
            })
            continue
        gate_data["key"] = gate["key"]
        gate_data["owner"] = gate["agent"]
        gates.append(gate_data)

    blocking = [g for g in gates if g.get("status") == "Missing" or g.get("blockers")]
    unverified = [g for g in gates if g.get("status") == "Claimed-not-verified"]
    confirmed_count = len([g for g in gates if g.get("status") == "Confirmed"])

    log(f"{confirmed_count}/{len(gates)} gates Confirmed; {len(unverified)} claimed-not-verified; {len(blocking)} blocking")

    # ---------------------------------------------------------------------------
    # Phase 2 — Synthesize
    # ---------------------------------------------------------------------------
    phase("Synthesize")

    recommendation_result = agent(
        f"""Produce a release readiness recommendation for: {release}\n\nGATE RESULTS:\n{format_findings(gates)}\n\nRules you already hold, restated because this run is automated and nobody is watching each step:\n- A gate with no result is Missing, never \"probably fine\".\n- Claimed-not-verified is not Confirmed. Do not upgrade it because the claim sounds plausible or the release is wanted.\n- Name explicitly what evidence is absent and what risk shipping without it accepts.\n- Produce a RECOMMENDATION for a human to confirm. You do not hold deploy authority, and neither does this workflow.""",
        "release-manager",
        "recommendation",
        timeout,
    )

    recommendation = recommendation_result.output if recommendation_result.success else ""

    output = {
        "release": release,
        "gates": gates,
        "gatesConfirmed": [g["key"] for g in gates if g.get("status") == "Confirmed"],
        "gatesBlocking": [g["key"] for g in blocking],
        "gatesClaimedNotVerified": [g["key"] for g in unverified],
        "recommendation": recommendation,
        "authority": "RECOMMENDATION ONLY. This workflow has no deploy authority and cannot grant it. A human confirms go/no-go.",
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
