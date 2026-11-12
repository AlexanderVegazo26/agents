# Model routing — pick the cook by the stage

Every agent in this suite pins a Claude Code model **tier** (`model:`) and an
**effort** level (`effort:`) in its frontmatter. The pin is chosen by the stage
of the lifecycle the agent serves and the cost of a mistake there, not by
habit. `sdlc-suite/tools/generate_trees.py` enforces the vocabulary.

> Don't send the head chef to chop carrots — and never send the prep cook to
> plan the menu.

## The four cooks

| Tier (`model:`) | Role | Current model | $ / 1M tokens in / out |
|---|---|---|---|
| `fable` | Head chef | Claude Fable 5.2 | 8 / 40 |
| `opus` | Sous-chef | Claude Opus 5.5 | 4 / 20 |
| `sonnet` | Line cook | Claude Sonnet 5.5 | 2 / 10 |
| `haiku` | Prep cook | Claude Haiku 5.5 | 0.10 / 0.50 |

Prices are Anthropic first-party API rates as of 2026-11. The alias resolves to
the current model of that tier, so the pins do not go stale on a release.

Effort (`effort:`) is `low` < `medium` < `high` < `xhigh` < `max`. It sets
thinking depth and token spend within one model. On Fable, start at `high`;
gains above it are uneven, so `xhigh` is kept for work where it is the best
you have (security).

## The rules

1. **Artifacts over chat.** Each stage commits a file the next stage reads:
   `intent.md` → `spec.md` → `plan.md` → diff + tests → PR + review findings →
   incident record. No artifact, nothing for the next cook to taste.
2. **Plan expensive, execute cheap.** Head-chef tokens go on intent, spec and
   plan. Once those are locked, the line cook implements. Institutional
   knowledge lives in `CLAUDE.md` and skills, not in the model, which is what
   lets a cheaper model perform like a senior.
3. **A different cook tastes the dish; a human approves.** The implementer
   never certifies its own work (ROUTING.md §2). Review runs on a different
   agent, and usually a different tier, from the one that wrote the code.

## Stage map

| Stage | Agent | Tier | Effort | Artifact |
|---|---|---|---|---|
| Plan | `product-manager` | fable | high | `intent.md`, PRD |
| Plan | `solution-architect` | fable | high | `spec.md`, ADRs, `plan.md` |
| Plan | `product-analyst` | opus | high | requirements, acceptance criteria |
| Design | `ux-designer` | opus | xhigh | flows, mock |
| Design | `ui-engineer` | opus | xhigh | frontend diff |
| Design | `motion-designer` | opus | high | motion spec / composition |
| Build | `software-engineer` | sonnet | medium | diff + tests, against an approved plan |
| Build | `database-engineer` | opus | high | migration (data loss is not cheap to undo) |
| Build | `prototyper`, `video-editor` | sonnet | medium | prototype, edit |
| Search | `product-archaeologist` | sonnet | low | as-built PRD from cited evidence |
| Test | `qa-engineer` | sonnet | medium | test plan, tests |
| Test | `qa-runner`, `persona-runner` | haiku | low | raw execution evidence |
| Test | `boundary-prober`, `persona-discovery`, `journey-orchestrator` | sonnet | medium | findings, personas, journeys |
| Review | `code-reviewer` | opus | high | review findings |
| Review | `performance-engineer` | opus | high | perf findings |
| Review | `security-engineer` | fable | xhigh | security assessment |
| Deploy | `release-manager` | opus | high | release authorization |
| Maintain | `site-reliability` | sonnet | medium | SLOs, runbooks, detection |
| Maintain | `incident-commander` | opus | max | incident record, the bug nobody can find |
| Docs | `technical-writer` | sonnet | medium | docs |
| Routing | `orchestrator` | sonnet | medium | dispatch decisions |

Auth, payments and anything that moves money or identity are never routed
below `opus`: send them through `solution-architect` for the plan and
`security-engineer` for the review, whatever agent builds them.

## Changing a pin

- Edit the agent in `sdlc-suite/agents/`, then run
  `python sdlc-suite/tools/generate_trees.py` and `python sdlc-suite/tools/bump.py --apply`.
- Allowed `model:` values: `inherit`, `fable`, `opus`, `sonnet`, `haiku`.
  Never a concrete model id: ids are not portable across harnesses.
- `inherit` means "follow the session model" — use it for an agent whose cost
  should track whoever invoked it.
- Move a pin down only with evidence (the cheaper tier passed the same task),
  and up only for a named failure the cheaper tier made.

## Other harnesses

The pins are Claude Code settings. The generator maps them per harness:

| Harness | `model:` | `effort:` |
|---|---|---|
| Claude Code (`.claude/`, plugin) | kept | kept |
| Command Code | omitted, follows the session | dropped |
| Kimi, Copilot, Codex | not emitted | not emitted |
| pi | passed as `--model`; falls back to the default model when unavailable | not read |
| Hermes | mapped through `role_model_aliases` in `.hermes/plugins/sdlc/models.json` (fable/opus → deep, sonnet → balanced, haiku → fast) | not read |
