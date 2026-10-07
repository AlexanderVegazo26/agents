#!/usr/bin/env python3
"""Validate the .pi tree and the sdlc extension that backs it.

Checks:
  - every prompt in .pi/prompts/ has frontmatter with a non-empty description
  - no prompt still carries ${CLAUDE_PLUGIN_ROOT} or the sdlc-suite: namespace
    prefix — both are rewritten by the generator, so a remainder is drift
  - every workflow-backed prompt names a scriptPath that exists in the repo,
    and carries the pi note that says the `Workflow` tool is the `workflow`
    tool of .pi/extensions/sdlc/
  - the repository-root AGENTS.md is the generated copy of
    sdlc-suite/pi/AGENTS.md: its first line is the generator's header and the
    remainder is the canonical file, byte for byte
  - the extension's selftest passes under the host's node (no pi, no network,
    no LLM required)

Exits 1 on any failure and 2 on a zero-file prompt scan (a missing or
renamed .pi/prompts/ must not read as a pass).
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent          # <repo>/.pi
REPO = ROOT.parent
PROMPTS_DIR = ROOT / "prompts"
EXT_LIB = ROOT / "extensions" / "sdlc" / "lib.js"
ROOT_AGENTS = REPO / "AGENTS.md"
CANON_AGENTS = REPO / "sdlc-suite" / "pi" / "AGENTS.md"

FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n(.*)\Z", re.DOTALL)
SCRIPTPATH_RE = re.compile(r'scriptPath:\s*"([^"]+)"')
NOTE_MARKER = "> **Pi.**"
PLUGIN_ROOT_MARKER = "${CLAUDE_PLUGIN_ROOT}"
NAMESPACE_MARKER = "sdlc-suite:"


def parse_frontmatter(text):
    front = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m:
            front[m.group(1)] = m.group(2).strip()
    return front


def main():
    ok = True
    scanned = 0

    print("=== .pi/prompts ===")
    if not PROMPTS_DIR.is_dir():
        print(f"FAIL {PROMPTS_DIR}: directory missing")
        ok = False
    for f in sorted(PROMPTS_DIR.glob("*.md")):
        scanned += 1
        text = f.read_text(encoding="utf-8")
        m = FRONTMATTER_RE.match(text)
        if not m:
            print(f"FAIL {f.name}: no frontmatter block")
            ok = False
            continue
        front = parse_frontmatter(m.group(1))
        body = m.group(2)
        name_ok = True
        if not front.get("description"):
            print(f"FAIL {f.name}: missing description in frontmatter")
            ok = False
            name_ok = False
        if PLUGIN_ROOT_MARKER in text:
            print(f"FAIL {f.name}: still contains {PLUGIN_ROOT_MARKER} — generator rewrite missing")
            ok = False
            name_ok = False
        if NAMESPACE_MARKER in body:
            print(f"FAIL {f.name}: body still carries the 'sdlc-suite:' namespace prefix")
            ok = False
            name_ok = False

        sp = SCRIPTPATH_RE.search(body)
        if sp:
            # Workflow-backed command: the script must exist and the pi note
            # must be present, so a session that lacks the extension says so
            # instead of improvising a substitute run.
            target = REPO / sp.group(1)
            if not target.is_file():
                print(f"FAIL {f.name}: scriptPath '{sp.group(1)}' does not exist")
                ok = False
                name_ok = False
            if NOTE_MARKER not in body:
                print(f"FAIL {f.name}: workflow-backed prompt missing the pi note ({NOTE_MARKER!r})")
                ok = False
                name_ok = False
        if name_ok:
            print(f"OK   {f.name}")

    if scanned == 0 and ok:
        print(f"FAIL {PROMPTS_DIR}: zero prompts scanned — the directory is empty or missing")
        print()
        print("Structural validation FAILED.")
        sys.exit(2)

    print()
    print("=== root AGENTS.md ===")
    if not ROOT_AGENTS.is_file():
        print(f"FAIL {ROOT_AGENTS}: missing")
        ok = False
    elif not CANON_AGENTS.is_file():
        print(f"FAIL {CANON_AGENTS}: missing (the source of the generated copy)")
        ok = False
    else:
        root_text = ROOT_AGENTS.read_text(encoding="utf-8")
        canon = CANON_AGENTS.read_text(encoding="utf-8")
        lines = root_text.split("\n", 2)
        header_ok = (
            len(lines) == 3
            and lines[0].startswith("<!-- GENERATED from sdlc-suite/pi/AGENTS.md")
            and lines[1] == ""
        )
        # The generator strips the canonical body and appends one newline:
        # header + "\n\n" + canon.strip() + "\n".
        expected = canon.strip() + "\n"
        body = lines[2] if header_ok else root_text
        if not header_ok:
            print(f"FAIL {ROOT_AGENTS.name}: missing the GENERATED header — regenerate")
            ok = False
        elif body != expected:
            print(f"FAIL {ROOT_AGENTS.name}: body differs from sdlc-suite/pi/AGENTS.md — regenerate")
            ok = False
        else:
            print(f"OK   {ROOT_AGENTS.name} is the generated copy of sdlc-suite/pi/AGENTS.md")

    print()
    print("=== sdlc extension selftest ===")
    if not EXT_LIB.is_file():
        print(f"FAIL {EXT_LIB}: missing")
        ok = False
    else:
        r = subprocess.run(["node", str(EXT_LIB), "--selftest"], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"FAIL {EXT_LIB.name} --selftest exited {r.returncode}")
            print((r.stdout.strip() or r.stderr.strip())[-800:])
            ok = False
        else:
            last = [l for l in r.stdout.strip().splitlines() if l.strip()]
            print(f"OK   node {EXT_LIB.name} --selftest ({last[-1] if last else 'pass'})")

    if not ok:
        print()
        print("Structural validation FAILED.")
        sys.exit(1)
    print()
    print(f"All .pi checks passed ({scanned} prompts).")


if __name__ == "__main__":
    main()
