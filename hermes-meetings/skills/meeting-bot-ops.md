---
name: meeting-bot-ops
description: Operate the self-hosted Vexa meeting bot: join meetings, check bot status, pull live transcripts, stop bots. Use for anything involving the Hermes meeting-bot integration.
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [meetings, vexa, transcription, bots]
    related_skills: [meeting-live-questions, meeting-notes]
---

# Meeting Bot Operations (Vexa)

Hermes runs a self-hosted Vexa meeting-bot stack on this machine (Docker
containers `vexa-lite`, `vexa-lite-whisper`, `vexa-lite-postgres`,
`vexa-lite-storage`, `vexa-mcp`). The bot joins Google Meet / Teams / Zoom /
Jitsi as a participant and streams speaker-attributed transcripts.

## Access

- API base: `http://localhost:8056` (gateway).
- API key: environment variable `VEXA_API_KEY` in `~/.hermes/.env`
  (`vxa_bot_...`). Never print the key into chat or notes.
- Preferred path: the `vexa` MCP tools (`mcp_*`-named tools from the vexa
  toolset). Use them when present.
- Fallback path: `curl` through the terminal, e.g.
  `curl -s -H "X-API-Key: $VEXA_API_KEY" http://localhost:8056/bots/status`.

## Operations

**Join a meeting** — tool `request_meeting_bot` (MCP) or
`POST /bots` with `{"platform": "google_meet"|"teams"|"zoom"|"jitsi",
"native_meeting_id": "<code from the join URL>", "bot_name": "Hermes"}`.
For a full URL, MCP `parse_meeting_link` splits it first. Declare the bot's
presence to participants when asked: it is there to transcribe and take
notes, not to record humans without consent.

**Bot status** — tool `get_bot_status` or `GET /bots/status`.

**Live transcript** — tool `get_meeting_transcript` or
`GET /transcripts/{platform}/{native_meeting_id}`. Returns speaker-attributed
segments; `draft` vs `confirmed` fields mark in-progress vs settled text.

**Stop / remove bot** — tool `stop_bot` or
`DELETE /bots/{platform}/{native_meeting_id}`. Always stop the bot when a
meeting ends or the user asks.

**Meetings / recordings** — tools `list_meetings`, `list_recordings`,
`get_recording` (or `GET /meetings`, `GET /recordings`).

## Constraints

- Bot lifecycle events (started, completed, failed) are also pushed to
  Hermes's webhook routes by the host-side poller (`~/.hermes/scripts/vexa-poll.py`,
  run by cron). Do not duplicate that work from inside a session.
- Transcription is local faster-whisper on CPU (small model) — transcripts
  are good but not word-perfect; never present uncertain attribution as fact
  (Vexa marks empty-speaker rows instead of guessing).
- `update_bot_config` is not wired in the open-core (404). If you need to
  change the bot mid-call, stop it and send a new one.
