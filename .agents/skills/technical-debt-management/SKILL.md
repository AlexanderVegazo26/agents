---
name: technical-debt-management
version: 1.0.0
description: Tracking known technical debt with its real cost of carrying it, and deciding when to pay it down vs. accept it. Load when identifying new debt, or when deciding whether to prioritize a payoff.
---

# Technical Debt Management

## Record it, don't let it stay tribal knowledge

Debt that only exists as "yeah, we know that part's bad" in someone's head is debt that will surprise the next person who touches it. Record in `.claude/memory/<project>/technical-debt.md`: what it is, why it exists (rarely negligence — usually a deliberate tradeoff made under a real constraint at the time), and its current cost of carrying it.

## Cost of carrying, not just cost of fixing

The decision isn't "how much would it cost to fix" alone — it's that against "what is this costing us every sprint/release/incident by continuing to exist" (slower changes in that area, recurring bug class, onboarding friction, blocked future work). Debt that's cheap to carry can reasonably wait; debt whose carrying cost compounds should be prioritized even if the fix itself is expensive.

## Distinguish debt from a bug

A bug is something broken relative to spec; debt is something that works but was built with a shortcut whose cost accrues over time (missing tests, a hacky workaround, an outdated pattern the rest of the codebase has moved past). Don't file debt as a bug or vice versa — the framing changes how it should be prioritized.

## Deliberate vs. accidental debt

Debt taken on deliberately (documented tradeoff, ADR-referenced) is different from debt that accumulated by accident (no one noticed the pattern drifting) — the former was a decision with known consequences; the latter is a signal that review/process missed something, worth investigating separately.

## Paying it down

Treat debt payoff as a real prioritized work item competing for the same time as features — not something squeezed in only when there's spare capacity, which in practice means never.
