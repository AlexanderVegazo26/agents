#!/usr/bin/env python3
"""Validate the commandcode-suite structural invariants.

Checks:
  - every agent has name/description frontmatter, name matches filename stem,
    name is kebab-case, not a reserved built-in subagent
  - every tool in tools: is a real Command Code tool name
  - every delegation target (task tool) referenced in the body resolves to an
    agent file or a built-in
  - every skill has name/description frontmatter
  - every workflow file is syntactically valid JS (node --check)
"""

from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
AGENTS_DIR = ROOT / "agents"
SKILLS_DIR = ROOT / "skills"
WORKFLOWS_DIR = ROOT / "workflows"

# Command Code tool names (subset used by this suite; "*" = all tools allowed)
KNOWN_TOOLS = {
    "shell_command", "read_file", "write_file", "edit_file", "grep", "glob",
    "task_create", "task_update", "task_list", "task_get", "task_output",
    "task_stop", "agent", "read_multiple_files", "read_directory", "powershell",
    "web_search", "web_fetch", "vision", "*",
}

# Command Code reserved built-in subagent types (must not be used as agent names)
RESERVED_AGENTS = {"explore", "plan", "review", "general"}

# Built-in subagent types that remain valid delegation targets
BUILTIN_TARGETS = RESERVED_AGENTS

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def parse_frontmatter(text):
    front = {}
    current_key = None
    current_value = []
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m:
            if current_key is not None:
                front[current_key] = "\n".join(current_value).strip()
            current_key = m.group(1)
            current_value = [m.group(2)]
        else:
            current_value.append(line)
    if current_key is not None:
        front[current_key] = "\n".join(current_value).strip()
    return front


def kebab_ok(name):
    return bool(re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", name))


def main():
    ok = True
    agent_names = []

    print("=== agents ===")
    for f in sorted(AGENTS_DIR.glob("*.md")):
        text = f.read_text(encoding="utf-8")
        m = FRONTMATTER_RE.match(text)
        if not m:
            print(f"FAIL {f.name}: no frontmatter")
            ok = False
            continue
        front = parse_frontmatter(m.group(1))
        body = m.group(2)

        name = front.get("name", "")
        if not name:
            print(f"FAIL {f.name}: missing name")
            ok = False
        elif name != f.stem:
            print(f"FAIL {f.name}: name '{name}' != filename stem '{f.stem}'")
            ok = False
        elif not kebab_ok(name):
            print(f"FAIL {f.name}: name '{name}' not kebab-case")
            ok = False
        elif name in RESERVED_AGENTS:
            print(f"FAIL {f.name}: name '{name}' is a reserved built-in")
            ok = False

        if not front.get("description"):
            print(f"FAIL {f.name}: missing description")
            ok = False

        tools = [t.strip() for t in front.get("tools", "").split(",") if t.strip()]
        for t in tools:
            if t not in KNOWN_TOOLS:
                print(f"FAIL {f.name}: unknown tool '{t}'")
                ok = False

        # Delegation targets: anything the body names in Agent(...) or
        # "delegate to X" patterns must resolve. The task tool dispatches by
        # subagent name, so the target must be an agent file or a built-in.
        for t in re.findall(r"Agent\((?:\w+:)?([a-z0-9-]+)\)", body):
            if t not in agent_names and t not in BUILTIN_TARGETS and not (AGENTS_DIR / f"{t}.md").exists():
                print(f"FAIL {f.name}: delegates to '{t}' — no agents/{t}.md and not a built-in")
                ok = False

        agent_names.append(name)
        print(f"OK   {f.name}")

    print()
    print("=== skills ===")
    for f in sorted(SKILLS_DIR.glob("*/SKILL.md")):
        text = f.read_text(encoding="utf-8")
        m = FRONTMATTER_RE.match(text)
        if not m:
            print(f"FAIL {f.parent.name}: no frontmatter")
            ok = False
            continue
        front = parse_frontmatter(m.group(1))
        name = front.get("name", "")
        if not name:
            print(f"FAIL {f.parent.name}: missing name")
            ok = False
        elif name != f.parent.name:
            print(f"FAIL {f.parent.name}: frontmatter name '{name}' != dir name")
            ok = False
        if not front.get("description"):
            print(f"FAIL {f.parent.name}: missing description")
            ok = False
        print(f"OK   {f.parent.name}")

    print()
    print("=== workflows ===")
    for f in sorted(WORKFLOWS_DIR.glob("*.js")):
        r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"FAIL {f.name}: node --check failed\n{r.stderr.strip()[:500]}")
            ok = False
        else:
            print(f"OK   {f.name}")

    if not ok:
        print()
        print("Structural validation FAILED.")
        sys.exit(1)
    print()
    print("All commandcode-suite files look structurally valid.")


if __name__ == "__main__":
    main()
