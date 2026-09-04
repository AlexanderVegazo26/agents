---
name: interaction-design
version: 1.0.0
description: Designing states, transitions, and feedback for user interactions — beyond static wireframes, how the UI behaves over time. Load when specifying interactive behavior for a feature.
---

# Interaction Design

## Design every state, not just the default

Every interactive element needs a defined: default, loading, error, empty, and success state. A design that only shows the happy-path screen leaves the implementer guessing at the states most likely to confuse a real user.

## Feedback for every action

Every user action needs visible feedback — a click with no response reads as broken, even if a request is in flight. Distinguish optimistic feedback (show success immediately, reconcile later) from confirmed feedback (wait for the server) explicitly — and note the risk of optimistic UI showing success before an action actually completed.

## Error states

Error messages should say what happened and, where possible, what the user can do about it — not just "an error occurred." Design recoverable paths (retry, undo, edit-and-resubmit) rather than a dead end.

## Transitions

Specify what happens between states (loading spinner, skeleton screen, instant vs. animated transition) — these affect perceived performance and clarity as much as raw speed does.

## Consistency

Reuse interaction patterns already established elsewhere in the product (how confirmation dialogs work, how errors are surfaced, how loading is indicated) rather than inventing a new pattern per feature — consistency reduces the user's cognitive load more than any single feature's polish does.
