#!/usr/bin/env bash
# ceo-daily-brief on the Claude plan: Sonnet drafts, Opus reviews and corrects.
exec "$HOME/.hermes/scripts/claude_job.py" --context-script brief_context.sh \
  --prompt-file claude-prompts/ceo-daily-brief.md --model sonnet --review-model opus
