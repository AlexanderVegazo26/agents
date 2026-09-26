# Agentic-readiness review — 2026-09-24

Five independent reviewers audited this repository for one question: **what has
to change for the suite to run with minimal human intervention — self-healing on
each detected error, learning from each execution, and turning repeated
processes into skills?**

| Lens | Method |
|---|---|
| 1. Self-improvement loop | Code trace run → `outcome.json` → `distil.py` → `learnings/` → agent load; synthetic distil runs in scratch |
| 2. Self-healing | Failure-mode matrix over all 6 workflows; reproduced in the `_wiring.test.js` sandbox replica |
| 3. Human-gate audit | Every confirm/ask/stop gate in `sdlc-suite/` classified; policy precedence executed |
| 4. Process → skill extraction | Git log, CONTRIBUTING, runbooks, tools and personal memory mined for un-encoded procedures |
| 5. Empirical run | Isolated worktree: all gates run with captured exit codes, synthetic outcomes fed to distil/decay, deliberate breakage |

All reviews were read-only against the main tree; the empirical run used a
throwaway worktree and left it clean. This builds on, and does not repeat,
[`platform-review-2026-09-01.md`](platform-review-2026-09-01.md).

---

## Verdict

**The architecture for a self-improving suite is largely present. None of it has
ever run.** Every CI gate is green (23/23 exit 0, measured), and that green says
nothing about self-improvement, because no gate exercises the loop end to end.

- `.claude/runs/` does not exist in this repo, `nawi/`, or any worktree — **zero
  runs have ever been recorded**.
- `learnings/` holds zero ratified learnings; `candidates/` holds `.gitkeep`.
- **No code path loads a learning into an agent.** Loading is prose in one skill.
- The self-heal primitives (`withRetry`, `rewritePrompt`, the failure classifier)
  are tested in isolation and **have zero production callers**.

Five reviewers converging independently on the same root causes is the strongest
signal in this report. Findings confirmed by two or more lenses are marked **⟂n**.

---

## Root causes, ranked

| # | Root cause | ⟂ | Evidence | Effect |
|---|---|---|---|---|
| R1 | 4 of 6 commands pass `args: "$ARGUMENTS"` (a string) → `args?.policy` undefined → `RUNTIME_DIR` null → every bridge call returns null | ⟂4 (L1,L2,L3,L5) | `commands/{sdlc-feature,independent-review,release-readiness,system-archaeology}.md:10` (persona-qa-sweep and registry-audit already pass objects); `sdlc-feature.js:109-113,149`; replica: dead verify lenses → `status: completed`, `outcomeRecorded: false`, 0 run dirs | Recording, breaker, policy **all off** as commands are written. The loop has never had an input. |
| R2 | Policy precedence fails open: explicit plugin path beats the repo's `.claude/autonomy.json` | L3 (executed) | `_policy.js:163-166`; repo sets `roadmapCommit=false`, result `true` | A repo's lockdown is silently re-enabled — a safety defect, not just an autonomy one |
| R3 | Learnings are never loaded, and aren't shipped | ⟂4 (L1,L2,L4,L5) | 0 hits in `_brief.js`/`_policy.js`; plugin `source: ./sdlc-suite`, `learnings/` at repo root; 7 agents never reference `project-memory` yet distil addresses learnings to 3 of them | The loop cannot close even with perfect input |
| R4 | `distil.py` filters by `.last-distil` marker *before* grouping | L5 (measured) | Run1 emit → run2 same sig emit → "0 of 1 met the floor"; 12 sigs / cap 10 → 2 "DEFERRED … reconsidered next run" are lost | Recurrence can never accumulate if distil runs per-run; the tool prints a false assurance |
| R5 | Failure classification gets no input: `classify({})` → always `tool` | ⟂3 (L1,L2,L5) | runtime block ×6 (`sdlc-feature.js:287`); records lack `agentType` | Taxonomy inert, signatures carry no cause, distil falls back to `appliesTo: [orchestrator]`, which workflows never invoke |
| R6 | Breaker trip marks the phase complete; breaker never resets | ⟂2 (L2,L5, replica) | `recordPhase` calls `completePhase` before the check; `_failure.js:152-162`; `_wiring.test.js:561` asserts the wrong behaviour | Resume after trip returns a degraded `completed` with 1 of 4 lenses; fixing only half re-trips forever |
| R7 | Dead refuter deletes the finding | L2 (replica) | `sdlc-feature.js:767` `refuted: v?.refuted !== false` — null → refuted; independent-review does the opposite | 4 null refuters → 0 confirmed, 0 failure records. The 09-01 review listed this as working — **correction** |
| R8 | No repair loop anywhere | ⟂3 (L2,L4,L5) | No rounds/iterate in any workflow; git log: 6a746ad, 10ad72f, 652f983, 8951c41 are human-driven fix-after-review commits | The most repeated human process in the repo is unautomated |
| R9 | Generator prunes any skill not in `sdlc-suite/` | L4 | `generate_trees.py:216-218,245,535-542`; only `.kimi-code` has `local_skills` | The repo **cannot author its own skills**: anything an agent creates is deleted and fails CI |
| R10 | No unattended entry point; distil/decay are `workflow_dispatch` only and see 0 runs on a hosted runner | ⟂3 (L1,L3,L5) | `distil.yml:9,48`, `decay.yml:9`; runs gitignored `.gitignore:90`; README calls them "scheduled/monthly" | Nothing happens unless a human starts it; CI distil is always green and always empty |
| R11 | Decay is inverted | L1 | `distil.py:812-848` stamps a learning when its failure *keeps recurring* | Effective learnings retire at 180 days; ignored ones are re-confirmed forever |
| R12 | Hand-ported runtimes feed nothing | ⟂4 (L1,L2,L4,L5) | 0 matches for `_state`/`outcome`/`_failure` in `commandcode-suite/workflows/` and `.kimi-code/workflows/`; commandcode still returns the string `_wiring` bans | Learning is Claude-only; 2 of 3 runtimes are blind; `_wiring` doesn't cover them |

---

## The plan

Ordered by dependency: each phase is inert without the one before it.

### Phase 0 — Make it run at all (all S, ~1 day)

Nothing below does anything until these land.

> **R1 and R2 must land in the same change.** Fixing the args shape alone
> makes R2 worse: today the explicit plugin path overrides the repo policy only
> when the host model happens to pass it. Once every command passes it, a
> repo's lockdown is overridden on *every* run. Resolution order must be
> **repo `.claude/autonomy.json` → explicit arg → plugin default**, with the
> explicit `policy` value treated as a fallback, never an override. The
> precedence test is the gate for merging the args fix.

| Change | Target | Test that proves it |
|---|---|---|
| Repo `.claude/autonomy.json` wins over an explicit path and over the plugin default | `workflows/_policy.js:163` | precedence test in `_policy.test.js` (repo `false` + explicit plugin path → `false`) |
| The 4 string-args commands pass a literal object `{initiative:"$ARGUMENTS", runtimeDir:…, policy:<fallback>}`; a string `args` without `runtimeDir` returns `selfHealDisabled: true` / ENV_DRIFT stop, **never** `completed` | the 4 commands in R1, 6 workflows | `_wiring` case for string args |
| Treat `outcomeRecorded: false` as a blocked gate in the return value | runtime block | `_wiring` assertion |
| A required null (terminal agent, refuter) means `stopped`/`incomplete`; refuter null → `failed`, not refuted | 6 workflows, `sdlc-feature.js:767` | replica: 4 null refuters → findings survive |
| One smoke test that runs a real workflow and asserts `outcome.json` exists on disk | CI | measured file, not a green count |

### Phase 1 — Real self-healing (M)

Principle: **detect → classify → repair → independently re-verify → record.**
The implementer never certifies its own repair (`ROUTING.md`).

1. **Structured error envelope.** Agent schemas gain `{error:{class,detail}}`;
   `classify` reads it. `recordFailure` writes `agentType` and a normalised
   `cause`. (R5)
2. **Call the primitives that already exist.** Wrap agent dispatch in `withRetry`
   with `rewritePrompt` for BAD_INPUT; honour `POLICY.<class>.maxAttempts`.
3. **Fix resume-after-trip — both halves together.** `failPhase` on trip **and**
   an epoch-scoped breaker fold (stamp failures with the attempt id; fold only
   the current epoch). Fix the test at `_wiring.test.js:561`. Add
   trip → fix → resume → pass. (R6)
4. **Bounded repair loop** (max 2 rounds) in `sdlc-feature.js` and
   `independent-review.js`: confirmed Must-Fix findings → the *same builder* in
   its worktree → re-run *only the lenses that raised them* → breaker entry and
   escalation if round 2 fails. Record `repairRounds` in outcome. (R8)
5. **Cross-run breaker memory.** 9 identical (Verify, tool) failures across 4
   runs tripped nothing (measured). At run start, read recent failure
   signatures and pre-warn / pre-route.
6. **Pre-flight doctor** `tools/doctor` (eol_check + generate_trees --check +
   roster/frontmatter parse + init --check) as a plugin `SessionStart` hook
   (report-only) and a phase-0 step. May auto-apply **only** LF normalisation,
   then re-run validators before continuing. Directly targets the
   "agent type not found" CRLF failure in `CLAUDE.md`.
7. **Deduplicate the runtime block.** The ~250-line block is byte-identical in
   6 files (hash `4bf460cf`), so every fix above lands 6×. Generate it via
   `generate_trees.py` or assert hash parity in `_wiring`.

### Phase 2 — Close the learning loop (M)

Tiered, so that **every execution teaches something** without removing the
cross-repo safety gate:

| Tier | Scope | Written by | Human gate |
|---|---|---|---|
| T0 | `outcome.json` every run | `_state.js` (fixed in Phase 0) | none |
| T1 | `.claude/memory/<project>/lessons-learned.md`, `quality-history.md`, `technical-debt.md` | **new deterministic close-of-run retrospective phase** in every workflow, from refutations, failures, blocked gates, open handoffs | **none** (per-project, never leaves the repo) |
| T2 | `learnings/*.md` (cross-repo) | `distil.py`, ≥2 distinct runs | human merge, with an independent agent pre-review |
| T3 | Definition patch (Phase 3) | gated pipeline | human merge |

Required fixes:
- **Load deterministically.** `_brief.js` / `withPolicy()` reads matching
  `learnings/*.md` and T1 memory, injects them the way the policy table is
  injected, and records `learningsLoaded[]` per agent in `phase-*.json` and the
  outcome. Add `project-memory` to the 7 agents that lack it. (R3)
- **Ship learnings with the plugin** (`sdlc-suite/learnings/` or resolve via
  `${CLAUDE_PLUGIN_ROOT}`).
- **Fix `do_distil`:** group over the whole store; use the marker only to decide
  what is new. Deferred candidates must actually reappear. (R4)
- **Signatures that can recur:** closed-vocabulary `findingClass` in finding
  schemas; key on (lens, findingClass, verdict); drop run-local criterion IDs.
  Paraphrases currently never merge (measured).
- **Rewrite the refutation template.** The generated `**Check:**` line tells
  agents to raise *fewer* findings — the opposite of `learnings/README.md`'s
  "look harder, never less". Add a `test_distil` fixture that fails on
  skip/suppress wording in any template.
- **Decay on effectiveness, not recurrence:** stamp "effective" when the
  signature's rate after first load drops; separate "problem gone" (keep or
  promote to T3) from "note ignored" (escalate). (R11)
- **Consumer-side distil:** run distil as a post-run step in the adopting repo,
  emit **redacted** candidates only, and export them as a PR to the suite repo.
  Drop the unmeetable "month of real run data on CI" precondition.
- **Redaction gap:** a short `password=` assignment recurring in 2 runs was
  published verbatim into a candidate (measured). Add a credential-assignment class to `redact.py`.

### Phase 3 — Self-improving definitions (L, gated)

Today a learning can never change a skill or agent. The safe path:

1. A learning is `corroborated` (≥4 runs) **and** Phase 2's effectiveness metric
   shows it effective or persistently ignored.
2. `distil.py --propose-patch` drafts a minimal diff to the named SKILL.md / agent
   in `sdlc-suite/`, on a `learnings/patch-*` branch — **never the live working
   tree**, because definitions are read fresh per invocation.
3. A gate script (`tools/patch_gate.py`) runs `generate_trees.py` then `--check`,
   `eol_check.py --check`, every `validate.py`, `bump.py --check`, and the
   workflow tests.
4. `independent-review` with code-reviewer plus one lens; **the drafting agent is
   excluded**. The gate script's result is evidence for the reviewer, not a
   certification by the drafter.
5. Human merge. If the bot opens the PR with `GITHUB_TOKEN`, CI will not run
   (`distil.yml:64-70`) and the only verification would be the bot's own — use
   an App/PAT token.

### Phase 4 — Processes → skills

**Prerequisite (S): add a `local_skills` tier for `.claude/`** in
`generate_trees.py`. Without it, repo-maintenance skills have nowhere to live:
`sdlc-suite/skills/` ships to adopters who have no `bump.py`, and `.claude/skills/`
is pruned. (R9)

| Process | Evidence it repeats | Form | Loaded by · report line |
|---|---|---|---|
| **Authoring/amending a definition** (meta-skill) | ea269bf, 652f983, 8951c41, dd3c5ee, 36a3fdd, aca6166, e6dd6e5; invariants only in CONTRIBUTING.md:103-140 | New shipped skill `definition-authoring`: frontmatter rules, negative scope, Skill grant + point-of-use mention, report line, "look harder never less", semver, LF, canonical tree only | technical-writer, software-engineer, orchestrator · `Definition changes: <file> vX→vY; invariants checked; generate_trees --check EXIT=n; bump --check EXIT=n` |
| **Repetition → skill proposal** | distil has no procedure signature; commit aca6166 was a human noticing | Extend `retrospectives` (loaded today only by incident-commander): step sequence seen ≥2× → draft SKILL.md via the meta-skill; later `_state.js` records action sequences for a real `playbook` signature | orchestrator at run end · `Promotion candidates: <n> / none` |
| **Act on review → re-review** | 6a746ad, 10ad72f, 652f983, 8951c41 | Phase 1 item 4 (workflow phase `remediate-findings`) | orchestrator on request-changes · `Remediation: round k/N; closed <ids>; deferred <ids>` |
| **Stale-claim sweep after a change** | 13a332b, 6ca13b6, e6dd6e5, 8951c41; live stale lines: CONTRIBUTING.md:37, :192, ROUTING.md:143, CLAUDE.md:50 | Extend `documentation` with "claims falsified by this diff"; optional `claims_check.py` | technical-writer · `Stale claims: checked <n>; corrected <list> / none` |
| **Port workflow to 3 runtimes** | CLAUDE.md:28-31; 6a746ad touched all 6 sdlc-suite workflows and neither port | Repo-local `port_parity.py` (phases, schemas, runtime-module use) + local skill `port-workflow` | software-engineer on `sdlc-suite/workflows/` edits · `Workflow ports: commandcode <ok/gap>, kimi <ok/gap>` |
| **Handoff-debt discharge** | e6dd6e5 | Extend `project-memory`: persist handoffs to `technical-debt.md`, orchestrator re-dispatches at run start | orchestrator · `Open handoffs: <n> carried, <n> dispatched` |
| **Pre-PR gate** | CONTRIBUTING.md:52-61, 4 manual commands | pre-commit hooks for `counts --check`, `generate_trees --check`, `bump --check` (also: pre-commit is **not installed** — `.git/hooks` has only samples) | hook |
| **Redaction before publishing** | 10ad72f, 13a332b | pre-commit `redact.py --scan` on staged `docs/**`, `*.md`; rule: never allowlist a whole document path | hook |
| **Portable lessons stuck in personal memory** | heredoc-collapses-backslashes: 0 hits in any skill; node-check-inert-on-esm only as CI tool; sinks-with-feedback-edges only in ROUTING.md | Extend `qa-tooling` and `code-review-craft` | existing `Skills loaded` line |

**CI auto-fix** (`.github/workflows/autofix.yml`, S): open a fix PR for
`counts.py --write`, CRLF→LF (needs new `eol_check --fix`), and regeneration
**only** when the diff touched `sdlc-suite/` and not the generated file.
**Stay fail-only:** regeneration over a hand-edited generated file (auto-fixing
discards the edit), validate.py, syncheck, `_wiring`, bump, gitleaks.

**Remove dead tooling:** the four `convert-agents.py` and four `sync-skills.py`
(no callers; recommended for deletion at review:1147, still present).

### Phase 5 — Fewer human gates, and an entry point that needs none

38 gates found: **20 can go** (13 automate under `autonomy.json`, 6 replace with an
independent agent, 1 remove); **18 should stay** as human or structured stops.

| Change | Effort |
|---|---|
| **Gate registry:** every prose "stop and confirm" names a policy key; add missing keys (force-push, destructive test data, env/target allowlists, Tier-3 strategic); `_wiring` asserts every gate line names a key. Today 0 prose gates name a key, and "silent means blocked" makes them permanent stops. | M |
| Add the unattended clause to the 12 agents lacking it (7 carry stop/ask gates), and an autonomy-policy pointer in `engineering-integrity` §7 | S |
| Replace human ratification with an independent agent for: persona promotion, ambiguous capabilities (product-analyst), runbook confirmation (qa-runner walks it in non-prod), UI-pattern sign-off (dispatch ux-designer), decay retirement | M |
| Route non-stakeholder `openQuestions` to product-manager instead of the human | S |
| Derive `humanDecisionRequired` from `POLICY.gates`; enforce `mode`, `onBlocked:halt`, `escalation.channel` or drop them from the schema; reduce agent STOP reports like BLOCKED entries | S |
| `ROUTING.md:91` "ask the user and wait" before skipping a lens → in unattended mode, never skip, always dispatch | S |
| `init.mjs --write-permissions` (opt-in): permission prompts are the most common silent stop in headless runs | S |
| **Unattended entry point:** a weekly scheduled routine (local or cloud, not a GH Action — the run store is gitignored) running `/sdlc-suite:registry-audit` with object args → `distil.py --emit` → PR | M |

---

## Tradeoffs we deliberately did not resolve for you

The goal is minimal intervention, not zero. Two human checkpoints carry real
weight, so each is presented with a recommended default rather than removed.

**Cross-repo learning merge.** *Recommend: keep the human merge; add an
independent reviewer agent in front of it; make T1 per-project memory fully
automatic.* "Auto-merge single-repo learnings" collapses into T1, which needs no
gate at all. The cross-repo merge is currently the only check against customer
names: the denylist is gitignored, so tier-1 redaction is inert on the runner.

**`act.*` gates.**
- **Automate:** `sharedComponentModification` (in-repo, git-reversible, cost is one
  mandatory review), `defectFiling` (move from `decide` to `act`, default on with
  signature dedup).
- **Automate for disposable environments only:** `loadTestAgainstSharedEnv`,
  `destructiveMigration`. This needs a new environment dimension in the schema.
  Keep prod human.
- **Keep human:** `externalDataSend`, `grantAccess`, `incidentFailover`,
  `productionConfigChange`, risk acceptance, go/no-go for deploy.
- **Note:** `act.deploy=true` does nothing, because no deploy actuator exists.

## What not to do

- **Don't let any agent certify its own repair or patch.** Every self-heal and
  self-patch path above re-verifies with a different lens.
- **Don't write auto-edits into the live tree.** Definitions are read fresh per
  invocation; a bad edit breaks the next dispatch.
- **Don't auto-regenerate over a hand-edited generated file.** It silently
  discards the edit, and this is the hazard `CLAUDE.md` documents.
- **Don't trust green CI as evidence of self-improvement.** 23/23 gates pass today
  on a loop that has never processed one real run.

## Porting cost

Everything in `sdlc-suite/workflows/` reaches `.claude/` via the generator.
`commandcode-suite/workflows/` and `.kimi-code/workflows/` are hand-ported and
currently lack `_state`, `_failure`, `_policy` and outcome recording entirely
(R12). Either:
- budget each Phase 0–2 change ×3, and add a runtime-agnostic contract test with
  the same stub scenarios per runtime; or
- explicitly declare those runtimes "no self-improvement" in their READMEs.

The silent middle ground is what exists today.

## Suggested first PR

Phase 0 in full plus R4 (the distil marker fix). The args fix and the
precedence fix ship together, never apart; see the note under Phase 0. This is roughly a day of S-effort
work, and it produces the first real `outcome.json` and the first candidate that
could ever reach an agent. Each fix needs a test that fails before it and passes
after. The PR goes through `independent-review` before merge.
