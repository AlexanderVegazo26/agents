#!/usr/bin/env python3
"""Offline gate for the Hermes port. No hermes, no network, no model.

    python .hermes/validate.py

The generated half (`.hermes/skills/` and `.hermes.md`) is already byte-checked
by `generate_trees.py --check`; this checks what that cannot:

* every generated command skill parses as a Hermes skill (`name` matching its
  directory, a `description`), carries no unresolved `${CLAUDE_PLUGIN_ROOT}` or
  `$ARGUMENTS`, and — when it names a workflow script — names one that exists;
* the hand-maintained plugin registers exactly the `agent` and `workflow` tools
  through a stub ctx, each with a schema whose name matches;
* the runner's selftest passes under the host node.

Exit 0 clean, 1 on any defect (each named), 2 when there is nothing to check.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".hermes" / "skills"
PLUGIN = ROOT / ".hermes" / "plugins" / "sdlc"
SCRIPT_RE = re.compile(r'scriptPath:\s*"([^"]+)"')


def check_skills(errors: list[str]) -> int:
    dirs = sorted(p for p in SKILLS.iterdir() if p.is_dir()) if SKILLS.is_dir() else []
    for d in dirs:
        f = d / "SKILL.md"
        if not f.is_file():
            errors.append(f"{d.relative_to(ROOT)}: no SKILL.md")
            continue
        text = f.read_text(encoding="utf-8")
        m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
        front = dict(re.findall(r"^(\w[\w-]*):\s*(.*)$", m.group(1), re.MULTILINE)) if m else {}
        rel = f.relative_to(ROOT)
        if front.get("name") != d.name:
            errors.append(f"{rel}: name {front.get('name')!r} does not match its directory")
        if not front.get("description"):
            errors.append(f"{rel}: no description")
        for leftover in ("${CLAUDE_PLUGIN_ROOT}", "$ARGUMENTS", "sdlc-suite:"):
            if leftover in text:
                errors.append(f"{rel}: unresolved {leftover}")
        for script in SCRIPT_RE.findall(text):
            if not (ROOT / script).is_file():
                errors.append(f"{rel}: scriptPath {script} does not exist")
            elif "`workflow` tool registered by the `.hermes/plugins/sdlc/` plugin" not in text:
                errors.append(f"{rel}: names a workflow but carries no Hermes note")
    return len(dirs)


class _StubCtx:
    def __init__(self) -> None:
        self.tools: dict[str, dict] = {}
        self.commands: dict[str, object] = {}
        self.cli: dict[str, object] = {}

    def register_tool(self, name, toolset, schema, handler, **_kw):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler}

    def register_command(self, name, handler, **_kw):
        self.commands[name] = handler

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, **_kw):
        self.cli[name] = (setup_fn, handler_fn)


def check_plugin(errors: list[str]) -> None:
    for f in ("plugin.yaml", "__init__.py", "runner.mjs"):
        if not (PLUGIN / f).is_file():
            errors.append(f".hermes/plugins/sdlc/{f}: missing")
    if errors:
        return
    spec = importlib.util.spec_from_file_location("sdlc_hermes_plugin", PLUGIN / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
        ctx = _StubCtx()
        mod.register(ctx)
    except Exception as e:  # noqa: BLE001 — any import/registration failure is the defect
        errors.append(f".hermes/plugins/sdlc/__init__.py: register() failed: {e!r}")
        return
    if set(ctx.tools) != {"agent", "workflow"}:
        errors.append(f".hermes/plugins/sdlc: registers {sorted(ctx.tools)}, expected ['agent', 'workflow']")
    if set(ctx.commands) != {"orchestrate"}:
        errors.append(f".hermes/plugins/sdlc: slash commands {sorted(ctx.commands)}, expected ['orchestrate']")
    if set(ctx.cli) != {"sdlc"}:
        errors.append(f".hermes/plugins/sdlc: CLI commands {sorted(ctx.cli)}, expected ['sdlc']")
    model = ctx.tools.get("agent", {}).get("schema", {}).get("parameters", {}).get("properties", {}).get("model")
    if model is None or not model.get("enum"):
        errors.append(".hermes/plugins/sdlc: `agent` has no `model` enum — is models.json readable?")
    for name, t in ctx.tools.items():
        if t["schema"].get("name") != name:
            errors.append(f".hermes/plugins/sdlc: tool {name} has schema name {t['schema'].get('name')!r}")
    check_catalog_rules(mod, errors)
    r = subprocess.run(["node", str(PLUGIN / "runner.mjs"), "--selftest"],
                       capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        errors.append(f".hermes/plugins/sdlc/runner.mjs --selftest exited {r.returncode}:\n{r.stdout}{r.stderr}")


def check_catalog_rules(mod, errors: list[str]) -> None:
    """The Python half's catalog rules for probe_key_env. runner.mjs's selftest
    holds the JS half to the same cases; an invalid catalog must be invalid in both."""
    def err(choice: dict) -> str:
        return mod.catalog_error({"choices": {"a": {"model": "x", **choice}}}) or ""
    cases = [
        ("a probe_key_env that is not a variable name", {"probe_key_env": "$(id)"}, "probe_key_env"),
        ("a key sent to a probe off loopback",
         {"probe": "https://evil.example/v1/models", "probe_key_env": "GITHUB_TOKEN"}, "not on loopback"),
        ("a loopback-looking subdomain", {"probe": "http://127.0.0.1.evil.example/v1", "probe_key_env": "K"}, "not on loopback"),
    ]
    for label, choice, want in cases:
        if want not in err(choice):
            errors.append(f".hermes/plugins/sdlc/__init__.py: catalog_error accepts {label}")
    for probe in ("http://127.0.0.1:11435/v1/models", "http://localhost:1/v1", "http://[::1]:2/v1"):
        if err({"probe": probe, "probe_key_env": "K"}):
            errors.append(f".hermes/plugins/sdlc/__init__.py: catalog_error rejects the loopback probe {probe}")


def main() -> int:
    errors: list[str] = []
    n = check_skills(errors)
    if n == 0:
        print("FAIL: .hermes/skills/ has no command skills — nothing to check", file=sys.stderr)
        return 2
    check_plugin(errors)
    if errors:
        for e in errors:
            print(f"FAIL: {e}", file=sys.stderr)
        return 1
    print(f"OK: {n} command skills, sdlc plugin registers agent (with model routing) + workflow + /orchestrate, "
          "runner selftest passes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
