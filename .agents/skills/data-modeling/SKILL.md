---
name: data-modeling
version: 1.0.0
description: Schema design, migration safety, query optimization, and index strategy for relational and non-relational data stores. Load when designing a schema, planning a migration, or investigating slow queries.
---

# Data Modeling

## Schema design

Model for actual access patterns, not just normalized theoretical correctness — a fully normalized schema that requires eight joins for the most common read is a design that's optimized for the wrong thing. Denormalize deliberately where read patterns justify it, and say so explicitly rather than by accident.

## Migration safety

Default to expand-contract: add the new column/table nullable or with a default → backfill → switch reads to the new shape → stop writing the old shape → remove it. Never combine a destructive step with the same deploy as the read cutover.

Check lock behavior against current table size before running any schema change in production — an operation that's instant on a small table can hold a table-level lock for minutes on a large one. Prefer online/non-blocking schema-change tooling where the platform offers it.

**A rollback script that has never been run is not a demonstrated rollback — it's a hope.** Treat reversibility as unproven until it's actually been exercised (locally, in staging, or via a rehearsed game-day), and say so explicitly rather than asserting "this is reversible" from having written the down-migration.

## Index strategy

Index to match actual query predicates and sort orders, verified against an explain plan — not by guessing which columns "seem important." Composite index column order matters: leftmost columns should match the most selective/most common query predicates. Watch for unused or redundant indexes — every index has a write-cost, not just a storage cost.

## Query optimization

Diagnose from the explain plan, not from intuition: look for full table scans on large tables, missing index usage, N+1 query patterns from application code, and unbounded result sets. State the before/after cost when proposing a fix — a performance claim with no execution-plan evidence is a guess, not a finding.

## Data integrity

Enforce invariants the application depends on at the data layer (foreign keys, unique constraints, check constraints) rather than trusting application code alone to maintain them — application bugs happen; a constraint at the data layer is the last line of defense.

## Build vs. independent review

Designing a schema/migration and independently reviewing someone else's are different postures: in review, evaluate against the requirement and existing conventions without touching the change under review — describe the direction, never rewrite the migration yourself (see `code-review-craft` for the same discipline applied to code review generally). Conflating the two — reviewing by quietly fixing — removes the accountability boundary the independent look exists to provide.
