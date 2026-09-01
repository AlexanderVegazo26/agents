#!/usr/bin/env python3
"""Master sync script: mirror the canonical suite into every harness.

Source of truth is sdlc-suite/ (the Claude Code plugin: 22 agents, 60 skills).
Every other harness tree is regenerated from it so all agents and all skills
are present everywhere, stale files are pruned, and counts are derived rather
than hardcoded.

For each harness this runs:
  - convert-agents.py  -> regenerate agents/ from sdlc-suite/agents/
  - sync-skills.py     -> mirror sdlc-suite/skills/ (copy + prune)

This script only calls the per-harness converters; the conversion logic lives
in those scripts so each harness can be regenerated independently.
"""

from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

# (script, destination kind) — every harness gets agents + skills via its own scripts.
SYNC_SCRIPTS = [
    ROOT / "commandcode-suite" / "convert-agents.py",
    ROOT / "commandcode-suite" / "sync-skills.py",
    ROOT / ".kimi-code" / "convert-agents.py",
    ROOT / ".kimi-code" / "sync-skills.py",
    ROOT / ".codex" / "convert-agents.py",
    ROOT / ".codex" / "sync-skills.py",
    ROOT / ".copilot" / "convert-agents.py",
    ROOT / ".copilot" / "sync-skills.py",
]

# Canonical source of truth — used only to verify (not to guess) the expected counts.
SDLC_AGENTS = ROOT / "sdlc-suite" / "agents"
SDLC_SKILLS = ROOT / "sdlc-suite" / "skills"

# Harness destination directories, used for verification and pruning.
HARNESSES = {
    "commandcode-suite": ROOT / "commandcode-suite",
    ".kimi-code": ROOT / ".kimi-code",
    ".codex": ROOT / ".codex",
    ".copilot": ROOT / ".copilot",
}

# Agent filename extension per harness (kimi/commandcode write .md, codex .toml, copilot .json).
AGENT_EXT = {
    "commandcode-suite": ".md",
    ".kimi-code": ".md",
    ".codex": ".toml",
    ".copilot": ".json",
}

# Skills that exist in sdlc-suite but are workflow launchers rather than agent skills —
# the kimi port keeps these out of skills/ (they live under workflows/). They are
# still part of the canonical 60 and are NOT dropped from any other harness.
KIMI_SKIP_SKILLS = {
    "independent-review",
    "persona-qa-sweep",
    "registry-audit",
    "release-readiness",
    "sdlc-feature",
    "system-archaeology",
}


def run_script(script_path):
    """Run a sync script and return True if successful."""
    print(f"\n{'=' * 60}")
    print(f"Running: {script_path.name} ({script_path.parent.name})")
    print("=" * 60)
    try:
        subprocess.run([sys.executable, str(script_path)], cwd=ROOT, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"ERROR: {script_path.name} failed with exit code {e.returncode}", file=sys.stderr)
        return False


def expected_agent_names():
    return sorted(p.stem for p in SDLC_AGENTS.glob("*.md"))


def expected_skill_names():
    return sorted(p.name for p in SDLC_SKILLS.iterdir() if p.is_dir())


def verify_parity():
    """Every harness must contain every canonical agent and skill (minus kimi's
    explicit exclusions); anything stale must have been pruned by the sync."""
    agents = expected_agent_names()
    skills = expected_skill_names()
    problems = []

    for name, dest in HARNESSES.items():
        agent_dir = dest / "agents"
        skill_dir = dest / "skills"

        # Agents: every canonical agent present, and no agent files the source doesn't have.
        present = {p.stem for p in agent_dir.glob(f"*{AGENT_EXT[name]}")} if agent_dir.exists() else set()
        for a in agents:
            if a not in present:
                problems.append(f"{name}: missing agent {a}")
        for a in sorted(present - set(agents)):
            problems.append(f"{name}: stale agent {a} (not in sdlc-suite)")

        # Skills: every canonical skill present (minus kimi's explicit set), and none stale.
        skip = KIMI_SKIP_SKILLS if name == ".kimi-code" else set()
        want = set(skills) - skip
        have = {p.name for p in skill_dir.iterdir() if p.is_dir()} if skill_dir.exists() else set()
        for s in sorted(want - have):
            problems.append(f"{name}: missing skill {s}")
        # kimi additionally keeps its workflow-launcher skills in skills/; they are
        # expected there, so only flag what is not canonical AND not in kimi's set.
        expected_extra = KIMI_SKIP_SKILLS if name == ".kimi-code" else set()
        for s in sorted(have - want - expected_extra):
            problems.append(f"{name}: stale skill {s}")

    if problems:
        for p in problems:
            print(f"  FAIL: {p}", file=sys.stderr)
        return False
    return True


def main():
    print("Syncing all agents and skills to all harnesses (source of truth: sdlc-suite/)...")
    all_ok = True

    for script in SYNC_SCRIPTS:
        if not script.exists():
            print(f"ERROR: {script} not found", file=sys.stderr)
            all_ok = False
            continue
        if not run_script(script):
            all_ok = False

    print(f"\n{'=' * 60}")
    if not all_ok:
        print("[ERROR] Some syncs failed. Check output above.")
        sys.exit(1)

    n_agents = len(expected_agent_names())
    n_skills = len(expected_skill_names())
    print(f"[OK] All syncs completed successfully!")
    print(f"Source of truth: sdlc-suite/ ({n_agents} agents, {n_skills} skills)")
    for name, dest in HARNESSES.items():
        print(f"  - {name}/agents/ ({n_agents} agents), {name}/skills/ ({n_skills} skills)")

    print("\nVerifying parity across all harnesses...")
    if not verify_parity():
        print("[ERROR] Parity check failed. Run a sync script directly to see details.")
        sys.exit(1)
    print("[OK] Every harness has all agents and all skills, and no stale files.")


if __name__ == "__main__":
    main()
