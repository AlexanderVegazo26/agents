#!/usr/bin/env python3
"""Fixture suite for the distiller's selection logic.

    python sdlc-suite/tools/test_distil.py          # exit 0 on pass, 1 on fail

The distiller had no test of its own until 2026-09-24, and the empirical review
found why that mattered: it filtered runs by `.last-distil` BEFORE grouping, so
run 1 then run 2 with the same signature printed "0 of 1 met the floor" -- the
loop could never emit when run per-run -- and the "DEFERRED ... reconsidered on
the next run" line described something that did not happen. The recurrence and
deferral tests went red against that code; the others guard behaviour added with
or after the fix, and each was shown red by disabling that behaviour alone (the
old-evidence test passes on the old code too, vacuously -- that code read zero
runs -- so it guards the new code, not the old defect).

No pytest: the standard library only, like `test_redact.py` beside it.
"""

from __future__ import annotations

import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import distil  # noqa: E402


_seq = [0]


def write_run(root: Path, run_id: str, ended: str, refutations=None, failures=None):
    # A real-shaped run id: the redactor's provenance class quarantines
    # anything else, which is a property worth keeping rather than stubbing.
    _seq[0] += 1
    run_id = "20260901T{:06d}Z-sdlc-feature-{:04x}".format(_seq[0], _seq[0])
    d = root / ".claude" / "runs" / run_id
    d.mkdir(parents=True, exist_ok=True)
    outcome = {
        "runId": run_id, "workflow": "sdlc-feature", "status": "completed",
        "startedAt": ended, "endedAt": ended,
        "refutations": refutations or [], "blockedGates": [], "failures": [],
    }
    (d / "outcome.json").write_text(json.dumps(outcome), encoding="utf-8")
    if failures:
        (d / "failures.jsonl").write_text(
            "".join(json.dumps(f) + "\n" for f in failures), encoding="utf-8")


def refutation(why: str, lens: str = "qa"):
    return {"lens": lens, "severity": "Should Fix", "summary": "s", "refuted": True, "why": why}


def distil_once(root: Path, emit=True) -> tuple[int, str]:
    buf = io.StringIO()
    code = distil.do_distil(root, emit, denylist=(), out=buf)
    return code, buf.getvalue()


def candidates(root: Path) -> list[Path]:
    d = root / "learnings" / "candidates"
    return sorted(d.glob("*.md")) if d.is_dir() else []


class Recurrence(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="distil-"))
        (self.root / "learnings").mkdir()

    def test_signature_recurring_across_two_per_run_distils_is_emitted(self):
        write_run(self.root, "r1", "2026-09-01T00:00:00Z", [refutation("the fixture predates the schema")])
        code, _ = distil_once(self.root)
        self.assertEqual(code, 0)
        self.assertEqual(candidates(self.root), [], "one run is below the floor")
        write_run(self.root, "r2", "2099-01-01T00:00:00Z", [refutation("the fixture predates the schema")])
        code, text = distil_once(self.root)
        self.assertEqual(code, 0, text)
        self.assertEqual(len(candidates(self.root)), 1, text)

    def test_old_evidence_alone_does_not_repropose_after_a_clean_emit(self):
        write_run(self.root, "r1", "2026-09-01T00:00:00Z", [refutation("same reason")])
        write_run(self.root, "r2", "2026-09-02T00:00:00Z", [refutation("same reason")])
        distil_once(self.root)
        for c in candidates(self.root):
            c.unlink()  # a reviewer rejected it
        _, text = distil_once(self.root)
        self.assertEqual(candidates(self.root), [],
                         "a rejected candidate came back with no new evidence:\n" + text)

    def test_a_pending_candidate_is_not_proposed_twice(self):
        write_run(self.root, "r1", "2026-09-01T00:00:00Z", [refutation("same reason")])
        write_run(self.root, "r2", "2026-09-02T00:00:00Z", [refutation("same reason")])
        distil_once(self.root)
        write_run(self.root, "r3", "2099-01-01T00:00:00Z", [refutation("same reason")])
        distil_once(self.root)
        self.assertEqual(len(candidates(self.root)), 1)

    def test_deferred_candidates_really_are_reconsidered_next_run(self):
        cap = distil.MAX_CANDIDATES_PER_RUN
        for n in range(cap + 2):
            for rid in ("a", "b"):
                write_run(self.root, f"r{n}{rid}", "2026-09-01T00:00:{:02d}Z".format(n),
                          [refutation(f"distinct reason number {n}")])
        _, first = distil_once(self.root)
        self.assertEqual(len(candidates(self.root)), cap, first)
        self.assertIn("DEFERRED 2", first)
        _, second = distil_once(self.root)
        self.assertEqual(len(candidates(self.root)), cap + 2,
                         "the deferred two never reappeared:\n" + second)


def ratify(root: Path, cand: Path):
    cand.replace(root / "learnings" / cand.name)


def ids_in(root: Path) -> set:
    out = set()
    for p in (root / "learnings").rglob("*.md"):
        m = re.search(r"(?m)^id: (LRN-\d+)$", p.read_text(encoding="utf-8"))
        if m:
            out.add(m.group(1))
    return out


class RealisticStores(unittest.TestCase):
    """Reviewers' repros: the fixtures above are all clean, and a realistic store
    is not -- one quarantined signature used to freeze the marker for good."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="distil-real-"))
        (self.root / "learnings").mkdir()

    def test_a_quarantine_does_not_bring_rejected_candidates_back(self):
        for _ in range(2):
            write_run(self.root, "x", "2026-09-01T00:00:00Z", [
                refutation("clean reason that recurs"),
                refutation("mail the owner at someone@example.org about it", lens="review"),
            ])
        code, first = distil_once(self.root)
        self.assertEqual(code, distil.EXIT_QUARANTINED, first)
        published = candidates(self.root)
        self.assertEqual(len(published), 1, first)
        used = ids_in(self.root)
        published[0].unlink()          # a reviewer rejects it
        _, second = distil_once(self.root)
        self.assertEqual(candidates(self.root), [],
                         "a rejected candidate came back on the next run:\n" + second)
        write_run(self.root, "x", "2099-01-01T00:00:00Z", [refutation("a brand new reason")])
        write_run(self.root, "x", "2099-01-01T00:00:01Z", [refutation("a brand new reason")])
        distil_once(self.root)
        new_ids = ids_in(self.root) - used
        self.assertTrue(new_ids and not (new_ids & used), f"an id was re-issued: {used} / {new_ids}")
        rejected_id = re.search(r"LRN-\d+", published[0].name).group(0)
        self.assertNotIn(rejected_id, {p.stem for p in candidates(self.root)},
                         "the rejected candidate's id was handed to a different signature")

    def test_a_rejected_candidates_id_is_never_reissued_on_a_clean_store(self):
        # QA T1: without the `issued` high-water mark this suite stayed green
        # while a clean store re-used LRN-0001 for a different signature.
        for _ in range(2):
            write_run(self.root, "x", "2026-09-01T00:00:00Z", [refutation("first reason")])
        self.assertEqual(distil_once(self.root)[0], 0)
        first = candidates(self.root)
        self.assertEqual([p.stem for p in first], ["LRN-0001"])
        first[0].unlink()
        for _ in range(2):
            write_run(self.root, "x", "2099-01-01T00:00:00Z", [refutation("second reason")])
        distil_once(self.root)
        self.assertEqual([p.stem for p in candidates(self.root)], ["LRN-0002"])

    def test_ratified_recurrences_do_not_starve_a_new_signature(self):
        cap = distil.MAX_CANDIDATES_PER_RUN
        for n in range(cap):
            for _ in range(2):
                write_run(self.root, "x", "2026-09-01T00:00:00Z", [refutation(f"known reason {n}")])
        distil_once(self.root)
        for c in candidates(self.root):
            ratify(self.root, c)
        for n in range(cap):
            write_run(self.root, "x", "2099-01-01T00:00:00Z", [refutation(f"known reason {n}")])
        write_run(self.root, "x", "2099-01-01T00:00:00Z", [refutation("genuinely new")])
        write_run(self.root, "x", "2099-01-01T00:00:01Z", [refutation("genuinely new")])
        _, text = distil_once(self.root)
        self.assertEqual(len(candidates(self.root)), 1, text)
        self.assertNotIn("DEFERRED", text)

    def test_notaddressed_with_run_local_ac_ids_is_not_quarantined(self):
        for n in range(2):
            write_run(self.root, "x", "2026-09-01T00:00:00Z", [])
        for i, d in enumerate(sorted((self.root / ".claude" / "runs").iterdir())):
            (d / "phase-3-build.json").write_text(json.dumps({"agents": [{"label": "build:backend", "result": {
                "notAddressed": [{"id": f"AC-{i + 2}", "why": "covered by the data surface, not this one"}]}}]}),
                encoding="utf-8")
        code, text = distil_once(self.root)
        self.assertEqual(code, 0, text)
        self.assertEqual(len(candidates(self.root)), 1, text)

    def test_below_floor_line_counts_only_single_run_signatures(self):
        for _ in range(2):
            write_run(self.root, "x", "2026-09-01T00:00:00Z", [refutation("twice")])
        distil_once(self.root)
        _, text = distil_once(self.root)   # pending now, and not new
        self.assertNotIn("seen in only one run", text)


class DecayOnEffectiveness(unittest.TestCase):
    """R11: a learning that WORKS must not retire; one that is IGNORED must be named."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="distil-decay-"))
        (self.root / "learnings").mkdir()
        for _ in range(2):
            write_run(self.root, "x", "2026-01-01T00:00:00Z", [refutation("the recurring reason")])
        distil_once(self.root)
        cand = candidates(self.root)[0]
        self.lid = cand.stem
        self.learning = self.root / "learnings" / cand.name
        cand.replace(self.learning)
        self.before = re.search(r"(?m)^lastConfirmed: (.*)$", self.learning.read_text(encoding="utf-8")).group(1)
        # A real BASELINE, separate from the founding runs (which the rate
        # excludes): 4 unexposed runs after ratification, 2 with the signature.
        for day, recur in (("01", True), ("02", False), ("03", True), ("04", False)):
            write_run(self.root, "x", "2026-03-%sT00:00:00Z" % day,
                      [refutation("the recurring reason")] if recur else [])

    def stamp(self):
        buf = io.StringIO()
        distil.do_stamp(self.root, True, buf)
        return buf.getvalue(), re.search(r"(?m)^lastConfirmed: (.*)$",
                                         self.learning.read_text(encoding="utf-8")).group(1)

    def loaded_run(self, ended, recur):
        rid = write_run(self.root, "x", ended, [refutation("the recurring reason")] if recur else [])
        d = self.root / ".claude" / "runs"
        latest = sorted(d.iterdir())[-1] / "outcome.json"
        o = json.loads(latest.read_text(encoding="utf-8"))
        o["learningsLoaded"] = [{"label": "verify:qa", "ids": [self.lid]}]
        latest.write_text(json.dumps(o), encoding="utf-8")
        return rid

    def test_an_effective_learning_is_kept_alive_by_exposure(self):
        # Baseline: the signature appeared in both unexposed runs (setUp).
        self.loaded_run("2026-06-01T00:00:00Z", recur=False)
        self.loaded_run("2026-06-02T00:00:00Z", recur=False)
        text, after = self.stamp()
        self.assertIn("EFFECTIVE", text)
        self.assertEqual(after, "2026-06-02", "a learning that worked was not kept alive: " + text)

    def test_an_ignored_learning_is_named_and_NOT_reconfirmed(self):
        # Code review: IGNORED used to print and then stamp anyway, from the
        # very recurrence the learning failed to prevent.
        self.loaded_run("2026-06-01T00:00:00Z", recur=True)
        self.loaded_run("2026-06-02T00:00:00Z", recur=True)
        text, after = self.stamp()
        self.assertIn("IGNORED", text)
        # Unexposed recurrence (the baseline) may still confirm the problem; the
        # EXPOSED recurrences must not.
        self.assertLess(after, "2026-06-01", "an ignored learning was re-confirmed: " + text)

    def test_a_rate_that_drops_but_not_to_zero_is_effective(self):
        # Baseline 2 of 4 (50%); exposed 1 of 3 (33%). Lower, so effective --
        # which "never seen in an exposed run" would miss.
        self.loaded_run("2026-06-01T00:00:00Z", recur=True)
        self.loaded_run("2026-06-02T00:00:00Z", recur=False)
        self.loaded_run("2026-06-03T00:00:00Z", recur=False)
        text, after = self.stamp()
        self.assertIn("EFFECTIVE", text)
        self.assertEqual(after, "2026-06-03", text)

    def test_a_rare_signature_is_not_effective_on_two_clean_runs(self):
        # Code review: with a low base rate, zero recurrences in two exposed runs
        # is what chance predicts. 2 of 10 unexposed (20%) x 2 exposed = 0.4
        # expected recurrences -- below 1, so no verdict either way.
        for day in range(5, 11):
            write_run(self.root, "x", "2026-03-%02dT00:00:00Z" % day, [])
        self.loaded_run("2026-06-01T00:00:00Z", recur=False)
        self.loaded_run("2026-06-02T00:00:00Z", recur=False)
        text, after = self.stamp()
        self.assertNotIn("EFFECTIVE", text)
        self.assertLess(after, "2026-06-01", text)

    def test_one_exposure_decides_nothing(self):
        self.loaded_run("2026-06-01T00:00:00Z", recur=False)
        text, after = self.stamp()
        self.assertNotIn("EFFECTIVE", text)
        self.assertLess(after, "2026-06-01")

    def test_a_future_dated_run_cannot_pin_a_learning_alive(self):
        self.loaded_run("9999-12-31T00:00:00Z", recur=False)
        self.loaded_run("9999-12-30T00:00:00Z", recur=False)
        _, after = self.stamp()
        self.assertNotEqual(after, "9999-12-31")

    def test_a_stamp_never_moves_lastconfirmed_backwards(self):
        self.learning.write_text(self.learning.read_text(encoding="utf-8").replace(
            "lastConfirmed: " + self.before, "lastConfirmed: 2099-01-01"), encoding="utf-8")
        self.loaded_run("2026-06-01T00:00:00Z", recur=False)
        self.loaded_run("2026-06-02T00:00:00Z", recur=False)
        _, after = self.stamp()
        self.assertEqual(after, "2099-01-01")


class FoundingRunsAreNotABaseline(unittest.TestCase):
    """Code review: a learning exists because its signature recurred in its
    founding runs, so counting them makes any baseline positive by construction."""

    def test_clean_runs_after_founding_alone_are_not_effective(self):
        root = Path(tempfile.mkdtemp(prefix="distil-founding-"))
        (root / "learnings").mkdir()
        for _ in range(2):
            write_run(root, "x", "2026-01-01T00:00:00Z", [refutation("only in the founding runs")])
        distil_once(root)
        cand = candidates(root)[0]
        lid = cand.stem
        learning = root / "learnings" / cand.name
        cand.replace(learning)
        for day in ("01", "02", "03"):
            write_run(root, "x", "2026-06-%sT00:00:00Z" % day, [])
            latest = sorted((root / ".claude" / "runs").iterdir())[-1] / "outcome.json"
            o = json.loads(latest.read_text(encoding="utf-8"))
            o["learningsLoaded"] = [{"label": "verify:qa", "ids": [lid]}]
            latest.write_text(json.dumps(o), encoding="utf-8")
        buf = io.StringIO()
        distil.do_stamp(root, True, buf)
        self.assertNotIn("EFFECTIVE", buf.getvalue(), buf.getvalue())


class Templates(unittest.TestCase):
    """A learning tells an agent to look HARDER, never less (learnings/README.md,
    review question 4). The generated `**Check:**` line is the text that lands in
    an agent's prompt, so it is checked for the wording that would invert that."""

    SUPPRESS = re.compile(r"\b(before raising|skip|suppress|do not raise|don't raise|fewer|"
                          r"no need to|stop (?:raising|checking)|ignore)\b", re.I)

    def test_no_check_line_tells_an_agent_to_look_less(self):
        for sigtype, key, kind, sample in [
            ("refutation", ("qa", "refuted", "why"), "heuristic",
             {"lens": "qa", "why": "why", "summary": "", "severity": "", "verdict": "refuted"}),
            ("refutation", ("qa", "confirmed", "why"), "heuristic",
             {"lens": "qa", "why": "why", "summary": "", "severity": "", "verdict": "confirmed"}),
            ("failure-class-phase", ("verify", "tool"), "failure-signature",
             {"phase": "Verify", "class": "tool", "strategyNext": "x", "agentType": None}),
            ("blocked-gate", ("act.deploy", "p"), "playbook",
             {"gate": "act.deploy", "prepared": "p", "unblocks": "u", "actionWithheld": "a"}),
            ("not-addressed", ("ac-1", "why"), "heuristic",
             {"id": "AC-1", "why": "why", "agentType": None}),
        ]:
            g = distil.Group(sigtype, key, kind)
            g.add({"runId": "r1", "_dir": Path(".")}, sample)
            _, _, check = distil._title_body_check(g)
            self.assertIsNone(self.SUPPRESS.search(check),
                              f"{sigtype}: check line reads as look-less: {check!r}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
