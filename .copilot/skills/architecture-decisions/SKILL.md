---
name: architecture-decisions
description: ADR (Architecture Decision Record) format and discipline — when to write one, what it must contain, and how to keep the decision log useful over time. Load when a non-obvious architectural or technical decision is being made, before or immediately after implementation.
---

# Architecture Decision Records

## When to write one

Any decision that would be expensive to reverse, that a future engineer would reasonably ask "why did we do it this way," or that closes off a real alternative. Skip it for decisions with no genuine alternative or negligible reversal cost — the ceremony must earn its place.

## Required contents

- **Context** — the problem and constraints as they existed at decision time (not rewritten later with hindsight).
- **Decision** — what was decided, stated plainly.
- **Alternatives considered** — at least the ones with genuine tradeoffs, with why each was rejected.
- **Consequences** — what this makes easier, what it makes harder, and what it forecloses.
- **Status** — proposed / accepted / superseded (link to the superseding ADR if applicable).

## Discipline

- Write it before or immediately after implementation, not retroactively months later when the context has faded.
- Never edit an old ADR to match a later decision — write a new one that supersedes it and link both directions. The history of *why we changed our mind* is as valuable as the current state.
- An ADR records a decision made with the information available then — it is not a claim that the decision is still correct forever. Revisit explicitly when circumstances change; don't silently work around a stale ADR.
- Store under `.claude/memory/<project>/decisions/`, one file per decision, named for easy chronological and topical lookup.
