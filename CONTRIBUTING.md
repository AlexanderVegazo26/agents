# Contributing

This repository is a source tree of prompt-defined specialist agents and the
procedural knowledge they load. The definitions are the deliverable — there is no
application and no unit-test suite, so the checks below are what stands in for one.

**This document describes what exists today.** Where a mechanism is planned but
not built, it is marked *Not yet in force* rather than written in the present
tense. A contribution guide that instructs you to run a command that does not
resolve is the same defect as a README asserting a stale count, and this
repository has already been bitten by that once.

## Which tree to edit

**`sdlc-suite/` is the only hand-edited tree.** `.claude/`, `commandcode-suite/`,
`.kimi-code/`, `.copilot/`, `.codex/` and `.agents/` are all generated from it:

```sh
python sdlc-suite/tools/generate_trees.py          # regenerate all six
python sdlc-suite/tools/generate_trees.py --check  # CI mode: non-zero if any drifted
```

Every generated agent file carries a `GENERATED … do not edit` header. Editing
one raises no error and changes nothing the next time the generator runs — that
failure has already happened here in five distinguishable ways, which is why the
generator exists.

The generator is not a byte-mirror, and that matters if you are changing it. It
applies one transform per target: `sdlc-suite/` is a plugin, so it refers to its
own agents and skills as `sdlc-suite:name`, while trees installed as plain
project directories resolve **bare** names. Mirroring the canonical tree verbatim
into a bare-name tree would push ~120 dead references into it. Command Code keeps
the namespace, drops `Agent(x)` grants its vocabulary has no name for, and maps
`inherit` to "omit". Kimi adds `whenToUse` and keeps six workflow-launcher skills
of its own that the generator must never prune.

**One thing the generator does NOT cover: `workflows/`.** It reads only `agents/`
and `skills/`. A change to a workflow script still has to be ported by hand
across `sdlc-suite/`, `.claude/`, `commandcode-suite/` and `.kimi-code/`, and
nothing checks that you did. That is a known gap, not a settled design.

## Before opening a pull request

```sh
python sdlc-suite/tools/counts.py --check   # documented counts match the tree
python sdlc-suite/tools/generate_trees.py   # regenerate the ports, then read the diff
python sdlc-suite/tools/bump.py --check     # a changed agent or skill moved its version
python sdlc-suite/tools/bump.py --marketplace --check   # marketplace.json matches plugin.json
```

`python sync-all.py` is superseded and now **refuses to run** (exit 2), pointing
at the generator instead. It is still on disk, and the refusal is the point:
measured 2026-09-02, none of the four `convert-agents.py` scripts it calls knows
about the `version:` field, so one run strips the version from every agent in
`.codex/`, `.copilot/`, `.kimi-code/` and `commandcode-suite/` — and none of them
de-namespaces. Neither failure raises an error, which is exactly why a warning
would not have been enough.

`bump.py --check` with no `--base` compares the working tree against `HEAD`, so
run it before committing. On a branch whose changes are already committed, pass
`--base main`.

CI (`.github/workflows/ci.yml`) runs all of the above plus
`sdlc-suite/tools/eol_check.py --check`, `validate-autonomy.py` and its
`--selftest`, `commandcode-suite/validate.py`, `.kimi-code/validate.py`,
`commandcode-suite/verify-bodies.py`, a syntax check over every workflow script,
and the runtime module suites. It runs unmodified on a fork with no repository
secret. Running the four commands above locally is enough to predict it.

*Not yet in force:* a single repository-wide `sdlc-suite/tools/validate.py`. The
per-tree validators above do the job today; consolidating them is pending. This
list does not name a command before that command exists.

## Line endings

`*.md` is pinned to LF by `.gitattributes`. Keep it that way.

This is not cosmetic. Five agents once silently stopped registering — dispatch
failed with "agent type not found" — and every one had CRLF in its frontmatter.

The pin used to be `*.md` only, and two gaps followed from that. Both are closed
now; they are recorded because the reasoning is what keeps them closed:

- **`.gitattributes` does not reach a writer that bypasses git.** It governs what
  git writes on checkout and stores on commit. A converter writing to disk in
  Python's default text mode emits `os.linesep`, which on Windows is CRLF — so
  the pin was never going to cover the producer. Every writer now passes
  `newline="\n"` explicitly.
- **The pin covered Markdown, but the CRLF had moved out of Markdown.** 54
  tracked non-`.md` definition files were CRLF, including all 22
  `.codex/agents/*.toml` and all 22 `.copilot/agents/*.json` — the files those
  two harnesses actually read, all with an empty `attr/`. `*.toml`, `*.json`,
  `*.py`, `*.js`, `*.yaml`, `*.yml`, `kflow` and `.gitattributes` itself are
  pinned now.

`sdlc-suite/tools/eol_check.py` is the check that covers both, because it reads
the bytes on disk rather than the index, and walks the tree rather than an
extension whitelist — the whitelist would have missed
`.codex/skills/exploration-charter/personas-schema-template.yaml`, which was CRLF.
Measured 2026-09-02: 0 of 709 files.

If you check line endings, read the bytes (`b"\r\n" in path.read_bytes()`), not
the index and not `file -b`, which reports "JSON text data" for a CRLF JSON file.

## The seven registry invariants

`/registry-audit` checks these.

1. **Frontmatter** — `name` kebab-case and matching the filename stem;
   `description` states *when to invoke* and *when not to*, not just what it is.
2. **Least privilege** — every tool in `tools:` must be exercised by a procedure
   in the body. If the body says "delegate to X", the frontmatter needs
   `Agent(X)`: a prose delegation instruction with no grant is unimplementable,
   and that was the one BLOCKER the original audit found.
3. **Skills get wired** — name the skill in an agent body at its point of use.
   An unnamed skill is unreachable, and so is one whose agent lacks the `Skill`
   grant.
4. **Negative scope on adjacent skills** — where two skills could both plausibly
   fire, both say what they are *not* for.
5. **Evidence vocabulary** — pick the classification scheme that fits the agent's
   evidentiary basis, and never let an assumption read as a confirmed fact.
6. **Escalate only to what exists** — route to a real configured agent, and do
   not default to "the human" for something an agent already owns.
7. **Canonical memory path** — `.claude/memory/<project>/`, never a bare
   relative `memory/`.

Two further rules apply. Neither is checked by `/registry-audit`, so each says
what does check it:

8. **Routing completeness** — every agent in a tree appears in that tree's
   `orchestrator` routing table, or is exempt with a stated reason. **Not yet
   mechanised**; stated so a contributor knows the standard, not because
   anything checks it. Currently unrouted and needing either a row or an
   exemption: `product-archaeologist`, `product-manager`, `site-reliability`.
9. **Versions move with content** — an agent or skill body that changes changes
   its `version:` too. Mechanised, by `python sdlc-suite/tools/bump.py --check`
   rather than by `/registry-audit`; it fails naming the file.

## Versioning and compatibility

Every agent and skill carries a `version:` in its frontmatter, and the generated
trees carry it in their own dialect — `version = "1.0.0"` in
`.codex/agents/*.toml`, a `"version"` key in `.copilot/agents/*.json`,
frontmatter everywhere else. All 82 start at `1.0.0`.

Agents and skills carry independent semantic versions. The plugin version is the
release train.

- **Major** on an agent or skill: a reporting contract or tool grant changed in a
  way a caller could depend on. A major bump on any agent is a major bump on the
  plugin.
- **Minor**: a new procedure. **Patch**: wording.

Removing an agent or a skill is a major plugin bump and requires one release of
deprecation notice in its `description`.

`sdlc-suite/.claude-plugin/plugin.json` is the single source of the plugin
version. `.claude-plugin/marketplace.json` is generated from it — regenerate with
`python sdlc-suite/tools/bump.py --marketplace`, never by hand. This matters
because of the mechanism `sdlc-suite/USAGE.md` describes: installing copies the
plugin into a versioned cache directory, so edits to the source reach nobody
until the version moves, and until now it had to move in two files at once.

To move a version:

```sh
python sdlc-suite/tools/bump.py            # what changed, and the increment it suggests
python sdlc-suite/tools/bump.py --apply    # write those versions
python sdlc-suite/tools/bump.py --check    # what CI will run
```

`--check` enforces only what is mechanically checkable: every artifact carries a
well-formed version; the plugin's MAJOR is at least the highest artifact MAJOR; a
changed body moved its version forward; a changed `tools:` grant moved the MAJOR.
The major/minor/patch classification itself is a **proposal** — it reads the
enclosing heading of each changed line and calls a change under an output-contract
heading major. That judgement is yours, not the gate's; a heuristic wired as a
gate is a gate that gets switched off.

Bumping the release train alone is refused. A new cache directory holding
identical definitions helps nobody, which is the failure `--apply --plugin`
checks for before it writes.

> **Not yet in force:** workflows do not yet declare a minimum agent version.
> The intent is that a run whose resolved agent is older stops with
> `Failure.ENV_DRIFT` (`sdlc-suite/workflows/_failure.js`) rather than proceeding.
> `python sdlc-suite/tools/bump.py --versions --json` exists to give that check
> its input; nothing consumes it yet.

## Reviewing a learning pull request

> **Not yet in force.** `learnings/` and the distiller do not exist yet. The
> checklist is recorded now because it is the gate the design depends on, and it
> is worth agreeing before the mechanism that needs it exists.

Pull requests labelled `learnings` will be opened by the distiller from run
outcomes. **Merging is the ratification** — nothing else in the loop can reach
the default branch. Check all five:

1. Is each file one concept, and would you know how to act on it?
2. Does the provenance name at least two real runs, and do those runs exist?
3. Is there anything here that identifies a person, employer, customer, host or
   ticket?
4. Does it tell a future agent to look *harder*, never to look *less*? A learning
   that would justify skipping a check is rejected on sight.
5. Is `confidence` honest? Two runs is `observed`, not `corroborated`.

To undo one, revert the merge commit. Loading is a directory scan with no index
and no cache, so reverting removes the behavior completely.

## Verification standards

These bind contributors as much as agents.

- **Exit codes, not output.** A runner can print "N passed" while exiting 1.
  Never pipe a test run to `tail` or `head` — that reports the pager's status.
- **Skipped is not passed.** A suite that skips a gate and exits 0 has not run it.
- **Artifacts over assertions.** Where a change produces an output, the acceptance
  evidence is the output, measured.
- **A test that cannot fail proves nothing.** When adding an assertion for a fix,
  demonstrate it failing against the unfixed code first.
- **A comment asserting a guarantee is an unverified claim.** State the
  measurement and its date, or scope the claim explicitly.
- **Prove a negative against a known positive.** Two tooling hazards in this
  repository's own Git Bash have produced false clean results: bare
  `diff fileA fileB` returned exit 0 on files that demonstrably differ (use
  `git diff --no-index`), and `grep -E` with an escaped `\|` matched a literal
  pipe instead of alternating. Any scan whose *negative* result matters should be
  run once against something you know matches.
