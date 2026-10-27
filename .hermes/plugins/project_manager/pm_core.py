"""Pure logic for the project manager: configuration, status normalization, reporting periods,
transition detection, staleness, identity mapping, follow-up decisions and message formatting.

Nothing here touches the network, the database or the clock directly (the caller passes `now`),
so every rule is unit-testable. Messages are in Spanish because the team's spec and channels are.
"""

from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
CONFIG_PATH = Path(os.environ.get("PM_CONFIG") or HERMES_HOME / "data" / "config" / "project_manager.yaml")
DATA_DIR = Path(os.environ.get("PM_DATA_DIR") or HERMES_HOME / "data" / "project-manager")

CATEGORIES = ("closed", "testing", "rejected", "blocked")  # reviewer-relevant transition categories
MENTION_MODES = ("all_team", "summary", "targeted", "quiet")
MONTHS_ES = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre",
             "octubre", "noviembre", "diciembre")

DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "timezone": "America/Santo_Domingo",
    "clickup": {
        "workspace_id": None,
        "list_ids": [],
        "status_mappings": {"closed": ["closed", "complete"], "testing": ["qa -testing", "testing"],
                            "rejected": ["rejected"], "blocked": ["blocked"]},
        "stale_excluded_categories": ["closed"],
        "inactivity_threshold_days": 7,
        "max_stale_listed": 15,
        "poll_interval_minutes": 15,
    },
    "discord": {
        "guild_id": None,
        "standup_channel_id": None,
        "report_channel_id": None,
        "operations_channel_id": None,
        "risks_channel_id": None,  # falls back to report_channel_id
        "standup": {
            "commands": ["daily", "standup", "checking"],
            "notification_mode": "summary",
            "targeted_recipients": [],
            "required_members": [],
            "workdays": [0, 1, 2, 3, 4],
            "prompt_enabled": True,
            "reminder_enabled": True,
            "summary_enabled": True,
        },
        "reporting": {
            "daily_enabled": False,
            "weekly_enabled": True,
            "stale_mention_assignees": True,
        },
        "reviewers": {"testing": None, "rejected": None, "blocked": None},
        "project_manager": None,
        "escalation_recipient": None,
    },
    "followups": {
        "enabled": True,
        "cooldown_hours": 24,
        "escalate_after_days": 3,
        "testing_stuck_days": 3,
        "rejected_stuck_days": 2,
        "due_soon_days": 2,
        "notify_unassigned": True,
        # task-hygiene checks (off until the first dry run has been reviewed: the first post notifies
        # every existing offender once). Subtasks are skipped for the missing-field checks.
        "hygiene": {"enabled": False, "no_due_date": True, "no_estimate": True, "no_description": True,
                    "duplicates": True, "done_open_subtasks": True, "max_listed": 10},
    },
    "risks": {"escalation_score": 15, "review_every_days": 7},
    "users": [],
}


class ConfigError(ValueError):
    pass


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = _merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


def load_config(path: Path | None = None) -> dict:
    path = path or CONFIG_PATH
    try:
        text = path.read_text()
    except FileNotFoundError:
        raise ConfigError(f"config not found: {path}")
    raw = _load_yaml(text)
    cfg = _merge(DEFAULTS, raw.get("project_manager", raw))
    validate_config(cfg)
    return cfg


def _load_yaml(text: str) -> dict:
    """Parse the YAML config. PyYAML is a tiny, ubiquitous dependency; if the
    running interpreter is missing it, install it into the same environment so
    the config can be read (self-heal on a trimmed/flaky environment instead of
    aborting with a cryptic 'No module named yaml')."""
    try:
        import yaml
    except ImportError:
        _ensure_pyyaml()
        import yaml  # noqa: F401
    return yaml.safe_load(text) or {}


def _ensure_pyyaml() -> None:
    """Best-effort install of PyYAML into the current interpreter, so a missing
    optional dep no longer takes down every pm.py cron job (standup-summary,
    report, health, follow-ups, ...)."""
    import subprocess
    import sys
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "PyYAML"],
        check=False,
        capture_output=True,
    )


def validate_config(cfg: dict) -> list[str]:
    """Hard errors raise; soft problems are returned as warnings for the health check."""
    try:
        ZoneInfo(cfg["timezone"])
    except Exception:
        raise ConfigError(f"unknown timezone {cfg['timezone']!r}")
    mode = cfg["discord"]["standup"]["notification_mode"]
    if mode not in MENTION_MODES:
        raise ConfigError(f"standup.notification_mode must be one of {MENTION_MODES}, not {mode!r}")
    warnings = []
    ids = [c for c in ("standup_channel_id", "report_channel_id", "operations_channel_id")]
    for key in ids:
        if not cfg["discord"].get(key):
            warnings.append(f"discord.{key} is not set")
    if not cfg["clickup"]["list_ids"]:
        warnings.append("clickup.list_ids is empty: nothing will be monitored")
    warnings += Directory(cfg).problems()
    return warnings


def norm_status(s: str | None) -> str:
    """'QA - Testing ' -> 'qa -testing'. Lowercase, collapse whitespace, no space after a hyphen,
    so 'qa - testing', 'qa -testing' and 'QA -Testing' compare equal."""
    s = re.sub(r"\s+", " ", (s or "").strip().lower())
    return re.sub(r"-\s+", "-", s)


def categorize(status: str | None, status_type: str | None, mappings: dict) -> str | None:
    n = norm_status(status)
    for cat in CATEGORIES:
        if n in {norm_status(x) for x in mappings.get(cat, [])}:
            return cat
    if status_type == "closed":
        return "closed"
    return None


# ---------------------------------------------------------------- identity


@dataclass
class User:
    key: str
    display_name: str
    clickup_user_id: str | None = None
    discord_user_id: str | None = None
    enabled: bool = True
    verified: bool = False
    aliases: list[str] = field(default_factory=list)


class Directory:
    """ClickUp <-> Discord identity mapping. A mention is produced only for an enabled, verified
    user with a numeric Discord ID; anything else degrades to the plain display name, and the
    reason is recorded so it can be reported instead of guessed."""

    def __init__(self, cfg: dict):
        self.users: list[User] = []
        for u in cfg.get("users") or []:
            self.users.append(User(
                key=str(u["key"]), display_name=str(u.get("display_name") or u["key"]),
                clickup_user_id=str(u["clickup_user_id"]) if u.get("clickup_user_id") else None,
                discord_user_id=str(u["discord_user_id"]) if u.get("discord_user_id") else None,
                enabled=bool(u.get("enabled", True)), verified=bool(u.get("verified", False)),
                aliases=[str(a) for a in u.get("aliases") or []]))
        self.by_key = {u.key: u for u in self.users}
        self.by_clickup = {u.clickup_user_id: u for u in self.users if u.clickup_user_id}
        self.by_discord = {u.discord_user_id: u for u in self.users if u.discord_user_id}
        self.issues: list[str] = []

    def problems(self) -> list[str]:
        out = []
        for attr in ("key", "clickup_user_id", "discord_user_id"):
            seen: dict[str, str] = {}
            for u in self.users:
                v = getattr(u, attr)
                if v and v in seen:
                    out.append(f"duplicate {attr} {v} ({seen[v]}, {u.key})")
                elif v:
                    seen[v] = u.key
        for u in self.users:
            if u.discord_user_id and not re.fullmatch(r"\d{15,21}", u.discord_user_id):
                out.append(f"user {u.key}: discord_user_id is not a snowflake")
            if u.clickup_user_id and not re.fullmatch(r"\d+", u.clickup_user_id):
                out.append(f"user {u.key}: clickup_user_id is not numeric")
        return out

    def mentionable(self, u: User | None) -> bool:
        return bool(u and u.enabled and u.verified and u.discord_user_id
                    and re.fullmatch(r"\d{15,21}", u.discord_user_id))

    def mention_key(self, key: str | None, purpose: str) -> tuple[str | None, str | None]:
        """(mention markup or None, discord id or None) for a configured user key."""
        if not key:
            self.issues.append(f"no {purpose} configured")
            return None, None
        u = self.by_key.get(key)
        if not u:
            self.issues.append(f"{purpose} '{key}' is not in users")
            return None, None
        if not self.mentionable(u):
            self.issues.append(f"{purpose} '{key}' has no verified, enabled Discord mapping")
            return None, None
        return f"<@{u.discord_user_id}>", u.discord_user_id

    def assignee_label(self, clickup_id: str | None, username: str | None, mention: bool
                       ) -> tuple[str, str | None]:
        """Label for a ClickUp assignee and the Discord id to allow, if mentioning."""
        if not clickup_id:
            return "sin asignar", None
        u = self.by_clickup.get(str(clickup_id))
        if mention and self.mentionable(u):
            return f"<@{u.discord_user_id}>", u.discord_user_id
        if not u:
            self.issues.append(f"ClickUp user {clickup_id} ({username}) has no mapping")
        elif mention:
            self.issues.append(f"ClickUp user {clickup_id} ({u.key}) mapping is not verified/enabled")
        return (u.display_name if u else (username or str(clickup_id))), None


# ---------------------------------------------------------------- time


def tz(cfg: dict) -> ZoneInfo:
    return ZoneInfo(cfg["timezone"])


def ms_to_dt(ms: Any) -> datetime | None:
    if ms in (None, "", 0, "0"):
        return None
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc)


def iso_or(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def to_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


@dataclass(frozen=True)
class Period:
    kind: str
    start: datetime  # inclusive, aware
    end: datetime    # exclusive, aware

    def label(self, zone: ZoneInfo) -> str:
        s, e = self.start.astimezone(zone), (self.end - timedelta(seconds=1)).astimezone(zone)
        if s.date() == e.date():
            return fmt_day(s.date())
        return f"{fmt_day(s.date())} – {fmt_day(e.date())}"

    def contains(self, dt: datetime | None) -> bool:
        return dt is not None and self.start <= dt < self.end


def fmt_day(d: date) -> str:
    return f"{d.day} de {MONTHS_ES[d.month - 1]} de {d.year}"


def report_period(kind: str, now: datetime, zone: ZoneInfo, days: int | None = None) -> Period:
    """daily = the previous calendar day; weekly = the previous completed ISO week (Monday 00:00
    to the next Monday 00:00, local time); on_demand = the last `days` days (default 7) up to now."""
    local = now.astimezone(zone)
    midnight = datetime.combine(local.date(), time(0), zone)
    if kind == "daily":
        return Period(kind, midnight - timedelta(days=1), midnight)
    if kind == "weekly":
        this_monday = midnight - timedelta(days=local.weekday())
        return Period(kind, this_monday - timedelta(days=7), this_monday)
    if kind == "on_demand":
        return Period(kind, now - timedelta(days=days or 7), now)
    raise ValueError(f"unknown period kind {kind!r}")


def local_date(now: datetime, zone: ZoneInfo) -> date:
    return now.astimezone(zone).date()


# ---------------------------------------------------------------- tasks and transitions


def task_from_api(t: dict, mappings: dict) -> dict:
    """Flatten a ClickUp REST v2 task into the snapshot shape stored and compared."""
    st = t.get("status") or {}
    return {
        "task_id": t["id"],
        "name": t.get("name") or "",
        "url": t.get("url") or f"https://app.clickup.com/t/{t['id']}",
        "list_id": str((t.get("list") or {}).get("id") or ""),
        "status": st.get("status") or "",
        "status_type": st.get("type") or "",
        "category": categorize(st.get("status"), st.get("type"), mappings),
        "assignees": [{"id": str(a.get("id")), "username": a.get("username")} for a in t.get("assignees") or []],
        "due_date": t.get("due_date"),
        "date_updated": t.get("date_updated"),
        "date_closed": t.get("date_closed"),
        "date_created": t.get("date_created"),
        "priority": ((t.get("priority") or {}) or {}).get("priority") if isinstance(t.get("priority"), dict)
        else t.get("priority"),
        "archived": bool(t.get("archived")),
        "parent": t.get("parent"),
        "time_estimate": t.get("time_estimate"),
        "description_len": len((t.get("text_content") or t.get("description") or "").strip()),
    }


MEANINGFUL_FIELDS = ("status", "assignees", "due_date", "name", "priority")


def diff_task(prev: dict | None, cur: dict, observed_at: datetime, prev_observed_at: datetime | None,
              baseline_at: datetime | None) -> tuple[dict | None, bool]:
    """Compare one task against its previous snapshot.

    Returns (transition event or None, meaningful_change). A transition is emitted when the status
    changed, or when a task first seen after the baseline already sits in a tracked category
    (created in Testing, say). Tasks present at the baseline produce no events: their history before
    monitoring started is unknown. The event's occurred_at is the task's date_updated when it falls
    inside the polling window (a status change bumps it), otherwise the observation time."""
    meaningful = prev is None or any(prev.get(f) != cur.get(f) for f in MEANINGFUL_FIELDS)
    if prev is None:
        created = ms_to_dt(cur.get("date_created"))
        if baseline_at is None or created is None or created < baseline_at or not cur.get("category"):
            return None, meaningful
        from_status = None
    elif norm_status(prev.get("status")) == norm_status(cur.get("status")):
        return None, meaningful
    else:
        from_status = prev.get("status")
    upd = ms_to_dt(cur.get("date_updated"))
    lo = prev_observed_at or baseline_at
    occurred = upd if (upd and upd <= observed_at and (lo is None or upd >= lo)) else observed_at
    event = {
        "event_id": f"{cur['task_id']}:{norm_status(cur['status'])}:{cur.get('date_updated') or to_ms(observed_at)}",
        "task_id": cur["task_id"],
        "from_status": from_status,
        "to_status": cur["status"],
        "to_category": cur.get("category"),
        "occurred_at": occurred,
        "window_start": lo,
        "observed_at": observed_at,
    }
    return event, meaningful


def stale_tasks(tasks: Iterable[dict], now: datetime, threshold_days: int, excluded: Iterable[str],
                last_meaningful: dict[str, datetime], coverage_since: datetime | None) -> list[dict]:
    """Tasks whose record shows no update for more than `threshold_days`.

    Primary signal: ClickUp's date_updated (any change to the task record, including automations).
    It cannot prove there was no activity at all, so the label says "sin actualización del ticket".
    Secondary, inferred signal: date_updated is recent but none of the tracked fields changed in our
    own snapshots for longer than the threshold (only when monitoring has covered that long). Those
    are flagged `inferred=True` (likely automation or non-meaningful edits)."""
    excluded = set(excluded)
    cutoff = now - timedelta(days=threshold_days)
    out = []
    for t in tasks:
        if t.get("archived") or (t.get("category") in excluded):
            continue
        upd = ms_to_dt(t.get("date_updated")) or ms_to_dt(t.get("date_created"))
        if upd and upd < cutoff:
            out.append({**t, "last_activity": upd, "inferred": False})
            continue
        lm = last_meaningful.get(t["task_id"])
        if coverage_since and coverage_since < cutoff and lm and lm < cutoff:
            out.append({**t, "last_activity": lm, "inferred": True})
    out.sort(key=lambda x: x["last_activity"])
    return out


# ---------------------------------------------------------------- report


SECTION = {
    "closed": ("✅ TICKETS CERRADOS", None),
    "testing": ("🧪 TICKETS MOVIDOS A TESTING", "favor revisar los tickets que entraron a pruebas."),
    "rejected": ("❌ TICKETS MOVIDOS A REJECTED", "favor revisar los tickets que entraron a Rejected."),
    "blocked": ("🚫 TICKETS MARCADOS COMO BLOCKED", "favor revisar los tickets marcados como Blocked."),
}


@dataclass
class Message:
    text: str
    user_ids: list[str] = field(default_factory=list)
    everyone: bool = False


def build_status_report(cfg: dict, period: Period, generated_at: datetime, moved: dict[str, list[dict]],
                        stale: list[dict], coverage_notes: list[str], directory: Directory) -> Message:
    """moved[category] = tasks that entered that category during the period (deduplicated).
    Reviewer mentions appear only for non-empty Testing/Rejected/Blocked sections."""
    zone = tz(cfg)
    users: set[str] = set()
    L = ["📊 **CLICKUP STATUS REPORT**", "",
         f"Periodo: {period.label(zone)}",
         f"Generado: {generated_at.astimezone(zone):%Y-%m-%d %H:%M} AST", ""]
    for cat in CATEGORIES:
        items = moved.get(cat) or []
        if not items:
            continue
        title, ask = SECTION[cat]
        L.append(f"**{title}**")
        for t in items:
            who = ", ".join(directory.assignee_label(a["id"], a.get("username"), False)[0]
                            for a in t.get("assignees") or []) or "sin asignar"
            L.append(f"- {t['name']} — {who}\n  <{t['url']}>")
        if ask:
            m, uid = directory.mention_key(cfg["discord"]["reviewers"].get(cat), f"{cat} reviewer")
            if m:
                L.append(f"{m} {ask}")
                users.add(uid)
            else:
                L.append(f"_(sin revisor de {cat} mapeado en Discord — revisar configuración)_")
        L.append("")
    if not any(moved.get(c) for c in CATEGORIES):
        L += ["Sin tickets cerrados ni movidos a Testing, Rejected o Blocked en el periodo.", ""]
    th = cfg["clickup"]["inactivity_threshold_days"]
    if stale:
        L.append(f"**⚠️ TICKETS SIN ACTUALIZACIÓN POR MÁS DE {th} DÍAS**")
        mention = cfg["discord"]["reporting"].get("stale_mention_assignees", True)
        limit = cfg["clickup"]["max_stale_listed"]
        for t in stale[:limit]:
            labels = []
            for a in t.get("assignees") or []:
                lab, uid = directory.assignee_label(a["id"], a.get("username"), mention)
                labels.append(lab)
                if uid:
                    users.add(uid)
            who = ", ".join(labels) or "sin asignar"
            last = t["last_activity"].astimezone(zone).strftime("%Y-%m-%d")
            flag = " (inferido: solo cambios no relevantes)" if t.get("inferred") else ""
            L.append(f"- {t['name']} — {who} — última actualización {last}{flag}\n  <{t['url']}>")
        if len(stale) > limit:
            L.append(f"- … y {len(stale) - limit} más")
        L.append("")
    L += ["**📈 RESUMEN**",
          f"- Tickets cerrados: {len(moved.get('closed') or [])}",
          f"- Tickets movidos a Testing: {len(moved.get('testing') or [])}",
          f"- Tickets movidos a Rejected: {len(moved.get('rejected') or [])}",
          f"- Tickets marcados como Blocked: {len(moved.get('blocked') or [])}",
          f"- Tickets sin actualización > {th} días: {len(stale)}"]
    if coverage_notes:
        L += ["", "_Cobertura: " + " ".join(coverage_notes) + "_"]
    return Message("\n".join(L), sorted(users))


def split_message(text: str, limit: int = 1900) -> list[str]:
    """Split on line boundaries under Discord's 2000-character limit."""
    out, cur = [], ""
    for line in text.split("\n"):
        while len(line) > limit:
            if cur:
                out.append(cur)
                cur = ""
            out.append(line[:limit])
            line = line[limit:]
        if len(cur) + len(line) + 1 > limit:
            out.append(cur)
            cur = line
        else:
            cur = f"{cur}\n{line}" if cur else line
    if cur:
        out.append(cur)
    return out


# ---------------------------------------------------------------- standup


# A short negative answer is "no blocker" ("No por ahora", "Sin impedimentos", "Ninguno reportado": the 2026-10-22
# summary counted those as 2 blockers); anything that goes on to name a dependency ("no, pero …") still counts.
NO_BLOCKER = re.compile(
    r"^\s*(?:no|nop|nope|ninguno|ninguna|nada|n/?a|none|nothing|-|todo bien|sin (?:bloqueos?|impedimentos?|riesgos?|"
    r"problemas?|novedad(?:es)?|pendientes?))"
    # only filler may follow the negative: "No hay ambiente de staging" names a blocker and must not match
    r"(?:[\s,.!]+(?:por|ahora|el|de|momento|hoy|reportados?|hasta|so|far|for|now|bloqueos?|impedimentos?|riesgos?|"
    r"tengo|hay|ninguno|nada))*[\s.!]*$", re.I)
STILL_BLOCKED = re.compile(r"\b(pero|but|aunque|except|excepto|salvo|esperando|waiting|bloquea|depend)", re.I)


def clip(text: str, n: int) -> str:
    """At most n chars, cut at a word boundary with an ellipsis (summaries used to stop mid-word)."""
    text = text.strip()
    return text if len(text) <= n else text[:n].rsplit(" ", 1)[0].rstrip(",.;:") + "…"
CLICKUP_REF = re.compile(r"(?:app\.clickup\.com/t/(?:\d+/)?|#)([0-9a-z]{9})\b", re.I)


def has_blocker(text: str | None) -> bool:
    t = (text or "").strip()
    return bool(t) and not (NO_BLOCKER.match(t) and not STILL_BLOCKED.search(t))


def clickup_refs(*texts: str | None) -> list[str]:
    seen: list[str] = []
    for t in texts:
        for m in CLICKUP_REF.finditer(t or ""):
            if m.group(1) not in seen:
                seen.append(m.group(1))
    return seen


def bullets(text: str | None) -> str:
    lines = [l.strip(" -•\t") for l in (text or "").splitlines() if l.strip(" -•\t")]
    return "\n".join(f"- {l}" for l in lines) or "- (sin respuesta)"


def build_standup_post(cfg: dict, s: dict, task_index: dict[str, dict], everyone: bool,
                       targeted_ids: list[str], edited: bool) -> Message:
    zone = tz(cfg)
    sub = datetime.fromisoformat(s["submitted_at"]).astimezone(zone)
    d = date.fromisoformat(s["local_date"])
    L = [f"📋 **DAILY STATUS — {d.day} DE {MONTHS_ES[d.month - 1].upper()}**", "",
         f"👤 Miembro del equipo: <@{s['user_id']}>", "",
         "✅ **Completado ayer:**", bullets(s["completed"]), "",
         "🎯 **Plan para hoy:**", bullets(s["planned"]), "",
         "🚧 **Bloqueos o riesgos (reportados):**", bullets(s["blockers"]) if has_blocker(s["blockers"])
         else "- Ninguno reportado"]
    refs = clickup_refs(s["completed"], s["planned"], s["blockers"])
    if refs:
        L += ["", "🔗 **Tickets mencionados:**"]
        for r in refs:
            t = task_index.get(r)
            if t:
                state = " — verificado en ClickUp: Blocked" if t.get("category") == "blocked" else \
                    f" — estado en ClickUp: {t['status']}"
                L.append(f"- {t['name']}{state}\n  <{t['url']}>")
            else:
                L.append(f"- {r} (no encontrado en las listas monitoreadas)")
    stamp = f"Enviado: {sub:%H:%M} AST"
    if edited:
        upd = datetime.fromisoformat(s["updated_at"]).astimezone(zone)
        stamp += f" · actualizado {upd:%H:%M} AST"
    L += ["", stamp]
    if everyone:
        L += ["@everyone"]
    elif targeted_ids:
        L += [" ".join(f"<@{i}>" for i in targeted_ids)]
    return Message("\n".join(L), list(targeted_ids), everyone)


def build_standup_summary(cfg: dict, day: date, subs: list[dict], missing: list[str], everyone: bool) -> Message:
    L = [f"🗂️ **RESUMEN DAILY STATUS — {day.day} DE {MONTHS_ES[day.month - 1].upper()}**", ""]
    if not subs:
        L.append("Nadie ha enviado su daily status hoy.")
    for s in subs:
        L.append(f"**<@{s['user_id']}>**")
        L.append(f"🎯 {clip(s['planned'].strip().splitlines()[0], 180) if (s['planned'] or '').strip() else '(sin plan)'}")
        if has_blocker(s["blockers"]):
            L.append(f"🚧 {clip(s['blockers'].strip().splitlines()[0], 180)}")
        L.append("")
    if missing:
        L.append("Pendientes de enviar: " + ", ".join(missing))
    blocked = [s for s in subs if has_blocker(s["blockers"])]
    L.append(f"Enviados: {len(subs)} · Con bloqueos reportados: {len(blocked)}")
    if everyone:
        L.append("@everyone")
    # Names in the summary are rendered as mentions but allowed_mentions only lists nobody: they don't ping.
    return Message("\n".join(L), [], everyone)


# ---------------------------------------------------------------- follow-ups


@dataclass
class Issue:
    key: str            # stable dedupe key, e.g. blocked:86e3abc
    kind: str
    task: dict | None
    owner_ids: list[str]  # Discord ids to mention (already verified)
    owner_label: str
    since: datetime
    why: str
    next_step: str


def detect_issues(cfg: dict, tasks: list[dict], entered: dict[str, datetime], now: datetime,
                  directory: Directory) -> list[Issue]:
    """Open issues right now. `entered[task_id]` = when the task entered its current status as far
    as monitoring knows (first observation for baseline tasks)."""
    f = cfg["followups"]
    rv = cfg["discord"]["reviewers"]
    out: list[Issue] = []

    def owners_assignees(t):
        ids, labels = [], []
        for a in t.get("assignees") or []:
            lab, uid = directory.assignee_label(a["id"], a.get("username"), True)
            labels.append(lab)
            if uid:
                ids.append(uid)
        return ids, ", ".join(labels) or "sin asignar"

    def reviewer(cat):
        m, uid = directory.mention_key(rv.get(cat), f"{cat} reviewer")
        return ([uid] if uid else []), (m or f"revisor de {cat} (sin mapear)")

    for t in tasks:
        if t.get("archived") or t.get("category") == "closed":
            continue
        since = entered.get(t["task_id"]) or now
        cat = t.get("category")
        if cat == "blocked":
            ids, lab = reviewer("blocked")
            out.append(Issue(f"blocked:{t['task_id']}", "blocked", t, ids, lab, since,
                             "ticket en Blocked", "identificar y destrabar el bloqueo"))
        elif cat == "testing" and now - since >= timedelta(days=f["testing_stuck_days"]):
            ids, lab = reviewer("testing")
            out.append(Issue(f"testing:{t['task_id']}", "testing_stuck", t, ids, lab, since,
                             f"en Testing desde hace más de {f['testing_stuck_days']} días", "completar QA"))
        elif cat == "rejected" and now - since >= timedelta(days=f["rejected_stuck_days"]):
            ids, lab = owners_assignees(t)
            out.append(Issue(f"rejected:{t['task_id']}", "rejected_stuck", t, ids, lab, since,
                             f"en Rejected desde hace más de {f['rejected_stuck_days']} días",
                             "corregir y devolver a Testing"))
        due = ms_to_dt(t.get("due_date"))
        if due and due < now:
            ids, lab = owners_assignees(t)
            out.append(Issue(f"overdue:{t['task_id']}:{t.get('due_date')}", "overdue", t, ids, lab, due,
                             f"vencido desde {due.astimezone(tz(cfg)):%Y-%m-%d}", "actualizar fecha o cerrar"))
        elif due and due - now <= timedelta(days=f["due_soon_days"]):
            ids, lab = owners_assignees(t)
            out.append(Issue(f"due_soon:{t['task_id']}:{t.get('due_date')}", "due_soon", t, ids, lab, now,
                             f"vence {due.astimezone(tz(cfg)):%Y-%m-%d}", "confirmar que llega a tiempo"))
        if f.get("notify_unassigned") and not t.get("assignees"):
            pm_ids, pm_lab = [], "PM"
            m, uid = directory.mention_key(cfg["discord"].get("project_manager"), "project manager")
            if uid:
                pm_ids, pm_lab = [uid], m
            created = ms_to_dt(t.get("date_created")) or since  # unassigned since creation, not first poll
            out.append(Issue(f"unassigned:{t['task_id']}", "unassigned", t, pm_ids, pm_lab, created,
                             "sin responsable asignado", "asignar responsable"))
    return out + detect_hygiene(cfg, tasks, now, directory)


HYGIENE_KINDS = ("no_due_date", "no_estimate", "no_description", "duplicate", "done_open_subtasks")


def _norm_name(name: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", unicodedata.normalize("NFKD", (name or "").lower())
                  .encode("ascii", "ignore").decode())


def detect_hygiene(cfg: dict, tasks: list[dict], now: datetime, directory: Directory) -> list[Issue]:
    """Housekeeping issues on open tasks. A field the snapshot does not carry yet (old rows before the
    next sync) is unknown, never flagged. Orphaned tasks are not checked: the board has no epics."""
    h = cfg["followups"].get("hygiene") or {}
    if not h.get("enabled"):
        return []
    pm_m, pm_id = directory.mention_key(cfg["discord"].get("project_manager"), "project manager")

    def owner(t):
        ids, labels = [], []
        for a in t.get("assignees") or []:
            lab, uid = directory.assignee_label(a["id"], a.get("username"), True)
            labels.append(lab)
            if uid:
                ids.append(uid)
        if labels:
            return ids, ", ".join(labels)
        return ([pm_id] if pm_id else []), (pm_m or "PM")

    def issue(kind, t, why, step):
        ids, lab = owner(t)
        return Issue(f"{kind}:{t['task_id']}", kind, t, ids, lab, ms_to_dt(t.get("date_created")) or now, why, step)

    open_t = [t for t in tasks if not t.get("archived") and t.get("category") != "closed"]
    out: list[Issue] = []
    for t in open_t:
        if t.get("parent"):
            continue
        if h.get("no_due_date") and not t.get("due_date"):
            out.append(issue("no_due_date", t, "sin fecha de entrega", "definir fecha de entrega"))
        if h.get("no_estimate") and "time_estimate" in t and not t.get("time_estimate"):
            out.append(issue("no_estimate", t, "sin estimación", "estimar el esfuerzo (lo define quien lo hace)"))
        if h.get("no_description") and t.get("description_len") == 0:
            out.append(issue("no_description", t, "sin descripción ni criterios de aceptación",
                             "agregar contexto y criterios de aceptación"))
    if h.get("duplicates"):
        groups: dict[str, list[dict]] = {}
        for t in open_t:
            n = _norm_name(t.get("name"))
            if len(n) >= 8:
                groups.setdefault(n, []).append(t)
        for g in groups.values():
            for t in g if len(g) > 1 else []:
                out.append(issue("duplicate", t, f"mismo título que {len(g) - 1} ticket(s) abierto(s)",
                                 "revisar y fusionar o diferenciar"))
    if h.get("done_open_subtasks"):
        by_id = {t["task_id"]: t for t in tasks}
        kids: dict[str, int] = {}
        for t in open_t:
            p = by_id.get(t.get("parent") or "")
            if p and p.get("category") == "closed":
                kids[p["task_id"]] = kids.get(p["task_id"], 0) + 1
        for pid, n in kids.items():
            out.append(issue("done_open_subtasks", by_id[pid], f"cerrado con {n} subtarea(s) abierta(s)",
                             "cerrar las subtareas o reabrir el ticket"))
    return out


def followup_action(state: dict | None, issue: Issue, now: datetime, cfg: dict) -> str | None:
    """'notify' (first time), 'followup' (still open after the cooldown), 'escalate' (open longer
    than escalate_after_days, once), or None. State keys: first_notified_at, last_notified_at,
    escalated_at (ISO strings or None)."""
    f = cfg["followups"]
    if state is None or not state.get("first_notified_at") or state.get("resolved_at"):
        return "notify"
    first = datetime.fromisoformat(state["first_notified_at"])
    last = datetime.fromisoformat(state["last_notified_at"])
    if issue.kind in HYGIENE_KINDS:
        return None  # housekeeping: one notice, no chasing
    if issue.kind != "due_soon" and not state.get("escalated_at") and \
            now - first >= timedelta(days=f["escalate_after_days"]):
        return "escalate"
    if issue.kind in ("blocked", "overdue", "testing_stuck", "rejected_stuck") and \
            now - last >= timedelta(hours=f["cooldown_hours"]):
        return "followup"
    return None


# ---------------------------------------------------------------- health


def health(cfg: dict, tasks: list[dict], issues: list[Issue], stale_n: int, standup_missing: int) -> dict:
    """Rule-based rating with no invented metrics. Counts are measured; the thresholds are the
    subjective part and live here, documented in README: RED if anything is blocked longer than
    escalate_after_days or anything is overdue; YELLOW if anything is blocked, stuck in Testing or
    Rejected, unassigned, or more than 20% of open tickets are stale; otherwise GREEN."""
    open_t = [t for t in tasks if t.get("category") != "closed" and not t.get("archived")]
    kinds: dict[str, int] = {}
    for i in issues:
        kinds[i.kind] = kinds.get(i.kind, 0) + 1
    esc = cfg["followups"]["escalate_after_days"]
    now_blocked_long = [i for i in issues if i.kind == "blocked" and
                        (datetime.now(timezone.utc) - i.since) >= timedelta(days=esc)]
    stale_ratio = stale_n / len(open_t) if open_t else 0.0
    if kinds.get("overdue") or now_blocked_long:
        level, why = "ROJO", "hay tickets vencidos o bloqueados por más de %d días" % esc
    elif kinds.get("blocked") or kinds.get("testing_stuck") or kinds.get("rejected_stuck") \
            or kinds.get("unassigned") or stale_ratio > 0.2:
        level, why = "AMARILLO", "hay bloqueos, colas en Testing/Rejected, tickets sin responsable o >20% sin actualizar"
    else:
        level, why = "VERDE", "sin vencidos, bloqueos ni colas detectadas"
    return {"level": level, "why": why, "open": len(open_t), "closed": len(tasks) - len(open_t),
            "issues": kinds, "stale": stale_n, "stale_ratio": round(stale_ratio, 2),
            "standup_missing": standup_missing}


# ---------------------------------------------------------------- risks and decisions

RISK_STATUSES = ("open", "mitigated", "materialized", "closed")


def risk_score(probability: int, impact: int) -> int:
    return int(probability) * int(impact)


def risk_level(score: int, cfg: dict) -> str:
    esc = cfg["risks"]["escalation_score"]
    return "🔴" if score >= esc else "🟡" if score >= 8 else "🟢"


def build_risk_review(cfg: dict, risks: list[dict], today: date, directory: Directory) -> Message | None:
    """Weekly RAID review of open risks, worst first. None when nothing is open (no noise)."""
    open_r = sorted((r for r in risks if r["status"] in ("open", "materialized")),
                    key=lambda r: (-r["score"], r["review_date"] or ""))
    if not open_r:
        return None
    esc = cfg["risks"]["escalation_score"]
    esc_m, esc_id = directory.mention_key(cfg["discord"].get("escalation_recipient"), "escalation recipient")
    high = [r for r in open_r if r["score"] >= esc]
    L = [f"🎲 **REVISIÓN DE RIESGOS — {fmt_day(today)}**",
         f"{len(open_r)} abiertos · {len(high)} con puntaje ≥ {esc}", ""]
    ids: list[str] = []
    if high and esc_id:
        ids.append(esc_id)
        L += [f"**⚠️ Escalar** {esc_m}: " + ", ".join(f"#{r['id']}" for r in high), ""]
    for r in open_r:
        due = r["review_date"] and r["review_date"] <= today.isoformat()
        L.append(f"{risk_level(r['score'], cfg)} **#{r['id']} {r['description']}** — {r['probability']}×{r['impact']}"
                 f" = {r['score']} · responsable: {r['owner'] or 'sin asignar'}"
                 f"{' · estado: ' + r['status'] if r['status'] != 'open' else ''}"
                 f"{' · ⏰ revisión vencida' if due else ''}")
        L.append(f"  mitigación: {r['mitigation'] or 'sin definir'}"
                 + (f" · disparador: {r['trigger_text']}" if r.get("trigger_text") else ""))
    return Message("\n".join(L), ids)
