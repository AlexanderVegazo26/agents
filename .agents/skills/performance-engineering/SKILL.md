---
name: performance-engineering
description: Load/stress/scalability testing technique and tool selection — how to define a target, find the actual breaking point, and profile-driven tuning. Load when planning or executing performance validation work. Do NOT use for projecting future infrastructure needs from growth estimates — that is `capacity-planning` — or for ongoing production monitoring, which is `observability-design`.
---

# Performance Engineering

## Define the target first

State expected latency (p50/p95/p99), throughput, and concurrency before testing — a result with no stated target can't be judged pass or fail, only described. If no target exists, that's a gap to flag, not to invent one and test against it silently.

## Load vs. stress vs. scalability

- **Load testing** — validate behavior at expected production load against the target.
- **Stress testing** — push beyond expected load to find the actual breaking point and observe the failure mode (graceful degradation vs. cliff-edge collapse).
- **Scalability analysis** — trend across increasing load (2x, 10x): does cost/latency scale linearly, or does a bottleneck (lock contention, connection pool exhaustion, single-threaded hot path) appear at some threshold?

## Tool selection

Detect the project's existing load-testing setup before introducing a new tool (k6, Locust, JMeter, Gatling are common fits) — match the tool to the protocol/pattern under test (HTTP API, WebSocket, queue-based) rather than defaulting to whatever's most familiar.

## Test data and environment

Test against realistic data volume and shape — an index that performs fine on 1K seeded rows can behave very differently at production scale. Note environment parity gaps (shared/smaller staging infra) explicitly when interpreting results.

## Test execution is an action, not passive observation

A load or stress test can itself cause an incident — wrong environment, uncontrolled cost, or a breaking-point push with real customer impact. Before running anything beyond a local/dedicated environment, state explicitly: which environment, the blast radius if something goes wrong, the abort/rollback plan if the test itself starts causing harm, and the cost of running it. Treat production or shared-environment testing as requiring explicit confirmation, same as any other hard-to-reverse action.

## Label every claim by how it was obtained

**Measured** (directly observed from an executed test, environment stated), **Modeled/Estimated** (calculated or extrapolated — say so), **Assumed** (not measured or modeled — flag, don't present as a finding), or **Unknown/Untestable** (no way to check it here — a legitimate outcome). Never let a modeled projection or an assumption read as if it were a direct measurement — "should scale to 10x" and "measured at 10x: p95 held at 340ms" are different claims and must stay visibly different.

## Profile-driven tuning

Never optimize based on guesswork about what's slow — profile first to find the actual bottleneck, fix it, then re-measure to confirm the fix helped. A change made without profiling risks optimizing something that wasn't actually the bottleneck while leaving the real one untouched. Report every improvement as a before/after pair, both Measured — a claimed improvement with no re-measurement is a guess with confidence attached, not a finding.
