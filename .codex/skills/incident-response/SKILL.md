---
name: incident-response
description: Coordinating an active production incident — severity assessment, role assignment, communication cadence, and mitigation-first prioritization. Load at the start of and during an active incident.
---

# Incident Response

## Mitigate first, understand second

The immediate goal is restoring service, not fully understanding the cause — a fast mitigation (rollback, failover, scale-up, kill switch) that stops user impact is correct even if the root cause isn't yet known. Root cause analysis happens after, or in parallel without blocking mitigation.

**Speed doesn't move the reversibility line, it only changes how fast you're allowed to reach it.** A reversible, scoped mitigation (rollback to known-good, flag disable, traffic shift) can proceed immediately under active customer impact without waiting for confirmation. Anything irreversible, anything that expands blast radius, or anything that bypasses an existing safety control still requires explicit confirmation — regardless of how urgent it feels. Treat uncertainty about whether an action is actually reversible as irreversibility.

## Evidence classification during an incident

Label every claim as it comes in: **confirmed** (corroborated from two independent sources, or directly verified), **hypothesis** (plausible, not yet confirmed — restate the label every time it's mentioned, not just once), **ruled out** (actively checked and disproven), or **unknown** (genuinely undetermined — a legitimate status, never silently defaulted to the most convenient hypothesis). Dashboards, alerts, and logs are evidence to verify, not facts to act on outright — corroborate anything critical before it drives an irreversible decision.

**Recovery specifically requires confirmed status** from real user-facing signals (error rate at baseline, business-critical flows completing, dependent-service health) — not a cleared alert or a completed deploy alone.

## Severity assessment

Assess actual user impact (not just "an alert fired"): how many users, what functionality, is data at risk, is it getting worse. Severity should be reassessed as new information arrives, not fixed at first declaration.

## Roles

For anything beyond a trivial incident: someone coordinating (tracking status, unblocking, deciding next action), someone communicating (stakeholders, status page), someone investigating/mitigating. One person can hold multiple roles for a small incident — the point is that these functions don't get dropped, not that every incident needs a full team.

## Communication cadence

Regular, predictable updates (even "no change, still investigating") beat silence — stakeholders escalate unpredictably when they don't know if anyone's working the problem.

## After mitigation

Hand off to `root-cause-analysis` for the postmortem — don't let the incident close without one for anything above trivial severity.
