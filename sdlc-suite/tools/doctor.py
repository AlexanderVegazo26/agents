#!/usr/bin/env python3
"""Pre-flight health check for this repository's agent suite — and the one safe repair.

    python sdlc-suite/tools/doctor.py            # report; exit 1 if anything is unhealthy
    python sdlc-suite/tools/doctor.py --fix-eol  # also normalise CRLF -> LF, then re-check
    python sdlc-suite/tools/doctor.py --hook     # SessionStart form: report-only, terse, exit 0

WHY
---
The failures this repository has actually suffered are silent at the moment they
happen and loud much later: five agents unregistered by CRLF ("agent type not
found" at dispatch), a hand-edited generated file overwritten on the next
regeneration, a runtime block that drifted between workflows and lost a security
guard. Every one had a check that would have caught it; none was run before the
agent that tripped over it started work. This runs them all, first.

WHAT IT REPAIRS, AND WHAT IT DELIBERATELY DOES NOT
-------------------------------------------------
Exactly one thing: CRLF -> LF, with `--fix-eol`. That repair is byte-exact,
idempotent, and the documented remedy (CLAUDE.md: "normalising to LF restored
them in the same session"), and it is re-verified by re-scanning afterwards.

It never regenerates trees or re-splices the runtime block. Drift there can mean
someone hand-edited a GENERATED file, and regenerating would silently discard
that edit — the exact hazard CLAUDE.md documents. It names the command instead.

As a SessionStart hook it is REPORT-ONLY and only ever exits 0: a hook that fails
blocks the session it is meant to inform, and a hook that rewrites files at
session start rewrites them under any other agent already working in the tree —
the shared-tree hazard engineering-integrity §8 names. Its report is what the
agent reads; the agent runs --fix-eol itself if it decides to.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "sdlc-suite" / "tools"

# (name, argv, the command that repairs it, whether doctor may run that repair)
CHECKS = [
    ("line endings", [sys.executable, str(TOOLS / "eol_check.py"), "--check"],
     "python sdlc-suite/tools/eol_check.py --fix", True),
    ("generated trees", [sys.executable, str(TOOLS / "generate_trees.py"), "--check"],
     "python sdlc-suite/tools/generate_trees.py   (read the diff first: drift may be a hand-edit to a generated file)", False),
    ("runtime block parity", [sys.executable, str(TOOLS / "runtime_block.py"), "--check"],
     "python sdlc-suite/tools/runtime_block.py --write   (edit _runtime.block.js, never a workflow's copy)", False),
    ("documented counts", [sys.executable, str(TOOLS / "counts.py"), "--check"],
     "python sdlc-suite/tools/counts.py --write", False),
    ("artifact versions", [sys.executable, str(TOOLS / "bump.py"), "--check"],
     "python sdlc-suite/tools/bump.py   (proposes the increments)", False),
]


def run(argv) -> tuple[int, str]:
    try:
        p = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 99, str(e)
    return p.returncode, (p.stdout + p.stderr).strip()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--fix-eol", action="store_true")
    ap.add_argument("--hook", action="store_true",
                    help="SessionStart mode: report-only, prints only problems, always exits 0")
    a = ap.parse_args(argv)
    fix_eol = a.fix_eol and not a.hook

    problems = []
    lines = []
    for name, cmd, remedy, auto in CHECKS:
        code, out = run(cmd)
        if code != 0 and auto and fix_eol:
            fcode, fout = run([sys.executable, str(TOOLS / "eol_check.py"), "--fix"])
            lines.append(f"REPAIRED {name}:\n  " + "\n  ".join(
                l for l in fout.splitlines() if l.startswith(("FIXED", "OK", "error"))))
            code, out = run(cmd)  # re-verified from disk, never assumed
        if code == 0:
            lines.append(f"ok       {name}")
        else:
            tail = "\n    ".join(out.splitlines()[-6:])
            problems.append(name)
            lines.append(f"PROBLEM  {name} (exit {code})\n    {tail}\n  repair: {remedy}")

    if a.hook:
        if problems or any(l.startswith("REPAIRED") for l in lines):
            print("[sdlc doctor] " + ("; ".join(problems) + " unhealthy" if problems else "healthy after repair"))
            for l in lines:
                if not l.startswith("ok"):
                    print(l)
        return 0

    print("\n".join(lines))
    print(f"\n{'UNHEALTHY: ' + ', '.join(problems) if problems else 'HEALTHY'}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
