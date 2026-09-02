---
name: project-memory
version: 1.0.0
description: Conventions for reading and writing the unified per-project memory at .claude/memory/<project>/ — what belongs in each file, when to update it, and how agents across the SDLC share durable context. Load before writing to memory, or when picking up a project to see what's already known.
---

# Project Memory

All SDLC agents share one memory root: `.claude/memory/<project-name>/`. It is durable, per-project context — not a session log, not a duplicate of what git/the codebase already tells you.

## Layout

```
.claude/memory/<project>/
  vision.md            product-manager: problem, target user, north-star outcome
  roadmap.md            product-manager: sequenced initiatives and why
  stakeholders.md        product-manager: who cares about what, and how to reach them
  glossary.md            everyone: domain terms, defined once, referenced everywhere
  constraints.md          everyone: hard constraints (regulatory, technical, org) that shape decisions
  risks.md                everyone: standing risks, owner, mitigation status
  milestones.md            product-manager/release-manager: target dates and what they gate
  releases.md               release-manager: what shipped, when, go/no-go record
  incidents.md               incident-commander: incident history and root causes
  technical-debt.md          software-engineer/solution-architect: known debt, cost of carrying it
  quality-history.md          qa-engineer: defect density, flaky tests, quality-attribute scope decisions
  lessons-learned.md           everyone: retrospective takeaways that should change future behavior
  changelog.md                 technical-writer: human-readable history of what changed
  requirements/                product-analyst: requirement sets per initiative
  architecture/                 solution-architect: current-state architecture docs
  decisions/                     solution-architect: ADRs
  designs/                        ux-designer: wireframes, journey maps, design decisions
  test-plans/                      qa-engineer: standing test strategy per area
  runbooks/                         technical-writer/site-reliability: operational procedures
```

## Rules

1. **Per-project isolation.** Never read or write another project's memory, and never carry a convention/assumption from one project's memory into another's without re-establishing it holds here.
2. **Write at the natural checkpoint**, not continuously — end of a workflow stage (roadmap set, ADR finalized, release shipped, incident closed), not mid-task scratch notes.
3. **Never record anything that would justify skipping a future check.** Memory tells an agent where to look harder or what happened before — never "this is fine, don't bother testing/reviewing it again."
4. **Keep entries factual and dated.** Update or remove stale entries rather than letting contradictory history accumulate.
5. **One file per concern** — don't blend `risks.md` content into `roadmap.md` because it was convenient at write time; a future reader (or agent) will look in the file named for what they need.
6. **Cross-reference, don't duplicate.** An incident that created technical debt gets one entry in `incidents.md` and a link (not a copy) in `technical-debt.md`.
