---
name: watch
description: "Monitor a price/page/API and alert when it changes. Create and manage proactive condition monitors (price, text, page-change, JSON API) that alert on Telegram only when their condition flips. Usage: /watch add <name> --url U --kind K --condition C, /watch list, /watch check <name>"
---

The tool is `~/.hermes/scripts/condition_monitor.py` (source:
`~/Documents/repos/personal/agents/hermes-proactive/condition_monitor.py`). Watches live in
`~/.hermes/monitors/*.json`, state in `~/.hermes/state/monitors/` (never edit state files).

Kinds: `changed` (visible-text hash, honors `--ignore` regexes), `text_contains`,
`text_missing`, `price_below`, `price_above`, `json_equals` / `json_below` / `json_above`
(dotted path in `--selector`).

- Add: `condition_monitor.py add <name> --url <U> --kind <K> --condition <C> [--selector <regex>] [--ignore <regex>]` (`--ignore` is repeatable)
- One-shot check without touching state: `condition_monitor.py test <name>`
- Tick one watch: `condition_monitor.py check <name> --notify`
- List: `condition_monitor.py list`

Every watch in `~/.hermes/monitors/` already runs through the `proactive-watchdog` cron job
(`watchdog_run.sh` → `run-all --mode transitions`, no LLM, empty output = silent tick). A new
watch therefore needs no new cron job. Always `test` it first, and give `changed` watches on busy
pages `--ignore` patterns for timestamps and counters, or they fire every tick.

Only when a change needs judgement ("is this changelog worth waking me for?") create a
separate agent job: a wrapper script under `~/.hermes/scripts/` that runs
`condition_monitor.py run-all --mode state`, used as
`hermes cron create "*/30 * * * *" --name watch-<name> --monitor-script <wrapper.sh> --script ""`.
Hermes suppresses unchanged output and passes the diff to the prompt.
