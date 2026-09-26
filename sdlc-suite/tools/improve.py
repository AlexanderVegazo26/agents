#!/usr/bin/env python3
"""Propose faster ways of running the suite, from the evidence of past runs.

    python sdlc-suite/tools/improve.py                 # proposals for this repo's runs
    python sdlc-suite/tools/improve.py --root PATH     # another repository
    python sdlc-suite/tools/improve.py --out FILE      # also write them as Markdown

WHAT THIS IS FOR
----------------
`distil.py` learns what agents get WRONG. Nothing learned where the PROCESS is
slow or wasteful: a phase that eats most of the wall-clock on every run, an
agent that needs its retry every time (a whole extra dispatch, paid on every
run), a repair loop that always burns its second round without closing, a gate
that blocks every run and waits for a person. Each of those is a faster way of
doing the work that the run records already prove is available.

WHAT IT NEVER PROPOSES
----------------------
Doing less checking. A lens that finds nothing is not proposed for removal, a
refuter that always agrees is not proposed for skipping, and no proposal lowers
a review's effort — "look harder, never less" (learnings/README.md) holds for
process proposals too. `test_improve.py` fails on skip/remove/fewer wording in
any proposal. Speed comes from removing waste — repeated dispatches, dead
rounds, serial waits — never from removing scrutiny.

Every proposal is for a HUMAN to decide. Nothing here edits a definition, a
workflow or a policy: a standing authorization is a human's call by
construction, and a prompt change goes through the same review as any other.

Exit code is always 0 unless the arguments are wrong (2): a report, not a gate.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_ID_RE = re.compile(r"\d{8}T\d{6}Z-[a-z0-9-]{1,40}-[0-9a-f]{4}")   # used with fullmatch
FILE_CAP = 1024 * 1024

# A phase is a bottleneck when its median share of run time is at least this.
SLOW_SHARE = 0.40
SLOW_MIN_RUNS = 3


# Every identifier interpolated into a proposal comes from a run record, and
# run records are gitignored and therefore plantable. A proposal is read by the
# orchestrator and relayed to a human, so only identifier-shaped values pass:
# anything else is dropped, never cleaned up and used.
# Real vocabularies, not a character set: security review showed a set that
# allows spaces and colons admits a 60-character instruction as a "label".
LABEL_RE = re.compile(r"[a-z][a-z0-9-]{0,30}(:[a-z0-9-]{1,30})?")
PHASE_RE = re.compile(r"[A-Z][A-Za-z-]{0,20}( [0-9]{1,2})?")
WORKFLOWS = {"sdlc-feature", "independent-review", "registry-audit", "release-readiness",
             "system-archaeology", "persona-qa-sweep"}
LENSES = {"review", "qa", "security", "performance"}
# Mirrors GATES in sdlc-suite/workflows/_policy.js. Only a real gate is ever put
# in front of a human as a standing-authorization question.
GATES = {
    "decide": {"roadmapCommit", "prioritizationDecision", "initiativeRejection",
               "architectureDirectionChange", "goNoGoClassification", "defectFiling"},
    "act": {"deploy", "destructiveMigration", "productionConfigChange", "incidentFailover",
            "loadTestAgainstSharedEnv", "externalDataSend", "grantAccess",
            "sharedComponentModification"},
}


def ident(v, pattern=LABEL_RE) -> str | None:
    # fullmatch, not match: Python's `$` also matches before a trailing newline.
    s = str(v or "")
    return s if pattern.fullmatch(s) else None


def _read_json(path: Path):
    try:
        if not path.is_file() or path.stat().st_size > FILE_CAP:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_runs(root: Path, window: int) -> list[dict]:
    """The newest `window` recorder-written runs: id-shaped, manifest naming them."""
    runs_root = root / ".claude" / "runs"
    if not runs_root.is_dir():
        return []
    ids = sorted((p.name for p in runs_root.iterdir()
                  if p.is_dir() and not p.is_symlink() and RUN_ID_RE.fullmatch(p.name)),
                 reverse=True)[:window]
    out = []
    for rid in ids:
        d = runs_root / rid
        manifest = _read_json(d / "manifest.json")
        outcome = _read_json(d / "outcome.json")
        if not isinstance(manifest, dict) or manifest.get("runId") != rid:
            continue
        if not isinstance(outcome, dict):
            continue
        outcome["_id"] = rid
        out.append(outcome)
    return out


def _proposal(kind, title, evidence, change, saves, runs):
    return {"kind": kind, "title": title, "evidence": evidence,
            "change": change, "saves": saves, "runs": sorted(runs)}


def slow_phases(runs: list[dict]) -> list[dict]:
    by_wf = defaultdict(list)
    for r in runs:
        wf = str(r.get("workflow") or "")
        by_wf[wf if wf in WORKFLOWS else "unknown"].append(r)
    out = []
    for wf, rs in sorted(by_wf.items()):
        shares = defaultdict(list)
        for r in rs:
            d = r.get("durationsMs") or {}
            total = sum(v for v in d.values() if isinstance(v, (int, float)) and v > 0)
            if total <= 0:
                continue
            for ph, v in d.items():
                if ident(ph, PHASE_RE) and isinstance(v, (int, float)) and v >= 0:
                    shares[ph].append((v / total, r["_id"]))
        for ph, vals in sorted(shares.items()):
            if len(vals) < SLOW_MIN_RUNS:
                continue
            med = statistics.median(v for v, _ in vals)
            if med >= SLOW_SHARE:
                out.append(_proposal(
                    "slow-phase",
                    f"{wf}: the {ph} phase is {med:.0%} of run time",
                    f"median share {med:.0%} of phase time across {len(vals)} runs",
                    f"Profile the {ph} phase before anything else: split its agents so the "
                    f"independent ones run in parallel, or hand them a narrower brief by "
                    f"reference so each reads less. Keep every check it makes.",
                    f"up to {med:.0%} of wall-clock per run, before any other optimisation",
                    [i for _, i in vals]))
    return out


def retry_habits(runs: list[dict], floor: int) -> list[dict]:
    seen = defaultdict(set)
    for r in runs:
        for x in r.get("retries") or []:
            if isinstance(x, dict) and x.get("attempts") == 2 and x.get("recovered") is True:
                label = ident(x.get("label"))
                if label:
                    seen[label].add(r["_id"])
    return [_proposal(
        "retry-habit",
        f"{label} needs its retry to succeed",
        f"recovered on the rewritten retry in {len(ids)} runs",
        f"Fold the retry's restated output contract into {label}'s FIRST prompt. The "
        f"retry proves the agent can do the task; the first prompt is what fails.",
        "one whole agent dispatch per run",
        ids) for label, ids in sorted(seen.items()) if label and len(ids) >= floor]


def repair_churn(runs: list[dict], floor: int) -> list[dict]:
    exhausted = defaultdict(set)
    for r in runs:
        rr = r.get("repairRounds")
        if not isinstance(rr, dict) or rr.get("outcome") != "exhausted":
            continue
        # Only rounds that actually ran a re-verification, and only the LAST of
        # them: a lens that closed in round 1 while another exhausted is not
        # churn, and a round that broke off ("no builder produced a repair
        # manifest") never reached round 2 (code review).
        ran = [x for x in (rr.get("rounds") or []) if isinstance(x, dict) and not x.get("note")]
        if len(ran) < 2:
            continue
        last = ran[-1]
        # `openLenses` names the lenses still open after the round; older records
        # have only the lenses that ENTERED it, which over-reports.
        for lens in (last.get("openLenses") if isinstance(last.get("openLenses"), list) else last.get("lenses")) or []:
            if str(lens) in LENSES:
                exhausted[str(lens)].add(r["_id"])
    return [_proposal(
        "repair-churn",
        f"repair for the {lens} lens exhausted both rounds in {len(ids)} of {len(runs)} runs",
        f"both bounded repair rounds ran and {lens} blocking findings were still open after the second, in {len(ids)} runs",
        f"Bring a human in on {lens} blocking findings as soon as round 1 fails to close them, "
        f"working in parallel with round 2. Round 2 and its re-verification still run unchanged; "
        f"only the human's start moves earlier.",
        "the human's wait for the whole second round, on every affected run",
        ids) for lens, ids in sorted(exhausted.items()) if len(ids) >= floor]


def recurring_gates(runs: list[dict], floor: int) -> list[dict]:
    seen = defaultdict(set)
    for r in runs:
        for g in r.get("blockedGates") or []:
            gate = str((g or {}).get("gate") or "")
            # Only authorization gates: a breaker or runtime gate is a defect to
            # fix, not a wait to authorize away.
            cls, _, name = gate.partition(".")
            if name in GATES.get(cls, ()):
                seen[gate].add(r["_id"])
    return [_proposal(
        "recurring-gate",
        f"{gate} was blocked, waiting for a person, in {len(ids)} of {len(runs)} runs",
        f"recorded as a blocked gate in {len(ids)} runs",
        f"Decide once whether {gate} should be pre-authorized for this repository in "
        f".claude/autonomy.json. This is a human decision, not a recommendation: the gate "
        f"exists for a reason, and a standing authorization is surfaced on every run as actGranted. "
        f"The evidence is gitignored run records: confirm the runs named are real before deciding.",
        "the human round-trip on every run that reaches this gate",
        ids) for gate, ids in sorted(seen.items()) if len(ids) >= floor]


def propose(root: Path, window: int = 20, floor: int = 2) -> tuple[list[dict], int]:
    runs = read_runs(root, window)
    props = slow_phases(runs) + retry_habits(runs, floor) + repair_churn(runs, floor) + recurring_gates(runs, floor)
    return props, len(runs)


def render(props: list[dict], n_runs: int) -> str:
    lines = [f"# Process proposals — from {n_runs} recorded run(s)", ""]
    if not props:
        lines.append("No proposal: no waste signal recurred in the runs read.")
        return "\n".join(lines) + "\n"
    lines.append("Each is for a human to decide. None removes a check.")
    lines.append("")
    for i, p in enumerate(props, 1):
        lines += [
            f"## {i}. {p['title']}",
            f"- **Kind:** {p['kind']}",
            f"- **Evidence:** {p['evidence']}",
            f"- **Proposed change:** {p['change']}",
            f"- **Saves:** {p['saves']}",
            f"- **Runs:** {', '.join(p['runs'])}",
            "",
        ]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=None)
    ap.add_argument("--window", type=int, default=20)
    ap.add_argument("--floor", type=int, default=2)
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)
    root = Path(a.root).resolve() if a.root else REPO_ROOT
    if not root.is_dir() or a.window < 1 or a.floor < 1:
        print("[improve] bad --root, --window or --floor", file=sys.stderr)
        return 2
    props, n = propose(root, a.window, a.floor)
    text = render(props, n)
    sys.stdout.write(text)
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
