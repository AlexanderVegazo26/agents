#!/usr/bin/env bash
# proactive-digest on the Claude plan: Sonnet writes it (DeepSeek if Claude fails).
exec "$HOME/.hermes/scripts/claude_job.py" --context-script proactive_digest.sh \
  --prompt-file claude-prompts/proactive-digest.md --model sonnet
