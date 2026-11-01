#!/usr/bin/env python3
"""Smoke tests for proactive_scan.py + goals.py — run: python3 tests/test_proactive_goals.py"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import proactive_scan as ps  # noqa: E402
import goals  # noqa: E402


class ProactiveScanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._state, self._feeds = ps.STATE, ps.FEEDS
        ps.STATE = os.path.join(self.tmp.name, "proactive_state.json")
        ps.FEEDS = os.path.join(self.tmp.name, "feeds.json")

    def tearDown(self):
        ps.STATE, ps.FEEDS = self._state, self._feeds
        self.tmp.cleanup()

    def test_dedup_and_ttl(self):
        st = ps.load_state()
        f = [{"id": "a", "severity": "info", "suggestion": "s1"},
             {"id": "b", "severity": "action", "suggestion": "s2"}]
        fresh = ps.pending(f, st)
        self.assertEqual({x["id"] for x in fresh}, {"a", "b"})
        fresh2 = ps.pending(f, st)          # immediate re-scan -> nothing new
        self.assertEqual(fresh2, [])
        st["delivered"]["a"] -= 8 * 86400   # older than TTL
        fresh3 = ps.pending(f, st)
        self.assertEqual([x["id"] for x in fresh3], ["a"])
        st["acked"].append("a")
        self.assertEqual(ps.pending(f, st), [])

    def _write_state(self, obj):
        with open(ps.STATE, "w") as f:
            json.dump(obj, f)

    def test_state_file_missing_keys_is_repaired_on_load(self):
        # a hand-edited or older state file without "acked"/"delivered" made
        # `ack`, `list` and `run` crash with KeyError
        for raw in ({"delivered": {"x": 1.0}}, {"acked": ["y"]}, {}, [], "junk"):
            self._write_state(raw)
            st = ps.load_state()
            self.assertIsInstance(st.get("delivered"), dict, f"state loaded from {raw!r}: delivered = {st.get('delivered')!r}")
            self.assertIsInstance(st.get("acked"), list, f"state loaded from {raw!r}: acked = {st.get('acked')!r}")
            ps.pending([{"id": "z", "severity": "info", "suggestion": "s"}], st)  # must not raise
        self._write_state({"delivered": {"x": 1.0}})
        self.assertEqual(ps.load_state()["delivered"], {"x": 1.0}, "existing delivered map should survive the repair")

    def test_cli_ack_on_state_without_acked_key(self):
        self._write_state({"delivered": {"disk-root-warn": 1.0}})
        old = sys.argv
        try:
            sys.argv = ["proactive_scan.py", "ack", "disk-root-warn"]
            self.assertEqual(ps.main(), 0, "ack should succeed on a state file lacking 'acked'")
        finally:
            sys.argv = old
        with open(ps.STATE) as f:
            saved = json.load(f)
        self.assertEqual(saved.get("acked"), ["disk-root-warn"], f"saved state: {saved!r}")

    def _disk_ids(self, used_pct):
        class _St:
            f_blocks = 1000
            f_bfree = 1000 - used_pct * 10
        orig = ps.os.statvfs
        ps.os.statvfs = lambda _p: _St()
        try:
            return [f["id"] for f in ps.src_disk()]
        finally:
            ps.os.statvfs = orig

    def test_disk_finding_id_is_stable_within_a_band(self):
        # the id used to embed the integer percent, so 91% -> 92% re-alerted
        # despite the 7-day TTL and an ack of the 91% finding silenced nothing
        self.assertEqual(self._disk_ids(85), [], "85% is under the 90% threshold")
        warn91, warn94 = self._disk_ids(91), self._disk_ids(94)
        self.assertEqual(warn91, warn94, "91% and 94% are the same warn band: same ids, no re-alert")
        st = ps.load_state()
        f91 = [{"id": i, "severity": "warn", "suggestion": "s"} for i in warn91]
        self.assertEqual(len(ps.pending(f91, st)), 2, "first scan delivers home + root")
        f94 = [{"id": i, "severity": "warn", "suggestion": "s"} for i in warn94]
        self.assertEqual(ps.pending(f94, st), [], "growth within the band must not re-alert inside the TTL")
        action96 = self._disk_ids(96)
        self.assertFalse(set(action96) & set(warn91), f"crossing into the action band should alert again: {warn91} vs {action96}")

    def test_git_source_on_temp_repo(self):
        d = os.path.join(self.tmp.name, "repo")
        subprocess.run(["git", "init", "-q", d], check=True)
        subprocess.run(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t",
                        "commit", "-q", "--allow-empty", "-m", "x"], check=True)
        old = ps.REPOS_DIR
        ps.REPOS_DIR = os.path.join(self.tmp.name)  # contains repo/ with .git
        try:
            found = ps.src_git()
        finally:
            ps.REPOS_DIR = old
        ids = {f["id"] for f in found}
        self.assertIn("git-unpushed-repo", ids, f"no-remote commit should be unpushed; got {ids}")
        self.assertNotIn("git-dirty-repo", ids, f"empty commit leaves a clean tree; got {ids}")

    def _scan_feed(self, body: str, st: dict | None = None) -> list[dict]:
        feed = os.path.join(self.tmp.name, "feed.xml")
        with open(feed, "w") as f:
            f.write(body)
        with open(ps.FEEDS, "w") as f:
            json.dump([{"url": "file://" + feed, "name": "blog"}], f)
        return ps.src_rss(st if st is not None else {})

    def test_rss2_items_become_findings_once(self):
        body = ("<rss version='2.0'><channel><title>t</title>"
                "<item><title>Post A</title><link>https://ex.test/a</link></item>"
                "</channel></rss>")
        st: dict = {}
        found = self._scan_feed(body, st)
        self.assertEqual([f["suggestion"] for f in found], ["blog: Post A"],
                         f"RSS 2.0 item should become one finding; got {found}")
        self.assertEqual(found[0]["detail"], "https://ex.test/a")
        self.assertEqual(self._scan_feed(body, st), [], "an item already seen must not re-surface")

    def test_atom_entries_become_findings(self):
        body = ("<?xml version='1.0'?><feed xmlns='http://www.w3.org/2005/Atom'><title>t</title>"
                "<entry><title>Release v2</title>"
                "<link rel='replies' href='https://ex.test/v2#comments'/>"
                "<link rel='alternate' href='https://ex.test/v2'/></entry>"
                "<entry><title>Bare</title><link href='https://ex.test/bare'/></entry>"
                "</feed>")
        found = self._scan_feed(body)
        got = [(f["suggestion"], f.get("detail")) for f in found]
        self.assertEqual(got, [("blog: Release v2", "https://ex.test/v2"),
                               ("blog: Bare", "https://ex.test/bare")],
                         "Atom <entry> should be read with its rel=alternate (or rel-less) link")

    def test_rss1_rdf_items_become_findings(self):
        body = ("<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#' "
                "xmlns='http://purl.org/rss/1.0/'><channel><title>t</title></channel>"
                "<item><title>Paper</title><link>https://ex.test/p</link></item></rdf:RDF>")
        found = self._scan_feed(body)
        self.assertEqual([f.get("detail") for f in found], ["https://ex.test/p"],
                         f"RSS 1.0 (RDF) <item> should become a finding; got {found}")

    def test_unreachable_feed_is_a_warning_not_a_crash(self):
        with open(ps.FEEDS, "w") as f:
            json.dump([{"url": "file://" + os.path.join(self.tmp.name, "missing.xml")}], f)
        found = ps.src_rss({})
        self.assertEqual([f["severity"] for f in found], ["warn"], f"got {found}")
        self.assertTrue(found[0]["id"].startswith("rss-dead-"), found[0]["id"])


class GoalsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._dir = goals.GOALS_DIR
        goals.GOALS_DIR = self.tmp.name

    def tearDown(self):
        goals.GOALS_DIR = self._dir
        self.tmp.cleanup()

    def test_full_cycle(self):
        rc = goals.main.__wrapped__ if hasattr(goals.main, "__wrapped__") else None
        # drive the CLI through subprocess-free function calls
        goals.save("g", {"title": "Ship it", "why": "because", "created": "2026-10-08", "milestones": []})
        g = goals.load("g")
        g["milestones"].append({"title": "m1", "due": "2026-10-15", "done": False, "done_at": None})
        goals.save("g", g)
        done, total = goals.progress(goals.load("g"))
        self.assertEqual((done, total), (0, 1))
        line = goals.summary_line("g", goals.load("g"), 1760000000.0)
        self.assertIn("0/1", line)
        self.assertFalse("OVERDUE" in line)  # due 2026-10-15 > now-ish test time only if before due
        goals.save("g2", {"title": "Overdue", "created": "x",
                          "milestones": [{"title": "late", "due": "2020-01-01", "done": False}]})
        self.assertIn("OVERDUE", goals.summary_line("g2", goals.load("g2"), 1760000000.0))

    def test_cli_add_and_checkin(self):
        # exercise the parser via direct argv manipulation
        old = sys.argv
        try:
            sys.argv = ["goals.py", "add", "Test goal", "--why", "w"]
            self.assertEqual(goals.main(), 0)
            sys.argv = ["goals.py", "milestone", "test-goal", "add", "step 1", "--due", "2026-12-01"]
            self.assertEqual(goals.main(), 0)
            sys.argv = ["goals.py", "checkin"]
            self.assertEqual(goals.main(), 0)
            sys.argv = ["goals.py", "milestone", "test-goal", "done", "1"]
            self.assertEqual(goals.main(), 0)
            g = goals.load("test-goal")
            self.assertTrue(g["milestones"][0]["done"])
        finally:
            sys.argv = old


if __name__ == "__main__":
    unittest.main(verbosity=2)
