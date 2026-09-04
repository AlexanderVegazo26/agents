<!--
Delete the sections that do not apply. The learning-PR section at the bottom
applies only to pull requests opened by the distiller against `learnings/`;
ignore it for anything else.
-->

## What this changes, and why

<!-- The failure it fixes or the capability it adds. One paragraph is plenty. -->

## Which trees

`.claude/` and `sdlc-suite/` are **both live** and must change together, or
which behavior you get depends on which name the caller happened to use.
`sdlc-suite/` namespaces its skill references (`sdlc-suite:requirements-craft`),
so the two edits are not always textually identical.

`.kimi-code/`, `commandcode-suite/`, `.copilot/`, `.codex/` and `.agents/` are
ports. Editing a tree that is regenerated raises no error and changes nothing
the next time the sync runs.

- [ ] Both live trees changed, or the change genuinely touches only one and I have said which and why below.
- [ ] I did not hand-edit a generated tree, or if I did, I said so below.

## Checks

From `CONTRIBUTING.md`, plus what CI now runs. Tick what you ran; do not tick
what you assume.

- [ ] `python sdlc-suite/tools/counts.py --check` — documented counts match the tree
- [ ] `python sdlc-suite/tools/eol_check.py --check` — definitions are LF, measured on the bytes
- [ ] `python sync-all.py` — ports regenerated, and I read the diff rather than just letting it run
- [ ] `python commandcode-suite/validate.py`
- [ ] `python .kimi-code/validate.py`
- [ ] Nothing I added would fail the secret scan — no token, employer name, private project name, absolute home path or `*-VEX.*` requirement id

**Line endings.** `*.md` is pinned to LF by `.gitattributes`. Five agents once
silently stopped registering — dispatch failed with "agent type not found" —
and every one had CRLF in its frontmatter. The pin does not reach a converter
writing to disk outside git, so if you ran `sync-all.py` on Windows, check the
bytes rather than assuming.

## The registry invariants

The seven that `/registry-audit` checks are listed in `CONTRIBUTING.md`. The
two most often missed:

- [ ] **Least privilege** — every tool in `tools:` is exercised by a procedure in the body, and every prose delegation instruction has the matching `Agent(x)` grant. A delegation with no grant is unimplementable.
- [ ] **Skills get wired** — any skill this change relies on is named in the agent body at its point of use, and that agent has the `Skill` grant. An unnamed skill is unreachable, and so is one whose agent cannot invoke it.

## Verification

These bind contributors the same way they bind agents.

- [ ] **Exit codes, not output.** I read the exit status, not the last line printed. I did not pipe a run to `tail` or `head` — that reports the pager's status.
- [ ] **Skipped is not passed.** Where a run skipped a gate and still exited 0, I said so rather than counting it.
- [ ] **Artifacts over assertions.** Where this produces an output, I measured the output.
- [ ] **A test that cannot fail proves nothing.** Any assertion I added was demonstrated failing against the unfixed code first, one change at a time, and I can say which assertion went red for which cause.
- [ ] **Prove a negative against a known positive.** Any scan whose *negative* result matters here was first run against something I knew would match.

If a claim in this pull request depends on runtime behavior I did not execute,
it is labelled **believed** or **assumed**, not **verified**.

## Documentation

- [ ] No document in the tree now describes behavior this change makes false, or the ones that did are updated in this pull request.

---

## For a learning pull request only

These are opened by the distiller from run outcomes, against `learnings/`.
**Merging is the ratification** — nothing else in the loop can reach the
default branch. Check all five.

1. [ ] Is each file one concept, and would you know how to act on it?
2. [ ] Does the provenance name at least two real runs, and do those runs exist?
3. [ ] Is there anything here that identifies a person, employer, customer, host or ticket?
4. [ ] Does it tell a future agent to look **harder**, never to look **less**? A learning that would justify skipping a check is rejected on sight.
5. [ ] Is `confidence` honest? Two runs is `observed`, not `corroborated`.

To undo one, revert the merge commit. Loading is a directory scan with no index
and no cache, so reverting removes the behavior completely.
