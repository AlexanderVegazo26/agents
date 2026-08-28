---
name: legacy-modernization
description: Strategy for evolving or replacing a legacy system safely — strangler-fig pattern, incremental migration, and when a full rewrite is actually justified. Load when planning modernization of an aging system or component.
---

# Legacy Modernization

## Incremental over rewrite by default

A full rewrite carries the risk of re-implementing years of accumulated edge-case handling incorrectly, while the business keeps needing the old system to work throughout. Prefer the strangler-fig pattern: build the new implementation alongside the old, route traffic/functionality to it incrementally, and retire the old system piece by piece once each piece is proven equivalent.

## When a rewrite is actually justified

State the evidence explicitly: the old system is fundamentally unextendable for the required change, the incremental path has been evaluated and found infeasible (not just harder), or the maintenance cost of the old system already exceeds the cost of a rewrite. "It's old and we don't like it" is not sufficient justification on its own.

## Preserving behavior during migration

The legacy system's actual behavior — including undocumented edge cases — is the real spec, more authoritative than any design doc about what it was supposed to do. Characterize existing behavior (via tests against the current system) before replacing it, so the new implementation can be verified against real behavior, not assumed intent.

## Data migration

Legacy data often carries inconsistencies accumulated over years that a clean new schema won't tolerate — plan explicit handling (cleanup, mapping rules, exception handling) for these rather than assuming a straightforward one-to-one migration.

## Sequencing

Migrate the highest-risk or highest-value piece first if it validates the approach quickly, or the lowest-risk piece first if the goal is building confidence in the migration mechanism — state which sequencing goal is driving the plan.
