---
name: capacity-planning
description: Translating growth projections into infrastructure and cost requirements ahead of time. Load when planning for expected growth, or when reviewing whether current capacity headroom is adequate. Do NOT use for measuring a system's actual limit or running load tests — that is `performance-engineering`; this skill consumes those measurements to project forward.
---

# Capacity Planning

## Plan ahead of growth, not during an incident

Capacity that's only assessed when something starts degrading is capacity planning by incident — the point of this discipline is to see the constraint coming with enough lead time to act (provision, optimize, or renegotiate the growth timeline).

## Inputs

Current utilization trend, stated or projected growth (traffic, data volume, user count), and the actual bottleneck resource for this system (CPU, memory, connection pool, storage, third-party rate limit) — identify which resource will constrain first, since it's rarely uniform across a system.

Label every number by how it was obtained: **Measured** (from an actual `performance-engineer` load/scalability campaign or real production telemetry) vs. **Modeled/Estimated** (extrapolated from a trend or a projection). An estimated capacity limit is a legitimate planning input, but it carries less weight than a measured breaking point — don't let a projection read as if it were confirmed.

## Headroom

State target headroom explicitly (e.g. "provision for 2x current peak") rather than provisioning to exactly meet today's peak — organic growth and unexpected spikes both eat into headroom faster than planned.

## Cost tradeoff

Capacity has a real cost — weigh headroom against actual growth confidence; massive over-provisioning "just in case" is a FinOps problem, not a safety margin (see `cost-optimization`).

## Monitoring against the plan

A capacity plan is only useful if actual usage is tracked against it — `site-reliability` should be watching the trend line, not just current-moment utilization, so drift from the plan is caught early.

## The feedback loop is bidirectional

`performance-engineer`'s pre-release load/scalability campaigns produce the initial capacity model; `site-reliability`'s real production data should calibrate and correct that model going forward, not just consume it once. A capacity plan that's never updated against actual observed usage drifts from reality exactly when it matters most — right before the limit it predicted is reached.

## Third-party limits

Don't forget capacity constraints outside your own infrastructure — API rate limits, quota ceilings on managed services, connection limits on shared databases — these can bind before your own compute does.
