#!/usr/bin/env python3
"""triggerd.py — OpenBot-style event triggers for Hermes cron.

OpenBot's "Responsibilities" turn poll-based schedules into event-driven ones:
verified webhooks (HMAC), GitHub/Linear/Sentry-style ingress, payload filters,
then a headless run of the bound job.  Hermes cron is poll-only; triggerd is
the missing ingress — it receives events and fires `hermes cron run <job>`.

Config: ~/.hermes/triggers.json

    {
      "host": "127.0.0.1", "port": 8471,
      "rules": [
        {
          "id": "github-issues-urgent",
          "source": "github",                 # github | generic
          "secret_env": "TRIGGER_SECRET_GH",  # env var NAME holding the HMAC secret
          "match": {"event": "issues", "action": "opened",
                     "repo": "owner/repo",
                     "json_path": "issue.title", "contains": "urgent"},
          "job": "pr-reviewer",               # hermes cron job name (or id)
          "notify": true
        },
        {
          "id": "deploy-hook",
          "source": "generic",
          "secret_env": "TRIGGER_SECRET_DEPLOY",
          "match": {"json_path": "status", "equals": "failed"},
          "job": "e2e-smoke-run",
          "command": "optional extra shell to run after the job fires"
        }
      ]
    }

  * github rules verify X-Hub-Signature-256 (HMAC-SHA256 of the raw body)
    and match X-GitHub-Event against match.event.  Point a GitHub webhook at
    http://<host>:<port>/github/<rule-id> with content-type application/json.
  * generic rules verify X-Trigger-Signature: sha256=<hmac> of the raw body.
    POST to /hook/<rule-id>.
  * match fields are ANDed: event/action/repo (github) plus one payload
    condition — json_path + one of contains | equals | regex | exists:false.
  * Secrets live in ~/.hermes/.env, referenced by NAME — never in this file.

CLI:
  serve [--host H] [--port P] [--once]    run the receiver (--once: handle one
                                          request then exit — used by tests)
  list                                    show rules + recent deliveries
  add-github / add-generic ...            append a rule interactively/flag-wise
  remove <id> | test <id> <payload.json>  dry-run matching without dispatch
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hp.notify import send_message  # noqa: E402

HOME = os.path.expanduser("~")
CONFIG = os.path.join(HOME, ".hermes", "triggers.json")
LOG = os.path.join(HOME, ".hermes", "state", "triggerd.log")
MAX_BODY = 256 * 1024


# ---------------------------------------------------------------- config/env

def env() -> dict:
    e = dict(os.environ)
    p = os.path.join(HOME, ".hermes", ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                e.setdefault(k, v.strip().strip('"\''))
    return e


def load_config() -> dict:
    with open(CONFIG) as f:
        cfg = json.load(f)
    cfg.setdefault("host", "127.0.0.1")
    cfg.setdefault("port", 8471)
    cfg.setdefault("rules", [])
    return cfg


def save_config(cfg: dict) -> None:
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    with open(CONFIG, "w") as f:
        json.dump(cfg, f, indent=1)


def log_event(rec: dict) -> None:
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps({"ts": time.time(), **rec}, default=str) + "\n")


def recent_deliverings(limit: int = 20) -> list[dict]:
    try:
        lines = open(LOG).read().splitlines()[-limit:]
        return [json.loads(l) for l in lines]
    except OSError:
        return []


# ---------------------------------------------------------------- matching

def payload_get(payload, dotted: str):
    cur = payload
    for part in dotted.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def rule_matches(rule: dict, *, event: str | None, payload: dict) -> tuple[bool, str]:
    m = rule.get("match", {})
    if rule.get("source") == "github":
        want = m.get("event")
        if want and event != want:
            return False, f"event {event!r} != {want!r}"
        if m.get("action") and payload.get("action") != m["action"]:
            return False, f"action {payload.get('action')!r} != {m['action']!r}"
        repo = (payload.get("repository") or {}).get("full_name")
        if m.get("repo") and repo != m["repo"]:
            return False, f"repo {repo!r} != {m['repo']!r}"
    jp = m.get("json_path")
    if jp:
        val = payload_get(payload, jp)
        if "exists" in m:
            if (val is not None) != bool(m["exists"]):
                return False, f"{jp} exists={val is not None}"
        if "equals" in m and str(val) != str(m["equals"]):
            return False, f"{jp}={val!r} != {m['equals']!r}"
        if "contains" in m and str(m["contains"]).lower() not in str(val).lower():
            return False, f"{jp} lacks {m['contains']!r}"
        if "regex" in m and not re.search(m["regex"], str(val)):
            return False, f"{jp}={val!r} !~ {m['regex']!r}"
    return True, "matched"


# ---------------------------------------------------------------- dispatch

def dispatch(rule: dict, payload: dict, *, dry_run: bool = False) -> dict:
    job = rule.get("job")
    out = {"rule": rule["id"], "job": job, "ok": True}
    if job and not dry_run:
        try:
            r = subprocess.run(["hermes", "cron", "run", job],
                               capture_output=True, text=True, timeout=60)
            out["dispatch"] = {"rc": r.returncode, "out": r.stdout.strip()[-300:],
                               "err": r.stderr.strip()[-300:]}
            out["ok"] = r.returncode == 0
        except Exception as ex:  # noqa: BLE001
            out.update(ok=False, dispatch={"error": str(ex)})
    cmd = rule.get("command")
    if cmd and not dry_run:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)  # noqa: S602
        out["command"] = {"rc": r.returncode, "err": r.stderr.strip()[-200:]}
        out["ok"] = out["ok"] and r.returncode == 0
    out["dry_run"] = dry_run
    return out


def verify_signature(rule: dict, raw: bytes, headers: dict, environ: dict) -> bool:
    sec_name = rule.get("secret_env")
    secret = (environ.get(sec_name) if sec_name else None) or rule.get("secret")
    if not secret:
        return False
    if rule.get("source") == "github":
        sig = headers.get("x-hub-signature-256", "")
        want = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, want)
    sig = headers.get("x-trigger-signature", "")
    want = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, want)


# ---------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-triggerd/0.1"

    def log_message(self, fmt, *args):  # quiet; we log JSONL ourselves
        pass

    def _reply(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self._reply(200, {"ok": True, "rules": len(self.server.cfg["rules"])})
            return
        self._reply(404, {"error": "not found"})

    def do_POST(self):
        cfg, environ = self.server.cfg, self.server.environ
        parts = [p for p in self.path.split("/") if p]
        if len(parts) != 2 or parts[0] not in ("github", "hook"):
            self._reply(404, {"error": "use /github/<rule-id> or /hook/<rule-id>"})
            return
        kind, rule_id = parts
        rule = next((r for r in cfg["rules"] if r["id"] == rule_id), None)
        if not rule:
            self._reply(404, {"error": f"no rule {rule_id!r}"})
            return
        if (rule.get("source") == "github") != (kind == "github"):
            self._reply(400, {"error": f"rule {rule_id!r} is source={rule.get('source')!r}, not {kind!r}"})
            return
        n = int(self.headers.get("content-length", 0))
        if n <= 0 or n > MAX_BODY:
            self._reply(413, {"error": "bad content-length"})
            return
        raw = self.rfile.read(n)
        if not verify_signature(rule, raw, {k.lower(): v for k, v in self.headers.items()}, environ):
            log_event({"rule": rule_id, "ok": False, "error": "bad signature"})
            self._reply(403, {"error": "signature verification failed"})
            return
        try:
            payload = json.loads(raw.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            self._reply(400, {"error": "invalid JSON"})
            return
        event = self.headers.get("x-github-event")
        ok, why = rule_matches(rule, event=event, payload=payload)
        if not ok:
            log_event({"rule": rule_id, "ok": False, "skipped": why})
            self._reply(200, {"matched": False, "reason": why})
            return
        result = dispatch(rule, payload)
        if rule.get("notify"):
            title = payload_get(payload, rule.get("notify_title_path") or "issue.title") \
                or payload_get(payload, "pull_request.title") \
                or payload_get(payload, "commits.0.message") or rule_id
            send_message(f"🔔 trigger {rule_id}: {title} -> job {rule.get('job')}",
                         dry_run=self.server.dry_run)
        log_event({"rule": rule_id, "ok": result["ok"], "matched": True, "result": result})
        self._reply(200 if result["ok"] else 500, {"matched": True, **result})
        if self.server.once:
            raise SystemExit(0)  # single-request mode (tests)


def serve(cfg: dict, *, host: str | None, port: int | None, once: bool = False,
          dry_run: bool = False) -> None:
    srv = ThreadingHTTPServer((host or cfg["host"], port or cfg["port"]), Handler)
    srv.cfg, srv.environ, srv.once, srv.dry_run = cfg, env(), once, dry_run
    log_event({"startup": True, "host": srv.server_address[0], "port": srv.server_address[1]})
    print(f"triggerd listening on http://{srv.server_address[0]}:{srv.server_address[1]} "
          f"({len(cfg['rules'])} rules)")
    try:
        srv.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        srv.server_close()


# ---------------------------------------------------------------- CLI

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve")
    s.add_argument("--host", default=None)
    s.add_argument("--port", type=int, default=None)
    s.add_argument("--once", action="store_true", help="handle one request then exit (tests)")

    sub.add_parser("list")

    for src in ("add-github", "add-generic"):
        a = sub.add_parser(src)
        a.add_argument("id")
        a.add_argument("--job", required=True, help="hermes cron job name to fire")
        a.add_argument("--secret-env", required=True, help="env var name in ~/.hermes/.env")
        a.add_argument("--event", default=None, help="github event name (github only)")
        a.add_argument("--action", default=None)
        a.add_argument("--repo", default=None, help="owner/name (github only)")
        a.add_argument("--json-path", default=None)
        a.add_argument("--contains", default=None)
        a.add_argument("--equals", default=None)
        a.add_argument("--regex", default=None)
        a.add_argument("--command", default=None, help="extra shell after job fires")
        a.add_argument("--no-notify", action="store_true")

    r = sub.add_parser("remove")
    r.add_argument("id")

    t = sub.add_parser("test")
    t.add_argument("id")
    t.add_argument("payload", help="path to JSON payload file (use '-' for stdin)")
    t.add_argument("--event", default=None, help="X-GitHub-Event value to simulate")

    args = ap.parse_args()

    try:
        cfg = load_config()
    except FileNotFoundError:
        if args.cmd != "serve":
            print(f"no config at {CONFIG} — create one with add-github/add-generic", file=sys.stderr)
            return 1
        cfg = {"host": "127.0.0.1", "port": 8471, "rules": []}

    if args.cmd == "serve":
        serve(cfg, host=args.host, port=args.port, once=args.once, dry_run=args.dry_run)
        return 0

    if args.cmd == "list":
        print(json.dumps(cfg["rules"], indent=1))
        print("--- recent deliveries ---")
        for rec in recent_deliverings():
            print(json.dumps(rec, default=str)[:300])
        return 0

    if args.cmd in ("add-github", "add-generic"):
        match = {k: v for k, v in {
            "event": args.event, "action": args.action, "repo": args.repo,
            "json_path": args.json_path, "contains": args.contains,
            "equals": args.equals, "regex": args.regex}.items() if v is not None}
        rule = {"id": args.id, "source": "github" if args.cmd == "add-github" else "generic",
                "secret_env": args.secret_env, "match": match, "job": args.job,
                "notify": not args.no_notify}
        if args.command:
            rule["command"] = args.command
        cfg["rules"] = [r for r in cfg["rules"] if r["id"] != args.id] + [rule]
        save_config(cfg)
        print(f"rule {args.id!r} saved ({len(cfg['rules'])} rules total)")
        return 0

    if args.cmd == "remove":
        before = len(cfg["rules"])
        cfg["rules"] = [r for r in cfg["rules"] if r["id"] != args.id]
        save_config(cfg)
        print(f"removed {before - len(cfg['rules'])} rule(s)")
        return 0

    if args.cmd == "test":
        rule = next((r for r in cfg["rules"] if r["id"] == args.id), None)
        if not rule:
            print(f"no rule {args.id!r}", file=sys.stderr)
            return 1
        raw = sys.stdin.buffer.read() if args.payload == "-" else open(args.payload, "rb").read()
        payload = json.loads(raw)
        ok, why = rule_matches(rule, event=args.event, payload=payload)
        print(f"match: {ok} ({why})")
        if ok:
            print(json.dumps(dispatch(rule, payload, dry_run=True), indent=1))
        return 0 if ok else 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
