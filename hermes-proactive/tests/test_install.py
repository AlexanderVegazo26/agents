#!/usr/bin/env python3
"""Tests for install.sh — run: python3 tests/test_install.py

install.sh writes only under $HOME/.hermes (and $HOME/.config/systemd/user),
so each case points HOME at a fresh temp directory: nothing here touches a
real ~/.hermes. Before 2026-11-13 the script never created ~/.hermes/scripts
and aborted on a fresh HOME at the first `install` into it.
"""

import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.join(os.path.dirname(HERE), "install.sh")


def run_install(home):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home}
    return subprocess.run(["bash", INSTALL], env=env, capture_output=True, text=True, timeout=60)


class FreshHomeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name

    def test_installs_into_an_empty_home(self):
        r = run_install(self.home)
        self.assertEqual(r.returncode, 0, r.stderr)
        scripts = os.path.join(self.home, ".hermes", "scripts")
        for name in ("condition_monitor.py", "triggerd.py", "proactive_scan.py", "goals.py",
                     "watchdog_run.sh", "proactive_digest.sh", os.path.join("hp", "notify.py")):
            self.assertTrue(os.path.isfile(os.path.join(scripts, name)), name)
        self.assertTrue(os.path.isfile(os.path.join(self.home, ".hermes", "triggers.json")))

    def test_is_idempotent(self):
        self.assertEqual(run_install(self.home).returncode, 0)
        r = run_install(self.home)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
