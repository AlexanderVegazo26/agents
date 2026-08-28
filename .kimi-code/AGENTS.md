# SDLC Agent Suite — Kimi Code availability

This project contains a full software-development-lifecycle agent suite converted to Kimi Code format.

> The suite is installed **globally** (any repo) via `~/.kimi-code/config.toml` extra dirs and `~/bin` shims.
> Setup, unattended usage, and troubleshooting: `.kimi-code/GLOBAL-SETUP.md`.

## Skills

Project-scope skills are auto-discovered from `.kimi-code/skills/`. This includes **59 domain skills** (mirrored from `.claude/skills/`) plus **6 flow skills** (rebuilt from `.claude/workflows/*.js`). Load a skill by mentioning it, with `/skill:<name>`, or run a flow with `/flow:<name>`.

> Note: `.claude/skills/` is **not** auto-discovered by the current Kimi Code. The domain skills are copied into `.kimi-code/skills/` so they are visible.

## Agents

Custom agents live in `.kimi-code/agents/*.md` and are discovered automatically. They can be selected as the main agent with `--agent <name>` or `--agent-file <path>`, or delegated to as sub-agents by name.

Available agents:

- **software-engineer** — implementation, refactoring, debugging
- **code-reviewer** — independent read-only design review
- **qa-engineer** — adversarial test design and execution
- **qa-runner** — raw test/command execution specialist
- **security-engineer** — threat modeling and security review
- **performance-engineer** — load, performance, capacity
- **database-engineer** — schema, migrations, data integrity
- **ui-engineer** — frontend implementation
- **ux-designer** — user experience and interaction design
- **solution-architect** — system design and ADRs
- **product-manager** — strategy and prioritization
- **product-analyst** — requirements and acceptance criteria
- **product-archaeologist** — reverse-engineer existing systems
- **persona-discovery** — derive user personas from code
- **persona-runner** — exploratory testing as one persona
- **boundary-prober** — cross-persona authorization probing
- **journey-orchestrator** — multi-actor user flows
- **release-manager** — release readiness and go/no-go
- **technical-writer** — docs, runbooks, release notes
- **site-reliability** — observability, SLO, first response
- **incident-commander** — incident coordination

Example:

```bash
kimi --agent software-engineer
```

## Workflows

The original `.claude/workflows/*.js` orchestrations have been rebuilt as Kimi flow skills in `.kimi-code/skills/`:

- **/flow:sdlc-feature** — full lifecycle: requirements → design → build → verification → readiness
- **/flow:independent-review** — four-lens review with adversarial cross-check
- **/flow:release-readiness** — five gates → release-manager recommendation
- **/flow:persona-qa-sweep** — derive personas → explore → probe → triage
- **/flow:system-archaeology** — reverse-engineer who + what from code evidence
- **/flow:registry-audit** — re-audit the registry for orphans, overlap, agnosticism, consistency

Example:

```bash
kimi
/flow:sdlc-feature
Add CSV export to the reporting dashboard
```

## Memory

Shared per-project memory lives at `.claude/memory/<project>/` (tool-agnostic by design). See `.kimi-code/memory/README.md` for why it is not duplicated here.
