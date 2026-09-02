---
name: rollback-strategies
version: 1.0.0
description: Designing and validating a real path back to the previous good state — for code deploys, schema changes, and configuration. Load when planning a release or reviewing whether a change is actually reversible.
---

# Rollback Strategies

## A rollback plan is a tested path, not a description

"We'd redeploy the previous version" is a plan only if that previous version can actually run against the current state (data, schema, config) without breaking. Verify this explicitly — don't assume reversibility.

## Code rollback

Straightforward if the new version's data/schema expectations are backward compatible with what the old version needs. Breaks down the moment a migration has already run that the old code can't handle — this is why schema changes need their own rollback reasoning (see below), independent of the code rollback.

## Schema/data rollback

Expand-contract migrations (see `sdlc-suite:data-modeling`) are rollback-friendly because the old schema shape still exists during the transition — rolling back code doesn't require reversing the migration. A destructive migration (dropped column, altered type, backfilled-and-removed old data) is not cleanly reversible — if one is unavoidable, state explicitly what's lost if rollback is needed after it runs.

**Ownership split:** `sdlc-suite:database-engineer` owns whether a migration's rollback is actually demonstrated (rehearsed, not just written) and reports that result. `sdlc-suite:release-manager` consumes that confirmed result when assembling a release's readiness case rather than re-assessing migration reversibility independently — re-deriving it from scratch risks a second, uncoordinated judgment on the same question.

## Configuration and feature flags

Prefer flag-gated behavior changes over code-level cutovers specifically because the rollback is instant (flip the flag) and doesn't require a redeploy — see `sdlc-suite:feature-flagging`.

## Validating the rollback path

Where feasible, actually exercise the rollback (in staging, or via a rehearsed game-day) rather than trusting it works because it looks correct on paper. A rollback plan that's never been run is a hypothesis.

## What "rollback" doesn't cover

Side effects that already happened (emails sent, external API calls made, payments processed) can't be undone by rolling back code — plan compensating actions for these separately rather than assuming rollback erases everything.
