#!/usr/bin/env python3
"""Behaviour of scripts/test-agent, the runner CI's validate job calls.

Run directly:  python scripts/test_test_agent.py  (exits non-zero on failure)

Seen red by: making locate() return the check's file only (the file:line case
fails), making find_unlisted report nothing (the unlisted case fails), and passing os.environ through unchanged (the HOME case fails).
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_loader = importlib.machinery.SourceFileLoader("test_agent", str(HERE / "test-agent"))
_spec = importlib.util.spec_from_loader("test_agent", _loader)
ta = importlib.util.module_from_spec(_spec)
sys.modules["test_agent"] = ta  # dataclasses looks its module up here
_loader.exec_module(ta)


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "repo"
        self.root.mkdir()
        self.report = self.root / ".test-report"

    def tearDown(self):
        self._tmp.cleanup()

    def script(self, rel: str, body: str) -> str:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        return rel

    def run_checks(self, checks):
        rc = ta.run(checks, self.root, self.report, guard=False)
        summary = (self.report / "summary.md").read_text(encoding="utf-8")
        return rc, summary

    def test_failure_names_check_file_line_excerpt_and_rerun_command(self):
        rel = self.script("suite/test_widget.py",
                          "def check():\n"
                          "    assert 1 + 1 == 3, 'expected 3, actual 2 for input 1+1'\n"
                          "check()\n")
        rc, summary = self.run_checks([ta.Check("widget", [ta.PY, rel], "widgets add up")])
        self.assertEqual(rc, 1, f"a failing check must exit 1; summary:\n{summary}")
        self.assertIn("## FAIL widget", summary)
        self.assertIn("`suite/test_widget.py:2`", summary,
                      f"summary should point at the failing assert line; got:\n{summary}")
        self.assertIn("expected 3, actual 2 for input 1+1", summary)
        self.assertIn("HOME=\"$(mktemp -d)\" TZ=UTC python3 suite/test_widget.py", summary)
        self.assertIn("logs/widget.log", summary)
        self.assertIn("widgets add up", summary, "the gate's reason should be in the summary")
        data = json.loads((self.report / "results.json").read_text())
        self.assertEqual((data["passed"], data["failed"]), (False, 1), data)
        junit = (self.report / "junit.xml").read_text()
        self.assertIn('<failure message="suite/test_widget.py:2"', junit)

    def test_all_passing_exits_zero_and_says_so(self):
        rel = self.script("ok.py", "print('fine')\n")
        rc, summary = self.run_checks([ta.Check("a", [ta.PY, rel], ""),
                                       ta.Check("b", [ta.PY, rel], "")])
        self.assertEqual(rc, 0, summary)
        self.assertIn("All 2 checks passed", summary)
        self.assertNotIn("## FAIL", summary)

    def test_every_check_gets_a_fresh_home_utc_and_no_hermes_env(self):
        rel = self.script("env.py",
                          "import os, sys\n"
                          f"real = {str(Path.home())!r}\n"
                          "home = os.environ['HOME']\n"
                          "assert home != real and os.path.isdir(home) and not os.listdir(home), home\n"
                          "assert os.environ['TZ'] == 'UTC', os.environ['TZ']\n"
                          "assert not [k for k in os.environ if k.startswith('HERMES_')]\n")
        os.environ["HERMES_HOME"] = str(Path.home() / ".hermes")
        try:
            rc, summary = self.run_checks([ta.Check("env", [ta.PY, rel], "")])
        finally:
            del os.environ["HERMES_HOME"]
        self.assertEqual(rc, 0, f"check saw the real environment:\n{summary}")

    def test_a_hang_is_killed_and_reported_as_a_timeout(self):
        rel = self.script("hang.py", "import time\nprint('started')\ntime.sleep(60)\n")
        check = ta.Check("hang", [ta.PY, rel], "", timeout=1)
        rc, summary = self.run_checks([check])
        self.assertEqual(rc, 1, summary)
        self.assertIn("timed out after 1 s", summary)

    def test_unlisted_test_file_is_reported_and_generated_copies_are_not(self):
        checks = [ta.Check("listed", [ta.PY, "tools/test_listed.py"], "")]
        paths = ["tools/test_listed.py", "tools/test_new.py", "workflows/_x.test.js",
                 ".claude/skills/s/scripts/test_copy.py", "tools/helper.py", "README.md"]
        self.assertEqual(ta.find_unlisted(paths, checks),
                         ["tools/test_new.py", "workflows/_x.test.js"])

    def test_explicit_covers_counts_as_run(self):
        checks = [ta.Check("discover", [ta.PY, "-m", "unittest", "discover", "-s", "d"], "",
                           covers=["d/test_a.py"])]
        self.assertEqual(ta.find_unlisted(["d/test_a.py"], checks), [])

    def test_real_check_list_runs_every_test_file_in_this_repo(self):
        unlisted = ta.find_unlisted(ta.repo_files(ta.ROOT), ta.CHECKS)
        self.assertEqual(unlisted, [], f"add these to CHECKS in scripts/test-agent: {unlisted}")


if __name__ == "__main__":
    unittest.main()
