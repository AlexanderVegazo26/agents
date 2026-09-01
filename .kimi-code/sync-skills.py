#!/usr/bin/env python3
"""Mirror sdlc-suite/skills/ into .kimi-code/skills/ (one-way, with prune).

Six skills in sdlc-suite are workflow launchers, not agent skills; the kimi port
keeps those under .kimi-code/workflows/ instead of skills/, so they are excluded
from the mirror and never pruned. Everything else must match sdlc-suite exactly.
"""

from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
SDLC_SKILLS = ROOT / "sdlc-suite" / "skills"
KIMI_SKILLS = ROOT / ".kimi-code" / "skills"

# Workflow-launcher skills that live under .kimi-code/workflows/ instead of skills/.
SKIP = {
    "independent-review",
    "persona-qa-sweep",
    "registry-audit",
    "release-readiness",
    "sdlc-feature",
    "system-archaeology",
}


def main():
    KIMI_SKILLS.mkdir(parents=True, exist_ok=True)

    copied = 0
    skipped = 0
    pruned = 0
    wanted = {p.name for p in SDLC_SKILLS.iterdir() if p.is_dir() and p.name not in SKIP}
    for src in sorted(SDLC_SKILLS.iterdir()):
        if not src.is_dir() or src.name in SKIP:
            continue
        name = src.name
        dst = KIMI_SKILLS / name
        if dst.exists():
            skipped += 1
            continue
        shutil.copytree(src, dst)
        copied += 1
        print(f"Copied {name}")

    # Prune anything not in the canonical set (renames and deletions must not linger).
    for dst in sorted(KIMI_SKILLS.iterdir()):
        if dst.is_dir() and dst.name not in wanted and dst.name not in SKIP:
            shutil.rmtree(dst)
            pruned += 1
            print(f"Pruned stale skill {dst.name}")

    print(f"Done. {copied} copied, {skipped} already present, {pruned} pruned.")
    print(f"Total skills in .kimi-code/skills: {len([d for d in KIMI_SKILLS.iterdir() if d.is_dir()])}")


if __name__ == "__main__":
    main()
