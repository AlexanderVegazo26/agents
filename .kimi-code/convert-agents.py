#!/usr/bin/env python3
"""Convert .claude/agents/*.md (Claude Code format) to .kimi-code/agents/*.md (Kimi Code format)."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
CLAUDE_AGENTS = ROOT / ".claude" / "agents"
KIMI_AGENTS = ROOT / ".kimi-code" / "agents"

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)

# Claude tool name -> Kimi Code tool name
TOOL_MAP = {
    "Bash": "Bash",
    "Read": "Read",
    "Write": "Write",
    "Edit": "Edit",
    "Grep": "Grep",
    "Glob": "Glob",
}


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


def parse_tool_entries(tools_value: str):
    """Return the list of tool entries from the frontmatter string."""
    return [t.strip() for t in tools_value.split(",")]


def build_tools(tool_entries):
    """Return the allowlist of Kimi Code tool names."""
    tools = []
    for entry in tool_entries:
        name = re.sub(r"\(.*\)", "", entry).strip()
        if name in TOOL_MAP:
            tools.append(TOOL_MAP[name])
    return tools


def extract_subagents(tool_entries):
    """Return the list of subagent names referenced via Agent(name)."""
    names = []
    for entry in tool_entries:
        m = re.match(r"Agent\(([^)]+)\)", entry)
        if m:
            names.append(m.group(1))
    return sorted(set(names))


def extract_when_to_use(description: str):
    """Derive a concise whenToUse from the description."""
    # Take the first sentence or first 160 chars, whichever is shorter.
    first_sentence = description.split(". ")[0]
    if len(first_sentence) > 160:
        return first_sentence[:159].rstrip() + "…"
    return first_sentence


def parse_agent(md_path: Path):
    text = md_path.read_text(encoding="utf-8")
    m = FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError(f"No frontmatter in {md_path}")
    front = parse_simple_frontmatter(m.group(1))
    body = m.group(2)
    return front, body


def format_yaml_list(items):
    if not items:
        return ""
    if len(items) == 1:
        return f"  - {items[0]}"
    return "\n".join(f"  - {item}" for item in items)


def yaml_dq(value: str) -> str:
    """Render a string as a YAML double-quoted scalar.

    Plain (unquoted) scalars break when the value contains ': ' or starts
    with an indicator character, which several agent descriptions do
    (e.g. "INVOKE WHEN: ..."). Invalid frontmatter is skipped by Kimi Code,
    so always quote.
    """
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def write_agent(name: str, front: dict, body: str):
    out_path = KIMI_AGENTS / f"{name}.md"

    description = front.get("description", "").replace("\n", " ")
    when_to_use = extract_when_to_use(description)
    tool_entries = parse_tool_entries(front.get("tools", ""))
    tools = build_tools(tool_entries)
    subagents = extract_subagents(tool_entries)

    lines = [
        "---",
        f"name: {name}",
        f"description: {yaml_dq(description)}",
        f"whenToUse: {yaml_dq(when_to_use)}",
    ]

    if tools:
        lines.append("tools:")
        lines.append(format_yaml_list(tools))

    if subagents:
        lines.append("subagents:")
        lines.append(format_yaml_list(subagents))

    lines.append("---")
    lines.append("")
    lines.append(body)

    out_path.write_text("\n".join(lines), encoding="utf-8", newline="\n")


def main():
    KIMI_AGENTS.mkdir(parents=True, exist_ok=True)
    for md_path in sorted(CLAUDE_AGENTS.glob("*.md")):
        name = md_path.stem
        print(f"Converting {name} ...")
        front, body = parse_agent(md_path)
        write_agent(name, front, body)
    print(f"Done. Agents written to {KIMI_AGENTS}")


if __name__ == "__main__":
    main()
