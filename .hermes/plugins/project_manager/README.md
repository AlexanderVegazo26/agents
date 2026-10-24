# project_manager — Hermes plugin (operator guide)

Hermes's project manager for the Hay Mesa ClickUp board and the SONNET CODE Discord server.
Source spec: ClickUp task 86e3rpuxm ("Bot de seguimiento y actualizaciones Discord", Lissette).

## Architecture

```
ClickUp REST v2 ──(poll every 15 min, pm-sync)──► pm.db (SQLite, WAL)
                                                   │ task_state · events · sync_runs
Discord /daily /standup /checking (modal) ────────►│ standups
   (guild commands, run inside the Hermes gateway) │ notifications (delivery ledger)
                                                   │ followups · ops_log
cron jobs (no-agent) ──► pm.py <command> --post ──►┴──► Discord REST (explicit allowed_mentions)
Hermes agent ──► project_manager tool (host) ──► pm.py (dry run unless post=true)
```

| File | Role |
|---|---|
| `pm_core.py` | pure rules: config, statuses, periods, transitions, staleness, mapping, messages, follow-ups, health |
| `pm_store.py` | SQLite schema and all persistence |
| `pm_clients.py` | ClickUp + Discord HTTP clients (stdlib, retries on 429/5xx) |
| `pm.py` | CLI for cron, the tool and operators |
| `standup_discord.py` | slash commands + modal inside the gateway |
| `__init__.py` | plugin registration (tool, skill, Discord handler) |
| `SKILL.md` | the `project-manager` skill for the agent |
| `test_project_manager.py` | unit + scenario tests (fakes, temp DB) |

Paths: config `~/.hermes/data/config/project_manager.yaml`, state `~/.hermes/data/project-manager/pm.db`,
backups `~/.hermes/data/project-manager/backups/` (daily, 14 kept). Credentials: `CLICKUP_API_TOKEN`
and `DISCORD_BOT_TOKEN` from `~/.hermes/.env` (only those keys are read; never logged).

Why a personal ClickUp token when Hermes already has ClickUp OAuth: the OAuth grant belongs to the
hosted MCP server and is managed inside Hermes's MCP client for the agent. Scheduled jobs run without
the agent and call the REST API directly, which takes the `pk_` token.

## Commands

Discord (team): `/daily`, `/standup`, `/checking` — same workflow. Opens a form with the three
questions; submitting saves it (one entry per person per day), replies privately, and posts it in the
standup channel. Running it again the same day pre-fills the form and edits the post in place
(no new ping).

Manual triggers (host shell; add `--post` to publish, omit it for a dry run that prints the text):

```bash
cd ~/.hermes/plugins/project_manager
/usr/bin/python3 pm.py report --period weekly          # previous Monday–Sunday
/usr/bin/python3 pm.py report --period daily           # yesterday
/usr/bin/python3 pm.py report --period on_demand --days 3
/usr/bin/python3 pm.py stale
/usr/bin/python3 pm.py followups
/usr/bin/python3 pm.py health
/usr/bin/python3 pm.py standup-summary --force         # --force: run on a non-workday
/usr/bin/python3 pm.py standup-remind --force
/usr/bin/python3 pm.py mappings                        # identity validation against both APIs
/usr/bin/python3 pm.py healthcheck                     # integration health
/usr/bin/python3 pm.py status                          # sync, events, ledger, recent ops log
```

From Hermes (Telegram/Discord/CLI): ask in plain language ("ClickUp report for this week",
"what's blocked?", "post the weekly report") — the agent uses the `project_manager` tool. It only
publishes when asked to; scheduled/webhook sessions can't publish through the tool.

## Schedules (Hermes cron, `hermes cron list`)

| Job | When (AST) | Does |
|---|---|---|
| pm-sync | every 15 min | poll ClickUp, detect transitions; daily DB backup |
| pm-standup-prompt | 09:00 Mon–Fri | invites required members to submit |
| pm-standup-remind | 11:00 Mon–Fri | pings only required members who haven't submitted |
| pm-standup-summary | 12:00 Mon–Fri | consolidated summary (+@everyone in summary/all_team mode) |
| pm-followups | 10:00 Mon–Fri | follow-ups and escalations |
| pm-weekly-report | Mon 09:30 | ClickUp status report for the previous week |
| pm-health | Mon 09:45 | project health |
| pm-healthcheck | hourly :07 | silent unless something is wrong |

All are `--no-agent` scripts (`~/.hermes/scripts/pm_*.py`). Success prints nothing; failure prints
one line, which cron delivers to the operator's Telegram. Inspect/enable/disable/modify:
`hermes cron list`, `hermes cron pause|resume <id>`, `hermes cron edit <id> --schedule "..."`,
`hermes cron runs <id>`. A daily report is supported (`report --period daily`) but disabled
(`reporting.daily_enabled: false`); to use it, set it true and create a job running
`pm_report_daily.py`. The host and the cron scheduler run in America/Santo_Domingo (UTC-4, no DST);
all stored timestamps are UTC.

Duplicates can't happen per run: every published message has a dedupe key in the `notifications`
ledger (`report:weekly:2026-10-19`, `standup:summary:2026-10-21`, …). A re-run, a manual trigger or a
gateway restart sees `sent` and skips.

## Configuration

Everything lives in `project_manager.yaml` and is re-read on every run — no code edits, no restart
(the slash-command *names* need a gateway restart).

- `clickup.list_ids` — boards monitored. `status_mappings` — which status names count as
  closed/testing/rejected/blocked (case/spacing-insensitive). Current: Testing = `qa -testing`.
- `discord.*_channel_id` — destinations. Standups and reports: #🍴haymesa-updates;
  operations (errors, mapping problems, permission fallbacks): #home.
- `standup.notification_mode`:
  - `all_team` — @everyone on every submission (noisy: one ping per person per day)
  - `summary` (current) — submissions post without a mass mention; the 12:00 summary carries one @everyone
  - `targeted` — mention `targeted_recipients` only
  - `quiet` — no mass mention anywhere
  `@all` isn't a Discord mention; @everyone is used only when the mode allows it and the bot has
  "Mention @everyone" in that channel (verified 2026-10-21: it does). Without it, the message is
  posted without the mention and the fallback is logged.
- `reviewers` — Testing→jorge, Rejected→ivana, Blocked→lissette (confirmed by Alexander 2026-10-21).
  `project_manager` (unassigned tickets) and `escalation_recipient` are separate roles.
- `users` — the identity map. `verified: true` only for identities confirmed beyond a name match;
  unverified users are shown by name and never mentioned. Assignee, reviewer, PM and escalation
  recipient are different roles: a ticket assigned to Dev that enters Testing names Dev as assignee
  and mentions Jorge as reviewer.

## Reporting semantics

- **Moved to Testing/Rejected/Blocked** = a status *change into* that category observed during the
  period. A ticket that's merely *in* Testing isn't counted. ClickUp status history isn't available
  (the "Total time in Status" ClickApp is off), so changes are detected by comparing 15-minute
  snapshots. Limits: if a ticket passes through several statuses between two polls only the last is
  seen; moves before monitoring started (2026-10-21 00:21 AST) are unknown; the report says so in
  its *Cobertura* line and flags polling gaps. Turning that ClickApp on would allow exact history.
- **Closed** = ClickUp's `date_closed` inside the period (authoritative, works for any date).
- **Week** = previous ISO week, Monday 00:00 to Monday 00:00 local; **daily** = yesterday.
- **Stale** = open ticket whose ClickUp record (`date_updated`) hasn't changed for more than
  `inactivity_threshold_days` (7). That field also moves on automation and minor edits, and isn't
  proof of no activity, so the label says "sin actualización". Additionally, once monitoring covers
  the window, a ticket whose `date_updated` keeps moving but whose tracked fields (status, assignees,
  due date, name, priority) never changed is listed as *inferido* (likely automation-only updates).
  Closed tickets are excluded (`stale_excluded_categories`).
- Reviewer mentions appear only for non-empty categories; empty categories produce no section and no
  mention. Stale-ticket assignees are mentioned (verified mappings) per `stale_mention_assignees`.
- If ClickUp can't be read, no report is published (never an empty "nothing happened" report); the
  failure is recorded in `sync_runs`/`ops_log`, posted to #home, and sent to the operator via cron.

## Follow-ups and escalation

Issues detected each run: Blocked (owner: Blocked reviewer), in Testing > 3 days (Testing reviewer),
in Rejected > 2 days (assignee), overdue (assignee), due within 2 days (assignee), unassigned
(project manager). Per issue: first notice → follow-up every 24 h while open (blocked, overdue,
stuck) → one escalation after 3 days to `escalation_recipient` → resolved automatically when the
condition disappears (recorded in `followups.resolved_at`). Messages group issues by type and owner,
so each person is mentioned once per message. Nothing is changed in ClickUp: no status, assignee or
date changes — notifications and recommendations only.

## Project health

Measured: open/closed counts, issue counts by type, stale count and ratio, missing standups, open
tickets per assignee. Rule (subjective thresholds, in `pm_core.health`): **ROJO** if anything is
overdue or blocked longer than `escalate_after_days`; **AMARILLO** if anything is blocked, stuck in
Testing/Rejected, unassigned, or > 20 % of open tickets are stale; else **VERDE**. No velocity,
capacity or probability is computed — the data for them doesn't exist (no estimates or due dates on
most tickets; the report says so).

## Tests

```bash
cd ~/.hermes/plugins/project_manager && /usr/bin/python3 -m unittest test_project_manager.py
```
27 tests: normalization, periods, timezone, inactivity, mapping (missing, unverified, duplicate),
conditional mentions, follow-up policy, splitting, and the 12 scenarios (Testing/Rejected/Blocked
mentions, no-move reports, stale, automation-only updates, unmapped assignee, restart without
duplicates, standup persistence/correction, @everyone fallback, ClickUp failure → no report).

## Runbook

| Symptom | Check | Fix |
|---|---|---|
| ClickUp API failures | `pm.py healthcheck`; `pm.py status` → `last_sync_runs[].error` | 401: token revoked/missing → new `pk_` token in `~/.hermes/.env` as `CLICKUP_API_TOKEN`. 429/5xx retried automatically; persistent → ClickUp status page. Reports refuse to publish meanwhile. |
| Discord outage | cron failure line in Telegram; `notifications` rows with `status=failed` | Re-run the job: failed keys are retried, sent keys skipped. Standup submissions are saved before posting; the user is told if posting failed. |
| Invalid user mapping | `pm.py mappings` (`NOT IN SERVER`, `NOT FOUND`, `problems`) | Fix IDs in YAML; set `verified: true` only after confirming the person. Problems are also posted to #home weekly. |
| Duplicate notifications | `SELECT * FROM notifications ORDER BY created_at DESC` | Shouldn't happen per key. Two different keys = two different runs (e.g. on_demand reports are unique per invocation by design). |
| Scheduler failures | `hermes cron list`, `hermes cron runs <id>`, `hermes cron doctor` | `hermes cron status`; resume paused jobs; scripts are `~/.hermes/scripts/pm_*.py`. |
| Missing task history | report *Cobertura* line, `sync_runs` gaps | Expected limit of polling. Enable ClickApp "Total time in Status" for exact history. |
| Bot restarts | `/daily` not visible | Gateway log: `grep project_manager ~/.hermes/logs/gateway*.log` → "synced N guild command(s)". `hermes gateway restart` re-registers. |
| Permission errors | ops_log `everyone_fallback` / `permission_check_failed` | Grant the bot role "Mention @everyone" in the channel, or switch mode to `quiet`/`targeted`. |
| Inconsistent statuses | a board renamed a status | Update `status_mappings`; `pm.py report` dry run to confirm. |

Backup/restore: backups are SQLite copies; restore with the gateway's jobs paused:
`cp backups/pm-YYYYMMDD.db pm.db` (remove `pm.db-wal`/`pm.db-shm` first). Config backups are the
operator's (`project_manager.yaml` is small; keep it in git or copy before edits).

## Security

Least privilege: the bot needed no new Discord permission (it already had Send Messages, Mention
@everyone, Use Application Commands); ClickUp access is read-only in practice — no code path writes to
ClickUp. Every Discord message carries explicit `allowed_mentions`, so text from tickets or standups
can't ping anyone not intended. The tool publishes only from human conversations; standup modal
answers are shown publicly only through the standup post itself. Secrets are never printed.
