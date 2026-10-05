# Hermes harness — instance configuration

The routing policy does not live here. It ships at
[`sdlc-suite/ROUTING.md`](sdlc-suite/ROUTING.md) — **read that file in full
before routing any work.** This file holds only what is local to running this
suite under Hermes Agent.

Hermes loads exactly one project context file per session, first match wins:
`.hermes.md` → `AGENTS.md` → `CLAUDE.md`. This file is that match, so the
repository's `CLAUDE.md` (which tree to hand-edit, the CRLF hazard) and the
root `AGENTS.md` (pi's instance file) are **not** in your context. Read
`CLAUDE.md` before editing anything in this repository. Ignore `AGENTS.md`:
its `agent` / `workflow` tools are pi's, and the Hermes equivalents below have
the same names and parameters.

---

## How the suite maps onto Hermes

| Suite layer | Where it lives in Hermes |
|---|---|
| Skills | `.agents/skills/` — Hermes's project-local skill directory. Loaded only once this repository is trusted (`hermes skills trust`); every project skill passes Hermes's skills_guard scan on load. |
| Slash commands | `.hermes/skills/<command>/` — generated from `sdlc-suite/commands/`. Hermes turns every skill into `/<name>`, so `/sdlc-feature <initiative>` works. Whatever follows the command arrives as the skill's `User instruction:` line. |
| Role agents | `sdlc-suite/agents/` (canonical) and `.claude/agents/`, dispatched with the `agent` tool (see below). They are deliberately **not** skills: loading a role into your own session would collapse the independence the suite is built on. |
| Workflows | `sdlc-suite/workflows/*.js`, run with the `workflow` tool (see below). |

**Sub-agents: the `agent` tool.** The hand-maintained plugin at
`.hermes/plugins/sdlc/` registers an `agent` tool (parameters: `name`,
`task`). A call runs a separate, non-interactive `hermes chat` process whose
prompt is the role file's body followed by the task. The nested session keeps
Hermes's normal system prompt — this file, skills, tools. Which model runs
it is decided per call (see *Model routing* below). A
failed or timed-out dispatch returns no result, and the tool says so. Role
files and workflow scripts are read only from this suite's repository, never
from the project the session runs in. A `scriptPath` outside
`sdlc-suite/workflows/` is refused.

Use `agent` for a suite role, not `delegate_task`. `delegate_task` children
know nothing of the role file, so "a `code-reviewer`" dispatched that way is
an anonymous helper, and calling its output an independent review is exactly
the claim `ROUTING.md` §2 forbids.

**Model routing.** `agent` takes an optional `model`: one of the choices in
the plugin's model catalog (`.hermes/plugins/sdlc/models.json`, or a
per-machine `~/.hermes/sdlc-models.json` that replaces it). The tool
description lists each choice with what it is for, and each role's default.
Resolution order: your explicit `model`, then the role's default in the
catalog, then the role file's `model:` alias (`haiku`/`sonnet`/`opus`, mapped
through the catalog), then the session default. Before dispatch the choice's
server is probed. If it is down, the choice's `fallback` list is walked, and
the result's first line says which model actually ran and why. Override a
role default when *this* piece of work is clearly harder or easier than the
role usually is, and say why.

**Leading a run: `/orchestrate <task>`** (or `hermes sdlc orchestrate
"<task>"` from a terminal). This is a plugin command, not a skill: its code
dispatches the `orchestrator` role (catalog default: `deep`) with no model
deciding whether to. A skill version was tried, and the default local model
answered it by itself with zero dispatches. The orchestrator classifies the
task, dispatches each specialist with a per-call model decision, and returns
its lens ledger with a Model column. `hermes sdlc models` shows the catalog
in effect and which choices are up. Prefer `/orchestrate` to picking
specialists yourself for any non-trivial change.

**Workflows: the `workflow` tool.** The same plugin registers a `workflow`
tool (parameters: `scriptPath`, `args`). It runs the script in the same
`node:vm` sandbox the pi extension uses — the allowlist and determinism
throwers are shared code — with `agent()` backed by the separate `hermes chat`
processes above. The relative `runtimeDir` / `policy` / `policyDefault`
values are resolved against this repository before the script sees them.
Use it when a command's body says to invoke the `Workflow` tool; if the tool
is missing from your session, the plugin is not enabled — say so, and do not
improvise a substitute run.

**The independence rule is structural, and the evidence standards still
bind.** Each role runs in a separate process with a separate conversation,
so implementer-never-certifies is enforced by process boundary. That does
not lower the bar: `ROUTING.md`'s Confirmed vs Claimed-not-verified
distinction applies to whatever each session reports, and a self-check
performed by the session that did the work must say so.

## Local paths

- `CLAUDE_PLUGIN_ROOT` does not exist here. The generated commands carry
  repository-relative paths (`sdlc-suite/...`); run Hermes with this
  repository as the working directory.
- The memory root stays `.claude/memory/<project>/` — agent and skill files
  reference that path. There is no `/install-routing` here: it writes
  `.claude/CLAUDE.md`, which Hermes does not read while this file exists, and
  Hermes quarantines skills that edit agent config. Under Hermes the routing
  pointer lives in this file.
- Run records land in `.claude/runs/`, the same place Claude Code and pi
  write them, so `/improve` reads all three.
