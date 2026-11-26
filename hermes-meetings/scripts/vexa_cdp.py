#!/usr/bin/env python3
"""vexa_cdp — act in the meeting the bot is in, from the host.

The Vexa bot sits in the call inside the vexa-lite container, in a real Chromium. The local CDP
patch gives that browser a DevTools port on 127.0.0.1:9222 (container-local). This wrapper runs the
driver INSIDE that container — where node and playwright already live — so nothing has to be
exposed, mounted or relayed: the script is piped in over `docker exec -i`.

  vexa_cdp.py chat --text "..."     post a message to the meeting chat
  vexa_cdp.py discover              list the chat-ish elements (for when Meet changes its DOM)
  vexa_cdp.py pages                 list the pages the meeting browser has open

Exit codes: 0 ok · 1 error · 3 no chat input found (candidates are printed) · 4 the send did not
take (the box was not cleared) · 5 the bot's browser is not running (no meeting in progress).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

DRIVER = Path(__file__).resolve().parent / "vexa_cdp.mjs"
CONTAINER = "vexa-lite"
# node + playwright resolve from the remote-browser package inside the image
NODE_CWD = "/app/core/meetings/modules/remote-browser"
CDP_PORT = 9222


def container_running(name: str) -> bool:
    p = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name],
        capture_output=True, text=True, timeout=30,
    )
    return p.returncode == 0 and p.stdout.strip() == "true"


def browser_alive(name: str) -> bool:
    """Is the bot's browser listening on its DevTools port?"""
    p = subprocess.run(
        ["docker", "exec", name, "python3", "-c",
         f"import urllib.request;urllib.request.urlopen('http://127.0.0.1:{CDP_PORT}/json/version',timeout=4)"],
        capture_output=True, text=True, timeout=30,
    )
    return p.returncode == 0


def run_driver(args: list[str], container: str = CONTAINER) -> tuple[int, str, str]:
    """Pipe the driver into the container and run it there."""
    script = DRIVER.read_text()
    cmd = [
        "docker", "exec", "-i", "-w", NODE_CWD, container,
        "node", "--input-type=module", "-", *args,
    ]
    p = subprocess.run(cmd, input=script, capture_output=True, text=True, timeout=180)
    return p.returncode, p.stdout, p.stderr


def main() -> int:
    ap = argparse.ArgumentParser(prog="vexa_cdp", description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=["chat", "discover", "pages"])
    ap.add_argument("--text", default="", help="the message to post (chat)")
    ap.add_argument("--container", default=CONTAINER)
    args = ap.parse_args()

    if not shutil.which("docker"):
        print("vexa_cdp: docker is not on PATH", file=sys.stderr)
        return 1
    if not container_running(args.container):
        print(
            f"vexa_cdp: the {args.container} container is not running — "
            "start the stack first (svc up vexa)",
            file=sys.stderr,
        )
        return 5
    if not browser_alive(args.container):
        print(
            "vexa_cdp: the bot's browser is not listening on its DevTools port — "
            "there is no meeting in progress (or the bot has not launched its browser yet)",
            file=sys.stderr,
        )
        return 5

    argv = [args.command]
    if args.command == "chat":
        argv += ["--text", args.text]
    code, out, err = run_driver(argv, args.container)
    if out.strip():
        try:
            print(json.dumps(json.loads(out.strip().splitlines()[-1]), indent=2))
        except json.JSONDecodeError:
            print(out.strip())
    if code != 0 and err.strip():
        print(err.strip(), file=sys.stderr)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
