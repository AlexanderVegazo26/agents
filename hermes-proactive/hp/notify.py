"""Telegram delivery for hermes-proactive tools.

Cron agents have the messaging toolset disabled, so — like the existing
~/.hermes/scripts/tg_send.py — we call the Bot API directly by shelling out
to tg_send.py.  When --dry-run is set (or tg_send is unavailable) messages
go to stdout instead.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

TG_SEND = os.path.expanduser("~/.hermes/scripts/tg_send.py")


def send_message(text: str, *, dry_run: bool = False, chat: str | None = None,
                 buttons: list[tuple[str, str]] | None = None) -> bool:
    """Send `text` to Telegram. Returns True if handed off (or simulated)."""
    if dry_run or not os.path.exists(TG_SEND):
        prefix = "[dry-run] " if dry_run else "[tg_send missing] "
        print(prefix + text)
        return False
    cmd = [sys.executable, TG_SEND, "message", text]
    if chat:
        cmd += ["--chat", chat]
    for label, url in (buttons or []):
        cmd += ["--url", f"{label}|{url}"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        print("tg_send timed out", file=sys.stderr)
        return False
    if out.returncode != 0:
        print(f"tg_send failed: {out.stderr.strip() or out.stdout.strip()}", file=sys.stderr)
        return False
    return True


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}
