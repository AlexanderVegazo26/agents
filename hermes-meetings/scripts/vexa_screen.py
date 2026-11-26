#!/usr/bin/env python3
"""vexa-screen — read what the meeting bot is looking at.

Vexa captures audio only: its browser capture harvests the audio tracks of the
meeting's media elements and ignores video. So the bot cannot hear a shared
slide, and nothing in the stack sends pixels to a model.

But the bot is a real Chromium on a real display: the Vexa container runs
Xvfb on :99 (1920x1080) with the meeting client in a window. When someone
shares their screen, the client renders that share into the page — so it is
on :99. Grabbing that display is enough to see the shared screen.

This does exactly that:

  vexa-screen --once              capture one frame, describe it, print
  vexa-screen --watch --interval 60   keep describing, one line per look

The capture is `docker exec vexa-lite ffmpeg -f x11grab -i :99` piped back over
stdin — no shared volume, no new container, no port exposed. The frame goes to
the local vision model (Qwen3-VL-8B, loaded on demand and unloaded by itself).

Library: `capture_frame()`, `describe_frame()`, `look()`.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

DEFAULT_CONTAINER = "vexa-lite"
DEFAULT_DISPLAY = ":99"
DEFAULT_SIZE = "1280x720"

VISION_SYSTEM = (
    "You look at screenshots of a meeting bot's screen. Report only what is "
    "actually visible. If the screen is blank, black, empty, or shows nothing "
    "meaningful, answer with exactly: BLANK"
)

VISION_QUESTION = (
    "Describe what is on this screen in one or two sentences: which app is open, "
    "whether a document, slide or shared screen is being shown, and any text "
    "worth reading (numbers, names, decisions). If nothing meaningful is visible, "
    "answer exactly: BLANK."
)


class ScreenUnavailable(RuntimeError):
    pass


def capture_frame(
    container: str = DEFAULT_CONTAINER,
    display: str = DEFAULT_DISPLAY,
    size: str = DEFAULT_SIZE,
    timeout: int = 30,
) -> bytes:
    """One JPEG of the bot's virtual display. Raises ScreenUnavailable."""
    cmd = [
        "docker", "exec", container,
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "x11grab", "-video_size", size, "-i", display,
        "-frames:v", "1", "-f", "image2", "-vcodec", "mjpeg", "-",
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except FileNotFoundError as e:
        raise ScreenUnavailable(f"docker is not on PATH: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise ScreenUnavailable(f"frame capture timed out after {timeout}s") from e
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ScreenUnavailable(err[-1] if err else f"ffmpeg exited {p.returncode}")
    if not p.stdout or p.stdout[:2] != b"\xff\xd8":
        raise ScreenUnavailable("no JPEG came back from the capture")
    return p.stdout


def describe_frame(
    jpeg: bytes,
    tier: str = "vision",
    question: str = VISION_QUESTION,
    system: str = VISION_SYSTEM,
    timeout: int = 180,
) -> str:
    """Describe a JPEG with the local vision model. Returns the model's text."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as fh:
        fh.write(jpeg)
        path = fh.name
    try:
        cmd = [
            "llm-ask", "--tier", tier, "-i", path,
            "--system", system, "--label", "vexa-screen", question,
        ]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if p.returncode != 0:
            err = (p.stderr or p.stdout or "").strip().splitlines()
            raise ScreenUnavailable(err[-1] if err else f"llm-ask exited {p.returncode}")
        return (p.stdout or "").strip()
    finally:
        Path(path).unlink(missing_ok=True)


def look(
    container: str = DEFAULT_CONTAINER,
    display: str = DEFAULT_DISPLAY,
    size: str = DEFAULT_SIZE,
    tier: str = "vision",
    question: str = VISION_QUESTION,
) -> dict:
    """Capture + describe in one step.

    Returns {"ok": bool, "blank": bool, "description": str, "error": str|None}.
    """
    try:
        jpeg = capture_frame(container, display, size)
    except ScreenUnavailable as e:
        return {"ok": False, "blank": True, "description": "", "error": str(e)}
    try:
        text = describe_frame(jpeg, tier=tier, question=question)
    except ScreenUnavailable as e:
        return {"ok": False, "blank": True, "description": "", "error": str(e)}
    blank = text.strip().upper().startswith("BLANK")
    return {
        "ok": True,
        "blank": blank,
        "description": "" if blank else text,
        "error": None,
    }


def main() -> int:
    ap = argparse.ArgumentParser(prog="vexa-screen", description=__doc__.splitlines()[0])
    ap.add_argument("--once", action="store_true", help="capture, describe, print, exit")
    ap.add_argument("--watch", action="store_true", help="keep looking, one line per look")
    ap.add_argument("--interval", type=int, default=60, help="seconds between looks (watch mode)")
    ap.add_argument("--container", default=DEFAULT_CONTAINER)
    ap.add_argument("--display", default=DEFAULT_DISPLAY)
    ap.add_argument("--size", default=DEFAULT_SIZE)
    ap.add_argument("--tier", default="vision", help="llm-ask tier to describe with")
    ap.add_argument("--question", default=VISION_QUESTION)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    def one() -> dict:
        return look(args.container, args.display, args.size, args.tier, args.question)

    if args.watch:
        while True:
            res = one()
            if args.json:
                print(json.dumps({"ts": time.time(), **res}), flush=True)
            elif not res["ok"]:
                print(f"[{time.strftime('%H:%M:%S')}] screen unavailable: {res['error']}", flush=True)
            elif res["blank"]:
                print(f"[{time.strftime('%H:%M:%S')}] (nothing on screen)", flush=True)
            else:
                print(f"[{time.strftime('%H:%M:%S')}] {res['description']}", flush=True)
            try:
                time.sleep(args.interval)
            except KeyboardInterrupt:
                return 0
        return 0

    res = one()
    if args.json:
        print(json.dumps(res, indent=2))
    elif not res["ok"]:
        print(f"screen unavailable: {res['error']}")
    elif res["blank"]:
        print("(nothing on screen)")
    else:
        print(res["description"])
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
