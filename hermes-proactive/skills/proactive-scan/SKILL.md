---
name: proactive-scan
description: "Run the proactive suggestion engine: read-only scans of git repos, GitHub, RSS feeds and disk that surface deduplicated, acknowledgeable next-step suggestions. Usage: /proactive-scan run --notify, /proactive-scan list, /proactive-scan ack <id>"
---

You operate `proactive_scan.py` (OpenBot proactive engine + OpenMuse ideas
patterns) at `~/.hermes/scripts/proactive_scan.py`.

It differs from a plain cron fetch: findings are deduplicated by id, re-alert
on a 7-day TTL, and can be permanently acknowledged — so the same unpushed
commit doesn't page you daily, but doesn't vanish either.

Commands:
- `proactive_scan.py run [--notify] [--source git|github|rss|disk]` — scan and
  print/emit NEW findings only. Exit 0 always; findings on stdout.
- `proactive_scan.py list` — known finding ids with ack state.
- `proactive_scan.py ack <finding-id>` — silence permanently.
- `proactive_scan.py add-feed <url> [--name N]` — register an RSS source
  (~/.hermes/proactive_feeds.json).
- `proactive_scan.py test <source>` — raw findings, no state changes.

Recommended wiring (weekly digest + instant alerts):
1. Digest: `hermes cron create "0 9 * * 1" "<prompt>" --name proactive-digest
   --script proactive_digest.sh --model <deep-model> --deliver telegram:<chat>`
   — the prompt should say: "Turn the findings below into a short ranked
   action list; if it says 'no new findings', reply with an all-clear line."
   (`--script` takes one filename, no args — hence the wrapper; both cron
   wrappers are installed by install.sh.)
2. Action-severity pings: same job shape with `--no-agent --script` wrapper
   grepping for `[ACTION]` lines.

When the user asks "what needs my attention?" — run
`proactive_scan.py test git` and `test github` first (raw, fast), then
present the action-severity items.
