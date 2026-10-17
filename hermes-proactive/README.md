# hermes-proactive

Proactive-agent toolkit for Hermes, ported from the CopilotKit open-agent repos
(all MIT). Hermes cron already *runs things on a schedule*; these tools add the
proactive layer those repos prove out: **condition monitors**, **event
triggers**, **a suggestion engine**, and **goal tracking**.

| Tool | Ports from | What it adds to Hermes |
|---|---|---|
| `condition_monitor.py` | OpenMuse monitors | Watch URLs for price/text/JSON/page-change conditions with dedup, exponential failure backoff, and per-watch durable state. Hermes' native `--monitor-url` only hashes bytes — this evaluates *conditions*. |
| `triggerd.py` | OpenBot Responsibilities | Event-driven cron: HMAC-verified webhooks (GitHub + generic) fire `hermes cron run <job>`. Turns poll loops into push triggers. |
| `proactive_scan.py` | OpenBot proactive engine + OpenMuse ideas | Read-only scans (git repos, GitHub, RSS, disk) → ranked, deduplicated, acknowledgeable suggestions. The same finding nags on a 7-day TTL until you `ack` it. |
| `goals.py` | OpenMuse goals | Durable goals + milestones with a `checkin` view designed for a weekly cron check-in prompt. |

## Install

```sh
./install.sh              # scripts -> ~/.hermes/scripts, skills -> ~/.hermes/skills
./install.sh --systemd    # also install the triggerd user service
systemctl --user enable --now hermes-triggerd
```

All Python is stdlib-only (3.11+). Telegram delivery reuses your existing
`~/.hermes/scripts/tg_send.py`.

## Wiring (hermes cron)

**Watchdog monitor** — pure condition ping, no LLM, instant Telegram alert:

```sh
cat > ~/.hermes/scripts/watchdog_run.sh <<'EOF'
#!/usr/bin/env bash
# stdout IS the delivery channel here (--no-agent): print transitions only,
# no --notify (that would double-send via tg_send).
exec python3 "$HOME/.hermes/scripts/condition_monitor.py" run-all --mode transitions
EOF
chmod +x ~/.hermes/scripts/watchdog_run.sh
hermes cron create "*/30 * * * *" --name proactive-watchdog \
    --no-agent --script watchdog_run.sh --deliver telegram:<chat>
```

**Event trigger** (GitHub issue with "urgent" in the title fires your existing
`pr-reviewer` job):

```sh
echo 'TRIGGER_SECRET_GH='"$(openssl rand -hex 24)" >> ~/.hermes/.env
python3 ~/.hermes/scripts/triggerd.py add-github github-issues-urgent \
    --job pr-reviewer --secret-env TRIGGER_SECRET_GH \
    --event issues --action opened --json-path issue.title --contains urgent
# GitHub repo -> Settings -> Webhooks -> http://<host>:8471/github/github-issues-urgent
```

**Weekly proactive digest** (LLM-formatted, from real findings):

```sh
hermes cron create "0 9 * * 1" "<check-in prompt>" --name proactive-digest \
    --script proactive_digest.sh --model <deep-model> --deliver telegram:<chat>
```

(`--script` takes a single filename under `~/.hermes/scripts/` with no extra
args — the `*_run.sh` / `*_digest.sh` wrappers in `wrappers/` exist for that.
Both are installed by `install.sh`.)

**Weekly goals check-in**:

```sh
python3 ~/.hermes/scripts/goals.py add "Ship the thing" --why "..."
python3 ~/.hermes/scripts/goals.py milestone ship-the-thing add "First step" --due 2026-10-20
hermes cron create "0 9 * * 1" --name goals-checkin \
    --script goals.py checkin --model <deep-model> --deliver telegram:<chat> \
    "From the goal report below write a check-in: celebrate done milestones, flag overdue, ask ONE question about the most stalled goal."
```

## Skills

`watch`, `trigger`, `proactive-scan`, `goals` — installed into
`~/.hermes/skills/`. In a Hermes session, mention them or use
`/skill:<name>`-style invocation per your harness.

## Layout

```
condition_monitor.py   monitors engine + CLI
triggerd.py            webhook receiver daemon + CLI
proactive_scan.py      suggestion engine + CLI
goals.py               goal/milestone store + CLI
hp/notify.py           shared tg_send wrapper
skills/                Hermes skills (one dir per capability)
systemd/               hermes-triggerd user service
examples/              sample watch + trigger configs
tests/                 stdlib unittest smoke suites (no network, no secrets)
```

## Tests

```sh
python3 tests/test_condition_monitor.py   # local HTTP fixture server
python3 tests/test_triggerd.py            # signed/unsigned webhook end-to-end
python3 tests/test_proactive_goals.py
```

## Security notes

- `triggerd` binds 127.0.0.1 by default and refuses unsigned requests; secrets
  live in `~/.hermes/.env`, referenced by env-var *name* in `triggers.json`.
- Monitor scripts fetch only URLs you configured; body size is capped.
- Everything is single-user (same trust model as your existing cron scripts).
