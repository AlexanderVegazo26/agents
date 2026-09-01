---
name: system-archaeology
description: Reverse-engineer an undocumented system — derive who uses it and what it does from code evidence in parallel, cross-check the two, and synthesize an as-built PRD. Use when planning a rebuild or onboarding onto a poorly documented system. Produces evidence only; never a recommendation about what to change. Invoke with /skill:system-archaeology, then describe the scope in the next message.
type: flow
---

# System Archaeology Flow

Detect the stack, excavate who uses the system and what it does in parallel, cross-check the two evidence sets, and synthesize a strictly descriptive as-built PRD.

```d2
BEGIN -> detect

detect: |md
  ## Phase 1 — Detect

  Identify the scope from the user's request (default: the whole application). Note any optional non-production observation target.

  Read `.kimi-code/agents/product-archaeologist.md` and detect the stack: language, framework, auth mechanism, data layer, API style, test tooling, deployment shape. Read manifests, lockfiles, and config, and report what could not be determined.

  If stack detection produced no result, output `<choice>stop-no-stack</choice>`. If the auth mechanism could not be located, output `<choice>stop-no-auth</choice>`. Otherwise output `<choice>excavate</choice>`.
|

detect -> stop-no-stack: stop-no-stack
detect -> stop-no-auth: stop-no-auth
detect -> excavate: excavate

stop-no-stack: |md
  ## Stopped

  Report that stack detection produced no result, so nothing downstream can proceed on evidence. Ask the user to clarify the scope or provide documentation.
|
stop-no-stack -> END

stop-no-auth: |md
  ## Stopped

  Report that the auth mechanism could not be located. This is persona-discovery's explicit stop condition and undermines permission-rule extraction. Ask the user to point to auth code or docs.
|
stop-no-auth -> END

excavate: |md
  ## Phase 2 — Excavate

  Run two archaeology passes in parallel, both with the stack context:
  1. Read `.kimi-code/agents/persona-discovery.md` and derive who uses the system from authorization code with path:line provenance.
  2. Read `.kimi-code/agents/product-archaeologist.md` and extract capabilities, business rules, data model, integration surface, and non-functional baseline.

  For the capability extraction, use static evidence only unless a non-production observeTarget was explicitly supplied. Every claim needs a citation. Describe what exists; do not recommend what to change.

  If product-archaeologist produced no as-built output, output `<choice>stop-no-asbuilt</choice>`. Otherwise output `<choice>cross-check</choice>`.
|

excavate -> stop-no-asbuilt: stop-no-asbuilt
excavate -> cross-check: cross-check

stop-no-asbuilt: |md
  ## Stopped

  Report that capability extraction produced no result. Return the stack and persona outputs so the user can diagnose.
|
stop-no-asbuilt -> END

cross-check: |md
  ## Phase 3 — Cross-check

  Read `.kimi-code/agents/product-archaeologist.md` and cross-check the personas against the as-built capabilities and any existing requirements in `.claude/memory/<project>/requirements/`.

  Report four mismatch classes as findings:
  1. A capability no persona can reach.
  2. A persona whose jobs have no corresponding capability.
  3. An implemented capability with no product requirement.
  4. A requirement with no implementation trace.

  Also list candidate-status capabilities and flag if more than half are candidates.
|

cross-check -> synthesize: synthesize

synthesize: |md
  ## Phase 4 — Synthesize

  Read `.kimi-code/agents/product-archaeologist.md` and:
  1. Synthesize the as-built PRD per prd-synthesis's nine-section structure. Write it to `.claude/discovery/prd.md` with an evidence-matrix appendix at `.claude/discovery/evidence-matrix.md`. Describe what exists only.
  2. Write a handoff brief naming what each downstream agent needs and what remains an open question. Frame every item as input, never as a recommendation.

  Present the PRD summary, cross-check findings, downstream handoff, and observation mode.
|

synthesize -> END: end

END: END
```
