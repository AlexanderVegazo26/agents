---
name: delivery-tracking
version: 1.0.0
description: Work breakdown, dependency mapping, milestone definition, and status tracking for delivery work. Load when planning how a body of work will be sequenced and tracked, or when reporting status across multiple in-flight items.
---

# Delivery Tracking

## Work breakdown

Break into units small enough to estimate honestly and complete within a short cycle. A unit that can't be described as done/not-done without a judgment call is too coarse — split it.

## Dependencies

Map explicitly: what this needs before it can start (data, another team's output, an in-flight architectural decision), and what depends on it. A dependency discovered mid-implementation is a planning failure, not bad luck — surface it during breakdown.

Distinguish **blocking** (can't start/finish without it) from **informing** (better with it, not blocked without it) — treating every dependency as blocking creates false serialization; treating a real blocker as informing creates false progress reports.

## Milestones

A milestone is a checkpoint that gates something real — a release, a go/no-go decision, a stakeholder commitment — not just a calendar date. State what each milestone actually gates.

## Status tracking

Report status as **done / in progress / blocked / not started**, with blocked items naming the specific blocker and its owner. "On track" with no supporting detail is not a status report. Surface schedule risk as soon as it's known, not at the milestone deadline — a status report's job is to let someone act on bad news early.

## Anti-patterns

- Reporting a work item as "90% done" repeatedly — most remaining-time estimation error concentrates in the last stretch; prefer binary done/not-done per sub-unit.
- Treating a dependency as resolved because it was requested, not because it was actually delivered.
- Silently re-scoping a milestone's definition of done to hit the date instead of reporting the date is at risk.
