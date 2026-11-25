---
name: proactive-scan
description: "Run the proactive suggestion scan of repos and feeds. Run the proactive suggestion engine: read-only scans of git repos, GitHub, RSS feeds and disk that surface deduplicated, acknowledgeable next-step suggestions. Usage: /proactive-scan run --notify, /proactive-scan list, /proactive-scan ack <id>"
---

`~/.hermes/scripts/proactive_scan.py` scans git repos, GitHub, RSS feeds and disk, read-only.
Findings are deduplicated by id, re-alert after a 7-day TTL and can be acknowledged for good,
so an unpushed commit neither pages daily nor silently disappears.

Commands:
- `proactive_scan.py run [--notify] [--source git|github|rss|disk]`: scan and print only NEW
  findings. Always exits 0.
- `proactive_scan.py list`: known finding ids with their ack state.
- `proactive_scan.py ack <finding-id>`: silence one permanently.
- `proactive_scan.py add-feed <url> [--name N]`: add an RSS source (`~/.hermes/proactive_feeds.json`).
- `proactive_scan.py test <source>`: raw findings, no state change.

Already wired: the `proactive-digest` cron job (wrapper `proactive_digest_claude.sh`, which runs
`proactive_digest.sh` → `proactive_scan.py run`) turns new findings into a ranked action list.
Check `hermes cron list` before adding another job; `--script` takes one filename with no
arguments, so new jobs need a wrapper under `~/.hermes/scripts/`.

"What needs my attention?": run `test git` and `test github` (raw, fast) and present only the
action-severity items, each with a recommended next action. Rank by
`~/.hermes/goals/_policy.md` (revenue and client outcomes first).
