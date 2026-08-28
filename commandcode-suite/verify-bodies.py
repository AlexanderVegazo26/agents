#!/usr/bin/env python3
"""Verify commandcode-suite/agents bodies are verbatim copies of sdlc-suite/agents (frontmatter excluded)."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SRC = ROOT.parent / "sdlc-suite" / "agents"
DST = ROOT / "agents"

FRONT = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)

mismatch = 0
checked = 0
for s in sorted(SRC.glob("*.md")):
    d = DST / s.name
    if not d.exists():
        print(f"MISSING: {s.name}")
        mismatch += 1
        continue
    checked += 1
    sb = FRONT.sub("", s.read_text(encoding="utf-8"))
    db = FRONT.sub("", d.read_text(encoding="utf-8"))
    if sb != db:
        mismatch += 1
        print(f"BODY MISMATCH: {s.name}")
print(f"Checked {checked} agents, {mismatch} body mismatches")
