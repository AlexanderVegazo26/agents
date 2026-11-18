#!/usr/bin/env python3
"""Context budget report: how much every agent and skill costs to load.

    python sdlc-suite/tools/context_budget.py            # largest first, over-budget marked
    python sdlc-suite/tools/context_budget.py --json     # machine-readable, for the repo-loop
    python sdlc-suite/tools/context_budget.py --top 10   # only the ten largest

A report, not a gate: it exits 0 whatever the sizes. The budgets are the
direction set in MODEL-ROUTING.md ("minimal context, minimal tools"): an agent
or skill over budget is a candidate for the improvement loop to shrink, never a
reason to fail CI. Words are counted, not tokens, so the numbers are stable and
need no tokenizer; roughly 1.3 tokens per English word.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUDGET = {"agent": 1500, "skill": 1000}


def body_and_tools(path: Path) -> tuple[str, int]:
    text = path.read_text(encoding="utf-8")
    tools = 0
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if m:
        t = re.search(r"^tools:\s*(.+)$", m.group(1), re.M)
        if t:
            tools = len({x.strip() for x in t.group(1).split(",") if x.strip()})
        text = text[m.end():]
    return text, tools


def rows() -> list[dict]:
    out = []
    for f in sorted((ROOT / "agents").glob("*.md")):
        body, tools = body_and_tools(f)
        out.append({"kind": "agent", "name": f.stem, "words": len(body.split()), "tools": tools})
    for d in sorted((ROOT / "skills").iterdir()):
        skill = d / "SKILL.md"
        if not skill.is_file():
            continue
        body, _ = body_and_tools(skill)
        extra = sum(len(p.read_text(encoding="utf-8", errors="replace").split())
                    for p in d.rglob("*.md") if p != skill)
        out.append({"kind": "skill", "name": d.name, "words": len(body.split()),
                    "reference_words": extra, "tools": None})
    for r in out:
        r["budget"] = BUDGET[r["kind"]]
        r["over"] = r["words"] > r["budget"]
    return sorted(out, key=lambda r: r["words"], reverse=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--top", type=int, default=0)
    a = ap.parse_args()
    data = rows()
    if a.top:
        data = data[: a.top]
    if a.json:
        print(json.dumps(data, indent=2))
        return
    for r in data:
        mark = "OVER" if r["over"] else "ok  "
        tools = f"  tools {r['tools']}" if r["tools"] is not None else ""
        print(f"{mark} {r['kind']:5} {r['name']:32} {r['words']:6} words (budget {r['budget']}){tools}")
    all_rows = rows()
    over = sum(r["over"] for r in all_rows)
    total = sum(r["words"] for r in all_rows)
    print(f"\n{over} of {len(all_rows)} over budget; {total} words in total")


if __name__ == "__main__":
    main()
