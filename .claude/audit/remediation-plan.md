# Remediation Plan

Ordered, dependency-aware. **Nothing here is applied.** Each wave needs separate approval; I will show the diff before each write.

Sequencing rationale: `DELEG-01` and `PATH-01` first because both are silent-failure paths — the suite currently looks like it works. `WIRE-01` is the largest win but must come *after* `SCHEMA-03`, since preload and explicit-load directives touch the same frontmatter and prose. `SCHEMA-01` must come *after* `OVERLAP-01`, so negative scope isn't written into a file that then gets merged away.

---

## Wave 1 — Blocker: restore delegation (`DELEG-01`)

**Files:** `agents/qa-engineer.md`, `agents/database-engineer.md`, `agents/performance-engineer.md`, `agents/incident-commander.md` — frontmatter line 4 only.

**Change:** append `Agent(qa-runner)` to the `tools` list of the first three. For `incident-commander`, choose one:
- (a) grant `Agent(qa-runner)` if its verification work should delegate execution, or
- (b) leave tools unchanged and amend `:3` to drop "coordinates the agents/humans who do" → "coordinates the humans and specialists who do, via its caller."

**Expected diff:** 4 lines changed, 0 added, 0 removed. Option (b) makes it 3 tool lines + 1 description line.

**Rollback:** revert the 4 lines. No downstream dependency.

**Verification:** invoke `qa-engineer` on a task that should shed a large run (e.g. "run the full suite and triage") and confirm from the transcript that it spawns `qa-runner` rather than calling `Bash` itself. This is the only finding with a directly observable behavioral test — run it before proceeding.

**Open question for you:** (a) or (b) for `incident-commander`. I recommend (b) — it has no execution need of its own, and narrower tool grants are the pattern the rest of the suite follows.

---

## Wave 2 — Silent memory loss (`PATH-01`)

**Files (18):** `agents/product-manager.md`, `product-analyst.md`, `incident-commander.md`, `release-manager.md`, `technical-writer.md`, `ux-designer.md`; `skills/risk-management`, `stakeholder-management`, `technical-debt-management`, `retrospectives`, `disaster-recovery`, `ux-research`, `architecture-decisions`, `analytics-and-telemetry` (`SKILL.md` each); `memory/README.md`.

**Change:** replace bare `memory/<project>` with `.claude/memory/<project>`. One line per site, ~20 sites total. `memory/README.md:8` gets the canonical root in its layout diagram.

**Expected diff:** ~20 lines changed, 0 added, 0 removed. Purely mechanical.

**Rollback:** single-line reverts, or one inverse replace.

**Verification:** `grep -rn "[^.]memory/<project>" .claude` returns nothing; `grep -rc "\.claude/memory/<project>"` matches every persistence directive found in the audit. Then have two agents round-trip: one writes to memory, another reads it back in a separate invocation.

**Note:** do not do this at the same time as Wave 4 — Wave 4 deletes one of these files (`dependency-*`), and touching both at once makes the diff harder to review.

---

## Wave 3 — Schema, least-privilege, and the structural outlier

Independent of each other; can land as one reviewable batch.

| Finding | Files | Change | Diff size |
|---|---|---|---|
| `SCHEMA-03` | 5 agent frontmatters + their line 11 | add `skills: [engineering-integrity, project-memory]`; delete the now-redundant prose directive | +5 / −5 |
| `SCHEMA-02` | `agents/qa-runner.md:1-5` | add an explicit lighter `model:` | +1 |
| `TOOL-01` | `agents/qa-runner.md:4` | drop `Write` | 1 changed |
| `TOOL-02` | `agents/code-reviewer.md` body | add one line scoping `Bash` to read-only inspection (`git diff`, `git log`, file listing) — no `tools` change | +1 |
| `STRUCT-01` | `agents/technical-writer.md` | full rewrite from `proposed/technical-writer.md` | 33 → ~95 lines |

**Rollback:** `SCHEMA-02`/`TOOL-01`/`TOOL-02`/`SCHEMA-03` are line reverts. `STRUCT-01` is a whole-file replace; the 33-line original is **already preserved** at `audit/originals/technical-writer.md`, so revert is a copy-back. No pre-step needed.

**Verification:** re-parse all 15 frontmatter blocks; then assert, per agent, that every tool in its `tools` list is exercised by a procedure in its own body — the check that would have caught `TOOL-01`. For `STRUCT-01`, confirm the rewritten agent still declares no capability it lacks a procedure for.

**Do `SCHEMA-03` before Wave 4**, since Wave 4 edits the same prose region in several agents.

---

## Wave 4 — Wire the registry together (`WIRE-01`) — the largest win

This is the substantive wave. It shrinks agents and makes 36+ skills reachable, and it must be done per-agent, not in bulk.

**Per agent, the pattern is the same** (copy `qa-engineer.md:133`'s form exactly — `Load the \`<skill>\` skill for X; the rules below are the non-negotiable core`):

| Agent | Skills to wire | Inline prose to thin |
|---|---|---|
| `solution-architect` | `architecture-decisions`, `system-architecture`, `domain-driven-design`, `distributed-systems` | §4.6 ADR contents list (`:75`) → defer to the skill |
| `ux-designer` | `accessibility`, `interaction-design`, `design-systems`, `ux-research` | §4.1 (`:58`), §4.3 (`:64`), §4.5 (`:70`), §4.6 (`:73`) → keep the *requirement*, defer the *mechanics* |
| `security-engineer` | `threat-modeling`, `secure-coding`, `supply-chain-security`, `privacy-engineering`, `compliance` | §3.1/§3.3 method detail |
| `release-manager` | `release-engineering`, `rollback-strategies`, `feature-flagging`, `backward-compatibility` | deployment-strategy detail |
| `site-reliability` | `observability-design`, `capacity-planning`, `disaster-recovery`, `business-continuity` | instrumentation detail |
| `performance-engineer` | `performance-engineering`, `capacity-planning` | tool/technique detail |
| `code-reviewer` | `code-review-craft`, `secure-coding` | severity-classification mechanics |
| `database-engineer` | `data-modeling`, `backward-compatibility`, `rollback-strategies` | migration-mechanics detail |
| `software-engineer` | `secure-coding`, `technical-debt-management`, `api-design`, **`dependency-health`** ⚠️ | — mostly already thin |

⚠️ **Ordering dependency:** `dependency-health` does not exist until Wave 5. Either wire `software-engineer` to the existing `dependency-management` now and re-point it in Wave 5, or move Wave 5 step 1 (the merge) ahead of this wave. **I recommend moving the merge first** — it is small, self-contained, and doing it first means nothing gets wired to a file that's about to be deleted.
| `product-manager` | `roadmapping`, `risk-management`, `stakeholder-management`, `governance`, `analytics-and-telemetry` | prioritization-criteria detail |
| `product-analyst` | `business-analysis`, `delivery-tracking` | — `requirements-craft` already wired |
| `incident-commander` | `incident-response`, `retrospectives` | — `root-cause-analysis` already wired |
| `technical-writer` | `documentation` | — already wired |

**Expected diff:** ~13 files, +2 to +6 lines each for load directives, −5 to −20 lines each for thinned prose. **Net negative** — agents get smaller.

**Rollback:** one agent at a time, each a self-contained revert. Do not batch all 13 into one commit.

**Verification:** re-run the orphan scan — every skill named by ≥1 agent body, orphan count 0. Then invoke two rewired agents (`ux-designer`, `security-engineer`) on a real task and confirm from the transcript that the named skills actually load. **This is the wave whose success is measurable**: orphan count 51→0 and total agent LOC down.

**Warning:** thinning inline prose is the only lossy step in this whole plan. Where an agent's inline wording is *stronger* than the skill's, move the wording into the skill rather than deleting it. Do not treat "the skill covers this" as sufficient reason to drop a sharper sentence.

---

## Wave 5 — Merge the one true duplicate, then disambiguate (`OVERLAP-01`, `SCHEMA-01`, `OVERLAP-02`, `GAP-01`)

Must follow Wave 4, so wiring reveals whether the merge target is actually used.

1. **`OVERLAP-01`** — write `skills/dependency-health/SKILL.md` from `proposed/dependency-health/SKILL.md`. Then, as a *separate* reviewable step, delete `skills/dependency-management/` and `skills/dependency-upgrades/`, and update the 3 referring sites (`skills/supply-chain-security/SKILL.md`, `agents/software-engineer.md`, and Wave 4's new wiring). Net: 51 → 50 skills.
2. **`SCHEMA-01`** — add negative scope to the ~8 skills in adjacent pairs only: `capacity-planning`/`performance-engineering`, `disaster-recovery`/`business-continuity`, `api-versioning`/`backward-compatibility`, `documentation`, `dependency-health`. One line each.
3. **`OVERLAP-02`** — state the boundary on both sides: `skills/documentation/SKILL.md:3` scoped to conventions/mechanics, `agents/technical-writer.md` scoped to authorship/verification.
4. **`GAP-01`** — either vendor `playwright-best-practices`/`playwright-cli` into the project tree, or amend `skills/qa-tooling/SKILL.md:27` to mark them environment-dependent. **Vendoring is the better fix** — it removes the last cross-tree dependency and makes the project self-contained, which is the same property Phase 5 scored highly.

**Rollback:** merges land as new files *before* any deletion, so a mid-wave stop leaves a working (if briefly redundant) registry. Deletions are the last step and are individually revertible from this audit directory.

**Verification:** skill count is 50; `grep` for `dependency-management`/`dependency-upgrades` returns nothing; orphan count still 0; re-run the secret/path/coupling sweep to confirm no regression.

---

## Wave 6 — Advisory only, outside project scope

`PORT-01`, `SETTINGS-01`, `SHADOW-01` all live in `%USERPROFILE%\.claude` or concern it.

- `SETTINGS-01` is a one-line deletion in `settings.local.json` and is safe to fold into any earlier wave if you want it gone.
- `PORT-01` and `SHADOW-01` change user-global configuration that affects **every other project on this machine**, not just this one. I will not touch either without a separate, explicit decision. Recommendation for `SHADOW-01`: delete the user-global `software-engineer.md` — it is 62 lines longer than the project version and therefore actively misleading to a future session, but it is inert here, so this is a housekeeping call, not a fix.

---

## What this plan deliberately does not do

- **No new artifacts.** Phase 4 found no coverage hole and no unowned handoff. Adding to a registry whose defect is unreachable existing material would make `WIRE-01` worse.
- **No capability-abstraction layer.** `skills/qa-tooling/SKILL.md:12-31` already does this correctly and is the only place it's needed.
- **No mass skill deletion.** The instinct from "36 orphans" is to delete. The evidence says the skills are the better-written half of the registry and the agents are duplicating them badly — so the fix is wiring, and the skill count drops by exactly one.
- **No mass negative-scope edit across 51 descriptions.** Wiring makes most of them unnecessary; editing all 51 would be padding.
