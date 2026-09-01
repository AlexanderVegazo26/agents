---
name: persona-qa-sweep
description: Derive real end-user personas from code evidence, explore the app as each one, then probe authorization boundaries between every persona pair. Use for role-based testing of a user-facing application. Requires an explicit non-production target — never point at production. Invoke with /skill:persona-qa-sweep, then provide target and env in the next message.
type: flow
---

# Persona QA Sweep Flow

Discover who the users are from code, explore the app as each confirmed persona, probe authorization between every pair, optionally run multi-actor journeys, and triage everything into one verdict.

```d2
BEGIN -> discover

discover: |md
  ## Phase 1 — Discover

  Confirm the user provided a non-production target URL and environment. If no target was provided, output `<choice>stop-no-target</choice>`.

  Read `.kimi-code/agents/persona-discovery.md` and derive personas from code evidence with path:line provenance. Require two independent source types before marking a persona confirmed. Emit specs conforming to `.claude/skills/exploration-charter/personas-schema-template.yaml`. Report ambiguities and undetermined items.

  If no personas were derived, output `<choice>stop-no-personas</choice>`. If more than 12 personas are confirmed, output `<choice>stop-too-many</choice>`. Otherwise output `<choice>explore</choice>`.
|

discover -> stop-no-target: stop-no-target
discover -> stop-no-personas: stop-no-personas
discover -> stop-too-many: stop-too-many
discover -> explore: explore

stop-no-target: |md
  ## Stopped

  Report that no target was supplied. persona-runner and boundary-prober require an explicit non-production target and refuse to default. Ask the user to provide one.
|
stop-no-target -> END

stop-no-personas: |md
  ## Stopped

  Report that no personas were derived from code evidence. Return the discovery output so the user can review ambiguities and undetermined items.
|
stop-no-personas -> END

stop-too-many: |md
  ## Stopped

  Report that more than 12 personas were confirmed, which exceeds persona-discovery's own stop condition and indicates splitting on the wrong axis. Return the persona list and ask the user to refine the decomposition.
|
stop-too-many -> END

explore: |md
  ## Phase 2 — Explore

  For each **confirmed** persona, read `.kimi-code/agents/persona-runner.md` and explore the target in its own isolated session. Adopt the persona's behavior model as constraints, pursue its ranked jobs, record abandonments, use synthetic data only, and stop if the target resolves to production.

  When all exploration sessions are complete, this phase is done.
|

explore -> probe: probe

probe: |md
  ## Phase 3 — Probe

  Build all ordered persona pairs (actor, owner) where actor ≠ owner.

  For each pair, read `.kimi-code/agents/boundary-prober.md` and attempt to reach the owner's resources while authenticated as the actor. Probe both UI and API layers, horizontal and vertical escalation, identifier substitution, stale-session reuse, and unauthenticated access.

  Count authorization leaks and ambiguous cells.
|

probe -> journeys-check: journeys-check

journeys-check: |md
  ## Phase 4 — Journeys (optional)

  If the user supplied multi-actor journeys, read `.kimi-code/agents/journey-orchestrator.md` and run each journey. Maintain a ledger as the only state channel between personas, delegate each step to persona-runner, verify from the receiving persona's view, and halt on a failed handoff.

  If no journeys were supplied, note that this phase was skipped rather than inventing a business process.
|

journeys-check -> report: report

report: |md
  ## Phase 5 — Report

  Read `.kimi-code/agents/qa-engineer.md` and triage everything into one verdict. Use the exploration sessions, authorization leaks, ambiguous cells, and journey results.

  Rank authorization leaks by blast radius, distinguish bug vs bad-test vs flake vs environment, and include a "what was NOT tested" section.

  Present the verdict and the list of human decisions required.
|

report -> END: end

END: END
```
