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

IDEAS (OpenMuse refreshIdeas/decideIdea port, MIT, (c) 2026 OpenMuse contributors) — suggestions with
evidence, no model call, sent one card each with Start / Hide buttons (plugin idea_buttons):
  mail    from ~/.hermes/state/mail_triage_latest.json (mail_triage.py, 07:20): an attachment plus
          form/permission/fill/sign words -> "I can help with <subject>" (document); meet/schedule/
          available/coffee words -> "I can help coordinate <subject>"
  goals   an active goal with no open milestone -> "Let's make a plan for <goal>"
  An idea is retired, never sent, once handled: you replied in that thread, the goal got an open
  milestone, or you started/hid it. Hidden ideas stay hidden.

Every finding gets: id, severity (info|warn|action), one-line suggestion.
Delivered findings live in ~/.hermes/state/proactive_scan.json with a 7-day
re-alert TTL; `ack <id>` silences one permanently.  Un-acked findings re-surface
on every scan — that recurring nudge loop is the point.

CLI:
  run [--notify] [--source S]...    scan + print/emit new findings
  list                              known finding ids (acked ones marked)
  ack <finding-id>                  silence permanently
  add-feed <url> [--name N]         register an RSS source
  test <source>                     dump raw findings, no state changes
  ideas [--notify]                  refresh ideas, retire handled ones, send new cards
  idea-decide <idea-id> start|hide  record a button tap (start creates a kanban task)

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


_ATOM = "{http://www.w3.org/2005/Atom}"
_RSS1 = "{http://purl.org/rss/1.0/}"


def _feed_entries(root: ET.Element) -> list[tuple[str, str]]:
    """(title, link) per entry of an RSS 2.0, RSS 1.0 (RDF) or Atom feed."""
    out = []
    for ns in ("", _RSS1):
        for item in root.iter(ns + "item"):
            out.append(((item.findtext(ns + "title") or "").strip(),
                        (item.findtext(ns + "link") or "").strip()))
    for entry in root.iter(_ATOM + "entry"):
        links = entry.findall(_ATOM + "link")
        alt = [x for x in links if x.get("rel", "alternate") == "alternate"]
        out.append(((entry.findtext(_ATOM + "title") or "").strip(),
                    ((alt or [ET.Element("link")])[0].get("href") or "").strip()))
    return out


def src_rss(state: dict) -> list[dict]:
    out = []
    feeds = []
    if os.path.exists(FEEDS):
        with open(FEEDS) as f:
            feeds = json.load(f)
    seen = state.setdefault("rss_seen", {})
    now = time.time()
    for feed in feeds:
        try:
            req = urllib.request.Request(feed["url"], headers={"User-Agent": "hermes-proactive/0.1"})
            with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310
                root = ET.fromstring(resp.read(500_000))
        except Exception:  # noqa: BLE001 - a dead feed shouldn't kill the scan
            out.append({"id": f"rss-dead-{hashlib_md5(feed['url'])}", "severity": "warn",
                        "source": "rss", "suggestion": f"RSS feed unreachable: {feed.get('name') or feed['url']}"})
            continue
        for title, link in _feed_entries(root):
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
            # id = path + severity band, not the percent: 91% -> 92% is the same
            # finding (TTL/ack apply); crossing into "action" alerts again
            severity = "warn" if pct < 95 else "action"
            out.append({"id": f"disk-{path.strip('/') or 'root'}-{severity}", "severity": severity,
                        "source": "disk",
                        "suggestion": f"{path}: {pct:.0f}% full — clean up before something breaks"})
    return out


SOURCES = {"git": src_git, "github": src_github, "rss": src_rss, "disk": src_disk}


# ---------------------------------------------------------------- ideas (OpenMuse port)

MAIL_JSON = os.path.join(HOME, ".hermes", "state", "mail_triage_latest.json")
GOALS_DIR = os.path.join(HOME, ".hermes", "goals")
DOC_WORDS = re.compile(r"form|permission|complete|fill|sign|formulario|permiso|completar|llenar|firma", re.I)
MEET_WORDS = re.compile(r"coffee|meet|available|schedule|reuni[oó]n|disponib|agendar|llamada|caf[eé]", re.I)


def idea_candidates() -> list[dict]:
    out = []
    try:
        mail = json.load(open(MAIL_JSON)).get("sorted", [])
    except (OSError, ValueError):
        mail = []
    for m in mail:
        text = f"{m.get('subject', '')} {m.get('body_head', '')}"
        who = (m.get("from") or "").split("<")[0].strip() or m.get("from", "")
        base = {"source": "mail", "ref": m.get("threadId") or m.get("id"), "handled": bool(m.get("replied")),
                "evidence": f"{who} — {m.get('subject', '')[:90]} ({m.get('date', '')[:16]})"}
        if m.get("attachments") and DOC_WORDS.search(text):
            out.append({**base, "id": f"idea-doc-{base['ref']}", "kind": "document",
                        "title": f"I can help with {m.get('subject', '')[:80]}",
                        "reason": f"{who} sent a document that may need you. I can prepare it and a reply for your review."})
        elif MEET_WORDS.search(text) and m.get("verdict") == "needs_you":
            out.append({**base, "id": f"idea-meet-{base['ref']}", "kind": "coordinate",
                        "title": f"I can help coordinate {m.get('subject', '')[:80]}",
                        "reason": f"{who} wants to find a time. I can check the calendar and draft a reply."})
    for fn in sorted(os.listdir(GOALS_DIR)) if os.path.isdir(GOALS_DIR) else []:
        if not fn.endswith(".json"):
            continue
        try:
            g = json.load(open(os.path.join(GOALS_DIR, fn)))
        except (OSError, ValueError):
            continue
        if str(g.get("status", "active")).lower() not in ("active", ""):
            continue
        ms = g.get("milestones") or []
        open_ms = [x for x in ms if not x.get("done")]
        gid = fn[:-5]
        if not open_ms:
            title = (f"Let's make a plan for {g.get('title', gid)}" if not ms
                     else f"Pick the next step for {g.get('title', gid)}")
            out.append({"id": f"idea-plan-{gid}-{len(ms)}", "source": "goals", "ref": gid, "kind": "plan",
                        "handled": False, "title": title[:110],
                        "reason": ("It has no milestones yet." if not ms else "Every milestone is done, but the goal is still open.")
                                  + " I can draft three dated milestones for you to approve.",
                        "evidence": f"goal {gid}: {g.get('why', '')[:100]}"})
    return out


def refresh_ideas(st: dict) -> list[dict]:
    """Update st['ideas']; return the ideas that are new and should be sent now."""
    ideas = st.setdefault("ideas", {})
    seen = set()
    for c in idea_candidates():
        seen.add(c["id"])
        cur = ideas.get(c["id"])
        if cur is None:
            if c["handled"]:
                continue  # already handled before we ever suggested it
            ideas[c["id"]] = {**c, "status": "new", "ts": time.time()}
        elif c["handled"] and cur["status"] in ("new", "sent"):
            cur["status"] = "retired"
    for iid, cur in ideas.items():  # goal ideas whose goal got a milestone: retire
        if cur["source"] == "goals" and iid not in seen and cur["status"] in ("new", "sent"):
            cur["status"] = "retired"
    for iid, cur in sorted(ideas.items(), key=lambda kv: kv[1].get("ts", 0))[:-300]:
        del ideas[iid]
    fresh = sorted((i for i in ideas.values() if i["status"] == "new"), key=lambda i: i.get("ts", 0))
    return fresh[:5]  # OpenDuet: at most five suggestions per check-in; the rest wait for the next one


def send_idea(idea: dict, dry_run: bool) -> bool:
    text = f"💡 {idea['title']}\n{idea['reason']}\n\nEvidence: {idea['evidence']}"
    cid = idea["id"][:56]
    cmd = [os.path.join(HOME, ".hermes", "scripts", "tg_send.py"), "message", text,
           "--cb", f"Start|ix:s:{cid}|primary", "--cb", f"Hide|ix:h:{cid}"]
    if dry_run:
        print("DRY", " ".join(cmd[2:]))
        return True
    return subprocess.run(cmd, capture_output=True, timeout=60).returncode == 0


def decide_idea(st: dict, prefix: str, choice: str) -> str:
    ideas = st.get("ideas", {})
    iid = next((k for k in ideas if k[:56] == prefix), None)
    if not iid:
        return "That suggestion is no longer known."
    idea = ideas[iid]
    if idea["status"] in ("started", "hidden"):
        return f"Already {idea['status']}."
    if choice == "hide":
        idea["status"] = "hidden"
        return "Hidden. It will not be suggested again."
    body = f"{idea['reason']}\n\nEvidence: {idea['evidence']}\nSource: {idea['source']} {idea['ref']}"
    r = subprocess.run(["hermes", "kanban", "create", idea["title"], "--body", body, "--created-by", "idea_buttons",
                        "--idempotency-key", iid], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return f"Could not create the task: {(r.stderr or r.stdout).strip()[:120]}"
    idea["status"] = "started"
    return "Started: added to the kanban board."


# ---------------------------------------------------------------- dedup/ack

def load_state() -> dict:
    try:
        with open(STATE) as f:
            st = json.load(f)
    except (OSError, json.JSONDecodeError):
        st = {}
    if not isinstance(st, dict):
        st = {}
    # older or hand-edited state files may lack a key; ack/list/run index both
    if not isinstance(st.get("delivered"), dict):
        st["delivered"] = {}
    if not isinstance(st.get("acked"), list):
        st["acked"] = []
    return st


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
    iv = sub.add_parser("ideas")
    iv.add_argument("--notify", action="store_true")
    idd = sub.add_parser("idea-decide")
    idd.add_argument("idea_id")
    idd.add_argument("choice", choices=("start", "hide"))

    # --dry-run also works after the subcommand (`run --notify --dry-run`); SUPPRESS keeps
    # a --dry-run given before the subcommand from being reset to False.
    for p in sub.choices.values():
        p.add_argument("--dry-run", action="store_true", default=argparse.SUPPRESS,
                       help="print the notification instead of sending it")

    args = ap.parse_args()
    st = load_state()

    if args.cmd == "add-feed":
        feeds = []
        if os.path.exists(FEEDS):
            with open(FEEDS) as f:
                feeds = json.load(f)
        if any(fd.get("url") == args.url for fd in feeds):
            print(f"feed already registered ({len(feeds)} total)")
            return 0
        feeds.append({"url": args.url, "name": args.name or args.url})
        os.makedirs(os.path.dirname(FEEDS), exist_ok=True)
        with open(FEEDS, "w") as f:
            json.dump(feeds, f, indent=1)
        print(f"feed added ({len(feeds)} total)")
        return 0

    if args.cmd == "ideas":
        fresh = refresh_ideas(st)
        save_state(st)
        if not fresh:
            print("no new ideas")
            return 0
        for idea in fresh:
            ok = send_idea(idea, args.dry_run) if args.notify else True
            if ok:
                idea["status"] = "sent"
            print(f"{'sent' if args.notify else 'new'}: {idea['title']}")
        save_state(st)
        return 0

    if args.cmd == "idea-decide":
        msg = decide_idea(st, args.idea_id, args.choice)
        save_state(st)
        print(msg)
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

        # `test` takes one positional source; `run --source` is an append list
        names = [args.source] if args.cmd == "test" else (args.source or sorted(SOURCES))
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
