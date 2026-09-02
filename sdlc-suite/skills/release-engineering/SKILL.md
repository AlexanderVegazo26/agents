---
name: release-engineering
version: 1.0.0
description: Deployment strategy selection — rolling, blue-green, canary — matched to risk, plus staged rollout practice. Load when planning how a change ships.
---

# Release Engineering

## Matching strategy to risk

- **Rolling deploy** — default for routine, low-risk, backward-compatible changes; instances updated incrementally with health checks between batches.
- **Blue-green** — full parallel environment cutover; near-instant rollback by switching traffic back. Good when the risk is in the deploy mechanism itself or downtime must be near zero.
- **Canary** — route a small percentage of real traffic to the new version, watch real signal, ramp gradually. Best for changes with real behavioral uncertainty — lets you catch a regression against a small blast radius before it's everyone's problem.
- **Feature-flagged dark launch** — deploy code inactive, activate via flag independent of deploy — decouples "is the code out" from "is the behavior live," letting you roll back behavior instantly without a redeploy (see `sdlc-suite:feature-flagging`).

## Staged rollout discipline

Define what "healthy" looks like at each stage before starting, and an explicit stop/rollback trigger (error rate threshold, latency regression, specific alert) — not a vague "we'll keep an eye on it."

## Avoid flag-day cutovers

A single all-at-once cutover with no staged validation concentrates all risk into one moment with no early warning. Justify explicitly if one is genuinely unavoidable (e.g. a schema change with no safe intermediate state) rather than defaulting to it for convenience.

## Coordination

State what needs to be true before traffic shifts: monitoring/alerting in place (see `sdlc-suite:observability-design`), rollback path tested (see `sdlc-suite:rollback-strategies`), and relevant stakeholders aware of the window.

## Readiness evidence, not readiness claims

When assembling a release readiness case, give every gate (engineering review, quality sign-off, security review, performance validation, operations readiness) one of exactly four statuses: **Confirmed** (the owning specialist actually performed the check and produced a result you can point to), **Claimed, not verified** (asserted but not demonstrably done), **Missing**, or **N/A** (genuinely out of scope, stated with the reason). A Claimed-not-verified or Missing gate is unresolved, never treated as a pass — this is the same "unknown is never approval" discipline the rest of this suite applies to correctness claims, applied here to release evidence.

## Recommendation vs. commitment

Assessing release readiness and producing a Go/No-Go recommendation is not the same as authorizing the deployment — the recommendation should be complete and evidenced enough to act on immediately, but recording it in project memory as a decided release, or treating it as authorization to proceed, belongs to a human confirmation step, not to the analysis itself.
