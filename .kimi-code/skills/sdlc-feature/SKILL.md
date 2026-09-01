---
name: sdlc-feature
description: Run a feature end-to-end through the SDLC agent suite — requirements, design, build, independent verification, and release readiness. Use for a feature or change large enough to warrant the full lifecycle. Produces recommendations only; never deploys. Invoke with /skill:sdlc-feature, then describe the initiative in the next message.
type: flow
---

# SDLC Feature Flow

Run the full lifecycle for one prioritized initiative. At each phase, load the owning specialist's system prompt from `.kimi-code/agents/<role>.md`, act in that role, and pass the output to the next phase. Stop immediately if a phase produces no usable output.

```d2
BEGIN -> requirements

requirements: |md
  ## Phase 1 — Requirements

  Read `.kimi-code/agents/product-analyst.md` to load the product-analyst role.

  Convert the user's initiative into:
  1. Numbered, stable acceptance-criterion IDs.
  2. Numbered / traceable / risk-rated assumptions.
  3. A classification of touched surfaces: backend, frontend, data.
  4. Open questions.

  If you produced no acceptance criteria, output `<choice>stop-no-criteria</choice>`. Otherwise output `<choice>design</choice>`.
|

requirements -> stop-no-criteria: stop-no-criteria
requirements -> design: design

stop-no-criteria: |md
  ## Stopped

  Report that no acceptance criteria were produced, so the workflow cannot proceed. List any open questions and ask the human to clarify before retrying.
|
stop-no-criteria -> END

design: |md
  ## Phase 2 — Design

  Based on the surfaces from Phase 1, run design roles:
  - If **frontend** is in surfaces, read `.kimi-code/agents/ux-designer.md` and produce the UX specification (every interactive state, checkable accessibility targets).
  - Read `.kimi-code/agents/solution-architect.md` and produce the architecture assessment (measurable NFRs, constraints on UX).

  When both design outputs are ready, this phase is complete.
|

design -> build: build

build: |md
  ## Phase 3 — Build

  For each touched surface, load the matching builder role and implement:
  - backend → read `.kimi-code/agents/software-engineer.md`
  - frontend → read `.kimi-code/agents/ui-engineer.md` (also use the UX spec)
  - data → read `.kimi-code/agents/database-engineer.md`

  Pass the acceptance criteria and architecture context. If no surface produced an implementation, output `<choice>stop-no-build</choice>`. Otherwise concatenate the implementation outputs and output `<choice>verify</choice>`.
|

build -> stop-no-build: stop-no-build
build -> verify: verify

stop-no-build: |md
  ## Stopped

  Report that no build surface produced an implementation. Return the requirements and design outputs so the human can diagnose why.
|
stop-no-build -> END

verify: |md
  ## Phase 4 — Verify

  Run four verification lenses on the acceptance criteria and full implementation. For each lens, read the corresponding system.md and produce findings:
  1. `.kimi-code/agents/code-reviewer.md` — read-only review.
  2. `.kimi-code/agents/qa-engineer.md` — execution-based verification.
  3. `.kimi-code/agents/security-engineer.md` — attack-path review.
  4. `.kimi-code/agents/performance-engineer.md` — measured performance.

  For every finding, attempt to refute it from a different lens. Default to treating a finding as refuted if the refuter cannot substantiate it.

  Count confirmed vs refuted findings.
|

verify -> readiness: readiness

readiness: |md
  ## Phase 5 — Readiness

  Run in parallel:
  1. Read `.kimi-code/agents/release-manager.md` and produce a go/no-go **recommendation** from the confirmed findings.
  2. Read `.kimi-code/agents/technical-writer.md` and draft user-facing docs and release notes.

  Synthesize the final output: initiative summary, acceptance criteria, design notes, implementation summary, confirmed/refuted findings, readiness recommendation, documentation draft, and a list of decisions that still require a human.
|

readiness -> END: end

END: END
```
