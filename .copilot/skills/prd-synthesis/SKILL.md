---
name: prd-synthesis
description: Structure and discipline for synthesizing an as-built PRD from extracted evidence — describing what an existing system does, with citations and honest gaps. Used by product-archaeologist. Do NOT use for writing forward-looking requirements for something being built (that is `requirements-craft`) or for deciding what a rebuild should keep, cut, or improve — this document deliberately stops short of recommending anything.
---

# PRD Synthesis

## The one rule that matters
An as-built PRD is a description of what exists, evidenced, not an opinion about what should change. Every sentence that starts drifting toward "this should be improved by..." belongs in a separate, clearly labeled section — or better, left for `product-manager` and `product-analyst` to decide once they've read the evidence.

A PRD that mixes discovered fact with the author's redesign preferences is far less useful to the people who have to make that call, because they can no longer tell which parts are ground truth. This is the same separation `qa-engineer` enforces between observation and interpretation, applied to a document instead of a finding.

## Document structure

**1. Overview** — what the system is, who it appears to serve (cross-referencing `persona-discovery`'s roster where it exists), what problem it evidently solves, at the level a new team member or a downstream product agent needs to orient.

**2. Capability inventory** — every confirmed and candidate capability from `capability-extraction`, grouped by user-facing area or subsystem, each with its status (confirmed/candidate/rejected) and citation. Group by what a user or operator would recognize, not by internal code structure.

**3. Business rules** — every discovered rule (validation, calculation, workflow, permission), cited, with status. Flag anything that reads as a possible defect rather than deliberate design explicitly, per `capability-extraction`'s guidance — don't launder a bug into looking like a documented rule.

**4. Data model** — entities, relationships, and constraints as reconstructed from schema and code, described as the domain model the system actually operates on.

**5. Integration surface** — external dependencies, in both directions.

**6. Non-functional baseline** — what's actually true today about scale, auth, deployment — described factually, not evaluated.

**7. Gaps and findings** — evidenced pain points (dead code, abandoned flags, defensive-code clusters, repeated-fix history), persona/capability mismatches, and requirement/implementation mismatches where `product-analyst` data exists. This section can and should surface *where* the evidence points to a problem — it should stop short of prescribing the fix.

**8. What could not be determined** — every source type that was absent or inaccessible, and every ambiguity left unresolved. Silent omission here is worse than an honest gap; a downstream team that doesn't know what wasn't checked will assume it was.

**9. Evidence appendix** — the full citation list, so any claim in the document can be traced back to what actually supports it.

## Status vocabulary
Carry `capability-extraction`'s confirmed/candidate/rejected through to the document itself, per item — not as a summary judgment on the PRD as a whole. A reader deciding what to carry forward into a rebuild needs to know which specific capabilities are solidly evidenced and which rest on a single source.

## Handoff framing
Address the document to its actual downstream readers explicitly:

- **`product-manager`** — deciding what's worth carrying forward at all.
- **`product-analyst`** — writing new numbered requirements informed by this baseline, which becomes traceable ground truth rather than institutional memory.
- **`solution-architect`** — assessing what technical debt and data-model reality a rebuild has to reckon with.
- **`ux-designer`** — deciding which discovered interaction patterns are worth preserving versus improving.

None of those decisions belong in this document — it equips them to make it. If a reader could not tell, from reading a section, whether a sentence is a discovered fact or an author's preference, that section needs rewriting.
