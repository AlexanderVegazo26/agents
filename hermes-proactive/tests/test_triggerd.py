#!/usr/bin/env python3
"""Smoke tests for triggerd.py — run: python3 tests/test_triggerd.py

Spawns triggerd in --once mode against a temp config and fires signed +
unsigned requests at it.  Dispatch is shimmed: a fake `hermes` earlier in PATH
records invocations instead of running the real CLI.
"""

import hashlib
import hmac
import http.client
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import triggerd  # noqa: E402

# Test-only HMAC key, never a real credential. The marker excuses this one line
# from the secret scan (gitleaks generic-api-key); a path allowlist would excuse
# the whole file, and .gitleaks.toml asks for the narrowest excuse that works.
SECRET = "test-secret-0123456789abcdef"  # gitleaks:allow


def sign(body: bytes, secret: str = SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


class TriggerdTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cfgdir = os.path.join(cls.tmp.name, "hermes-home")
        os.makedirs(os.path.join(cls.cfgdir, "state"))
        os.makedirs(os.path.join(cls.cfgdir, "scripts"))
        # fake `hermes` CLI that records cron run calls
        bindir = os.path.join(cls.tmp.name, "bin")
        os.makedirs(bindir)
        cls.calls = os.path.join(cls.tmp.name, "calls.jsonl")
        fake = os.path.join(bindir, "hermes")
        with open(fake, "w") as f:
            f.write(f"#!/usr/bin/env python3\nimport json,sys\n"
                    f"open({cls.calls!r},'a').write(json.dumps(sys.argv[1:])+'\\n')\n"
                    f"print('dispatched')")
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        cls.old_path = os.environ.get("PATH", "")
        os.environ["PATH"] = bindir + os.pathsep + cls.old_path

        cls.cfg = {"host": "127.0.0.1", "port": 0, "rules": [
            {"id": "gh", "source": "github", "secret_env": "TRIGGER_SECRET_GH",
             "match": {"event": "issues", "action": "opened", "repo": "o/r",
                       "json_path": "issue.title", "contains": "urgent"},
             "job": "pr-reviewer", "notify": False},
            {"id": "gen", "source": "generic", "secret_env": "TRIGGER_SECRET_DEPLOY",
             "match": {"json_path": "status", "equals": "failed"},
             "job": "e2e-smoke-run", "notify": False},
        ]}
        os.environ["TRIGGER_SECRET_GH"] = SECRET
        os.environ["TRIGGER_SECRET_DEPLOY"] = SECRET
        cls.log = os.path.join(cls.cfgdir, "state", "triggerd.log")
        triggerd.LOG = cls.log

        cls.httpd = triggerd.ThreadingHTTPServer(("127.0.0.1", 0), triggerd.Handler)
        cls.httpd.cfg, cls.httpd.environ, cls.httpd.once, cls.httpd.dry_run = cls.cfg, os.environ, False, True
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        os.environ["PATH"] = cls.old_path
        cls.tmp.cleanup()

    def post(self, path, body, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        hdrs = {"content-type": "application/json"}
        hdrs.update(headers or {})
        conn.request("POST", path, body=body, headers=hdrs)
        r = conn.getresponse()
        data = json.loads(r.read().decode())
        conn.close()
        return r.status, data

    def test_github_signed_match_dispatches(self):
        payload = json.dumps({"action": "opened",
                              "repository": {"full_name": "o/r"},
                              "issue": {"title": "URGENT: prod is down"}}).encode()
        n0 = len(open(self.calls).read().splitlines()) if os.path.exists(self.calls) else 0
        code, data = self.post("/github/gh", payload,
                               {"x-github-event": "issues", "x-hub-signature-256": sign(payload)})
        self.assertEqual(code, 200, data)
        self.assertTrue(data["matched"])
        time.sleep(0.2)
        calls = open(self.calls).read().splitlines()
        self.assertEqual(json.loads(calls[-1]), ["cron", "run", "pr-reviewer"])

    def test_github_bad_signature_rejected(self):
        payload = json.dumps({"action": "opened", "repository": {"full_name": "o/r"},
                              "issue": {"title": "urgent"}}).encode()
        code, _ = self.post("/github/gh", payload,
                            {"x-github-event": "issues", "x-hub-signature-256": "sha256=deadbeef"})
        self.assertEqual(code, 403)

    def test_github_filter_mismatch_skips(self):
        payload = json.dumps({"action": "opened", "repository": {"full_name": "o/r"},
                              "issue": {"title": "minor typo"}}).encode()
        code, data = self.post("/github/gh", payload,
                               {"x-github-event": "issues", "x-hub-signature-256": sign(payload)})
        self.assertEqual(code, 200)
        self.assertFalse(data["matched"])

    def test_generic_equals_match(self):
        payload = json.dumps({"status": "failed", "service": "api"}).encode()
        code, data = self.post("/hook/gen", payload, {"x-trigger-signature": sign(payload)})
        self.assertEqual(code, 200, data)
        self.assertTrue(data["matched"])

    def test_wrong_endpoint_for_source(self):
        payload = json.dumps({"status": "failed"}).encode()
        code, _ = self.post("/github/gen", payload, {"x-trigger-signature": sign(payload)})
        self.assertEqual(code, 400)

    def test_healthz(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/healthz")
        r = conn.getresponse()
        self.assertEqual(r.status, 200)
        conn.close()

    def test_rule_matches_unit(self):
        rule = {"source": "github", "match": {"event": "push", "json_path": "ref", "regex": r"refs/heads/main"}}
        ok, _ = triggerd.rule_matches(rule, event="push", payload={"ref": "refs/heads/main"})
        self.assertTrue(ok)
        ok, why = triggerd.rule_matches(rule, event="pull_request", payload={"ref": "refs/heads/main"})
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main(verbosity=2)
