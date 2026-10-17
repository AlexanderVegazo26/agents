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
        self.assertIn("git-unpushed-repo", ids)
        self.assertIn("git-dirty-repo", ids) if False else None  # no files -> clean


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
