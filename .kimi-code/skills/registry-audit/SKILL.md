---
name: registry-audit
description: Re-run the .claude registry audit as a repeatable check — schema validation, orphan detection, overlap analysis, tech-agnosticism, and consistency, with every finding adversarially verified. Use after adding or changing agents/skills to confirm the registry has not regressed. Invoke with /skill:registry-audit, then confirm the registry root in the next message if needed.
type: flow
---

# Registry Audit Flow

Run five audit dimensions on the `.claude/` registry in parallel, verify each finding adversarially, then merge the confirmed findings into a ranked register.

```d2
BEGIN -> dimensions

dimensions: |md
  ## Phase 1 — Dimensions

  Identify the registry root from the user's request (default: `.claude`).

  Run five read-only audit passes in parallel. For each pass, read `.kimi-code/agents/code-reviewer.md` first (the audit is read-only). Each pass should produce structured findings with id, severity (BLOCKER/HIGH/MEDIUM/LOW), summary, path, line, evidence, and recommendation.

  1. **Schema** — frontmatter parses; names are kebab-case and unique; tool grants match stated privileges; delegations declare `Agent(<name>)`; skills have name + description + negative scope; referenced files resolve.
  2. **Orphans** — skills named by no agent body; agents referenced by no other agent/workflow; dangling name references.
  3. **Overlap** — near-duplicate content across artifact bodies; classify MERGE / SPLIT / DELINEATE / DEMOTE.
  4. **Agnosticism** — hardcoded stack coupling: absolute paths, usernames, vendor CLIs, cloud names, secrets/tokens (redact values).
  5. **Consistency** — conflicting boundary claims, inconsistent section citations, inconsistent memory paths or vocabularies.

  Drop any finding that cannot be cited with path:line evidence.
|

dimensions -> verify: verify

verify: |md
  ## Phase 2 — Verify

  For each finding from each dimension, read `.kimi-code/agents/code-reviewer.md` and verify it by reading the cited file. Confirm the finding only if the evidence actually supports it, the cited path/line exists, and the "problem" is not intentional and correct as written.

  Count confirmed and dropped findings.
|

verify -> report: report

report: |md
  ## Phase 3 — Report

  Read `.kimi-code/agents/code-reviewer.md` and write the audit register from verified findings only:
  - Lead with BLOCKER count.
  - Group by severity.
  - Each entry: id, severity, path:line, impact, concrete fix.
  - Include a "verified clean" section listing what was checked and found fine.
  - Note how many candidate findings were dropped on verification.

  Present the final register.
|

report -> END: end

END: END
```
