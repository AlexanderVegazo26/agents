#!/usr/bin/env bash
# engineering-radar on the Claude plan: Sonnet drafts, Opus reviews and corrects (DeepSeek if Claude fails).
exec "$HOME/.hermes/scripts/claude_job.py" --context-script github_context.sh \
  --prompt-file claude-prompts/engineering-radar.md --model sonnet --review-model opus
