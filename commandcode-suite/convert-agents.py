#!/usr/bin/env python3
"""Convert sdlc-suite/agents/*.md (Claude Code format) to commandcode-suite/agents/*.md (Command Code format)."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SRC = ROOT.parent / "sdlc-suite" / "agents"
DST = ROOT / "agents"

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)

# Claude tool name -> Command Code tool name
TOOL_MAP = {
    "Bash": "shell_command",
    "Read": "read_file",
    "Write": "write_file",
    "Edit": "edit_file",
    "Grep": "grep",
    "Glob": "glob",
    "TaskCreate": "task_create",
}

# Claude model id -> Command Code model catalog id (or None = follow session model)
MODEL_MAP = {
    "inherit": None,  # omit -> session model
    "sonnet": "claude-sonnet-5",
}

# Command Code reserved subagent names
RESERVED = {"explore", "plan", "review", "general"}


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
    return [t.strip() for t in tools_value.split(",")]


def build_tools(tool_entries):
    """Map Claude tool names to Command Code tool names; drop Agent(x) grants."""
    tools = []
    for entry in tool_entries:
        if entry.startswith("Agent("):
            continue
        name = re.sub(r"\(.*\)", "", entry).strip()
        mapped = TOOL_MAP.get(name)
        if mapped and mapped not in tools:
            tools.append(mapped)
    return tools


def extract_subagent_names(tool_entries):
    """Return referenced subagent names (Agent(x) / Agent(sdlc-suite:x)) for the audit log."""
    names = []
    for entry in tool_entries:
        m = re.match(r"Agent\((?:(?:sdlc-suite):)?([^)]+)\)", entry)
        if m:
            names.append(m.group(1))
    return sorted(set(names))


def convert_model(model_value: str):
    """Return (key_to_write_or_None, note)."""
    v = (model_value or "").strip()
    if not v or v == "inherit":
        return None, "omit (follows session model)"
    mapped = MODEL_MAP.get(v)
    if mapped is None and v != "inherit":
        # Unknown model id: keep it but flag in the audit log
        return v, f"UNMAPPED model id '{v}' kept verbatim"
    return mapped, f"{v} -> {mapped}"


def parse_agent(md_path: Path):
    text = md_path.read_text(encoding="utf-8")
    m = FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError(f"No frontmatter in {md_path}")
    front = parse_simple_frontmatter(m.group(1))
    body = m.group(2)
    return front, body


def write_agent(name: str, front: dict, body: str):
    out_path = DST / f"{name}.md"

    description = front.get("description", "").replace("\n", " ")
    tool_entries = parse_tool_entries(front.get("tools", ""))
    tools = build_tools(tool_entries)
    subagents = extract_subagent_names(tool_entries)

    # model handling
    model_key = convert_model(front.get("model", ""))

    lines = [
        "---",
        f"name: {name}",
        f"description: {description}",
    ]

    if tools:
        lines.append(f"tools: {', '.join(tools)}")
    elif subagents:
        # An agent that only delegates still needs at least the task tool
        lines.append("tools: agent")

    if model_key[0]:
        lines.append(f"model: {model_key[0]}")

    lines.append("---")
    lines.append("")
    lines.append(body)

    out_path.write_text("\n".join(lines), encoding="utf-8")
    return subagents, model_key[1]


def main():
    DST.mkdir(parents=True, exist_ok=True)

    audit = []
    for md_path in sorted(SRC.glob("*.md")):
        name = md_path.stem
        front, body = parse_agent(md_path)
        subagents, model_note = write_agent(name, front, body)
        audit.append((name, subagents, model_note))
        print(f"Converted {name}")

    print()
    print(f"Done. Agents written to {DST}")
    print(f"Total: {len(audit)}")

    # Audit report
    print()
    print("=== Delegation audit (Agent(x) grants found in source) ===")
    for name, subagents, model_note in audit:
        if subagents:
            print(f"  {name}: -> {', '.join(subagents)}")

    print()
    print("=== Model mapping ===")
    for name, subagents, model_note in audit:
        if model_note and "UNMAPPED" not in model_note:
            print(f"  {name}: {model_note}")

    # Cross-check: every delegated agent must exist as a file (or be a reserved built-in)
    print()
    print("=== Delegation existence check ===")
    existing = {p.stem for p in DST.glob("*.md")}
    ok = True
    for name, subagents, _ in audit:
        for s in subagents:
            if s not in existing and s not in RESERVED:
                print(f"  MISSING TARGET: {name} delegates to {s}, no agents/{s}.md and not a built-in")
                ok = False
    if ok:
        print("  All delegated agents exist (or are built-ins).")


if __name__ == "__main__":
    main()
