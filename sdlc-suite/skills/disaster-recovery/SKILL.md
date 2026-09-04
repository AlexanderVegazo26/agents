---
name: disaster-recovery
version: 1.0.0
description: Planning and testing recovery from major infrastructure loss — RTO/RPO definition, backup validation, and failover procedures. Load when defining DR requirements or reviewing whether a system could actually recover from a major outage. Do NOT use for keeping the business operating while systems are down (that is `sdlc-suite:business-continuity`) or for day-to-day incident mitigation (that is `sdlc-suite:incident-response`).
---

# Disaster Recovery

## RTO and RPO

Define explicitly per system, not as a blanket org-wide number: **RTO** (recovery time objective — how long can this be down) and **RPO** (recovery point objective — how much data loss is tolerable, measured in time). These drive real architecture decisions (backup frequency, replication topology, failover automation) — don't leave them as unstated assumptions.

## Backups are not a plan until restored

A backup that's never been restored is a hope, not a recovery capability. Test restoration on a real (or realistic) schedule, and time it — if the restore takes longer than the RTO, the backup strategy doesn't actually meet the requirement it exists for.

## Failover

For anything with a failover target (secondary region, standby replica), test the actual failover procedure — not just that the standby exists. Failover automation itself can fail; know what the manual fallback looks like.

## Scope

Disaster recovery covers loss of infrastructure/data at a scale beyond a single incident's normal mitigation (region loss, catastrophic data corruption, ransomware) — day-to-day incident response is `sdlc-suite:incident-response`; this is the plan for when that response isn't enough.

## Documentation

DR procedures belong in `.claude/memory/<project>/runbooks/`, written so someone unfamiliar with the system's internals could execute them under pressure — not written for the person who already knows how it all works.
