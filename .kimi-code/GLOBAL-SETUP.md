# Global Tool Wallet — Setup & Operations Guide

How the SDLC Agent Suite is installed as a **global, repo-agnostic tool wallet** for the
standalone Kimi Code CLI: every agent, skill, and workflow is callable from any
repository on this machine, with this repo as the single source of truth.

---

## 1. Architecture

```
C:\Users\avega\Documents\personal\agents        ← source of truth (edit here)
└── .kimi-code/
    ├── agents/      21 custom agents (Markdown + YAML frontmatter)
    ├── skills/      59 domain skills + 6 flow skills
    └── workflows/   6 Python orchestration scripts + runner.py

C:\Users\avega\.kimi-code\
├── bin\kimi.exe     standalone Kimi Code CLI (v0.32.0)
└── config.toml      extra_agent_dirs + extra_skill_dirs → point at the repo above

C:\Users\avega\bin\  (on PATH: persistent User PATH registration + Git Bash profile)
├── kimi             Git Bash shim → ~/.kimi-code/bin/kimi.exe
├── kimi.cmd         cmd/PowerShell shim → %USERPROFILE%\.kimi-code\bin\kimi.exe
├── kflow            Git Bash shim → <repo>/kflow (workflow shortcut)
└── kflow.cmd        cmd/PowerShell shim → bash <repo>/kflow
```

> The workflow shortcut is named `kflow`, not `wf`: `wf` collides with `wf.msc`
> (Windows Defender Firewall console) in cmd/PowerShell, where `.MSC` is in
> `PATHEXT` and extensionless shims are not executable.

**Why shims, not symlinks:** Windows symlinks require Developer Mode or admin rights,
Git Bash `ln -s` silently falls back to copies, and cmd/PowerShell need a `PATHEXT`
extension anyway. Shims work in every shell with zero privileges.

**Two Kimi products exist on this machine.** The legacy Python `kimi-cli` lives at
`~/.local/bin/kimi` (config `~/.kimi/`); the standalone Kimi Code lives at
`~/.kimi-code/bin/kimi.exe` (config `~/.kimi-code/`). The `~/bin/kimi*` shims come
first on PATH, so plain `kimi` = the standalone everywhere. The legacy CLI remains
reachable via its full path.

---

## 2. Components

### 2.1 User-level registration (`~/.kimi-code/config.toml`)

```toml
extra_agent_dirs = [ "C:/Users/avega/Documents/personal/agents/.kimi-code/agents" ]
extra_skill_dirs = [ "C:/Users/avega/Documents/personal/agents/.kimi-code/skills" ]
```

Kimi Code scans these "Extra" scope directories in **every** project
(priority: Project > Extra > User > Plugin > Built-in). Edits to the repo take
effect everywhere immediately — no copies, no sync step.

Validate with:

```bash
kimi doctor        # checks config.toml / tui.toml syntax
```

### 2.2 Agents (21)

Discovered globally via `extra_agent_dirs`. Use as the main agent or delegate by name:

```bash
kimi --agent software-engineer
kimi --agent qa-engineer
kimi -p --agent code-reviewer "review the diff on main"   # non-interactive
```

Full list in [`AGENTS.md`](./AGENTS.md) (software-engineer, code-reviewer, qa-engineer,
qa-runner, security-engineer, performance-engineer, database-engineer, ui-engineer,
ux-designer, solution-architect, product-manager, product-analyst, product-archaeologist,
persona-discovery, persona-runner, boundary-prober, journey-orchestrator, release-manager,
technical-writer, site-reliability, incident-commander).

### 2.3 Skills (59 domain + 6 flow)

Discovered globally via `extra_skill_dirs`. Invocation:

- Mention it in conversation (auto-loaded by the model), or
- `/skill:<name>` — inject the skill as a prompt, or
- `/flow:<name>` — execute a flow skill's D2 diagram end-to-end:
  `/flow:sdlc-feature`, `/flow:independent-review`, `/flow:release-readiness`,
  `/flow:persona-qa-sweep`, `/flow:system-archaeology`, `/flow:registry-audit`

### 2.4 Python workflows (`.kimi-code/workflows/`)

Programmatic orchestration via `subprocess` → `kimi -p --agent-file <agent>.md`.
Phases run sequentially, agents within a phase in parallel (`ThreadPoolExecutor`),
structured JSON extracted between phases.

| Command | What it does |
|---|---|
| `kflow sdlc "<feature>"` | requirements → design → build → verify → readiness |
| `kflow review "<target>"` | four-lens review with adversarial cross-check |
| `kflow release "<release>"` | five gates → release-manager recommendation |
| `kflow qa --target <url> --env <env>` | personas → explore → probe → triage |
| `kflow archaeology "<system>" [--observe-target <url>]` | reverse-engineer who + what from code |
| `kflow audit --root <dir>` | registry audit with verification |

`kflow` resolves the suite by absolute path and runs the workflow against your
**current working directory** — `cd` into any project and go.

### 2.5 `runner.py` resolution rules

| Setting | Default | Override |
|---|---|---|
| Kimi binary | `~/.kimi-code/bin/kimi.exe` (standalone; NOT PATH `kimi`, which may be legacy) | `$KIMI_BIN` |
| Agent files | `<repo>/.kimi-code/agents/<name>.md` (absolute) | — |
| Working dir | caller's cwd (the target repo) | — |
| Approval mode | none needed — print mode (`-p`) is inherently non-interactive and executes tool calls without prompts (the CLI rejects `--yolo`/`--auto` combined with `-p`) | `$KIMI_APPROVAL_FLAG` (escape hatch for future versions) |
| Per-agent timeout | 3600s | `timeout=` arg in the script |

---

## 3. Day-to-day usage

```bash
cd /path/to/any/project

# Interactive with a specialist
kimi --agent software-engineer

# Interactive flows
kimi
/flow:sdlc-feature
Add CSV export to the reporting dashboard

# One-shot non-interactive
kimi -p --agent code-reviewer "review the last commit"

# Full unattended workflow against this repo
kflow sdlc "Add CSV export to the reporting dashboard"
```

---

## 4. Unattended full-application generation

### 4.1 One-time auth (the only interactive step)

```bash
kimi login        # device-code flow, ~15 min window, cached afterwards
```

- The token persists per machine; subsequent runs are fully unattended.
- For CI/headless: `kimi provider` to configure an API-key provider instead —
  no browser, no token refresh.
- Legacy credentials do **not** carry over automatically; `kimi migrate` ports
  config (it kept our `extra_*_dirs` on conflict) but OAuth still requires one login.

### 4.2 Auto-approval

Nothing to configure: the workflows drive agents via `kimi -p` (print mode), which
is non-interactive by design — tool calls (shell, file writes) execute without
approval prompts, and agents never pause for questions. ⚠️ This means agents can
execute **any** shell command and file write in the target repo unsupervised —
always point workflows at a dedicated project folder.

### 4.3 Recipe

```bash
mkdir my-new-app && cd my-new-app
git init                     # commit baseline → full diff/rollback trail of agent work
kflow sdlc "Build a REST API for a recipe manager: FastAPI, SQLite,
         CRUD for recipes and ingredients, pytest coverage, Dockerfile" \
  2>&1 | tee build.log
```

The workflow runs requirements → design → build → verify → readiness unattended
and prints a final JSON report on stdout. Review `build.log` for `[workflow]`
phase markers and warnings.

### 4.4 Known limits

- **JSON-only handoff** — each phase is a fresh agent session; context carries
  forward only through the previous phase's JSON output. Write detailed prompts
  (stack, features, constraints); vague prompts degrade phase over phase.
- **JSON contract** — a phase that returns prose instead of parseable JSON is
  logged as failed and the workflow moves on.
- **Timeouts** — each agent call caps at 3600s; large build phases may need the
  `timeout=` bumped in the workflow script.
- **No nested delegation** — sub-agents cannot spawn sub-agents; orchestration
  stays top-level by design.

---

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `kimi --version` shows old Python CLI | You're bypassing the shim; use `hash -r` (bash) or a new shell. `which -a kimi` should list `~/bin/kimi` first |
| `No model configured` | Not logged in → `kimi login` (or `kimi migrate` from legacy, then login once) |
| `auth.login_required ... requires login` | OAuth token missing/expired → `kimi login` |
| Agent not found | Check `kimi doctor`; confirm `extra_agent_dirs` path exists |
| Workflow phase "failed" warnings | Agent returned prose, not JSON — inspect the phase output in the log |
| Workflow used wrong CLI | Set `$KIMI_BIN` explicitly; default prefers `~/.kimi-code/bin/kimi.exe` |

---

## 6. Maintenance

This repo remains the source of truth. After editing the suite:

```bash
python .kimi-code/convert-agents.py   # regenerate .kimi-code/agents/ from .claude/agents/
python .kimi-code/sync-skills.py      # copy new .claude/skills/ into .kimi-code/skills/
python .kimi-code/validate.py         # structural sanity check
```

Changes are picked up globally with **no further steps** — `extra_agent_dirs` /
`extra_skill_dirs` point directly at this repo.

If the suite repo ever moves, update:
1. `~/.kimi-code/config.toml` (`extra_agent_dirs`, `extra_skill_dirs`)
2. `~/bin/kflow` (path to the `kflow` wrapper)

Shared per-project memory stays in `.claude/memory/<project>/` (tool-agnostic by
design); see [`memory/README.md`](./memory/README.md).
