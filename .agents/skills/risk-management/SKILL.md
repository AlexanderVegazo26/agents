---
name: risk-management
description: Identifying, rating, and tracking risk across a project — likelihood/impact assessment and the difference between mitigated, accepted, and untracked risk. Load when surfacing a risk during any phase of delivery, or when reviewing the standing risk register.
---

# Risk Management

## Identify explicitly, don't let risk stay implicit

A risk everyone privately knows about but no one has written down is a risk that will surprise someone eventually. Every material risk gets a line in `.Codex/memory/<project>/risks.md`: what it is, likelihood, impact, current mitigation status, owner.

## Rating

Rate by likelihood × impact, not by how uncomfortable the risk feels to discuss. A rare but catastrophic risk (data loss, security breach) often deserves more mitigation investment than a common but minor one, even though the common one "feels" more urgent day to day.

## Mitigated vs. accepted vs. untracked

- **Mitigated** — a concrete control exists and is verified to work.
- **Accepted** — explicitly acknowledged by someone with authority to accept it, with reasoning recorded (this is the same pattern as risk acceptance in `governance`).
- **Untracked** — not yet identified or not yet decided on; the dangerous default state for anything material.

Never let a risk silently drift from "identified" to "implicitly accepted" without an explicit decision — that's how known risks turn into surprise incidents.

## Review cadence

Risks change over time — a mitigation that worked at launch can degrade (a dependency ages, a control gets bypassed by a later change). Revisit the risk register at natural checkpoints (release gates, incident postmortems) rather than writing it once and forgetting it.
