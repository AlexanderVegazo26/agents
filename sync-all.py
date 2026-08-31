#!/usr/bin/env python3
"""Master sync script: syncs agents and skills to all harnesses (Kimi Code, Copilot)."""

from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

SYNC_SCRIPTS = [
    ROOT / ".kimi-code" / "convert-agents.py",
    ROOT / ".kimi-code" / "sync-skills.py",
    ROOT / ".copilot" / "convert-agents.py",
    ROOT / ".copilot" / "sync-skills.py",
    ROOT / "commandcode-suite" / "convert-agents.py",
    ROOT / "commandcode-suite" / "sync-skills.py",
]


def run_script(script_path):
    """Run a sync script and return True if successful."""
    print(f"\n{'='*60}")
    print(f"Running: {script_path.name} ({script_path.parent.name})")
    print('='*60)
    try:
        result = subprocess.run(
            [sys.executable, str(script_path)],
            cwd=ROOT,
            check=True,
        )
        return True
    except subprocess.CalledProcessError as e:
        print(f"ERROR: {script_path.name} failed with exit code {e.returncode}", file=sys.stderr)
        return False


def main():
    print("Syncing all agents and skills to all harnesses...")
    all_ok = True
    for script in SYNC_SCRIPTS:
        if not script.exists():
            print(f"ERROR: {script} not found", file=sys.stderr)
            all_ok = False
            continue
        if not run_script(script):
            all_ok = False

    print(f"\n{'='*60}")
    if all_ok:
        print("[OK] All syncs completed successfully!")
        print("Synced to:")
        print("  - .kimi-code/agents/ (22 agents)")
        print("  - .kimi-code/skills/ (65 skills)")
        print("  - .copilot/agents/ (22 agents)")
        print("  - .copilot/skills/ (59 skills)")
        print("  - commandcode-suite/agents/ (22 agents)")
        print("  - commandcode-suite/skills/ (59 skills)")
    else:
        print("[ERROR] Some syncs failed. Check output above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
