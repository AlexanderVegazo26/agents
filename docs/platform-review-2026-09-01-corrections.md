# Corrections to `platform-review-2026-09-01.md`

> **Identifiers in this document are redacted.** The employer name, the
> author's email, and both machines' home-directory paths are replaced with
> placeholders (`<employer>`, `<author>`, `<user-home>`, `<user>`). Nothing
> analytical depends on the literal strings.
>
> This repository is public, and removing exactly those identifiers is the
> point of CHG-01, CHG-03 and CHG-04 — which this document specifies.
> Publishing the document that specifies the removal with the strings intact
> would have undone it, and `docs/` was untracked before this branch, so
> this would have been their first appearance on a remote.


**Date:** 2026-09-02
**Measured at:** commit `1f988ab` on `main` — one commit ahead of the `d5cf491`
the review audited. That commit changed 173 files.
**Method:** ten independent read-only agents, one per change cluster, each
re-measuring the *Current state* paragraph of its assigned entries against the
tree rather than trusting the review's text. 414 tool calls.

The review's analysis is sound and its recommendations stand. This file records
where its **measurements** have gone stale or were wrong when written, because an
implementer working from the review's text alone would do wrong work in about a
dozen places. Verdicts: 1 already fixed, 12 premises hold exactly, 13 partly stale.

---

## Superseded after implementation

**Phase 5 finding 3 — `nawi-vex/` untracked and not ignored — is resolved by
removal, not only by an ignore rule.** It was a linked git *worktree* of the
`nawi` repository (`nawi-vex/.git` was a file pointing into
`nawi/.git/worktrees/nawi-vex`), 623 MB on disk, checked out on branch
`vex-consolidation`.

Checked before removing it, because deleting a worktree directory is the kind of
thing that quietly destroys work:

- the worktree was **clean** — zero modified, zero untracked beyond build output,
  so it held nothing that was not already committed;
- its branch was **2 commits ahead of `nawi`'s `main`** and `main` was 0 behind —
  a 3,820-line video-export feature;
- those commits live in `nawi/.git`, which is the *common* git directory, so
  `git worktree remove` deregisters the checkout and **cannot** delete the branch.

So it was removed with `git worktree remove` rather than `rm -rf` (which would
have left a stale registration), and `vex-consolidation` is intact at `418025b`.
No merge was performed: `nawi`'s working tree has 59 uncommitted modified files,
6 of which collide with files the fast-forward would touch, and resolving that is
the owner's call about their own project, not a side effect of this cleanup.

The `nawi*/` ignore rule stays. The directory that motivated it is gone, but the
next sibling worktree would be just as invisible.

**The pre-rename product codename is gone from the tree.** The project is `nawi`;
that name was redacted from the review documents and dropped from the
`.gitleaks.toml` pattern, because a literal-match rule is the only thing that
would still have been publishing it. It survives in two commit *subjects* on
`main` (`dd3c5ee`, `36a3fdd`), which are already published — see this review's own
reasoning for why rewriting `main` over two words is disproportionate.

---

## Resolved open questions (Phase 7)

**Q1 — what is in the published history?** Settled. `git fetch origin` was run.
`origin/main` is `1f988ab`, 16 commits, and `git log --format='%ae%n%ce' origin/main | sort -u`
returns only `<owner>@<mail>.com`. No secrets and no `<employer>`,
`atlassian.net` or `dev.azure.com` strings in remote content. **CHG-01 is
sufficient; the remote needs no rewrite.**

**Q10 — was the `commandcode-suite` work finished?** Yes. `1f988ab` contains all
17 modified agent files byte-identical to the local working copies, plus
`orchestrator.md` and all 60 `.codex/skills/`. The local clone was simply one
commit behind. The local untracked `orchestrator.md` was the *older*, degraded
copy — missing the five routing rows.

**Q4 — does `TaskCreate` exist?** Absent from the current Claude Code tool
registry, which exposes `TaskOutput` and `TaskStop`. No tree references either of
the names that do exist. Second independent reason the eight grants are inert.

---

## CHG-10 is already fixed

Every sentence of its *Current state* is now stale. At `1f988ab`,
`sdlc-suite/agents/orchestrator.md:4` carries 21 bare + 16 namespaced `Agent()`
grants — including all five the review lists as omitted — with their routing rows
at `:91-95` and the out-of-pipeline escalation block at `:118-129`. The two
orchestrator copies differ only in four `sdlc-suite:` skill prefixes at
`:203-209`, which is the correct transform for a plugin tree, not drift.

Two consequences for anyone implementing it:

- The instruction *"Run this against the current file first: it must report the
  five missing agents"* will report none. Only the **validator rule** remains.
- The expected output names `qa-runner` as the one exemption. `qa-runner` **is**
  routed, at `:83`. The agents genuinely absent from the trigger table are
  `product-archaeologist`, `product-manager` and `site-reliability` — identically
  in both trees.

---

## Corrections that change what an implementer should do

### CHG-08 — mirroring the canonical tree would corrupt three ports

`.codex/`, `.copilot/` and `.kimi-code/` carry **bare** skill names (3
`sdlc-suite:` occurrences each). `sdlc-suite/skills/` carries 120. A byte-mirror
from the canonical tree pushes dead namespaced text into three harnesses that
have no such namespace — converting a small staleness problem into 60-skill
corruption. `commandcode-suite/` is the exception: it already carries 127
namespaced references, so a byte-mirror is correct there.

The review says a stale copy and an intended divergence are "indistinguishable
from the outside". They were distinguished. After normalising the namespace
prefix and line endings, genuine staleness is **1 skill in `.codex`, 1 in
`.copilot`, 4 in `.kimi-code`, 5 in `commandcode-suite`** — not "all of them".

Three further facts the entry does not have:

- `1f988ab` already landed the **name-level** half of the target state: pruning
  exists in all four scripts, and `sync-all.py:89-124 verify_parity()` fails the
  run on a missing or stale *name*. Nothing compares bytes. The remaining work is
  the content comparison and `--check`, hung on scaffolding that now exists.
- `commandcode-suite/skills/exploration-charter/` is **missing
  `personas-schema-template.yaml`** entirely. The directory exists, so
  skip-if-exists never re-copies it and the name-level parity check passes. A
  directory-existence test cannot see this class of gap; compare recursively.
- `.claude/skills/cicd-and-infrastructure/SKILL.md` is **two lines ahead** of the
  declared canonical source. The first content-aware sync would delete that
  paragraph. Decide the direction of truth before mirroring.

Line numbers all moved: the skip block is at `.kimi-code:39-41`,
`.copilot:24-26`, `.codex:24-26`, `commandcode-suite:29-31` — not `:22-24`. And
the source is no longer `.claude/skills/`: all four now read
`sdlc-suite/skills/`, so an edit to `.claude/skills/` propagates to **nothing**,
which is worse than the review describes.

### CHG-09 — `.claude/` is the better copy on three items

Generating `.claude/` from `sdlc-suite/` today would **delete** all three:

1. **The `Skill` tool grant on four agents.**
   `sdlc-suite/agents/{boundary-prober,persona-discovery,persona-runner,journey-orchestrator}.md:4`
   have no `Skill` in `tools:`. Those four packaged agents **cannot invoke a
   skill at all** — a capability loss, not merely a missing report line, and the
   same BLOCKER class as CHG-10's defect in the tree that ships.
2. Their `Supporting Skills` sections.
3. The detect-don't-assume paragraph in `cicd-and-infrastructure/SKILL.md`.

Reconcile these **into** `sdlc-suite/` before the first generation run.

The entry's four-row reconciliation table is also both over- and under-stated at
this commit: the orchestrator row is fully resolved, the `autonomy-policy` row is
half resolved (the skill is now byte-identical in both trees; only the 10 agent
wirings remain `sdlc-suite`-only), and the table omits at least seven further
divergences — the `cicd-and-infrastructure` paragraph, the
`engineering-integrity/SKILL.md` CRLF difference, the four dropped `Skill`
grants, persona-schema path wording, the `sdlc-feature.js` `blockedGates` field,
the `product-archaeologist` restructure, and a 10-agent preload-wording split.

Scope is narrower than "eight scripts replaced by one": three of the four
converters and all four sync scripts already read `sdlc-suite/`. The single
inconsistency is `.kimi-code/convert-agents.py:8`, which still reads
`.claude/agents` while `sync-all.py:4` declares `sdlc-suite/` canonical — which
is exactly why `.kimi-code/agents` is the one port still in the old generation.
Fix that line before building anything larger.

A CRLF divergence needs a **byte-level** check. `git diff --no-index` honours
`.gitattributes` and Python's `open()` does universal-newline translation, so
both report `engineering-integrity/SKILL.md` as identical across trees when it is
12,985 bytes in one and 13,072 in the other.

### CHG-13 — the defect is not in `pipeline()`

`pipeline()` is **never called anywhere in the repository**. Its `zip` is dead
code, and the test the entry proposes would validate dead code while leaving
every live site untested.

The live mispairing is in the callers of `parallel()`, which zip its
completion-ordered return against their own submission-ordered label lists:
`sdlc-feature.py:184` and `:204`, `independent-review.py:97` (read and confirmed),
plus six further sites with the same shape. Test `parallel()` directly.

The prescribed **fix** is correct and broader than claimed — indexing by
submission repairs every caller at once. It is also nearer than implied: the
`futures` dict at `:114` already maps future → submission index, and the
exception path at `:118-120` already reads it. Only the success path at `:117`
discards it.

All line numbers are +2 (`parallel()` at `:103-121`, `pipeline()` at `:124-149`).

### CHG-26 — the CRLF count dropped, and nothing was fixed

`git ls-files --eol -- '*.md'` now reports **6 w/crlf**, not 45. That is a
checkout artifact, not remediation: `1f988ab` rewrote 22 `.kimi-code/agents/*.md`
and 18 `commandcode-suite/agents/*.md`, and `attr/text eol=lf` made those on-disk
copies LF. The four files it did *not* touch in that directory
(`boundary-prober`, `journey-orchestrator`, `persona-discovery`,
`persona-runner`) are exactly the four still CRLF. The correlation is perfect.

**All four converters still lack `newline="\n"`.** One `python sync-all.py` on
Windows — which invokes all four at `sync-all.py:25,27,29,31` — puts the count
straight back above 40. Anyone reading "6" as "mostly fixed" is wrong by one
command.

The larger hole has moved out of `.md`: **54 tracked non-`.md` files are CRLF**,
including all 22 `.codex/agents/*.toml` and all 22 `.copilot/agents/*.json` — the
definition files those harnesses actually read. Every one shows `attr/` empty,
because `.gitattributes` pins `*.md` only, so nothing renormalises them the way
the `.md` files were just renormalised. Extend the pin.

Two review claims are wrong rather than stale:

- *"The untracked trees are the same"* — `.codex/` and `.copilot/` were **already
  tracked** when the review ran (added in `ddce70e` and `fa63dad`). So the
  argument that they are "not visible to a git-based check at all" is false. The
  validator rule is still worth having, but because `.gitattributes` does not
  **cover** those extensions, not because git cannot see them.
- The kimi converter write site is `:137`, not `:125` (+12 from a `yaml_dq`
  helper).

Scope the validator by **bytes over the tree**, not an extension whitelist: the
review's four extensions miss
`.codex/skills/exploration-charter/personas-schema-template.yaml`, which is CRLF.
And `file -b` is unreliable here — it reports "JSON text data" for a CRLF JSON
file while `git ls-files --eol` reports `w/crlf`. Assert on
`b"\r\n" in path.read_bytes()`.

### CHG-12 — 34 sites, not 16, and the supporting inference is backwards

The review argues *"`commandcode-suite/agents/` grants `TaskCreate` to none of its
22 agents — so the converter drops it, which is itself evidence the name is
harness-specific."* Both halves fail.
`commandcode-suite/convert-agents.py:21` holds `"TaskCreate": "task_create"` and
eight agents in that tree carry `task_create`.
`.copilot/convert-agents.py:23` holds `"TaskCreate": "create-task"` and eight
`.copilot` agents carry `create-task`. Two converters **translate** the grant,
which is evidence the name is portable — the opposite conclusion. The false
negative came from grepping the literal string across trees whose converters
rename it. Do not repeat this reasoning in a commit message.

Dropping the grant therefore touches 34 sites: 16 frontmatters in `.claude/` and
`sdlc-suite/`, 8 `commandcode-suite/agents/*.md:4`, 8 `.copilot/agents/*.json`,
and the two converter map entries. Leaving the maps reintroduces the tool on the
next regeneration.

Also: *"the only non-frontmatter occurrence is `findings.json:13-14`"* — there are
five; `.claude/audit/AUDIT.md:92` is a third, and it names `database-engineer`
and `performance-engineer` as declarers. Neither declares it today, so the grant
set **churned** rather than grew 7→8, which makes the dissolved audit finding
worse precedent than the review says.

The proposed validator rule needs more exemptions than `Skill`: `Agent(x)` grants
are not named as bare tokens in bodies, and `Artifact` appears in three
grantees' frontmatter. Without name-normalisation the rule fires well beyond the
eight cases and gets switched off.

### CHG-04 — grep the class, not the username

`1f988ab` rewrote `.kimi-code/GLOBAL-SETUP.md` from a Windows guide to a macOS
one. It did not remove the hardcoded-home class from that file — it **substituted
a macOS hardcoded home and added the owner's real name** at `:40` and `:41`:
`/Users/<user>/Documents/Documents - Alexander's MacBook Pro/personal/agents/.kimi-code/{agents,skills}`.
Note the **curly apostrophe (U+2019)** — a straight-quote pattern will not match
it. `<user-home>` survives at `:230`.

So an `<user>`-only sweep now leaves a second real username leaking. Use
`C:[/\\]+Users|/Users/[A-Za-z]|/home/[a-z]`. Those two lines are TOML config
values (`extra_agent_dirs`, `extra_skill_dirs`), so the fix is a placeholder plus
a substitute-your-own-path sentence, not `$HOME` — most TOML readers will not
expand it.

Count is 27 occurrences across 12 files, not 29. And
`commandcode-suite/commands/persona-qa-sweep.md` needs `:9` and **`:16`**, not
`:14` — it carries an extra paragraph. A blind `sed -n '9p;14p'` across the six
command files silently misses one of the twelve command sites. This was wrong at
`d5cf491` too.

`_diag-requirements.js` is safe to delete: nothing references it, it is mode 644
while every real workflow is 755, and it is the only file in the tree naming the
product. Do **not** delete `_runner.js` — all six workflows require it.

### CHG-06 — `sync-all.py` is already fixed, and every "59 skills" is now 60

The eight hardcoded count strings are gone. The file is 159 lines (was 68) and
computes counts at `:144-149`. The Files-touched bullet *"modified
`sync-all.py:52-63` — measure instead of assert"* is a no-op. Two residuals
survive: the docstring at `:4` still types "22 agents, 60 skills", and `:149`
prints the **source** count for every harness, so it reports 60 for
`.kimi-code/` which holds 66.

`1f988ab` added `autonomy-policy` to five harnesses, so every "59 skills" figure
in the review — including its own proposed corrections and its target-state table
— is now 60 and would be wrong on arrival.

Four things the entry does not handle:

- **`.kimi-code` cannot use a single Skills column.** Its 66 = 60 canonical + 6
  flow skills, and `.kimi-code/README.md:16`, `AGENTS.md:10` and
  `GLOBAL-SETUP.md:15,76` all say "60 domain skills + 6 flow skills", which is
  **correct as written**. A `counts.py` emitting one number fails `--check`
  against three correct documents forever — the gate is born red.
  `sync-all.py:109-118` already models the split via `KIMI_SKIP_SKILLS`.
- **`.agents/` is in no sync script.** It holds 59 skills and is one behind
  (`autonomy-policy`). It is absent from `SYNC_SCRIPTS` and from
  `verify_parity()`'s `HARNESSES`, so the new parity gate does not catch it
  either. Adding it to `counts.py` without adding it to the pipeline produces a
  permanently-red row.
- **A second wrong memory-root site** at `commandcode-suite/README.md:151`, which
  the review never cites. Fixing only `USAGE.md:81` leaves the wrong path in the
  README a reader hits first.
- Three more typed counts outside the five listed documents:
  `sync-all.py:4`, `.claude-plugin/marketplace.json:13`, and
  `sdlc-suite/.claude-plugin/plugin.json:4`. All correct today; all able to rot.

Two citation defects, wrong at `d5cf491` too: the "every one of the 57" sentence
is at `.claude/README.md:27`, not `:29`; and the `(59 skills)` string was at
`sync-all.py:61`, not `:63`.

### CHG-11 — the packaged orchestrator now ships the trigger table

*"They get the definitions and not the trigger table"* is falsified.
`sdlc-suite/agents/orchestrator.md:70-95` ships a 20-row mandatory-dispatch table
covering 11 of `CLAUDE.md`'s 12 §1 rows, plus verification standards at `:134-148`.

**This does not make CHG-11 unnecessary.** An orchestrator's table binds the
orchestrator — it fires only if someone invokes the orchestrator, which is
precisely the recursion `CLAUDE.md:3-6` names. The target state survives intact.
What is overstated is the severity argument. That distinction — the
orchestrator's table binds the orchestrator, `ROUTING.md` binds the caller — is
the actual justification for the change and is written down nowhere yet.

The de-instancing scope is wider than the two lines named. Beyond `:47` and
`:117`, three further instance-specific citations sit inside the generic half:
`:113-115` names private-project symbols verbatim, `:120` names a private
test-harness idiom, and `:121` cites a specific defect count. De-instancing only
`:47` and `:117` ships private identifiers into the platform copy.

The instance-configuration block starts at `:127`, not `:128` (`:128` is blank) —
the review contradicts itself here, since CHG-09 cites `:127-140` for the same
block.

### CHG-19 — five failure-collapse sites, not three

`grep -n "False," .kimi-code/workflows/runner.py` returns five: `:66` (agent file
absent), `:95`, `:98`, `:100`, and `:120` inside `parallel()`. A classifier
confined to the cited range leaves `:66` and `:120` unclassified. `:120` is the
worst — it substitutes the literal string `"unknown"` for the agent name, so that
failure cannot be attributed to an agent at all, which defeats the
per-class-per-phase breaker this change specifies.

The existing retry is narrower than described, in the change's favour:
`_runner.js:205` returns on attempt 1 for any schema-less call, and the `:201`
guard means a non-zero exit that emitted parseable JSON is treated as success.

`sdlc-suite/workflows/` and `.claude/workflows/` contain **no runner module at
all**. "Breaker check at each phase boundary in all six workflows" has nothing to
hold breaker state; one must be created.

### CHG-18 — the false `writtenTo` literal exists in four copies

`.kimi-code/workflows/system-archaeology.py:156`,
`sdlc-suite/workflows/system-archaeology.js:149`,
`.claude/workflows/system-archaeology.js:149`, and
`commandcode-suite/workflows/system-archaeology.js:166` all carry the identical
hardcoded list. The entry names only the `.py`.

**`commandcode-suite`'s `withWorktree` destroys build output on success.** Its
`finally` at `_runner.js:277-281` runs `git worktree remove --force` and
`fs.rmSync`, so on a *successful* run the builders' files are gone and only the
returned prose survives into `implementation` at `sdlc-feature.js:141`. A run
recorder must capture the worktree diff **before** that teardown, or resume
replays a prefix whose artifacts no longer exist.

The Files-touched list omits `commandcode-suite/workflows/` entirely — the one
tree whose teardown destroys build output — and `.kimi-code/workflows/` holds 7
`.py`, not 6.

Two negative claims are imprecise though substantively right: `write_file` has
three hits, not zero (two defs and an import, no call sites), and
`_runner.js` does write to the filesystem (`fs.mkdtempSync`, `fs.rmSync`).

### CHG-21 — the policy is already written; the mechanism is at zero

`CONTRIBUTING.md` now states the compatibility policy essentially as this entry
drafts it, against a `version:` field present on **0 of 557** agent and skill
files. That is the entry's own stated risk already realised in inverted form —
policy without mechanism. Reconcile against the existing text rather than writing
fresh.

The census must cover three dialects: YAML frontmatter, `.codex/agents/*.toml`
(`version = "x.y.z"`), and `.copilot/agents/*.json` (a `"version"` key). A
generator emitting YAML frontmatter into those trees produces invalid files.

`sdlc-suite/USAGE.md:18`, not `:15` — `:15` is blank at both commits. There are 6
agent trees and 7 skill trees, not seven of each.

### CHG-01 — the counts

24 commits before the purge, 16 after, with `main` at 16 throughout — not the
23→15 the verification block states. The check was confirmed capable of failing
first: two identities, both refs present.

---

## Corrections that do not change the work

- **CHG-24** — *"Searched `denylist`, `scrub`, `sanitiz`: zero hits"* is 0 / 1 /
  14. All 15 are prose (thread sanitizers, input-validation guidance, video
  scrubbing); none is a filter, so severity and target state are unaffected. But
  a reader re-running the scan gets non-zero and may wrongly conclude the entry
  is obsolete.
- **CHG-25** — *"zero hits"* for `git commit` is 2, both Bash permission grants in
  the untracked `.claude/settings.local.json`, legitimately outside the review's
  628-tracked-file scope. `sdlc-feature.js:251` is exact.
  `sdlc-suite/README.md:48`, not `:47-49`.
- **CHG-19/23** — *"zero hits"* for `retry|attempt|backoff` is 2 per tree, all the
  prose word "Attempt" inside prompt strings. `fallback` has 2 hits in
  `commandcode-suite`, neither a breaker.

Premises that hold exactly, with no correction needed: **CHG-02, CHG-03, CHG-05,
CHG-07, CHG-14, CHG-15, CHG-16, CHG-17, CHG-20, CHG-22, CHG-23, CHG-25.**

---

## A note on method

Three of the corrections above are the same failure the review itself names —
*"a count asserted in prose decays silently, and an authoritative tone is exactly
what stops anyone re-checking it"* — occurring inside the document that names it.
That is not a criticism of the review; it is the strongest available evidence for
its own central argument, and the reason `counts.py` computes rather than states.

Several of the review's negative results (`zero hits` for a grep) were produced by
patterns that could not match: a literal string across trees whose converters
rename it, or an extension filter that excluded the file that mattered. The
review's own Phase 5 Method records this hazard and prescribes the fix — run any
scan whose negative result matters against a known positive first. Applying that
rule to the review found four such cases.
