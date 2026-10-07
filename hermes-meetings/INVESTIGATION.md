# Hermes in Meetings — Open Source Integration Investigation

Goal: give Hermes personality + agency so it can join meetings, take notes,
transcribe, and generate questions in realtime. This report maps verified
open-source tools onto Hermes's actual, verified extension points.

## 1. What Hermes already has (verified on this machine)

| Capability | Evidence |
|---|---|
| Plugin API | `.hermes/plugins/sdlc/` — `plugin.yaml` declares `provides_tools`; Python `register(ctx)` exposes `register_tool(name, toolset, schema, handler)`, `register_command`, `register_cli_command`; Node `runner.mjs` is the subprocess backend (JSON stdin/stdout) |
| MCP toolsets | `-t/--toolsets` flag, MCP servers managed via `hermes` CLI; security audit covers MCP servers |
| Webhook → agent activation | `hermes webhook subscribe` — POST to `/webhooks/<name>` runs an agent turn with `--prompt` template using `{dot.notation}` payload refs, optional `--skills`, `--deliver` to Telegram/Discord/Slack, `--deliver-only` (zero LLM), `--mirror-to-session`, HMAC secret |
| Cron agency loop | `hermes cron` — scheduled jobs with durable run history, incidents, and per-job `notepad` KV |
| Messaging gateway | Running (Telegram + webhook platforms enrolled; Slack/WhatsApp/Discord available via `hermes gateway setup`) |
| Outbound push | `hermes send -t telegram` etc. from any shell script |
| Local STT | `faster-whisper 1.2.1` + `ctranslate2` already in the venv ("Speech-to-Text: local faster-whisper") |
| Personality | `~/.hermes/SOUL.md` system personality + project/local skills (`.hermes/skills/`), including `persona-qa-sweep` |
| Models | Local Ornith-1.5-35B (llamastash), cc-bridge, Nous Portal, Anthropic |

Key insight: Hermes is an event-driven agent already. Meetings are just another
event source. The bot is the *ears and voice*; Hermes is the *brain*.

## 2. Architecture that fits

```
Meeting (Meet/Teams/Zoom)
   │  joins as participant
   ▼
Meeting-bot layer (open source, self-hosted)
   │  realtime speaker-attributed transcript stream
   ▼
Local bridge (script / MCP / webhook POST)
   │  transcript chunks + events (joined, ended)
   ▼
HERMES (gateway webhook / cron / plugin tool)
   ├─ skills: meeting-notes, live-questions, persona
   ├─ generates questions + notes with its own LLM
   └─ delivers via `hermes send` (Telegram) or TTS back into call
```

Two modes:
- **Listen-only Hermes (works today):** bot transcribes → Hermes receives chunks
  via webhook/cron → notes + questions land in Telegram/Obsidian, optionally
  posted into the meeting chat.
- **Speaking Hermes (needs voice pipeline):** Pipecat/LiveKit bot does
  STT → Hermes LLM → TTS so Hermes can ask questions *in the call*.

## 3. Candidate open-source tools (verified)

### Primary: Vexa — self-hosted meeting-bot API + MCP
- https://github.com/Vexa-ai/vexa — Apache-2.0, ~2.9k stars
- Bots join **Google Meet, Microsoft Teams, Zoom** (Jitsi in validation).
- Real-time, speaker-attributed transcript via REST (poll) + Redis stream;
  WebSocket multiplex planned. STT unit is **faster-whisper** (reuse your GPU /
  your existing venv model).
- Ships an **MCP endpoint at `/mcp`** → register as a Hermes toolset, so Hermes
  can call `send-bot`, `get-transcript`, `stop-bot` natively as tools.
- Agent control plane (`/agent/chat`, routines, events) — but per the README:
  "Vexa runs no model of its own during a meeting: there is one intelligence and
  it is your agent." That is exactly the Hermes-as-brain design.
- Honest caveats (v0.12): `POST /bots/{id}/speak` (TTS into call) and live bot
  config return 404 in open-core today — in-call *speaking* is not there yet.
- Deploy: `make lite` (single container) or `make all` (Docker Compose) on the
  Linux box; API key printed at first boot.

### Speaking in-call: Meeting-Baas speaking-meeting-bot (Pipecat)
- https://github.com/Meeting-Baas/speaking-meeting-bot
- Expands **Pipecat** (BSD-2, https://github.com/pipecat-ai/pipecat) into AI
  meeting agents that join and **participate** in Google Meet + Teams with
  "distinct personalities and capabilities defined in Markdown files" — i.e.,
  feed it your SOUL.md.
- Full STT → LLM → TTS voice loop. Wire the LLM step to Hermes (local
  OpenAI-compatible endpoint or `commandcode-gateway` on 127.0.0.1:11440) so
  the *personality and brain* are Hermes's, not a third-party model.
- Best path for: Hermes actually asking questions aloud mid-meeting.

### LiveKit Agents — realtime voice framework (alternative)
- https://github.com/livekit/agents — Apache-2.0, Python/Node SDKs
- Realtime STT/LLM/TTS pipelines with built-in transcription. Joining Meet/Zoom
  requires LiveKit Cloud's meeting/SIP gateway (commercial bridge) or a
  self-built ingress; stronger fit for LiveKit-native rooms than for Meet/Zoom.

### Lighter / fallback options
- **Attendee** (https://github.com/attendee-labs/attendee) — meeting-bot API,
  Elastic License 2.0 (source-available, NOT OSI open source). Mentioned for
  completeness; license rules it out if "open source" is a hard requirement.
- **meeto** (PyPI) / **google-meet-bot** (PyPI) — Python Google-Meet-only bots:
  join, record, transcribe with whisper, summarize. Small, single-platform,
  good for a weekend prototype.
- **Whisper family for STT:** `faster-whisper` (already installed in Hermes's
  venv), `whisper.cpp`, `Vosk` (true streaming).

## 4. Wiring: how each Hermes extension point is used

1. **Plugin tool (`~/.hermes/plugins/meetings/`)**
   - `plugin.yaml` → `provides_tools: [meeting_bot, meeting_transcript, meeting_stop]`
   - Python `__init__.py` registers tools whose handlers call the Vexa API
     (localhost:18056). Or skip the plugin: Vexa's `/mcp` endpoint is an MCP
     server — add it as a Hermes toolset (`hermes` MCP config) and Hermes gets
     the tools for free.
2. **Webhook (event → agent turn)**
   - Vexa events (bot joined, meeting ended) or a cron-driven transcript poller
     POSTs to `hermes webhook subscribe` routes:
     - `meeting-live-questions` — prompt: "You are in meeting {meeting_id}. Last
       transcript: {transcript}. Generate the 3 sharpest questions to ask now.
       Reply in Hermes's voice (SOUL.md)." with `--skills live-questions` and
       `--deliver telegram`.
     - `meeting-notes` — on meeting end: full transcript → structured Markdown
       notes into `~/AI/memory/projects/` (the Basic Memory vault) via `bm` CLI.
3. **Cron (the agency loop)**
   - A `hermes cron` job every 1–2 min during meetings polls
     `GET /transcripts/{platform}/{id}`, diffs against the job's `notepad`
     cursor, and on new chunks either triggers a webhook route or a
     `hermes chat -Q` turn with the meeting-notes skill. Durable runs +
     incidents make this auditable.
4. **Personality**
   - SOUL.md already sets the voice. Add two skills:
     - `meeting-notes` — how to structure notes: decisions, action items,
       owners, open questions, per-speaker.
     - `live-questions` — Socratic, short, non-interrupting question style;
       throttle rules (max 1 question per N minutes unless asked).
   - For the speaking bot, export the same persona into the Pipecat bot's
     Markdown personality file so in-call voice == chat voice.

## 5. Recommended rollout

- **Phase 1 (listen + notes + realtime questions):** Vexa `make lite` self-hosted
  + Vexa MCP toolset in Hermes + `hermes webhook subscribe` for `meeting-live-questions`
  and `meeting-notes`, delivered to Telegram. Hermes's existing faster-whisper
  venv can serve as the Vexa STT unit.
- **Phase 2 (in-call voice):** Meeting-Baas speaking-meeting-bot (Pipecat) with
  its LLM step pointed at Hermes (cc-bridge / local llamastash endpoint), and
  its Markdown persona generated from SOUL.md. Vexa remains the transcription/
  archive layer, or the Pipecat bot's transcript is posted to the same webhook
  routes.
- **Phase 3 (full agency):** calendar-synced auto-join (Vexa ICS), pre-meeting
  briefs via cron (hermes reads memory + Vexa workspace), post-meeting commits
  to the memory vault.

## 6. Open questions / risks

- Vexa open-core currently lacks TTS-in-call (`/bots/{id}/speak` 404) — Phase 2
  needs the Pipecat route or waiting on Vexa roadmap.
- WebSocket transcript streaming in Vexa is "planned" — Phase 1 uses polling
  (fine at 1–2 min question cadence).
- Zoom/Teams bot admission requires platform-side bot apps/permissions in most
  tenants; Google Meet (personal/workspace with allow-listed accounts) is the
  easiest first target.
- Running a bot in meetings has legal/etiquette constraints (consent,
  recording notices) — configure Vexa capture-only vs transcription per call.
