"""Tests for the sdlc plugin's cmdc caller gate (_cmdc_caller_problem): cmdc runs Command Code on the
host, so only the owner on Telegram or an interactive local CLI may use it.

    python3 -m unittest test_cmdc_gate.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent


class CmdcCallerGate(unittest.TestCase):
    """cmdc runs on the host; only the owner on Telegram or an interactive local CLI may use it."""

    def setUp(self):
        import types
        spec = importlib.util.spec_from_file_location("sdlc_plugin_under_test", HERE / "__init__.py")
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.session = {}
        fake = types.ModuleType("gateway.session_context")
        fake.get_session_env = lambda name, default="": self.session.get(name, default)
        gw = types.ModuleType("gateway")
        gw.session_context = fake
        for pt in (mock.patch.dict(sys.modules, {"gateway": gw, "gateway.session_context": fake}),
                   mock.patch.dict(os.environ, {"TELEGRAM_ALLOWED_USERS": "222"}),
                   mock.patch.object(self.m.os, "isatty", lambda fd: True)):
            pt.start()
            self.addCleanup(pt.stop)
        for key in ("HERMES_PLATFORM", "HERMES_SDLC_DEPTH"):
            os.environ.pop(key, None)

    def gate(self, **session):
        self.session = session
        return self.m._cmdc_caller_problem()

    def test_allowed(self):
        self.assertEqual(self.gate(HERMES_SESSION_PLATFORM="telegram", HERMES_SESSION_USER_ID="222"), "")
        self.assertEqual(self.gate(), "")

    def test_refused(self):
        for session in (dict(HERMES_SESSION_PLATFORM="telegram", HERMES_SESSION_USER_ID="999"),
                        dict(HERMES_SESSION_PLATFORM="webhook"), dict(HERMES_SESSION_PLATFORM="api_server"),
                        dict(HERMES_SESSION_SOURCE="kanban"), dict(HERMES_CRON_SESSION="1"),
                        dict(HERMES_CRON_SESSION="1", HERMES_SESSION_PLATFORM="telegram", HERMES_SESSION_USER_ID="222")):
            self.assertNotEqual(self.gate(**session), "", session)
        with mock.patch.dict(os.environ, {"HERMES_SDLC_DEPTH": "1"}):
            self.assertNotEqual(self.gate(), "")
        with mock.patch.object(self.m.os, "isatty", lambda fd: False):
            self.assertNotEqual(self.gate(), "")

    def test_refused_caller_never_reaches_the_runner(self):
        called = []
        with mock.patch.object(self.m, "_run", lambda *a, **k: called.append(a) or ({"ok": True}, "")):
            self.session = {"HERMES_SESSION_PLATFORM": "webhook"}
            out = json.loads(self.m._handle_cmdc({"task": "rm -rf ~", "yolo": True}))
        self.assertFalse(out["success"])
        self.assertEqual(called, [])



if __name__ == "__main__":
    unittest.main()
