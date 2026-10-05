#!/usr/bin/env python3
"""One canonical tree, seven generated. Replaces the four convert-agents.py /
sync-skills.py pairs and the skip-if-exists mirror that froze them.

    python sdlc-suite/tools/generate_trees.py            # regenerate everything
    python sdlc-suite/tools/generate_trees.py --check    # exit non-zero if any tree drifted
    python sdlc-suite/tools/generate_trees.py --tree .claude    # one target only
    python sdlc-suite/tools/generate_trees.py --diff     # with --check, show what differs

Why this exists
---------------
Two defects, both of which report success while doing nothing.

**Skip-if-exists.** Every `sync-skills.py` did::

    if dst.exists():
        skipped += 1
        continue

so a skill edited in the source was copied the first time and never again, across
four trees, while the tool printed `[OK] All syncs completed successfully!`. The
parity check added later compares *names*, so it passes on a content change too.
This generator compares bytes.

**A directory-level check cannot see a missing file inside a directory that
exists.** `commandcode-suite/skills/exploration-charter/` is present but is
missing `personas-schema-template.yaml`, which a workflow prompt tells agents to
conform to by name. Name-level parity reports that tree as clean. This generator
compares recursively.

The namespace transform
-----------------------
This is the part that makes a naive byte-mirror wrong. `sdlc-suite/` is a Claude
Code *plugin*, so it refers to its own agents and skills as `sdlc-suite:name`.
Trees installed as plain project directories resolve **bare** names, and a
`sdlc-suite:` prefix there is dead text that silently resolves to nothing.

Measured before writing this: `sdlc-suite/skills` carries 120 `sdlc-suite:`
references, `commandcode-suite/skills` 127, and `.claude`, `.kimi-code`,
`.codex`, `.copilot` carry 3 each — all three of those being leaks from the one
skill that was copied without the transform. `.agents` carries 0.

So the prefix is per-target, not global, and mirroring the canonical tree
verbatim into the bare-name trees would push 120 dead references into each.

The pi target
-------------
Pi is the one port that is not a dot-directory mirror. It discovers skills
itself — the Agent Skills location `.agents/skills/`, already generated for
another harness — so copying a seventh skills tree into it would create the
duplication hazard this repository's README warns about. What it gets is:

* `.pi/prompts/` — the commands, de-namespaced, with
  `${CLAUDE_PLUGIN_ROOT}` rewritten to the repository-relative `sdlc-suite`.
  The commands backed by `workflows/*.js` carry an inserted note that the
  `Workflow` tool is the `workflow` tool of the hand-maintained
  `.pi/extensions/sdlc/` extension. The note is generation, not canon: the
  canonical command must keep working in Claude Code, where the tool exists.
* the repository-root `AGENTS.md` — from the hand-edited
  `sdlc-suite/pi/AGENTS.md`, with a GENERATED header.

Those two locations span one target, so its base is the repository root
itself, and only the generator-owned paths are diffed: a hand-maintained
`.pi/settings.json` or `.pi/extensions/` is never touched or pruned.

The Hermes target
-----------------
Hermes is shaped like pi: it discovers `.agents/skills/` itself (as a
project-local skill directory, once the repository is trusted), so it gets no
skills copy either. What it gets is:

* `.hermes/skills/<command>/SKILL.md` — the commands as skills, because
  Hermes has no prompt-template directory: every skill is a `/<name>` slash
  command, and the text typed after it arrives as a `User instruction:` line,
  which is what `$ARGUMENTS` is rewritten to name. Same two body transforms as
  pi, and the workflow-backed ones carry a Hermes note instead of pi's.
* the repository-root `.hermes.md` — from the hand-edited
  `sdlc-suite/hermes/HERMES.md`. Hermes loads `.hermes.md` ahead of
  `AGENTS.md`, which is what keeps pi's instance file, and its pi-only tools,
  out of a Hermes session.

The role agents are deliberately not turned into skills (see HERMES.md), and
`.hermes/plugins/` is hand-maintained: only `.hermes/skills/` and `.hermes.md`
are diffed or pruned.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC_AGENTS = ROOT / "sdlc-suite" / "agents"
SRC_SKILLS = ROOT / "sdlc-suite" / "skills"
SRC_WORKFLOWS = ROOT / "sdlc-suite" / "workflows"
SRC_COMMANDS = ROOT / "sdlc-suite" / "commands"
SRC_PI_AGENTS = ROOT / "sdlc-suite" / "pi" / "AGENTS.md"
SRC_HERMES_MD = ROOT / "sdlc-suite" / "hermes" / "HERMES.md"
#: Claude Code's plugin-root variable. Undefined in pi, where the equivalent
#: content lives at the repository-relative canonical path.
PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}"

NS = "sdlc-suite:"

GENERATED_MD = (
    "<!-- GENERATED from {src} — do not edit. Run "
    "python sdlc-suite/tools/generate_trees.py -->"
)

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)

# Skills that are workflow launchers rather than agent skills. The Kimi port keeps
# these out of skills/ because they live under workflows/ there. They remain part
# of the canonical set and are not dropped from any other tree.
FLOW_SKILLS = {
    "independent-review",
    "persona-qa-sweep",
    "registry-audit",
    "release-readiness",
    "sdlc-feature",
    "system-archaeology",
}


# --------------------------------------------------------------------------- #
# Frontmatter
# --------------------------------------------------------------------------- #

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse the simple `key: value` frontmatter these agents use.

    Deliberately not a YAML parser: the descriptions contain `: ` (every
    `INVOKE WHEN: ...` clause does), and a real YAML load would either fail or
    require the source to be quoted, which it is not.
    """
    m = FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError("no frontmatter")
    front: dict[str, str] = {}
    key, buf = None, []
    for line in m.group(1).splitlines():
        if not line.strip():
            continue
        km = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if km:
            if key is not None:
                front[key] = "\n".join(buf).strip()
            key, buf = km.group(1), [km.group(2)]
        else:
            buf.append(line)
    if key is not None:
        front[key] = "\n".join(buf).strip()
    return front, m.group(2)


def tool_entries(front: dict) -> list[str]:
    raw = front.get("tools", "")
    return [t.strip() for t in raw.split(",") if t.strip()]


def subagents(entries: list[str]) -> list[str]:
    """Agent(name) grants, de-namespaced and deduplicated.

    The canonical tree grants both `Agent(qa-runner)` and
    `Agent(sdlc-suite:qa-runner)` so a plugin install resolves either spelling.
    A bare-name tree wants one entry, not two spellings of one.
    """
    names = []
    for e in entries:
        m = re.match(r"Agent\(([^)]+)\)", e)
        if m:
            names.append(m.group(1).removeprefix(NS))
    return sorted(set(names))


def when_to_use(description: str) -> str:
    first = description.split(". ")[0]
    return first[:159].rstrip() + "…" if len(first) > 160 else first


def yaml_dq(value: str) -> str:
    """Render as a YAML double-quoted scalar.

    An unquoted scalar breaks on `: ` or a leading indicator character, and a
    harness that cannot parse the frontmatter skips the agent silently — which
    is how agents vanish from a roster without an error.
    """
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def toml_dq(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def denamespace(text: str) -> str:
    return text.replace(NS, "")


def _read_lf(p: Path) -> str:
    """Read a file's real bytes and normalise line endings to LF.

    `read_bytes`, never `read_text`. Python's text mode universal-newline-
    translates on read, so a CRLF file decodes identically to its LF twin — the
    generator then reports it "unchanged" and leaves on disk exactly the bytes
    that have silently unregistered agents in this repository before. It is the
    same blind spot `git diff --no-index` has, and it is precisely the class of
    defect this tool exists to close, so it must not have it itself.

    Normalising here rather than only on write also means a CRLF *source* file
    cannot propagate CRLF into six generated trees.
    """
    return p.read_bytes().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")


# --------------------------------------------------------------------------- #
# Target definitions
# --------------------------------------------------------------------------- #

@dataclass
class Target:
    name: str
    #: keep the `sdlc-suite:` prefix on agent/skill references
    namespaced: bool
    #: agent file extension; None means this tree ships no agents
    agent_ext: str | None
    #: emit function name, resolved below
    agent_format: str | None = None
    #: Claude tool name -> this harness's tool name. Empty means pass through.
    tool_map: dict[str, str] = field(default_factory=dict)
    #: canonical skills this tree does not carry
    skip_skills: set[str] = field(default_factory=set)
    #: skill directories this tree owns locally. Not generated, and NOT pruned —
    #: without this the generator would delete them as "not in the source", which
    #: is a regression dressed up as a sync.
    local_skills: set[str] = field(default_factory=set)
    #: emit a `GENERATED` header comment into agent files
    header: bool = True
    #: What to do with `Agent(x)` grants. Command Code's tool vocabulary has a
    #: bare `agent` tool and no parameterised form, so `Agent(qa-runner)` is an
    #: unknown tool there and its own validator rejects it. "drop" reproduces
    #: what that harness's original converter did.
    agent_grants: str = "keep"          # keep | drop
    #: Claude `model:` value -> this harness's model id. A value mapping to None
    #: is omitted entirely, which is how "inherit" means "follow the session".
    model_map: dict[str, str | None] = field(default_factory=dict)
    #: frontmatter key order; keys not listed are appended in source order.
    #: `version` sits second, matching where the source carries it, so the
    #: Markdown trees are byte-comparable against sdlc-suite/ line for line.
    key_order: tuple = ("name", "version", "description", "tools", "skills", "model")
    #: also generate `workflows/*.js`. True only where the tree is a straight
    #: de-namespaced copy of the canonical scripts — see desired_files().
    workflows: bool = False
    #: directory (relative to the repository root) the tree lives in; defaults
    #: to the target name. `.pi` spans `.pi/prompts/` and the repository-root
    #: `AGENTS.md`, so its base is the root itself — see "The pi target".
    base: Path | None = None


TARGETS = {
    # The live Claude Code project tree. Bare names; same Markdown shape as the
    # source, so the only transform is de-namespacing.
    ".claude": Target(".claude", namespaced=False, agent_ext=".md", agent_format="markdown",
                      workflows=True),

    # Command Code. Keeps the namespace — it is the one port whose references are
    # already namespaced, and changing that is a behavioural decision, not a
    # generation detail.
    "commandcode-suite": Target(
        "commandcode-suite", namespaced=True, agent_ext=".md", agent_format="markdown",
        tool_map={"Bash": "shell_command", "Read": "read_file", "Write": "write_file",
                  "Edit": "edit_file", "Grep": "grep", "Glob": "glob"},
        # `Agent(x)` is not a Command Code tool name — `commandcode-suite/validate.py`
        # rejects it as unknown. Its own converter dropped these grants; so do we.
        agent_grants="drop",
        # "inherit" is omitted so the agent follows the session model.
        model_map={"inherit": None},
    ),

    # Kimi Code. Adds whenToUse and a subagents list; the six flow skills live
    # under workflows/ there, not skills/.
    ".kimi-code": Target(
        ".kimi-code", namespaced=False, agent_ext=".md", agent_format="kimi",
        tool_map={"Bash": "Bash", "Read": "Read", "Write": "Write",
                  "Edit": "Edit", "Grep": "Grep", "Glob": "Glob"},
        # The six workflow launchers are packaged as `type: flow` skills here and
        # live under workflows/ in every other tree. `.kimi-code/README.md` and
        # `AGENTS.md` both document "60 domain skills + 6 flow skills" — that is
        # correct, so they are excluded from generation and protected from pruning.
        skip_skills=FLOW_SKILLS,
        local_skills=FLOW_SKILLS,
    ),

    ".copilot": Target(
        ".copilot", namespaced=False, agent_ext=".json", agent_format="json",
        tool_map={"Bash": "bash", "Read": "read", "Write": "write", "Edit": "edit",
                  "Grep": "grep", "Glob": "glob", "Agent": "spawn-agent",
                  "Artifact": "artifact", "Skill": "skill"},
    ),

    ".codex": Target(".codex", namespaced=False, agent_ext=".toml", agent_format="toml"),

    # Skills only. No agents directory and no converter has ever produced one —
    # which is why it silently fell one skill behind: it was in no sync script.
    ".agents": Target(".agents", namespaced=False, agent_ext=None),

    # pi. No agents, no skills of its own: pi discovers `.agents/skills/`
    # itself, so a seventh skills copy would be the duplication hazard the
    # README warns about. What it gets is `.pi/prompts/` (the commands,
    # de-namespaced, `${CLAUDE_PLUGIN_ROOT}` rewritten repository-relative)
    # and the repository-root `AGENTS.md` — see "The pi target" above.
    ".pi": Target(".pi", namespaced=False, agent_ext=None, base=Path(".")),

    # Hermes Agent. Like pi: no agents and no skills copy (it reads
    # `.agents/skills/` as a project skill directory). It gets the commands as
    # `.hermes/skills/<command>/SKILL.md` and the root `.hermes.md` — see
    # "The Hermes target" above.
    ".hermes": Target(".hermes", namespaced=False, agent_ext=None, base=Path(".")),
}


# --------------------------------------------------------------------------- #
# Emitters — each returns the exact bytes for one agent file
# --------------------------------------------------------------------------- #

def render_tools(front: dict, t: Target) -> str:
    """Map, filter and dedupe the tool grants for one target.

    Dedupe ALWAYS, not only when a tool_map applies. The canonical tree grants
    both `Agent(qa-runner)` and `Agent(sdlc-suite:qa-runner)` so a plugin install
    resolves either spelling; de-namespacing collapses them to one token, and
    without dedupe every bare-name tree gets `Agent(qa-runner), Agent(qa-runner)`.
    """
    mapped: list[str] = []
    for e in tool_entries(front):
        base = re.sub(r"\(.*\)", "", e).strip()
        if base == "Agent":
            if t.agent_grants == "keep":
                mapped.append(e)
            continue
        if not t.tool_map:
            mapped.append(e)
        elif base in t.tool_map:
            mapped.append(t.tool_map[base])
        # a tool this harness has no name for is dropped, as the converters did
    return ", ".join(dict.fromkeys(mapped))


def emit_markdown(name: str, front: dict, body: str, t: Target, src_rel: str) -> str:
    lines = ["---"]
    for k in t.key_order:
        if k not in front:
            continue
        v = front[k]
        if k == "tools":
            v = render_tools(front, t)
            if not v:
                # An agent that only delegates still needs something to delegate
                # with; this mirrors the Command Code converter's own fallback.
                if t.agent_grants == "drop" and any(
                        e.startswith("Agent(") for e in tool_entries(front)):
                    v = "agent"
                else:
                    continue
        elif k == "model" and t.model_map:
            if v not in t.model_map:
                pass                       # unknown id: keep it verbatim
            elif t.model_map[v] is None:
                continue                   # e.g. "inherit" -> omit, follow session
            else:
                v = t.model_map[v]
        lines.append(f"{k}: {v}")
    for k in front:
        if k not in t.key_order:
            lines.append(f"{k}: {front[k]}")
    lines.append("---")
    lines.append("")
    if t.header:
        # In the BODY, not the frontmatter. Frontmatter here is fragile — CRLF in
        # it once silently unregistered five agents — so nothing that can be kept
        # out of it goes in. `verify-bodies.py` strips this line before comparing.
        lines.append(GENERATED_MD.format(src=src_rel))
        lines.append("")
    lines.append(body.strip())
    lines.append("")
    return "\n".join(lines)


def emit_kimi(name: str, front: dict, body: str, t: Target, src_rel: str) -> str:
    desc = front.get("description", "").replace("\n", " ")
    entries = tool_entries(front)
    tools = [t.tool_map[re.sub(r"\(.*\)", "", e).strip()]
             for e in entries
             if re.sub(r"\(.*\)", "", e).strip() in t.tool_map]
    subs = subagents(entries)
    lines = ["---", f"name: {name}"]
    if front.get("version"):
        lines.append(f"version: {front['version']}")
    lines += [f"description: {yaml_dq(desc)}",
              f"whenToUse: {yaml_dq(when_to_use(desc))}"]
    if tools:
        lines.append("tools:")
        lines += [f"  - {x}" for x in dict.fromkeys(tools)]
    if subs:
        lines.append("subagents:")
        lines += [f"  - {x}" for x in subs]
    lines += ["---", "", GENERATED_MD.format(src=src_rel), "", body.strip(), ""]
    return "\n".join(lines)


def emit_json(name: str, front: dict, body: str, t: Target, src_rel: str) -> str:
    desc = front.get("description", "").replace("\n", " ").strip()
    entries = tool_entries(front)
    tools = [t.tool_map[re.sub(r"\(.*\)", "", e).strip()]
             for e in entries
             if re.sub(r"\(.*\)", "", e).strip() in t.tool_map]
    d: dict = {
        "_generated": f"from {src_rel} by sdlc-suite/tools/generate_trees.py — do not edit",
        "name": name,
    }
    # A JSON object, not frontmatter: emitting `version: 1.0.0` here the way the
    # Markdown trees do would produce an unparseable file rather than a visible
    # error, which is the whole reason the dialect is handled per emitter.
    if front.get("version"):
        d["version"] = front["version"]
    d["description"] = desc
    d["whenToUse"] = when_to_use(desc)
    if tools:
        d["tools"] = list(dict.fromkeys(tools))
    subs = subagents(entries)
    if subs:
        d["subagents"] = subs
    if body.strip():
        d["body"] = body.strip()
    return json.dumps(d, indent=2, ensure_ascii=False) + "\n"


def emit_toml(name: str, front: dict, body: str, t: Target, src_rel: str) -> str:
    desc = front.get("description", "").replace("\n", " ").strip()
    # A comment, not a key. Codex deserialises agent files strictly, and a
    # `version = "1.0.0"` key made it reject every one of them with "unknown
    # field `version`" -- so no suite agent loaded under Codex at all. The
    # revision stays readable for bug reports; bump.py reads the source tree.
    v = front.get("version")
    if v and not re.fullmatch(r"[0-9]+[.][0-9]+[.][0-9]+", str(v)):
        # Unescaped into the file, so anything but x.y.z could add TOML keys.
        raise SystemExit(f"{src_rel}: version {v!r} is not x.y.z")
    version = f"# version: {v}{chr(10)}" if v else ""
    return (
        f'# GENERATED from {src_rel} — do not edit. '
        f'Run python sdlc-suite/tools/generate_trees.py\n'
        f'name = "{toml_dq(name)}"\n'
        f'{version}'
        f'description = "{toml_dq(desc)}"\n'
        f'developer_instructions = """{body.strip()}"""\n'
    )


EMITTERS = {"markdown": emit_markdown, "kimi": emit_kimi,
            "json": emit_json, "toml": emit_toml}


# --------------------------------------------------------------------------- #
# Generation
# --------------------------------------------------------------------------- #

# Inserted into the generated copy of the workflow-backed commands: under pi
# the `Workflow` tool is the `workflow` tool registered by the hand-maintained
# .pi/extensions/sdlc/ extension. The note keeps the generated copy honest in
# both directions — how to run the pipeline here, and what to do when the
# extension is not loaded.
PI_WORKFLOW_NOTE = (
    "> **Pi.** This command invokes the `Workflow` tool, which under pi is the\n"
    "> `workflow` tool registered by the `.pi/extensions/sdlc/` extension. Call\n"
    "> it with the `scriptPath` and the `args` OBJECT below — an object, never\n"
    "> a bare string — and report the pipeline's result, not a substitute. If\n"
    "> the `workflow` tool is not available in this session (the extension is\n"
    "> not loaded), say so to the user; do not improvise a substitute run, and\n"
    "> do not report a result this pipeline did not produce.\n"
)


def render_pi_prompt(md: Path) -> str:
    """One `sdlc-suite/commands/*.md` file as a pi prompt template.

    The frontmatter passes through untouched: pi prompt templates use the
    same `description` / `argument-hint` fields and the same `$ARGUMENTS` /
    `$1` substitutions the commands already carry, and the filename — not a
    `name:` field — is the command name in both harnesses. The body gets the
    two transforms that make it true under pi: bare names, and the plugin
    root rewritten to the canonical path it actually resolves to here.
    """
    raw = _read_lf(md)
    front, body = parse_frontmatter(raw)
    lines = ["---"]
    lines += [f"{k}: {v}" for k, v in front.items()]
    lines += ["---", ""]
    if md.stem in FLOW_SKILLS:
        lines.append(PI_WORKFLOW_NOTE)
    lines.append(denamespace(body).replace(PLUGIN_ROOT, "sdlc-suite").strip())
    lines.append("")
    return "\n".join(lines)


HERMES_WORKFLOW_NOTE = (
    "> **Hermes.** This command invokes the `Workflow` tool, which under Hermes\n"
    "> is the `workflow` tool registered by the `.hermes/plugins/sdlc/` plugin.\n"
    "> Call it with the `scriptPath` and the `args` OBJECT below — an object,\n"
    "> never a bare string — and report the pipeline's result, not a substitute.\n"
    "> If the `workflow` tool is not available in this session (the plugin is\n"
    "> not enabled), say so to the user; do not improvise a substitute run, and\n"
    "> do not report a result this pipeline did not produce.\n"
)

#: What `$ARGUMENTS` means once a command is a Hermes skill.
HERMES_ARGUMENTS = "<the User instruction>"


def render_hermes_skill(md: Path) -> str:
    """One `sdlc-suite/commands/*.md` file as a Hermes skill.

    A skill needs a `name`, which a command takes from its filename instead.
    `argument-hint` has no Hermes meaning and is folded into the description,
    where the skill index shows it. `$ARGUMENTS` becomes a reference to the
    `User instruction:` line Hermes appends when the skill is invoked as a
    slash command with text after it.
    """
    raw = _read_lf(md)
    front, body = parse_frontmatter(raw)
    desc = front.get("description", "").strip()
    hint = front.get("argument-hint", "").strip()
    if hint:
        sep = "" if desc.endswith((".", "!", "?")) else "."
        desc = f"{desc}{sep} Usage: /{md.stem} {hint}"
    lines = ["---", f"name: {md.stem}", f"description: {yaml_dq(desc)}", "---", ""]
    lines.append(GENERATED_MD.format(src=f"sdlc-suite/commands/{md.name}"))
    lines.append("")
    if "$ARGUMENTS" in body:
        lines.append(
            f"`{HERMES_ARGUMENTS}` below is the text that followed `/{md.stem}`, "
            "shown as the `User instruction:` line of this message. If there is "
            "none, ask for it rather than guessing.\n"
        )
    if md.stem in FLOW_SKILLS:
        lines.append(HERMES_WORKFLOW_NOTE)
    text = denamespace(body).replace(PLUGIN_ROOT, "sdlc-suite")
    lines.append(text.replace("$ARGUMENTS", HERMES_ARGUMENTS).strip())
    lines.append("")
    return "\n".join(lines)


def hermes_md() -> str:
    body = _read_lf(SRC_HERMES_MD).strip()
    return (
        GENERATED_MD.format(src="sdlc-suite/hermes/HERMES.md") + "\n\n" + body + "\n"
    )


def pi_agents_md() -> str:
    # Same discipline as the prompt bodies: LF-normalised bytes, never
    # universal-newline text (see _read_lf).
    body = _read_lf(SRC_PI_AGENTS).strip()
    return (
        GENERATED_MD.format(src="sdlc-suite/pi/AGENTS.md") + "\n\n" + body + "\n"
    )


def render_agent(md_path: Path, t: Target) -> str:
    text = _read_lf(md_path)
    if not t.namespaced:
        text = denamespace(text)
    front, body = parse_frontmatter(text)
    src_rel = f"sdlc-suite/agents/{md_path.name}"
    # Every agent follows the session model. A pin is not portable: qa-runner's
    # `sonnet` became `claude-sonnet-5` under Command Code, which offers no Claude
    # models, and an unmapped id would pass through verbatim with no warning.
    if front.get("model", "inherit") != "inherit":
        raise SystemExit(f"{src_rel}: model {front['model']!r} -- agents must "
                         f"use `model: inherit` (or omit it) to follow the session")
    return EMITTERS[t.agent_format](md_path.stem, front, body, t, src_rel)


def desired_pi_files() -> dict[Path, str]:
    out: dict[Path, str] = {}
    for md in sorted(SRC_COMMANDS.glob("*.md")):
        out[Path(".pi/prompts") / md.name] = render_pi_prompt(md)
    out[Path("AGENTS.md")] = pi_agents_md()
    return out


#: Commands with no Hermes skill. `install-routing` writes ROUTING.md into
#: `.claude/CLAUDE.md`, which Hermes never reads while `.hermes.md` exists — and
#: Hermes's skills_guard rates a skill that edits agent config "dangerous" and
#: quarantines it on every load. Shipping it would be a skill that silently
#: does not exist.
HERMES_SKIP_COMMANDS = {"install-routing"}


def desired_hermes_files() -> dict[Path, str]:
    out: dict[Path, str] = {}
    for md in sorted(SRC_COMMANDS.glob("*.md")):
        if md.stem in HERMES_SKIP_COMMANDS:
            continue
        out[Path(".hermes/skills") / md.stem / "SKILL.md"] = render_hermes_skill(md)
    out[Path(".hermes.md")] = hermes_md()
    return out


def desired_files(t: Target) -> dict[Path, str]:
    """Every file this target should contain, as {relative path: content}."""
    if t.name == ".pi":
        return desired_pi_files()
    if t.name == ".hermes":
        return desired_hermes_files()
    out: dict[Path, str] = {}

    if t.agent_ext:
        for md in sorted(SRC_AGENTS.glob("*.md")):
            out[Path("agents") / f"{md.stem}{t.agent_ext}"] = render_agent(md, t)

    for skill_dir in sorted(p for p in SRC_SKILLS.iterdir() if p.is_dir()):
        if skill_dir.name in t.skip_skills:
            continue
        # Recursive: a skill directory is not just its SKILL.md. Comparing only
        # the directory name is how commandcode-suite lost
        # exploration-charter/personas-schema-template.yaml without any check
        # noticing.
        for f in sorted(skill_dir.rglob("*")):
            if not f.is_file() or is_bytecode(f):
                continue
            rel = Path("skills") / f.relative_to(SRC_SKILLS)
            raw = _read_lf(f)
            out[rel] = raw if t.namespaced else denamespace(raw)

    # Workflow scripts, for the targets that are a straight de-namespaced copy.
    #
    # This was left out originally, and independent review found the cost by
    # measurement: the CHG-16..22 runtime wiring landed in `sdlc-suite/workflows/`
    # only, `.claude/workflows/` stayed byte-identical to its pre-change state
    # through six commits, and NO gate in the repository noticed — appending a
    # line to a generated workflow passed all seven checks. `.claude/` is the
    # live tree for bare-name invocation in this repository, so the two copies
    # silently did different things, which is precisely what CLAUDE.md exists to
    # prevent.
    #
    # Only `.claude/` opts in. `commandcode-suite/workflows/` and
    # `.kimi-code/workflows/` are NOT copies — they target different runtimes
    # (a `cmdc` subprocess runner and Python respectively) and are genuinely
    # hand-maintained. Generating them from these scripts would be wrong, and
    # saying so here is better than a whitelist that quietly omits them.
    if t.workflows:
        for f in sorted(SRC_WORKFLOWS.glob("*.js")):
            if f.name.endswith(".test.js"):
                continue        # suites stay with the canonical tree
            raw = _read_lf(f)
            out[Path("workflows") / f.name] = raw if t.namespaced else denamespace(raw)

    return out


def existing_pi_files() -> dict[Path, str]:
    """Only the paths the generator owns.

    Anything else under `.pi/` — `settings.json`, `extensions/` — is
    hand-maintained, per machine or per project, and must never be diffed,
    rewritten or pruned: the same regression-as-sync failure the `local_skills`
    guard exists to prevent.
    """
    out: dict[Path, str] = {}
    prompts = ROOT / ".pi" / "prompts"
    if prompts.is_dir():
        for f in sorted(prompts.glob("*.md")):
            out[f.relative_to(ROOT)] = f.read_bytes().decode("utf-8")
    if (ROOT / "AGENTS.md").is_file():
        out[Path("AGENTS.md")] = (ROOT / "AGENTS.md").read_bytes().decode("utf-8")
    return out


def existing_hermes_files() -> dict[Path, str]:
    """Only the generated command skills and `.hermes.md`.

    `.hermes/skills/` is also Hermes's native project-skill location, so a
    directory there is ours only if its SKILL.md carries our GENERATED marker;
    a hand-made project skill is never diffed or pruned.
    `.hermes/plugins/` is hand-maintained and never touched.
    """
    out: dict[Path, str] = {}
    skills = ROOT / ".hermes" / "skills"
    marker = "<!-- GENERATED from sdlc-suite/"
    if skills.is_dir():
        for sd in sorted(p for p in skills.iterdir() if p.is_dir()):
            md = sd / "SKILL.md"
            if not (md.is_file() and marker in md.read_bytes().decode("utf-8", "replace")):
                continue
            for f in sorted(sd.rglob("*")):
                if f.is_file():
                    out[f.relative_to(ROOT)] = f.read_bytes().decode("utf-8")
    if (ROOT / ".hermes.md").is_file():
        out[Path(".hermes.md")] = (ROOT / ".hermes.md").read_bytes().decode("utf-8")
    return out


def is_bytecode(f: Path) -> bool:
    """Python's own cache files. A skill that ships a script (image-generation)
    gets a __pycache__ beside it the moment anything imports it, and copying
    that into six trees -- or decoding it as UTF-8, which is how it first
    surfaced -- is never wanted. Skipped on both sides so --check stays
    symmetric."""
    return "__pycache__" in f.parts or f.suffix in (".pyc", ".pyo")


def existing_files(base: Path, t: Target) -> dict[Path, str]:
    if t.name == ".pi":
        return existing_pi_files()
    if t.name == ".hermes":
        return existing_hermes_files()
    out: dict[Path, str] = {}
    subs = ["agents", "skills"] + (["workflows"] if t.workflows else [])
    for sub in subs:
        d = base / sub
        if not d.is_dir():
            continue
        for f in sorted(d.rglob("*")):
            if not f.is_file():
                continue
            if sub == "agents" and (t.agent_ext is None or f.suffix != t.agent_ext):
                continue
            if sub == "workflows" and (f.suffix != ".js" or f.name.endswith(".test.js")):
                continue
            if is_bytecode(f):
                continue
            try:
                # read_bytes, NOT read_text: Python text mode universal-newline-
                # translates on read, so a CRLF file compares equal to its LF twin and
                # the generator reports it "unchanged" while leaving on disk exactly
                # the bytes that have unregistered agents here before. Same blind spot
                # `git diff --no-index` has.
                out[f.relative_to(base)] = f.read_bytes().decode("utf-8")
            except UnicodeDecodeError:
                out[f.relative_to(base)] = "\0<binary>"
    return out


@dataclass
class TreeDelta:
    added: list[Path] = field(default_factory=list)
    updated: list[Path] = field(default_factory=list)
    removed: list[Path] = field(default_factory=list)
    unchanged: int = 0

    @property
    def dirty(self) -> bool:
        return bool(self.added or self.updated or self.removed)


def diff_tree(name: str, t: Target) -> TreeDelta:
    base = ROOT / (t.base or name)
    want = desired_files(t)
    have = existing_files(base, t)
    d = TreeDelta()
    for rel, content in want.items():
        if rel not in have:
            d.added.append(rel)
        elif have[rel] != content:
            d.updated.append(rel)
        else:
            d.unchanged += 1
    for rel in have:
        if rel in want:
            continue
        if rel.parts[0] == "skills" and len(rel.parts) > 1 and rel.parts[1] in t.local_skills:
            d.unchanged += 1      # locally owned; not ours to remove
            continue
        d.removed.append(rel)
    return d


def apply_tree(name: str, t: Target, d: TreeDelta) -> None:
    base = ROOT / (t.base or name)
    want = desired_files(t)
    for rel in d.added + d.updated:
        p = base / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        # newline="\n" is not optional. Python's default text mode translates to
        # os.linesep, which on Windows is CRLF — and CRLF in an agent's
        # frontmatter has already silently unregistered five agents in this
        # repository. .gitattributes cannot help: this writes outside git.
        p.write_text(want[rel], encoding="utf-8", newline="\n")
    for rel in d.removed:
        p = base / rel
        if p.is_file():
            p.unlink()
    # A removed `.hermes/skills/<command>/SKILL.md` leaves its directory, which
    # Hermes would still scan; drop it once empty.
    if t.name == ".hermes":
        for rel in d.removed:
            sd = (base / rel).parent
            if sd.is_dir() and not any(sd.iterdir()):
                sd.rmdir()
    # Prune skill directories the source no longer has.
    skills = base / "skills"
    if skills.is_dir():
        keep = {r.parts[1] for r in want if r.parts[0] == "skills" and len(r.parts) > 1}
        keep |= t.local_skills
        for sd in sorted(p for p in skills.iterdir() if p.is_dir()):
            if sd.name not in keep:
                shutil.rmtree(sd)


def report(name: str, d: TreeDelta, show_diff: bool) -> None:
    if not d.dirty:
        print(f"  [in sync]  {name:<20} {d.unchanged} files")
        return
    bits = []
    if d.added:
        bits.append(f"{len(d.added)} added")
    if d.updated:
        bits.append(f"{len(d.updated)} updated")
    if d.removed:
        bits.append(f"{len(d.removed)} removed")
    print(f"  [drift]    {name:<20} {', '.join(bits)}, {d.unchanged} unchanged")
    if show_diff:
        for label, items in (("+", d.added), ("~", d.updated), ("-", d.removed)):
            for rel in items:
                print(f"               {label} {rel.as_posix()}")


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="report drift and exit non-zero; write nothing")
    ap.add_argument("--diff", action="store_true",
                    help="list every differing path, not just counts")
    ap.add_argument("--tree", action="append", choices=sorted(TARGETS),
                    help="limit to one target (repeatable)")
    args = ap.parse_args()

    names = args.tree or list(TARGETS)
    print(f"Canonical source: sdlc-suite/ "
          f"({len(list(SRC_AGENTS.glob('*.md')))} agents, "
          f"{sum(1 for p in SRC_SKILLS.iterdir() if p.is_dir())} skills)")
    print(f"{'Checking' if args.check else 'Generating'} {len(names)} trees\n")

    dirty: list[str] = []
    for name in names:
        t = TARGETS[name]
        d = diff_tree(name, t)
        report(name, d, args.diff or args.check)
        if d.dirty:
            dirty.append(name)
            if not args.check:
                apply_tree(name, t, d)

    print()
    if args.check:
        if dirty:
            print(f"FAIL: {len(dirty)} tree(s) drifted from sdlc-suite/: "
                  f"{', '.join(dirty)}", file=sys.stderr)
            print("Run: python sdlc-suite/tools/generate_trees.py", file=sys.stderr)
            return 1
        print(f"OK: {len(names)} generated trees match sdlc-suite/")
        return 0

    if dirty:
        print(f"Regenerated {len(dirty)} tree(s): {', '.join(dirty)}")
    else:
        print(f"All {len(names)} trees already matched sdlc-suite/; nothing written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
