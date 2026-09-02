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

# Never descend into these. nawi / nawi-vex / snagit-clone are separate
# repositories; the rest hold generated or vendored bytes, not definitions.
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "nawi", "nawi-vex", "snagit-clone",
}


def is_binary(data: bytes) -> bool:
    """A NUL byte in the first 8 KiB is the usual binary tell.

    CRLF occurs by coincidence inside binary payloads, so asserting on it
    without this guard reports compiled artefacts as line-ending defects.
    """
    return b"\0" in data[:8192]


def iter_files(root: Path):
    if root.is_file():
        yield root
        return
    for path in sorted(root.rglob("*")):
        if not path.is_file():
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
            if is_binary(data):
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
    return 1 if args.check else 0


if __name__ == "__main__":
    raise SystemExit(main())
