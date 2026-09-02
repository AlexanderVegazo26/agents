# SDLC Agent Suite for Command Code

A full software-development-lifecycle framework for **Command Code** — 21 agents, 60 skills, 6 scripted workflows, and a shared per-project memory root.

This is a faithful port of the [sdlc-suite](../sdlc-suite) Claude Code plugin, re-targeted to Command Code's native `.commandcode/` layout. The organizing idea is unchanged: **the agent that does the work is never the agent that certifies it.** Implementation, review, execution-based verification, security assessment, and release authorization are held by separate agents on purpose, and none of them can quietly absorb another's job.

```
commandcode-suite/
├── agents/          21 agents (.commandcode/agents format — Markdown + YAML frontmatter)
├── skills/          60 skills (.commandcode/skills/<name>/SKILL.md format)
├── commands/        6 workflow launchers (commands/*.md)
├── workflows/       6 standalone Node orchestration scripts + _runner.js
├── memory-template/ per-project durable-context scaffold
├── autonomy.json    pre-authorization policy for unattended runs
├── convert-agents.py  regenerate agents/ from sdlc-suite/agents/ (Claude → Command Code)
├── verify-bodies.py   confirm agent bodies are verbatim copies of the source suite
└── validate.py        structural sanity check
```

> **Model-agnostic by design.** Agents, skills, and workflows carry no model pins. Only `qa-runner` (an execution specialist that benefits from a cheap, fast model) pins one — `claude-sonnet-5`. Everything else follows the session's `/model`, so the suite runs on any Command Code model, DeepSeek included.

## The four layers

| Layer | What it is | Who holds the plan | Use when |
|---|---|---|---|
| **Skill** | Procedural knowledge, loaded on demand | The model, following it | You need the *how* of a technique |
| **Agent** | A specialist with its own context, tools, and evidence discipline | The model, turn by turn | One role's judgment is what's needed |
| **Workflow** | A Node script the CLI executes, spawning headless sessions | The script | Many agents, or a repeatable orchestration |
| **Memory** | Durable per-project context | The agents that own each file | Something must outlive the session |

The registry is deliberately wired so **no skill is orphaned** — every one of the 60 is named by at least one agent body at its point of use. Skills do not reliably auto-trigger inside a subagent, so an unnamed skill is effectively unreachable. That property is checked by the `registry-audit` workflow.

## Quick start

The suite is self-contained and lives in this repo. Use it from any project by copying it into that project's `.commandcode/`, or from here by running the workflows directly:

```bash
# Full lifecycle (requirements → design → build → verify → readiness)
node "<repo>/commandcode-suite/workflows/sdlc-feature.js" "Add CSV export to the reporting dashboard"

# Four-lens independent review
node "<repo>/commandcode-suite/workflows/independent-review.js" "the diff on feature/checkout-v2"

# Release gates → recommendation
node "<repo>/commandcode-suite/workflows/release-readiness.js" "release 2.4.0"

# Persona-based QA (requires a non-production target)
node "<repo>/commandcode-suite/workflows/persona-qa-sweep.js" --target http://localhost:3000 --env staging

# Reverse-engineer an undocumented system
node "<repo>/commandcode-suite/workflows/system-archaeology.js" "the billing subsystem"

# Audit this registry
node "<repo>/commandcode-suite/workflows/registry-audit.js"
```

Inside a Command Code session, invoke the same scripts via the launcher commands (`commands/*.md`) — the model runs the script and relays the result. See `USAGE.md` for install, cross-repo use, and unattended runs.

## The 21 agents by lifecycle stage

### Excavate — *what's already there*
| Agent | Owns | Never |
|---|---|---|
| `product-archaeologist` | As-built PRD: capabilities, business rules, data model, integration surface, from cited evidence | Recommends what a rebuild should keep, cut, or improve |
| `persona-discovery` | The implemented user roles, from authorization code with `path:line` provenance | Self-promotes a candidate persona |

### Frame — *what's worth building*
| Agent | Owns | Never |
|---|---|---|
| `product-manager` | Strategy, prioritization reasoning, outcome validation | Commits a decision — it recommends |
| `product-analyst` | Numbered acceptance criteria — **the oracle everything else traces to** | Reinterprets product intent |

### Design — *how it should work*
| Agent | Owns | Never |
|---|---|---|
| `ux-designer` | Journeys, every interactive state, accessibility *requirements* | Picks visual values, or edits existing files |
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

## Workflows

| Command | What it does | Agents |
|---|---|---|
| `sdlc-feature` | Full lifecycle: requirements → design → build → 4-lens verification → readiness | ~12 |
| `independent-review` | Four evidentiary bases on one change, every finding adversarially refuted, then merged | ~10 |
| `persona-qa-sweep` | Derive personas → explore as each → probe every pair → triage | scales with personas |
| `release-readiness` | Five gates in parallel from their owning agents → classified recommendation | 6 |
| `system-archaeology` | Derive who + what from an undocumented system in parallel, cross-check, synthesize an as-built PRD | 6 |
| `registry-audit` | Re-audits this registry: schema, orphans, overlap, agnosticism, consistency | ~12 |

### Quality patterns these encode

- **Adversarial verification** — a finding is refuted by an agent with a *different* evidentiary basis before it's reported. `independent-review` sends `code-reviewer`'s findings to `qa-engineer` and vice versa.
- **Pipelining over barriers** — each lens cross-checks as soon as it finishes rather than waiting for the slowest.
- **Fail-closed defaults** — a gate agent that returns nothing is `Missing`, never "probably fine". A refuter that returns no verdict marks the finding `Unverified`, not confirmed.
- **Honest stop conditions** — `persona-qa-sweep` halts above 12 personas because that's `persona-discovery`'s own signal that it split on the wrong axis. `system-archaeology` stops when auth cannot be located.

### How workflows run

Each workflow is a standalone Node script (no runtime globals, no plugin manifest) that drives Command Code headlessly via `cmdc -p`. The shared `_runner.js`:

- resolves the real `cmdc` entry point (npm package bin via `node`, native exe, or `CMDC_BIN`) so multi-line prompts need no shell quoting;
- inlines the target agent's definition from `agents/<name>.md` into each phase's prompt, so phases run under the correct specialist's system prompt;
- enforces a JSON output contract per phase — unparseable output is treated as `null` (fail-closed), never as "probably fine";
- provides `parallel`, `pipeline`, `phase`, and `log` helpers mirroring the original Claude Code workflow runtime.

Phases are sequential; agents within a phase run concurrently (`Promise.all` over spawned children). Structured JSON passes between phases — each phase is a fresh session, so context carries forward only through the previous phase's JSON.

### Three important caveats

**1. Unattended phases run with auto-accept — tool calls are auto-approved.** Several agents have "stop and confirm before" boundaries (`software-engineer` §13, `ui-engineer` §5, `database-engineer`). Those are *prompt-level* commitments; the workflow runner does not enforce them. `sdlc-feature` runs its build agents in a git worktree so edits land in a throwaway copy, but **review the diff before merging** — don't treat a workflow-produced change as pre-approved.

**2. Workflows accept no mid-run human input.** That's why every workflow terminates in a *recommendation* with an explicit `humanDecisionRequired` list, and why sign-off-shaped stages are separate workflows rather than one long chain.

**3. `incident-commander` is deliberately not driven by a workflow.** Incident response needs human judgment on irreversible mitigation *during* the run, which is exactly what a workflow cannot provide. Use the agent directly. Same reasoning limits `product-manager`: prioritization is a human business-value call.

`qa-runner` also appears in no workflow script — correctly. It's reached at runtime via task-tool delegation from `qa-engineer`, `database-engineer`, and `performance-engineer` when a run would otherwise flood their context.

## Memory

One root, `.commandcode/memory/<project>/`, shared by every agent, with per-file ownership (see `memory-template/README.md`). Two rules matter more than the layout:

- **Project isolation is absolute.** No agent reads or writes another project's subdirectory, and no convention, risk, or pattern crosses between projects without being re-established.
- **Memory says where to look *harder*, never where to look *less*.** Nothing that would justify skipping a future check gets recorded.

## Keeping everything in sync

If you edit the source `.claude/` suite, regenerate the port:

```bash
python commandcode-suite/convert-agents.py   # regenerate agents/ from sdlc-suite/agents/
python commandcode-suite/verify-bodies.py    # confirm bodies are verbatim
python commandcode-suite/validate.py         # structural sanity check
```

## Registry health

Run `node commandcode-suite/workflows/registry-audit.js` to re-check the registry — schema validation, orphan detection, overlap analysis, and tech-agnosticism, with every finding adversarially verified before it is reported. It audits this suite by default; pass a path to audit a different registry root.
