#!/usr/bin/env python3
"""Derive personas, explore the app as each, then probe authorization boundaries.

Equivalent to .claude/workflows/persona-qa-sweep.js.
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


PERSONA_SCHEMA_HINT = """
Return a JSON object with:
- personas: array of {id, label?, status: "confirmed"|"candidate"|"rejected", provenanceCount?, forbidden: array of strings}
- ambiguities: array of strings
- undetermined: array of strings
"""


PROBE_SCHEMA_HINT = """
Return a JSON object with:
- leaks: array of {severity, resource, evidence, layer?, kind?}
- ambiguous: array of strings
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Persona QA sweep workflow")
    parser.add_argument("--target", required=True, help="Non-production target URL")
    parser.add_argument("--env", default="non-production", help="Environment name")
    parser.add_argument("--journeys", nargs="*", default=[], help="Multi-actor journeys to run")
    parser.add_argument("--timeout", type=int, default=3600, help="Agent timeout in seconds")
    args = parser.parse_args()

    target = args.target
    env = args.env
    requested_journeys = args.journeys
    timeout = args.timeout

    if not target:
        print(json.dumps({
            "status": "stopped",
            "reason": "No target supplied. persona-runner and boundary-prober both require an explicit non-production target and refuse to default — asking is the correct behavior here, not guessing.",
        }, indent=2))
        return 1

    # ---------------------------------------------------------------------------
    # Phase 1 — Discover
    # ---------------------------------------------------------------------------
    phase("Discover")

    discovery_result = agent(
        f"""Derive the end-user personas this application actually implements. Every persona needs path:line provenance — a persona with none does not get written. Require two independent source types before marking one confirmed; never promote a candidate on your own judgment.\n\nEmit specs conforming to .claude/skills/exploration-charter/personas-schema-template.yaml. Report ambiguous capability entries as the high-value output they are, not as a gap to fill by guessing. State explicitly what you could not determine.\n\n{PERSONA_SCHEMA_HINT}""",
        "persona-discovery",
        "discover",
        timeout,
    )

    if not discovery_result.success:
        log(f"persona-discovery failed: {discovery_result.error}")
        return 1

    discovery = extract_json(discovery_result.output)
    if not discovery or not discovery.get("personas"):
        log("No personas derived from code evidence")
        print(json.dumps({
            "status": "stopped",
            "reason": "No personas derived from code evidence.",
            "discovery": discovery,
        }, indent=2))
        return 1

    personas = discovery["personas"]
    confirmed = [p for p in personas if p.get("status") == "confirmed"]
    candidates = [p for p in personas if p.get("status") == "candidate"]

    log(f"{len(confirmed)} confirmed personas, {len(candidates)} candidates")

    if len(confirmed) > 12:
        print(json.dumps({
            "status": "stopped",
            "reason": f"{len(confirmed)} personas exceeds persona-discovery's own stop condition of 12 — that indicates splitting on the wrong axis. Stopping rather than fanning out a wrong decomposition across dozens of agents.",
            "discovery": discovery,
        }, indent=2))
        return 1

    # ---------------------------------------------------------------------------
    # Phase 2 — Explore
    # ---------------------------------------------------------------------------
    phase("Explore")

    explore_tasks = []
    for p in confirmed:
        explore_tasks.append(lambda p=p: agent(
            f"""Explore {target} in the {env} environment as persona \"{p['id']}\".\n\nAdopt the persona's behavior model as constraints on HOW you act, not just what you check — a novice+sloppy persona takes wrong turns and submits bad input; a keyboard-only persona never uses a pointer. Stay inside its anti_goals. Use its own session_isolation_key; never reuse another persona's session.\n\nCharter: pursue this persona's ranked jobs and report where it cannot complete them. Record an abandonment as a finding, including where it gave up and why. Synthetic data only. Refuse and stop if the target resolves to production.\n\nDo NOT probe anything in this persona's forbidden list — record it and leave it to boundary-prober.""",
            "persona-runner",
            f"explore:{p['id']}",
            timeout,
        ))

    explore_results = parallel(explore_tasks)
    sessions_by_persona = [
        {"persona": p["id"], "session": r.output}
        for p, r in zip(confirmed, explore_results)
        if r.success
    ]

    # ---------------------------------------------------------------------------
    # Phase 3 — Probe
    # ---------------------------------------------------------------------------
    phase("Probe")

    pairs = []
    for owner in confirmed:
        for actor in confirmed:
            if owner["id"] != actor["id"]:
                pairs.append((owner, actor))

    log(f"{len(pairs)} ordered persona pairs to probe")

    resource_ids = "\n".join(
        f"[{s['persona']}] {s['session']}" for s in sessions_by_persona
    )[:4000]

    probe_tasks = []
    for owner, actor in pairs:
        probe_tasks.append(lambda o=owner, a=actor: agent(
            f"""Probe authorization between personas on {target} ({env}).\n\nAttempt to reach persona \"{o['id']}\"'s resources while authenticated as persona \"{a['id']}\". Probe BOTH layers — an action hidden in {a['id']}'s UI but reachable at its API is a finding, and usually the most serious class here. Cover horizontal (peer resource, same role) as well as vertical escalation, plus identifier substitution, direct navigation, stale-session reuse, and unauthenticated access.\n\nResources {o['id']} must deny to others: {', '.join(o.get('forbidden', [])) or '(none listed — report this as an unactionable spec gap rather than inventing identifiers)'}\n\nResource identifiers discovered during exploration:\n{resource_ids}\n\nUse security-engineer's severity scale. Report an ambiguous cell as an unmade product decision, not a bug. Read-oriented probes only — no destructive probe against another persona's resource from inside this workflow.\n\n{PROBE_SCHEMA_HINT}""",
            "boundary-prober",
            f"probe:{a['id']}->{o['id']}",
            timeout,
        ))

    probe_results = parallel(probe_tasks)

    leaks = []
    ambiguous = set()
    for result, (owner, actor) in zip(probe_results, pairs):
        if not result.success:
            continue
        probe_data = extract_json(result.output)
        if not probe_data:
            continue
        for leak in probe_data.get("leaks", []):
            leak["actor"] = actor["id"]
            leak["owner"] = owner["id"]
            leaks.append(leak)
        ambiguous.update(probe_data.get("ambiguous", []))

    log(f"{len(leaks)} authorization leaks, {len(ambiguous)} unresolved ambiguous cells")

    # ---------------------------------------------------------------------------
    # Phase 4 — Journeys
    # ---------------------------------------------------------------------------
    journey_results = []
    if requested_journeys:
        phase("Journeys")
        log(f"{len(requested_journeys)} multi-actor journeys to run")

        journey_tasks = []
        for i, journey in enumerate(requested_journeys):
            journey_tasks.append(lambda j=journey, idx=i: agent(
                f"""Run this multi-actor journey on {target} ({env}): {j}\n\nAvailable personas: {', '.join(p['id'] for p in confirmed)}\n\nMaintain the journey ledger as the ONLY state channel between personas — artifact identifiers and observable facts, never credentials or session state. Delegate each step to persona-runner under a step-scoped charter, each with its own isolated identity.\n\nAfter every handoff, verify from the RECEIVING persona's own view. A sender-side confirmation is not evidence of delivery. Also check negative propagation: personas outside the journey must not observe the artifact.\n\nOn a failed handoff, record exactly which one broke, preserve the ledger, and halt — do not skip ahead or fabricate the missing state.""",
                "journey-orchestrator",
                f"journey:{idx + 1}",
                timeout,
            ))

        journey_results = [r.output for r in parallel(journey_tasks) if r.success]
    else:
        log("No journeys supplied — skipping the multi-actor phase rather than inventing a business process")

    # ---------------------------------------------------------------------------
    # Phase 5 — Report
    # ---------------------------------------------------------------------------
    phase("Report")

    sessions_text = "\n\n".join(
        f"### {s['persona']}\n{s['session']}" for s in sessions_by_persona
    )[:8000]

    journeys_text = "\n\n---\n\n".join(journey_results)[:6000] if journey_results else "(no journeys supplied — this coverage gap belongs in the \"what was NOT tested\" section)"

    verdict_result = agent(
        f"""Triage this persona sweep into one verdict. The explorers reported what happened; the bug / bad-test / flake / environment classification is yours, per your §10 — do not treat their severity ratings as finished triage verdicts.\n\nRank authorization leaks by blast radius: cross-tenant > cross-user > cross-role > UI-only inconsistency. Keep security-engineer's severity scale for those and the persona-impact scale for usability findings, labeled so they don't get conflated.\n\nInclude a \"what was NOT tested\" section: candidate personas were deliberately not explored, and unresolved ambiguous cells are unmade product decisions rather than defects.\n\nEXPLORATION SESSIONS:\n{sessions_text}\n\nAUTHORIZATION LEAKS:\n{format_findings(leaks)}\n\nAMBIGUOUS CELLS (need a product decision, not a fix):\n{chr(10).join(ambiguous) or '(none)'}\n\nMULTI-ACTOR JOURNEY RESULTS:\n{journeys_text}""",
        "qa-engineer",
        "triage",
        timeout,
    )

    verdict = verdict_result.output if verdict_result.success else ""

    output = {
        "target": target,
        "env": env,
        "personas": {
            "confirmed": [p["id"] for p in confirmed],
            "candidatesAwaitingDecision": [p["id"] for p in candidates],
        },
        "authorizationLeaks": leaks,
        "journeys": {"requested": len(requested_journeys), "results": journey_results},
        "ambiguousCapabilities": list(ambiguous),
        "undeterminedByDiscovery": discovery.get("undetermined", []),
        "verdict": verdict,
        "humanDecisionRequired": [
            *[f"Promote or reject candidate persona \"{p['id']}\" — persona-discovery will not self-promote." for p in candidates],
            *[f"Resolve ambiguous capability: {a}" for a in ambiguous],
        ],
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
