#!/usr/bin/env python3
"""Convert .claude/agents/*.md (Claude Code format) to .copilot/agents/*.json (Copilot JSON format)."""

from pathlib import Path
import re
import json

ROOT = Path(__file__).resolve().parent.parent
CLAUDE_AGENTS = ROOT / ".claude" / "agents"
COPILOT_AGENTS = ROOT / ".copilot" / "agents"

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)

# Claude tool name -> Copilot tool name (pass through for now, Copilot uses same names)
TOOL_MAP = {
    "Bash": "bash",
    "Read": "read",
    "Write": "write",
    "Edit": "edit",
    "Grep": "grep",
    "Glob": "glob",
    "Agent": "spawn-agent",
    "TaskCreate": "create-task",
    "TaskUpdate": "update-task",
    "Artifact": "artifact",
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
    """Return the list of Copilot tool names."""
    tools = []
    seen = set()
    for entry in tool_entries:
        # Extract tool name before any parentheses or Agent( calls
        name = re.sub(r"\(.*", "", entry).strip()
        if name in TOOL_MAP and name not in seen:
            tools.append(TOOL_MAP[name])
            seen.add(name)
    return sorted(tools)


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


def write_agent(name: str, front: dict, body: str):
    out_path = COPILOT_AGENTS / f"{name}.json"

    description = front.get("description", "").replace("\n", " ").strip()
    when_to_use = extract_when_to_use(description)
    tool_entries = parse_tool_entries(front.get("tools", ""))
    tools = build_tools(tool_entries)
    subagents = extract_subagents(tool_entries)

    agent_def = {
        "name": name,
        "description": description,
        "whenToUse": when_to_use,
    }

    if tools:
        agent_def["tools"] = tools

    if subagents:
        agent_def["subagents"] = subagents

    # Store the full body for reference (agent implementations can use this)
    if body.strip():
        agent_def["body"] = body.strip()

    out_path.write_text(json.dumps(agent_def, indent=2, ensure_ascii=False), encoding="utf-8")


def main():
    COPILOT_AGENTS.mkdir(parents=True, exist_ok=True)
    for md_path in sorted(CLAUDE_AGENTS.glob("*.md")):
        name = md_path.stem
        print(f"Converting {name} ...")
        front, body = parse_agent(md_path)
        write_agent(name, front, body)
    print(f"Done. Agents written to {COPILOT_AGENTS}")


if __name__ == "__main__":
    main()
