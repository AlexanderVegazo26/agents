# Hermes ops

Copies of the machine-level Hermes files that live in `~/.hermes` (not a git repo), kept here so they are tracked. Copy back by hand; nothing here is installed automatically.

| Path | Lives at | What |
|---|---|---|
| `scripts/claude_job.py` | `~/.hermes/scripts/` | Runs a cron job's model step on the Claude plan (`claude -p`, no tools, medium effort). Falls back to DeepSeek, Kimi, then local Ornith. |
| `scripts/*_claude.sh`, `scripts/claude-prompts/` | `~/.hermes/scripts/` | The four cron jobs on Claude: `ceo-daily-brief`, `engineering-radar`, `goals-checkin`, `proactive-digest`. |
| `scripts/stt_shim.py`, `systemd/hermes-stt-shim.service` | `~/.hermes/scripts/`, `~/.config/systemd/user/` | Fixed-port (11436) front for the LlamaStash whisper launch; Hermes voice notes use it because the 0.8.0 proxy has no audio route. Enable with `systemctl --user enable --now hermes-stt-shim`. |
| `scripts/hermes-transcribe`, `scripts/video_edit_mcp.py` | `~/.hermes/scripts/` | Local SRT transcription for the Opus video role; `video_edit` with a 404 fallback to `stt-transcribe`. |
| `config/sdlc-models.json` | `~/.hermes/sdlc-models.json` | Per-machine sdlc role routing; overrides the plugin's `models.json`. |
| `config/SOUL.md` | `~/.hermes/SOUL.md` | Hermes persona plus the model-routing, video and fallback rules. |
| `config/cron-routing.json` | read only | Each cron job's model, provider and fallback chain (no prompts or chat ids). |
| `config/config-routing.yaml` | read only | The routing parts of `config.yaml`: fallbacks, auxiliary, delegation, MoA, Telegram display. |

Not tracked: `config.yaml` as a whole, `cron/jobs.json`, `.env` and `auth.json` hold credentials, chat ids and business data.

`hermes-agent/cron/scheduler.py` carries a local patch (per-job `fallback_providers`), committed in that checkout and not here.
