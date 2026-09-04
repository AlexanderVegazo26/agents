# Memory

Unified, per-project durable memory for every agent in this SDLC framework. See the `project-memory` skill for full read/write conventions — this file is just the map.

## Layout

```
.claude/memory/<project-name>/
  vision.md            product-manager
  roadmap.md            product-manager
  stakeholders.md        product-manager
  glossary.md            shared
  constraints.md          shared
  risks.md                shared
  milestones.md            product-manager / release-manager
  releases.md               release-manager
  incidents.md               incident-commander
  technical-debt.md          software-engineer / solution-architect
  quality-history.md          qa-engineer
  lessons-learned.md           shared (retrospectives)
  changelog.md                 technical-writer
  requirements/                 product-analyst
  architecture/                  solution-architect
  decisions/                      solution-architect (ADRs)
  designs/                         ux-designer
  test-plans/                       qa-engineer
  runbooks/                          technical-writer / site-reliability
```

No project subdirectory is pre-created here — each agent creates `<project-name>/` and the files it owns the first time it has something durable to record for that project. Never fabricate a project folder or file just to look complete; an empty/missing file means nothing has been recorded yet, which is itself accurate information.

Project isolation is absolute: an agent never reads or writes another project's subdirectory, and never carries a convention, risk, or pattern from one project's memory into another's without re-establishing it holds here.

## A worked example

`sdlc-suite/memory-template/example/decisions/ADR-0001-example.md` shows the shape
of an ADR this suite expects — the header fields, the evidence-with-provenance
section, consequences in both directions, and a stated falsifier. It is fictional
on purpose: an adopter opening this directory should find the convention, not
somebody else's project decisions.

Nothing is pre-created here. Each agent creates `<project-name>/` and the files it
owns the first time it has something durable to record.
