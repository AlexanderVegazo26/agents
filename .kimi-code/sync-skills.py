#!/usr/bin/env python3
"""Sync .claude/skills/ into .kimi-code/skills/ (one-way mirror)."""

from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
CLAUDE_SKILLS = ROOT / ".claude" / "skills"
KIMI_SKILLS = ROOT / ".kimi-code" / "skills"


def main():
    KIMI_SKILLS.mkdir(parents=True, exist_ok=True)

    copied = 0
    skipped = 0
    for src in sorted(CLAUDE_SKILLS.iterdir()):
        if not src.is_dir():
            continue
        name = src.name
        dst = KIMI_SKILLS / name
        if dst.exists():
            skipped += 1
            continue
        shutil.copytree(src, dst)
        copied += 1
        print(f"Copied {name}")

    print(f"Done. {copied} copied, {skipped} already present.")
    print(f"Total skills in .kimi-code/skills: {len([d for d in KIMI_SKILLS.iterdir() if d.is_dir()])}")


if __name__ == "__main__":
    main()
