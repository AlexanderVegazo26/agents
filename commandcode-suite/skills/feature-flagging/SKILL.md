---
name: feature-flagging
description: Using feature flags to decouple deployment from release, enable safe rollback, and support staged rollout. Load when planning how a risky or user-visible change ships.
---

# Feature Flagging

## Why: decoupling deploy from release

A feature flag lets code reach production inactive, then get activated independently of a deploy — this turns "roll back a bad feature" into "flip a flag" instead of "coordinate a redeploy," which is faster and lower-risk.

## Types of flags

- **Release flags** — gate a feature during development/rollout; short-lived, removed once fully released.
- **Ops flags** — kill switches for operational control (disable a degraded dependency's feature under load); may be long-lived.
- **Experiment flags** — A/B testing; tied to analytics, removed once the experiment concludes.
- **Permission flags** — gate a feature by plan/tier/entitlement; long-lived by design.

## Discipline

- Every release flag has a planned removal — flag debt (dozens of stale flags no one remembers the purpose of) is a real maintainability cost. Track flags with an owner and an expected retirement point.
- Test both flag states, not just the "on" path — a flag that's never tested off is a rollback plan that's never been exercised.
- Avoid flag interaction complexity: two flags that combine to create a state nobody designed for is a common source of production surprises. Keep the combinatorial space small, or explicitly test the combinations that matter.
- Don't use a flag as a substitute for actual access control — a flag hidden in the UI is not a security boundary if the underlying API doesn't also check authorization.

## Staged rollout via flags

Percentage-based or cohort-based rollout lets a change reach a small population first, with the flag as the rollback lever if signal looks bad — pair with `sdlc-suite:observability-design` so there's something to actually watch during the ramp.
