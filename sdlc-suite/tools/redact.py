#!/usr/bin/env python3
"""The filter between a private run record and a public pull request.

`distil.py` derives learning candidates from `outcome.json` files produced by
running the suite against whatever repository the adopter actually works in, and
`.github/workflows/distil.yml` opens a pull request against a public one. That
is a data path from a private tree to a public tree with a schedule attached,
and this module is the only thing standing in it. This repository has already
demonstrated the failure it prevents: the private design records removed by
CHG-03 -- a real project name, a real spec path, fifty internal requirement
identifiers -- are exactly what an unredacted learning looks like. That happened
by hand, once. A scheduled job would do it reliably.

Two tiers, with deliberately different consequences
---------------------------------------------------

**Tier 1, the literal denylist** (`redaction/denylist.txt`, one entry per line,
case-insensitive, matched as a substring). A hit DROPS the candidate and counts
a reason. Dropping is right here because these are known-private strings named
by the adopter -- organisations, projects, customers, hosts -- and there is no
benign reason for one to appear in a cross-project heuristic. The file is
instance data, so it is gitignored and `redaction/denylist.example.txt` ships in
its place.

**Tier 2, the compiled regex classes** (`CLASSES` below). Not configurable, and
that is the point: an adopter can add to tier 1 but cannot weaken tier 2 by
editing a file. A hit QUARANTINES the candidate -- it is written to
`learnings/quarantine/`, which is gitignored and never committed -- and the job
then fails. Uncertain is not published, and it is not silently discarded
either, because a dropped signal nobody sees is how a filter comes to be trusted
more than it deserves.

`ticket_id` fires on this repository's own finding ids and on `AC-1`. That is
the correct failure direction -- a false positive costs a human read, a false
negative publishes a customer's ticket number -- and it is exactly why the
outcome is quarantine rather than a drop. Loosen the *consequence* if the noise
becomes unmanageable (batch the review rather than failing every run); never
loosen the pattern.

What is scanned, and what is shape-checked instead
--------------------------------------------------

This boundary is load-bearing, so it is stated rather than left implicit.

*Derived* fields -- `title`, `body`, `check`, and anything else carrying text
that originated in a run record -- are scanned by both tiers.

*Generated* fields -- `id`, `kind`, `confidence`, `firstSeen`, `lastConfirmed`,
`signature`, `appliesTo`, `provenance`, `supersedes` -- are validated against an
allowlist of shapes and never scanned. Scanning them would be self-defeating:
`LRN-0042` matches `ticket_id`, and a run id such as
`20260814T090000Z-independent-review-91bc` matches `high_entropy`, so every
candidate would quarantine forever, which is precisely the pressure to loosen a
pattern that the design forbids. An allowlist on shape is the stronger control
anyway: anything unexpected -- a path traversal in a run id, a `kind` that is
not one of the four -- fails closed with `malformed:<field>`.

Reporting leaks nothing
-----------------------

`mask_summary()` never echoes a match. The distiller runs in GitHub Actions on a
public repository, where the job log is public, so a summary reading
`quarantined: email matched alice@customer.example` would make the redactor
itself the leak. Tier 2 reports class, field and character count. Tier 1 reports
the denylist entry by its *index* in the file -- enough for the human who owns
the list to look it up locally, and nothing to anyone who does not have it.

For the same reason `learnings/quarantine/` must never be uploaded as a workflow
artifact: artifacts on a public repository are publicly downloadable. On a
hosted runner the quarantined content is discarded with the runner and only the
signal survives, which is the intended trade.

Usage:
    python sdlc-suite/tools/redact.py --selftest     # known-positive check
    python sdlc-suite/tools/redact.py --scan FILE    # classify one file

Exit codes (the contract `distil.py` and CI depend on -- do not change silently):
    0  selftest passed, or --scan classified the input as publishable
    1  selftest failed, or --scan quarantined the input
    2  --scan dropped the input on a tier-1 denylist hit
    3  a path given on the command line does not exist
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

REPO_ROOT = Path(__file__).resolve().parents[2]

DENYLIST_REL = Path("redaction") / "denylist.txt"

# Fields whose text originated in a run record. Both tiers scan these.
DERIVED_FIELDS = ("title", "body", "check")

# --------------------------------------------------------------------------
# Tier 2. Compiled in, not configurable.
# --------------------------------------------------------------------------
#
# Flags are per class rather than global, because a global re.IGNORECASE would
# silently destroy two of them: `ticket_id` relies on [A-Z]{2,6} to avoid firing
# on every hyphenated lowercase word, and `high_entropy` relies on a lookahead
# for an uppercase character. Case-folding those does not loosen them slightly;
# it makes them match nearly everything or nothing.
#
# `abs_home_path` and `internal_host` DO fold case -- a strengthening over the
# patterns as first drafted. Windows writes `C:\Users\someone` where a log or a
# shell writes `c:\users\someone`; the class must not depend on which tool
# produced the line. The lowercase fixture in the test suite is what holds that.
#
# Both spellings here use an account name the placeholder allowlist in
# `.gitleaks.toml` excuses. That rule's account-name group includes `.`, so an
# ellipsis would be read as a real username and the secret scan would fire on
# this comment -- caught by simulating the rules over this file before commit.
_CLASS_SOURCES: dict[str, tuple[str, int]] = {
    "abs_home_path": (
        r"(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+|/Users/[^/\s]+|/home/[^/\s]+)",
        re.IGNORECASE,
    ),
    "email": (
        r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
        0,
    ),
    "private_ip": (
        r"\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.?\d{0,3}\b",
        0,
    ),
    "internal_host": (
        r"\b[\w.-]+\.(?:internal|corp|local|lan)\b",
        re.IGNORECASE,
    ),
    # `\d{1,6}`, not `\d{2,6}` as first drafted. The two-digit floor was a
    # measured defect, not a judgement call: the design states that this class
    # "will fire on requirement ids like AC-1", and `AC-1` has one digit, so it
    # did not. A single-digit criterion id -- `AC-1`, `FR-2` -- is exactly the
    # shape most likely to appear in a `notAddressed` reason, which is one of
    # the four things this tool distils.
    #
    # This is a WIDENING, and the rule that patterns are never loosened is
    # intact. The cost is more quarantine: `UTF-8`, `SHA-256` and `ISO-8601`
    # now match too. That is the correct direction -- a false positive costs a
    # human read, a false negative publishes a customer's ticket number -- and
    # if the noise becomes unmanageable, loosen the CONSEQUENCE (batch the
    # review rather than failing every run), never this pattern.
    "ticket_id": (
        r"\b(?:AB#\d+|[A-Z]{2,6}-\d{1,6}\.\d+|[A-Z]{2,6}-\d{1,6})\b",
        0,
    ),
    "high_entropy": (
        r"\b(?=[A-Za-z0-9_-]{24,})(?=[^\s]*[A-Z])(?=[^\s]*[0-9])[A-Za-z0-9_-]{24,}\b",
        0,
    ),
}

CLASSES: dict[str, re.Pattern] = {
    name: re.compile(src, flags) for name, (src, flags) in _CLASS_SOURCES.items()
}

# One known positive per class. `selftest()` asserts each still matches, which is
# what `distil.py` gates on: a redactor that imports cleanly but matches nothing
# is a worse failure than one that fails to import, because it is silent.
SELFTEST_POSITIVES: dict[str, str] = {
    "abs_home_path": r"seen at C:\Users\someone\project",
    "email": "seen from first.last@example.invalid",
    "private_ip": "seen at 10.4.2.19",
    "internal_host": "seen at build.corp",
    "ticket_id": "seen as AB#41207",
    "high_entropy": "seen as aB3xQ7mZ2pR9tL4wS8vN6yH1kJ5cD0fG",
}

SELFTEST_NEGATIVE = (
    "A test harness that stubs a callback as a sink terminates one hop before "
    "anything the consumer does with it."
)

# --------------------------------------------------------------------------
# Generated-field shapes. An allowlist, so anything unexpected fails closed.
# --------------------------------------------------------------------------
#
# The run-id shape mirrors `_state.js`: stamp + "-" + slug(workflow) + "-" +
# shortId(), where stamp is `20260902T141500Z`, slug is lowercased alphanumerics
# and hyphens capped at 40, and shortId is four hex characters. The slug half is
# allowed to be empty because `slug()` can legitimately produce that for a
# workflow name with no alphanumerics.
_SCALAR_SHAPES: dict[str, str] = {
    "id": r"^LRN-\d{4}$",
    "kind": r"^(?:failure-signature|playbook|heuristic|selector-map)$",
    "confidence": r"^(?:observed|corroborated|provisional)$",
    "firstSeen": r"^\d{4}-\d{2}-\d{2}$",
    "lastConfirmed": r"^\d{4}-\d{2}-\d{2}$",
    "signature": r"^[0-9a-f]{16}$",
}

_LIST_SHAPES: dict[str, str] = {
    "appliesTo": r"^[a-z][a-z0-9-]{1,40}$",
    "provenance": r"^\d{8}T\d{6}Z-[a-z0-9-]{0,40}-[0-9a-f]{4}$",
    "supersedes": r"^LRN-\d{4}$",
}

GENERATED_SHAPES: dict[str, re.Pattern] = {
    k: re.compile(v) for k, v in {**_SCALAR_SHAPES, **_LIST_SHAPES}.items()
}


# --------------------------------------------------------------------------
# Verdict
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Reason:
    """Why a candidate was dropped or quarantined.

    Deliberately holds no matched content -- only its length. A Reason ends up
    in a public CI log; if it carried the match, the record of the leak would be
    the leak.
    """

    tier: int
    name: str
    field: str
    length: int
    count: int = 1


@dataclass(frozen=True)
class Verdict:
    outcome: str  # "published" | "dropped" | "quarantined"
    reasons: tuple[Reason, ...] = ()

    @property
    def published(self) -> bool:
        return self.outcome == "published"

    @property
    def dropped(self) -> bool:
        return self.outcome == "dropped"

    @property
    def quarantined(self) -> bool:
        return self.outcome == "quarantined"


def mask_summary(verdict: Verdict) -> str:
    """A one-line summary safe to print into a public job log."""
    if verdict.published:
        return "published (no tier-1 or tier-2 match)"
    parts = []
    for r in verdict.reasons:
        parts.append(
            "tier{t} {n} in {f} ({c}x, {L} chars)".format(
                t=r.tier, n=r.name, f=r.field, c=r.count, L=r.length
            )
        )
    return "{o}: {p}".format(o=verdict.outcome, p="; ".join(parts))


# --------------------------------------------------------------------------
# Tier 1 loading
# --------------------------------------------------------------------------


def load_denylist(root: Path | None = None, path: Path | None = None) -> list[str]:
    """Read the literal denylist. A missing file is empty and LOUD, never fatal.

    Two failure directions, deliberately different. A missing denylist must not
    stop the job -- it is instance data, and it is legitimately absent on a
    hosted runner where the checkout cannot carry a gitignored file. But it must
    not be silent either: tier 1 inert with no signal is how a filter gets
    trusted more than it deserves, so the absence is written to stderr where the
    job log will carry it.

    Blank lines and `#` comments are skipped. A blank entry is skipped
    specifically because the empty string is a substring of every text: one
    stray blank line would otherwise drop the entire corpus and leave a loop
    that looks permanently clean.
    """
    if path is None:
        path = (root or REPO_ROOT) / DENYLIST_REL
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        print(
            "[redact] WARNING no denylist at {p} -- tier 1 is INERT for this run. "
            "Only the compiled regex classes are in force. Copy "
            "redaction/denylist.example.txt to redaction/denylist.txt and fill "
            "it in.".format(p=path),
            file=sys.stderr,
        )
        return []
    except OSError as e:  # unreadable is not the same as absent; say which
        print(
            "[redact] WARNING denylist at {p} could not be read ({e}) -- tier 1 "
            "is INERT for this run.".format(p=path, e=e),
            file=sys.stderr,
        )
        return []

    entries: list[str] = []
    for line in raw.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        entries.append(s)
    return entries


# --------------------------------------------------------------------------
# The filter
# --------------------------------------------------------------------------


def _tier1(text: str, denylist: Sequence[str], field: str) -> list[Reason]:
    lowered = text.lower()
    out: list[Reason] = []
    for i, entry in enumerate(denylist, start=1):
        e = entry.strip().lower()
        if not e:
            continue
        n = lowered.count(e)
        if n:
            # The entry names an adopter's organisation or customer, so the
            # reason records its INDEX, never its value.
            out.append(Reason(tier=1, name="denylist entry #{i}".format(i=i),
                              field=field, length=len(e), count=n))
    return out


def _tier2(text: str, field: str) -> list[Reason]:
    out: list[Reason] = []
    for name, pattern in CLASSES.items():
        found = pattern.findall(text)
        if found:
            longest = max((len(f) if isinstance(f, str) else 0) for f in found)
            out.append(Reason(tier=2, name=name, field=field,
                              length=longest, count=len(found)))
    return out


def redact(text: str, denylist: Sequence[str] = (), field: str = "text") -> Verdict:
    """Classify one blob of derived text.

    Tier 1 is checked first and wins outright. A text carrying both a denylist
    name and a regex match must DROP, not quarantine: quarantine is a holding
    pen a human empties by hand, and a known-private string must never sit in
    one waiting to be rewritten.
    """
    text = "" if text is None else str(text)

    t1 = _tier1(text, denylist, field)
    if t1:
        return Verdict("dropped", tuple(t1))

    t2 = _tier2(text, field)
    if t2:
        return Verdict("quarantined", tuple(t2))

    return Verdict("published", ())


def check_generated(candidate: dict) -> list[Reason]:
    """Validate the distiller's own fields against the shape allowlist.

    Absent is fine -- not every candidate carries `supersedes`. Present and
    unexpected is not: it fails closed as `malformed:<field>`, which
    quarantines. The length recorded is the offending value's length, never the
    value.
    """
    out: list[Reason] = []
    for key, pattern in GENERATED_SHAPES.items():
        if key not in candidate or candidate[key] is None:
            continue
        value = candidate[key]
        values: Iterable
        if key in _LIST_SHAPES:
            if isinstance(value, str):
                # A list field arriving as a bare string is itself a shape
                # violation; treat it as one rather than iterating characters.
                out.append(Reason(tier=2, name="malformed:" + key, field=key,
                                  length=len(value)))
                continue
            values = value
        else:
            values = [value]
        bad = 0
        longest = 0
        for v in values:
            if not isinstance(v, str) or not pattern.match(v):
                bad += 1
                longest = max(longest, len(v) if isinstance(v, str) else 0)
        if bad:
            out.append(Reason(tier=2, name="malformed:" + key, field=key,
                              length=longest, count=bad))
    return out


def redact_candidate(candidate: dict, denylist: Sequence[str] = ()) -> Verdict:
    """Classify a whole candidate: derived text scanned, generated fields shaped.

    This is the only entry point `distil.py` uses. It exists so the
    derived/generated boundary is decided in one place rather than at every call
    site, where it would drift.
    """
    t1: list[Reason] = []
    t2: list[Reason] = []
    for field in DERIVED_FIELDS:
        if field not in candidate or candidate[field] is None:
            continue
        text = str(candidate[field])
        t1.extend(_tier1(text, denylist, field))
        t2.extend(_tier2(text, field))

    # Tier 1 wins outright, before any shape check: a known-private string must
    # not be parked in quarantine because some unrelated field was malformed.
    if t1:
        return Verdict("dropped", tuple(t1))

    t2.extend(check_generated(candidate))
    if t2:
        return Verdict("quarantined", tuple(t2))
    return Verdict("published", ())


# --------------------------------------------------------------------------
# Known-positive self-test
# --------------------------------------------------------------------------


def selftest() -> list[str]:
    """Run one known positive per class plus the negative. Empty list == healthy.

    This is rule 3 of the repository's verification standard turned into code:
    prove a negative against a known positive before trusting a zero result.
    `distil.py` calls it at start-up and refuses to run if it returns anything,
    because the dangerous failure of a filter is not an exception -- it is a
    quiet zero.
    """
    failures: list[str] = []

    for name, fixture in SELFTEST_POSITIVES.items():
        if name not in CLASSES:
            failures.append(
                "class {n} is missing from CLASSES -- its known positive cannot "
                "be checked".format(n=name)
            )
            continue
        v = redact(fixture, field="selftest")
        hit = {r.name for r in v.reasons}
        if name not in hit:
            failures.append(
                "class {n} did not match its known positive (verdict {o}, "
                "matched {h})".format(n=name, o=v.outcome, h=sorted(hit) or "nothing")
            )

    for name in CLASSES:
        if name not in SELFTEST_POSITIVES:
            failures.append(
                "class {n} has no known positive -- add one to SELFTEST_POSITIVES "
                "or the class is unverified".format(n=name)
            )

    v = redact(SELFTEST_NEGATIVE, field="selftest")
    if not v.published:
        failures.append(
            "the clean negative did not publish ({s}) -- the classes have become "
            "so broad that nothing can ever be published".format(s=mask_summary(v))
        )

    v = redact("the example-employer build", denylist=["example-employer"],
               field="selftest")
    if not v.dropped:
        failures.append(
            "tier 1 did not drop its known positive (verdict {o})".format(o=v.outcome)
        )

    return failures


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true",
                    help="check every class against a known positive; exit 1 on failure")
    ap.add_argument("--scan", metavar="FILE",
                    help="classify one file as published / quarantined / dropped")
    ap.add_argument("--root", metavar="PATH", default=None,
                    help="repository root to resolve redaction/denylist.txt from")
    args = ap.parse_args(argv)

    if not args.selftest and not args.scan:
        ap.error("give --selftest or --scan FILE")

    if args.selftest:
        failures = selftest()
        if failures:
            print("[redact] SELFTEST FAILED", file=sys.stderr)
            for f in failures:
                print("  - " + f, file=sys.stderr)
            return 1
        print("[redact] selftest ok: {n} classes, each matched its known "
              "positive; the clean negative published".format(n=len(CLASSES)))
        return 0

    target = Path(args.scan)
    if not target.exists():
        print("[redact] no such file: {p}".format(p=target), file=sys.stderr)
        return 3
    root = Path(args.root).resolve() if args.root else REPO_ROOT
    verdict = redact(target.read_text(encoding="utf-8", errors="replace"),
                     denylist=load_denylist(root=root), field=str(target))
    print(mask_summary(verdict))
    if verdict.dropped:
        return 2
    if verdict.quarantined:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
