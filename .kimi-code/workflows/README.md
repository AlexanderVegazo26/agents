# Kimi Code Workflows

Python workflow scripts that orchestrate Kimi Code agents programmatically. These are the closest equivalent to the JavaScript workflows in `.claude/workflows/`.

## How they work

Each script uses `subprocess` to call the Kimi Code CLI (`kimi -p --agent-file <agent> <prompt>`) and passes structured outputs between phases. Parallel phases use `ThreadPoolExecutor`.

Unlike the flow skills in `.kimi-code/skills/`, these scripts:
- Run **outside** the Kimi Code TUI
- Support true parallel agent execution
- Return structured JSON results
- Can be chained, scheduled, or integrated into CI

## Requirements

- Standalone Kimi Code (`~/.kimi-code/bin/kimi.exe`), logged in (`kimi login` or `/login` in the TUI)
- Agents present in `.kimi-code/agents/` (this repo)
- Python 3.10+

## Usage

The workflows are a **global tool wallet**: run them from *any* repository and
they operate on your current working directory. Agent definitions are resolved
from this repo by absolute path, and agents are launched with the standalone
Kimi Code binary (`~/.kimi-code/bin/kimi.exe`; override with `$KIMI_BIN`).

### Shortcut: `kflow` (recommended)

A `kflow` shim in `~/bin` (already on PATH) wraps everything:

```bash
cd /path/to/any/repo

kflow sdlc "Add CSV export to the reporting dashboard"     # full SDLC lifecycle
kflow review "the diff on feature/checkout-v2"             # four-lens review
kflow release "release 2.4.0"                              # release readiness gates
kflow qa --target http://localhost:3000 --env staging      # persona QA sweep
kflow archaeology "the billing subsystem" --observe-target http://localhost:8080
kflow audit --root .claude                                  # registry audit
```

### Direct invocation

```bash
python <repo>/.kimi-code/workflows/sdlc-feature.py "Add CSV export"
```

## Workflow scripts

| Script | Equivalent to | What it does |
|---|---|---|
| `sdlc-feature.py` | `sdlc-feature.js` | Requirements → design → build → verify → readiness |
| `independent-review.py` | `independent-review.js` | Four-lens review with adversarial cross-check |
| `release-readiness.py` | `release-readiness.js` | Five gates → release-manager recommendation |
| `persona-qa-sweep.py` | `persona-qa-sweep.js` | Derive personas → explore → probe → triage |
| `system-archaeology.py` | `system-archaeology.js` | Reverse-engineer who + what from code evidence |
| `registry-audit.py` | `registry-audit.js` | Registry audit with verification |

## Architecture

```
runner.py              # Common utilities: agent(), parallel(), pipeline(), extract_json()
├── sdlc-feature.py
├── independent-review.py
├── release-readiness.py
├── persona-qa-sweep.py
├── system-archaeology.py
└── registry-audit.py
```

Each workflow:
1. Parses CLI arguments
2. Runs phases sequentially, agents within a phase in parallel
3. Extracts structured JSON from agent outputs
4. Cross-checks findings adversarially where the original workflow did
5. Prints a final JSON result to stdout

## Limitations

- Agents are invoked via `kimi -p` (print mode), so each agent run is a fresh session. There is no persistent agent state across phases.
- The workflows rely on agents returning parseable JSON. If an agent returns prose instead of JSON, the workflow logs a warning and treats the phase as failed.
- Subagent nesting is not used (Kimi Code subagents cannot spawn further subagents). The workflows orchestrate everything from the top level.

## Choosing between workflows and flow skills

| Use case | Use |
|---|---|
| Interactive, human-in-the-loop | `/skill:<name>` in the Kimi Code TUI |
| Automated, CI, scripting, batch | `python .kimi-code/workflows/<name>.py` |
| True parallel agent execution | `python .kimi-code/workflows/<name>.py` |
| Persistent agent context across steps | Not supported by either; use a single agent session |
