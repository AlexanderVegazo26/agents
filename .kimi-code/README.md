# SDLC Agent Suite for Kimi Code

> **Installed as a global tool wallet** — usable from any repository via `~/.kimi-code/config.toml`
> (`extra_agent_dirs`/`extra_skill_dirs`) and `~/bin` shims (`kimi`, `kimi.cmd`, `kflow`).
> **Full setup, unattended-operation, and troubleshooting guide: [GLOBAL-SETUP.md](./GLOBAL-SETUP.md)**

This directory contains the `.claude/` SDLC Agent Suite converted to the current **Kimi Code** format (the standalone product documented at `https://www.kimi.com/code/docs/en/kimi-code-cli/`).

> **Two Kimi products exist on this machine.** The legacy `kimi-cli` Python package (v1.49.0) uses the older `.kimi/` format; the newer standalone Kimi Code uses `.kimi-code/`. This directory targets the **new** product. The legacy mirror is kept in `.kimi/` for backward compatibility.

## Layout

```
.kimi-code/
├── agents/              # custom agents (Markdown with YAML frontmatter) — see the counts table in the root README.md
├── skills/              # 60 domain skills + 6 flow skills
├── workflows/           # 6 Python workflow scripts (programmatic orchestration)
├── GLOBAL-SETUP.md      # Global tool-wallet setup & operations guide
├── memory/              # Pointer to the shared .claude/memory/ root
├── AGENTS.md            # Project instructions auto-loaded by Kimi Code
├── convert-agents.py    # Regenerate agents/ from .claude/agents/
├── sync-skills.py       # Copy new .claude/skills/ into skills/
└── validate.py          # Structural sanity check
```

The 60 domain skills are generated from `sdlc-suite/skills/` (the canonical source; they were mirrored from `.claude/skills/` before that tree itself became generated) because the current Kimi Code only auto-discovers `.kimi-code/skills/` and `.agents/skills/`, not `.claude/skills/`. The 6 flow skills were rebuilt from the canonical workflow scripts and are local to this port — the generator is told never to prune them. Shared per-project memory remains in `.claude/memory/` (see `.kimi-code/memory/README.md`).

## Quick start

This suite is installed as a **global tool wallet** — usable from any repository,
not just this one. `~/.kimi-code/config.toml` registers this repo's `agents/` and
`skills/` via `extra_agent_dirs` / `extra_skill_dirs`, so edits here take effect
everywhere immediately (no copies, no sync step).

```bash
# From ANY repo — use a specialist agent as the main agent
kimi --agent software-engineer
kimi --agent qa-engineer
kimi --agent code-reviewer

# Or start normally and use flows
kimi
/skill:sdlc-feature
Add CSV export to the reporting dashboard

# Run a Python workflow against the current repo (kflow shim lives in ~/bin)
kflow sdlc "Add CSV export to the reporting dashboard"
kflow review "the diff on feature/checkout-v2"
```

> `kimi` here means the **standalone Kimi Code** (`~/.kimi-code/bin/kimi.exe`).
> Shims in `~/bin` (`kimi` for Git Bash, `kimi.cmd` for cmd/PowerShell) route the
> `kimi` command to the standalone from any directory — `~/bin` precedes the legacy
> Python kimi-cli (`~/.local/bin`) on PATH. The legacy CLI is still reachable via
> its full path if ever needed. The same pattern provides the `kflow` workflow
> shortcut (`~/bin/kflow`).

## Agent format

Each agent is a single Markdown file with YAML frontmatter, following the current Kimi Code spec:

```markdown
---
name: software-engineer
description: ...
whenToUse: ...
tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
subagents:
  - qa-runner
---

# System prompt body...
```

Agents are discovered automatically from `.kimi-code/agents/` and can be delegated to by name from any main agent.

## Flow skills

Flow skills use `type: flow` with a D2 diagram. Invoke with `/skill:<name>` (no inline args), then describe the target in the next message.

## Workflows

Python workflow scripts in `.kimi-code/workflows/` provide programmatic orchestration equivalent to the original `.claude/workflows/*.js`. Run them from the shell:

```bash
python .kimi-code/workflows/sdlc-feature.py "Add CSV export"
python .kimi-code/workflows/independent-review.py "the diff on feature/checkout-v2"
python .kimi-code/workflows/release-readiness.py "release 2.4.0"
```

See `.kimi-code/workflows/README.md` for details.

## Keeping everything in sync

**Do not edit this tree.** Its `agents/` and `skills/` are generated from
`sdlc-suite/`, the single hand-edited source. An edit here raises no error and is
overwritten on the next run.

```bash
python sdlc-suite/tools/generate_trees.py            # regenerate every tree
python sdlc-suite/tools/generate_trees.py --check    # what CI runs
```

The old per-tree scripts (`convert-agents.py`, `sync-skills.py`, and the
top-level `sync-all.py`, which now refuses to run) are superseded. They predate
the `version:` frontmatter field and would strip it from every generated agent,
and they do not apply the per-target namespace transform — neither failure
raises an error.

`workflows/*.py` is the exception: it targets a different runtime and is **not**
generated. A change to a workflow has to be ported here by hand, and nothing
checks that it was.

## Note on subagent nesting

Kimi Code sub-agents cannot spawn further sub-agents. The flow skills therefore instruct the main agent to read the relevant agent file and act in that role for each step, rather than relying on nested delegation.
