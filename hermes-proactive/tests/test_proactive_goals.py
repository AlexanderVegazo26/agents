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


class ProactiveScanCliTest(unittest.TestCase):
    """The `run`/`list`/`ack`/`add-feed`/`test` CLI, with fake sources (no git, disk, network)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._saved = (ps.STATE, ps.FEEDS, dict(ps.SOURCES), ps.send_message)
        ps.STATE = os.path.join(self.tmp.name, "state", "proactive_state.json")
        ps.FEEDS = os.path.join(self.tmp.name, "hermes", "feeds.json")
        self.findings = {
            "git": [{"id": "git-dirty-a", "severity": "info", "source": "git", "suggestion": "a: dirty"}],
            "disk": [{"id": "disk-root-action", "severity": "action", "source": "disk",
                      "suggestion": "/: 97% full", "detail": "du -sh /var"}],
        }
        ps.SOURCES.clear()
        ps.SOURCES.update({n: (lambda n=n: list(self.findings[n])) for n in self.findings})
        self.sent = []
        ps.send_message = lambda text, **kw: self.sent.append((text, kw)) or True

    def tearDown(self):
        ps.STATE, ps.FEEDS, sources, ps.send_message = self._saved
        ps.SOURCES.clear()
        ps.SOURCES.update(sources)
        self.tmp.cleanup()

    def cli(self, *argv):
        import contextlib
        import io
        out = io.StringIO()
        old = sys.argv
        try:
            sys.argv = ["proactive_scan.py", *argv]
            with contextlib.redirect_stdout(out):
                rc = ps.main()
        finally:
            sys.argv = old
        return rc, out.getvalue()

    def saved_state(self):
        with open(ps.STATE) as f:
            return json.load(f)

    def test_run_prints_new_findings_most_severe_first_then_nothing_new(self):
        rc, out = self.cli("run")
        self.assertEqual(rc, 0, out)
        lines = out.splitlines()
        self.assertEqual(lines, ["[ACTION] /: 97% full", "    du -sh /var", "[INFO  ] a: dirty"],
                         f"run output should list action before info, with detail indented:\n{out}")
        self.assertEqual(set(self.saved_state()["delivered"]), {"git-dirty-a", "disk-root-action"},
                         "both findings should be recorded as delivered")
        rc, out = self.cli("run")
        self.assertEqual((rc, out.strip()), (0, "no new findings"), "an immediate re-run must not re-alert")
        self.assertEqual(self.sent, [], "run without --notify must not send anything")

    def test_run_source_filter_scans_only_that_source(self):
        rc, out = self.cli("run", "--source", "git")
        self.assertEqual((rc, out.strip()), (0, "[INFO  ] a: dirty"), f"--source git output:\n{out}")
        self.assertEqual(list(self.saved_state()["delivered"]), ["git-dirty-a"])

    def test_failing_source_becomes_a_warning_finding(self):
        def boom():
            raise RuntimeError("gh not logged in")
        ps.SOURCES["github"] = boom
        rc, out = self.cli("run", "--source", "github")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.strip(), "[WARN  ] source github errored: gh not logged in",
                         "a crashing source should surface as a warn finding, not kill the scan")

    def test_notify_sends_one_message_and_honours_dry_run(self):
        rc, out = self.cli("--dry-run", "run", "--notify")
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(self.sent), 1, f"--notify should send exactly one message; sent {self.sent}")
        text, kw = self.sent[0]
        self.assertTrue(text.startswith("🧭 proactive scan — 2 new finding(s):\n[ACTION] /: 97% full"), text)
        self.assertEqual(kw, {"dry_run": True}, "--dry-run must reach send_message")
        self.cli("run", "--notify")
        self.assertEqual(len(self.sent), 1, "nothing new -> no second message")

    def test_ack_silences_a_finding_and_list_marks_it(self):
        self.cli("run")
        rc, out = self.cli("ack", "git-dirty-a")
        self.assertEqual((rc, out.strip()), (0, "acked 'git-dirty-a'"))
        self.cli("ack", "git-dirty-a")
        self.assertEqual(self.saved_state()["acked"], ["git-dirty-a"], "acking twice must not duplicate the id")
        rc, out = self.cli("list")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.splitlines()[1:], ["  [active] disk-root-action", "  [ACKED ] git-dirty-a"],
                         f"list output:\n{out}")
        # age every delivery past the 7-day TTL and rescan: only the un-acked one re-alerts
        st = self.saved_state()
        st["delivered"] = {k: v - 8 * 86400 for k, v in st["delivered"].items()}
        with open(ps.STATE, "w") as f:
            json.dump(st, f)
        rc, out = self.cli("run")
        self.assertNotIn("a: dirty", out, "an acked finding must stay silent after the TTL")
        self.assertIn("/: 97% full", out, "an un-acked finding re-alerts after the TTL")

    def test_test_dumps_raw_findings_without_touching_state(self):
        rc, out = self.cli("test", "disk")
        self.assertEqual(rc, 0, out)
        self.assertEqual(json.loads(out), self.findings["disk"], "test should print the source's raw findings")
        self.assertFalse(os.path.exists(ps.STATE), "test must not write the state file")

    def test_add_feed_creates_the_file_and_ignores_a_duplicate_url(self):
        rc, out = self.cli("add-feed", "https://ex.test/rss", "--name", "Ex")
        self.assertEqual((rc, out.strip()), (0, "feed added (1 total)"), "add-feed must create a missing parent dir")
        self.cli("add-feed", "https://ex.test/atom")
        rc, out = self.cli("add-feed", "https://ex.test/rss", "--name", "Again")
        self.assertEqual((rc, out.strip()), (0, "feed already registered (2 total)"), out)
        with open(ps.FEEDS) as f:
            feeds = json.load(f)
        self.assertEqual(feeds, [{"url": "https://ex.test/rss", "name": "Ex"},
                                 {"url": "https://ex.test/atom", "name": "https://ex.test/atom"}],
                         "a re-added URL must not be stored twice; name defaults to the URL")


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
