#!/usr/bin/env python3
"""Byte-level line-ending check over the definition trees.

Why bytes, and why none of the obvious shortcuts:

* NOT an extension whitelist. `.codex/skills/exploration-charter/
  personas-schema-template.yaml` and the extensionless `kflow` are both real
  definitions, and a four-extension filter skips them silently.
* NOT git. `git ls-files --eol` cannot see an untracked definition at all, and
  it reports the index unless you read the `w/` column -- the harnesses read
  the working copy.
* NOT `file -b`. It reports plain "JSON text data" for a CRLF JSON file, so a
  check built on it passes over exactly the files that broke registration.
* NOT `.gitattributes`. Those pins govern checkout and commit. The converters
  write to disk outside git entirely, so no pin can reach their output.

The one assertion that survives all four is b"\r\n" in path.read_bytes().

Usage:
    python sdlc-suite/tools/eol_check.py                # list offenders, exit 0
    python sdlc-suite/tools/eol_check.py --check        # exit 1 if any offender
    python sdlc-suite/tools/eol_check.py --check PATH   # scan PATH instead
    python sdlc-suite/tools/eol_check.py --fix          # rewrite CRLF -> LF, re-scan

Exit codes (the contract a CI job depends on -- do not change silently):
    0  no CRLF found, or offenders found in plain listing mode
    1  --check was given and at least one file contains CRLF
    2  a path given on the command line does not exist
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

CRLF = b"\r\n"

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Definition trees scanned when no path is given on the command line.
DEFAULT_ROOTS = [
    ".agents",
    ".claude",
    ".claude-plugin",
    ".codex",
    ".commandcode",
    ".copilot",
    ".kimi-code",
    "commandcode-suite",
    "sdlc-suite",
]

# Root-level files that are part of the tooling and equally able to break.
DEFAULT_FILES = ["kflow", "sync-all.py", ".gitattributes", "CLAUDE.md"]

# Also scanned. Independent review found these uncovered by injecting CRLF into
# each in turn and watching this tool exit 0 every time. .gitattributes pins them
# for a git-managed checkout, but this tool is the byte-level backstop that
# exists precisely because writers bypass git and untracked files never reach
# the index. A CRLF ci.yml is a plausible YAML-parser failure this is positioned
# to catch and did not.
DEFAULT_ROOTS += [".github", "docs"]
DEFAULT_FILES += [
    ".pre-commit-config.yaml", ".gitleaks.toml", "README.md",
    "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md",
]

# Never descend into these. nawi / nawi-vex / snagit-clone are separate
# repositories; the rest hold generated or vendored bytes, not definitions.
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "nawi", "nawi-vex", "snagit-clone",
}


# Extensions that are definitions by construction. A NUL in one of these is a
# defect in the file, never evidence that it is a binary payload.
TEXT_SUFFIXES = {
    ".md", ".py", ".js", ".mjs", ".cjs", ".json", ".toml", ".yaml", ".yml",
    ".txt", ".sh", ".ts",
}


def is_binary(path: Path, data: bytes) -> bool:
    """A NUL byte is the usual binary tell — but not in a definition file.

    Two things this had wrong, both found by independent review, and both of the
    exact class this tool exists to catch:

    1. It scanned only the first 8 KiB, and a NUL there made the whole file
       invisible. A fully-CRLF agent definition with a NUL at byte 100 passed
       with exit 0, while the identical file without the NUL failed. The run
       printed "1 binary skipped" and still exited 0, so CI passed — a gate
       reporting success while doing nothing.

    2. It is not hypothetical. `sdlc-suite/workflows/_policy.js` carries a
       deliberate NUL at offset 12364 as a dedupe-key delimiter. A shorter file,
       or that delimiter moving earlier, drops a real source file into the
       skipped set — and `git ls-files --eol` already reports that file as
       `w/-text`, meaning git itself treats it as binary and never applies
       `eol=lf` to it.

    So a known definition extension is never skipped: it is scanned for CRLF
    regardless of what else it contains. Everything else keeps the NUL
    heuristic, now over the whole file rather than a window.
    """
    if path.suffix.lower() in TEXT_SUFFIXES:
        return False
    return b"\0" in data


def iter_files(root: Path):
    if root.is_file():
        yield root
        return
    for path in sorted(root.rglob("*")):
        # A symlink is never followed. `is_file()` and `write_bytes()` both
        # follow one, so `--fix` would rewrite a target outside the scanned
        # tree — the definition trees never need a link to be real files.
        if path.is_symlink() or not path.is_file():
            continue
        # A directory junction is not a symlink to `is_symlink()`, and rglob
        # walks through it. Anything that RESOLVES outside the root being
        # scanned is skipped, so `--fix` can never rewrite a file beyond it.
        try:
            path.resolve().relative_to(root.resolve())
        except ValueError:
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        yield path


def scan(roots):
    offenders = []
    scanned = 0
    skipped_binary = 0
    seen = set()
    for root in roots:
        for path in iter_files(root):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            try:
                data = path.read_bytes()
            except OSError as exc:
                print("warning: cannot read {}: {}".format(path, exc), file=sys.stderr)
                continue
            if is_binary(path, data):
                skipped_binary += 1
                continue
            scanned += 1
            if CRLF in data:
                offenders.append(path)
    return offenders, scanned, skipped_binary


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Report every definition file containing a CRLF line ending.",
        epilog="exit codes: 0 = clean (or listing mode), 1 = --check found CRLF, "
               "2 = a given path does not exist",
    )
    parser.add_argument(
        "paths", nargs="*",
        help="files or directories to scan (default: the definition trees)",
    )
    parser.add_argument(
        "--check", action="store_true",
        help="exit non-zero when any file contains CRLF",
    )
    parser.add_argument(
        "--fix", action="store_true",
        help="rewrite every offender's CRLF to LF in place, then re-scan; exit 1 "
             "only if CRLF survives the rewrite",
    )
    args = parser.parse_args(argv)

    if args.paths:
        roots = [Path(p) for p in args.paths]
        missing = [p for p in roots if not p.exists()]
        if missing:
            for p in missing:
                print("error: no such path: {}".format(p), file=sys.stderr)
            return 2
    else:
        roots = [REPO_ROOT / r for r in DEFAULT_ROOTS if (REPO_ROOT / r).exists()]
        roots += [REPO_ROOT / f for f in DEFAULT_FILES if (REPO_ROOT / f).exists()]

    offenders, scanned, skipped_binary = scan(roots)

    if args.fix and offenders:
        # The documented remedy — "normalising to LF restored them in the same
        # session" — applied by the tool instead of by hand. Byte-level, so a
        # file carrying a deliberate NUL (_policy.js) is rewritten exactly and
        # nothing else in it moves. Binary files never reach this list. Then
        # re-scan: a fix is reported from what is on disk afterwards, never
        # from the fact that a write was attempted.
        for path in offenders:
            try:
                path.write_bytes(path.read_bytes().replace(CRLF, b"\n"))
                print("FIXED CRLF -> LF: {}".format(rel(path)))
            except OSError as exc:
                print("error: could not rewrite {}: {}".format(rel(path), exc), file=sys.stderr)
        offenders, scanned, skipped_binary = scan(roots)
        if not offenders:
            print("OK: {} file(s) scanned, 0 with CRLF after --fix".format(scanned))
            return 0

    for path in offenders:
        print("CRLF: {}".format(rel(path)))

    summary = "{} file(s) scanned, {} with CRLF, {} binary skipped".format(
        scanned, len(offenders), skipped_binary
    )

    if not offenders:
        print("OK: {}".format(summary))
        return 0

    print("")
    print("{}: {}".format("FAIL" if args.check else "FOUND", summary))
    print(
        "CRLF in a definition file has silently unregistered agents in this "
        "repository before. Rewrite the bytes with LF."
    )
    return 1 if (args.check or args.fix) else 0


if __name__ == "__main__":
    raise SystemExit(main())
