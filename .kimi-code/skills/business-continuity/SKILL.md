---
name: business-continuity
version: 1.0.0
description: Ensuring critical business functions can continue through a major disruption — beyond technical DR, covering process, staffing, and communication continuity. Load when assessing organizational resilience to a major disruption, not just system recovery. Do NOT use for the technical recovery mechanics themselves — RTO/RPO, backups, failover — that is `disaster-recovery`, whose commitments this skill's plans depend on.
---

# Business Continuity

## Beyond technical recovery

`disaster-recovery` covers getting systems back; business continuity covers whether the business can keep operating while they're down — degraded-mode processes, manual workarounds for critical functions, and communication to customers/partners during the outage.

## Critical function identification

Identify which business functions genuinely can't tolerate downtime (payment processing, safety-critical operations, regulatory reporting deadlines) vs. which can tolerate a delay — continuity planning effort should concentrate on the former.

## Degraded-mode operation

For critical functions, define what a manual or reduced-capability fallback looks like when the primary system is down — a documented manual process, even a slow one, beats total inability to operate.

## Communication continuity

Plan how the business communicates with customers/stakeholders during an outage when normal channels (status page hosted on the affected infra, for instance) might themselves be affected.

## Dependency on DR

Business continuity plans assume DR's RTO/RPO commitments are real — mismatched expectations here (business assumes 1-hour recovery, DR is architected for 24-hour) is a planning gap that should surface during joint review, not during an actual disaster.
