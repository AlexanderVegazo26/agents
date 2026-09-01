# Taste

- Wants their agent/tooling setup to be model-agnostic — asked whether DeepSeek or any other model could drive the same custom agents (not locked into a single model/provider). Confidence: 0.5
- Maintains parallel copies of the same SDLC agent suite across every AI coding tool they use (Claude Code, Kimi Code, Command Code) — asked for a Command Code port "similar to the one created for kimi or claude" rather than a one-off suite. Confidence: 0.8
- Requests adversarial review of work — wants the agent to actively hunt for problems, drift, and inconsistencies between claims and actual state (e.g., documented sync counts vs. real files), not just positive verification. Confidence: 0.8
- When the agent flags drift or staleness, expects those issues to be actually fixed and verified end-to-end, not just reported — a terse "fix that" meant: resolve the flagged staleness, hunt down every related inconsistency (grant gaps, missing triggers), and re-run the sync/validators to confirm. Confidence: 0.6
- Wants their multi-tool agent/skill suite verified as actually loaded and functional in the current tool — asked whether all agents and skills were loading, expecting a check of live session state against what's on disk (and a straight answer about what is/isn't active) rather than an assumption that everything works. Confidence: 0.5
