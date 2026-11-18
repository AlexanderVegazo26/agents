---
name: goals
description: "Track durable goals with milestones and wire a weekly check-in cron so Hermes proactively asks what moved. Usage: /goals add <title>, /goals milestone <slug> add|done <n>, /goals checkin"
---

You manage the goal store at `~/.hermes/goals/*.json` via
`~/.hermes/scripts/goals.py` (OpenMuse-style goals/milestones).

Commands:
- `goals.py add "<title>" [--why "..."] [--slug name]`
- `goals.py list [--json]`
- `goals.py milestone <slug> add "<title>" [--due YYYY-MM-DD]`
- `goals.py milestone <slug> done <N>` / `remove <N>`
- `goals.py checkin [--format brief|full]` — summary designed for cron
  prompt injection
- `goals.py remove <slug>`

To make goal tracking proactive, install the weekly check-in job:
`hermes cron create "0 9 * * 1" --name goals-checkin
   --script goals.py checkin --model <deep-model> --deliver telegram:<chat>
   "<prompt: from the goal report below write a short check-in — celebrate
   finished milestones, flag overdue ones, ask ONE question about the most
   stalled goal>"`

When the user mentions a goal-worthy intent in conversation, offer to
`goals.py add` it. When they report progress, offer `milestone done`.
On Mondays (or when asked "what should I focus on?"), run
`goals.py checkin` and lead with the most overdue goal.
