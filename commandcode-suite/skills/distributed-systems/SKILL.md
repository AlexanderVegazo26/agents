---
name: distributed-systems
version: 1.0.0
description: Core distributed-systems reasoning — consistency models, failure modes, idempotency, and the fallacies that quietly break designs which assume a network is reliable. Load when a design spans more than one process/service/datastore.
---

# Distributed Systems

## Assume the network will fail

Design for partial failure as the normal case, not the exception: timeouts, retries with backoff, circuit breakers on every cross-process call. A call with no timeout is a design that assumes the network never fails — it will, eventually, and then the caller hangs forever.

## Consistency models

State explicitly whether a given read needs to be strongly consistent (must reflect the latest write) or can tolerate eventual consistency (will converge, but a caller might briefly see stale data). Most of an application's data doesn't need strong consistency everywhere — but the parts that do (balances, inventory counts, permission checks) need it named explicitly, not assumed by default.

## Idempotency

Any operation that can be retried (network timeout, client retry, message redelivery) must be idempotent, or must be made idempotent via a dedup key/idempotency token. An operation that "usually" only runs once is a duplicate-charge or duplicate-side-effect bug waiting for the right timing.

## Ordering and causality

Don't assume messages/events arrive in the order they were sent across process boundaries. If order matters, make the ordering constraint explicit (sequence numbers, causal metadata) rather than relying on transport-layer ordering that isn't guaranteed at the application level.

## The eight fallacies of distributed computing

The network is reliable; latency is zero; bandwidth is infinite; the network is secure; topology doesn't change; there is one administrator; transport cost is zero; the network is homogeneous. Every one of these, taken as an unstated assumption, has caused a real outage somewhere — check a new distributed design against this list explicitly.
