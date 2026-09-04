#!/usr/bin/env python3
"""Fixture suite for the redactor -- the one control in the learning loop whose
failure is invisible.

Everything else in this repository fails loudly when it breaks: a broken
converter unregisters an agent, a broken validator goes red. A broken redactor
publishes. Nothing goes red, the pull request looks ordinary, and the leak is
found by whoever reads the public repository. So this suite is not decoration
around `redact.py`; it is the only evidence the control does anything at all.

No pytest. This repository has no `requirements.txt` and therefore no dependency
floor, so the suite uses `unittest` from the standard library and signals the
result through the exit code, exactly as the `.js` suites beside it do.

    python sdlc-suite/tools/test_redact.py          # exit 0 on pass, 1 on fail

Every fixture below was first run against a `redact.py` whose `CLASSES` was
empty and whose denylist loader returned nothing, and then again with one class
ablated at a time. The record of which assertion went red for which cause is in
the change report -- a fixture that has only ever been observed green is
indistinguishable from one that asserts nothing, and that is precisely the shape
of test that would give false confidence here.

Two notes on the fixtures themselves:

* The home-path fixtures use account names (someone, username) that the
  placeholder allowlist in `.gitleaks.toml` already excuses. A fixture suite for
  a secret filter must not itself trip the secret scan.
* The high-entropy fixture is bound to a name carrying none of the gitleaks
  generic-api-key keywords, for the same reason.
"""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import redact  # noqa: E402


# --------------------------------------------------------------------------
# Fixtures. One per class, plus the negatives.
# --------------------------------------------------------------------------

CLEAN = (
    "A test harness that stubs a callback as a sink terminates one hop before "
    "anything the consumer does with it. When a callback gains a consumer, the "
    "harness has to model the consumer too."
)

# 32 characters, mixed case, digits. Deliberately not bound to a name containing
# access / auth / api / credential / key / password / secret / token.
OPAQUE_32 = "aB3xQ7mZ2pR9tL4wS8vN6yH1kJ5cD0fG"

DENYLIST = ["example-employer", "example-customer", "internal-codename"]


def one_class(text, denylist=()):
    """Run a fixture and return (outcome, sorted class names)."""
    v = redact.redact(text, denylist=denylist, field="body")
    return v.outcome, sorted({r.name for r in v.reasons})


class Tier1Denylist(unittest.TestCase):
    """A denylist hit DROPS. These are known-private strings; there is no benign
    reason for one to appear in a cross-project heuristic."""

    def test_denylist_hit_drops_and_counts_a_reason(self):
        outcome, _ = one_class("The " + DENYLIST[0] + " build always fails.", DENYLIST)
        self.assertEqual(outcome, "dropped")

    def test_denylist_reason_is_tier_1(self):
        v = redact.redact("a " + DENYLIST[1] + " b", denylist=DENYLIST, field="body")
        self.assertEqual([r.tier for r in v.reasons], [1])

    def test_denylist_is_case_insensitive(self):
        outcome, _ = one_class("The EXAMPLE-EMPLOYER pipeline.", DENYLIST)
        self.assertEqual(outcome, "dropped")

    def test_denylist_matches_as_a_substring(self):
        # A compound name must drop too. A word-boundary match would let
        # example-employer-api through, and the fail-safe direction is to drop.
        outcome, _ = one_class("see example-employer-api for detail", DENYLIST)
        self.assertEqual(outcome, "dropped")

    def test_tier_1_beats_tier_2(self):
        # Text carrying both must DROP, not quarantine: quarantine is a holding
        # pen a human empties, and a known-private string must never sit in one.
        v = redact.redact(DENYLIST[0] + " reported 10.4.2.19",
                          denylist=DENYLIST, field="body")
        self.assertEqual(v.outcome, "dropped")
        self.assertEqual({r.tier for r in v.reasons}, {1})

    def test_clean_text_survives_a_populated_denylist(self):
        outcome, _ = one_class(CLEAN, DENYLIST)
        self.assertEqual(outcome, "published")


class Tier2Classes(unittest.TestCase):
    """A regex hit QUARANTINES and the job then fails. Uncertain is not
    published, and it is not silently discarded either."""

    def test_windows_home_path(self):
        outcome, names = one_class(r"logged from C:\Users\someone\project\notes.md")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("abs_home_path", names)

    def test_windows_home_path_lowercased(self):
        # Windows paths reach a log in both cases; the class must not depend on
        # the drive letter or on Users being capitalised.
        outcome, names = one_class(r"logged from c:\users\someone\project")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("abs_home_path", names)

    def test_posix_home_path(self):
        outcome, names = one_class("logged from /home/username/notes")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("abs_home_path", names)

    def test_macos_home_path(self):
        outcome, names = one_class("logged from /Users/someone/personal/agents")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("abs_home_path", names)

    def test_email(self):
        outcome, names = one_class("raised by first.last@example.invalid last week")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("email", names)

    def test_private_ip(self):
        outcome, names = one_class("the runner at 10.4.2.19 timed out")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("private_ip", names)

    def test_private_ip_192_168(self):
        outcome, names = one_class("gateway 192.168.1.1 refused")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("private_ip", names)

    def test_internal_host(self):
        outcome, names = one_class("build.corp refused the connection")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("internal_host", names)

    def test_ticket_id_azure_form(self):
        outcome, names = one_class("tracked as AB#41207 in the board")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("ticket_id", names)

    def test_ticket_id_fires_on_this_repositorys_own_finding_ids(self):
        # Stated in the design and asserted here so nobody narrows it later: a
        # false positive costs a human read, a false negative publishes a
        # customer ticket number. This is the correct failure direction, and it
        # is why the outcome is quarantine rather than a drop.
        outcome, names = one_class("supersedes LRN-0042")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("ticket_id", names)

    def test_ticket_id_fires_on_a_single_digit_criterion_id(self):
        # Split out from the case above deliberately. Asserted together, this
        # passed on the strength of LRN-0042 alone while AC-1 did not match at
        # all -- the pattern's `\d{2,6}` needed two digits, so the docstring
        # claiming it fires on AC-1 was false and the test could not reveal it.
        # A single-digit criterion id is the shape most likely to turn up in a
        # notAddressed reason, which is one of the four distilled signatures.
        outcome, names = one_class("deferred AC-1 to the next slice")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("ticket_id", names)

    def test_high_entropy(self):
        outcome, names = one_class("the value " + OPAQUE_32 + " appeared in the log")
        self.assertEqual(outcome, "quarantined")
        self.assertIn("high_entropy", names)

    def test_clean_candidate_is_published(self):
        outcome, names = one_class(CLEAN)
        self.assertEqual(outcome, "published", "clean text matched " + str(names))
        self.assertEqual(names, [])


class DenylistLoading(unittest.TestCase):
    def test_missing_file_yields_empty_list_and_warns_loudly(self):
        # Silence would be the dangerous outcome: tier 1 inert with no signal is
        # how a filter gets trusted more than it deserves. It must not raise --
        # a missing instance file cannot be allowed to stop the whole job -- but
        # it must say so.
        buf = io.StringIO()
        with redirect_stderr(buf):
            got = redact.load_denylist(path=Path("no-such-denylist-file.txt"))
        self.assertEqual(got, [])
        self.assertIn("denylist", buf.getvalue().lower())

    def test_comments_and_blank_lines_are_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "denylist.txt"
            f.write_text(
                "# a comment\n\n   \nexample-employer\n  example-customer  \n",
                encoding="utf-8",
                newline="\n",
            )
            got = redact.load_denylist(path=f)
        self.assertEqual(got, ["example-employer", "example-customer"])
        # A comment line must not become an entry: a "#" substring entry would
        # drop every candidate mentioning a fragment identifier.
        self.assertNotIn("# a comment", got)

    def test_a_blank_entry_cannot_drop_everything(self):
        # An empty string is a substring of every text. If a stray blank entry
        # survived loading, tier 1 would drop the entire corpus and the loop
        # would look clean forever.
        v = redact.redact(CLEAN, denylist=["", "   "])
        self.assertEqual(v.outcome, "published")


class GeneratedFields(unittest.TestCase):
    """The distiller's own identifiers are shape-validated against an allowlist,
    never regex-scanned.

    Scanning them would be self-defeating: LRN-0042 matches ticket_id, and a run
    id such as 20260814T090000Z-independent-review-91bc matches high_entropy, so
    every candidate would quarantine forever -- which is exactly the pressure to
    loosen a pattern that the design forbids. An allowlist on shape is the
    stronger control anyway, because anything unexpected fails closed."""

    GOOD = {
        "id": "LRN-0042",
        "kind": "heuristic",
        "confidence": "observed",
        "firstSeen": "2026-08-14",
        "lastConfirmed": "2026-09-02",
        "signature": "0123456789abcdef",
        "appliesTo": ["qa-engineer", "code-reviewer"],
        "provenance": [
            "20260814T090000Z-independent-review-91bc",
            "20260902T141500Z-sdlc-feature-a3f1",
        ],
        "supersedes": [],
    }

    def test_wellformed_generated_fields_do_not_quarantine(self):
        cand = dict(self.GOOD)
        cand.update(title="A short clean title", body=CLEAN,
                    check="Ask what reads the value after the stub.")
        v = redact.redact_candidate(cand, denylist=DENYLIST)
        self.assertEqual(v.outcome, "published", "reasons: " + str(v.reasons))

    def test_malformed_run_id_quarantines(self):
        cand = dict(self.GOOD, provenance=["../../etc/passwd"])
        cand.update(title="t", body=CLEAN, check="c")
        v = redact.redact_candidate(cand)
        self.assertEqual(v.outcome, "quarantined")
        self.assertIn("malformed:provenance", {r.name for r in v.reasons})

    def test_malformed_id_quarantines(self):
        cand = dict(self.GOOD, id="LRN-42/../..")
        cand.update(title="t", body=CLEAN, check="c")
        v = redact.redact_candidate(cand)
        self.assertEqual(v.outcome, "quarantined")
        self.assertIn("malformed:id", {r.name for r in v.reasons})

    def test_derived_fields_are_still_scanned(self):
        cand = dict(self.GOOD)
        cand.update(title="t", body="reported by first.last@example.invalid", check="c")
        v = redact.redact_candidate(cand)
        self.assertEqual(v.outcome, "quarantined")
        self.assertIn("email", {r.name for r in v.reasons})


class ReportingLeaksNothing(unittest.TestCase):
    """The summary is printed into a CI log on a public repository. If it echoed
    the match, the redactor would itself be the leak."""

    def test_tier_2_summary_carries_no_matched_content(self):
        v = redact.redact("raised by first.last@example.invalid", field="body")
        summary = redact.mask_summary(v)
        self.assertNotIn("first.last@example.invalid", summary)
        self.assertNotIn("example.invalid", summary)
        self.assertIn("email", summary)

    def test_tier_1_summary_names_the_entry_by_index_not_by_value(self):
        v = redact.redact("a " + DENYLIST[0] + " b", denylist=DENYLIST, field="body")
        summary = redact.mask_summary(v)
        self.assertNotIn(DENYLIST[0], summary)
        self.assertIn("#1", summary)

    def test_reason_objects_hold_no_matched_content(self):
        v = redact.redact("the runner at 10.4.2.19 timed out", field="body")
        self.assertTrue(v.reasons)
        for r in v.reasons:
            self.assertNotIn("10.4.2.19", repr(r))


class SelfTest(unittest.TestCase):
    """selftest() is the known positive that distil.py gates on. A redactor that
    imports cleanly but matches nothing is a more dangerous failure than one
    that fails to import, because it is silent."""

    def test_selftest_passes_against_the_shipped_classes(self):
        self.assertEqual(redact.selftest(), [])

    def test_selftest_detects_a_disabled_class(self):
        saved = dict(redact.CLASSES)
        try:
            del redact.CLASSES["email"]
            failures = redact.selftest()
        finally:
            redact.CLASSES.clear()
            redact.CLASSES.update(saved)
        self.assertTrue(failures, "selftest passed with the email class removed")
        self.assertTrue(any("email" in f for f in failures), failures)


if __name__ == "__main__":
    unittest.main(verbosity=2)
