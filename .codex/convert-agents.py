#!/usr/bin/env python3
"""Convert sdlc-suite/agents/*.md (Claude Code plugin format) to .codex/agents/*.toml (Codex TOML format)."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
CLAUDE_AGENTS = ROOT / "sdlc-suite" / "agents"
CODEX_AGENTS = ROOT / ".codex" / "agents"

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def parse_simple_frontmatter(text: str):
    """Parse the simple key: value / key: [list] frontmatter used by these agents."""
    result = {}
    current_key = None
    current_value = []
    for line in text.splitlines():
        if not line.strip():
            continue
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m:
            if current_key is not None:
                result[current_key] = "\n".join(current_value).strip()
            current_key = m.group(1)
            current_value = [m.group(2)]
        else:
            current_value.append(line)
    if current_key is not None:
        result[current_key] = "\n".join(current_value).strip()
    return result


def escape_toml_string(s: str) -> str:
    """Escape a string for TOML."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def parse_agent(md_path: Path):
    text = md_path.read_text(encoding="utf-8")
    m = FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError(f"No frontmatter in {md_path}")
    front = parse_simple_frontmatter(m.group(1))
    body = m.group(2)
    return front, body


def write_agent(name: str, front: dict, body: str):
    out_path = CODEX_AGENTS / f"{name}.toml"

    description = front.get("description", "").replace("\n", " ").strip()
    body_content = body.strip()

    # Write TOML manually (no external dependencies)
    lines = [
        f'name = "{escape_toml_string(name)}"',
        f'description = "{escape_toml_string(description)}"',
        f'developer_instructions = """{body_content}"""',
    ]

    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))


def main():
    CODEX_AGENTS.mkdir(parents=True, exist_ok=True)
    for md_path in sorted(CLAUDE_AGENTS.glob("*.md")):
        name = md_path.stem
        print(f"Converting {name} ...")
        front, body = parse_agent(md_path)
        write_agent(name, front, body)
    print(f"Done. Agents written to {CODEX_AGENTS}")


if __name__ == "__main__":
    main()
