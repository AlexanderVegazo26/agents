---
name: documentation
description: Structure and formatting conventions for technical documentation — task-oriented writing, runbook layout, and keeping docs accurate over time. Load for the mechanics of how a doc should be shaped. Do NOT use as a substitute for the `sdlc-suite:technical-writer` agent, which owns authorship, audience decisions, and verifying that every behavioral claim matches the actual system — this skill covers conventions, that agent covers whether the content is true.
---

# Documentation

## Accuracy over completeness

A shorter doc that's entirely true beats a longer one with a stale section — a wrong doc actively misleads because it's trusted. Verify every behavioral claim against the actual current system before writing it down.

## Structure for the reader's task

Organize around what the reader is trying to accomplish ("how do I authenticate," "how do I roll back a deploy"), not around the internal structure of the code. A reference doc (exhaustive, structured by API/module) and a guide (task-oriented, narrative) serve different needs — know which one you're writing.

## Runbook conventions

Numbered steps, explicit preconditions, expected output at each step so the operator can tell if something's already gone wrong, and a clear escalation path if the steps don't resolve it. Written for someone unfamiliar with the system's internals under time pressure — not for the author who already knows how it works.

## Keeping docs current

Update documentation in the same change that alters the behavior it describes, not as a deferred follow-up that quietly never happens. Flag stale docs found incidentally rather than either silently fixing unrelated staleness (scope creep) or ignoring it (letting it rot further) — note it and let the owner decide priority.

## Release notes

State what changed, why it matters to the reader (not just what changed internally), and any action required of them — breaking changes and required migrations go first and prominent, not buried at the bottom of a long list.
