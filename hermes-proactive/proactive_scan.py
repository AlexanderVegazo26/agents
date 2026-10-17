#!/usr/bin/env python3
"""proactive_scan.py — OpenBot-style proactive engine + OpenMuse-style ideas.

OpenBot's proactive engine: bots scan the owner's connected apps *read-only*,
form memories, and surface suggested next steps.  OpenMuse's ideas engine:
rule-based suggestion generation from mail/goals/tasks, deduplicated.

Hermes cron already *fetches* data (scripts + prompts). What's missing is the
suggestion layer: turning raw scans into ranked, deduplicated, acknowledgeable
proposals.  This is that layer.

Sources (all read-only, stdlib + gh CLI):
  git     scan ~/Documents/repos/* : unpushed commits, uncommitted changes,
          stashes, repos gone stale (no commit in N days)
  github  `gh api notifications` (unread) + PRs awaiting your review
  rss     configured feeds -> items newer than last scan
  disk    filesystem usage above threshold

Every finding gets: id, severity (info|warn|action), one-line suggestion.
Delivered findings live in ~/.hermes/state/proactive_scan.json with a 7-day
re-alert TTL; `ack <id>` silences one permanently.  Un-acked findings re-surface
on every scan — that recurring nudge loop is the point.

CLI:
  run [--notify] [--source S]...    scan + print/emit new findings
  list                              pending (un-acked) findings
  ack <finding-id>                  silence permanently
  add-feed <url> [--name N]         register an RSS source
  test <source>                     dump raw findings, no state changes

Cron wiring (see README): run on a schedule with --notify, or attach as a
--script and let the LLM turn the findings into a daily "here's what needs
you" message.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hp.notify import send_message  # noqa: E402

HOME = os.path.expanduser("~")
REPOS_DIR = os.path.join(HOME, "Documents", "repos")
STATE = os.path.join(HOME, ".hermes", "state", "proactive_scan.json")
FEEDS = os.path.join(HOME, ".hermes", "proactive_feeds.json")
DISK_THRESHOLD_PCT = 90
STALE_DAYS = 21
RE_ALERT_SECONDS = 7 * 24 * 3600


# ---------------------------------------------------------------- sources

def _sh(cmd: list[str], cwd: str | None = None, timeout: int = 30) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                              cwd=cwd).stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""


def src_git() -> list[dict]:
    out = []
    base = REPOS_DIR
    if not os.path.isdir(base):
        return out
    for name in sorted(os.listdir(base)):
        d = os.path.join(base, name)
        if not os.path.isdir(os.path.join(d, ".git")):
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        if _sh(["git", "rev-parse", "--is-inside-work-tree"], d) != "true":
            continue
        unpushed = _sh(["git", "log", "--oneline", "--branches", "--not", "--remotes"], d)
        if unpushed:
            n = len(unpushed.splitlines())
            out.append({"id": f"git-unpushed-{slug}", "severity": "action",
                        "source": "git", "suggestion": f"repo {name}: {n} unpushed commit(s) — push or prune",
                        "detail": unpushed[:400]})
        dirty = _sh(["git", "status", "--porcelain"], d)
        if dirty:
            n = len(dirty.splitlines())
            out.append({"id": f"git-dirty-{slug}", "severity": "warn",
                        "source": "git", "suggestion": f"repo {name}: {n} uncommitted change(s) — commit or stash",
                        "detail": dirty[:300]})
        stashes = _sh(["git", "stash", "list"], d)
        if stashes:
            out.append({"id": f"git-stash-{slug}", "severity": "info",
                        "source": "git", "suggestion": f"repo {name}: {len(stashes.splitlines())} stash(es) gathering dust",
                        "detail": stashes[:200]})
        last = _sh(["git", "log", "-1", "--format=%ct"], d)
        if last and time.time() - float(last) > STALE_DAYS * 86400:
            out.append({"id": f"git-stale-{slug}", "severity": "info",
                        "source": "git", "suggestion": f"repo {name}: no commits in {STALE_DAYS}+ days — archive or refresh"})
    return out


def src_github() -> list[dict]:
    if not shutil_which("gh"):
        return [{"id": "github-no-cli", "severity": "info", "source": "github",
                 "suggestion": "gh CLI not on PATH — github source disabled"}]
    out = []
    notifs = _sh(["gh", "api", "notifications", "--jq",
                  ".[] | {repo: .repository.full_name, reason: .reason, title: .subject.title, url: .subject.url}"],
                 timeout=45)
    for line in notifs.splitlines():
        try:
            n = json.loads(line)
        except json.JSONDecodeError:
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", (n.get("repo") or "?").lower()).strip("-")
        out.append({"id": f"gh-notif-{slug}-{hashlib_md5(n.get('title', ''))}", "severity": "info",
                    "source": "github",
                    "suggestion": f"github: {n.get('title')} ({n.get('repo')}, {n.get('reason')})"})
    reviews = _sh(["gh", "search", "prs", "--review-requested=@me", "--state=open",
                   "--json=repository,title,url,createdAt", "--limit=10"], timeout=45)
    try:
        for pr in json.loads(reviews or "[]"):
            slug = re.sub(r"[^a-z0-9]+", "-", pr["repository"]["nameWithOwner"].lower()).strip("-")
            out.append({"id": f"gh-review-{slug}-{hashlib_md5(pr['url'])}", "severity": "action",
                        "source": "github",
                        "suggestion": f"review requested: {pr['title']} ({pr['repository']['nameWithOwner']})",
                        "detail": pr["url"]})
    except json.JSONDecodeError:
        pass
    return out


def shutil_which(cmd: str) -> str | None:
    for p in os.environ.get("PATH", "").split(os.pathsep):
        full = os.path.join(p, cmd)
        if os.path.isfile(full) and os.access(full, os.X_OK):
            return full
    return None


def hashlib_md5(s: str) -> str:
    import hashlib
    return hashlib.md5(s.encode()).hexdigest()[:10]  # noqa: S324 - dedup id, not crypto


def src_rss(state: dict) -> list[dict]:
    out = []
    feeds = []
    if os.path.exists(FEEDS):
        feeds = json.load(open(FEEDS))
    seen = state.setdefault("rss_seen", {})
    now = time.time()
    for feed in feeds:
        try:
            req = urllib.request.Request(feed["url"], headers={"User-Agent": "hermes-proactive/0.1"})
            root = ET.fromstring(urllib.request.urlopen(req, timeout=20).read(500_000))  # noqa: S310
        except Exception:  # noqa: BLE001 - a dead feed shouldn't kill the scan
            out.append({"id": f"rss-dead-{hashlib_md5(feed['url'])}", "severity": "warn",
                        "source": "rss", "suggestion": f"RSS feed unreachable: {feed.get('name') or feed['url']}"})
            continue
        for item in root.iter("item"):
            link = (item.findtext("link") or "").strip()
            title = (item.findtext("title") or "").strip()
            if not link or link in seen:
                continue
            seen[link] = now
            out.append({"id": f"rss-{hashlib_md5(link)}", "severity": "info", "source": "rss",
                        "suggestion": f"{feed.get('name', 'feed')}: {title}", "detail": link})
        # prune seen older than 30 days
        for k, ts in list(seen.items()):
            if now - ts > 30 * 86400:
                del seen[k]
    return out


def src_disk() -> list[dict]:
    out = []
    for path in (HOME, "/"):
        try:
            st = os.statvfs(path)
        except OSError:
            continue
        pct = (st.f_blocks - st.f_bfree) / max(st.f_blocks, 1) * 100
        if pct >= DISK_THRESHOLD_PCT:
            out.append({"id": f"disk-{path.strip('/') or 'root'}-{(int(pct))}", "severity": "warn" if pct < 95 else "action",
                        "source": "disk",
                        "suggestion": f"{path}: {pct:.0f}% full — clean up before something breaks"})
    return out


SOURCES = {"git": src_git, "github": src_github, "rss": src_rss, "disk": src_disk}


# ---------------------------------------------------------------- dedup/ack

def load_state() -> dict:
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"delivered": {}, "acked": []}


def save_state(st: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, STATE)


def pending(findings: list[dict], st: dict) -> list[dict]:
    now = time.time()
    fresh = []
    for f in findings:
        if f["id"] in st["acked"]:
            continue
        first = st["delivered"].get(f["id"], 0)
        if first and now - first < RE_ALERT_SECONDS:
            continue
        st["delivered"][f["id"]] = now
        fresh.append(f)
    # cap delivered map
    for k, ts in sorted(st["delivered"].items(), key=lambda kv: kv[1])[:-200]:
        del st["delivered"][k]
    return fresh


# ---------------------------------------------------------------- CLI

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run")
    r.add_argument("--notify", action="store_true")
    r.add_argument("--source", action="append", choices=sorted(SOURCES))

    sub.add_parser("list")
    a = sub.add_parser("ack")
    a.add_argument("finding_id")
    af = sub.add_parser("add-feed")
    af.add_argument("url")
    af.add_argument("--name", default=None)
    t = sub.add_parser("test")
    t.add_argument("source", choices=sorted(SOURCES))

    args = ap.parse_args()
    st = load_state()

    if args.cmd == "add-feed":
        feeds = json.load(open(FEEDS)) if os.path.exists(FEEDS) else []
        feeds.append({"url": args.url, "name": args.name or args.url})
        with open(FEEDS, "w") as f:
            json.dump(feeds, f, indent=1)
        print(f"feed added ({len(feeds)} total)")
        return 0

    if args.cmd == "ack":
        if args.finding_id not in st["acked"]:
            st["acked"].append(args.finding_id)
        save_state(st)
        print(f"acked {args.finding_id!r}")
        return 0

    if args.cmd in ("run", "test", "list"):
        if args.cmd == "list":
            known = sorted(st["delivered"])
            print("pending/known finding ids (ack to silence):")
            for i in known[-50:]:
                mark = "ACKED " if i in st["acked"] else "active"
                print(f"  [{mark}] {i}")
            return 0

        names = args.source or sorted(SOURCES)
        findings = []
        for n in names:
            try:
                findings.extend(SOURCES[n](st) if n == "rss" else SOURCES[n]())
            except Exception as ex:  # noqa: BLE001
                findings.append({"id": f"source-error-{n}", "severity": "warn",
                                 "source": n, "suggestion": f"source {n} errored: {ex}"})

        if args.cmd == "test":
            print(json.dumps(findings, indent=1))
            return 0

        fresh = pending(findings, st)
        save_state(st)
        if not fresh:
            print("no new findings")
            return 0
        sev_rank = {"action": 0, "warn": 1, "info": 2}
        fresh.sort(key=lambda f: sev_rank.get(f["severity"], 3))
        lines = [f"[{f['severity'].upper():6}] {f['suggestion']}" + (f"\n    {f['detail']}" if f.get("detail") else "")
                 for f in fresh]
        print("\n".join(lines))
        if args.notify:
            send_message("🧭 proactive scan — " + str(len(fresh)) + " new finding(s):\n" + "\n".join(lines),
                         dry_run=args.dry_run)
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
