"""project_manager: Hermes's project manager for the team's ClickUp board and Discord server.

Registers three things:
- Discord guild commands /daily, /standup, /checking (standup_discord.py, in the gateway process);
- the `project_manager` tool, which runs pm.py on the host (the agent's terminal is a sandbox that
  cannot reach pm.db or the host Python), with typed arguments only;
- the `project-manager` skill (SKILL.md) that says when and how to use it.

Publishing to Discord (post=true) pings real people, so it is refused for scheduled, webhook,
API-server and sub-agent sessions; those get dry runs. The scheduled jobs call pm.py directly.

Hand-maintained: the tree generator never writes or removes anything under .hermes/plugins/.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

HERE = Path(__file__).resolve().parent  # resolve(): installed as a symlink into ~/.hermes/plugins/
SCRIPT = HERE / "pm.py"
PYTHON = "/usr/bin/python3"
TOOLSET = "project_manager"
TIMEOUT = 300
ACTIONS = ("report", "stale", "followups", "health", "standup_summary", "standup_remind", "sync",
           "mappings", "healthcheck", "status", "risk_list", "risk_review", "decision_list", "risk_add",
           "risk_update", "decision_log")
POSTABLE = {"report", "stale", "followups", "health", "standup_summary", "standup_remind", "risk_review"}
WRITES = {"risk_add", "risk_update", "decision_log"}  # local RAID log only; need a person's conversation
RAID_FIELDS = {"title": "title", "probability": "probability", "impact": "impact", "owner": "owner",
               "mitigation": "mitigation", "contingency": "contingency", "trigger": "trigger",
               "review_date": "review-date", "status": "status", "risk_id": "id", "text": "text",
               "context": "context", "decided_by": "by"}

SCHEMA = {
    "name": "project_manager",
    "description": (
        "Project manager for the team's ClickUp board (Hay Mesa) and Discord server. Reads REAL ClickUp data "
        "and the standup records; never invent tickets, people or numbers beyond what it returns. Actions: "
        "report (ClickUp status report: closed / moved to Testing / Rejected / Blocked / stale; period weekly = "
        "previous Monday-Sunday, daily = yesterday, on_demand = last `days` days), stale (tickets without "
        "updates), followups (open issues with owner, next step and escalation state), health (project health "
        "with evidence), standup_summary / standup_remind (today's daily status), sync (poll ClickUp now), "
        "mappings (ClickUp<->Discord identity check), healthcheck, status, risk_list / risk_review (RAID risk "
        "log, score = probability x impact, escalate at >= 15), decision_list, and the writes risk_add / "
        "risk_update / decision_log (local log only; fields: title, probability 1-5, impact 1-5, owner, "
        "mitigation, contingency, trigger, review_date YYYY-MM-DD, status, risk_id, text, context, "
        "decided_by; only write what the user stated, never invent). Default is a dry run that returns "
        "the text; post=true publishes to the team's Discord channel and pings people, so only set it when "
        "the user explicitly asked to publish in this conversation."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "period": {"type": "string", "enum": ["weekly", "daily", "on_demand"],
                       "description": "report only; default weekly"},
            "days": {"type": "integer", "minimum": 1, "maximum": 90,
                     "description": "report with period=on_demand: how many days back"},
            "title": {"type": "string"}, "probability": {"type": "integer", "minimum": 1, "maximum": 5},
            "impact": {"type": "integer", "minimum": 1, "maximum": 5}, "owner": {"type": "string"},
            "mitigation": {"type": "string"}, "contingency": {"type": "string"}, "trigger": {"type": "string"},
            "review_date": {"type": "string"}, "status": {"type": "string",
                                                         "enum": ["open", "mitigated", "materialized", "closed"]},
            "risk_id": {"type": "integer"}, "text": {"type": "string"}, "context": {"type": "string"},
            "decided_by": {"type": "string"},
            "post": {"type": "boolean", "description": "publish to Discord (default false = dry run)"},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


def _post_problem() -> str:
    """Why this session may not publish, or ''. Publishing pings real people: it needs a person in a
    conversation (Telegram/Discord sessions already pass the gateway's allowlists, or a local CLI)."""
    try:
        from gateway.session_context import get_session_env
    except ImportError:
        return "no session context, so the caller cannot be checked; dry run only"
    if get_session_env("HERMES_CRON_SESSION", "").strip().lower() in ("1", "true", "yes"):
        return "scheduled jobs publish through their own pm.py job, not this tool"
    if os.environ.get("HERMES_SDLC_DEPTH"):
        return "sub-agents may not publish; ask the user's own session"
    platform = (os.getenv("HERMES_PLATFORM") or get_session_env("HERMES_SESSION_PLATFORM", "")).strip().lower()
    source = get_session_env("HERMES_SESSION_SOURCE", "").strip().lower()
    if platform in ("telegram", "discord"):
        return ""
    if not platform and source in ("cli", "tui", "desktop", "local", ""):
        return ""
    return f"publishing is only allowed from a Telegram/Discord conversation or the local CLI, not '{platform or source}'"


def _handle(params: dict, **_kwargs) -> str:
    def no(why: str) -> str:
        return json.dumps({"success": False, "message": why}, ensure_ascii=False)

    action = params.get("action")
    if action not in ACTIONS:
        return no(f"action must be one of {', '.join(ACTIONS)}")
    argv = [PYTHON, "-I", str(SCRIPT), action.replace("_", "-")]
    if action == "report":
        period = params.get("period") or "weekly"
        if period not in ("weekly", "daily", "on_demand"):
            return no("period must be weekly, daily or on_demand")
        argv.append(f"--period={period}")
        if params.get("days") is not None:
            d = params["days"]
            if isinstance(d, bool) or not isinstance(d, int) or not 1 <= d <= 90:
                return no("days must be a whole number from 1 to 90")
            argv.append(f"--days={d}")
    for k, flag in RAID_FIELDS.items():
        if params.get(k) is not None:
            if action not in WRITES and action not in ("risk_list", "decision_list"):
                continue
            argv.append(f"--{flag}={params[k]}")
    if action in WRITES:
        if (problem := _post_problem()):
            return no(problem)
        argv.append("--source=agent")
    if params.get("post"):
        if action not in POSTABLE:
            return no(f"{action} has nothing to publish")
        if (problem := _post_problem()):
            return no(problem)
        argv.append("--post")
    if action in ("standup_summary", "standup_remind"):
        argv.append("--force")  # an explicit request runs on weekends too
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=TIMEOUT, stdin=subprocess.DEVNULL,
                           env={"HOME": str(Path.home()), "PATH": "/usr/local/bin:/usr/bin:/bin",
                                "LANG": "C.UTF-8", "HERMES_HOME": os.environ.get("HERMES_HOME",
                                                                                 str(Path.home() / ".hermes"))})
    except subprocess.TimeoutExpired:
        return no("pm.py timed out")
    if r.returncode == 0:
        return json.dumps({"success": True, "result": json.loads(r.stdout or "{}")}, ensure_ascii=False)
    logger.warning("pm.py %s exit %s: %s", action, r.returncode, (r.stderr or "")[-500:])
    return no(f"pm.py {action} failed (exit {r.returncode}): {(r.stderr or r.stdout or '').strip()[-400:]}")


def _available() -> bool:
    return SCRIPT.is_file() and Path(PYTHON).exists()


def _discord_factory(bot, adapter=None):
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    import standup_discord
    standup_discord.setup(bot, adapter)
    import coach_discord
    coach_discord.setup(bot, adapter)


def register(ctx) -> None:
    ctx.register_tool(name="project_manager", toolset=TOOLSET, schema=SCHEMA, handler=_handle,
                      check_fn=_available, emoji="📋")
    ctx.register_skill("project-manager", HERE / "SKILL.md",
                       description="Run the team's project management: ClickUp status reports, standups, "
                                   "stale/blocked/overdue follow-ups, project health, and who to notify")
    ctx.register_platform_handler("discord", _discord_factory)
