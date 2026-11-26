#!/usr/bin/env python3
"""join_meeting — one command for the whole meeting.

Sending Hermes a link works (it parses the link and sends the bot), but three things
were left to the human: loading the models and the stack, starting the in-call loop,
and giving the resources back when the call ends. This does all of it.

  join_meeting.py <meeting_url> [options]

  1. parse the link with the same MCP tool an agent uses
  2. load the resources (models + the Vexa stack) and take a lease
  3. send the bot, wait until it is in the room
  4. start the in-call loop, which announces itself and then decides/speaks/chats
  5. wait for the call to end, then release the lease

Options:
  --profile NAME   res profile to load (default: meeting; meeting-live also sees the screen)
  --chat           the bot also writes in the meeting chat
  --screen         the bot reads the shared screen
  --notify         questions for Alexander go to Telegram
  --no-announce    do not announce the recording (you know what you are doing)
  --no-loop        join and wait, but do not run the in-call agent
  --keep           leave the resources loaded when the call ends
  --dry-run        resolve the link and show what would happen
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vexa_mcp import Mcp, McpError  # noqa: E402

HERE = Path(__file__).resolve().parent
LOG_DIR = Path.home() / ".local/state/vexa-agent"
RES = Path.home() / ".local/bin/res"


def log(msg: str) -> None:
    print(f"join-meeting: {msg}", flush=True)


def run(cmd: list[str], timeout: int = 900) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except FileNotFoundError:
        return 127, "", f"{cmd[0]} not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{' '.join(cmd)} timed out after {timeout}s"


def res_load(profile: str) -> bool:
    rc, out, err = run([str(RES), "load", profile], timeout=1800)
    for line in (out + "\n" + err).splitlines():
        if line.strip():
            log(line.strip())
    return rc == 0


def res_release(profile: str) -> None:
    rc, out, err = run([str(RES), "release", profile], timeout=600)
    log(out.strip() or err.strip() or "released")


def main() -> int:
    ap = argparse.ArgumentParser(prog="join_meeting", description=__doc__.splitlines()[0])
    ap.add_argument("meeting_url")
    ap.add_argument("--profile", default="meeting", help="res profile to load (default: meeting)")
    ap.add_argument("--bot-name", default="Hermes (transcribing)")
    ap.add_argument("--chat", action="store_true")
    ap.add_argument("--screen", action="store_true")
    ap.add_argument("--notify", action="store_true")
    ap.add_argument("--no-announce", action="store_true")
    ap.add_argument("--no-loop", action="store_true")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--admit-timeout", type=int, default=300, help="seconds to wait for the bot to be admitted")
    args = ap.parse_args()

    # ── 1. the link ──────────────────────────────────────────────────────
    try:
        with Mcp() as m:
            parsed = m.call("parse_meeting_link", {"meeting_url": args.meeting_url})
            platform = parsed.get("platform")
            native_id = parsed.get("native_meeting_id")
    except McpError as e:
        log(f"could not parse the link: {e}")
        log("is the Vexa stack up? (svc up vexa)")
        return 1
    if not platform or not native_id:
        log(f"could not make sense of the link: {parsed}")
        return 1
    log(f"link resolved: {platform} / {native_id}")
    if parsed.get("warnings"):
        log("warnings: " + "; ".join(parsed["warnings"]))

    if args.dry_run:
        log(f"would load profile '{args.profile}', send the bot as '{args.bot_name}', "
            f"announce, then run the in-call loop")
        return 0

    # ── 2. the resources ──────────────────────────────────────────────────
    if not res_load(args.profile):
        log("could not load the resources — aborting before a bot joins a call")
        return 1

    # ── 3. the bot ────────────────────────────────────────────────────────
    try:
        with Mcp() as m:
            sent = m.call(
                "request_meeting_bot",
                {"meeting_url": args.meeting_url, "bot_name": args.bot_name},
            )
            log(f"bot requested: {json.dumps(sent)[:200]}")
    except McpError as e:
        log(f"could not send the bot: {e}")
        if not args.keep:
            res_release(args.profile)
        return 1

    # ── 4. wait until it is in the room ───────────────────────────────────
    deadline = time.time() + args.admit_timeout
    active = False
    while time.time() < deadline:
        try:
            with Mcp() as m:
                status = m.call("get_bot_status", {})
        except McpError:
            time.sleep(10)
            continue
        bots = status.get("running_bots") or []
        mine = [b for b in bots if b.get("native_meeting_id") == native_id]
        if mine:
            state = mine[0].get("status", "")
            if state not in ("awaiting_admission", "requested", "starting"):
                active = True
                log(f"bot is in the room ({state})")
                break
            log(f"bot is {state} — waiting for the host to admit it")
        else:
            log("waiting for the bot to appear in the room…")
        time.sleep(10)

    if not active:
        log("the bot never got into the room (still in the lobby, or the host has not admitted it)")
        log("leave it running and re-run this command once the host admits it, or stop it with:")
        log(f"  curl -X DELETE -H \"X-API-Key: $MCP_VEXA_API_KEY\" http://127.0.0.1:8056/bots/{platform}/{native_id}")
        if not args.keep:
            res_release(args.profile)
        return 2

    # ── 5. the in-call loop ───────────────────────────────────────────────
    if args.no_loop:
        log("bot is in the room; not starting the in-call loop (--no-loop)")
        log(f"resources are leased under profile '{args.profile}' — release with: res release {args.profile}")
        return 0

    cmd = [
        sys.executable, str(HERE / "vexa_agent.py"),
        "--meeting-id", native_id, "--platform", platform,
    ]
    if args.chat:
        cmd.append("--chat")
    if args.screen:
        cmd.append("--screen")
    if args.notify:
        cmd.append("--notify")
    if not args.no_announce:
        cmd.append("--announce")
    cmd += ["--tier", "deep" if args.screen else "agent"]

    log_path = LOG_DIR / f"{platform}-{native_id}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log(f"starting the in-call loop → {log_path}")
    with log_path.open("a") as fh:
        fh.write(f"\n=== join_meeting {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        fh.write(" ".join(cmd) + "\n")
        proc = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT)
    log(f"the loop is running (pid {proc.pid}); it stops when the bot leaves the call")

    try:
        rc = proc.wait()
        log(f"the in-call loop ended (exit {rc})")
    except KeyboardInterrupt:
        proc.terminate()
        log("interrupted — stopping the in-call loop")
    finally:
        if not args.keep:
            res_release(args.profile)
            log(f"resources released (profile '{args.profile}')")
        else:
            log(f"resources left loaded (--keep); release with: res release {args.profile}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
