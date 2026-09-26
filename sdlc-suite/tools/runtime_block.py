#!/usr/bin/env python3
"""Keep the shared workflow runtime block byte-identical across every workflow.

    python sdlc-suite/tools/runtime_block.py --check   # exit 1 on any drift
    python sdlc-suite/tools/runtime_block.py --write   # propagate the canonical copy

WHY THIS EXISTS
---------------
A Workflow-tool script runs in a `node:vm` sandbox with no `require`, so the
~340-line runtime block (policy bridge, run recorder, breaker, retry, learnings
loader, outcome record) cannot be imported -- it is pasted into all six
workflows. The review of 2026-09-24 claimed the six copies were byte-identical.
Measured before this tool existed, they were not: `sdlc-feature.js` still read
`resolvedPath(args?.resume)` where the other five used `resumeIdOf(...)`, so the
path-traversal guard security review added was absent from the one workflow that
replays the most phase output into downstream prompts. Nothing noticed, because
nothing compared the copies.

The canonical copy is `sdlc-suite/workflows/_runtime.block.js`. Each workflow
carries it between these two marker lines, and everything workflow-specific
(`const WORKFLOW = ...`, the `meta` export, the phases) sits outside them:

    // >>> RUNTIME BLOCK — generated from _runtime.block.js by tools/runtime_block.py; do not hand-edit >>>
    // <<< RUNTIME BLOCK <<<

`_wiring.test.js` asserts the same parity at test time, so drift fails CI even
if nobody runs this tool.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WF = ROOT / "sdlc-suite" / "workflows"
CANONICAL = WF / "_runtime.block.js"
BEGIN = ("// >>> RUNTIME BLOCK — generated from _runtime.block.js by "
         "tools/runtime_block.py; do not hand-edit >>>")
END = "// <<< RUNTIME BLOCK <<<"


def workflows() -> list[Path]:
    return sorted(p for p in WF.glob("*.js")
                  if not p.name.startswith("_") and not p.name.endswith(".test.js"))


def canonical_body() -> str:
    text = CANONICAL.read_text(encoding="utf-8")
    # The canonical file carries a short header explaining itself; the body is
    # everything after its own BEGIN marker, so the header is not propagated.
    if BEGIN not in text or END not in text:
        raise SystemExit(f"{CANONICAL.name}: missing its own BEGIN/END markers")
    return text.split(BEGIN, 1)[1].split(END, 1)[0]


def splice(text: str, body: str, name: str) -> str:
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        raise ValueError(f"{name}: expected exactly one BEGIN and one END marker")
    head, rest = text.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    return head + BEGIN + body + END + tail


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true")
    g.add_argument("--write", action="store_true")
    a = ap.parse_args(argv)

    body = canonical_body()
    drift = []
    for wf in workflows():
        text = wf.read_text(encoding="utf-8")
        try:
            new = splice(text, body, wf.name)
        except ValueError as e:
            print(f"FAIL {e}", file=sys.stderr)
            return 1
        if new != text:
            drift.append(wf.name)
            if a.write:
                wf.write_text(new, encoding="utf-8", newline="\n")

    if not workflows():
        print("FAIL no workflows found — a check over nothing is not a pass", file=sys.stderr)
        return 1
    if a.check and drift:
        print("FAIL runtime block drifted from _runtime.block.js in: " + ", ".join(drift)
              + "\n     run: python sdlc-suite/tools/runtime_block.py --write", file=sys.stderr)
        return 1
    verb = "rewrote" if a.write else "checked"
    print(f"runtime block: {verb} {len(workflows())} workflow(s); "
          f"{len(drift)} {'updated' if a.write else 'drifted'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
