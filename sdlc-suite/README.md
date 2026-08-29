# SDLC Agent Suite

> **Naming note.** Agents and skills are written with bare names throughout this document (`qa-engineer`, `engineering-integrity`). Installed as a plugin they resolve as `sdlc-suite:qa-engineer` and `sdlc-suite:qa-techniques`. See `USAGE.md` for install, cross-repo use, and unattended runs.

A full software-development-lifecycle framework for Claude Code: **22 agents**, **60 skills**, **6 workflows**, **6 slash commands**, and a shared per-project memory root.

The organizing idea is that the agent which *does* the work is never the agent that *certifies* it. Implementation, review, execution-based verification, security assessment, and release authorization are held by separate agents on purpose, and none of them can quietly absorb another's job.

That rule governs behavior *once an agent is invoked*. It does not make a caller invoke anything — which is why the suite now also carries an `orchestrator` (below) and why the source repository's root `CLAUDE.md` carries a routing policy.

```
sdlc-suite/
├── agents/            22 agent definitions
├── skills/            60 skills (procedural knowledge agents load on demand)
├── workflows/          6 workflows (scripted multi-agent orchestration)
├── commands/           6 slash commands, one per workflow
├── memory-template/   the per-project memory layout, ready to copy
├── autonomy.json      unattended-run policy (see USAGE.md)
└── .claude-plugin/    plugin manifest
```

Counts verified by listing this directory on 2026-08-29. The audit trail (`AUDIT.md`, `findings.json`, remediation record) lives in the source repository and is deliberately not shipped with the plugin — see **Registry health** below.

---

## The four layers, and when each applies

| Layer | What it is | Who holds the plan | Use when |
|---|---|---|---|
| **Skill** | Procedural knowledge, loaded on demand | Claude, following it | You need the *how* of a technique |
| **Agent** | A specialist with its own context, tools, and evidence discipline | Claude, turn by turn | One role's judgment is what's needed |
| **Command** | A thin slash-command entry point that invokes a workflow | The workflow it calls | You want one of the six orchestrations, by name |
| **Workflow** | A JS script the runtime executes, spawning agents | The script | Many agents, or a repeatable orchestration |
| **Memory** | Durable per-project context | The agents that own each file | Something must outlive the session |

The registry is deliberately wired so **no skill is orphaned** — each one is named by at least one agent body at its point of use. Skills do not reliably auto-trigger inside a subagent, so an unnamed skill is effectively unreachable. That property is checked by `/registry-audit`; this document does not restate its verdict.

---

## Naming a skill is not enough: the skills contract

This is the part most likely to be copied wrongly into another registry, so it is stated in full.

Three successive fixes were needed, and only the third worked:

1. **Prose alone.** Agents carried a *Supporting Skills* section saying "load these at the point of use". Thirteen of them had no `Skill` tool at all, so the instruction was literally unfollowable. *(Count of 13 is from the maintainer's record of the pre-fix state, not re-measurable from the current tree — see the arithmetic below.)*
2. **Granting the tool.** Necessary, and still insufficient. `ux-designer` held the `Skill` tool and never invoked `ux-research`: declarative prose describing a good habit is not an instruction an agent must satisfy.
3. **Moving the requirement into the output contract.** Each affected agent's reporting section now opens with a **`Skills loaded`** line naming every skill invoked, with a one-clause reason for each skipped. A report without that line is malformed, which makes the omission visible to the caller instead of silent.

Currently **15 agents** hold the `Skill` tool *and* carry the `Skills loaded` output-contract line — verified by reading the frontmatter and reporting section of every agent file in `agents/`. Subtracting `orchestrator` (added later) and `qa-engineer` (see below) reconciles with the 13 originally fixed.

`qa-engineer` was missed by the first pass entirely: it references its skills in running prose without a *Supporting Skills* heading, so a heading-based sweep did not see it. Any audit of this pattern must search for the behavior, not the heading.

> **Reported effect.** On one real security review, the before/after was zero `Skill` invocations and then five. That measurement comes from the maintainer's record of that run and is **not reproducible from this repository** — treat it as a reported result, not a benchmark.

---

## The 22 agents by lifecycle stage

### Route — *which lenses this task actually needs*
| Agent | Owns | Never |
|---|---|---|
| `orchestrator` | Deciding which specialists a task requires, in what order, and dispatching them | Implements anything — it holds `Agent()` grants for the specialists and no `Write`/`Edit` |

It exists because of the gap the certification rule cannot close: a definition governs an agent's behavior once invoked and cannot make a caller invoke it. Lenses were being skipped not because the agents were wrong but because whoever dispatched them narrowed scope silently. Its output contract requires a **lens ledger** — every trigger, and for each one, dispatched or skipped with the reason the trigger did not fire. A report without the ledger is malformed. Announcing a skip does not authorize it; a fired trigger is discharged by dispatching, or by showing the condition is factually absent.

### Excavate — *what's already there* (for a rebuild or an unfamiliar system)
| Agent | Owns | Never |
|---|---|---|
| `product-archaeologist` | As-built PRD: capabilities, business rules, data model, integration surface, from cited evidence | Recommends what a rebuild should keep, cut, or improve |
| `persona-discovery` | The implemented user roles, from authorization code with `path:line` provenance | Self-promotes a candidate persona |

These two are siblings answering different questions from the same codebase — *what it does* and *who uses it*. Neither infers from what an app "like this" typically has. Their disagreements with each other, and with any existing requirements, are the highest-value output: a capability no persona can reach, or a requirement with no implementation trace, is a finding rather than something to reconcile quietly.

### Frame — *what's worth building*
| Agent | Owns | Never |
|---|---|---|
| `product-manager` | Strategy, prioritization reasoning, outcome validation | Commits a decision — it recommends |
| `product-analyst` | Numbered acceptance criteria — **the oracle everything else traces to** | Reinterprets product intent |

### Design — *how it should work*
| Agent | Owns | Never |
|---|---|---|
| `ux-designer` | Journeys, every interactive state, accessibility *requirements* | Picks visual values, or edits existing files (`Write` only, no `Edit`) |
| `solution-architect` | Boundaries, contracts, ADRs, measurable NFRs | Writes production code; blocks unilaterally |

### Build — *make it exist*
| Agent | Owns | Never |
|---|---|---|
| `software-engineer` | Implementation, Tier 1 architecture, baseline security hygiene | Certifies its own work |
| `ui-engineer` | Frontend architecture, accessibility *implementation* | Designs UX, or certifies its own spec fidelity |
| `database-engineer` | Schema, migration safety, rollback *design* | Executes its own rollback rehearsal |

### Verify — *prove it works, independently*
| Agent | Evidentiary basis | Verdict vocabulary |
|---|---|---|
| `code-reviewer` | Reads | Must Fix / Should Fix / Nit × High / Med / Low confidence |
| `qa-engineer` | Executes | Verified / Falsified / Unverified / Untestable |
| `qa-runner` | Executes only, judges nothing | Verified / Untestable / Incomplete (about the *run*) |
| `security-engineer` | Attack-path reasoning | Critical / High / Medium / Low / Informational |
| `performance-engineer` | Measures | Measured / Modeled / Assumed / Unknown |

Overlap between these is a **feature**: two independent methods agreeing is a stronger signal than either alone.

### Persona testing — *does it work for real user types*
| Agent | Owns |
|---|---|
| `persona-runner` | One timeboxed exploration session as one persona |
| `boundary-prober` | Cross-persona authorization probing, API layer included |
| `journey-orchestrator` | Multi-actor flows, with a ledger as the only cross-persona state channel |

### Ship & operate
| Agent | Owns | Never |
|---|---|---|
| `release-manager` | Gate classification, go/no-go **recommendation** | Deploys |
| `technical-writer` | Docs, runbooks, release notes | Asserts an unverified behavioral claim |
| `site-reliability` | SLI/SLO, observability, capacity, first-response triage | Runs formal incident command |
| `incident-commander` | Incident coordination, mitigation decisions, post-incident review | Implements the fix |

---

## The end-to-end flow

```
                        ┌─ product-manager ──┐  prioritization stays human
   IDEA ────────────────┤                    ├──────────────────────────────┐
                        └─ product-analyst ──┘  numbered acceptance criteria │
                                                            │                │
                        ┌───────────────────────────────────┴──────┐         │
                        ▼                                          ▼         │
                  ux-designer  ◄──── bidirectional ────►  solution-architect  │
                  (states, a11y reqs)                     (boundaries, NFRs)  │
                        │                                          │         │
                        └──────────────────┬───────────────────────┘         │
                                           ▼                                 │
                    ┌──────────────────────┼──────────────────────┐          │
                    ▼                      ▼                      ▼          │
             software-engineer        ui-engineer         database-engineer   │
                    └──────────────────────┼──────────────────────┘          │
                                           ▼                                 │
        ╔══════════════════ INDEPENDENT VERIFICATION ══════════════════╗      │
        ║  code-reviewer   qa-engineer   security-engineer   perf-eng  ║      │
        ║     (reads)      (executes)     (attack paths)    (measures) ║      │
        ║                       │                                       ║     │
        ║                  qa-runner  ◄── delegated for large output    ║     │
        ╚═══════════════════════╪═══════════════════════════════════════╝     │
                                ▼                                             │
                    persona-discovery → persona-runner                        │
                                      → boundary-prober                       │
                                      → journey-orchestrator                  │
                                ▼                                             │
                         release-manager ──── RECOMMENDATION ─────► HUMAN ◄───┘
                                │                                    │
                        technical-writer                          deploys
                                ▼
                    site-reliability ──► incident-commander (if it breaks)
                                └──────────► retrospective ──► memory
```

`orchestrator` is not a stage in this diagram — it sits above it, choosing which of these boxes a given task actually needs and accounting for the ones it skipped.

Two properties hold at every arrow:

1. **Traceability.** Everything downstream cites `product-analyst`'s numbered criterion IDs. Those IDs are Tier 3 of `qa-engineer`'s Oracle Hierarchy, which is the suite's tie-breaker when sources of truth disagree — regulatory requirement first, the agent's own inference last, and a conflict is *reported*, never silently resolved by taking the higher tier.
2. **Human authority at the irreversible points.** `release-manager` recommends and cannot deploy. `product-manager` recommends and cannot commit. `incident-commander` needs confirmation for irreversible mitigation. `boundary-prober` stops on the first cross-tenant leak.

---

## Workflows

Workflows script the orchestration so it's repeatable and its intermediate results never fill a context window. Run `/workflows` to watch progress, `s` to save a run.

| Command | What it does | Agents |
|---|---|---|
| `/sdlc-feature` | Full lifecycle: requirements → design → build → 4-lens verification → readiness | ~12 |
| `/independent-review` | Four evidentiary bases on one change, every finding adversarially refuted, then merged | ~10 |
| `/persona-qa-sweep` | Derive personas → explore as each → probe every pair → triage | scales with personas |
| `/release-readiness` | Five gates in parallel from their owning agents → classified recommendation | 6 |
| `/system-archaeology` | Derive who + what from an undocumented system in parallel, cross-check, synthesize an as-built PRD | 6 |
| `/registry-audit` | Re-audits this registry: schema, orphans, overlap, agnosticism, consistency | ~12 |

```bash
/sdlc-feature          Add CSV export to the reporting dashboard
/independent-review    the diff on feature/checkout-v2
/persona-qa-sweep      { "target": "http://localhost:3000", "env": "staging" }
/release-readiness     release 2.4.0
/system-archaeology    { "scope": "the billing subsystem", "observeTarget": "http://localhost:8080" }
/registry-audit
```

Commands are shown bare for readability, matching the naming note at the top. Installed as a plugin they resolve as `/sdlc-suite:sdlc-feature` and so on; the six command files ship under `commands/` in this plugin, so the prefixed form is the one guaranteed to resolve.

`/system-archaeology` runs **static-evidence-only** unless you pass `observeTarget`, and it refuses to guess at a safe one — dynamic observation is opt-in and must name a non-production target.

### Quality patterns these encode

- **Adversarial verification** — a finding is refuted by an agent with a *different* evidentiary basis before it's reported. `independent-review` sends `code-reviewer`'s findings to `qa-engineer` and vice versa.
- **Pipelining over barriers** — each lens cross-checks as soon as it finishes rather than waiting for the slowest.
- **Fail-closed defaults** — a gate agent that returns nothing is `Missing`, never "probably fine". A refuter that returns no verdict marks the finding `Unverified`, not confirmed.
- **Honest stop conditions** — `persona-qa-sweep` halts above 12 personas because that's `persona-discovery`'s own signal that it split on the wrong axis, rather than fanning a wrong decomposition across dozens of agents.

### Four important caveats

**1. Workflow subagents run in `acceptEdits` — file edits are auto-approved.** Several agents here have "stop and confirm before" boundaries (`software-engineer` §13, `ui-engineer` §5, `database-engineer`). Those are *prompt-level* commitments; the workflow runtime does not enforce them. `sdlc-feature` runs its build agents with `isolation: 'worktree'` so edits land in a throwaway copy, but **review the diff before merging** — don't treat a workflow-produced change as pre-approved.

**2. Workflows accept no mid-run human input.** That's why every workflow here terminates in a *recommendation* with an explicit `humanDecisionRequired` list, and why sign-off-shaped stages are separate workflows rather than one long chain.

**3. `incident-commander` is deliberately not driven by a workflow.** Incident response needs human judgment on irreversible mitigation *during* the run, which is exactly what a workflow cannot provide. Use the agent directly. Same reasoning limits `product-manager`: prioritization is a human business-value call, so `sdlc-feature` starts from an already-prioritized initiative.

**4. Fanning agents out *outside* a workflow gives you none of the workflow's isolation.** `sdlc-feature` runs its build agents with `isolation: 'worktree'`; calling `Agent` directly two or three times in one message does not — they share one working tree, one branch, and one uncommitted diff. That is often what you want for a split task, but it has three failure modes worth planning around:

- **Whole-tree git operations are destructive to a peer.** A `git stash -u` taken to measure a clean baseline sweeps up the other agent's in-flight work. Give each agent an explicit ownership list of paths, and tell it that a shared tree makes `stash`/`clean`/`reset`/branch-switch off limits.
- **Shared checks go red for reasons that belong to someone else.** A typecheck or suite run while a peer is mid-edit reports their broken state as readily as yours. Agents need to be told this in advance, or they will either "fix" a peer's file or report their own work as broken.
- **The join is what gets dropped, not the files.** Two agents given disjoint paths will not conflict — they will each build to the interface and neither will connect it, producing a green suite over a feature that does nothing. Name the seam in both briefs and say which side closes it, and make the milestone's acceptance exercise the joined path end to end.

`qa-runner` also appears in no workflow script — correctly. It's reached at runtime via `Agent(qa-runner)` from `qa-engineer`, `database-engineer`, and `performance-engineer` when a run would otherwise flood their context.

---

## Memory

One root, `.claude/memory/<project>/`, shared by every agent, with per-file ownership (`vision.md` → product-manager, `requirements/` → product-analyst, `decisions/` → solution-architect, `quality-history.md` → qa-engineer, and so on — see `memory/README.md`).

Two rules that matter more than the layout:

- **Project isolation is absolute.** No agent reads or writes another project's subdirectory, and no convention, risk, or pattern crosses between projects without being re-established.
- **Memory says where to look *harder*, never where to look *less*.** Nothing that would justify skipping a future check gets recorded. A module remembered as "usually fine" still gets tested to the tier its current risk warrants.

The highest-value thing stored is **outcome tracking on hypotheses** — did the architectural bet hold, did the design pattern work for users, did the "low severity" call turn out to matter. That's what stops an assumption that already proved wrong from being quietly reused.

---

## Conventions any new agent must follow

Adding an agent or skill? These are the invariants `/registry-audit` checks:

1. **Frontmatter** — `name` kebab-case and matching the filename stem; `description` states *when to invoke* and *when not to*, not just what it is.
2. **Least privilege** — every tool in `tools:` must be exercised by a procedure in the body. If the body says "delegate to X", the frontmatter needs `Agent(X)` — a prose delegation instruction with no grant is unimplementable, and that was the one BLOCKER the original audit found.
3. **Skills get wired, three ways at once** — name the skill in the agent body at its point of use, grant the agent the `Skill` tool, and require a `Skills loaded` line in its output contract. Any one of the three alone has already been observed to fail (see *the skills contract* above). An unnamed skill is unreachable; an ungranted one is unloadable; an uncontracted one is skippable in silence. *Known exception at time of writing: `technical-writer` instructs loading four skills in its body but holds no `Skill` grant — same defect class as the thirteen already fixed, left for the maintainer rather than patched by the document that describes it.*
4. **Negative scope on adjacent skills** — where two skills could both plausibly fire, both say what they're *not* for.
5. **Evidence vocabulary** — pick the classification scheme that fits the agent's evidentiary basis, and never let an assumption read as a confirmed fact.
6. **Escalate only to what exists** — route to a real configured agent, and don't default to "the human" for something an agent already owns.
7. **Canonical memory path** — `.claude/memory/<project>/`, never a bare relative `memory/`.

## Registry health

Run `/sdlc-suite:registry-audit` to re-check the registry — schema validation, orphan detection, overlap analysis, and tech-agnosticism, with every finding adversarially verified before it is reported. It audits this plugin by default; pass a path to audit a different registry root.

Health is whatever that run reports, not a number recorded here. An earlier audit trail (`AUDIT.md`, `findings.json`, remediation record) lives in the source repository and is deliberately not distributed with the plugin — a stale "0 findings" claim shipped alongside the code is worse than no claim, because it invites skipping the check.

Known open findings, re-checked against the current agent files on 2026-08-29:

- `qa-engineer` documents a delegation to `persona-runner` in its body without holding the corresponding `Agent(persona-runner)` grant. **Confirmed still open.**
- `technical-writer` is instructed to load `api-design`, `documentation`, `disaster-recovery` and `backward-compatibility`, but its frontmatter grants no `Skill` tool. **Confirmed still open.**
- Rollback-rehearsal ownership was previously reported as described inconsistently across `release-manager`, `database-engineer`, and the `rollback-strategies` skill. **Not re-verified in this pass** — treat as unconfirmed until `/registry-audit` runs again.

These are design decisions left to the maintainer rather than silently patched.
