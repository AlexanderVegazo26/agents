#!/usr/bin/env bash
# goals-checkin on the Claude plan: Sonnet writes it (DeepSeek if Claude fails).
exec "$HOME/.hermes/scripts/claude_job.py" --context-script goals_digest.sh \
  --prompt-file claude-prompts/goals-checkin.md --model sonnet
