---
name: release-readiness
description: Collect every release gate in parallel from the agent that owns it, then have release-manager synthesize an evidence-classified go/no-go recommendation. Use before a production release. Produces a recommendation for human confirmation — it does not deploy and never upgrades a claim to Confirmed on its own. Invoke with /skill:release-readiness, then describe the release in the next message.
type: flow
---

# Release Readiness Flow

Run five release gates in parallel, each assessed by the agent that owns it. Then synthesize a recommendation.

```d2
BEGIN -> gates

gates: |md
  ## Phase 1 — Gates

  Identify the release from the user's request (release name, branch, or tag).

  Run five gate assessments in parallel. For each, read the corresponding `.kimi-code/agents/<role>.md` first:
  1. `.kimi-code/agents/solution-architect.md` — architectural alignment.
  2. `.kimi-code/agents/qa-engineer.md` — quality gate.
  3. `.kimi-code/agents/security-engineer.md` — security gate.
  4. `.kimi-code/agents/site-reliability.md` — operations readiness.
  5. `.kimi-code/agents/database-engineer.md` — rollback/reversibility.

  Each gate returns Confirmed / Claimed-not-verified / Missing / N-A plus evidence and blockers.

  Count Confirmed, Claimed-not-verified, Missing, and blocking gates.
|

gates -> synthesize: synthesize

synthesize: |md
  ## Phase 2 — Synthesize

  Read `.kimi-code/agents/release-manager.md` and produce a go/no-go **recommendation** from the full gate results:
  - Treat Missing as Missing, never "probably fine".
  - Treat Claimed-not-verified as not Confirmed.
  - Name absent evidence and the risk of shipping without it.

  Present the recommendation, per-gate evidence, and a clear statement that the workflow has no deploy authority.
|

synthesize -> END: end

END: END
```
