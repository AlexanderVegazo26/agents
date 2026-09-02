---
name: design-systems
version: 1.0.0
description: Using and evolving a shared design system — component reuse discipline, and when a new pattern is actually warranted vs. a one-off. Load when designing anything that could reuse or extend existing components.
---

# Design Systems

## Reuse before inventing

Check the existing design system for a component/pattern that already solves this before designing something new — a one-off pattern is a maintenance cost for both design and engineering, and an inconsistency cost for the user.

## When a new pattern is warranted

Only when the existing system genuinely can't express the need — not "the existing button doesn't quite match this mockup's aesthetic." State explicitly why the existing pattern doesn't fit before proposing a new one, and flag it as a system change (affecting more than this one feature) rather than a local decision.

## Consistency over local optimization

A component that's 5% better for this one screen but breaks consistency with the rest of the product is usually a net loss — the user's mental model of "how this product behaves" is worth more than a marginal local improvement.

## Documentation

A design system component isn't reusable if its usage guidelines (when to use it, when not to, its variants and states) aren't documented — a component that only the original designer knows how to use correctly isn't actually shared.

## Governance

Changes to shared components ripple across every consumer — review them with the same rigor as a shared library API change in code, including checking who else is affected before altering behavior.
