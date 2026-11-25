#!/usr/bin/env python3
"""condition_monitor.py — OpenMuse-style condition monitors for Hermes cron.

OpenMuse ships recurring page monitors with change / text-contains /
price-below conditions, exponential failure backoff and deduplicated
notifications.  Hermes' native --monitor-url only does exact-bytes hashing;
this tool adds *condition* evaluation on top, with per-watch durable state.

A watch is a JSON file in ~/.hermes/monitors/:

    {
      "name": "sonnet-price",
      "url": "https://example.com/pricing",
      "kind": "price_below",          # see KINDS below
      "condition": "4.00",            # threshold / pattern, per kind
      "selector": "Sonnet[^$]{0,80}", # optional narrow regex before extraction
      "ignore": ["\\d{1,2}:\\d{2}"],  # optional volatile-text regexes (kind=changed)
      "headers": {"User-Agent": "..."},
      "timeout": 15, "max_bytes": 500000
    }

KINDS
  changed       visible text differs from last run (honours "ignore"); the alert lists the
                changed lines (New / Updated / Removed). A change in relative times alone
                ("3 min ago", "hace 2 horas") is not reported. Line diff ported from
                OpenMuse page-diff.ts (MIT, (c) 2026 OpenMuse contributors).
  text_contains condition substring/regex present
  text_missing  condition substring/regex absent
  price_below   any $ / USD price (after "selector") < condition
  price_above   any $ / USD price (after "selector") > condition
  json_equals   dotted json_path == condition        (path in "selector")
  json_below    numeric json_path < condition
  json_above    numeric json_path > condition

OUTPUT MODES (pick per cron wiring)
  state-all       one stable line per watch, every run — pair with
                  `hermes cron create --monitor-script ...`: Hermes hash-
                  suppresses unchanged output and injects a diff on change.
  run-all         prints ONLY transition lines (empty stdout = silent tick) —
                  pair with `--no-agent --script`: classic watchdog, stdout is
                  delivered verbatim.  This is the default.

Failure handling (OpenMuse semantics): consecutive fetch errors back off
exponentially (1,2,4,8... ticks); an error line is emitted only when the
backoff boundary is crossed, and a "recovered" line when the fetch succeeds
again — so a flapping site pages you once, not forever.

CLI:
  list | add <name> --url U --kind K --condition C [--selector S] [--ignore R]...
       | remove <name> | check <name> [--notify] [--mode state|transitions]
       | run-all [--notify] [--mode state|transitions] | test <name>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hp.notify import send_message  # noqa: E402

HOME = os.path.expanduser("~")
WATCH_DIR = os.path.join(HOME, ".hermes", "monitors")
STATE_DIR = os.path.join(HOME, ".hermes", "state", "monitors")
KINDS = ("changed", "text_contains", "text_missing", "price_below",
         "price_above", "json_equals", "json_below", "json_above")
BACKOFF_BASE_TICKS = 1
BACKOFF_MAX_TICKS = 64


# ---------------------------------------------------------------- fetching

BLOCK_TAGS = {"p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
              "header", "footer", "td", "th", "dt", "dd", "pre", "blockquote", "option", "table", "ul", "ol"}


class _Text(HTMLParser):
    """Strip tags/script/style -> visible-ish text, one line per block element."""

    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self._skip += 1
        elif tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1
        elif tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def _raw_text(html: str) -> str:
    p = _Text()
    p.feed(html)
    return "".join(p.parts)


def visible_text(html: str) -> str:
    return re.sub(r"\s+", " ", _raw_text(html)).strip()


# ---------------------------------------------------------------- page diff (OpenMuse page-diff.ts, MIT)

def page_lines(text: str, limit: int = 2000) -> list[str]:
    """Unique, whitespace-collapsed lines (max 300 chars each) in page order."""
    seen: dict[str, None] = {}
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()[:300]
        if line:
            seen.setdefault(line, None)
        if len(seen) >= limit:
            break
    return list(seen)


# Relative times tick on their own ("58 minutes ago" -> "1 hour ago"); a change in them alone is not news.
_REL_TIME = re.compile(
    r"\b(?:\d+|an?|one)\s+(?:sec(?:ond)?|min(?:ute)?|hour|hr|day|week|month|year)s?\s+ago\b"
    r"|\bhace\s+(?:\d+|un[ao]?)\s+(?:segundo|minuto|min|hora|d[ií]a|semana|mes|año)(?:s|es)?\b"
    r"|\bvor\s+(?:\d+|einer?|einem)\s+(?:sekunde|minute|stunde|tag|woche|monat|jahr)(?:e|en|n)?\b",
    re.I)


def without_relative_times(text: str) -> str:
    return _REL_TIME.sub("<time>", text)


def _numberless(line: str) -> str:
    s = re.sub(r"\d+(?:[.,]\d+)*", "#", without_relative_times(line))
    return re.sub(r"([^\W\d_])s\b", r"\1", s).lower()


def _pair(previous: list[str], current: list[str], key):
    """Pair each current line with one unused previous line of the same key."""
    open_: dict[str, list[str]] = {}
    for line in previous:
        open_.setdefault(key(line), []).append(line)
    used: list[str] = []
    paired, unpaired = [], []
    for line in current:
        bucket = open_.get(key(line))
        if bucket:
            used.append(bucket.pop(0))
            paired.append(line)
        else:
            unpaired.append(line)
    left = list(previous)
    for u in used:
        left.remove(u)
    return paired, unpaired, left


def diff_page(previous: list[str], current: list[str]) -> dict:
    _, unpaired, left = _pair(previous, current, lambda x: x)
    _, unpaired, left = _pair(left, unpaired, without_relative_times)  # only a relative time changed
    updated, added, removed = _pair(left, unpaired, _numberless)
    return {"added": added, "updated": updated, "removed": removed}


def describe_diff(d: dict) -> str:
    out = []
    for title, key, limit in (("New", "added", 8), ("Updated", "updated", 4), ("Removed", "removed", 4)):
        lines = d[key]
        if lines:
            out.append(f"{title}:")
            out += [f"• {x[:160]}" for x in lines[:limit]]
            if len(lines) > limit:
                out.append(f"+{len(lines) - limit} more")
    return "\n".join(out)


def count_diff(d: dict) -> str:
    parts = [f"{len(d[k])} {w}" for k, w in (("added", "new"), ("updated", "updated"), ("removed", "removed")) if d[k]]
    total = sum(len(v) for v in d.values())
    return f"{total} line{'s' if total != 1 else ''} changed ({', '.join(parts)})" if total else ""


def fetch(url: str, headers: dict | None, timeout: int, max_bytes: int) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "hermes-proactive/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (watch URLs are user-configured)
        ctype = r.headers.get("content-type", "")
        return r.read(max_bytes + 1)[:max_bytes], ctype


# ---------------------------------------------------------------- evaluation

def _prices(text: str) -> list[float]:
    return [float(m.replace(",", "")) for m in re.findall(r"(?:\$|USD)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)", text)]


def _json_path(payload, path: str):
    cur = payload
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit():
            cur = cur[int(part)] if int(part) < len(cur) else None
        else:
            return None
    return cur


def evaluate(watch: dict, body: bytes, ctype: str) -> dict:
    """Returns {state: 'ok'|'alert'|'error', line: str, value: any}."""
    kind, name = watch["kind"], watch.get("name", "?")
    cond = str(watch.get("condition", ""))
    sel = watch.get("selector")

    if kind.startswith("json_"):
        payload = json.loads(body.decode("utf-8", "replace"))
        val = _json_path(payload, sel or "")
        if kind == "json_equals":
            hit = str(val) == cond
        else:
            try:
                num = float(val)
                thr = float(cond)
            except (TypeError, ValueError):
                return {"state": "error", "line": f"{name}: ERROR json path {sel!r} -> {val!r} not numeric", "value": val}
            hit = num < thr if kind == "json_below" else num > thr
        return {"state": "alert" if hit else "ok",
                "line": f"{name}: {'ALERT' if hit else 'ok'} {sel}={val} (threshold {cond})",
                "value": val}

    text = body.decode("utf-8", "replace")
    if kind == "changed":
        raw = _raw_text(text) if "<" in text else text
        for pat in watch.get("ignore", []):
            raw = re.sub(pat, " ", raw)
        vis = re.sub(r"\s+", " ", raw).strip()
        digest = hashlib.sha256(vis.encode()).hexdigest()[:16]
        timeless = hashlib.sha256(without_relative_times(vis).encode()).hexdigest()[:16]
        return {"state": "changed", "line": f"{name}: changed hash={digest} len={len(vis)}",
                "value": digest, "timeless": timeless, "lines": page_lines(raw), "snapshot": vis[:400]}

    region = text
    if sel:
        m = re.search(sel, text, re.S)
        region = m.group(0) if m else ""
        if not m:
            return {"state": "error", "line": f"{name}: ERROR selector {sel!r} matched nothing", "value": None}

    if kind == "text_contains":
        hit = re.search(cond, region) is not None
        return {"state": "alert" if hit else "ok",
                "line": f"{name}: {'ALERT' if hit else 'ok'} pattern {cond!r} {'found' if hit else 'absent'}",
                "value": hit}
    if kind == "text_missing":
        hit = re.search(cond, region) is not None
        return {"state": "alert" if not hit else "ok",
                "line": f"{name}: {'ALERT' if not hit else 'ok'} expected text {cond!r} {'present' if hit else 'MISSING'}",
                "value": hit}
    # price kinds
    prices = _prices(visible_text(region) if "<" in region else region)
    if not prices:
        return {"state": "error", "line": f"{name}: ERROR no price found in selected region", "value": None}
    thr = float(cond)
    hits = [p for p in prices if (p < thr if kind == "price_below" else p > thr)]
    hit = bool(hits)
    price = hits[0] if hits else prices[0]
    return {"state": "alert" if hit else "ok",
            "line": f"{name}: {'ALERT' if hit else 'ok'} price ${price:.2f} threshold ${thr:.2f}",
            "value": price}


# ---------------------------------------------------------------- state

def state_path(name: str) -> str:
    return os.path.join(STATE_DIR, f"{name}.json")


def load_state(name: str) -> dict:
    try:
        with open(state_path(name)) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(name: str, st: dict) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = state_path(name) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, state_path(name))


def load_watch(path: str) -> dict:
    with open(path) as f:
        w = json.load(f)
    w.setdefault("timeout", 15)
    w.setdefault("max_bytes", 500_000)
    w.setdefault("headers", {})
    if w["kind"] not in KINDS:
        raise ValueError(f"unknown kind {w['kind']!r}; one of {', '.join(KINDS)}")
    return w


def list_watches() -> list[dict]:
    out = []
    for fn in sorted(os.listdir(WATCH_DIR)):
        if fn.endswith(".json"):
            try:
                out.append(load_watch(os.path.join(WATCH_DIR, fn)))
            except Exception as ex:  # noqa: BLE001 - report and continue
                out.append({"name": fn[:-5], "kind": "?", "url": f"CONFIG ERROR: {ex}"})
    return out


# ---------------------------------------------------------------- core tick

def run_watch(watch: dict, *, mode: str = "transitions", notify: bool = False,
              dry_run: bool = False) -> str | None:
    """Evaluate one watch, persist state, return the line to emit (or None)."""
    name = watch.get("name") or "?"
    st = load_state(name)
    now = time.time()

    def commit(fail_inc: int = 0, **kw):
        st["failures"] = st.get("failures", 0) + fail_inc
        st.update(kw)
        st["last_run"] = now
        save_state(name, st)

    try:
        body, ctype = fetch(watch["url"], watch["headers"], watch["timeout"], watch["max_bytes"])
        res = evaluate(watch, body, ctype)
    except Exception as ex:  # noqa: BLE001 - network/parse errors are the backoff path
        fails = st.get("failures", 0) + 1
        backoff = min(BACKOFF_BASE_TICKS * (2 ** min(fails, 10)), BACKOFF_MAX_TICKS)
        crossed = fails == 1 or fails >= backoff and fails % backoff == 0
        commit(1)
        if not crossed:
            return None
        line = f"{name}: ERROR fetch/eval failed ({fails}x): {ex}"
        if notify:
            send_message(line, dry_run=dry_run)
        return line

    prev_failures = st.get("failures", 0)
    if res["state"] == "error":
        commit(1)
        line = res["line"] + f" [after {prev_failures} fetch failures]" if prev_failures else res["line"]
        if prev_failures:  # recovery path below handles success-after-failure
            pass
        if notify:
            send_message(line, dry_run=dry_run)
        return line

    if prev_failures:
        commit(-prev_failures)  # reset to 0
        line = f"{name}: recovered (after {prev_failures} failures) — {res['line']}"
        if notify:
            send_message(line, dry_run=dry_run)
        return line if mode == "transitions" else f"{name}: ok (recovered)"

    if watch["kind"] == "changed":
        old_baseline, old_timeless, old_lines = st.get("baseline"), st.get("timeless"), st.get("lines")
        commit(0, baseline=res["value"], timeless=res["timeless"], lines=res["lines"])
        if old_baseline is None or old_timeless is None:  # first run, or state from before the line diff
            return f"{name}: baseline hash={res['value']}" if mode == "state" else None
        if res["value"] == old_baseline:
            return f"{name}: ok hash={res['value']}" if mode == "state" else None
        if old_timeless == res["timeless"]:  # only relative times ("3 min ago") changed: keep quiet
            return f"{name}: ok (only relative times changed)" if mode == "state" else None
        d = diff_page(old_lines, res["lines"]) if old_lines is not None else None
        summary = count_diff(d) if d else ""
        line = f"{name}: changed — {watch['url']}" + (f" — {summary}" if summary else "")
        if d and not summary:  # text moved but no line changed (e.g. a reflow): not news
            return f"{name}: ok (reflow only)" if mode == "state" else None
        if notify:
            body = describe_diff(d) if d else (res.get("snapshot") or "")
            send_message(line + "\n\n" + body, dry_run=dry_run)
        return line + ("\n" + describe_diff(d) if d else "")

    prev_alert = st.get("alert")
    hit = res["state"] == "alert"
    commit(0, value=res["value"], alert=hit)
    if mode == "state":
        return res["line"]
    first_run = prev_alert is None
    if not first_run and prev_alert == hit:
        return None
    # first run only surfaces already-alerting conditions, not quiet baselines
    if first_run and not hit:
        return None
    if notify and hit:
        send_message(res["line"], dry_run=dry_run)
    return res["line"]


# ---------------------------------------------------------------- CLI

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print instead of sending Telegram")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list")

    a = sub.add_parser("add")
    a.add_argument("name")
    a.add_argument("--url", required=True)
    a.add_argument("--kind", required=True, choices=KINDS)
    a.add_argument("--condition", default="")
    a.add_argument("--selector", default=None)
    a.add_argument("--ignore", action="append", default=[])
    a.add_argument("--header", action="append", default=[], help="'K: V' pairs")

    r = sub.add_parser("remove")
    r.add_argument("name")

    for c in ("check", "test"):
        p = sub.add_parser(c)
        p.add_argument("name")
        p.add_argument("--notify", action="store_true")
        p.add_argument("--mode", choices=("state", "transitions"), default="transitions")

    ra = sub.add_parser("run-all")
    ra.add_argument("--notify", action="store_true")
    ra.add_argument("--mode", choices=("state", "transitions"), default="transitions")

    args = ap.parse_args()
    os.makedirs(WATCH_DIR, exist_ok=True)

    if args.cmd == "list":
        for w in list_watches():
            st = load_state(w.get("name", ""))
            extra = f" last={st.get('line', '')[:60]}" if st.get("line") else ""
            print(f"{w.get('name', '?'):24} {w.get('kind', '?'):14} {w.get('url', '?')}{extra}")
        return 0

    if args.cmd == "add":
        w = {"name": args.name, "url": args.url, "kind": args.kind,
             "condition": args.condition, "selector": args.selector, "ignore": args.ignore,
             "headers": dict(h.split(":", 1) for h in args.header)}
        path = os.path.join(WATCH_DIR, f"{args.name}.json")
        if os.path.exists(path):
            print(f"refusing to overwrite existing watch {args.name!r} — remove it first", file=sys.stderr)
            return 1
        with open(path, "w") as f:
            json.dump({k: v for k, v in w.items() if v not in (None, "", [])}, f, indent=1)
        print(f"watch {args.name!r} written to {path}")
        return 0

    if args.cmd == "remove":
        for p in (os.path.join(WATCH_DIR, f"{args.name}.json"), state_path(args.name)):
            if os.path.exists(p):
                os.remove(p)
                print(f"removed {p}")
        return 0

    if args.cmd in ("check", "test"):
        w = load_watch(os.path.join(WATCH_DIR, f"{args.name}.json"))
        if args.cmd == "test":
            body, ctype = fetch(w["url"], w["headers"], w["timeout"], w["max_bytes"])
            print(json.dumps(evaluate(w, body, ctype), indent=1, default=str))
            return 0
        line = run_watch(w, mode=args.mode, notify=args.notify, dry_run=args.dry_run)
        if line:
            print(line)
        return 0

    if args.cmd == "run-all":
        emitted = 0
        for w in list_watches():
            if w.get("kind") == "?":
                print(w["url"], file=sys.stderr)
                continue
            line = run_watch(w, mode=args.mode, notify=args.notify, dry_run=args.dry_run)
            if line:
                print(line)
                emitted += 1
        return 0 if emitted == 0 else 10  # 10 = "something to report" for watchdog wrappers

    return 2


if __name__ == "__main__":
    sys.exit(main())
