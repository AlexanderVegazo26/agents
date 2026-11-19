---
description: Run a feature end-to-end through the SDLC agent suite — plan expensive, execute cheap — plan, design, build, test, review, release readiness, each stage handing the next a file
argument-hint: <initiative description>
---

> **Pi.** This command invokes the `Workflow` tool, which under pi is the
> `workflow` tool registered by the `.pi/extensions/sdlc/` extension. Call
> it with the `scriptPath` and the `args` OBJECT below — an object, never
> a bare string — and report the pipeline's result, not a substitute. If
> the `workflow` tool is not available in this session (the extension is
> not loaded), say so to the user; do not improvise a substitute run, and
> do not report a result this pipeline did not produce.

Invoke the `Workflow` tool with:

```
scriptPath: "sdlc-suite/workflows/sdlc-feature.js"
args: { "initiative": "$ARGUMENTS", "runtimeDir": "sdlc-suite/workflows", "policyDefault": "sdlc-suite/autonomy.json" }
```

Do not reimplement the orchestration inline — the script is the plan. When it returns, relay the readiness recommendation and the `humanDecisionRequired` list verbatim; this workflow produces recommendations and never deploys.

Pass `args` as the literal OBJECT above, never a bare string. `runtimeDir` is what lets the workflow reach its run recorder, retry breaker, learnings loader and policy loader; a string `args` carries none of it, and the run then records nothing and learns nothing — the workflow reports that as status `incomplete` with a `runtime.unreachable` blocked gate, never as `completed`. `policyDefault` is the plugin's shipped policy, a fallback: a repo's own `.claude/autonomy.json` overrides it. To make a run stricter than the repo allows, also pass `policy`: an explicit policy is INTERSECTED with the repo's (a gate is authorized only if both authorize it), so it can tighten a repo's policy and never loosen it.

Model tiers — plan expensive, execute cheap. Every mechanical bridge step (run recording, policy, handoff files) runs on Haiku and is sealed — its script and output cross as hex with a SHA-256, in chunks under the host's output limit — unless `"tiers": "inherit"` pins nothing. Plan (product-manager → `intent.md`, product-analyst → `spec.md`, solution-architect → `plan.md`) runs on Opus/high; Design (ux-designer spec, ui-engineer static mock) on Opus/high; Build on Sonnet/medium; Test on Sonnet, with qa-runner's execution loops on Haiku; Review on Opus/high, security on Opus/high; readiness on Opus. Fable is opt-in per stage for risky changes (auth, payments, destructive data changes, concurrency, lasting architecture): `"tiers": { "plan": { "model": "fable" }, "security": { "model": "fable" } }`. Each stage's file lands in `<runDir>/handoff/`; the return value's `handoff` lists the ones on disk. A builder that hits a decision the plan left open escalates it in `planGaps` instead of improvising — relay those with the readiness recommendation. To pin nothing, add `"tiers": "inherit"` to `args`, or override one stage, e.g. `"tiers": { "plan": { "model": "opus" }, "security": { "model": "opus" } }`.

Spec mode — durable files beside the change, as in a `specs/features/<HU>/` layout. Add `"specDir": "specs/features/HU-22"` to `args`:

- A person's `intent.md` in that directory is the intent: product-manager does not run, and Plan does not start without it.
- `spec.md`, `plan.md`, `design.md`, `mock.html` and `test-report.md` are written there instead of the run directory. The directory must resolve inside the repository with no link on the way — checked before the run and again at every write — and no part of its path may start with `.` or be `node_modules` (any case), so documents can never land in `.git`, `.claude`, `.github` or another tool's command folder.
- **The run pauses after Plan** with status `awaiting-plan-approval`. Relay its `next` line: the person reviews `spec.md` and `plan.md`, edits them if needed, **commits them**, and starts a **fresh** run with the args `next` gives (the same args plus `"approvedPlan": true`) — that run starts at Design from exactly the committed files; no planner runs and `spec.md` is not re-rendered. `"pauseAfterPlan": false` runs straight through instead. Approval is never a `resume` of the paused run: that is refused.
- In the approved `spec.md`, each criterion is one line — `- **AC-1** — text` (an en dash, hyphen or colon also works, as do numbered items and checkboxes; an indented line continues the criterion above). A line under "Acceptance criteria" that is not a criterion, a duplicated id, or a leftover truncation marker stops the run and quotes the line — nothing is dropped silently.
- A run is never allowed to overwrite an uncommitted edit: planning again while `spec.md`, `plan.md`, `design.md` or `mock.html` has uncommitted changes is refused (with `approvedPlan`, `design.md` and `mock.html`); `"replan": true` overwrites on purpose.
- Resuming follows what the run RECORDED, not the new flags: a resumed approved run builds only what it approved and stops if `spec.md` or `plan.md` changed since; a resumed run never pauses again. Before Build, every file an earlier stage wrote is re-checked against its recorded hash.
- Spec mode is STRICT: a stage whose input file is not confirmed on disk does not start, and the run stops naming the file. A file an earlier run left at a path is never taken as this run's.
- Spec mode builds in the CHECKOUT: the builders take turns (data, backend, frontend) on the current branch, each told what the earlier ones changed, and leave the change uncommitted for review; reviewers are pointed at `git diff <base>`. A run that will build refuses to start while anything outside the spec directory and `.claude/` is uncommitted, or when git cannot be read; a resume diffs against the base its Build recorded. `"buildTree": "worktrees"` restores one isolated worktree per builder, in parallel.
- Evidence for review: the Test stage returns one case per acceptance criterion (type, result, evidence path), saves the evidence under `<specDir>/evidencia/` with a `casos.md`, and `test-report.md` opens with the traceability table — criteria proven by a passing automated case, failing, and pending human QA. Relay that line with the readiness recommendation. When the repository has `specs/qa-case-template.md` (or the file `"qaTemplate"` names), `casos.md` follows it exactly, plus a `tracker-draft.md` it describes; nothing is published to a tracker.
- Learning per run: a completed run returns `learningCandidates` — what `tools/distil.py` would propose from this repository's runs (a dry run; nothing is written). Relay it; keeping a candidate is a person's call (`distil.py --emit`, then a pull request). `"distil": false` turns it off.
- Decision records: in spec mode the architect, the designer and the builders write any ADR or settled trade-off to `<specDir>/decisiones.md`, where the team versions and reviews it — never to `.claude/memory/`, which is local.
- Contradictions: `spec.md` carries a `## Contradictions` section — the intent against the repository's specs, docs and code, both sides quoted. They reach the person at the pause, first in `humanDecisionRequired`, and readiness treats a criterion one of them touches as not Confirmed.

`"intentPath": "docs/intent.md"` uses an existing intent file without moving the rest; `"strict": true` turns on strictness without a spec directory. Both paths are repository-relative. On a resume, an authored file that changed since its phase recorded it is not handed on.

Autonomy: this run is unattended unless the user is clearly present. Gates not pre-authorized by the resolved policy are recorded as BLOCKED rather than halting the run.
