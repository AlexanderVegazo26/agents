---
name: watch
description: "Create and manage proactive condition monitors (price, text, page-change, JSON API) that alert on Telegram only when their condition flips. Usage: /watch add <name> --url U --kind K --condition C, /watch list, /watch check <name>"
---

You manage the hermes-proactive condition monitors. The tool is
`~/.hermes/scripts/condition_monitor.py` (also at
`~/Documents/repos/agents/hermes-proactive/condition_monitor.py`).

Watches live in `~/.hermes/monitors/*.json`; per-watch state in
`~/.hermes/state/monitors/`. Do not edit state files.

Kinds: `changed` (visible-text hash change, honors `ignore` regexes),
`text_contains`, `text_missing`, `price_below`, `price_above`,
`json_equals` / `json_below` / `json_above` (dotted path in `--selector`).

Common operations:
- Add: `condition_monitor.py add <name> --url <U> --kind <K> --condition <C> [--selector <regex>] [--ignore <regex>]` (repeatable)
- Inspect one shot without touching state: `condition_monitor.py test <name>`
- Tick a single watch: `condition_monitor.py check <name> --notify`
- List everything: `condition_monitor.py list`

To make a watch actually run, create a cron job (choose ONE):

1. Watchdog (no LLM, delivers raw transition lines to Telegram):
   `hermes cron create "*/30 * * * *" --name watch-<name> --no-agent
    --script condition_monitor.py --deliver telegram:<chat>`
   — wrap the call in a tiny shell script under ~/.hermes/scripts/ that runs
   `condition_monitor.py run-all --mode transitions` (or `check <name>` for a
   single watch). Empty stdout = silent tick.

2. Agent-summarized: `hermes cron create "*/30 * * * *" --name watch-<name>
   --monitor-script <state-wrapper.sh> --script ""` — the wrapper runs
   `condition_monitor.py run-all --mode state` (one stable line per watch);
   Hermes hash-suppresses unchanged output and injects a diff on change, then
   your prompt summarizes the diff.

Rules of thumb:
- Prefer `--no-agent` for pure threshold pings (cheap, instant); use the
  agent mode when the diff needs judgement ("is this changelog release
  note worth waking me for?").
- Always `test <name>` before wiring it into cron.
- `changed` on busy pages needs `--ignore` for timestamps/counters or it
  will fire every tick.
