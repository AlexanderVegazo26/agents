#!/usr/bin/env python3
"""Tests for hp/notify.py — run: python3 tests/test_notify.py

hp.notify is how triggerd, condition_monitor and proactive_scan reach Telegram.
tg_send.py is replaced by a fake script in a temp dir that records its argv and
exits with a chosen code, so nothing here touches the network or ~/.hermes.
"""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from hp import notify  # noqa: E402


class SendMessageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.argv_log = os.path.join(self.tmp.name, "argv.json")
        self.fake = os.path.join(self.tmp.name, "tg_send.py")
        self.write_fake(exit_code=0)
        patcher = mock.patch.object(notify, "TG_SEND", self.fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_fake(self, exit_code: int, stderr: str = "", stdout: str = "") -> None:
        with open(self.fake, "w") as f:
            f.write(
                "import json, sys\n"
                f"json.dump(sys.argv[1:], open({self.argv_log!r}, 'w'))\n"
                f"sys.stdout.write({stdout!r})\n"
                f"sys.stderr.write({stderr!r})\n"
                f"sys.exit({exit_code})\n")

    def recorded_argv(self):
        self.assertTrue(os.path.exists(self.argv_log),
                        "send_message should have run the fake tg_send.py, but it never ran")
        with open(self.argv_log) as f:
            return json.load(f)

    def send(self, *args, **kwargs):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            ok = notify.send_message(*args, **kwargs)
        return ok, out.getvalue(), err.getvalue()

    def test_hands_text_to_tg_send_and_reports_success(self):
        ok, out, err = self.send("disk 91% on /")
        self.assertIs(ok, True, f"exit 0 from tg_send should return True; stderr={err!r}")
        self.assertEqual(self.recorded_argv(), ["message", "disk 91% on /"],
                         "tg_send argv for a plain message")
        self.assertEqual(out, "", "a real send should print nothing to stdout")

    def test_passes_chat_and_url_buttons_in_order(self):
        ok, _, err = self.send("price drop", chat="-100123",
                               buttons=[("Open", "https://a.example/x"),
                                        ("Ack", "https://b.example/y?id=1")])
        self.assertIs(ok, True, f"stderr={err!r}")
        self.assertEqual(
            self.recorded_argv(),
            ["message", "price drop", "--chat", "-100123",
             "--url", "Open|https://a.example/x", "--url", "Ack|https://b.example/y?id=1"],
            "chat must follow the text and each button must become one --url 'label|url'")

    def test_text_that_looks_like_a_flag_stays_one_argument(self):
        ok, _, _ = self.send("--chat evil; rm -rf /")
        self.assertIs(ok, True)
        self.assertEqual(self.recorded_argv(), ["message", "--chat evil; rm -rf /"],
                         "message text must reach tg_send as a single argv item (no shell)")

    def test_dry_run_prints_and_never_runs_tg_send(self):
        ok, out, _ = self.send("hello", dry_run=True, chat="1")
        self.assertIs(ok, False, "dry-run returns False: nothing was handed off")
        self.assertEqual(out, "[dry-run] hello\n", "dry-run stdout")
        self.assertFalse(os.path.exists(self.argv_log), "dry-run must not run tg_send.py")

    def test_missing_tg_send_falls_back_to_stdout(self):
        os.remove(self.fake)
        ok, out, _ = self.send("hello")
        self.assertIs(ok, False, "a missing tg_send.py must return False")
        self.assertEqual(out, "[tg_send missing] hello\n", "fallback stdout")

    def test_nonzero_exit_returns_false_and_reports_stderr(self):
        self.write_fake(exit_code=1, stderr="  401 Unauthorized \n")
        ok, _, err = self.send("hello")
        self.assertIs(ok, False, "a failing tg_send must return False")
        self.assertEqual(err, "tg_send failed: 401 Unauthorized\n",
                         "the failure line should carry tg_send's stripped stderr")

    def test_nonzero_exit_with_empty_stderr_reports_stdout(self):
        self.write_fake(exit_code=2, stdout="bad chat id\n")
        ok, _, err = self.send("hello")
        self.assertIs(ok, False)
        self.assertEqual(err, "tg_send failed: bad chat id\n",
                         "with empty stderr the failure line falls back to stdout")

    def test_timeout_returns_false(self):
        boom = subprocess.TimeoutExpired(cmd="tg_send", timeout=30)
        with mock.patch.object(notify.subprocess, "run", side_effect=boom) as run:
            ok, _, err = self.send("hello")
        self.assertIs(ok, False, "a timed-out tg_send must return False, not raise")
        self.assertEqual(err, "tg_send timed out\n", "timeout stderr")
        self.assertEqual(run.call_args.kwargs.get("timeout"), 30,
                         f"tg_send must be bounded by a timeout; call={run.call_args!r}")


class EnvFlagTest(unittest.TestCase):
    NAME = "HP_TEST_NOTIFY_FLAG"

    def check(self, value, expected):
        env = {} if value is None else {self.NAME: value}
        with mock.patch.dict(os.environ, env, clear=False):
            if value is None:
                os.environ.pop(self.NAME, None)
            self.assertIs(notify.env_flag(self.NAME), expected,
                          f"env_flag with {self.NAME}={value!r}")

    def test_truthy_values(self):
        for v in ("1", "true", "TRUE", "Yes", "on", "  on  "):
            self.check(v, True)

    def test_falsy_and_unset_values(self):
        for v in (None, "", "0", "false", "no", "off", "2", "enabled"):
            self.check(v, False)


if __name__ == "__main__":
    unittest.main()
