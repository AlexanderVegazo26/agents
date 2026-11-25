#!/usr/bin/env python3
"""goals.py — OpenMuse-style goals + milestones for Hermes cron.

OpenMuse has first-class goals with milestones; Hermes cron has a per-job
notepad KV but no goal semantics.  This adds a small durable goal store that
cron check-ins can read, so a weekly job can ask "what moved on goal X?"
instead of re-deriving context from scratch.

Store: ~/.hermes/goals/<slug>.json

    {"title": "Ship hermes-proactive v0.2", "why": "...",
     "created": "2026-10-08",
     "milestones": [{"title": "triggers wired to systemd", "due": "2026-10-15",
                      "done": false, "done_at": null}]}

CLI:
  add <title> [--why W] [--slug S]
  milestone <slug> add <title> [--due YYYY-MM-DD]
  milestone <slug> done <N>        mark milestone N (1-based) complete
  milestone <slug> remove <N>
  list [--json]                    all goals with progress bars
  checkin [--format brief|full]    progress summary for cron prompt injection
  remove <slug>

Cron wiring (see README):
  hermes cron create "0 9 * * 1" --name goals-checkin \\
      --script goals.py checkin --model <deep-model> \\
      --deliver telegram:... \\
      "<prompt asking the LLM to write a check-in from the script output>"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

GOALS_DIR = os.path.expanduser("~/.hermes/goals")


def slugify(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:48] or "goal"


def path(slug: str) -> str:
    return os.path.join(GOALS_DIR, f"{slug}.json")


def load(slug: str) -> dict:
    with open(path(slug)) as f:
        return json.load(f)


def save(slug: str, goal: dict) -> None:
    os.makedirs(GOALS_DIR, exist_ok=True)
    with open(path(slug), "w") as f:
        json.dump(goal, f, indent=1)


def all_goals() -> list[tuple[str, dict]]:
    if not os.path.isdir(GOALS_DIR):
        return []
    out = []
    for fn in sorted(os.listdir(GOALS_DIR)):
        if fn.endswith(".json"):
            try:
                out.append((fn[:-5], load(fn[:-5])))
            except (OSError, json.JSONDecodeError):
                pass
    return out


def progress(goal: dict) -> tuple[int, int]:
    ms = goal.get("milestones", [])
    done = sum(1 for m in ms if m.get("done"))
    return done, len(ms)


def summary_line(slug: str, goal: dict, now: float) -> str:
    done, total = progress(goal)
    overdue = [m for m in goal.get("milestones", [])
               if not m.get("done") and m.get("due") and m["due"] < time.strftime("%Y-%m-%d", time.localtime(now))]
    bar = f"{done}/{total}"
    line = f"{goal.get('title', slug)} [{bar}]"
    if overdue:
        line += f" — OVERDUE: {', '.join(m['title'] for m in overdue)}"
    return line


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add")
    a.add_argument("title")
    a.add_argument("--why", default="")
    a.add_argument("--slug", default=None)

    m = sub.add_parser("milestone")
    m.add_argument("slug")
    msub = m.add_subparsers(dest="mcmd", required=True)
    ma = msub.add_parser("add")
    ma.add_argument("title")
    ma.add_argument("--due", default=None, help="YYYY-MM-DD")
    md = msub.add_parser("done")
    md.add_argument("n", type=int)
    mr = msub.add_parser("remove")
    mr.add_argument("n", type=int)

    l = sub.add_parser("list")
    l.add_argument("--json", action="store_true")

    c = sub.add_parser("checkin")
    c.add_argument("--format", choices=("brief", "full"), default="brief")

    r = sub.add_parser("remove")
    r.add_argument("slug")

    args = ap.parse_args()

    if args.cmd == "add":
        slug = args.slug or slugify(args.title)
        if os.path.exists(path(slug)):
            print(f"goal {slug!r} already exists", file=sys.stderr)
            return 1
        save(slug, {"title": args.title, "why": args.why,
                    "created": time.strftime("%Y-%m-%d"), "milestones": []})
        print(f"goal {slug!r} created at {path(slug)}")
        return 0

    if args.cmd == "milestone":
        goal = load(args.slug)
        ms = goal.setdefault("milestones", [])
        if args.mcmd == "add":
            ms.append({"title": args.title, "due": args.due, "done": False, "done_at": None})
            save(args.slug, goal)
            print(f"milestone {len(ms)} added to {args.slug!r}")
            return 0
        idx = args.n - 1
        if not 0 <= idx < len(ms):
            print(f"no milestone #{args.n} (goal has {len(ms)})", file=sys.stderr)
            return 1
        if args.mcmd == "done":
            ms[idx]["done"] = True
            ms[idx]["done_at"] = time.strftime("%Y-%m-%d")
            save(args.slug, goal)
            print(f"✓ {args.slug} milestone {args.n}: {ms[idx]['title']}")
            return 0
        if args.mcmd == "remove":
            removed = ms.pop(idx)
            save(args.slug, goal)
            print(f"removed milestone: {removed['title']}")
            return 0

    if args.cmd == "list":
        goals = all_goals()
        if args.json:
            print(json.dumps([{ "slug": s, **g } for s, g in goals], indent=1))
            return 0
        if not goals:
            print("no goals yet — add one with: goals.py add \"<title>\"")
            return 0
        for slug, g in goals:
            done, total = progress(g)
            print(f"{slug:20} {summary_line(slug, g, time.time())}")
            if g.get("why"):
                print(f"{'':20} why: {g['why']}")
            for i, mst in enumerate(g.get("milestones", []), 1):
                mark = "✓" if mst.get("done") else "○"
                due = f" (due {mst['due']})" if mst.get("due") else ""
                print(f"{'':20} {i}. {mark} {mst['title']}{due}")
        return 0

    if args.cmd == "checkin":
        goals = all_goals()
        if not goals:
            print("No goals tracked yet.")
            return 0
        now = time.time()
        if args.format == "json":
            print(json.dumps([{"slug": s, **g} for s, g in goals], indent=1))
            return 0
        print(f"GOALS CHECK-IN — {time.strftime('%a %d %b', time.localtime(now))}")
        for slug, g in goals:
            done, total = progress(g)
            pct = int(100 * done / total) if total else 0
            print(f"\n■ {g.get('title', slug)} — {done}/{total} milestones ({pct}%)")
            if g.get("why"):
                print(f"  why: {g['why']}")
            for i, mst in enumerate(g.get("milestones", []), 1):
                mark = "DONE" if mst.get("done") else "open"
                due = f" due {mst['due']}" if mst.get("due") else ""
                flag = " ⚠ OVERDUE" if (not mst.get("done") and mst.get("due")
                                        and mst["due"] < time.strftime("%Y-%m-%d", time.localtime(now))) else ""
                print(f"  {i}. [{mark}] {mst['title']}{due}{flag}")
        return 0

    if args.cmd == "remove":
        if os.path.exists(path(args.slug)):
            os.remove(path(args.slug))
            print(f"removed goal {args.slug!r}")
            return 0
        print(f"no goal {args.slug!r}", file=sys.stderr)
        return 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
