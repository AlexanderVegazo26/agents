# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Agents and skills carry their own versions; the plugin version is the release
train. See `CONTRIBUTING.md` for the compatibility policy.

## [Unreleased]

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
