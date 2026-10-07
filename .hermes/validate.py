#!/usr/bin/env python3
"""Offline gate for the Hermes port. No hermes, no network, no model.

    python .hermes/validate.py

The generated half (`.hermes/skills/` and `.hermes.md`) is already byte-checked
by `generate_trees.py --check`; this checks what that cannot:

* every generated command skill parses as a Hermes skill (`name` matching its
  directory, a `description`), carries no unresolved `${CLAUDE_PLUGIN_ROOT}` or
  `$ARGUMENTS`, and — when it names a workflow script — names one that exists;
* the hand-maintained plugin registers exactly the `agent` and `workflow` tools
  through a stub ctx, each with a schema whose name matches;
* the runner's selftest passes under the host node.

Exit 0 clean, 1 on any defect (each named), 2 when there is nothing to check.
"""

from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".hermes" / "skills"
PLUGIN = ROOT / ".hermes" / "plugins" / "sdlc"
SCRIPT_RE = re.compile(r'scriptPath:\s*"([^"]+)"')


def check_skills(errors: list[str]) -> int:
    dirs = sorted(p for p in SKILLS.iterdir() if p.is_dir()) if SKILLS.is_dir() else []
    for d in dirs:
        f = d / "SKILL.md"
        if not f.is_file():
            errors.append(f"{d.relative_to(ROOT)}: no SKILL.md")
            continue
        text = f.read_text(encoding="utf-8")
        m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
        front = dict(re.findall(r"^(\w[\w-]*):\s*(.*)$", m.group(1), re.MULTILINE)) if m else {}
        rel = f.relative_to(ROOT)
        if front.get("name") != d.name:
            errors.append(f"{rel}: name {front.get('name')!r} does not match its directory")
        if not front.get("description"):
            errors.append(f"{rel}: no description")
        for leftover in ("${CLAUDE_PLUGIN_ROOT}", "$ARGUMENTS", "sdlc-suite:"):
            if leftover in text:
                errors.append(f"{rel}: unresolved {leftover}")
        for script in SCRIPT_RE.findall(text):
            if not (ROOT / script).is_file():
                errors.append(f"{rel}: scriptPath {script} does not exist")
            elif "`workflow` tool registered by the `.hermes/plugins/sdlc/` plugin" not in text:
                errors.append(f"{rel}: names a workflow but carries no Hermes note")
    return len(dirs)


class _StubCtx:
    def __init__(self) -> None:
        self.tools: dict[str, dict] = {}
        self.commands: dict[str, object] = {}
        self.cli: dict[str, object] = {}
        self.telegram: list = []

    def register_tool(self, name, toolset, schema, handler, **_kw):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler}

    def register_command(self, name, handler, **_kw):
        self.commands[name] = handler

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, **_kw):
        self.cli[name] = (setup_fn, handler_fn)

    def register_telegram_handler(self, factory):
        self.telegram.append(factory)


def check_plugin(errors: list[str]) -> None:
    for f in ("plugin.yaml", "__init__.py", "runner.mjs"):
        if not (PLUGIN / f).is_file():
            errors.append(f".hermes/plugins/sdlc/{f}: missing")
    if errors:
        return
    spec = importlib.util.spec_from_file_location("sdlc_hermes_plugin", PLUGIN / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
        ctx = _StubCtx()
        mod.register(ctx)
    except Exception as e:  # noqa: BLE001 — any import/registration failure is the defect
        errors.append(f".hermes/plugins/sdlc/__init__.py: register() failed: {e!r}")
        return
    if set(ctx.tools) != {"agent", "workflow"}:
        errors.append(f".hermes/plugins/sdlc: registers {sorted(ctx.tools)}, expected ['agent', 'workflow']")
    want = {"orchestrate", "idea", "idea-cloud", "implement", "implement-cloud", "jobs"}
    if set(ctx.commands) != want:
        errors.append(f".hermes/plugins/sdlc: slash commands {sorted(ctx.commands)}, expected {sorted(want)}")
    if not ctx.telegram:
        errors.append(".hermes/plugins/sdlc: no Telegram handler registered — the job card buttons would be dead")
    for f in ("jobs.py", "implement_pipeline.py"):
        if not (PLUGIN / f).is_file():
            errors.append(f".hermes/plugins/sdlc/{f}: missing")
    if not (PLUGIN / "prototype_pipeline.py").is_file():
        errors.append(".hermes/plugins/sdlc: /idea is registered but prototype_pipeline.py is missing")
    if set(ctx.cli) != {"sdlc"}:
        errors.append(f".hermes/plugins/sdlc: CLI commands {sorted(ctx.cli)}, expected ['sdlc']")
    model = ctx.tools.get("agent", {}).get("schema", {}).get("parameters", {}).get("properties", {}).get("model")
    if model is None or not model.get("enum"):
        errors.append(".hermes/plugins/sdlc: `agent` has no `model` enum — is models.json readable?")
    for name, t in ctx.tools.items():
        if t["schema"].get("name") != name:
            errors.append(f".hermes/plugins/sdlc: tool {name} has schema name {t['schema'].get('name')!r}")
    check_catalog_rules(mod, errors)
    check_jobs(errors)
    for f in ("prototype_pipeline.py", "implement_pipeline.py"):
        check_templates(PLUGIN / f, errors)
    r = subprocess.run(["node", str(PLUGIN / "runner.mjs"), "--selftest"],
                       capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        errors.append(f".hermes/plugins/sdlc/runner.mjs --selftest exited {r.returncode}:\n{r.stdout}{r.stderr}")


def check_catalog_rules(mod, errors: list[str]) -> None:
    """The Python half's catalog rules for probe_key_env. runner.mjs's selftest
    holds the JS half to the same cases; an invalid catalog must be invalid in both."""
    def err(choice: dict) -> str:
        return mod.catalog_error({"choices": {"a": {"model": "x", **choice}}}) or ""
    cases = [
        ("a probe_key_env that is not a variable name", {"probe_key_env": "$(id)"}, "probe_key_env"),
        ("a key sent to a probe off loopback",
         {"probe": "https://evil.example/v1/models", "probe_key_env": "GITHUB_TOKEN"}, "not on loopback"),
        ("a loopback-looking subdomain", {"probe": "http://127.0.0.1.evil.example/v1", "probe_key_env": "K"}, "not on loopback"),
    ]
    for label, choice, want in cases:
        if want not in err(choice):
            errors.append(f".hermes/plugins/sdlc/__init__.py: catalog_error accepts {label}")
    for probe in ("http://127.0.0.1:11435/v1/models", "http://localhost:1/v1", "http://[::1]:2/v1"):
        if err({"probe": probe, "probe_key_env": "K"}):
            errors.append(f".hermes/plugins/sdlc/__init__.py: catalog_error rejects the loopback probe {probe}")


def check_templates(path: Path, errors: list[str]) -> None:
    """Every `<NAME>.format(...)` of a module-level prompt template passes
    exactly the fields the template uses — a missing one is the
    `KeyError: 'review_dir'` that failed a build on 2026-10-06."""
    import ast
    import string
    tree = ast.parse(path.read_text(encoding="utf-8"))
    templates = {}
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)):
            fields = {f for _, f, _, _ in string.Formatter().parse(node.value.value) if f}
            if fields:
                templates[node.targets[0].id] = fields
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format"
                and isinstance(node.func.value, ast.Name) and node.func.value.id in templates):
            given = {k.arg for k in node.keywords if k.arg}
            missing = templates[node.func.value.id] - given
            if missing:
                errors.append(f"{path.relative_to(ROOT)}:{node.lineno}: {node.func.value.id}.format() "
                              f"lacks {sorted(missing)}")


def check_jobs(errors: list[str]) -> None:
    """jobs.py offline: records, the card's buttons per state, Telegram's
    64-byte callback limit, pause/resume/stop on the detached fallback path
    (a real process tree), the paused clock, and the slot locks."""
    import tempfile
    import time
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["SDLC_JOBS_STATE"] = tmp
        os.environ["SDLC_JOBS_NO_SYSTEMD"] = "1"
        spec = importlib.util.spec_from_file_location("sdlc_jobs_check", PLUGIN / "jobs.py")
        jobs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(jobs)
        jobs.post_status = lambda job, new=False: job  # no network in a check
        def bad(msg):
            errors.append(f".hermes/plugins/sdlc/jobs.py: {msg}")
        job = jobs.create("idea", "a <b>tip</b> splitter", slug="x" * 80)
        for status, want in (("running", {"pause", "stop"}), ("paused", {"resume", "stop"}),
                             ("failed", {"again"}), ("done", {"again"})):
            kb = jobs.keyboard({**job, "status": status})
            got = {b["callback_data"].split(":")[1] for row in kb for b in row if "callback_data" in b}
            if got != want:
                bad(f"a {status} card offers {sorted(got)}, expected {sorted(want)}")
            for row in kb:
                for b in row:
                    if "callback_data" in b and (len(b["callback_data"].encode()) > 64
                                                 or not jobs.CALLBACK_RE.match(b["callback_data"])):
                        bad(f"callback_data {b['callback_data']!r} breaks Telegram's limit or our pattern")
        if "<b>tip</b>" in jobs.card(job):
            bad("the card does not escape the request text")
        proc = subprocess.Popen(["sh", "-c", "sleep 30 & wait"], start_new_session=True)
        try:
            jobs.update(job["id"], status="running", pid=proc.pid, pid_start=jobs._proc_start(proc.pid))
            jobs.pause(job["id"])
            for _ in range(50):  # signal delivery is asynchronous
                state = Path(f"/proc/{proc.pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
                if state == "T":
                    break
                time.sleep(0.02)
            if state != "T" or jobs.load(job["id"])["status"] != "paused":
                bad(f"pause did not stop the process tree (state {state})")
            time.sleep(1.1)
            jobs.resume(job["id"])
            if jobs.load(job["id"])["paused_total"] < 1:
                bad("resume did not book the paused time")
            jobs.stop(job["id"])
            proc.wait(timeout=10)
        finally:
            if proc.poll() is None:
                proc.kill()
        # Stop reaches a pid that is not a process-group leader (the scout's case).
        nl = subprocess.Popen(["sleep", "30"])
        try:
            j2 = jobs.create("idea", "c")
            jobs.update(j2["id"], status="running", pid=nl.pid, pid_start=jobs._proc_start(nl.pid))
            jobs.stop(j2["id"])
            try:
                nl.wait(timeout=5)
            except subprocess.TimeoutExpired:
                bad("stop did not reach a pid that is not a process-group leader")
        finally:
            if nl.poll() is None:
                nl.kill()
        # A systemctl that cannot answer must not turn a live job into "failed".
        j3 = jobs.update(jobs.create("idea", "d")["id"], status="running", unit="sdlc-job-none")
        real = jobs._systemctl
        def broken(*_a):
            raise subprocess.TimeoutExpired("systemctl", 30)
        jobs._systemctl = broken
        try:
            if jobs.reconcile(j3).get("status") != "running":
                bad("a systemctl failure marked a running job failed")
        finally:
            jobs._systemctl = real
        # Refused HTML is re-sent as plain text, never dropped.
        calls = []
        def fake_tg(method, payload):
            calls.append(payload)
            return ({"ok": False, "description": "Bad Request: can't parse entities"} if len(calls) == 1
                    else {"ok": True, "result": {"message_id": 1}})
        real_tg, jobs.tg = jobs.tg, fake_tg
        try:
            r = jobs.send_html("sendMessage", {"chat_id": "1", "text": "<pre>a &amp; b", "parse_mode": "HTML"})
            if not (r and r.get("ok")) or len(calls) != 2 or "parse_mode" in calls[1] or calls[1]["text"] != "a & b":
                bad("send_html did not fall back to plain text when Telegram refused the markup")
        finally:
            jobs.tg = real_tg
        held = jobs.acquire_slots(job, local=True)
        other = jobs.create("idea", "b")
        import threading
        got = []
        t = threading.Thread(target=lambda: got.append(jobs.acquire_slots(other, local=True, poll=0.1)), daemon=True)
        t.start()
        t.join(0.5)
        if got:
            bad("a second local job got a slot while the first held the only one")
        for fh in held:
            fh.close()
        t.join(3)
        if not got:
            bad("a queued job never got the slot after it was released")
        for fh in (got[0] if got else []):
            fh.close()
        del os.environ["SDLC_JOBS_STATE"], os.environ["SDLC_JOBS_NO_SYSTEMD"]


def main() -> int:
    errors: list[str] = []
    n = check_skills(errors)
    if n == 0:
        print("FAIL: .hermes/skills/ has no command skills — nothing to check", file=sys.stderr)
        return 2
    check_plugin(errors)
    if errors:
        for e in errors:
            print(f"FAIL: {e}", file=sys.stderr)
        return 1
    print(f"OK: {n} command skills, sdlc plugin registers agent (with model routing) + workflow + /orchestrate + /idea + /idea-cloud + /implement(-cloud) + /jobs, job controls pass, "
          "runner selftest passes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
