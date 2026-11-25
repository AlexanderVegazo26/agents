#!/usr/bin/env python3
"""ai_news_fetch.py -- AI radar data gatherer (Hermes `ai-radar` cron job).

Fetches AI news from a curated set of RSS/Atom feeds and prints DATA lines for
the model step to compose the "🧠 AI radar" Telegram message. This script does
NOT call any model: it only prints data to stdout.

Output -- one item per line, TAB-separated:
    KIND<TAB>source<TAB>title<TAB>url

    KIND  one of  NEWS | TOOL | TREND   (drives the radar's sections)
On a feed error it prints a failure line (so the model knows a source didn't load)
instead of dying:
    SOURCE FAILED<TAB>source<TAB>reason<TAB>

Diagnostics (counts, per-feed status) go to STDERR, never stdout, so they never
pollute the DATA the model sees.

Stdlib only (urllib + xml.etree + email.utils) so it runs in the minimal cron
environment with no external packages.

Usage:
    python3 ai_news_fetch.py [--limit N] [--per-feed M] [--quiet]
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

USER_AGENT = "SonnetCode/ai-radar (feed fetcher; +https://sonnetcode.com)"
TIMEOUT = 20
ENCODINGS = ("utf-8", "iso-8859-1", "windows-1252")


# --- Curated feeds -----------------------------------------------------------
# kind_hint is a soft default; per-title heuristics can still override it.
FEEDS = [
    {"name": "TechCrunch AI", "url": "https://techcrunch.com/category/artificial-intelligence/feed/", "kind_hint": "NEWS"},
    {"name": "The Verge AI", "url": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", "kind_hint": "NEWS"},
    {"name": "MIT Tech Review", "url": "https://www.technologyreview.com/feed/", "kind_hint": "TREND"},
    {"name": "Ars Technica", "url": "https://feeds.arstechnica.com/arstechnica/index", "kind_hint": "NEWS"},
    {"name": "Ars Technica · Tech Lab", "url": "https://feeds.arstechnica.com/arstechnica/technology-lab", "kind_hint": "TOOL"},
    {"name": "Google AI Blog", "url": "https://blog.google/technology/ai/rss", "kind_hint": "TOOL"},
    {"name": "ZDNet", "url": "https://www.zdnet.com/rss/news/", "kind_hint": "NEWS"},
    {"name": "ArXiv cs.AI", "url": "http://export.arxiv.org/rss/cs.ai", "kind_hint": "TOOL"},
    {"name": "ArXiv cs.LG", "url": "http://export.arxiv.org/rss/cs.lg", "kind_hint": "TOOL"},
]

TOOL_WORDS = ("model", "release", "launch", "weights", "api", "open source", "open-source",
              "plugin", "sdk", "tool", "update", "v2", "v3", "v4", "fine-tune", "fine tuning",
              "fine-tuning", "benchmark", "checkpoint", "release", "out now", "now available")
TREND_WORDS = ("trend", "future", "why", "signal", "analysis", "report", "state of",
               "inside", "opinion", "interview", "perspective", "lessons", "lessons from",
               "what i learned", "prediction", "outlook", "era", "shift", "race")


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "application/rss+xml, application/atom+xml, application/xml, */*"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        raw = r.read()
    for enc in ENCODINGS:
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _text(el) -> str:
    if el is None:
        return ""
    return (el.text or "").strip()


def _find(el, path):
    # single-segment path; first match wins (used where the result feeds _text)
    kids = el.findall(".//" + path)
    return kids[0] if kids else None


def _pick(el, *paths):
    """First path that matches, else None. Explicit None avoids Element truthiness tests."""
    for p in paths:
        found = el.findall(".//" + p)
        if found:
            return found[0]
    return None


def norm_url(url: str) -> str:
    url = (url or "").strip()
    for p in ("utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
              "fbclid", "gclid", "ref", "ref_src"):
        url = re.sub(r"[?&]" + p + r"=[^&#]+", "", url, flags=re.I)
    return url.rstrip("/").rstrip("?")


def classify(title: str, kind_hint: str) -> str:
    t = (title or "").lower()
    if any(w in t for w in TOOL_WORDS):
        return "TOOL"
    if any(w in t for w in TREND_WORDS):
        return "TREND"
    return kind_hint or "NEWS"


def parse_date(text: str):
    text = (text or "").strip()
    if not text:
        return None
    for fn in (parsedate_to_datetime, lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))):
        try:
            d = fn(text)
            if d.tzinfo is None:
                d = d.replace(tzinfo=dt.timezone.utc)
            return d
        except Exception:
            continue
    return None


def _localize(root: ET.Element) -> ET.Element:
    """Rewrite every tag to its local name, dropping the namespace URI.

    Works for RSS (no namespace) and Atom/ArXiv (prefixed) so one tag set
    (`entry`, `title`, `link`, `channel`, `item`) handles every feed without
    guessing namespace URIs."""
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def items_from_text(xml_text: str):
    """Return (kind_hint, [ {title, url, date} ]) from RSS or Atom XML text."""
    root = _localize(ET.fromstring(xml_text))
    items = []
    kind_hint = "NEWS"

    # Atom
    atom_entries = root.findall(".//entry")
    if atom_entries:
        for e in atom_entries:
            link_el = _pick(e, 'link[rel="alternate"]', "link", "url")
            link = link_el.get("href") if link_el is not None else ""
            title = _text(_find(e, "title"))
            if not link:
                link = ""  # keep title even if link missing; model can skip
            date_el = _pick(e, "updated", "published")
            items.append({"title": title, "url": link, "date": parse_date(_text(date_el))})
        return kind_hint, items

    # RSS 2.0
    channel = root.find("channel")
    if channel is not None:
        seen = 0
        for it in channel.findall("item"):
            title = _text(_find(it, "title"))
            link = _text(_find(it, "link"))
            date = parse_date(_text(_find(it, "pubDate")))
            items.append({"title": title, "url": link, "date": date})
            seen += 1
            if seen >= 15:
                break
        return kind_hint, items

    return kind_hint, items


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=28, help="max total items on stdout")
    ap.add_argument("--per-feed", type=int, default=5, help="max items per feed")
    ap.add_argument("--quiet", action="store_true", help="suppress STDERR diagnostics")
    a = ap.parse_args()

    total, failed = 0, 0
    seen_urls: set[str] = set()
    collected = []
    failures = []

    for feed in FEEDS:
        try:
            xml_text = http_get(feed["url"])
            kind_hint, items = items_from_text(xml_text)
            loaded = 0
            for it in items:
                if loaded >= a.per_feed:
                    break
                if not it["title"]:
                    continue
                url = norm_url(it["url"])
                key = url or (it["title"].lower() + str(it["date"] or ""))
                if key in seen_urls:
                    continue
                seen_urls.add(key)
                kind = classify(it["title"], feed.get("kind_hint") or kind_hint)
                collected.append((kind, feed["name"], it["title"], url, it["date"]))
                loaded += 1
            total += loaded
            if not a.quiet:
                print(f"[feed] {feed['name']}: {loaded} items", file=sys.stderr)
        except Exception as e:  # keep going: mark this feed, not the whole run
            failed += 1
            reason = f"{type(e).__name__}: {(str(e) or '')[:60]}"
            failures.append((feed["name"], reason))

    # STDOUT (DATA the model composes from): data lines newest-first, then the
    # SOURCE FAILED lines so the model knows which sources didn't update.
    collected.sort(key=lambda r: (r[4] is not None, r[4] or dt.datetime.min.replace(tzinfo=dt.timezone.utc)), reverse=True)
    for kind, source, title, url, _date in collected[: a.limit]:
        print(f"{kind}\t{source}\t{title}\t{url}")
    for name, reason in failures:
        print(f"SOURCE FAILED\t{name}\t{reason}\t")

    if not a.quiet:  # operational diagnostics only -- stderr, quiet-able
        print(f"[stats] {total} items from {len(FEEDS)} feeds, {failed} failed", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
