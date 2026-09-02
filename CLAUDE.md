# Agent routing policy — instance configuration

The generic routing policy — the mandatory trigger table, the
implementer-never-certifies rule, handoffs-as-debts, announcing-a-skip-does-not-
authorise-it, skills-are-part-of-the-contract, and the verification standards —
now ships with the plugin at [`sdlc-suite/ROUTING.md`](sdlc-suite/ROUTING.md),
so it travels with every adopter, not just this repository. **Read that file
first.** This file holds only what is genuinely local to *this* repository:
which tree to hand-edit, the line-ending hazard that has bitten it before, and
the separate project it builds against.

---

## Repository layout — edit the right copy

`sdlc-suite/` is the only hand-edited tree in this repository. `.claude/`,
`commandcode-suite/`, `.kimi-code/`, `.copilot/`, `.codex/` and `.agents/` are
all generated from it by `sdlc-suite/tools/generate_trees.py` — editing any of
them directly raises no error and is silently overwritten on the next
generation run.

**If an agent vanishes from the roster, check its line endings first.** Five agents
silently stopped registering — dispatch failed with "agent type not found" — and every
one had CRLF in its frontmatter; normalising to LF restored them in the same session.
The CRLF was never authored, git's autocrlf introduced it on checkout, which is what
the "LF will be replaced by CRLF" warnings report. Two hypotheses were falsified and
should not be retried: description length (a 480-char broken one sat beside a 659-char
working one) and the `INVOKE WHEN:` colon-space in unquoted YAML (nine carry it, five
broke).

`.gitattributes` pins `*.md`, and since 2026-09-02 also `*.toml`, `*.json`, `*.py`,
`*.js`, `*.yaml` and `*.yml` — the extensions `.codex/agents/`, `.copilot/agents/` and
the `exploration-charter` schema template use, every one of which sat CRLF in the
working tree with an empty `attr/` because only `*.md` was ever claimed. **Treat that
pin as half a mitigation.** It governs what git writes on checkout and what it stores
on commit; it cannot reach a generator, which writes to disk outside git entirely.
Until 2026-09-02 all four `convert-agents.py` scripts wrote in Python's default text
mode, so a single `python sync-all.py` on Windows re-emitted CRLF into every generated
definition — measured at 88 of 88 regenerated files, with the CRLF landing in the
frontmatter itself (`---\r\nname: ...`). Each converter and `generate_trees.py` now
pass `newline="\n"` explicitly, which is the other half. Neither half covers an
extensionless definition such as `kflow`, nor an untracked one git cannot see, so the
check to trust is `python sdlc-suite/tools/eol_check.py --check`, which reads the
bytes of every file in the definition trees rather than an extension list, the index,
or `file -b`.

Definitions are read fresh per invocation, so an edit takes effect without a restart —
which also means a broken one breaks immediately.

`nawi/` (still named `snagit-clone/` on disk until the rename lands — both are ignored) is a separate repository these agents build against — deliberately
untracked here, with its own history and branches.
