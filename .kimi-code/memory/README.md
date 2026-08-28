# Memory

This directory is a pointer, not the memory root.

The SDLC suite's shared per-project memory lives at **`.claude/memory/<project-name>/`**. That location is tool-agnostic on purpose: the same memory is read and written whether the work is being driven by Claude Code, the legacy `kimi-cli`, or the current Kimi Code CLI.

See `.claude/memory/README.md` for the layout and `.claude/skills/project-memory/SKILL.md` for the full read/write conventions.

## Why not `.kimi-code/memory/`?

Memory is durable cross-tool context, not Kimi-specific configuration. Agents, skills, and workflows all reference `.claude/memory/<project>/` as the canonical path. Keeping memory there means:

- A project started under Claude Code can be picked up under Kimi Code without losing context.
- The `project-memory` skill does not need two variants.
- New agents or workflows do not need to know which CLI is running to find memory.

If you ever need Kimi-specific memory that should not be shared with other tools, create `.kimi-code/memory/<project>/` explicitly for that purpose only.
