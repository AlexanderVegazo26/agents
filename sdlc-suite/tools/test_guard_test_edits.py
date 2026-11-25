#!/usr/bin/env python3
"""Tests for sdlc-suite/hooks/guard_test_edits.py.

Two parts:
- the replay dataset sdlc-suite/evals/hook-cases.v1.json: each case is a
  PreToolUse payload an agent's tool call produces, replayed through the real
  hook (a subprocess with the payload on stdin, as Claude Code runs it) in a
  fresh temporary project, and graded on the decision and its reason;
- the behaviour around it: the user's environment override, bad input never
  blocking, the lock/unlock CLI, and hooks.json wiring.

    python sdlc-suite/tools/test_guard_test_edits.py [--case <id>]

No framework, no network, no clock: the exit code is the result.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SUITE = Path(__file__).resolve().parents[1]
HOOK = SUITE / "hooks" / "guard_test_edits.py"
HOOKS_JSON = SUITE / "hooks" / "hooks.json"
CASES = SUITE / "evals" / "hook-cases.v1.json"
ONLY = sys.argv[sys.argv.index("--case") + 1] if "--case" in sys.argv else None
failures = 0


def clean_env(**extra: str) -> dict:
    env = {k: v for k, v in os.environ.items()
           if k not in ("SDLC_ALLOW_TEST_EDITS", "CLAUDE_PROJECT_DIR")}
    env.update(extra)
    return env


def run_hook(payload, env=None, raw=None, args=()):
    stdin = raw if raw is not None else json.dumps(payload)
    p = subprocess.run([sys.executable, str(HOOK), *args], input=stdin, capture_output=True,
                       text=True, encoding="utf-8", env=env or clean_env(), timeout=10)
    decision = reason = None
    if not args and p.stdout.strip():
        out = json.loads(p.stdout)["hookSpecificOutput"]
        assert out["hookEventName"] == "PreToolUse", f"hookEventName: expected PreToolUse, actual {out!r}"
        decision, reason = out["permissionDecision"], out["permissionDecisionReason"]
    return p, decision, reason


def project(lock: str | None) -> tempfile.TemporaryDirectory:
    tmp = tempfile.TemporaryDirectory(prefix="edit-guard-")
    if lock is not None:
        (Path(tmp.name) / ".sdlc").mkdir()
        (Path(tmp.name) / ".sdlc" / "test-lock").write_text(lock + "\n", encoding="utf-8")
    return tmp


def subst(v, root: str):
    if isinstance(v, str):
        return v.replace("{root}", root)
    if isinstance(v, list):
        return [subst(x, root) for x in v]
    if isinstance(v, dict):
        return {k: subst(x, root) for k, x in v.items()}
    return v


def test(name, fn):
    global failures
    if ONLY and name != ONLY:
        return
    try:
        fn()
        print(f"  pass  {name}")
    except AssertionError as e:
        failures += 1
        print(f"  FAIL  {name}: {e}\n        rerun: python {Path(__file__).relative_to(SUITE.parent)} --case {name}")


def replay(case):
    def fn():
        with project(case["lock"]) as root:
            cwd = subst(case.get("cwd", "{root}"), root)
            Path(cwd).mkdir(parents=True, exist_ok=True)
            payload = {"session_id": "replay", "transcript_path": "/dev/null", "cwd": cwd,
                       "permission_mode": "default", "hook_event_name": "PreToolUse",
                       "tool_name": case["tool"], "tool_input": subst(case["input"], root),
                       "tool_use_id": f"toolu_{case['id']}"}
            p, decision, reason = run_hook(payload)
            got = decision or "none"
            assert p.returncode == 0, f"exit: expected 0, actual {p.returncode}; stderr {p.stderr!r}"
            assert got == case["expect"], (
                f"{case['tool']} {json.dumps(case['input'])[:120]} with lock {case['lock']!r}: "
                f"expected {case['expect']}, actual {got}; reason {reason!r}")
            if case["expect"] == "deny" and case.get("reason"):
                assert re.search(case["reason"], reason, re.S), (
                    f"reason: expected to match /{case['reason']}/, actual {reason!r}")
    return fn


def dataset_is_valid():
    data = json.loads(CASES.read_text(encoding="utf-8"))
    assert data["version"] == 1, f"version: expected 1, actual {data['version']!r}"
    ids = [c["id"] for c in data["cases"]]
    assert len(ids) == len(set(ids)), f"duplicate ids: {sorted(i for i in ids if ids.count(i) > 1)}"
    for c in data["cases"]:
        assert re.fullmatch(r"[a-z0-9-]+", c["id"]), f"{c['id']}: id must be kebab-case"
        assert c["expect"] in ("deny", "none"), f"{c['id']}: expect must be deny|none, actual {c['expect']!r}"
        assert "lock" in c and c.get("tool") and isinstance(c.get("input"), dict), \
            f"{c['id']}: needs lock (string or null), tool and input"
    kinds = {c["expect"] for c in data["cases"]}
    assert kinds == {"deny", "none"}, f"dataset must hold both deny and none cases, actual {kinds}"


def override_env_turns_it_off():
    with project("fixing tests/test_a.py") as root:
        payload = {"cwd": root, "tool_name": "Edit",
                   "tool_input": {"file_path": f"{root}/tests/test_a.py"}}
        _, decision, _ = run_hook(payload)
        assert decision == "deny", f"control: expected deny without the override, actual {decision}"
        for value in ("1", "true"):
            _, decision, _ = run_hook(payload, env=clean_env(SDLC_ALLOW_TEST_EDITS=value))
            assert decision is None, f"SDLC_ALLOW_TEST_EDITS={value}: expected no decision, actual {decision}"
        _, decision, _ = run_hook(payload, env=clean_env(SDLC_ALLOW_TEST_EDITS="0"))
        assert decision == "deny", f"SDLC_ALLOW_TEST_EDITS=0: expected deny, actual {decision}"


def project_dir_env_finds_the_lock():
    with project("fixing tests/test_a.py") as root, tempfile.TemporaryDirectory() as elsewhere:
        payload = {"cwd": elsewhere, "tool_name": "Write",
                   "tool_input": {"file_path": f"{root}/tests/test_a.py", "content": ""}}
        _, decision, _ = run_hook(payload)
        assert decision is None, f"cwd outside the project, no CLAUDE_PROJECT_DIR: expected none, actual {decision}"
        _, decision, _ = run_hook(payload, env=clean_env(CLAUDE_PROJECT_DIR=root))
        assert decision == "deny", f"CLAUDE_PROJECT_DIR={root}: expected deny, actual {decision}"


def bad_input_never_blocks():
    with project("fixing tests/test_a.py") as root:
        for raw in ("", "not json", "[1, 2]", "null",
                    json.dumps({"cwd": root, "tool_name": "Edit", "tool_input": "oops"}),
                    json.dumps({"cwd": root, "tool_name": "Edit", "tool_input": {"file_path": 7}}),
                    json.dumps({"cwd": root, "tool_name": "Bash", "tool_input": {"command": "echo 'unterminated"}})):
            p, decision, _ = run_hook(None, raw=raw)
            assert p.returncode == 0 and decision is None and not p.stderr, (
                f"input {raw[:60]!r}: expected exit 0, no decision, no stderr; actual exit {p.returncode}, "
                f"decision {decision}, stderr {p.stderr[-200:]!r}")


def cli_lock_unlock():
    with tempfile.TemporaryDirectory() as root:
        env = clean_env(CLAUDE_PROJECT_DIR=root)
        p, _, _ = run_hook(None, raw="", env=env, args=("lock", "fixing", "test_a"))
        lock = Path(root) / ".sdlc" / "test-lock"
        assert p.returncode == 0 and lock.read_text() == "fixing test_a\n", \
            f"lock: expected {lock} with 'fixing test_a', actual exit {p.returncode}, exists {lock.exists()}"
        payload = {"cwd": root, "tool_name": "Edit", "tool_input": {"file_path": f"{root}/tests/test_a.py"}}
        _, decision, _ = run_hook(payload, env=env)
        assert decision == "deny", f"after lock: expected deny, actual {decision}"
        p, _, _ = run_hook(None, raw="", env=env, args=("status",))
        assert "fixing test_a" in p.stdout, f"status: expected the reason, actual {p.stdout!r}"
        run_hook(None, raw="", env=env, args=("unlock",))
        assert not lock.exists(), "unlock: expected the lock file removed"
        _, decision, _ = run_hook(payload, env=env)
        assert decision is None, f"after unlock: expected no decision, actual {decision}"


def symlinked_project_root():
    with project("fixing tests/test_a.py\nallow: tests/test_a.py") as real, \
            tempfile.TemporaryDirectory() as links:
        link = str(Path(links) / "proj")
        os.symlink(real, link)
        for tool, inp, want in [
            ("Write", {"file_path": f"{link}/.sdlc/test-lock", "content": "allow: *"}, "deny"),
            ("Bash", {"command": f"rm {link}/.sdlc/test-lock"}, "deny"),
            ("Edit", {"file_path": f"{link}/tests/test_b.py"}, "deny"),
            ("Edit", {"file_path": f"{link}/tests/test_a.py"}, None),
        ]:
            _, decision, reason = run_hook({"cwd": link, "tool_name": tool, "tool_input": inp})
            assert decision == want, (f"project opened through symlink {link}: {tool} {inp}: "
                                      f"expected {want or 'none'}, actual {decision or 'none'}; {reason!r}")


def cli_unlock_from_subdirectory():
    with project("fixing tests/test_a.py") as root:
        sub = Path(root) / "src" / "pkg"
        sub.mkdir(parents=True)
        p = subprocess.run([sys.executable, str(HOOK), "unlock"], cwd=sub, capture_output=True,
                           text=True, env=clean_env(), timeout=10)
        lock = Path(root) / ".sdlc" / "test-lock"
        assert p.returncode == 0 and not lock.exists(), (
            f"unlock run in {sub}: expected the project lock {lock} removed, actual exists={lock.exists()}, "
            f"stdout {p.stdout!r}")


def hooks_json_wires_it():
    cfg = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))
    entries = cfg["hooks"].get("PreToolUse", [])
    wired = [e for e in entries for h in e["hooks"]
             if "${CLAUDE_PLUGIN_ROOT}/hooks/guard_test_edits.py" in h["command"]]
    assert wired, f"hooks.json PreToolUse: expected an entry running guard_test_edits.py, actual {entries!r}"
    matcher = set(wired[0].get("matcher", "").split("|"))
    need = {"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"}
    assert need <= matcher, f"matcher: expected to include {sorted(need)}, actual {sorted(matcher)}"
    cmd = next(h["command"] for h in wired[0]["hooks"] if "guard_test_edits" in h["command"])
    assert cmd.startswith("python3 "), (
        f"command: expected to start with python3 (many hosts have no bare python, and a missing "
        f"interpreter is a non-blocking hook error that silently disables the guard), actual {cmd!r}")


def main() -> int:
    print("guard_test_edits.py")
    data = json.loads(CASES.read_text(encoding="utf-8"))
    test("dataset-is-valid", dataset_is_valid)
    for case in data["cases"]:
        test(case["id"], replay(case))
    for name, fn in [("override-env-turns-it-off", override_env_turns_it_off),
                     ("project-dir-env-finds-the-lock", project_dir_env_finds_the_lock),
                     ("bad-input-never-blocks", bad_input_never_blocks),
                     ("cli-lock-unlock", cli_lock_unlock),
                     ("symlinked-project-root", symlinked_project_root),
                     ("cli-unlock-from-subdirectory", cli_unlock_from_subdirectory),
                     ("hooks-json-wires-it", hooks_json_wires_it)]:
        test(name, fn)
    print(f"{'FAILED' if failures else 'ok'}: {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
