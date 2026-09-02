# Registry Audit — `.claude` agent/skill suite

Audited: 2026-08-04 · Root: `<repo>/.claude` · Read-only through Phase 5.

> ## REMEDIATION STATUS — all 15 findings applied 2026-08-04
>
> | Finding | Status | What changed |
> |---|---|---|
> | `DELEG-01` **BLOCKER** | **fixed** | `Agent(qa-runner)` added to `qa-engineer`, `database-engineer`, `performance-engineer`; `incident-commander` description reworded to drop the coordination claim it couldn't execute (option b) |
> | `WIRE-01` | **fixed** | "Supporting Skills" section added to 12 agents naming which skill to load for what. **Orphan count 36+ → 0 of 51** |
> | `PATH-01` | **fixed** | 20 sites across 16 files canonicalized to `.claude/memory/<project>/`; zero bare paths remain |
> | `SCHEMA-01` | **fixed (scoped)** | Negative scope added to the 8 adjacent-pair skills, not all 51, as recommended |
> | `STRUCT-01` | **fixed** | `technical-writer.md` rewritten to family structure, 33 → 150 lines; original preserved at `originals/` |
> | `SCHEMA-02` | **fixed** | `model: sonnet` on `qa-runner` only; other 14 inherit deliberately |
> | `SCHEMA-03` | **fixed** | `skills: [engineering-integrity, project-memory]` on the 6 agents that load unconditionally; prose reworded to "are preloaded" |
> | `TOOL-01` | **fixed** | `Write` dropped from `qa-runner` |
> | `TOOL-02` | **fixed** | `code-reviewer` body now scopes `Bash` to read-only inspection explicitly |
> | `OVERLAP-01` | **fixed** | `dependency-management` + `dependency-upgrades` merged → `dependency-health`. **51 → 50 skills**, then 51 with the new `exploration-charter` |
> | `OVERLAP-02` | **fixed** | `documentation` skill scoped to conventions; `technical-writer` owns authorship/verification |
> | `GAP-01` | **fixed, and was broader than reported** | I cited only `playwright-best-practices`/`playwright-cli`. Implementation found `qa-tooling/SKILL.md:29` also references `mabl-plan-test`/`mabl-debug`, equally user-global-only. **The original finding undercounted 2 of 4 dangling references.** All four now marked environment-dependent with a stack-neutral fallback note |
> | `SETTINGS-01` | **fixed** | Dead `disabledMcpjsonServers: ["webmcp"]` removed |
> | `PORT-01`, `SHADOW-01` | **deferred by design** | Both live in `%USERPROFILE%\.claude` and affect every project on this machine. Not touched without a separate decision |
>
> **Process note, recorded because it affected these files:** the first `PATH-01` pass used `Get-Content -Raw` + `WriteAllText`, which in PowerShell 5.1 read UTF-8 as cp1252 and double-encoded every em-dash and `§` in 16 files. Caught on the next read, reversed via cp1252 round-trip, and verified — 0 mojibake files remain. All subsequent edits used the editor rather than shell rewrites. Any future bulk edit of this tree must not round-trip through `Get-Content -Raw`.
>
> **Also added this session** (new scope, not audit findings): 4 agents — `persona-discovery`, `persona-runner`, `boundary-prober`, `journey-orchestrator` — plus the `exploration-charter` skill and its `personas-schema-template.yaml`. Three audit fixes were applied to them pre-install: the bare `memory/<project>/` path, a `tools: Task` entry (not a valid tool name — corrected to scoped `Agent(persona-runner)`, the `DELEG-01` lesson), and a referenced-but-missing schema template. All 19 agents now cross-reference only agents that exist.

## Executive summary

1 **BLOCKER**: `qa-runner` is unreachable — no agent declares the `Agent` tool, so the entire context-protection design silently does not work (`DELEG-01`).
The registry's *content* is in good shape. Its *wiring* is not. Two findings dominate:

- **`WIRE-01` (HIGH)** — `qa-engineer` is the only agent that calls domain skills. The other 14 inline their domain knowledge and name **zero** domain skills. 36+ of 51 skills have no caller at all. The registry is effectively two disconnected halves.
- **`PATH-01` (HIGH)** — the memory root is written two incompatible ways across 18 files; the relative form resolves against cwd, so memory silently fails to round-trip between agents.

Tech-agnosticism (the stated priority objective) **passes**: zero secrets, absolute paths, usernames, client names, or accidental stack coupling in the project tree. All 15 agents and 50/51 skills port cleanly. **No new artifacts are proposed for Phase 5, and no capability-abstraction layer is needed** — the registry already expresses capability intent.

Two suspected findings were **dissolved** by verifying frontmatter semantics against the docs before asserting them. Only **one** merge is genuinely justified; several apparent overlaps already delineate themselves in their own text and are reported as fine.

Totals: **1 BLOCKER · 4 HIGH · 7 MEDIUM · 3 LOW** (15). Recommended net change: **51 skills → 50**, and agents shrink rather than grow.

---

## Phase 0 — Inventory

| Type | Count | Notes |
|---|---|---|
| agent | 15 | `agents/*.md`, all top-level, all with valid frontmatter |
| skill | 51 | `skills/<name>/SKILL.md`, 13–36 lines, **zero sibling files** |
| memory | 1 | `memory/README.md` (27 lines) |
| settings | 1 | `settings.local.json` |
| workflow | 5 | `workflows/*.js` — added after the audit; see the note below |
| hook / mcp-server / orphan | 0 | — |

> **Inventory updated 2026-08-04 (post-remediation).** The tree is now **20 agents, 57 skills, 5 workflows**, versus 15/51/0 at audit time. Added since: `ui-engineer`; the four persona agents (`persona-discovery`, `persona-runner`, `boundary-prober`, `journey-orchestrator`); the `exploration-charter` skill with the registry's first progressive-disclosure sibling file; six hazard/mechanics skills (`slo-and-error-budgets`, `debugging-methodology`, `concurrency-and-thread-safety`, `caching-and-invalidation`, `refactoring-mechanics`, `datetime-correctness`); and `.claude/workflows/` plus `.claude/README.md`. Every addition was checked against the findings below before install — `PATH-01`, `SCHEMA-01`, `SCHEMA-03`, `DELEG-01`, and `WIRE-01` all applied to new artifacts, and `/registry-audit` now re-checks those invariants on demand.

All agents declare exactly `name`, `description`, `tools`. All skills declare exactly `name`, `description`. No `model:`, no `skills:`, no `allowed-tools:` anywhere.

Agent LOC: `qa-engineer` 305 · `software-engineer` 179 · `code-reviewer` 139 · `database-engineer` 134 · `incident-commander` 133 · `product-analyst` 125 · `performance-engineer` 124 · `solution-architect` 124 · `release-manager` 116 · `product-manager` 114 · `ux-designer` 106 · `site-reliability` 105 · `security-engineer` 88 · `qa-runner` 62 · `technical-writer` 33.

**Checked and absent — N/A, not findings:** no project `settings.json`, `commands/`, `hooks/`, `.mcp.json`, or `CLAUDE.md`; no nested `.claude/` beyond the root; no orphan files; no skill dir missing `SKILL.md`; no `SKILL.md` misplaced under `agents/`; no `.md` without frontmatter; no agent file below top level.

**Precedence vs. `%USERPROFILE%\.claude`** — see `SHADOW-01`. `software-engineer` and the `accessibility` skill exist in both trees; project definitions win.

---

## Phase 1 — Schema & structural validation

All 15 agent frontmatter blocks parse cleanly: no tabs, no duplicate keys, no unquoted `:`-bearing scalars, every `name` kebab-case and matching its filename stem, all unique registry-wide. All 51 skill frontmatter blocks likewise.

Descriptions are **strong routing signals**, not nominal labels — most state both positive trigger and negative scope for agents (e.g. `performance-engineer.md:3` "Distinct from qa-engineer's lightweight per-change performance check… Not for functional correctness"). This is materially better than typical and is reported as fine. Skills state positive triggers only — see `SCHEMA-01`.

Bodies define objective, procedure, output contract, and stop conditions for 14 of 15 agents; `technical-writer` is the exception (`STRUCT-01`). No body contradicts its own frontmatter except `code-reviewer` (`TOOL-02`).

No `@`-references anywhere. No script invocations. No skill has sibling files, so progressive disclosure cannot be violated — every `SKILL.md` is 13–36 lines and cheap to load. One dangling cross-tree reference: `GAP-01`.

---

## Phase 2 — Correctness & behavior

**Clean, verified rather than skipped:** no `|| true`, no swallowed exit codes, no procedure that continues past a failed step. No `--force`/`--yes`/force-push instruction anywhere except inside explicit *prohibitions* — destructive-action gates exist and are well-formed at `software-engineer.md:192` and `skills/engineering-integrity/SKILL.md:55`, both judging by blast radius and reversibility rather than category. Human-authority-retained gates are consistent across `release-manager`, `product-manager`, `incident-commander`, and `software-engineer`. No recursive delegation cycle exists — but that check is currently **vacuous**: per `DELEG-01` no delegation is possible at all, so it must be re-run once `DELEG-01` is fixed. No stale pinned versions, deprecated flags, or aged-out "current as of" claims.

**Trigger failure risk** is concentrated in skills, not agents — see `WIRE-01` and `SCHEMA-01`.

---

## Findings

### BLOCKER

#### `DELEG-01` — `qa-runner` is unreachable; no agent can invoke it
**Evidence:** `agents/qa-engineer.md:4` declares `tools: Bash, Read, Write, Edit, Grep, Glob, TaskCreate`. Likewise `agents/database-engineer.md:4`, `agents/performance-engineer.md:4`, `agents/incident-commander.md:4`. **No agent in the registry declares `Agent`.** Yet delegation is instructed in prose at `agents/qa-engineer.md` §9.1 ("delegate raw execution to this agent when a run would produce large output"), `agents/qa-runner.md:3` ("Invoked by qa-engineer (primary), and usable by database-engineer or performance-engineer"), `agents/qa-runner.md:27` ("Report to whoever invoked you"), and `agents/incident-commander.md:3` ("coordinates the agents/humans who do").

Per the [docs](https://code.claude.com/docs/en/sub-agents.md), subagents *can* nest (3 layers by default) but **`Agent` must be listed in `tools:`** to do so.

**Impact:** `qa-runner` exists for exactly one reason — keeping large raw output out of a reasoning agent's context — and nothing can reach it. The agent is dead weight, and worse, `qa-engineer` will run large suites through its own `Bash` instead, which is precisely the context flood `qa-runner` was created to prevent. Three agents carry instructions they cannot execute.

**Fix:** add scoped `Agent(qa-runner)` to `qa-engineer`, `database-engineer`, `performance-engineer`. Decide explicitly what `incident-commander` may spawn, or reword its description to drop the coordination claim. Four one-line frontmatter edits.

---

### HIGH

#### `WIRE-01` — Only one agent calls domain skills; the other 14 inline their knowledge and reference none
**Evidence:** `qa-engineer` systematically delegates to skills — `qa-engineer.md:133` (`qa-techniques`), `:163` (`qa-tooling`), `:222` (`qa-triage`), `:249` (`qa-quality-attributes`). Outside it, only three agents name any domain skill: `product-analyst.md:71` (`requirements-craft`), `incident-commander.md:92` (`root-cause-analysis`), `technical-writer.md:19` (`documentation`).

A grep for every skill slug across each owning agent returns **nothing** for:
- `solution-architect.md` → names none of `architecture-decisions`, `system-architecture`, `domain-driven-design`, `distributed-systems`, while `solution-architect.md:75` inlines the ADR contents list ("context, decision, alternatives considered, consequences, rejected options and why") that `skills/architecture-decisions/SKILL.md:12-20` already owns in more detail.
- `ux-designer.md` → names none of `accessibility`, `interaction-design`, `design-systems`, `ux-research`, while `ux-designer.md:70` inlines accessibility checks that `skills/accessibility/SKILL.md:10-19` owns, `:64` inlines state coverage that `skills/interaction-design/SKILL.md:8` owns, `:73` inlines new-pattern justification that `skills/design-systems/SKILL.md:12` owns, and `:58` inlines research posture that `skills/ux-research/SKILL.md:8` owns.
- `code-reviewer.md` → does not name `code-review-craft`.
- `performance-engineer.md` → names neither `performance-engineering` nor `capacity-planning`.
- `release-manager.md` → names none of `release-engineering`, `rollback-strategies`, `feature-flagging`.
- `security-engineer.md` → names none of `threat-modeling`, `secure-coding`, `supply-chain-security`, `privacy-engineering`.
- `site-reliability.md` → names none of `observability-design`, `capacity-planning`, `disaster-recovery`.

At least **36 of 51** skills are named by no agent body; 21 of those are named by no other skill either.

**Impact:** this is the registry's central defect and it explains the apparent bloat. The suite carries 51 well-written skills that mostly have no caller, while agents run a thinner duplicated version of the same content inline. Two consequences: the better material rarely if ever fires, and the two copies will drift.

*Scoping the claim precisely:* description-based auto-triggering **inside a subagent** is **undocumented** — the docs describe auto-delegation to subagents by description, and skill invocation via the `Skill` tool or the `skills:` preload field, but state no auto-matching mechanism for skills within a subagent's own context. That is absence of documentation, not documented absence, so the honest form is: an unnamed skill **cannot be relied on to load**. The finding does not depend on resolving this — 14 agents inlining a thinner duplicate of content the skill layer owns better is a defect either way.

**Fix:** wire, don't delete. Add explicit `Load the \`<skill>\` skill` directives at the point of use in each owning agent, following the `qa-engineer` pattern exactly, then thin the now-redundant inline prose. This shrinks agents and makes skills reachable in one move. Deleting the skills instead would discard the better-written half of the registry.

#### `PATH-01` — Memory root specified two incompatible ways
**Evidence:** canonical `.claude/memory/<project>/` at `skills/project-memory/SKILL.md:8`, `agents/qa-engineer.md:298`, `agents/code-reviewer.md:151`. Bare relative `memory/<project>/` at `agents/product-manager.md:93,109`, `agents/product-analyst.md:95,101,115`, `agents/incident-commander.md:146`, `agents/release-manager.md:107`, `agents/technical-writer.md:31`, `agents/ux-designer.md:115`, plus `skills/risk-management/SKILL.md:10`, `skills/stakeholder-management/SKILL.md:10`, `skills/technical-debt-management/SKILL.md:10`, `skills/retrospectives/SKILL.md:22`, `skills/disaster-recovery/SKILL.md:26`, `skills/ux-research/SKILL.md:26`, `skills/architecture-decisions/SKILL.md:25`, `skills/analytics-and-telemetry/SKILL.md:26`. `memory/README.md:8` also uses the bare form.

**Impact — prospective, not yet observed.** `.claude/memory/` currently contains only `README.md`, and no `<repo>/memory/` directory exists, so nothing has been written to either location yet and no memory has actually been lost. But the relative form resolves against the working directory, so once agents start persisting, writers will land in `<repo>/memory/` while readers look in `<repo>/.claude/memory/`. Cross-agent memory handoff — the explicit purpose of the unified layout — **will** silently fail, and the failure mode is an empty/missing file, which `memory/README.md:24` instructs agents to read as "nothing recorded yet." That turns a silent-loss path into something indistinguishable from valid information. Fixing this before first use costs 20 lines; after, it costs a data migration.

**Fix:** mechanical replace to `.claude/memory/<project>/`. ~18 files, one line each.

**Note on direction of the fix:** the bare form is the numerical majority (16 sites vs. 3). I am nonetheless treating `.claude/memory/<project>/` as canonical because `skills/project-memory/SKILL.md:3,8` is the artifact that *defines* the convention, and because the memory root genuinely does live inside `.claude/`. Standardizing the other way would require moving the directory and contradicting the defining skill. Stated explicitly because it is a judgment call, not a conclusion the tree forces.

#### `SCHEMA-01` — No skill description carries negative scope
**Evidence:** 51/51 state a positive trigger and none state a "do NOT use for" clause. Representative: `skills/api-design/SKILL.md:3`, `skills/system-architecture/SKILL.md:3`, `skills/accessibility/SKILL.md:3`, `skills/capacity-planning/SKILL.md:3`.

**Impact:** matters less than it would in a normal registry, because `WIRE-01` means selection should be by explicit agent directive rather than description match. It matters for the adjacent pairs a human or main-loop invoker must choose between — `capacity-planning` vs `performance-engineering`, `disaster-recovery` vs `business-continuity`, `api-versioning` vs `backward-compatibility`.

**Fix:** add negative scope to the ~8 skills in genuinely adjacent pairs only. Do **not** edit all 51 — the rest are disambiguated by `WIRE-01`'s explicit wiring.

#### `STRUCT-01` — `technical-writer.md` is structurally out of family
**Evidence:** 33 lines vs. 62–305 for every peer. Alone among 15 it has no §-numbered sections, no proportionality tier table, no evidence classification, no stop conditions, and no `engineering-integrity`/`project-memory` load directive (contrast `agents/ux-designer.md:11`). Its frontmatter omits the "Loads the… skills" clause its peers carry (`agents/technical-writer.md:3` vs `agents/ux-designer.md:3`).

**Impact:** the only agent producing durable, externally-consumed artifacts has the weakest verification discipline and no memory protocol — while `agents/technical-writer.md:31` still instructs persistence to memory it has no convention for. Its own quality bar (`:40`) demands "every behavioral claim verified against current code" with no evidence-classification vocabulary to express a claim it *couldn't* verify.

**Fix:** bring to family structure. Draft at `proposed/technical-writer.md`.

---

### MEDIUM

#### `SCHEMA-02` — No agent declares `model:`; all 15 inherit
**Evidence:** all frontmatter is `name`/`description`/`tools` only. **Impact:** inheritance is right for the reasoning-heavy 14, but `agents/qa-runner.md:13,17` defines an explicitly no-judgment, memory-less executor that will inherit Opus for work that is mechanical by design. **Fix:** set a lighter tier on `qa-runner` only; leave the other 14 inheriting and say so deliberately.

#### `SCHEMA-03` — The `skills:` preload field is unused
**Evidence:** six agents commit in their *description* to loading two skills unconditionally (`agents/ux-designer.md:3`, `solution-architect.md:3`, `security-engineer.md:3`, `site-reliability.md:3`, `software-engineer.md:3`) and repeat it as the first body line (`ux-designer.md:11` et al.). No agent uses `skills:`. **Impact:** the prose works, but spends a tool round-trip per agent per session on two always-wanted skills, and the guarantee depends on the model obeying line 11 rather than being structural. **Fix:** `skills: [engineering-integrity, project-memory]` on the agents that load unconditionally; drop the redundant prose.

#### `TOOL-01` — `qa-runner` holds `Write` with no documented need
**Evidence:** `agents/qa-runner.md:4` grants `Write`; `:3` charters it as "returns factual execution evidence — nothing interpreted"; `:17` makes it explicitly memory-less. No procedure in the 62-line body writes a file. **Impact:** write capability on the one agent defined by having no judgment — the exact profile where least-privilege matters most. **Fix:** drop `Write`, or document the artifact it produces.

#### `TOOL-02` — `code-reviewer` is described as read-only but holds `Bash`
**Evidence:** `agents/code-reviewer.md:3` — "Read-only; never modifies code… this agent reads and reasons, it does not execute" — against `:4` `tools: Read, Grep, Glob, Bash`. **Impact:** the description contradicts the grant, and "does not execute" is asserted to the orchestrator while execute capability is present. Almost certainly intentional for `git diff`/`git log`. **Fix:** state the intended read-only `Bash` scope in the body, or remove it.

#### `OVERLAP-02` — `documentation` skill vs. `technical-writer` agent boundary is unstated
**Evidence:** `agents/technical-writer.md:19` loads `documentation` for "structure conventions"; `skills/documentation/SKILL.md:3` claims "Structure and quality bar for technical documentation… Load when writing or updating any documentation artifact" — the agent's whole remit. **Classification: DELINEATE, not merge.** Both are justified; neither states the boundary. **Fix:** scope the skill to conventions/mechanics and the agent to authorship/verification, explicitly on both sides.

#### `GAP-01` — Cross-tree dangling skill reference
**Evidence:** `skills/qa-tooling/SKILL.md:27` references `playwright-best-practices` and `playwright-cli`, which exist only under `%USERPROFILE%\.claude\skills\`. **Impact:** resolves on this machine only; the project tree is otherwise fully self-contained. **Fix:** either vendor them into the project tree or mark the reference as environment-dependent.

---

### LOW

#### `PORT-01` — User-global `Bash` hook depends on a user-local binary
**Evidence:** `%USERPROFILE%\.claude\settings.json` registers `PreToolUse` matcher `Bash` → command `rtk hook claude`. `rtk` resolves to `<user-home>/.local/bin/rtk`. Ten of 15 agents hold `Bash`. **Impact:** on a second machine without `rtk`, every `Bash` call in the suite hits a missing-binary hook. Outside the audited tree, so advisory — but it is the registry's only genuine "breaks on a second machine" item, and it is *not* in the project tree, which is a point in the project's favor.

#### `SETTINGS-01` — Dangling MCP reference
**Evidence:** `settings.local.json` sets `disabledMcpjsonServers: ["webmcp"]`; no `.mcp.json` exists anywhere under the repo. Harmless; remove for tidiness.

#### `SHADOW-01` — User-global definitions shadowed by project ones
**Evidence:** `software-engineer` exists at both `agents/software-engineer.md` (179 lines) and `%USERPROFILE%\.claude\agents\software-engineer.md` (241 lines); `accessibility` exists as both a project and a user-global skill. **Impact:** project precedence means the user-global copies are inert here. The real risk is editing the wrong file in a later session — the user-global `software-engineer` is 62 lines *longer*, so it looks like the more developed one.

---

## Phase 3 — Overlap & boundary analysis

Capability extraction was done from bodies, not names. The result is that this registry has **much less true redundancy than its size suggests**. Only one merge is justified.

### MERGE — 1 pair

| Pair | Evidence | Action |
|---|---|---|
| `dependency-management` + `dependency-upgrades` | `skills/dependency-management/SKILL.md:16-18` ("## Updating — Prefer frequent small updates over rare large ones… don't bump blindly because a bot opened a PR") restates `skills/dependency-upgrades/SKILL.md:8-14` nearly verbatim. An orchestrator choosing between them on description alone is a coin flip for any upgrade task. | MERGE → `dependency-health`. Draft at `proposed/dependency-health/SKILL.md`. |

### Reported as **correctly delineated** — no action, despite surface similarity

These were candidate merges on name similarity and survived inspection. Each **states its own boundary in its own text**, which is exactly the behavior `SCHEMA-01` asks for, already present:

- `disaster-recovery` / `business-continuity` — `skills/business-continuity/SKILL.md:8` opens "`disaster-recovery` covers getting systems back; business continuity covers whether the business can keep operating while they're down." Explicit, correct, mutually exclusive.
- `api-versioning` / `backward-compatibility` — `skills/backward-compatibility/SKILL.md:8`: "`api-versioning` covers explicit API contracts; backward compatibility covers everything else." Explicit.
- `system-architecture` / `domain-driven-design` / `distributed-systems` — distinct bodies of reasoning that cross-reference rather than duplicate (`skills/domain-driven-design/SKILL.md:16` defers coupling/cohesion to `system-architecture`; `skills/api-design/SKILL.md:22` defers idempotency to `distributed-systems`). `skills/domain-driven-design/SKILL.md:24` even carries its own "when not to apply this" gate.
- `accessibility` / `interaction-design` / `design-systems` / `ux-research` — four genuinely different concerns. Their overlap is **not with each other** but with `ux-designer`'s inlined §4.1/§4.3/§4.5/§4.6 — that is `WIRE-01`, and the fix is to wire and thin the agent, not merge the skills.
- `governance` / `risk-management` / `stakeholder-management` / `delivery-tracking` — distinct, and cross-referenced (`skills/risk-management/SKILL.md:20` ties risk acceptance to `governance`; `skills/stakeholder-management/SKILL.md:16` routes conflict resolution to `governance`).
- `capacity-planning` / `performance-engineering` — DELINEATE only: real boundary (pre-release measurement vs. forward projection), already half-stated at `skills/capacity-planning/SKILL.md:16,32`, needs it in the descriptions. Covered by `SCHEMA-01`.

### Category errors — none found
No reusable procedural knowledge is encoded as an agent. `qa-runner` is the one artifact that could look like a mis-scoped skill, but it correctly needs its own context window and tool budget precisely because its purpose is context isolation — agent is the right category. No skill needs promoting to an agent.

### Layer violations — one
`WIRE-01` is a duplication-across-layers finding: domain knowledge lives in both the skill layer and inline in agent bodies, with the inline copy winning. No `CLAUDE.md`/artifact duplication (no project `CLAUDE.md`). No commands or hooks exist to duplicate anything.

---

## Phase 4 — Gap analysis

Derived from tree evidence only.

- **Dangling references:** one — `GAP-01`. No agent names a nonexistent agent; no skill names a nonexistent project skill.
- **Unowned handoff stages:** none. Every handoff target named across the 15 agents (`solution-architect`, `ux-designer`, `technical-writer`, `release-manager`, `security-engineer`, `site-reliability`, `qa-engineer`, `code-reviewer`, `database-engineer`, `performance-engineer`, `incident-commander`, `product-manager`, `product-analyst`, `qa-runner`) resolves to a real configured agent. The lifecycle is closed: frame → specify → design → architect → build → review → verify → secure → release → operate → respond → document.
- **Recurring inline procedure worth extracting:** one candidate. The numbered-assumption format `"Assumption #N: X (because Y). Risk if wrong: Z."` and its Known-fact/Assumption/Hypothesis/Decision-needed vocabulary is restated in four agents (`product-manager`, `product-analyst`, `solution-architect`, `ux-designer.md:47`). `skills/engineering-integrity/SKILL.md` is the natural home. **Ranked below `WIRE-01`** — extract only after wiring, since wiring may make it moot.
- **Coverage holes:** none. The registry has generate, review, verify, execute, release, operate, and retire coverage.

**No new artifacts are proposed.** The registry's problem is unreachable existing material, not missing material. Adding to it now would make `WIRE-01` worse.

---

## Phase 5 — Tech-agnosticism audit (priority objective)

### Hardcoded dependencies

| Artifact | Hardcoded dependency | Line | Category | Why coupled | Agnostic reformulation |
|---|---|---|---|---|---|
| `skills/qa-tooling/SKILL.md` | `package.json`/`jest`/`vitest`/`pytest`/`Playwright`/`axe-core`/`OWASP ZAP` etc. | 12–31 | Test tooling | **Coupled by purpose.** This is a stack-*detection* matrix — "`package.json` → look at `devDependencies`" — i.e. the exact detection-rule shape this audit asks for. | None needed. Correct as written. |
| `skills/dependency-management/SKILL.md` | `npm audit`, `pip-audit`, `bundler-audit` | 14 | Package manager | Named as examples, immediately followed by "language-native equivalent". | Acceptable. Optionally add explicit fallback: if no audit tool is detected, ask rather than assume. |
| `skills/cicd-and-infrastructure/SKILL.md` | Terraform ("a bad Terraform apply") | 14 | IaC | Single illustrative aside in an otherwise tool-neutral section; "plan before apply" is stated as the general capability. | Acceptable. Optionally "a bad IaC apply". |

Sweep covered absolute paths, usernames, `%USERPROFILE%`, vendor CLIs, clouds (AWS/GCP/Azure), CI systems, package managers, shells (PowerShell/bash), path/quoting/env-var syntax, datastores, and client/tenant/org identifiers across all 67 project files.

**Result: zero** secrets, tokens, API keys, tenant IDs, org URLs, client/employer names, internal hostnames, project keys, absolute paths, or username-bearing paths in the project tree. Zero shell-specific syntax — no artifact contains a shell command at all, which is why cross-platform quoting and path-separator breakage cannot occur.

### Capability layer proposal

**Recommendation: do not build one.** The registry already expresses capability intent throughout. `skills/qa-tooling/SKILL.md:12-31` is the only place a concrete-tool mapping is needed, and it already implements exactly the detection-signal → implementation pattern a capability layer would provide: manifest/lockfile/config inspection first, established project tool wins, ask before assuming. `agents/qa-engineer.md:163` enforces it as policy — "never default to a tool because a previous project used it. If the project already has an established tool for a capability, that tool wins." Adding an abstraction layer over one correct table would be pure ceremony, and would violate the "prefer deleting over adding" instruction for no portability gain.

The one substantive improvement is to generalize that detection discipline beyond QA: `skills/dependency-management/SKILL.md:14` and `skills/cicd-and-infrastructure/SKILL.md:14` should reference `qa-tooling`'s detection principle the way `skills/api-versioning/SKILL.md:14` already does ("Match to what the project already does (see `qa-tooling`'s stack-detection principle)"). Two one-line edits, no new artifact.

### Portability test on paper

Projects chosen to maximize distance from what the registry could be assumed to expect:

- **Project A** — Rust CLI tool, Cargo, GitHub Actions, no database, no web UI, no cloud deployment, single maintainer.
- **Project B** — COBOL/DB2 mainframe batch system, in-house scheduler, no CI, no package manager, regulated financial domain, on-prem only.

| Artifact group | Project A | Project B |
|---|---|---|
| All 15 agents | **pass** | **pass** — proportionality tiers, evidence classification, and escalation are stack-independent; `qa-engineer`'s oracle hierarchy explicitly puts regulatory requirements at tier 1, which fits B better than most registries would |
| 50 of 51 skills | **pass** | **pass** — applicability-gated by their own trigger language; e.g. `distributed-systems` simply never loads for A |
| `skills/qa-tooling/SKILL.md` | **pass** | **pass** — detection returns "none detected", and `:12` plus `agents/qa-engineer.md:163` route that to asking rather than assuming |
| `PORT-01` (Bash hook, outside project tree) | **fail** | **fail** — missing `rtk` binary breaks every `Bash` call on any machine without it |

**Registry score: 15/15 agents `pass`, 51/51 skills `pass`, 1 environment-level `fail` outside the audited tree.** No artifact requires adapter changes.

---

## Deliverables

- `findings.json` — machine-readable register
- `remediation-plan.md` — dependency-ordered waves
- `proposed/` — drafts for the one merge and one rewrite. **Drafts only; not installed.**

No existing artifact was modified, moved, deleted, or renamed.
