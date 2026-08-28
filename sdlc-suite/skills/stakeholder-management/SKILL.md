---
name: stakeholder-management
description: Identifying stakeholders, tailoring communication to their concerns, and surfacing conflicting asks explicitly rather than resolving them silently. Load when planning communication for a decision or release, or when stakeholder asks conflict.
---

# Stakeholder Management

## Identify who actually has a stake

Beyond the obvious requester: who's affected by this decision, who has veto power, who needs to know even if they can't influence it. Record in `.claude/memory/<project>/stakeholders.md` — who cares about what, and the right channel/cadence to reach them.

## Tailor the message, not the facts

An engineer, a PM, and an executive stakeholder need different framing of the same underlying facts — technical depth for one, business impact for another — but the facts themselves don't change based on the audience. Adjusting substance to what a stakeholder wants to hear is a trust-destroying failure mode, not effective communication.

## Surface conflict, don't silently resolve it

When two stakeholders want incompatible things, name the conflict explicitly and let the accountable decision-maker (see `sdlc-suite:governance`) resolve it — silently picking one side and not mentioning the other's ask erodes trust when it's later discovered.

## Expectation setting

Set expectations early and update them as soon as something changes (schedule slip, scope cut) rather than waiting until the original deadline to disclose it — early bad news is manageable; late bad news is a trust problem on top of the original issue.

## Closing the loop

After a decision or release, report back to stakeholders on the outcome against what was promised — silence after the ask was fulfilled reads as indifference even when the work was done well.
