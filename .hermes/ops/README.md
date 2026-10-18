# Hermes ops

Copies of the machine-level Hermes files that live in `~/.hermes` (not a git repo), kept here so they are tracked. Copy back by hand; nothing here is installed automatically.

| Path | Lives at | What |
|---|---|---|
| `scripts/claude_job.py` | `~/.hermes/scripts/` | Runs a cron job's model step on the Claude plan (`claude -p`, no tools, medium effort). Falls back to DeepSeek, Kimi, then local Ornith. |
| `scripts/*_claude.sh`, `scripts/claude-prompts/` | `~/.hermes/scripts/` | The four cron jobs on Claude: `ceo-daily-brief`, `engineering-radar`, `goals-checkin`, `proactive-digest`. |
| `config/sdlc-models.json` | `~/.hermes/sdlc-models.json` | Per-machine sdlc role routing; overrides the plugin's `models.json`. |
| `config/SOUL.md` | `~/.hermes/SOUL.md` | Hermes persona plus the model-routing, video and fallback rules. |
| `config/cron-routing.json` | read only | Each cron job's model, provider and fallback chain (no prompts or chat ids). |
| `config/config-routing.yaml` | read only | The routing parts of `config.yaml`: fallbacks, auxiliary, delegation, MoA, Telegram display. |

Not tracked: `config.yaml` as a whole, `cron/jobs.json`, `.env` and `auth.json` hold credentials, chat ids and business data.

`hermes-agent/cron/scheduler.py` carries a local patch (per-job `fallback_providers`), committed in that checkout and not here.
