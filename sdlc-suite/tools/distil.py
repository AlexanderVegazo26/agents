#!/usr/bin/env python3
"""Propose learning candidates from run outcomes, without being asked.

The repository's stated highest-value artifact is outcome tracking on
hypotheses -- did the architectural bet hold, did the "low severity" call turn
out to matter -- and until `_state.js` there was no path at all from run N to
run N+1. Every input a distiller needs already existed in memory at `return`
time and was thrown away. This reads what `_state.js` now persists and proposes,
never decides.

    python sdlc-suite/tools/distil.py                  # dry run, writes nothing
    python sdlc-suite/tools/distil.py --emit           # write candidates
    python sdlc-suite/tools/distil.py --stamp          # recurrence -> lastConfirmed
    python sdlc-suite/tools/distil.py --retire         # 180-day sweep to retired/

Conservative in three specific ways
-----------------------------------

**Zero candidates is the normal outcome and exits 0.** A distiller that always
produces something will produce noise, the pull requests become unreadable, they
get rubber-stamped, and the human gate turns decorative. Silence is a result.

**The floor is two DISTINCT RUNS, not two occurrences.** One noisy run repeating
the same reason three times is an echo, not a signal, and it emits nothing. This
is the single most important line in the file.

**It never edits an existing learning** in `--emit` mode, and writes only to
`learnings/candidates/` (plus `learnings/quarantine/`, which is gitignored and
where the redactor puts anything uncertain). A recurrence does not rewrite a
learning's text; a contradiction arrives as a separate new candidate, leaving
the judgment to the reviewer.

`supersedes` is emitted so the file matches the published contract, and is
**always empty** -- this tool never populates it. Deciding that one candidate
replaces a specific existing learning means reading two pieces of prose and
judging that they conflict, which a signature comparison cannot do. What the
tool does instead is make a contradiction *visible*: the refutation signature
includes the verdict, so "the same lens, the same reasoning, the opposite
conclusion" is a distinct signature. It never stamps the learning it
contradicts, and it lands as a second candidate beside the first for a human to
link or close.

Reconciling two lines of the design that pull against each other
----------------------------------------------------------------

The design says both "it never edits an existing learning; a recurrence updates
only `lastConfirmed`" and "it writes to `learnings/candidates/` only". Taken
together those cannot both hold, and dropping the stamp is not a free choice:
decay is specified as "by recurrence, not calendar", so without the stamp every
learning retires at 180 days whether or not it is still true, and the decay
property is inert.

Resolved by separating the two into modes rather than by picking a winner.
`--emit` -- what `distil.yml` runs -- writes only to `learnings/candidates/`.
The `lastConfirmed` stamp is `--stamp`, a distinct mode that `distil.yml` never
invokes; `decay.yml` runs it immediately before the retirement sweep, so the
only edit ever made to an existing learning is a date on one line, in the
retirement pull request, where a reviewer is already reading that file.

A contract extension, named as one
----------------------------------

Phase 3's contract 5 has no field linking a learning back to the signature that
produced it, so neither recurrence nor `supersedes` can be computed from a
learning file as specified. This tool adds `signature:` -- a 16-hex-character
digest of the normalised signature key -- to the front matter, after
`lastConfirmed`. It is an addition to the published contract and should be
recorded as one. It leaks nothing: a digest only ever appears on a candidate
whose source text already passed redaction and is being published anyway.

What it reads, and why that is three files and not one
------------------------------------------------------

`outcome.json` is the primary source, exactly as specified. Two of the four
signatures cannot be computed from it alone, so the two siblings in the same run
directory are read as well -- this is stated rather than left to be discovered:

* `outcome.failures` is aggregated to `{class, count}` by `_state.js:close()`
  and carries no phase, so "the same failure class in the same PHASE" needs
  `failures.jsonl`, whose records carry `phase` (`_failure.js:191`). A run whose
  outcome reports failures but whose `failures.jsonl` is unreadable is counted
  and reported as a gap, never silently treated as clean.
* `notAddressed` is a build-manifest field (`_brief.js:69`) and lives in
  `phase-*.json` under `agents[].result`, not in `outcome.json` at all.

Everything read is the agents' own findings and reasoning. That is what keeps
the redaction surface small -- but small is not zero, which is why nothing is
written before `redact.py` has classified it.

Exit codes (the contract `distil.yml` and `decay.yml` depend on):
    0  ok -- candidates written, or none met the floor
    1  at least one candidate was QUARANTINED; a human must read it
    2  at least one candidate was DROPPED on a tier-1 denylist hit
    3  the redactor is unavailable or failed its self-test -- nothing ran
    4  usage or environment error

Codes 2 and 3 outrank 1. The design table says only a non-empty quarantine fails
the job, but the mandated end-to-end assertion is that a seeded denylist string
produces a non-zero exit, and a tier-1 hit is the stronger signal of the two: a
string the adopter has declared private reached a candidate at all. Both are
non-zero; the distinct codes let the workflow say which happened.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(Path(__file__).resolve().parent))

# The refusal, at the top, before anything can be written.
#
# "Rollback is removing the redact() call, which also means CHG-25 must not be
# enabled without it; make the distiller refuse to run when the redactor is
# missing rather than degrading to no filtering." Degrading to no filtering is
# the one behaviour this tool must never have, so the import failure is fatal
# and it is fatal here rather than at the first write, where a partially
# completed run would already have produced files.
try:
    import redact as _redact
except Exception as _e:  # noqa: BLE001 -- any import failure is equally fatal
    print(
        "[distil] REFUSING TO RUN: the redactor could not be imported ({e}).\n"
        "         Every candidate is derived from a private repository's run "
        "records; without redact.py there is no filter between them and a "
        "public pull request.".format(e=_e),
        file=sys.stderr,
    )
    raise SystemExit(3)


EXIT_OK = 0
EXIT_QUARANTINED = 1
EXIT_DROPPED = 2
EXIT_NO_REDACTOR = 3
EXIT_USAGE = 4

RUNS_REL = Path(".claude") / "runs"
LEARNINGS_REL = Path("learnings")
MARKER_NAME = ".last-distil"

MAX_CANDIDATES_PER_RUN = 10
DEFAULT_RETIRE_DAYS = 180

# Derived text is capped, and the cap is announced in the text. Enforcing it
# silently would be the same defect as a silent budget truncation one layer
# down: a 200 KB reason would have 198 KB dropped and nothing would say so.
BODY_CAP = 2000
TITLE_CAP = 90

# `byLens` keys as the contract actually names them, mapped to the agent that
# owns the lens. Only the four in the published contract are listed: inventing
# mappings for lenses no workflow emits would put agent names into learnings
# derived from nothing, and the fall-through is already correct. An unmapped
# lens falls through to its own name, which the redactor's shape allowlist then
# accepts or rejects -- unknown input fails closed rather than being guessed at.
LENS_TO_AGENT = {
    "review": "code-reviewer",
    "qa": "qa-engineer",
    "security": "security-engineer",
    "performance": "performance-engineer",
}


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def norm(s) -> str:
    """Lowercase and collapse whitespace. Exact match after that, and no more.

    Deliberately not fuzzy. Merging two nearly-identical reasons is how two
    different findings become one piece of false doctrine, and the reviewer
    reading the pull request has no way to notice it happened.
    """
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def clamp(s: str, n: int) -> str:
    s = str(s or "")
    if len(s) <= n:
        return s
    return s[: n - 1].rstrip() + "…"


def sig_hash(kind: str, *parts: str) -> str:
    h = hashlib.sha256()
    h.update(kind.encode("utf-8"))
    for p in parts:
        h.update(b"\x00")
        h.update(str(p).encode("utf-8"))
    return h.hexdigest()[:16]


def iso_date(s) -> str:
    """`2026-09-02` from an ISO timestamp, or an empty string."""
    m = re.match(r"(\d{4}-\d{2}-\d{2})", str(s or ""))
    return m.group(1) if m else ""


def parse_iso(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


# --------------------------------------------------------------------------
# Reading the run store
# --------------------------------------------------------------------------


class Gap:
    """A run that could not be fully read. Reported, never silently skipped."""

    def __init__(self):
        self.unreadable_outcome = []
        self.missing_outcome = []
        self.failures_without_phase = []


def read_runs(root: Path, since: datetime | None, gaps: Gap) -> list[dict]:
    """Every run directory whose outcome is newer than `since`.

    A run with no `outcome.json` is a gap the distiller reports, never an error
    that loses the run -- `_state.js` writes the file in a `finally`, so its
    absence means the process died before `close()`, which is itself worth
    seeing in the log.
    """
    runs_root = root / RUNS_REL
    out = []
    if not runs_root.is_dir():
        return out
    # The same run-directory controls as _learnings.js and improve.py (security
    # IM5): the recorder's run-id shape, no symlinked directory, and a size cap.
    # Anything else under .claude/runs is not a run the recorder wrote.
    run_id = re.compile(r"\d{8}T\d{6}Z-[a-z0-9-]{1,40}-[0-9a-f]{4}")
    for d in sorted(p for p in runs_root.iterdir()
                    if p.is_dir() and not p.is_symlink() and run_id.fullmatch(p.name)):
        f = d / "outcome.json"
        if f.is_file() and f.stat().st_size > 1024 * 1024:
            gaps.unreadable_outcome.append("{n}: outcome.json exceeds 1 MB".format(n=d.name))
            continue
        if not f.is_file():
            gaps.missing_outcome.append(d.name)
            continue
        try:
            outcome = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            gaps.unreadable_outcome.append("{n}: {e}".format(n=d.name, e=e))
            continue
        if not isinstance(outcome, dict):
            gaps.unreadable_outcome.append("{n}: not a JSON object".format(n=d.name))
            continue
        ended = parse_iso(outcome.get("endedAt")) or datetime.fromtimestamp(
            f.stat().st_mtime, tz=timezone.utc
        )
        if since is not None and ended <= since:
            continue
        outcome["_dir"] = d
        outcome["_endedAt"] = ended
        out.append(outcome)
    return out


def read_failure_records(run_dir: Path) -> list[dict]:
    """`failures.jsonl` -- append-only, one JSON object per line.

    A malformed line is skipped rather than failing the run, matching
    `_state.js.readFailures()`. The file is written by the same recorder that
    tolerates its own write failures, so a truncated last line is expected.
    """
    f = run_dir / "failures.jsonl"
    out = []
    try:
        text = f.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def read_not_addressed(run_dir: Path) -> list[dict]:
    """`notAddressed` entries out of the phase artifacts.

    They are a build-manifest field, so they live under
    `phase-<n>-<title>.json` -> `agents[].result.notAddressed`, never in
    `outcome.json`.
    """
    out = []
    for f in sorted(run_dir.glob("phase-*.json")):
        try:
            payload = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        for agent in payload.get("agents") or []:
            if not isinstance(agent, dict):
                continue
            result = agent.get("result")
            if not isinstance(result, dict):
                continue
            for item in result.get("notAddressed") or []:
                if isinstance(item, dict) and item.get("id") and item.get("why"):
                    out.append(
                        {
                            "id": str(item["id"]),
                            "why": str(item["why"]),
                            "agentType": agent.get("agentType"),
                        }
                    )
    return out


# --------------------------------------------------------------------------
# Signatures
# --------------------------------------------------------------------------


class Group:
    """One signature and every occurrence of it, across runs."""

    def __init__(self, sigtype: str, key: tuple, kind: str):
        self.sigtype = sigtype
        self.key = key
        self.kind = kind
        self.runs: dict[str, dict] = {}
        self.samples: list[dict] = []

    @property
    def distinct_runs(self) -> int:
        return len(self.runs)

    @property
    def signature(self) -> str:
        return sig_hash(self.sigtype, *self.key)

    def add(self, run: dict, sample: dict):
        rid = str(run.get("runId") or run["_dir"].name)
        self.runs.setdefault(rid, run)
        self.samples.append(sample)


def collect(runs: list[dict], gaps: Gap) -> dict[str, Group]:
    groups: dict[str, Group] = {}

    def group(sigtype, key, kind) -> Group:
        g = Group(sigtype, key, kind)
        return groups.setdefault(g.signature, g)

    for run in runs:
        run_dir = run["_dir"]

        # 1. the same finding refuted with the same reasoning -> heuristic
        for r in run.get("refutations") or []:
            if not isinstance(r, dict):
                continue
            why = norm(r.get("why"))
            if not why:
                continue
            lens = norm(r.get("lens")) or "unspecified"
            # The verdict IS part of the key, and that is the load-bearing
            # choice here. Leaving it out looks like it surfaces contradictions
            # -- same lens, same reasoning, opposite conclusion -- but it does
            # the reverse: the contradicting evidence hashes to the signature of
            # the learning it contradicts, so it is counted as a recurrence and
            # `--stamp` moves that learning's `lastConfirmed` FORWARD on the
            # strength of evidence against it. With the verdict in the key, the
            # two are distinct signatures, the old learning is never stamped by
            # the new evidence, and the reviewer sees a second candidate beside
            # the first and decides.
            verdict = "refuted" if r.get("refuted", True) else "confirmed"
            g = group("refutation", (lens, verdict, why), "heuristic")
            g.add(run, {
                "lens": lens,
                "why": str(r.get("why")),
                "summary": str(r.get("summary") or ""),
                "severity": str(r.get("severity") or ""),
                "verdict": verdict,
            })

        # 2. the same failure class in the same phase -> failure-signature
        records = read_failure_records(run_dir)
        phased = [r for r in records if r.get("phase") and r.get("class")]
        if (run.get("failures") or []) and not phased:
            # The outcome says failures happened but nothing carries a phase.
            # That is a gap in the record, not a clean run.
            gaps.failures_without_phase.append(str(run.get("runId") or run_dir.name))
        seen_in_run = set()
        for rec in phased:
            # Named `phase_class` rather than the obvious short name, which is
            # one of gitleaks' generic-api-key keywords. That rule matches any
            # identifier ENDING in that word, followed by a delimiter and a
            # ten-character value -- which the literal on the next line is. It
            # sat close enough to the rule's entropy threshold to be worth not
            # finding out on a public repository's first scheduled run. Naming
            # the word here would re-create the match, so this comment does not.
            phase_class = (norm(rec["phase"]), norm(rec["class"]))
            if phase_class in seen_in_run:
                continue
            seen_in_run.add(phase_class)
            g = group("failure-class-phase", phase_class, "failure-signature")
            g.add(run, {
                "phase": str(rec["phase"]),
                "class": str(rec["class"]),
                "strategyNext": str(rec.get("strategyNext") or ""),
                "agentType": rec.get("agentType"),
            })

        # 3. the same gate blocked with the same prepared shape -> playbook
        for b in run.get("blockedGates") or []:
            if not isinstance(b, dict):
                continue
            gate = norm(b.get("gate"))
            if not gate:
                continue
            g = group("blocked-gate", (gate, norm(b.get("prepared"))), "playbook")
            g.add(run, {
                "gate": str(b.get("gate")),
                "prepared": str(b.get("prepared") or ""),
                "unblocks": str(b.get("unblocks") or ""),
                "actionWithheld": str(b.get("actionWithheld") or ""),
            })

        # 4. a criterion not addressed for the same stated reason -> heuristic
        for na in read_not_addressed(run_dir):
            why = norm(na["why"])
            if not why:
                continue
            # Keyed on the REASON alone. A criterion id is run-local --
            # product-analyst numbers each run's criteria afresh, so "AC-2" in
            # two runs names two unrelated things, and keying on it both split
            # real recurrences and put an AC-n string into every candidate,
            # which the redactor's ticket-id class then quarantined.
            g = group("not-addressed", (why,), "heuristic")
            g.add(run, {"id": na["id"], "why": na["why"],
                        "agentType": na.get("agentType")})

    return groups


# --------------------------------------------------------------------------
# Rendering a candidate
# --------------------------------------------------------------------------


def _agents_for(g: Group) -> list[str]:
    names: list[str] = []
    if g.sigtype == "refutation":
        lens = g.samples[0]["lens"]
        names = [LENS_TO_AGENT.get(lens, lens)]
    elif g.sigtype == "failure-class-phase":
        names = sorted({s["agentType"] for s in g.samples if s.get("agentType")})
        names = names or ["orchestrator"]
    elif g.sigtype == "blocked-gate":
        names = ["orchestrator", "release-manager"]
    elif g.sigtype == "not-addressed":
        names = sorted({s["agentType"] for s in g.samples if s.get("agentType")})
        names = names or ["product-analyst", "software-engineer"]
    # Whatever survives here is shape-checked by the redactor, so an unexpected
    # value fails closed into quarantine rather than being written.
    return list(dict.fromkeys(str(n) for n in names if n))


def _title_body_check(g: Group) -> tuple[str, str, str]:
    s = g.samples[0]
    n = g.distinct_runs
    if g.sigtype == "refutation":
        # Every sample in this group shares a verdict -- it is part of the key.
        word = s["verdict"]
        title = clamp("A {l} finding is repeatedly {w} - {why}".format(
            l=s["lens"], w=word, why=s["why"]), TITLE_CAP)
        body = (
            "Across {n} distinct runs the {l} lens reached the same conclusion "
            "for the same stated reason:\n\n> {why}\n\n"
            "A reason that recurs is either a real property of the codebase or a "
            "reliable false positive from the lens. Either way the reasoning is "
            "the useful part, not the verdict."
        ).format(n=n, l=s["lens"], why=clamp(s["why"], BODY_CAP))
        # Worded to make the agent look HARDER. The previous text -- "Before
        # raising this class of finding again, check whether the reason above
        # already applies" -- read as a reason to raise fewer findings, the one
        # thing learnings/README.md says a learning must never do. The template
        # test in test_distil.py fails on that wording.
        check = ("When this class of finding comes up again, test it against the "
                 "reason above using evidence from the change in front of you, and "
                 "state explicitly whether that reason holds here and why.")
    elif g.sigtype == "failure-class-phase":
        title = clamp("{c} failures recur in the {p} phase".format(
            c=s["class"], p=s["phase"]), TITLE_CAP)
        body = (
            "The {c} failure class has been recorded in the {p} phase in {n} "
            "distinct runs. Recurrence across runs points at an environmental or "
            "prompt defect rather than bad luck; the retry policy for this class "
            "is `{sn}`."
        ).format(c=s["class"], p=s["phase"], n=n, sn=clamp(s["strategyNext"], 200))
        check = ("When this phase fails this way again, check the environment "
                 "before re-running -- the same retry has already been tried.")
    elif g.sigtype == "blocked-gate":
        title = clamp("The {g} gate is blocked on every run".format(
            g=s["gate"]), TITLE_CAP)
        body = (
            "`{g}` has been recorded as a blocked gate in {n} distinct runs with "
            "the same prepared work each time:\n\n> {p}\n\n"
            "A gate that is always hit is either mis-set for this repository or "
            "needs a standing procedure. Deciding which is a human's call; this "
            "file only records that it keeps happening. Unblocking it: {u}"
        ).format(g=s["gate"], n=n, p=clamp(s["prepared"], BODY_CAP),
                 u=clamp(s["unblocks"], 300))
        check = ("Before starting work that will hit this gate, prepare the "
                 "action and record it as blocked rather than stopping the run.")
    else:  # not-addressed
        title = clamp("A criterion is repeatedly deferred: {why}".format(
            why=s["why"]), TITLE_CAP)
        body = (
            "A criterion has been reported in `notAddressed` in {n} "
            "distinct runs for the same stated reason:\n\n> {why}\n\n"
            "A scope boundary that keeps being rediscovered mid-build is worth "
            "naming in the requirements up front."
        ).format(i=s["id"], n=n, why=clamp(s["why"], BODY_CAP))
        check = ("When scoping work that touches this criterion, state the "
                 "boundary in the requirements rather than discovering it at build time.")
    return title, body, check


def build_candidate(g: Group, lrn_id: str, supersedes: list[str]) -> dict:
    dates = sorted(iso_date(r.get("startedAt") or r.get("endedAt"))
                   for r in g.runs.values())
    dates = [d for d in dates if d]
    title, body, check = _title_body_check(g)
    # Whitespace collapsed before anything else sees it: a newline in derived
    # prose would end the `title:` line and turn the rest of the front matter
    # into body text.
    title = re.sub(r"\s+", " ", title).strip()
    return {
        "id": lrn_id,
        "title": title,
        "kind": g.kind,
        # Two runs is `observed`, not `corroborated` -- the pull-request
        # checklist asks a reviewer to check exactly this, so the threshold is
        # here in one place rather than left to a judgement call per candidate.
        "confidence": "corroborated" if g.distinct_runs >= 4 else "observed",
        "appliesTo": _agents_for(g),
        "firstSeen": dates[0] if dates else "",
        "lastConfirmed": dates[-1] if dates else "",
        "signature": g.signature,
        "provenance": sorted(g.runs.keys()),
        "supersedes": supersedes,
        "body": body,
        "check": check,
    }


def yaml_dq(s: str) -> str:
    """A double-quoted YAML scalar.

    The title is derived from an agent's prose, so it routinely contains a
    colon-space -- `A review finding is repeatedly refuted: the guard ...` --
    and a plain YAML scalar cannot. Emitted unquoted, every such candidate is a
    file that `yaml.safe_load` rejects with "mapping values are not allowed
    here", which nothing in this repository would have caught: the front-matter
    reader here is a line regex and tolerates it happily. Newlines are collapsed
    for the same reason, one layer up in `build_candidate`.
    """
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def render(c: dict) -> str:
    lines = ["---"]
    lines.append("id: " + c["id"])
    lines.append("title: " + yaml_dq(c["title"]))
    lines.append("kind: " + c["kind"])
    lines.append("appliesTo: [" + ", ".join(c["appliesTo"]) + "]")
    lines.append("confidence: " + c["confidence"])
    lines.append("firstSeen: " + c["firstSeen"])
    lines.append("lastConfirmed: " + c["lastConfirmed"])
    lines.append("signature: " + c["signature"])
    lines.append("provenance:")
    for r in c["provenance"]:
        lines.append("  - run: " + r)
    lines.append("supersedes: [" + ", ".join(c["supersedes"]) + "]")
    lines.append("---")
    lines.append("")
    lines.append(c["body"])
    lines.append("")
    lines.append("**Check:** " + c["check"])
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Existing learnings
# --------------------------------------------------------------------------

_FM_SCALAR = re.compile(r"^([A-Za-z][A-Za-z0-9_]*):[ \t]*(.*)$")


def read_frontmatter(path: Path) -> dict:
    """The handful of scalar fields this tool needs. No YAML dependency.

    This repository has no `requirements.txt` and therefore no dependency floor,
    so adding PyYAML to read six known keys would impose one on every adopter.
    Anything not understood is ignored rather than guessed at.
    """
    out: dict = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    if not text.startswith("---"):
        return out
    lines = text.splitlines()
    for line in lines[1:]:
        if line.strip() == "---":
            break
        m = _FM_SCALAR.match(line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def existing_learnings(root: Path) -> list[tuple[Path, dict]]:
    """Committed learnings only: `learnings/*.md`, not the sub-directories.

    Known limitation, stated rather than hidden: `candidates/` is excluded, so a
    signature already sitting in an UNMERGED candidate is proposed again under a
    fresh id when newer runs make it recur. The reviewer then sees two files
    describing one thing. Including `candidates/` would trade that for a worse
    failure -- a candidate rejected by a reviewer and deleted would be silently
    suppressed on every later run, and the signal would disappear with no record
    of the decision. Duplicates are visible; suppression is not.
    """
    d = root / LEARNINGS_REL
    if not d.is_dir():
        return []
    return [(p, read_frontmatter(p))
            for p in sorted(d.glob("*.md"))
            if p.name.lower() != "readme.md"]


def next_id(root: Path) -> int:
    """One past the highest LRN id anywhere under `learnings/`.

    Includes `candidates/` and `retired/` deliberately: an id that has been
    proposed but not yet merged, or retired, must never be handed out again, or
    `supersedes` would point at two different things.
    """
    highest = 0
    d = root / LEARNINGS_REL
    if d.is_dir():
        for p in d.rglob("*.md"):
            fm = read_frontmatter(p)
            m = re.match(r"^LRN-(\d{4})$", str(fm.get("id", "")))
            if m:
                highest = max(highest, int(m.group(1)))
    return highest + 1


# --------------------------------------------------------------------------
# Writing, with a containment guard
# --------------------------------------------------------------------------


def safe_write(root: Path, target: Path, text: str) -> None:
    """Write only inside `learnings/`. Defence in depth behind the shape check.

    Candidate ids are already shape-validated by the redactor, so this cannot
    fire today. It is here because the thing on the other side of a path
    traversal is a scheduled job with `contents: write`, and a control whose
    only guard is "the input is well formed" is one refactor away from not
    having one.
    """
    base = (root / LEARNINGS_REL).resolve()
    resolved = target.resolve()
    if base != resolved and base not in resolved.parents:
        raise RuntimeError(
            "refusing to write outside learnings/: {t}".format(t=resolved)
        )
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(text, encoding="utf-8", newline="\n")


# --------------------------------------------------------------------------
# Modes
# --------------------------------------------------------------------------


def read_marker(marker: Path):
    """`(since, deferred_signatures)` out of `.last-distil`.

    Line 1 is the ISO timestamp the marker always held; any later line reading
    `deferred <signature>` names a signature that qualified but was cut by the
    per-run cap. A marker from before deferrals existed is just line 1.
    """
    if not marker.is_file():
        return None, set(), 0
    lines = marker.read_text(encoding="utf-8").splitlines()
    since = parse_iso(lines[0].strip()) if lines else None
    deferred = {ln.split(None, 1)[1].strip() for ln in lines[1:]
                if ln.startswith("deferred ") and len(ln.split(None, 1)) == 2}
    # The highest LRN number ever handed out. A candidate a reviewer rejects is
    # deleted, and with it the only record that its id was used; without this
    # line the next run re-issued the id for a different signature.
    issued = 0
    for ln in lines[1:]:
        m = re.match(r"^issued LRN-(\d+)$", ln.strip())
        if m:
            issued = max(issued, int(m.group(1)))
    return since, deferred, issued


def pending_candidate_signatures(root: Path) -> set:
    """Signatures already sitting in `candidates/`, awaiting a reviewer.

    Only files that are present NOW. A candidate a reviewer rejected and deleted
    is absent, so it is not suppressed forever -- it comes back only when new
    runs bring new evidence for it, which is the behaviour the reviewer needs.
    """
    d = root / LEARNINGS_REL / "candidates"
    if not d.is_dir():
        return set()
    return {read_frontmatter(p).get("signature") for p in d.glob("*.md")} - {None}


def do_distil(root: Path, emit: bool, denylist, out) -> int:
    marker = root / LEARNINGS_REL / MARKER_NAME
    since, deferred_before, issued_before = read_marker(marker)

    # The WHOLE store is grouped; the marker only decides what is new. Filtering
    # by the marker before grouping -- what this did until 2026-09-24 -- meant a
    # signature seen in run 1 and again in run 2 was grouped from run 2 alone,
    # so "0 of 1 met the 2-distinct-run floor" on exactly the recurrence the
    # floor exists to detect. Run per-run, as the loop intends, distil could
    # therefore never emit anything. Measured, not inferred.
    gaps = Gap()
    runs = read_runs(root, None, gaps)
    groups = collect(runs, gaps)

    known = {fm.get("signature"): fm.get("id")
             for _, fm in existing_learnings(root) if fm.get("signature")}
    pending = pending_candidate_signatures(root)

    def is_new(g: Group) -> bool:
        # New evidence since the last emit, or left unresolved (deferred, quarantined, dropped) by it.
        if g.signature in deferred_before:
            return True
        return since is None or any(r["_endedAt"] > since for r in g.runs.values())

    # Ratified signatures are removed BEFORE the cap. Grouping the whole store
    # makes a ratified learning that keeps recurring the highest-count group, so
    # left in, ten of them filled every slot as a no-op "recurrence" and a new
    # signature was deferred on every run -- measured, a regression on HEAD.
    recurring_known = [g for g in groups.values()
                       if g.distinct_runs >= 2 and g.signature in known]
    qualifying = [g for g in groups.values()
                  if g.distinct_runs >= 2 and g.signature not in known
                  and g.signature not in pending and is_new(g)]

    # Deterministic order: strongest signal first, then a stable tiebreak, so
    # the same store produces the same ten candidates and the same ids on every
    # run. A cap applied to an unstable order would silently rotate which
    # signals ever get seen.
    qualifying.sort(key=lambda g: (-g.distinct_runs, g.sigtype, g.key))

    # "Seen in only one run" means exactly that -- not "pending" or "no new
    # evidence", which the old subtraction also counted and then mislabelled.
    below_floor = sum(1 for g in groups.values() if g.distinct_runs < 2)
    selected = qualifying[:MAX_CANDIDATES_PER_RUN]
    deferred = qualifying[MAX_CANDIDATES_PER_RUN:]

    counts = defaultdict(int)
    counts["recurrence"] = len(recurring_known)
    written = []
    quarantined = []
    unresolved = []          # quarantined or dropped: reconsidered next run
    dropped_reasons = []
    seq = max(next_id(root), issued_before + 1)

    for g in selected:

        # `supersedes` is always empty. Computing it would mean deciding that
        # one candidate replaces a specific existing learning, and nothing here
        # can tell "contradicts" from "is about something adjacent" -- that is a
        # reading of two pieces of prose, which is the reviewer's job and not a
        # hash comparison's. A contradiction therefore arrives as a SEPARATE
        # candidate, distinguishable because the verdict is part of the
        # signature; the reviewer sees both files and links or closes them by
        # hand. The field is emitted so the format matches the published
        # contract, not because this tool populates it.
        supersedes: list[str] = []

        lrn_id = "LRN-{n:04d}".format(n=seq)
        cand = build_candidate(g, lrn_id, supersedes)
        verdict = _redact.redact_candidate(cand, denylist=denylist)

        if verdict.dropped:
            counts["dropped"] += 1
            unresolved.append(g)
            dropped_reasons.append(_redact.mask_summary(verdict))
            # Nothing is written. Not even to quarantine: a string the adopter
            # has declared private must not sit in a holding pen.
            continue
        if verdict.quarantined:
            counts["quarantined"] += 1
            unresolved.append(g)
            # The quarantined file carries this id, so the id is used: the next
            # published candidate must not be handed the same one.
            seq += 1
            quarantined.append((g.signature, _redact.mask_summary(verdict)))
            if emit:
                # Named by digest, never by title: a quarantine filename built
                # from derived text would put the unredacted string in
                # `git status` and in any directory listing pasted into a log.
                safe_write(root,
                           root / LEARNINGS_REL / "quarantine" / (g.signature + ".md"),
                           render(cand))
            continue

        counts["published"] += 1
        seq += 1
        written.append(cand)
        if emit:
            safe_write(root,
                       root / LEARNINGS_REL / "candidates" / (lrn_id + ".md"),
                       render(cand))

    # ---- report -----------------------------------------------------------
    new_runs = sum(1 for r in runs if since is None or r["_endedAt"] > since)
    print("read {r} outcome(s), {n} new since {s}; {q} of {t} signature(s) met the "
          "2-distinct-run floor with new evidence; {c} candidate(s)".format(
              r=len(runs), n=new_runs, s=(since.isoformat() if since else "the beginning"),
              q=len(qualifying), t=len(groups), c=counts["published"]), file=out)
    if pending & {g.signature for g in groups.values()}:
        print("  {n} signature(s) already have a candidate awaiting review in "
              "candidates/ -- not proposed twice".format(
                  n=len(pending & {g.signature for g in groups.values()})), file=out)
    if below_floor:
        print("  {n} signature(s) seen in only one run -- the floor is distinct "
              "runs, not occurrences".format(n=below_floor), file=out)
    if counts["recurrence"]:
        print("  {n} signature(s) already have a learning; --stamp updates "
              "lastConfirmed, --emit never edits one".format(
                  n=counts["recurrence"]), file=out)
    if deferred:
        # A silent cap reads as "covered everything".
        print("  DEFERRED {n} candidate(s) over the per-run cap of {c}; they "
              "remain in the store and will be reconsidered on the next run "
              "(the marker only advances past outcomes already read)".format(
                  n=len(deferred), c=MAX_CANDIDATES_PER_RUN), file=out)
    for name, ident in (("missing outcome.json", gaps.missing_outcome),
                        ("unreadable outcome.json", gaps.unreadable_outcome),
                        ("failures recorded with no phase", gaps.failures_without_phase)):
        if ident:
            print("  GAP {n}: {k} run(s) -- {v}".format(
                n=name, k=len(ident), v=", ".join(ident[:5])), file=out)
    for sig, summary in quarantined:
        print("  QUARANTINED {s}: {m}".format(s=sig, m=summary), file=out)
    for summary in dropped_reasons:
        print("  DROPPED {m}".format(m=summary), file=out)
    if not emit:
        print("  (dry run -- nothing written; pass --emit to write)", file=out)

    code = EXIT_OK
    if counts["quarantined"]:
        code = EXIT_QUARANTINED
    if counts["dropped"]:
        code = EXIT_DROPPED

    # The marker advances on EVERY emit, and carries forward by signature
    # whatever is still unresolved -- deferred by the cap, quarantined, or
    # dropped -- so each is reconsidered (and re-quarantined, and fails the job
    # again) on every run until a human acts, without holding everything else
    # back. The old rule, "advance only on a clean emit", achieved the first
    # half by never advancing at all: the redactor quarantines the suite's own
    # AC-n criterion ids, so a realistic store almost never exited 0, and every
    # candidate a reviewer rejected came back on the next run under a re-used id.
    # `issued` records the id high-water mark for the same reason.
    if emit:
        carried = list(dict.fromkeys(g.signature for g in [*deferred, *unresolved]))
        safe_write(root, marker,
                   datetime.now(timezone.utc).isoformat().replace("+00:00", "Z") + "\n"
                   + "".join("deferred {s}\n".format(s=s) for s in carried)
                   + "issued LRN-{n:04d}\n".format(n=seq - 1))

    return code


def do_stamp(root: Path, emit: bool, out) -> int:
    """Recurrence -> `lastConfirmed`. The only edit ever made to a learning.

    Reads the whole store rather than the window after `.last-distil`, so it is
    idempotent and independent of whatever `--emit` last did. It rewrites
    exactly one line of one file and nothing else.
    """
    gaps = Gap()
    runs = read_runs(root, None, gaps)
    groups = collect(runs, gaps)
    recurring = {g.signature: g for g in groups.values() if g.distinct_runs >= 2}
    by_sig = {g.signature: g for g in groups.values()}

    # EXPOSURE: which runs actually handed each learning to an agent. Before
    # runs recorded `learningsLoaded`, decay could only count recurrence -- so a
    # learning that WORKED (its signature stopped appearing) retired at 180
    # days, and one that was IGNORED (its signature kept appearing) was
    # re-confirmed forever.
    #
    # The judgement is a RATE comparison, within the workflows the signature
    # occurs in: how often the signature appears in runs where the learning
    # was loaded, against runs where it was not. "Not seen in an exposed run"
    # alone is not effectiveness -- most runs never exercise a given failure
    # class, so that rule kept every loaded learning alive forever (code review).
    today = datetime.now(timezone.utc).date().isoformat()
    run_info = {}                        # runId -> (date, workflow)
    exposed = defaultdict(set)           # learning id -> {runId}
    for r in runs:
        rid = str(r.get("runId") or r["_dir"].name)
        date = iso_date(r.get("endedAt") or r.get("startedAt"))
        # A date in the future is not evidence of anything; security review
        # showed a planted `9999-12-31` pinning a learning alive for good.
        if date and date > today:
            date = ""
        run_info[rid] = (date, str(r.get("workflow") or ""))
        for x in r.get("learningsLoaded") or []:
            if isinstance(x, dict):
                for i in x.get("ids") or []:
                    exposed[str(i)].add(rid)

    def rate(ids, sig_runs):
        return (len(ids & sig_runs) / len(ids)) if ids else None

    changed = 0
    for path, fm in existing_learnings(root):
        sig = fm.get("signature")
        g = recurring.get(sig)
        sig_runs = set(by_sig[sig].runs) if sig in by_sig else set()
        workflows = {run_info[r][1] for r in sig_runs if r in run_info}
        relevant = {rid for rid, (_, wf) in run_info.items() if wf in workflows}
        exp = exposed.get(fm.get("id"), set()) & relevant
        # The baseline excludes the learning's FOUNDING runs (its provenance):
        # it exists only because its signature recurred there, so counting them
        # makes the baseline positive by construction, and two clean runs of a
        # rare signature then read as "effective" by chance (code review).
        founding = set(re.findall(r"(?m)^[ \t]+- run:[ \t]*(\S+)[ \t]*$",
                                  path.read_text(encoding="utf-8")))
        unexp = relevant - exp - founding
        pre, post = rate(unexp, sig_runs), rate(exp, sig_runs)
        verdict = None
        # Enough exposure that at least one recurrence was EXPECTED at the
        # baseline rate; below that, zero recurrences is noise, not an effect.
        if (len(exp) >= 2 and pre is not None and post is not None
                and len(exp) * pre >= 1):
            if post < pre:
                verdict = "effective"
            elif post > 0:
                verdict = "ignored"
        dates = []
        if verdict == "effective":
            dates += [run_info[r][0] for r in exp - sig_runs]
            print("  EFFECTIVE {p}: signature in {a:.0%} of {n} run(s) where it was loaded, "
                  "against {b:.0%} of {m} where it was not".format(
                      p=path.name, a=post, n=len(exp), b=pre, m=len(unexp)), file=out)
        elif verdict == "ignored":
            # Loaded, and the failure it names happens as often as without it.
            # The note is not changing behaviour: escalate it (reword it, or
            # promote it into the agent or skill definition). It is NOT
            # re-confirmed by the very recurrence it failed to prevent.
            print("  IGNORED {p}: signature in {a:.0%} of {n} run(s) where it was loaded, "
                  "against {b:.0%} where it was not -- the note is not changing "
                  "behaviour; escalate it".format(p=path.name, a=post, n=len(exp), b=pre), file=out)
        if g:
            # Recurrence still confirms that the problem exists -- but only in
            # runs where the learning was NOT in play.
            dates += [run_info[r][0] for r in sig_runs - exp if r in run_info]
        latest = max((d for d in dates if d), default="")
        # Never backwards: a stamp only ever extends a learning's life.
        if not latest or latest <= (fm.get("lastConfirmed") or ""):
            continue
        text = path.read_text(encoding="utf-8")
        new = re.sub(r"(?m)^lastConfirmed:[ \t]*.*$",
                     "lastConfirmed: " + latest, text, count=1)
        if new == text:
            continue
        changed += 1
        print("  {p}: lastConfirmed {a} -> {b} ({why})".format(
            p=path.name, a=fm.get("lastConfirmed"), b=latest,
            why="; ".join(filter(None, [
                "{n} distinct runs recurring".format(n=g.distinct_runs) if g else "",
                "effective against exposure" if verdict == "effective" else "",
            ]))), file=out)
        if emit:
            path.write_text(new, encoding="utf-8", newline="\n")

    print("stamped {c} learning(s) as still recurring or effective{d}".format(
        c=changed, d="" if emit else " (dry run -- nothing written)"), file=out)
    return EXIT_OK


def do_retire(root: Path, days: int, emit: bool, out) -> int:
    """Move anything unconfirmed for `days` to `learnings/retired/`.

    Staleness is detected by absence of recurrence, not by a date someone
    remembered to update -- which only holds because `--stamp` runs first.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    moved = 0
    for path, fm in existing_learnings(root):
        last = fm.get("lastConfirmed", "")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", last):
            print("  SKIP {p}: lastConfirmed is not a date ({v!r}) -- retiring on "
                  "an unparseable field would delete a learning by accident".format(
                      p=path.name, v=last), file=out)
            continue
        if last >= cutoff:
            continue
        moved += 1
        print("  {p}: lastConfirmed {l} is older than {d} days".format(
            p=path.name, l=last, d=days), file=out)
        if emit:
            dest = root / LEARNINGS_REL / "retired" / path.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            path.replace(dest)
    print("retired {m} learning(s) unconfirmed since {c}{d}".format(
        m=moved, c=cutoff, d="" if emit else " (dry run -- nothing moved)"), file=out)
    return EXIT_OK


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Propose learning candidates from run outcomes.")
    ap.add_argument("--emit", action="store_true",
                    help="write files; without it nothing is written")
    ap.add_argument("--dry-run", action="store_true",
                    help="explicit no-op form of the default")
    ap.add_argument("--stamp", action="store_true",
                    help="update lastConfirmed on learnings whose signature recurred")
    ap.add_argument("--retire", action="store_true",
                    help="move learnings unconfirmed for --retire-days to retired/")
    ap.add_argument("--retire-days", type=int, default=DEFAULT_RETIRE_DAYS)
    ap.add_argument("--root", default=None,
                    help="repository root (default: the one this file lives in)")
    ap.add_argument("--pr-body", metavar="FILE", default=None,
                    help="also write the run summary here, for a pull-request body")
    args = ap.parse_args(argv)

    if args.emit and args.dry_run:
        print("[distil] --emit and --dry-run contradict each other", file=sys.stderr)
        return EXIT_USAGE

    root = Path(args.root).resolve() if args.root else REPO_ROOT
    if not root.is_dir():
        print("[distil] no such root: {r}".format(r=root), file=sys.stderr)
        return EXIT_USAGE

    # The redactor imported. That is necessary and not sufficient: a redactor
    # whose classes have been emptied imports perfectly and matches nothing,
    # which is the more dangerous failure because it is silent.
    failures = _redact.selftest()
    if failures:
        print("[distil] REFUSING TO RUN: the redactor failed its self-test, so it "
              "cannot be trusted to filter anything.", file=sys.stderr)
        for f in failures:
            print("  - " + f, file=sys.stderr)
        return EXIT_NO_REDACTOR

    import io

    buf = io.StringIO()

    class Tee:
        def write(self, s):
            buf.write(s)
            sys.stdout.write(s)

        def flush(self):
            sys.stdout.flush()

    out = Tee()
    emit = bool(args.emit)

    code = EXIT_OK
    if args.stamp:
        code = max(code, do_stamp(root, emit, out))
    if args.retire:
        code = max(code, do_retire(root, args.retire_days, emit, out))
    if not args.stamp and not args.retire:
        denylist = _redact.load_denylist(root=root)
        if not denylist:
            print("  NOTE tier 1 is inert for this run -- no denylist entries "
                  "were loaded. Only the compiled regex classes applied.", file=out)
        code = do_distil(root, emit, denylist, out)

    if args.pr_body:
        Path(args.pr_body).write_text(buf.getvalue(), encoding="utf-8", newline="\n")

    return code


if __name__ == "__main__":
    raise SystemExit(main())
