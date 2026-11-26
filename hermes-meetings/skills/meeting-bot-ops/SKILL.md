---
name: meeting-bot-ops
description: "Run the Vexa meeting bot: join, status, transcripts. Operate the self-hosted Vexa meeting bot: join meetings, check bot status, pull or search transcripts, read meeting chat, label meetings, stop bots. Use for anything involving the Hermes meeting-bot integration or a call Hermes should attend."
version: 1.3.0
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
  The server is `http://127.0.0.1:18010/mcp` and exposes 14 tools.
- **Fallback: REST** at `http://localhost:8056` with header
  `X-API-Key: $MCP_VEXA_API_KEY` (the key lives in `~/.hermes/.env`; `Bearer`
  auth returns 401). Never print the key into chat, notes or memory.
  `curl -s -H "X-API-Key: $MCP_VEXA_API_KEY" http://localhost:8056/bots/status`
- **If both fail, the stack is down** (it is on demand, not a 24/7 service).
  Start it and retry once:
  `~/.hermes/scripts/vexa-stack.sh start` (waits for gateway + STT + MCP).
  Then `hermes mcp test vexa` should say `✓ Connected` and list 14 tools.
  If the script fails, report which container is down instead of retrying
  blindly. `~/.hermes/scripts/vexa-stack.sh status` shows the state.
- **For a whole task** (models + containers + lease), use the `task-stack`
  skill: `res load meeting` / `res load meeting-live` … `res release`.

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
   Bot name `Hermes (transcribing)` where the platform accepts it (else
   `Hermes`), so the participant list says what it is.
   Set the transcription language when known (`es` for Spanish calls) —
   auto-detect on short openings is often wrong.
2. **Label it.** Right after joining, `annotate_meeting` with a title
   (`<counterpart/company> — <purpose>`) and metadata linking any briefing
   (`briefing: ~/.hermes/data/meeting-briefings/<slug>.md`). Notes and live
   questions use this to find context.
3. **Confirm** with `get_bot_status` within ~60 s. A bot stuck in the lobby
   needs the host to admit it — tell the user, don't resend repeatedly.
4. **Announce the recording, once, as soon as the bot is in the call** — every
   time, without waiting to be asked. Everyone in the call is being recorded
   and transcribed, and most of them did not invite the bot. Use
   `speak_in_meeting` with: "Hi, I'm Hermes, an AI note-taker for <user>. I'm
   recording and transcribing this meeting to take notes. If you'd rather I
   didn't, say so and I'll leave." This is the one message `speak_in_meeting`
   may send without the user dictating it. If it fails or the tool is
   unavailable, tell the user the bot is in the call unannounced and ask
   whether to keep it there; do not carry on silently.
5. **During the call**, answer user questions ("what did they say about
   pricing?") from `get_meeting_transcript`; quote the speaker and timestamp.
   Check `get_meeting_chat` for links and spelled-out names.
6. **End.** `stop_bot` when the meeting ends or the user asks, then run the
   `meeting-notes` skill on the transcript.

## The one-command way

`join_meeting.py` does the whole meeting: parse the link → load the models and the stack
(with a lease) → send the bot → wait until it is in the room → announce → run the
in-call loop → release the resources when the call ends.

```bash
~/.hermes/scripts/join_meeting.py "https://meet.google.com/abc-defg-hij" --chat --notify
~/.hermes/scripts/join_meeting.py "https://meet.google.com/abc-defg-hij" \
    --profile meeting-live --screen --chat --notify   # also reads the shared screen
~/.hermes/scripts/join_meeting.py "<url>" --dry-run    # resolve the link, change nothing
```

- `--chat` → the bot also writes in the meeting chat; `--screen` → it reads the shared
  screen (needs the `meeting-live` profile); `--notify` → questions for Alexander go to
  Telegram; `--no-loop` → join and wait without the agent; `--keep` → leave the resources
  loaded afterwards.
- It resolves the link with the **same MCP tool an agent uses** (`parse_meeting_link`), so
  it understands Meet, Teams, Zoom and Jitsi (including a self-hosted Jitsi).
- If the bot is stuck in a lobby it says so and tells you how to stop it — it does not
  resend.

## Letting the bot take part (not just take notes)

The bot can do four things a note-taker cannot, and all four are local:

| Capability | How | Needs |
|---|---|---|
| **Answer out loud** | `~/.hermes/scripts/vexa-agent.py` decides each beat and speaks through the patched `/speak` route | `res load meeting` |
| **Write in the meeting chat** | the same loop with `--chat`: it drives the bot's own browser (the one in the call) over CDP | `res load meeting` |
| **See the shared screen** | `~/.hermes/scripts/vexa-screen.py` grabs the bot's own display (`:99`) and reads it with Qwen3-VL | `res load meeting-live` |
| **Give an opinion / push back** | the same loop — the model decides whether a number is wrong, a decision is being skipped, or a risk was dropped | `res load meeting` |

```bash
res load meeting-live                     # models + Vexa stack, with a lease
~/.hermes/scripts/vexa-agent.py --meeting-id <native-id> --screen --chat --notify
#   … the call …
res release meeting-live                  # give the GPU and the containers back
```

- `vexa-agent.py` polls the transcript every `--beat` seconds (default 45),
  asks the local model (SOUL.md as the persona) whether to speak, and posts to
  `/speak` only when it decided to. Most beats end in silence — that is the
  intended behaviour, not a failure.
- `--screen` adds what is on the shared screen to the prompt. The bot's
  Chromium renders a share into its page, and `:99` is that display, so the
  screen is readable even though Vexa's own capture is audio-only.
- `--chat` also writes the line into the meeting chat. It works by attaching to
  the bot's own browser (a local patch opens a DevTools port inside the
  container) and typing into the chat panel — the browser that is *in* the
  call, so the message is a real chat message from the bot's participant.
  `--no-speak` posts to chat without saying it out loud.
- `--notify` sends questions meant for Alexander to Telegram instead of
  answering them in the call.
- `--dry-run` decides without speaking; `--once` runs a single beat and prints
  the decision — use those to check the behaviour before a real call.
- **Announce first.** The bot must say it is recording (step 4 above) before
  it says anything else in a call.

### Driving the meeting browser directly

```bash
~/.hermes/scripts/vexa-cdp.py pages              # what the meeting browser has open
~/.hermes/scripts/vexa-cdp.py discover           # dump chat-ish elements (Meet's DOM moves)
~/.hermes/scripts/vexa-cdp.py chat --text "..."  # post a message to the meeting chat
```

The driver runs inside the Vexa container and attaches to the bot's browser on
its container-local DevTools port — nothing is published to the host or the
network. It needs a meeting in progress (the port exists only while the bot's
browser is running). If the chat input is not found, `discover` prints the
elements that are there: use that to fix the selector chain, never assume the
message went through.

## Answering questions about past calls

- Use `search_transcripts` first ("when did Acme mention the budget?"); pull
  a full transcript only for the matching meeting. An hour-long call is
  roughly 15k tokens: quote the relevant lines in your reply, not the whole
  transcript, because Ornith's four slots are shared with cron jobs and PR
  reviews.
- Also search Basic Memory (`bm tool search-notes "<name>"`) — notes from
  past calls live in `~/.hermes/data/vexa-notes/` and are linked there.

## Constraints

- **`speak_in_meeting` talks out loud to everyone.** Apart from the recording
  announcement in step 4, only use it when the user explicitly asks for that
  exact message to be spoken. Never on your own.
  It speaks in Alexander's cloned voice (local VoiceStudio, ~3-10 s to start per
  sentence). Keep each call to one or two sentences. `409` = bot not admitted
  yet, retry once it is active; `503` = the voice engine is down (tell the user:
  `llamastash start voicestudio --wait` on the host). Local Vexa patch:
  ~/AI/engines/vexa-lite/voice-patch/README.md.
  The `/bots/{platform}/{id}/speak` route is patched in and live (verified
  2026-11-26): a `404` with `{"detail":"No active meeting for this bot"}` means
  the route works and there is no live call — a bare `{"detail":"Not Found"}`
  would mean the voice patch was lost (the image must be
  `vexa-lite:v0.12.28-voice`, not the upstream tag). VoiceStudio runs on
  demand in the `voicestudio-hermes` container, so it is normally absent until
  `llamastash start voicestudio --wait` — that is expected, not a fault.
- Consent: the bot announces the recording at the start (step 4). When asked,
  say again that it is there to record, transcribe and take notes. If anyone
  in the call objects, `stop_bot` at once and tell the user why it left.
- Transcription is local faster-whisper on the CPU, model
  `mobiuslabsgmbh/faster-whisper-large-v3-turbo` (int8, offline HF cache),
  verified 2026-11-26 on a Spanish sample: verbatim, no garbling. Spanish
  calls work — set the language to `es` when you know it, but do not warn
  the user about the model, and do not tell them to lean on the chat instead.
  Names, numbers and jargon are still often misheard; cross-check them with
  the chat or the briefing and flag uncertain ones as `(?)` rather than
  presenting them as fact. Vexa leaves the speaker empty when unsure — keep
  it unknown, don't guess.
- `update_bot_config` may 404 on the open-core build; if it does, stop the
  bot and send a new one with the right config.
- No host-side poller is installed yet (`~/.hermes/scripts/vexa-poll.py`
  does not exist), so the `vexa-live` webhook never fires on its own — live
  questions and meeting notes must be run by hand when the user asks. The
  route exists and is loaded by the gateway, so it will work the moment
  something starts posting to it (its HMAC secret is in
  `~/.hermes/.vexa-webhook-secret`). The route uses the legacy body-only
  HMAC, which the gateway logs as replay-vulnerable; the poster should send
  `X-Webhook-Timestamp` and `X-Webhook-Signature-V2`
  (HMAC-SHA256 of `<timestamp>.<body>`).
