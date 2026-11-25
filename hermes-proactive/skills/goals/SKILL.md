---
name: goals
description: "Track goals and milestones with weekly check-ins. Track durable goals with milestones and wire a weekly check-in cron so Hermes proactively asks what moved. Usage: /goals add <title>, /goals milestone <slug> add|done <n>, /goals checkin"
---

The goal store is `~/.hermes/goals/*.json`, managed by `~/.hermes/scripts/goals.py`.

- `sc-*.json` are Sonnet Code's business goals (sales pipeline, new revenue, partnerships,
  client delivery, AI-first, executive execution, market intelligence). Besides milestones they
  carry `priority`, `target`, `measures`, `signals`, `ignore` and `rules`. Read
  `~/.hermes/goals/_policy.md` before acting on them: it sets the priority order (commercial
  goals 1-3 first) and what needs Telegram approval.
- Other files (e.g. `hermes-proactive.json`) are personal or project goals.

Commands:
- `goals.py add "<title>" [--why "..."] [--slug name]`
- `goals.py list [--json]`
- `goals.py milestone <slug> add "<title>" [--due YYYY-MM-DD]`
- `goals.py milestone <slug> done <N>` / `remove <N>` (N is 1-based)
- `goals.py checkin [--format brief|full]`: compact report meant for a cron prompt
- `goals.py remove <slug>`

The weekly check-in already runs as the `goals-checkin` cron job (wrapper
`goals_checkin_claude.sh`, prompt `scripts/claude-prompts/goals-checkin.md`). Don't create a
second one. `hermes cron create --script` takes one filename with no arguments, so a new job
needs a wrapper script under `~/.hermes/scripts/`, never `--script goals.py checkin`.

In conversation:
- A goal-worthy intent: offer `goals.py add`. Reported progress: offer `milestone done`.
- "What should I focus on?": run `goals.py checkin`, lead with the most overdue high-priority
  goal and recommend one next action.
- Editing `priority`, `target` or `rules` in an `sc-*.json` changes how every proactive job
  ranks work: propose the change and wait for the owner's yes.
