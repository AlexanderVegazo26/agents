#!/usr/bin/env python3
"""Tests for sdlc-suite/hooks/transcript_detect.py.

The hook is run as a subprocess with a JSON payload on stdin, exactly as Claude
Code runs it, so these tests exercise the real entry point and exit status.
No framework: the result is the exit code.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / "hooks" / "transcript_detect.py"
HOOKS_JSON = HOOK.parent / "hooks.json"
failures = 0


def run(prompt, mode=None, raw=None):
    env = dict(os.environ)
    env.pop("SDLC_TRANSCRIPT_PROTOTYPER", None)
    if mode:
        env["SDLC_TRANSCRIPT_PROTOTYPER"] = mode
    payload = raw if raw is not None else json.dumps({"hook_event_name": "UserPromptSubmit", "prompt": prompt})
    p = subprocess.run([sys.executable, str(HOOK)], input=payload, capture_output=True,
                       text=True, encoding="utf-8", env=env, timeout=10)
    ctx = None
    if p.stdout.strip():
        out = json.loads(p.stdout)
        assert out["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
        ctx = out["hookSpecificOutput"]["additionalContext"]
    return p.returncode, ctx


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  pass  {name}")
    except AssertionError as e:
        failures += 1
        print(f"  FAIL  {name}: {e}")


MEETING = """[00:00:12] Dana: Thanks for joining. The main pain is that approvals live in email.
[00:00:31] Marco: Right, and managers can't see which invoices are stuck.
[00:01:05] Dana: So we need a queue with statuses, and a way to approve in one click.
[00:01:40] Priya: Finance wants an export to CSV at month end.
[00:02:02] Marco: Let's not do mobile yet.
[00:02:30] Dana: Agreed. Decision: web only for the pilot.
[00:03:10] Priya: Who approves above ten thousand? That's still open.
"""
VTT = """WEBVTT

00:00:01.000 --> 00:00:04.000
<v Dana>We keep losing approvals in email.

00:00:04.500 --> 00:00:07.000
<v Marco>A single queue would fix most of it.
"""
YAML = "\n".join(f"Key{i}: value {i}" for i in range(15))
# Bracketed-time log lines are shaped exactly like "[00:00:12] Dana: ..." turns,
# so only the log-level exclusion keeps them quiet.
LOGS = "\n".join(f"[10:0{i % 10}:1{i % 10}] INFO: request {i} served\n"
                 f"[10:0{i % 10}:2{i % 10}] ERROR: request {i} failed" for i in range(8))


def ask_mode():
    code, ctx = run(MEETING)
    assert code == 0, code
    assert ctx and "Ask the user one question" in ctx, ctx
    assert "Do not start the prototype without a yes" in ctx
    assert "sdlc-suite:prototyper" in ctx and "bare `prototyper`" in ctx


def asked_for_prototype():
    code, ctx = run("Build a clickable prototype from this call:\n" + MEETING)
    assert code == 0 and ctx and ctx.startswith("The user's message contains a meeting transcript"), ctx
    assert "and asks for a prototype. Dispatch" in ctx, ctx


def auto_mode():
    code, ctx = run(MEETING, mode="auto")
    assert code == 0 and ctx and "Dispatch" in ctx and "offer the prototype in one line" in ctx, ctx


def off_mode():
    assert run(MEETING, mode="off") == (0, None)


def subtitle_file():
    code, ctx = run(VTT)
    assert code == 0 and ctx and "subtitle cues" in ctx, ctx


def attached_file():
    for p in ["here is the call: @notes/discovery-call-2026-09-12.vtt",
              "see C:/work/acme/meeting_2026-09-10.txt",
              "attached kickoff_transcript.docx"]:
        code, ctx = run(p)
        assert code == 0 and ctx and "a transcript file" in ctx, (p, ctx)


def summary_request_still_asks_after():
    code, ctx = run("Summarize this:\n" + MEETING)
    assert code == 0 and ctx and "do that first and then ask the question in one line" in ctx, ctx


def quiet_on_ordinary_prompts():
    for p in ["fix the failing test in src/app.ts", "what time is it, 10:30 or 11:00?",
              "Rename the Dana component to Profile", YAML, LOGS,
              "Subject: hi\nFrom: a@b.c\nTo: d@e.f\nDate: Mon\n\nHello"]:
        assert run(p) == (0, None), p[:60]


def never_blocks():
    for raw in ["", "not json", "[]", json.dumps({"prompt": 42}), json.dumps({})]:
        code, ctx = run(None, raw=raw)
        assert code == 0 and ctx is None, (raw, code, ctx)


def hooks_json_points_at_the_script():
    cfg = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))
    cmd = cfg["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert "${CLAUDE_PLUGIN_ROOT}/hooks/transcript_detect.py" in cmd, cmd


print("transcript_detect.py")
for name, fn in [("ask mode asks once, and names both agent spellings", ask_mode),
                 ("a prototype request dispatches directly", asked_for_prototype),
                 ("auto mode dispatches, but defers to another request", auto_mode),
                 ("off mode is silent", off_mode),
                 ("WebVTT cues are detected", subtitle_file),
                 ("an attached transcript file is detected", attached_file),
                 ("a summary request is honoured first, then the offer", summary_request_still_asks_after),
                 ("ordinary prompts, YAML, logs and email headers stay silent", quiet_on_ordinary_prompts),
                 ("malformed input never blocks the prompt", never_blocks),
                 ("hooks.json runs this script from the plugin root", hooks_json_points_at_the_script)]:
    test(name, fn)
print(f"\n{'FAILED' if failures else 'OK'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
