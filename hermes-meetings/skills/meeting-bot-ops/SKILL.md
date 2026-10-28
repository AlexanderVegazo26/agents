---
name: meeting-bot-ops
description: "Run the Vexa meeting bot: join, status, transcripts. Operate the self-hosted Vexa meeting bot: join meetings, check bot status, pull or search transcripts, read meeting chat, label meetings, stop bots. Use for anything involving the Hermes meeting-bot integration or a call Hermes should attend."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [meetings, calls, vexa, transcription, bots]
    related_skills: [meeting-briefing, meeting-live-questions, meeting-notes]
---

# Meeting Bot Operations (Vexa)

Hermes runs a self-hosted Vexa stack on this machine (Docker containers
`vexa-lite`, `vexa-lite-whisper`, `vexa-lite-postgres`, `vexa-lite-storage`,
`vexa-mcp`). The bot joins Google Meet / Teams / Zoom / Jitsi as a participant
and produces speaker-attributed transcripts.

## Access

- **Preferred: MCP tools** from the `vexa` server, named `mcp__vexa__<tool>`
  (e.g. `mcp__vexa__get_meeting_transcript`). Auth is already configured.
- **Fallback: REST** at `http://localhost:8056` with header
  `X-API-Key: $MCP_VEXA_API_KEY` (the key lives in `~/.hermes/.env`; `Bearer`
  auth returns 401). Never print the key into chat, notes or memory.
  `curl -s -H "X-API-Key: $MCP_VEXA_API_KEY" http://localhost:8056/bots/status`
- If both fail: `docker ps | grep vexa` — report which container is down
  instead of retrying blindly.

## Tools (MCP name → REST)

| Need | MCP tool | REST |
|---|---|---|
| Split a join URL | `parse_meeting_link` | — |
| Send the bot | `request_meeting_bot` (accepts `meeting_url`) | `POST /bots` |
| Running bots | `get_bot_status` | `GET /bots/status` |
| Transcript (live or done) | `get_meeting_transcript` | `GET /transcripts/{platform}/{id}` |
| Search what was said, all meetings | `search_transcripts` | — |
| In-call chat (links, spellings, names) | `get_meeting_chat` | — |
| Title / metadata | `annotate_meeting` | — |
| Change language mid-call | `update_bot_config` | `PUT /bots/{platform}/{id}/config` |
| Leave | `stop_bot` | `DELETE /bots/{platform}/{id}` |
| History | `list_meetings`, `list_recordings`, `get_recording` | `GET /meetings`, `/recordings` |

## Procedure: attending a call

1. **Join.** Pass the full URL to `request_meeting_bot` (or parse it first).
   Bot name `Hermes`. Set the transcription language when known (`es` for
   Spanish calls) — auto-detect on short openings is often wrong.
2. **Label it.** Right after joining, `annotate_meeting` with a title
   (`<counterpart/company> — <purpose>`) and metadata linking any briefing
   (`briefing: ~/.hermes/data/meeting-briefings/<slug>.md`). Notes and live
   questions use this to find context.
3. **Confirm** with `get_bot_status` within ~60 s. A bot stuck in the lobby
   needs the host to admit it — tell the user, don't resend repeatedly.
4. **During the call**, answer user questions ("what did they say about
   pricing?") from `get_meeting_transcript`; quote the speaker and timestamp.
   Check `get_meeting_chat` for links and spelled-out names.
5. **End.** `stop_bot` when the meeting ends or the user asks, then run the
   `meeting-notes` skill on the transcript.

## Answering questions about past calls

- Use `search_transcripts` first ("when did Acme mention the budget?"); pull
  a full transcript only for the matching meeting. An hour-long call is
  roughly 15k tokens: quote the relevant lines in your reply, not the whole
  transcript, because Ornith's four slots are shared with cron jobs and PR
  reviews.
- Also search Basic Memory (`bm tool search-notes "<name>"`) — notes from
  past calls live in `~/.hermes/data/vexa-notes/` and are linked there.

## Constraints

- **`speak_in_meeting` talks out loud to everyone.** Only use it when the
  user explicitly asks for that exact message to be spoken. Never on your own.
  It speaks in Alexander's cloned voice (local VoiceStudio, ~3-10 s to start per
  sentence). Keep each call to one or two sentences. `409` = bot not admitted
  yet, retry once it is active; `503` = the voice engine is down (tell the user:
  `llamastash start voicestudio --wait` on the host). Local Vexa patch:
  ~/AI/engines/vexa-lite/voice-patch/README.md.
- Consent: when asked, say the bot is there to transcribe and take notes.
- Transcription is local faster-whisper on the CPU, model
  `Systran/faster-whisper-small.en` (checked 2026-10-28). That model is
  English-only: Spanish calls come out garbled even with `language: es`.
  Warn the user before a Spanish call and lean on the chat and the briefing
  until the model is switched to a multilingual one. Names, numbers and
  jargon are often misheard in English too. Cross-check them with the chat or the briefing;
  flag uncertain ones as `(?)` rather than presenting them as fact. Vexa
  leaves the speaker empty when unsure — keep it unknown, don't guess.
- `update_bot_config` may 404 on the open-core build; if it does, stop the
  bot and send a new one with the right config.
- No host-side poller is installed yet (`~/.hermes/scripts/vexa-poll.py`
  does not exist), so live-question and notes webhooks do not fire on their
  own. Run those skills by hand when the user asks.
