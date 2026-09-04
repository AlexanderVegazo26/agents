---
name: cost-optimization
version: 1.0.0
description: FinOps-style reasoning for balancing infrastructure/tooling cost against reliability and performance needs. Load when reviewing spend, right-sizing infrastructure, or weighing a cost-vs-reliability tradeoff.
---

# Cost Optimization (FinOps)

## Cost is a tradeoff, not just a number to minimize

Cutting cost by removing genuinely needed redundancy or headroom trades money for risk — make that tradeoff explicit and let whoever owns the risk decide, rather than silently optimizing cost at reliability's expense.

## Right-sizing

Match provisioned resources (compute, storage, database tier) to actual measured utilization, not to a guess made at initial setup that was never revisited. Over-provisioning is the most common and easiest-to-fix cost issue; under-provisioning shows up as a reliability problem instead, so check both directions.

## Waste identification

Idle/orphaned resources (unattached storage volumes, unused reserved capacity, forgotten environments), redundant data storage, and inefficient queries/algorithms that inflate compute cost for no functional benefit — these are pure waste with no tradeoff, fix them regardless of the reliability-vs-cost conversation.

## Visibility

Cost attribution (which team/service/feature drives which spend) has to exist before optimization decisions can be made responsibly — flag missing cost visibility as a gap rather than optimizing blind.

## Commitment vs. flexibility

Reserved/committed spend (annual commitments, reserved instances) trades a lower rate for reduced flexibility — appropriate for stable, predictable baseline load; risky for volatile or still-uncertain workloads. State the confidence level behind a usage projection before committing spend against it.
