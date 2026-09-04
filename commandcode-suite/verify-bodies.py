#!/usr/bin/env python3
"""Verify commandcode-suite/agents bodies are verbatim copies of sdlc-suite/agents.

Frontmatter is excluded: it is legitimately different, because the two harnesses
have different tool vocabularies and model ids. The body is not — a body that
diverges is either an edit made to the wrong copy, or a generator bug.

Two things this script previously got wrong, both of which made it useless as a
gate:

1. **It exited 0 no matter what.** It printed `BODY MISMATCH: <file>` for each
   divergence, printed a count, and returned success. Wired into CI as a bare
   `run:` it would have been permanently green — a decorative gate, which is
   worse than no gate because it invites skipping the check.

2. **It compared text, not bytes.** `read_text` universal-newline-translates on
   read, so a CRLF body compared equal to its LF twin. That is the exact failure
   class this repository has already been bitten by, and it means the check was
   blind to the one difference most likely to break a harness.

Both are fixed. Exit status is the result: 0 clean, 1 mismatch, 2 usage error.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT.parent / "sdlc-suite" / "agents"
DST = ROOT / "agents"

FRONT = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)

# The generator stamps this into every generated agent body. It is expected in
# the destination and absent from the source, so strip it before comparing —
# otherwise every file reports as mismatched and the real signal is buried.
GENERATED = re.compile(r"^<!-- GENERATED from .*? -->\s*\n+", re.MULTILINE)


def body_of(path: Path) -> str:
    # read_bytes, not read_text: no newline translation, so a CRLF body is
    # actually detected as different rather than silently normalised away.
    text = path.read_bytes().decode("utf-8")
    return GENERATED.sub("", FRONT.sub("", text)).strip()


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")

    if not SRC.is_dir():
        print(f"FAIL: source not found: {SRC}", file=sys.stderr)
        return 2

    sources = sorted(SRC.glob("*.md"))
    if not sources:
        # Zero files scanned looks identical to a clean run. It is not one.
        print(f"FAIL: no agent files under {SRC} — the check has stopped checking anything",
              file=sys.stderr)
        return 2

    mismatch = 0
    checked = 0
    for s in sources:
        d = DST / s.name
        if not d.exists():
            print(f"MISSING: {s.name}", file=sys.stderr)
            mismatch += 1
            continue
        checked += 1
        if body_of(s) != body_of(d):
            mismatch += 1
            print(f"BODY MISMATCH: {s.name}", file=sys.stderr)

    if mismatch:
        print(f"FAIL: checked {checked} agents, {mismatch} body mismatch(es). "
              f"Run: python sdlc-suite/tools/generate_trees.py", file=sys.stderr)
        return 1

    print(f"OK: {checked} agent bodies match sdlc-suite/agents/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
