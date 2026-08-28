---
name: independent-review
description: Review a completed change through four independent evidentiary bases in parallel, adversarially cross-check every finding, then merge into one ranked report. Use for a branch, PR, diff, or working tree that needs review deeper than one pass. Invoke with /flow:independent-review, then describe the target in the next message.
type: flow
---

# Independent Review Flow

Run four lenses on the same change. Each lens uses a different evidentiary basis (reading, executing, attack-path reasoning, measurement). Cross-check every finding adversarially before reporting it.

```d2
BEGIN -> review

review: |md
  ## Phase 1 — Review

  Identify the target from the user's request (branch, PR, diff, or working tree).

  Run four review lenses in parallel on the target. For each lens, read the corresponding `.kimi-code/agents/<role>.md` first:
  1. `.kimi-code/agents/code-reviewer.md` — read-only correctness review; form expectation before reading the diff.
  2. `.kimi-code/agents/qa-engineer.md` — execute tests and behavior; re-run claimed verification.
  3. `.kimi-code/agents/security-engineer.md` — attack-path review.
  4. `.kimi-code/agents/performance-engineer.md` — measured performance.

  When all four structured findings lists are ready, this phase is complete.
|

review -> cross-check: cross-check

cross-check: |md
  ## Phase 2 — Cross-check

  For each finding from each lens, refute it from a different evidentiary basis:
  - code-reviewer findings → refute as qa-engineer (read `.kimi-code/agents/qa-engineer.md`)
  - qa-engineer findings → refute as code-reviewer (read `.kimi-code/agents/code-reviewer.md`)
  - security-engineer findings → refute as code-reviewer
  - performance-engineer findings → refute as qa-engineer

  Default to treating a finding as refuted if the refuter cannot substantiate it from actual evidence.

  If zero findings survived cross-check, output `<choice>no-findings</choice>`. Otherwise output `<choice>merge</choice>`.
|

cross-check -> no-findings: no-findings
cross-check -> merge: merge

no-findings: |md
  ## No Findings Survived

  Report that the review produced no findings that survived adversarial cross-check. Include the count of raw candidate findings that were refuted, and note this as a clean outcome.
|
no-findings -> END

merge: |md
  ## Phase 3 — Merge

  Read `.kimi-code/agents/code-reviewer.md` and deduplicate/rank the surviving findings into one report:
  - Merge findings from multiple lenses that describe the same underlying defect, noting when two independent methods agreed.
  - Rank by blast radius and reversibility.
  - Preserve the correct severity scale for each finding.
  - Mark any finding whose cross-check produced no verdict as Unverified.

  Present the final ranked report.
|

merge -> END: end

END: END
```
