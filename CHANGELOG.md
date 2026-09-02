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
