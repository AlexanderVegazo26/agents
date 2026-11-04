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
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import triggerd  # noqa: E402

# Test-only HMAC key, never a real credential. The marker excuses this one line
# from the secret scan (gitleaks generic-api-key); a path allowlist would excuse
# the whole file, and .gitleaks.toml asks for the narrowest excuse that works.
SECRET = "test-secret-0123456789abcdef"  # gitleaks:allow


def read_lines(p: str) -> list[str]:
    with open(p) as f:
        return f.read().splitlines()


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
        cls.httpd.server_close()
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
        n0 = len(read_lines(self.calls)) if os.path.exists(self.calls) else 0
        code, data = self.post("/github/gh", payload,
                               {"x-github-event": "issues", "x-hub-signature-256": sign(payload)})
        self.assertEqual(code, 200, data)
        self.assertTrue(data["matched"])
        # dispatch runs synchronously before the response is sent: no wait needed
        calls = read_lines(self.calls)
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


class TriggerdCliTest(unittest.TestCase):
    """The management CLI (add-*/list/remove/test) against a temp config.

    triggerd.CONFIG and triggerd.LOG are module constants, so each test points
    them at a fresh temp dir: the real ~/.hermes is never read or written.
    """

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.cfg_path = os.path.join(tmp.name, "home", "triggers.json")
        self.log_path = os.path.join(tmp.name, "home", "state", "triggerd.log")
        self.tmp = tmp.name
        for name, val in (("CONFIG", self.cfg_path), ("LOG", self.log_path)):
            old = getattr(triggerd, name)
            setattr(triggerd, name, val)
            self.addCleanup(setattr, triggerd, name, old)

    def run_cli(self, *argv, stdin: bytes | None = None):
        """Run triggerd.main() with argv; return (exit code, stdout, stderr)."""
        import contextlib
        import io
        out, err = io.StringIO(), io.StringIO()
        old_argv, old_stdin = sys.argv, sys.stdin
        sys.argv = ["triggerd.py", *argv]
        if stdin is not None:
            sys.stdin = io.TextIOWrapper(io.BytesIO(stdin))
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = triggerd.main()
        finally:
            sys.argv, sys.stdin = old_argv, old_stdin
        return code, out.getvalue(), err.getvalue()

    def rules(self) -> list[dict]:
        with open(self.cfg_path) as f:
            return json.load(f)["rules"]

    def payload_file(self, payload: dict) -> str:
        p = os.path.join(self.tmp, "payload.json")
        with open(p, "w") as f:
            json.dump(payload, f)
        return p

    def add_github(self, rule_id="gh", *extra):
        return self.run_cli("add-github", rule_id, "--job", "pr-reviewer",
                            "--secret-env", "TRIGGER_SECRET_GH", *extra)

    def test_add_github_creates_config_with_only_the_given_match_fields(self):
        code, out, _ = self.add_github("gh", "--event", "issues", "--action", "opened",
                                       "--repo", "o/r", "--json-path", "issue.title",
                                       "--contains", "urgent")
        self.assertEqual(code, 0)
        self.assertIn("1 rules total", out)
        self.assertEqual(self.rules(), [{
            "id": "gh", "source": "github", "secret_env": "TRIGGER_SECRET_GH",
            "match": {"event": "issues", "action": "opened", "repo": "o/r",
                      "json_path": "issue.title", "contains": "urgent"},
            "job": "pr-reviewer", "notify": True}])

    def test_add_generic_with_command_and_no_notify(self):
        code, _, _ = self.run_cli("add-generic", "gen", "--job", "e2e", "--secret-env", "S",
                                  "--json-path", "status", "--equals", "failed",
                                  "--command", "echo hi", "--no-notify")
        self.assertEqual(code, 0)
        rule = self.rules()[0]
        self.assertEqual((rule["source"], rule["notify"], rule["command"]), ("generic", False, "echo hi"))
        self.assertEqual(rule["match"], {"json_path": "status", "equals": "failed"})

    def test_adding_an_existing_id_replaces_the_rule(self):
        self.add_github("gh", "--event", "push")
        code, out, _ = self.add_github("gh", "--event", "issues")
        self.assertEqual(code, 0)
        self.assertIn("1 rules total", out)
        self.assertEqual([r["match"] for r in self.rules()], [{"event": "issues"}],
                         "re-adding rule 'gh' should replace it, not append a second one")

    def test_remove_reports_how_many_rules_went(self):
        self.add_github("a")
        self.add_github("b")
        code, out, _ = self.run_cli("remove", "a")
        self.assertEqual((code, out.strip()), (0, "removed 1 rule(s)"))
        self.assertEqual([r["id"] for r in self.rules()], ["b"])
        _, out, _ = self.run_cli("remove", "missing")
        self.assertEqual(out.strip(), "removed 0 rule(s)")

    def test_commands_other_than_serve_fail_clearly_without_a_config(self):
        code, out, err = self.run_cli("list")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn(self.cfg_path, err)
        self.assertIn("add-github/add-generic", err)
        self.assertFalse(os.path.exists(self.cfg_path), "a failed list must not create the config")

    def test_list_prints_rules_then_recent_deliveries(self):
        self.add_github("gh", "--event", "push")
        triggerd.log_event({"rule": "gh", "ok": True})
        code, out, _ = self.run_cli("list")
        self.assertEqual(code, 0)
        rules_part, deliveries = out.split("--- recent deliveries ---\n")
        self.assertEqual(json.loads(rules_part)[0]["id"], "gh")
        self.assertEqual(json.loads(deliveries.strip())["rule"], "gh")

    def test_list_without_a_delivery_log_still_works(self):
        self.add_github("gh")
        code, out, _ = self.run_cli("list")
        self.assertEqual(code, 0)
        self.assertTrue(out.endswith("--- recent deliveries ---\n"), out)

    def test_test_matching_payload_dry_runs_without_dispatching(self):
        self.run_cli("add-generic", "gen", "--job", "e2e", "--secret-env", "S",
                     "--json-path", "status", "--equals", "failed", "--command", "touch NEVER")
        p = self.payload_file({"status": "failed"})
        code, out, _ = self.run_cli("test", "gen", p)
        self.assertEqual(code, 0, out)
        self.assertTrue(out.startswith("match: True (matched)"), out)
        result = json.loads(out.split("\n", 1)[1])
        self.assertEqual((result["rule"], result["job"], result["dry_run"]), ("gen", "e2e", True))
        self.assertNotIn("dispatch", result, "test must never run the hermes job")
        self.assertNotIn("command", result, "test must never run the rule's shell command")

    def test_dry_run_reaches_serve_before_or_after_the_subcommand(self):
        calls = []
        old = triggerd.serve
        triggerd.serve = lambda cfg, **kw: calls.append(kw)
        self.addCleanup(setattr, triggerd, "serve", old)
        for argv in (["--dry-run", "serve", "--once"], ["serve", "--once", "--dry-run"], ["serve", "--once"]):
            code, out, err = self.run_cli(*argv)
            self.assertEqual(code, 0, f"{argv}: {out}{err}")
        self.assertEqual([kw["dry_run"] for kw in calls], [True, True, False],
                         f"dry_run passed to serve() for each argv; calls={calls}")

    def test_test_non_matching_payload_exits_1_and_says_why(self):
        self.run_cli("add-generic", "gen", "--job", "e2e", "--secret-env", "S",
                     "--json-path", "status", "--equals", "failed")
        code, out, _ = self.run_cli("test", "gen", self.payload_file({"status": "ok"}))
        self.assertEqual(code, 1)
        self.assertEqual(out.strip(), "match: False (status='ok' != 'failed')")

    def test_test_reads_the_payload_from_stdin_and_honours_event(self):
        self.add_github("gh", "--event", "push")
        body = json.dumps({"ref": "x"}).encode()
        code, out, _ = self.run_cli("test", "gh", "-", "--event", "push", stdin=body)
        self.assertEqual(code, 0, out)
        code, out, _ = self.run_cli("test", "gh", "-", "--event", "issues", stdin=body)
        self.assertEqual(code, 1)
        self.assertIn("event 'issues' != 'push'", out)

    def test_test_unknown_rule_exits_1(self):
        self.add_github("gh")
        code, _, err = self.run_cli("test", "nope", self.payload_file({}))
        self.assertEqual(code, 1)
        self.assertIn("no rule 'nope'", err)


class TriggerdServeOnceCliTest(unittest.TestCase):
    """`triggerd.py --dry-run serve --once` as a real process.

    HOME is a temp dir (triggerd reads ~/.hermes at import), a fake `hermes`
    on PATH records cron dispatches, and the config asks for port 0 so the OS
    picks a free one; the "listening on" line says which.
    """

    TIMEOUT = 15

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = tmp.name
        hermes = os.path.join(self.home, ".hermes")
        os.makedirs(os.path.join(hermes, "state"))
        bindir = os.path.join(self.home, "bin")
        os.makedirs(bindir)
        self.calls = os.path.join(self.home, "calls.jsonl")
        fake = os.path.join(bindir, "hermes")
        with open(fake, "w") as f:
            f.write(f"#!{sys.executable}\nimport json,sys\n"
                    f"open({self.calls!r},'a').write(json.dumps(sys.argv[1:])+'\\n')\n")
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        with open(os.path.join(hermes, "triggers.json"), "w") as f:
            json.dump({"host": "127.0.0.1", "port": 0, "rules": [
                {"id": "gen", "source": "generic", "secret_env": "TRIGGER_SECRET_DEPLOY",
                 "match": {"json_path": "status", "equals": "failed"},
                 "job": "e2e-smoke-run", "notify": True}]}, f)
        with open(os.path.join(hermes, ".env"), "w") as f:
            f.write(f"TRIGGER_SECRET_DEPLOY={SECRET}\n")
        self.log = os.path.join(hermes, "state", "triggerd.log")
        self.env = {"HOME": self.home, "PATH": bindir + os.pathsep + os.environ.get("PATH", ""),
                    "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"}

    def start(self):
        import subprocess
        script = os.path.join(os.path.dirname(HERE), "triggerd.py")
        proc = subprocess.Popen([sys.executable, script, "--dry-run", "serve", "--once"],
                                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        self.addCleanup(lambda: proc.poll() is None and (proc.kill(), proc.wait()))
        line = proc.stdout.readline()
        self.assertIn("triggerd listening on http://127.0.0.1:", line,
                      f"serve should announce its address first; stderr: {proc.stderr.read() if not line else ''}")
        port = int(line.split("http://127.0.0.1:", 1)[1].split()[0])
        return proc, port

    def post(self, port, body: bytes, sig: str):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=self.TIMEOUT)
        conn.request("POST", "/hook/gen", body=body,
                     headers={"content-type": "application/json", "x-trigger-signature": sig})
        r = conn.getresponse()
        data = json.loads(r.read().decode())
        conn.close()
        return r.status, data

    def wait_exit(self, proc) -> tuple[int, str]:
        import subprocess
        try:
            out, err = proc.communicate(timeout=self.TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
            self.fail(f"serve --once still running {self.TIMEOUT}s after its one request "
                      f"(it must exit); stdout={out!r} stderr={err!r}")
        self.assertEqual(proc.returncode, 0, f"serve --once exit code; stderr={err!r}")
        return out, err

    def test_once_dispatches_the_matching_delivery_then_exits(self):
        proc, port = self.start()
        body = json.dumps({"status": "failed", "issue": {"title": "deploy 42 failed"}}).encode()
        status, data = self.post(port, body, sign(body))
        self.assertEqual((status, data.get("matched"), data.get("ok")), (200, True, True),
                         f"signed matching delivery, secret from ~/.hermes/.env; reply={data}")
        out, _ = self.wait_exit(proc)
        self.assertEqual(read_lines(self.calls), ['["cron", "run", "e2e-smoke-run"]'],
                         "the rule's job should be fired once through `hermes cron run`")
        self.assertIn("[dry-run] 🔔 trigger gen: deploy 42 failed -> job e2e-smoke-run", out,
                      "--dry-run should reach the notifier (printed, not sent)")
        recs = [json.loads(l) for l in read_lines(self.log)]
        self.assertEqual([("startup" in r, r.get("rule"), r.get("matched")) for r in recs],
                         [(True, None, None), (False, "gen", True)],
                         f"log should hold the startup record then the delivery; log={recs}")

    def test_once_also_exits_after_a_rejected_delivery(self):
        proc, port = self.start()
        body = b'{"status": "failed"}'
        status, data = self.post(port, body, sign(body, "wrong-secret"))
        self.assertEqual(status, 403, f"bad signature should be refused; reply={data}")
        self.wait_exit(proc)
        self.assertFalse(os.path.exists(self.calls), "a refused delivery must not dispatch")


if __name__ == "__main__":
    unittest.main(verbosity=2)
