#!/usr/bin/env python3
"""UserPromptSubmit hook: notice a meeting transcript and route it to prototyper.

Claude Code runs this on every prompt, before the model sees it. When the prompt
looks like a transcript (pasted text or an attached transcript file), the hook
adds an instruction to the context:

- the user asked for a prototype      -> dispatch the prototyper agent
- otherwise                           -> ask the user once whether to build one

`SDLC_TRANSCRIPT_PROTOTYPER` selects the behaviour: `ask` (default), `auto`
(dispatch unless the user asked for something else), or `off`.

A description match alone does not do this reliably: the model delegates when a
request looks like a job for an agent, and a transcript pasted with no
instruction does not. A hook runs on every prompt regardless.

It must never get in the way of a prompt, so every failure path exits 0 with no
output, and it uses the standard library only.
"""
from __future__ import annotations

import json
import os
import re
import sys

TIMESTAMP = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b")
CUE = re.compile(r"\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}\s+-->\s+\d")
# "Alice:", "Dr. Bob Smith:", "[00:01:02] Alice:", "Alice (00:12):", "SPEAKER 1:"
SPEAKER = re.compile(
    r"(?m)^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*[-–]?\s*)?"
    r"([A-Z][\w.'-]*(?: [A-Z0-9][\w.'-]*){0,3})"
    r"\s*(?:\(\d{1,2}:\d{2}(?::\d{2})?\))?:\s+\S")
TRANSCRIPT_FILE = re.compile(
    r"[\w.\\/:-]*(?:\.(?:vtt|srt)\b"
    r"|(?:transcript|meeting|call[-_ ]?notes|interview|discovery[-_ ]?call)[\w.-]*\.(?:txt|md|docx|pdf|json)\b)",
    re.IGNORECASE)
WANTS_PROTOTYPE = re.compile(
    r"prototyp|clickable|proof[- ]of[- ]concept|\bpoc\b|demo app|mock[- ]?up app|build (?:it|this|an? app)",
    re.IGNORECASE)
# Speaker labels that are really prose or code, not people.
NOT_SPEAKERS = {"note", "notes", "example", "http", "https", "step", "todo", "summary",
                "question", "answer", "q", "a", "re", "subject", "from", "to", "cc", "date",
                "info", "debug", "warn", "warning", "error", "trace", "fatal", "critical"}


def signals(prompt: str) -> list[str]:
    found: list[str] = []
    if prompt.lstrip().startswith("WEBVTT") or len(CUE.findall(prompt)) >= 2:
        found.append("subtitle cues")
    speakers = [m.group(1) for m in SPEAKER.finditer(prompt) if m.group(1).lower() not in NOT_SPEAKERS]
    distinct = set(speakers)
    # A conversation has at least two people who each speak more than once;
    # the keys of a YAML or config block are unique, so they never qualify.
    recurring = [n for n in distinct if speakers.count(n) >= 2]
    stamps = len(TIMESTAMP.findall(prompt))
    if (len(speakers) >= 6 and len(recurring) >= 2
            and (stamps >= 4 or len(speakers) >= 10)):
        found.append(f"{len(speakers)} speaker turns from {len(distinct)} speakers")
    if TRANSCRIPT_FILE.search(prompt):
        found.append("a transcript file")
    if not found and re.search(r"\btranscripts?\b", prompt, re.IGNORECASE) and len(prompt) > 1500:
        found.append("a long message described as a transcript")
    return found


def instruction(found: list[str], wants: bool, mode: str) -> str:
    agent = ("the `prototyper` agent (`sdlc-suite:prototyper` when it comes from the plugin; "
             "bare `prototyper` where the project defines it)")
    why = ", ".join(found)
    if wants or mode == "auto":
        head = (f"The user's message contains a meeting transcript ({why})"
                + (" and asks for a prototype." if wants else "."))
        tail = ("" if wants else
                " If the user asked for something else instead, such as a summary, do that and offer the "
                "prototype in one line rather than dispatching.")
        return (f"{head} Dispatch {agent} with it: pass the transcript text or its file path, and the "
                f"target repository if one was named.{tail}")
    return (f"The user's message appears to contain a meeting transcript ({why}). Ask the user one "
            f"question: whether they want {agent} to build a clickable prototype from it. If they "
            f"asked for something else, such as a summary or action items, do that first and then "
            f"ask the question in one line. Do not start the prototype without a yes.")


def main() -> int:
    mode = os.environ.get("SDLC_TRANSCRIPT_PROTOTYPER", "ask").strip().lower()
    if mode == "off":
        return 0
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
        return 0
    prompt = data.get("prompt") if isinstance(data, dict) else None
    if not isinstance(prompt, str) or not prompt.strip():
        return 0
    found = signals(prompt)
    if not found:
        return 0
    out = {"hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": instruction(found, bool(WANTS_PROTOTYPE.search(prompt)), mode),
    }}
    sys.stdout.write(json.dumps(out))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # never block a prompt
        sys.exit(0)
