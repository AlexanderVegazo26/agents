"""The sdlc-suite Hermes plugin: the suite's two Claude Code primitives.

    agent     one sub-agent dispatch (Claude Code's Agent()/Task): a separate
              `hermes chat` process running the named role file from
              sdlc-suite/agents/
    workflow  one Workflow-tool run: sdlc-suite/workflows/*.js in the node:vm
              sandbox shared with the pi extension, with agent() backed by
              those same separate processes

This module is only the Hermes registration. The work happens in runner.mjs,
which imports the pi extension's lib.js for everything that is not
Hermes-specific — see README.md.

Hand-maintained: the tree generator never writes or removes anything under
.hermes/plugins/.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import subprocess
import threading
from collections import deque
from pathlib import Path

logger = logging.getLogger(__name__)

# resolve(): the plugin is installed as a symlink into ~/.hermes/plugins/, and
# runner.mjs finds the pi lib relative to its real location in the repository.
RUNNER = Path(__file__).resolve().parent / "runner.mjs"
TOOLSET = "sdlc"
LOG_TAIL = 50
DEFAULT_CATALOG = RUNNER.parent / "models.json"


def catalog_path() -> Path | None:
    """The model catalog: a per-machine override in the Hermes home wins over
    the plugin's models.json. None when neither exists (routing off)."""
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    for p in (home / "sdlc-models.json", DEFAULT_CATALOG):
        if p.is_file():
            return p
    return None


def catalog_error(data) -> str | None:
    """Why a catalog is unusable, or None. The same rule as runner.mjs's
    loadCatalog: an unusable catalog turns routing off in both halves."""
    if not isinstance(data, dict):
        return "not a JSON object"
    choices = data.get("choices")
    if not isinstance(choices, dict) or not choices:
        return 'no "choices"'
    for name, c in choices.items():
        if not isinstance(c, dict) or not isinstance(c.get("model"), str) or not c["model"]:
            return f'choice "{name}" has no "model"'
        for fb in c.get("fallback") or []:
            if fb not in choices:
                return f'choice "{name}" falls back to unknown "{fb}"'
    for key in ("roles", "role_model_aliases"):
        section = data.get(key) or {}
        if not isinstance(section, dict):
            return f'"{key}" is not an object'
        for k, v in section.items():
            if v not in choices:
                return f'{key} "{k}" routes to unknown "{v}"'
    return None


def listed_model_ids(body: str) -> set[str] | None:
    """Model ids a /v1/models-style reply lists — the same rule as
    runner.mjs's listedModelIds, so `hermes sdlc models` and the router agree."""
    try:
        j = json.loads(body)
    except ValueError:
        return None
    ids: set[str] = set()
    if isinstance(j, dict):
        for key in ("data", "models"):
            for m in j.get(key) or []:
                if isinstance(m, dict):
                    ids.update(v for k in ("id", "name", "model") if isinstance(v := m.get(k), str))
    return ids


def _load_catalog() -> dict | None:
    p = catalog_path()
    if p is None:
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        logger.warning("sdlc: model catalog %s is unreadable (%s); model routing is off", p, e)
        return None
    err = catalog_error(data)
    if err:
        logger.warning("sdlc: model catalog %s: %s; model routing is off", p, err)
        return None
    return data

AGENT_SCHEMA = {
    "name": "agent",
    "description": (
        "Run one sdlc-suite sub-agent (a role file from sdlc-suite/agents/, e.g. code-reviewer, "
        "qa-engineer, security-engineer) in its own separate `hermes chat` process. This is how "
        "ROUTING.md's 'You MUST invoke <agent>' is satisfied under Hermes — use it, not delegate_task, "
        "for a suite role. The sub-agent cannot see this conversation: `task` must be a complete, "
        "self-contained brief. One call is one sub-agent run; do not split one role's work across "
        "parallel calls. Returns the sub-agent's final output, or says that no result came back — "
        "in which case the dispatch failed: say so, never invent its output."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": 'Agent name from sdlc-suite/agents/, e.g. "code-reviewer" or "qa-runner". '
                               'The "sdlc-suite:" prefix is also accepted.',
            },
            "task": {
                "type": "string",
                "description": "The complete, self-contained brief for the sub-agent.",
            },
        },
        "required": ["name", "task"],
        "additionalProperties": False,
    },
}

WORKFLOW_SCHEMA = {
    "name": "workflow",
    "description": (
        "Run an sdlc-suite workflow script (sdlc-suite/workflows/*.js) — Claude Code's Workflow tool. "
        "Executes in a node:vm sandbox (globals: agent, parallel, pipeline, workflow, phase, log, args, "
        "budget, setTimeout, clearTimeout, console; no require, process or fs) with agent() backed by "
        "separate hermes chat processes. Pass the exact scriptPath and the args OBJECT from the command "
        "— never a string. Report the pipeline's result as returned; do not re-derive it. Do not create, "
        "edit or delete anything under .claude/runs/ yourself. On failure, relay the failure; never "
        "improvise a substitute run. Runs can take a long time: every stage is a full agent session."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "scriptPath": {
                "type": "string",
                "description": 'Path to the workflow script, e.g. "sdlc-suite/workflows/release-readiness.js".',
            },
            "args": {
                "type": "object",
                "description": "The workflow arguments object exactly as the command states it "
                               "(e.g. { release, runtimeDir, policyDefault }). Always an object, never a string.",
            },
        },
        "required": ["scriptPath"],
        "additionalProperties": False,
    },
}


def _available() -> bool:
    return RUNNER.is_file() and shutil.which("node") is not None


def _anchor() -> str:
    """The session's working directory — the repository the suite runs in."""
    try:
        from agent.runtime_cwd import resolve_agent_cwd
        return str(resolve_agent_cwd())
    except Exception:  # an older Hermes without the resolver
        return str(Path.cwd())


def _run(mode: str, request: dict) -> tuple[dict, list[str]]:
    """Run runner.mjs once. Progress lines stream to the Hermes log as they
    arrive (a workflow can run for an hour); the last LOG_TAIL come back to
    the model with the result."""
    # Own session: the runner and anything it has not detached sit in one
    # process group we can signal as a whole. The runner kills its detached
    # `hermes chat` children itself on SIGTERM (see runner.mjs).
    proc = subprocess.Popen(
        ["node", str(RUNNER), mode],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", cwd=request["anchor"], start_new_session=True,
    )
    tail: deque[str] = deque(maxlen=LOG_TAIL)
    out: list[str] = []

    def pump() -> None:
        for line in proc.stderr:
            line = line.rstrip("\n")
            tail.append(line)
            logger.info("[sdlc %s] %s", mode, line)

    readers = [threading.Thread(target=pump, daemon=True),
               threading.Thread(target=lambda: out.append(proc.stdout.read()), daemon=True)]
    for r in readers:
        r.start()
    interrupted = False
    try:
        try:
            proc.stdin.write(json.dumps(request))
            proc.stdin.close()
        except BrokenPipeError:
            pass  # the runner died before reading; its stderr says why
        while proc.poll() is None:
            if _interrupted():
                interrupted = True
                _stop(proc)
                break
            try:
                proc.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
    except BaseException:
        _stop(proc)
        raise
    for r in readers:
        r.join(timeout=5)
    if interrupted:
        return {"ok": False, "error": "interrupted — the run and its sub-agent sessions were stopped"}, list(tail)
    try:
        reply = json.loads(out[0] if out else "")
    except json.JSONDecodeError:
        reply = {"ok": False, "error": f"runner exited {proc.returncode} without a reply"}
    return reply, list(tail)


def _interrupted() -> bool:
    try:
        from tools.interrupt import is_interrupted
        return is_interrupted()
    except Exception:  # an older Hermes without the interrupt module
        return False


def _stop(proc: subprocess.Popen, grace: float = 10.0) -> None:
    """SIGTERM the runner's group (it forwards to its sessions), then SIGKILL."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError, AttributeError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        try:
            proc.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            continue


def _render(value) -> str:
    return value if isinstance(value, str) else json.dumps(value, indent=2, ensure_ascii=False)


def _route_line(name: str, route: dict | None, dispatched: bool = True) -> str:
    """One header line naming the model that actually ran — what an
    orchestrator records in its lens ledger, and what a reader checks."""
    if not route:
        return (f"[sdlc agent: {name} — session default model]" if dispatched
                else f"[sdlc agent: {name} — not dispatched, no model ran]")
    used = f"{route['choice']} (-m {route['model']})" if route.get("choice") else "session default model"
    return f"[sdlc agent: {name} on {used} — {route.get('why')}]"


def _handle_agent(params: dict, **_kwargs) -> str:
    name = str(params.get("name") or "")
    request = {"anchor": _anchor(), "name": name, "task": params.get("task") or ""}
    if params.get("model"):
        request["model"] = str(params["model"])
    cat = catalog_path()
    if cat is not None:
        request["catalog"] = str(cat)
    reply, logs = _run("agent", request)
    if reply.get("ok"):
        return f"{_route_line(name, reply.get('route'))}\n{_render(reply.get('result'))}"
    return json.dumps({
        "success": False,
        "error": f"{reply.get('error')} — the reason is in `progress`. Do not treat the task as done "
                 "and do not invent its output.",
        "model": _route_line(name, reply.get("route"), dispatched=bool(reply.get("route"))),
        "progress": logs,
    }, ensure_ascii=False)


def _handle_workflow(params: dict, **_kwargs) -> str:
    script = str(params.get("scriptPath") or "")
    args = params.get("args")
    if args is not None and not isinstance(args, dict):
        return json.dumps({"success": False, "error": "`args` must be an object, never a string"})
    request = {"anchor": _anchor(), "scriptPath": script, "args": args or {}}
    cat = catalog_path()
    if cat is not None:
        request["catalog"] = str(cat)
    reply, logs = _run("workflow", request)
    if not reply.get("ok"):
        return json.dumps({"success": False, "error": f"workflow failed: {reply.get('error')}",
                           "progress": logs}, ensure_ascii=False)
    meta = reply.get("meta") or {}
    return json.dumps({"success": True, "workflow": meta.get("name") or script,
                       "result": reply.get("result"), "models": reply.get("routes") or [],
                       "progress": logs}, indent=2, ensure_ascii=False)


ORCHESTRATE_BRIEF = """TASK (from the user, verbatim):
{task}

WORKING DIRECTORY: {cwd}

You are leading this run under Hermes. Classify the task (tier, lens set) as
your role file says, then dispatch each specialist with the `agent` tool. For
every dispatch, decide the `model`: omit it to use the role's default, or set
it when this specific piece of work is clearly harder or easier than the role
usually is, and say why in one clause. Never write a dispatched role's answer
yourself - a finding counts only if it came back from an `agent` call, and the
first line of each result names the model that ran it. End with your lens
ledger, adding a Model column (the choice from that first line, and why it was
chosen or overridden) for every row you dispatched. If a dispatch returned no
result, mark that lens as not run, not as passed."""


def orchestrate(task: str) -> str:
    """Dispatch the orchestrator role on the user's task. Deterministic on
    purpose: the session's own model never decides whether to orchestrate -
    a weak default model was observed answering a preloaded orchestration
    skill by itself, with no dispatch at all. The orchestrator's model is
    its catalog role default."""
    task = (task or "").strip()
    if not task:
        return "usage: /orchestrate <task>  (or: hermes sdlc orchestrate \"<task>\")"
    return _handle_agent({"name": "orchestrator",
                          "task": ORCHESTRATE_BRIEF.format(task=task, cwd=_anchor())})


def _setup_cli(parser) -> None:
    sub = parser.add_subparsers(dest="sdlc_command")
    p = sub.add_parser("orchestrate", help="Run a task through the orchestrator role")
    p.add_argument("task", nargs="+", help="The task, in plain words")
    sub.add_parser("models", help="Show the model catalog in effect and which choices are up")


def _cli(args) -> int:
    if getattr(args, "sdlc_command", None) == "orchestrate":
        out = orchestrate(" ".join(args.task))
        print(out)
        return 1 if out.startswith('{"success": false') else 0
    if getattr(args, "sdlc_command", None) == "models":
        print(models_report())
        return 0
    print("usage: hermes sdlc {orchestrate <task> | models}")
    return 2


def models_report() -> str:
    """The catalog in effect, each choice's availability, and role defaults."""
    cat = _load_catalog()
    if not cat:
        where = catalog_path()
        return (f"model routing is OFF — {where} is invalid (see the Hermes log)" if where
                else "no model catalog — every role runs on the session default model")
    import urllib.request
    lines = [f"catalog: {catalog_path()}"]
    for name, c in cat["choices"].items():
        up = "no probe"
        if c.get("probe"):
            try:
                with urllib.request.urlopen(c["probe"], timeout=2.5) as r:  # noqa: S310 — user-configured URL
                    body = r.read().decode("utf-8", "replace")
                    expect = c.get("expect")
                    ids = listed_model_ids(body)
                    listed = (expect in ids) if ids is not None else (expect or "") in body
                    up = "up" if not expect or listed else "model missing"
            except Exception:
                up = "DOWN"
        lines.append(f"  {name:<10} -m {str(c.get('model')):<10} {up:<14} {str(c.get('use_for', ''))[:70]}")
    by_choice: dict[str, list[str]] = {}
    for role, choice in (cat.get("roles") or {}).items():
        by_choice.setdefault(choice, []).append(role)
    lines.append("role defaults:")
    lines += [f"  {c}: {', '.join(sorted(rs))}" for c, rs in by_choice.items()]
    return "\n".join(lines)


def agent_schema(catalog: dict | None) -> dict:
    """AGENT_SCHEMA plus a `model` parameter built from the catalog.

    Built once, at plugin load: the schema is part of the cached prompt
    prefix, so it must not change mid-conversation. The choices offered here
    change in the next session; role defaults, fallbacks and probes are
    re-read by the runner on every call.
    """
    if not catalog:
        return AGENT_SCHEMA
    schema = json.loads(json.dumps(AGENT_SCHEMA))
    choices = catalog["choices"]
    lines = [f'"{k}": {c.get("use_for") or c["model"]}' for k, c in choices.items()]
    by_choice: dict[str, list[str]] = {}
    for role, choice in (catalog.get("roles") or {}).items():
        by_choice.setdefault(choice, []).append(role)
    defaults = "; ".join(f"{c}: {', '.join(sorted(rs))}" for c, rs in by_choice.items())
    schema["parameters"]["properties"]["model"] = {
        "type": "string",
        "enum": list(choices),
        "description": (
            "Optional. Which model runs this sub-agent. Omit it to use the role's default ("
            + defaults + "). Set it when this particular task is clearly harder or easier than the role "
            "usually is — e.g. a one-line doc fix for technical-writer on fast, a subtle concurrency "
            "review for software-engineer on deep. Unavailable models fall back automatically; the "
            "result's first line names the model that actually ran. Choices: " + " | ".join(lines)
        ),
    }
    schema["description"] += (
        " Each call can pick a model (`model`); the first line of the result names the model used."
    )
    return schema


def register(ctx) -> None:
    ctx.register_tool(name="agent", toolset=TOOLSET, schema=agent_schema(_load_catalog()), handler=_handle_agent,
                      check_fn=_available, emoji="🧑‍💼")
    ctx.register_command("orchestrate", orchestrate,
                         description="Lead a task through the SDLC suite: the orchestrator role picks the "
                                     "specialists and a model per dispatch", args_hint="<task>")
    ctx.register_cli_command("sdlc", help="sdlc-suite: orchestrate a task, inspect model routing",
                             setup_fn=_setup_cli, handler_fn=_cli)
    ctx.register_tool(name="workflow", toolset=TOOLSET, schema=WORKFLOW_SCHEMA, handler=_handle_workflow,
                      check_fn=_available, emoji="🔁")
