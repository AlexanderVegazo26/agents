#!/usr/bin/env bash
# proactive-digest: print NEW proactive-scan findings (git/github/rss/disk).
# When nothing is new it prints "no new findings"; the job prompt maps that to
# an all-clear message. Weekly cron, LLM-formatted delivery.
exec python3 "$HOME/.hermes/scripts/proactive_scan.py" run
