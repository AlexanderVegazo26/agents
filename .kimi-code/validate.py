#!/usr/bin/env python3
"""Validate the .kimi-code setup."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
AGENTS_DIR = ROOT / ".kimi-code" / "agents"
SKILLS_DIR = ROOT / ".kimi-code" / "skills"


def main():
    ok = True

    print("=== .kimi-code/agents ===")
    for f in sorted(AGENTS_DIR.glob("*.md")):
        text = f.read_text(encoding="utf-8")
        m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, re.DOTALL)
        if not m:
            print(f"FAIL {f.name}: no frontmatter")
            ok = False
            continue
        front = m.group(1)
        missing = [r for r in ["name:", "description:"] if r not in front]
        if missing:
            print(f"FAIL {f.name}: missing {missing}")
            ok = False
            continue
        # Unquoted plain scalars break YAML when the value contains ': '
        # (or starts with an indicator char). Kimi Code silently skips
        # agents with invalid frontmatter, so fail loudly here.
        unsafe = []
        for line in front.splitlines():
            kv = re.match(r"^([A-Za-z0-9_-]+):\s+(\S.*)$", line)
            if kv and not kv.group(2).startswith(('"', "'")):
                if ": " in kv.group(2) or kv.group(2).endswith(":"):
                    unsafe.append(kv.group(1))
        if unsafe:
            print(f"FAIL {f.name}: unquoted scalar(s) with ':' in value: {unsafe} — wrap in quotes")
            ok = False
            continue
        print(f"OK   {f.name}")

    print()
    flow_skills = {
        "sdlc-feature",
        "independent-review",
        "release-readiness",
        "persona-qa-sweep",
        "system-archaeology",
        "registry-audit",
    }

    print("=== .kimi-code/skills ===")
    for f in sorted(SKILLS_DIR.glob("*/SKILL.md")):
        name = f.parent.name
        text = f.read_text(encoding="utf-8")
        if "name:" not in text:
            print(f"FAIL {name}: missing name")
            ok = False
            continue
        if "description:" not in text:
            print(f"FAIL {name}: missing description")
            ok = False
            continue
        if name in flow_skills:
            if "type: flow" not in text:
                print(f"FAIL {name}: missing type: flow")
                ok = False
                continue
            m = re.search(r"```d2\s*(.*?)\s*```", text, re.DOTALL)
            if not m:
                print(f"FAIL {name}: no D2 diagram")
                ok = False
                continue
            diagram = m.group(1)
            if "BEGIN" not in diagram or "END" not in diagram:
                print(f"FAIL {name}: missing BEGIN/END")
                ok = False
                continue
        print(f"OK   {name}")

    if not ok:
        raise SystemExit(1)
    print()
    print("All .kimi-code files look structurally valid.")


if __name__ == "__main__":
    main()
