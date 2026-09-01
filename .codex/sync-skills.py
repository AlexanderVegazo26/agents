#!/usr/bin/env python3
"""Mirror sdlc-suite/skills/ into .codex/skills/ (one-way, with prune)."""

from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
SDLC_SKILLS = ROOT / "sdlc-suite" / "skills"
CODEX_SKILLS = ROOT / ".codex" / "skills"


def main():
    CODEX_SKILLS.mkdir(parents=True, exist_ok=True)

    copied = 0
    skipped = 0
    pruned = 0
    wanted = {p.name for p in SDLC_SKILLS.iterdir() if p.is_dir()}
    for src in sorted(SDLC_SKILLS.iterdir()):
        if not src.is_dir():
            continue
        name = src.name
        dst = CODEX_SKILLS / name
        if dst.exists():
            skipped += 1
            continue
        shutil.copytree(src, dst)
        copied += 1
        print(f"Copied {name}")

    # Prune anything not in the canonical set (renames and deletions must not linger).
    for dst in sorted(CODEX_SKILLS.iterdir()):
        if dst.is_dir() and dst.name not in wanted:
            shutil.rmtree(dst)
            pruned += 1
            print(f"Pruned stale skill {dst.name}")

    print(f"Done. {copied} copied, {skipped} already present, {pruned} pruned.")
    print(f"Total skills in .codex/skills: {len([d for d in CODEX_SKILLS.iterdir() if d.is_dir()])}")


if __name__ == "__main__":
    main()
