# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Agents and skills carry their own versions; the plugin version is the release
train. See `CONTRIBUTING.md` for the compatibility policy.

## [1.2.0] — 2026-09-24

The self-improvement loop, closed. The 2026-09-24 agentic-readiness review found
the architecture present and none of it ever run: zero run records, zero
learnings loaded, retry and breaker primitives with no production caller. Almost
every fix below has a test that was shown red — against the old code, or by
reverting that fix alone — and green after. The exceptions are text-only changes
(the `run.deliverableMissing` wording) and the directory-junction guard in
`eol_check.py`; the junction guard was verified by hand with a real `mklink /J`,
whose target stayed byte-identical. `_wiring.test.js` proves the loop
end to end on disk: two recorded runs, the real `distil.py` emitting a candidate,
and the third run's agent prompt carrying the ratified learning. The first cut of
this change then went through independent code, QA and security review, all
three of which returned request-changes. Their findings are fixed here and
listed under *Fixed after review*.

### Fixed

- **Policy precedence failed open.** The commands passed the plugin's default
  policy as the explicit `policy`, and it beat the repo's own
  `.claude/autonomy.json`, so a repo's lockdown was silently re-enabled. There
  are now two arguments. `policyDefault` (what the commands pass) is a fallback
  that the repo file overrides. An explicit `policy` is **intersected** with
  the repo file: a gate needs both, so an invoker can run stricter than the
  repo and never looser, and a caller still passing the plugin default under
  the old `policy` name cannot lift a repo lockdown. A file that exists but is
  invalid or unreadable denies everything, as does an explicit path that does
  not exist. Only an absent repo file or default falls through.
  `autonomy-policy` skill 1.1.0 documents the same rules. Any `act.*` gate the resolved policy
  grants is surfaced as `actGranted` on the return and in `outcome.json`.
- **Four of six commands passed `args` as a bare string**, so no run was ever
  recorded. All six now pass an object carrying `runtimeDir` and
  `policyDefault`. A run that cannot reach its runtime returns status
  `incomplete`, `selfHealDisabled: true` and a `runtime.unreachable` blocked
  gate, never `completed`.
- **A dead refuter deleted the finding** (`sdlc-feature`), and a dead verifier
  dropped it (`registry-audit`). Both now keep it, flagged `unverified`. It is
  presented in its own section, never as confirmed or verified. It is not sent to
  a builder for repair. It is counted as a phase failure, so enough of them trip
  the breaker.
- **A tripped breaker marked its phase complete**, so a resume replayed one lens
  of four and reported `completed`. The breaker also never reset, so a fixed run
  re-tripped forever. Tripped phases are now failed, and the breaker folds only
  the current attempt's failures. The manifest carries `attempt`, and every
  `failures.jsonl` record carries it as `epoch` (that record's own `attempt`
  field counts dispatches).
- **`sdlc-feature` had lost the resume-path traversal guard** the other five
  workflows carried. The new parity check found it; review had not.
- **`distil.py` filtered by `.last-distil` before grouping**, so recurrence
  across per-run distils never reached the two-run floor, and deferred
  candidates were never reconsidered. It now:
  - groups the whole store and uses the marker only to decide what is new;
  - carries deferred, quarantined and dropped signatures forward in the marker;
  - never re-proposes a signature already pending in `candidates/`.
- The refutation template's `**Check:**` line read as "raise fewer findings". It
  now tells the agent to test the finding harder, and `test_distil.py` fails on
  look-less wording in any template.

### Fixed after review

- **Repair dropped the re-verified lens's other findings.** The re-verifier sees
  only the blocking findings, but the whole lens's confirmed set used to be
  replaced. Now only the targeted findings are replaced.
- **A learning could forge the policy block** (security, High).
  - Learnings sit after the gate table, so the prompt begins
    `AUTONOMY POLICY —` again.
  - They arrive in a DATA frame that states they cannot grant or revoke a gate.
  - Their title, Check line and body are flattened to one line and capped.
  - `AUTONOMY POLICY`, `BLOCKED —` and `---` are neutralised.
  - Inside a git repository, only committed, unmodified learning files load.
- **Learnings travelled through the policy bridge** — the one ungated agent
  that relays the gate table. They now have their own bridge step.
- **`runtimeDir` accepted a relative path**, which resolved against the reviewed
  repo and ran its modules. Only absolute paths are accepted now.
- **distil, three fixes:**
  - Ratified recurrences no longer use up the per-run cap and starve new
    signatures.
  - The marker now advances on a quarantined emit too. Before, one
    quarantine (and the redactor quarantines `AC-n` ids) froze it, and every
    rejected candidate came back under a re-used id. The id high-water mark is
    persisted.
  - Not-addressed signatures key on the reason, not the run-local criterion id.
- **A null terminal agent** (readiness, merge, report, PRD, recommendation,
  triage) makes the run `incomplete`, with a `run.deliverableMissing` gate.
- **Builders and repairs are not retried**, since a null after a partial
  mutation is not a clean retry.
- **The learnings and retry ledger replays with its phase on resume.**
  **Malformed learnings** (BOM, quoted or namespaced `appliesTo`, block lists,
  comments) now load. Refused learnings are named in `learningsSkipped`.
- **`doctor.py --hook` is report-only**; it previously rewrote files at
  session start. **`eol_check --fix` never follows a symlink.**
- `_wiring.test.js --src .claude/workflows` now runs against the `.claude`
  modules. Before, a broken `.claude` module left it green.

**From the second review round.** Security and QA both approved it; code review
asked for four small fixes:

- **Committed-only learnings check:** a learning must now be positively tracked.
  `git status` never lists ignored files, so a planted learning under a
  gitignored `.claude/` used to load. Paths are also case-folded on Windows,
  where a cwd in a different case from git's switched the check off.
- **Neutralisation:** now applies NFKC, strips format and C1 characters, and
  folds Cyrillic/Greek lookalikes. It also neutralises authorization wording
  (`pre-authorized`, `standing authorization`), so zero-width, soft-hyphen,
  fullwidth and Cyrillic variants of the policy words no longer survive.
- **Repair loop:** a blocking finding the re-verifier re-reports stays open even
  if its refuter dies. Before, the loop could report `closed` on a defect just
  re-confirmed.
- **Deliverable gate:** `run.deliverableMissing` now says re-run, because a
  resume would replay the empty deliverable.
- **UNC guard:** now rejects mixed leading separators (`/\host\share`).
- **eol_check:** no longer rewrites through a directory junction.
- **Repair routing:** a suffix match no longer lets a root-level file own a
  finding in a subdirectory.

### Added

- **`tools/improve.py` — faster ways of working, proposed from evidence.**
  `distil.py` learns what agents get wrong; nothing learned where the process
  was slow or wasteful. `improve.py` reads the recorded runs and proposes a
  concrete change for each recurring waste signal:
  - a phase that is ≥40% of run time → profile it, parallelise its independent
    agents, or narrow their briefs;
  - an agent recovered by its retry in ≥2 runs → fold the retry's restated
    contract into its first prompt, saving a dispatch per run;
  - a repair loop that exhausts both rounds for a lens → bring a human in as soon as
    round 1 fails, in parallel with round 2 (round 2 and its re-verification still run);
  - a real autonomy gate blocked in repeated runs → a standing authorization is
    a human decision, and the wait is now measured.

  It never proposes less checking; `test_improve.py` fails on skip, remove or
  fewer wording. Every proposal is for a human to decide.
  - The orchestrator (1.1.0) must end each run with a
    `Process proposals: <n> / none` line.
  - `retrospectives` (1.1.0) has a "look for the faster way, from evidence"
    step, which also covers turning steps a person repeats into skill
    proposals.
  - `/sdlc-suite:improve` runs it. `_wiring.test.js` shows it reading real run
    records and proposing the retry fix.
- **Decay measured against exposure.** `distil.py --stamp` now reads
  `learningsLoaded` and compares the signature's RATE in runs where the learning
  was loaded against runs of the same workflow where it was not (≥2 exposed runs):
  - lower with it → *effective*: stamped, so it stays alive;
  - no lower → *ignored*: printed for escalation and NOT re-confirmed by the
    recurrence it failed to prevent;
  - recurrence in runs where it was not loaded still confirms the problem exists.
  The baseline excludes the learning's own founding (provenance) runs, and a
  verdict needs enough exposure that at least one recurrence was expected at
  the baseline rate, so a rare signature is not "effective" by chance after
  two clean runs. Dates in the future are ignored, and a stamp never moves
  backwards.

  Before, an effective learning retired at 180 days and an ignored one was
  re-confirmed forever.
- **Repo-local lessons — the tier with no human gate.** Before this, an agent
  could stop repeating a mistake only after two runs, `distil.py` and a human
  merge. Now `loadRepoLessons()` reads this repository's own recent runs.
  - It picks up two signals when they recur in two or more distinct runs: the
    same refutation reasoning for a lens, and the same agent returning nothing
    in a phase.
  - Each recurring signal goes straight to the agent it concerns on the next
    run, labelled `REPO-xxxxxxxx (repo-local, unratified)`.
  - It is written nowhere and published nowhere; cross-repo learning still goes
    through distil, redaction and the human merge.
  - It never renders free text. The refutation reason is the grouping key,
    and the lesson is fixed wording that only ever asks for more scrutiny:
    "attach evidence a refuter can check", or "look for this class
    deliberately". It names no run ids either: an id is a residual free-text channel, and a long run list truncated the safety sentence. The runs are under `.claude/runs/` for a human to read. Security review showed
    that the rendered reason ("your security findings of this kind were
    dismissed because…") was a structural reason to raise fewer findings. That
    text could be authored by a tree-writer, or laundered through a real
    refuter by the code under review, and no word filter catches a paraphrase.
  - Only recorder-shaped run directories whose manifest names them are read,
    at most 1 MB per file, and an unknown or prototype-named lens is dropped.
  - Which agents received them is surfaced as `repoLessonsLoaded`, on the
    return value and in `outcome.json`.
  - `args.repoLessons: false` turns it off. `_wiring.test.js` shows the third
    run in a repository taught by the first two, with no distil and no
    ratified file.
- `sdlc-suite/workflows/_learnings.js` — learnings are loaded in code and placed
  in the prompts of the agents they name. `learningsLoaded`, `learningsSkipped`
  and `learningsError` are recorded in `outcome.json`.
- `dispatch()` in the runtime block. It retries once, with a rewritten prompt,
  an agent that returns nothing, and records the attempt in `outcome.json` →
  `retries`. `args.retry: false` disables it for the run; `retry: false` in a
  call's opts disables it for that call.
- **A bounded repair loop in `sdlc-feature`:**
  - Confirmed blocking findings go back to the builder that owns the file,
    routed per finding with normalised paths, and the builder works on its own
    change.
  - Only the lenses that raised them re-verify, through the same refuter.
  - At most two rounds; an exhausted loop is a `repair.exhausted` blocked gate.
  - A silent re-verifier certifies nothing.
  - Recorded as `repairRounds`.
- `sdlc-suite/workflows/_runtime.block.js` and `tools/runtime_block.py` — one
  canonical runtime block, spliced into all six workflows and parity-checked in
  CI and in `_wiring.test.js`. The shared tail is now `finishRun()`.
- `tools/doctor.py` — every tree-state check in one pass. `--fix-eol` repairs
  CRLF only (`eol_check.py --fix`, also new); `--hook` is a report-only
  `SessionStart` mode.
- `tools/test_distil.py`, wired into CI.
- `engineering-integrity` 1.1.0:
  - A script sent through a heredoc or inline string can be rewritten in
    transit.
  - In an unattended run, "confirm first" means the autonomy policy, not
    waiting.

### Known gaps, stated

- `commandcode-suite/` and `.kimi-code/` workflows have none of the above; both
  READMEs say so.
- **No repair loop in `independent-review`** yet; the review asked for one there
  too. It reviews a change it did not build, so it has no builder to hand a
  finding back to, and needs a design decision about who repairs.
- **Learnings are not shipped inside the plugin.** The loader reads
  `<plugin>/learnings/`, but ratified learnings live at the repository root
  `learnings/`, outside the plugin source, so an adopter inherits none. There
  are zero ratified learnings today.
- `project-memory` has not been added to the seven agents that lack it.
- `Skill(sdlc-suite:improve)` resolves only where the plugin is installed.
  Commands are not copied into the generated `.claude/` tree, so a repository
  using only that tree runs `python sdlc-suite/tools/improve.py` directly.
- `improve.py` proposes; it does not enact. Folding a habitual retry into a
  prompt, or escalating a lens earlier, is still a human-reviewed definition
  change, deliberately: a self-applied prompt edit would be an agent certifying
  its own change.
- Failure *classification* still has no input: `agent()` returns null with no
  error text, so every failure is the fallback class. A user who deliberately
  skips a read-only agent is indistinguishable from a failure, and is asked
  once more.
- A committed learning in a pull-request branch is still loaded when that branch
  is the working tree. The DATA framing and neutralisation bound what it can do;
  they do not make it reviewed. The same is true of a planted run directory
  feeding repo-local lessons.
- Refuter nulls count per finding against an absolute breaker threshold (3). A
  lens with many findings and three flaky refuter calls stops the run, and a
  resume re-runs all four lenses. Not blocking; a proportional threshold would
  be better.
- `loadPolicy` takes `mode` from the first present source rather than the
  stricter one; the gates themselves are intersected correctly.
- A new blocking defect raised during re-verification whose refuter died is sent
  to the builder under "independent reviewers confirmed". The re-verifier is
  independent, but that finding is unrefuted.
- Runtime claims that need a live host and cannot be settled in the vm
  replica:
  - where repair edits land relative to the build worktrees;
  - whether host-level `resumeFromRunId` replays the open step without
    starting a new attempt.

## [1.1.0] — 2026-09-03

Minor, not major. Nothing a consumer could depend on was removed: the one grant
dropped (`TaskCreate`, from eight agents) was exercised by no procedure in any
tree, and `Skill` was *added* to four packaged agents that could not previously
invoke one. The plugin version moves because it is the only thing that reaches a
consumer — installing copies the plugin into a versioned cache directory, so
edits to the source do nothing until it does.

Entries are added as each change lands. Nothing is listed here before the file
it describes exists — a changelog that promises absent files is the same defect
as a README that asserts a stale count.

### Added

- `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md` and this changelog. The
  repository was previously unlicensed, so nobody could reuse, fork or
  contribute to it.
- `sdlc-suite/tools/counts.py` — the registry counts are now measured and
  written into a marked block in each README, never typed into prose.
- `sdlc-suite/memory-template/example/decisions/ADR-0001-example.md` — a
  deliberately fictional worked example of the ADR shape.
- A `version:` field on all 22 agents and all 60 skills, at `1.0.0`. The
  generated trees carry it in their own dialect: `version = "1.0.0"` in
  `.codex/agents/*.toml`, a `"version"` key in `.copilot/agents/*.json`,
  frontmatter elsewhere. Until now the only version in the repository was the
  plugin's, so a report that an agent behaved differently from its
  documentation could not be pinned to a revision of it.
- `sdlc-suite/tools/bump.py` — reads the diff, proposes an increment per the
  `CONTRIBUTING.md` policy, and gates on the part of that policy which is
  mechanically checkable: a changed body must move its version, a changed
  `tools:` grant must move the MAJOR, and the plugin cannot be bumped past
  definitions that did not move. `--selftest` drives every rule to red and back
  to green with no git and no filesystem.
- `.claude-plugin/marketplace.json` is now generated from
  `sdlc-suite/.claude-plugin/plugin.json` by `bump.py --marketplace`. The two
  files carried the plugin version separately and were bumped by hand, and
  `sdlc-suite/USAGE.md` explains what a stale one costs: installing snapshots
  the plugin into a versioned cache directory, so the version is the only thing
  that moves a fix to a consumer.
- Three CI steps in a new `versioning` job — `bump.py --selftest`,
  `bump.py --marketplace --check` and `bump.py --check`. It is the only job
  checked out with history, because comparing a body against the base branch
  needs it.

### Removed

- `.claude/memory/snagit-clone/` — real design records for an unreleased
  application, the only non-stub content in the memory tree. Relocated to that
  project's own repository.
- Machine-local state from version control: `.commandcode/settings.json` (33
  permission grants, absolute paths, a stale pid, and a private product brief in
  four shell-command entries), `.commandcode/taste/`, and seven tracked `.pyc`
  files. All are kept on disk and now ignored.

### Security

- Purged two local refs — `refs/original/refs/heads/chore/untrack-snagit-clone-submodule`
  and tag `backup-pre-email-rewrite`, both at `01440bf` — that preserved eight
  commits carrying the author's employer identity as author and committer, then
  expired the reflog and pruned. Verified: `git log --all --format='%ae%n%ce' | sort -u`
  went from two addresses to one, and `git rev-list --all` from 24 to 16 with
  `main` intact at 16. The published history was fetched and scanned first and
  never carried the identity, so no remote rewrite was required.
- `nawi-vex/`, a git worktree of a separate repository, is now ignored. It was
  untracked but **not** ignored, so one `git add -A` would have committed a
  second project including its `node_modules/` and a 265 KB lockfile.
- The `**/settings.json` ignore rule closes the gap that let
  `.commandcode/settings.json` be tracked: `.gitignore` had `**/*.local.json`,
  which does not match the filename actually in use.
