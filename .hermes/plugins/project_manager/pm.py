#!/usr/bin/env python3
"""Project manager CLI: the one entry point for cron jobs, the Hermes tool and operators.

    pm.py sync                                  poll ClickUp, store snapshots, detect transitions
    pm.py report --period weekly|daily|on_demand [--days N] [--post]
    pm.py stale [--post]                        stale-ticket report
    pm.py followups [--post]                    follow-up / escalation review
    pm.py health [--post]                       project health assessment
    pm.py standup-prompt|standup-remind|standup-summary [--post] [--force]
    pm.py mappings                              validate ClickUp<->Discord identities
    pm.py healthcheck                           integration health (exit 1 on problems)
    pm.py status                                state overview (sync, notifications, follow-ups)
    pm.py backup
    pm.py risk-add --title T --probability 1-5 --impact 1-5 [--owner --mitigation --contingency --trigger --review-date]
    pm.py risk-update --id N [any risk field, --status open|mitigated|materialized|closed]
    pm.py risk-list [--all] | risk-review [--post]     RAID log (local DB; ClickUp is never written)
    pm.py decision-log --text T [--context C --by WHO] | decision-list [--days N=how many]

Without --post every command only prints what it would publish (dry run). With --post it
publishes to the configured Discord channel, recording each message in the notification ledger
so a re-run never posts twice. Cron mode (--cron) prints nothing on success and a short
failure line otherwise, which the Hermes cron delivers to the operator."""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import pm_core as C  # noqa: E402
from pm_clients import ApiError, ClickUp, Discord  # noqa: E402
from pm_store import Store, open_store, parse  # noqa: E402


class Ctx:
    def __init__(self, cfg: dict, store: Store, now: datetime | None = None,
                 clickup: ClickUp | None = None, discord: Discord | None = None):
        self.cfg, self.store = cfg, store
        self.now = now or datetime.now(timezone.utc)
        self.zone = C.tz(cfg)
        self._clickup, self._discord = clickup, discord
        self.directory = C.Directory(cfg)

    @property
    def clickup(self) -> ClickUp:
        if self._clickup is None:
            self._clickup = ClickUp()
        return self._clickup

    @property
    def discord(self) -> Discord:
        if self._discord is None:
            self._discord = Discord()
        return self._discord


# ------------------------------------------------------------------ sync


def sync(ctx: Ctx) -> dict:
    started = datetime.now(timezone.utc)
    cfg = ctx.cfg["clickup"]
    try:
        raw: list[dict] = []
        for lid in cfg["list_ids"]:
            raw += ctx.clickup.list_tasks(str(lid))
    except Exception as e:
        ctx.store.record_sync_failure(started, str(e))
        raise
    observed = ctx.now
    prev_states = ctx.store.task_states()
    baseline = ctx.store.baseline_at()
    prev_obs = ctx.store.last_sync_ok()
    tasks, events, meaningful = [], [], set()
    seen = set()
    for t in raw:
        if t["id"] in seen:  # a task in two monitored lists
            continue
        seen.add(t["id"])
        cur = C.task_from_api(t, cfg["status_mappings"])
        prev = prev_states.get(cur["task_id"])
        prev_clean = {k: v for k, v in prev.items() if not k.startswith("_")} if prev else None
        ev, changed = C.diff_task(prev_clean, cur, observed, prev_obs, baseline or (observed if prev_states else None))
        if ev:
            events.append(ev)
        if changed:
            meaningful.add(cur["task_id"])
        tasks.append(cur)
    n = ctx.store.apply_sync(tasks, events, meaningful, observed, started)
    return {"tasks": len(tasks), "new_events": n, "baseline_at": C.iso_or(ctx.store.baseline_at()),
            "first_sync": baseline is None}


def require_fresh_sync(ctx: Ctx) -> None:
    """Every report starts with a sync; if ClickUp can't be read, the report is not produced
    (an empty report would claim 'nothing happened')."""
    sync(ctx)


# ------------------------------------------------------------------ publishing


def publish(ctx: Ctx, key: str, kind: str, channel_key: str, msg: C.Message, post: bool) -> dict:
    channel = ctx.cfg["discord"].get(channel_key)
    chunks = C.split_message(msg.text)
    if not post:
        return {"posted": False, "dry_run": True, "channel": channel, "text": msg.text,
                "mentions": msg.user_ids, "everyone": msg.everyone}
    if not channel:
        raise C.ConfigError(f"discord.{channel_key} is not configured; nothing was posted")
    if not ctx.store.begin_notification(key, kind, str(channel)):
        return {"posted": False, "duplicate": True, "key": key}
    everyone = msg.everyone
    if everyone:
        try:
            ok = ctx.discord.can_mention_everyone(str(ctx.cfg["discord"]["guild_id"]), str(channel))
        except ApiError as e:
            ok = False
            ctx.store.log("warning", "permission_check_failed", str(e))
        if not ok:
            everyone = False
            chunks = [c.replace("@everyone", "").rstrip() for c in chunks]
            ctx.store.log("warning", "everyone_fallback",
                          f"{key}: bot cannot mention @everyone in {channel}; posted without it")
    ids = []
    try:
        for i, chunk in enumerate(chunks):
            users = [u for u in msg.user_ids if f"<@{u}>" in chunk]
            ids.append(ctx.discord.send(str(channel), chunk, users, everyone and "@everyone" in chunk))
    except Exception as e:
        ctx.store.finish_notification(key, ids, str(e))
        raise
    ctx.store.finish_notification(key, ids)
    return {"posted": True, "key": key, "channel": channel, "message_ids": ids, "everyone": everyone}


def notify_ops(ctx: Ctx, key: str, text: str) -> None:
    """Best effort: operational problems go to the operations channel once per key."""
    try:
        publish(ctx, key, "ops", "operations_channel_id", C.Message("⚙️ **Project manager** — " + text), True)
    except Exception as e:  # the cron failure line still reaches the operator
        ctx.store.log("error", "ops_notify_failed", str(e))


def flush_mapping_issues(ctx: Ctx, post: bool) -> list[str]:
    issues = sorted(set(ctx.directory.issues))
    for i in issues:
        ctx.store.log("warning", "mapping", i)
    if issues and post:
        week = C.local_date(ctx.now, ctx.zone).isocalendar()
        notify_ops(ctx, f"ops:mapping:{week[0]}-{week[1]}:{hash(tuple(issues)) & 0xffffffff:x}",
                   "problemas de mapeo ClickUp↔Discord (no se mencionó a nadie por suposición):\n- " +
                   "\n- ".join(issues))
    return issues


# ------------------------------------------------------------------ reports


def moved_in_period(ctx: Ctx, period: C.Period) -> tuple[dict[str, list[dict]], list[str]]:
    states = ctx.store.task_states()
    moved: dict[str, dict[str, dict]] = {c: {} for c in C.CATEGORIES}
    for e in ctx.store.events_between(period.start, period.end):
        cat = e["to_category"]
        t = states.get(e["task_id"])
        if cat in moved and t:
            moved[cat][e["task_id"]] = t
    # closures have an authoritative timestamp: use it even for tasks closed before monitoring
    for tid, t in states.items():
        if period.contains(C.ms_to_dt(t.get("date_closed"))) and t.get("category") == "closed":
            moved["closed"][tid] = t
    notes = []
    baseline = ctx.store.baseline_at()
    if baseline and baseline > period.start:
        notes.append(f"el monitoreo de cambios de estado empezó el {baseline.astimezone(ctx.zone):%Y-%m-%d %H:%M}; "
                     "los movimientos a Testing/Rejected/Blocked anteriores no están incluidos "
                     "(los cierres sí, por su fecha de cierre).")
    runs = ctx.store.sync_runs_between(max(period.start, baseline or period.start), period.end)
    ok = [parse(r["finished_at"]) for r in runs if r["ok"]]
    gap = timedelta(minutes=ctx.cfg["clickup"]["poll_interval_minutes"] * 4)
    gaps = [(a, b) for a, b in zip(ok, ok[1:]) if b - a > gap]
    if gaps:
        notes.append(f"{len(gaps)} hueco(s) de sondeo en el periodo; transiciones intermedias pueden faltar.")
    notes.append("Detección por sondeo cada %d min: si un ticket pasó por varios estados entre sondeos, "
                 "solo se ve el último." % ctx.cfg["clickup"]["poll_interval_minutes"])
    return {c: sorted(v.values(), key=lambda t: t["name"]) for c, v in moved.items()}, notes


def stale_list(ctx: Ctx) -> list[dict]:
    states = ctx.store.task_states()
    tasks = [{k: v for k, v in t.items() if not k.startswith("_")} for t in states.values()]
    lm = {tid: t["_meaningful"] for tid, t in states.items() if t.get("_meaningful")}
    cc = ctx.cfg["clickup"]
    return C.stale_tasks(tasks, ctx.now, cc["inactivity_threshold_days"], cc["stale_excluded_categories"],
                         lm, ctx.store.baseline_at())


def cmd_report(ctx: Ctx, period_kind: str, days: int | None, post: bool) -> dict:
    require_fresh_sync(ctx)
    period = C.report_period(period_kind, ctx.now, ctx.zone, days)
    moved, notes = moved_in_period(ctx, period)
    msg = C.build_status_report(ctx.cfg, period, ctx.now, moved, stale_list(ctx), notes, ctx.directory)
    key = f"report:{period_kind}:{period.start.astimezone(ctx.zone):%Y-%m-%d}"
    if period_kind == "on_demand":
        key += f":{ctx.now:%Y%m%dT%H%M%S}"
    res = publish(ctx, key, "status_report", "report_channel_id", msg, post)
    res["mapping_issues"] = flush_mapping_issues(ctx, post)
    res["counts"] = {c: len(moved.get(c) or []) for c in C.CATEGORIES}
    return res


def cmd_stale(ctx: Ctx, post: bool) -> dict:
    require_fresh_sync(ctx)
    stale = stale_list(ctx)
    th = ctx.cfg["clickup"]["inactivity_threshold_days"]
    period = C.Period("on_demand", ctx.now - timedelta(days=th), ctx.now)
    msg = C.build_status_report(ctx.cfg, period, ctx.now, {}, stale, [], ctx.directory)
    key = f"stale:{C.local_date(ctx.now, ctx.zone)}"
    res = publish(ctx, key, "stale_report", "report_channel_id", msg, post)
    res["stale"] = len(stale)
    res["mapping_issues"] = flush_mapping_issues(ctx, post)
    return res


def entered_map(ctx: Ctx) -> dict:
    return {tid: t["_entered"] for tid, t in ctx.store.task_states().items() if t.get("_entered")}


def current_issues(ctx: Ctx) -> list[C.Issue]:
    states = ctx.store.task_states()
    tasks = [{k: v for k, v in t.items() if not k.startswith("_")} for t in states.values()]
    return C.detect_issues(ctx.cfg, tasks, entered_map(ctx), ctx.now, ctx.directory)


KIND_ES = {"blocked": "🚫 Bloqueado", "testing_stuck": "🧪 Esperando QA", "rejected_stuck": "❌ Rechazado sin corregir",
           "overdue": "⏰ Vencido", "due_soon": "📅 Vence pronto", "unassigned": "👤 Sin responsable",
           "no_due_date": "📆 Sin fecha de entrega", "no_estimate": "⏱️ Sin estimación",
           "no_description": "📝 Sin descripción", "duplicate": "🧬 Posible duplicado",
           "done_open_subtasks": "🧩 Cerrado con subtareas abiertas"}


def cmd_followups(ctx: Ctx, post: bool) -> dict:
    if not ctx.cfg["followups"]["enabled"]:
        return {"skipped": "followups disabled"}
    require_fresh_sync(ctx)
    issues = current_issues(ctx)
    users, actions = set(), []
    groups: dict[tuple, list] = {}  # (escalated, kind, owner_label, why-or-'', next_step) -> [(issue, act)]
    esc_m, esc_id = ctx.directory.mention_key(ctx.cfg["discord"].get("escalation_recipient"), "escalation recipient")
    for i in issues:
        st = ctx.store.followup(i.key)
        act = C.followup_action(st, i, ctx.now, ctx.cfg)
        actions.append((i, act))
        if not act:
            continue
        per_task_why = i.kind in ("overdue", "due_soon")  # the why carries a date that differs per task
        groups.setdefault((act == "escalate", i.kind, i.owner_label, "" if per_task_why else i.why, i.next_step),
                          []).append((i, act))
        users.update(i.owner_ids)
        if act == "escalate" and esc_id:
            users.add(esc_id)
    res: dict = {"open_issues": len(issues), "to_send": sum(1 for _, a in actions if a)}
    if groups:
        L = [f"🔔 **SEGUIMIENTO DE PROYECTO — {C.fmt_day(C.local_date(ctx.now, ctx.zone))}**", ""]
        for escalated in (False, True):
            keys = [k for k in groups if k[0] == escalated]
            if escalated and keys:
                L += [f"**⚠️ ESCALADOS** {esc_m or '(sin destinatario de escalamiento mapeado)'}"]
            for k in sorted(keys, key=lambda k: (list(KIND_ES).index(k[1]), k[2])):
                _, kind, owner, why, step = k
                items = groups[k]
                again = " (seguimiento)" if any(a == "followup" for _, a in items) else ""
                L.append(f"**{KIND_ES[kind]}{again} ({len(items)})** — {why + ' — ' if why else ''}"
                         f"responsable: {owner} — próximo paso: {step}")
                cap = ctx.cfg["followups"]["hygiene"]["max_listed"] if kind in C.HYGIENE_KINDS else None
                shown = sorted(items, key=lambda x: x[0].since)
                for i, _ in shown[:cap]:
                    t = i.task or {}
                    extra = f"{i.why}; " if not why else ""
                    L.append(f"- {t.get('name','')} ({extra}abierto hace {(ctx.now - i.since).days} d)\n"
                             f"  <{t.get('url','')}>")
                if cap and len(shown) > cap:
                    L.append(f"… y {len(shown) - cap} más (`pm.py followups` los lista todos)")
                L.append("")
        msg = C.Message("\n".join(L), sorted(users))
        key = f"followups:{ctx.now.astimezone(ctx.zone):%Y-%m-%dT%H}"
        res.update(publish(ctx, key, "followups", "report_channel_id", msg, post))
    if post:
        for i, act in actions:
            ctx.store.touch_followup(i.key, i.kind, (i.task or {}).get("task_id"), i.since, ctx.now, act, i.why)
        res["resolved"] = [f["issue_key"] for f in ctx.store.resolve_missing({i.key for i in issues}, ctx.now)]
    res["mapping_issues"] = flush_mapping_issues(ctx, post)
    return res


def cmd_health(ctx: Ctx, post: bool) -> dict:
    require_fresh_sync(ctx)
    issues = current_issues(ctx)
    stale = stale_list(ctx)
    today = C.local_date(ctx.now, ctx.zone).isoformat()
    missing = standup_missing(ctx, today)
    h = C.health(ctx.cfg, [{k: v for k, v in t.items() if not k.startswith("_")}
                           for t in ctx.store.task_states().values()], issues, len(stale), len(missing))
    prev = json.loads(ctx.store.meta("last_health") or "null")
    icon = {"VERDE": "🟢", "AMARILLO": "🟡", "ROJO": "🔴"}[h["level"]]
    L = [f"🩺 **SALUD DEL PROYECTO — {C.fmt_day(C.local_date(ctx.now, ctx.zone))}**", "",
         f"{icon} **{h['level']}** — {h['why']}", "",
         "**Hechos observados (ClickUp):**",
         f"- Tickets abiertos: {h['open']} · cerrados: {h['closed']}",
         *[f"- {KIND_ES[k]}: {v}" for k, v in sorted(h["issues"].items())],
         f"- Sin actualización > {ctx.cfg['clickup']['inactivity_threshold_days']} días: {h['stale']} "
         f"({int(h['stale_ratio'] * 100)}% de los abiertos)",
         f"- Daily status pendientes hoy: {h['standup_missing']}"]
    blockers = [s for s in ctx.store.latest_standups() if C.has_blocker(s["blockers"])]
    if blockers:
        L += ["", "**Bloqueos reportados en standups (no verificados):**"]
        L += [f"- <@{s['user_id']}> ({s['local_date']}): {s['blockers'].splitlines()[0][:150]}" for s in blockers]
    load: dict[str, int] = {}
    for t in ctx.store.task_states().values():
        if t.get("category") != "closed":
            for a in t.get("assignees") or []:
                load[a.get("username") or a["id"]] = load.get(a.get("username") or a["id"], 0) + 1
    if load:
        top = sorted(load.items(), key=lambda x: -x[1])[:5]
        L += ["", "**Carga (tickets abiertos por persona):** " + ", ".join(f"{k}: {v}" for k, v in top)]
    L += ["", "**Recomendaciones (inferidas):**"]
    recs = []
    if h["issues"].get("unassigned"):
        recs.append(f"asignar responsable a {h['issues']['unassigned']} ticket(s) sin asignar")
    if h["issues"].get("blocked"):
        recs.append("revisar bloqueos con el PM y definir dueño del desbloqueo")
    if h["stale_ratio"] > 0.2:
        recs.append("depurar el backlog: cerrar, repriorizar o poner fecha a los tickets sin actualización")
    if load and max(load.values()) > 2 * (sum(load.values()) / len(load)):
        recs.append("la carga está concentrada en una persona; revisar distribución")
    if not any(t.get("due_date") for t in ctx.store.task_states().values() if t.get("category") != "closed"):
        recs.append("ningún ticket abierto tiene fecha de entrega: no se puede medir riesgo de plazo")
    L += [f"- {r}" for r in recs] or ["- ninguna"]
    if prev:
        L += ["", f"**Cambio desde la última evaluación ({prev.get('at','')[:10]}):** "
              f"{prev.get('level')} → {h['level']}, abiertos {prev.get('open')} → {h['open']}, "
              f"sin actualizar {prev.get('stale')} → {h['stale']}"]
    L += ["", "_Regla de semáforo documentada en README (sin métricas inventadas: no hay velocidad ni capacidad)._"]
    msg = C.Message("\n".join(L))
    res = publish(ctx, f"health:{today}", "health", "report_channel_id", msg, post)
    if post:
        ctx.store.set_meta("last_health", json.dumps({**h, "at": C.iso_or(ctx.now)}))
    res["health"] = h
    return res


# ------------------------------------------------------------------ standups


def required_members(ctx: Ctx) -> list[C.User]:
    out = []
    for key in ctx.cfg["discord"]["standup"]["required_members"]:
        u = ctx.directory.by_key.get(key)
        if u and ctx.directory.mentionable(u):
            out.append(u)
        else:
            ctx.directory.issues.append(f"standup member '{key}' has no verified Discord mapping")
    return out


def standup_missing(ctx: Ctx, day: str) -> list[C.User]:
    done = {s["user_id"] for s in ctx.store.standups_on(day)}
    return [u for u in required_members(ctx) if u.discord_user_id not in done]


def is_workday(ctx: Ctx) -> bool:
    return ctx.now.astimezone(ctx.zone).weekday() in ctx.cfg["discord"]["standup"]["workdays"]


def cmd_standup_prompt(ctx: Ctx, post: bool, force: bool) -> dict:
    s = ctx.cfg["discord"]["standup"]
    if not (s["prompt_enabled"] and (is_workday(ctx) or force)):
        return {"skipped": "not a workday or prompt disabled"}
    members = required_members(ctx)
    cmds = " · ".join(f"`/{c}`" for c in s["commands"])
    L = ["☀️ **DAILY STATUS**", "",
         f"Buenos días. Envíen su daily status con {cmds}:",
         "1. ¿Qué completaste ayer?", "2. ¿Qué trabajarás hoy?", "3. ¿Tienes algún bloqueo o riesgo?"]
    if members:
        L += ["", " ".join(f"<@{u.discord_user_id}>" for u in members)]
    msg = C.Message("\n".join(L), [u.discord_user_id for u in members])
    day = C.local_date(ctx.now, ctx.zone)
    res = publish(ctx, f"standup:prompt:{day}", "standup_prompt", "standup_channel_id", msg, post)
    res["mapping_issues"] = flush_mapping_issues(ctx, post)
    return res


def cmd_standup_remind(ctx: Ctx, post: bool, force: bool) -> dict:
    if not (ctx.cfg["discord"]["standup"]["reminder_enabled"] and (is_workday(ctx) or force)):
        return {"skipped": "not a workday or reminders disabled"}
    day = C.local_date(ctx.now, ctx.zone).isoformat()
    missing = standup_missing(ctx, day)
    if not missing:
        return {"skipped": "everyone required has submitted", "missing": []}
    cmd = ctx.cfg["discord"]["standup"]["commands"][0]
    msg = C.Message(" ".join(f"<@{u.discord_user_id}>" for u in missing) +
                    f" — recordatorio: aún falta tu daily status de hoy. Usa `/{cmd}`.",
                    [u.discord_user_id for u in missing])
    res = publish(ctx, f"standup:remind:{day}", "standup_reminder", "standup_channel_id", msg, post)
    res["missing"] = [u.key for u in missing]
    return res


def cmd_standup_summary(ctx: Ctx, post: bool, force: bool) -> dict:
    s = ctx.cfg["discord"]["standup"]
    if not (s["summary_enabled"] and (is_workday(ctx) or force)):
        return {"skipped": "not a workday or summary disabled"}
    day = C.local_date(ctx.now, ctx.zone)
    subs = ctx.store.standups_on(day.isoformat())
    missing = [u.display_name for u in standup_missing(ctx, day.isoformat())]
    everyone = s["notification_mode"] in ("summary", "all_team") and bool(subs)
    msg = C.build_standup_summary(ctx.cfg, day, subs, missing, everyone)
    res = publish(ctx, f"standup:summary:{day}", "standup_summary", "standup_channel_id", msg, post)
    res["submitted"] = len(subs)
    res["missing"] = missing
    return res


# ------------------------------------------------------------------ admin


def cmd_mappings(ctx: Ctx) -> dict:
    out = {"problems": ctx.directory.problems(), "users": [], "reviewers": {}}
    cu_members = {}
    try:
        cu_members = {str(m["id"]): m for m in ctx.clickup.team_members(ctx.cfg["clickup"]["workspace_id"])}
    except Exception as e:
        out["problems"].append(f"ClickUp members unavailable: {e}")
    gid = str(ctx.cfg["discord"]["guild_id"] or "")
    for u in ctx.directory.users:
        row = {"key": u.key, "enabled": u.enabled, "verified": u.verified, "mentionable": ctx.directory.mentionable(u)}
        if u.clickup_user_id:
            m = cu_members.get(u.clickup_user_id)
            row["clickup"] = m.get("username") if m else "NOT FOUND in workspace"
        if u.discord_user_id and gid:
            try:
                m = ctx.discord.guild_member(gid, u.discord_user_id)
                row["discord"] = (m["user"].get("global_name") or m["user"]["username"]) if m else "NOT IN SERVER"
            except Exception as e:
                row["discord"] = f"check failed: {e}"
        out["users"].append(row)
    for cat, key in ctx.cfg["discord"]["reviewers"].items():
        m, _ = ctx.directory.mention_key(key, f"{cat} reviewer")
        out["reviewers"][cat] = {"user": key, "mention": m or None}
    mapped = set(ctx.directory.by_clickup)
    out["unmapped_clickup_members"] = [f"{m.get('username')} ({i})" for i, m in cu_members.items() if i not in mapped]
    out["issues"] = sorted(set(ctx.directory.issues))
    return out


def cmd_healthcheck(ctx: Ctx) -> dict:
    problems, ok = [], []
    problems += C.validate_config(ctx.cfg)
    try:
        ctx.clickup.get("/user")
        ok.append("ClickUp token valid")
    except Exception as e:
        problems.append(f"ClickUp: {e}")
    try:
        me = ctx.discord.me()
        ok.append(f"Discord bot {me['username']}")
        for key in ("standup_channel_id", "report_channel_id", "operations_channel_id"):
            ch = ctx.cfg["discord"].get(key)
            if ch:
                ctx.discord.call("GET", f"/channels/{ch}")
    except Exception as e:
        problems.append(f"Discord: {e}")
    last = ctx.store.last_sync_ok()
    limit = timedelta(minutes=ctx.cfg["clickup"]["poll_interval_minutes"] * 4)
    if not last:
        problems.append("no successful ClickUp sync yet")
    elif ctx.now - last > limit:
        problems.append(f"last successful ClickUp sync {last:%Y-%m-%d %H:%M} UTC is older than {limit}")
    else:
        ok.append(f"last sync {last.astimezone(ctx.zone):%H:%M}")
    failed = list(ctx.store.c.execute("SELECT dedupe_key,error FROM notifications WHERE status!='sent' "
                                      "AND created_at > ?", (C.iso_or(ctx.now - timedelta(days=2)),)))
    if failed:
        problems.append(f"{len(failed)} undelivered notification(s): " + ", ".join(r[0] for r in failed[:5]))
    return {"ok": not problems, "checks_ok": ok, "problems": problems}


def cmd_status(ctx: Ctx) -> dict:
    s = ctx.store
    return {
        "baseline_at": s.meta("baseline_at"), "last_sync_ok_at": s.meta("last_sync_ok_at"),
        "tasks_tracked": s.c.execute("SELECT COUNT(*) FROM task_state").fetchone()[0],
        "events": s.c.execute("SELECT COUNT(*) FROM events").fetchone()[0],
        "recent_events": [dict(r) for r in s.c.execute(
            "SELECT task_id,from_status,to_status,occurred_at FROM events ORDER BY occurred_at DESC LIMIT 5")],
        "open_followups": len(s.open_followups()),
        "notifications": dict(s.c.execute("SELECT status, COUNT(*) FROM notifications GROUP BY status").fetchall()),
        "recent_ops_log": s.recent_log(8),
        "last_sync_runs": [dict(r) for r in s.c.execute("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 3")],
    }


# ------------------------------------------------------------------ risks and decisions (local RAID log)


def _fail(msg: str):
    raise C.ConfigError(msg)


def _int15(v, name):
    try:
        n = int(v)
    except (TypeError, ValueError):
        _fail(f"{name} must be a whole number from 1 to 5")
    if not 1 <= n <= 5:
        _fail(f"{name} must be a whole number from 1 to 5")
    return n


def cmd_risk_add(ctx: Ctx, a) -> dict:
    if not (a.title or "").strip():
        _fail("--title (the risk description) is required")
    p, i = _int15(a.probability, "--probability"), _int15(a.impact, "--impact")
    review = a.review_date or (C.local_date(ctx.now, ctx.zone)
                               + timedelta(days=ctx.cfg["risks"]["review_every_days"])).isoformat()
    rid = ctx.store.add_risk(ctx.now, a.title.strip(), p, i, owner=a.owner, mitigation=a.mitigation,
                             contingency=a.contingency, trigger_text=a.trigger, review_date=review, source=a.source)
    ctx.store.log("info", "risk_add", f"#{rid} {p}x{i} by {a.source or 'cli'}: {a.title.strip()[:120]}")
    return {"risk": ctx.store.risk(rid), "escalate": p * i >= ctx.cfg["risks"]["escalation_score"]}


def cmd_risk_update(ctx: Ctx, a) -> dict:
    if a.id is None:
        _fail("--id is required")
    if a.status and a.status not in C.RISK_STATUSES:
        _fail(f"--status must be one of {', '.join(C.RISK_STATUSES)}")
    before = ctx.store.risk(a.id)
    r = ctx.store.update_risk(
        ctx.now, a.id, description=a.title, owner=a.owner, mitigation=a.mitigation, contingency=a.contingency,
        trigger_text=a.trigger, review_date=a.review_date, status=a.status,
        probability=_int15(a.probability, "--probability") if a.probability is not None else None,
        impact=_int15(a.impact, "--impact") if a.impact is not None else None)
    if r is None:
        _fail(f"risk #{a.id} does not exist")
    ctx.store.log("info", "risk_update", f"#{a.id} by {a.source or 'cli'}: score {before['score']}->{r['score']},"
                                         f" status {before['status']}->{r['status']}")
    return {"before": before, "after": r}


def cmd_risk_list(ctx: Ctx, a) -> dict:
    return {"risks": ctx.store.risks(include_closed=a.all)}


def cmd_risk_review(ctx: Ctx, post: bool) -> dict:
    today = C.local_date(ctx.now, ctx.zone)
    msg = C.build_risk_review(ctx.cfg, ctx.store.risks(), today, ctx.directory)
    if msg is None:
        return {"skipped": "no open risks"}
    channel_key = "risks_channel_id" if ctx.cfg["discord"].get("risks_channel_id") else "report_channel_id"
    return publish(ctx, f"risks:{today.isoformat()}", "risk_review", channel_key, msg, post)


def cmd_decision_log(ctx: Ctx, a) -> dict:
    if not (a.text or "").strip():
        _fail("--text (the decision) is required")
    did = ctx.store.add_decision(ctx.now, a.text.strip(), a.context, a.by, a.source)
    ctx.store.log("info", "decision_log", f"#{did} by {a.source or 'cli'}: {a.text.strip()[:120]}")
    return {"decision": ctx.store.decisions(1)[0]}


def cmd_decision_list(ctx: Ctx, a) -> dict:
    return {"decisions": ctx.store.decisions(a.days or 20)}


# ------------------------------------------------------------------ main


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pm.py")
    ap.add_argument("command", choices=["sync", "report", "stale", "followups", "health", "standup-prompt",
                                        "standup-remind", "standup-summary", "mappings", "healthcheck",
                                        "status", "backup", "risk-add", "risk-update", "risk-list", "risk-review",
                                        "decision-log", "decision-list"])
    ap.add_argument("--period", default="weekly", choices=["daily", "weekly", "on_demand"])
    ap.add_argument("--days", type=int)
    ap.add_argument("--post", action="store_true", help="publish to Discord (default: dry run)")
    ap.add_argument("--force", action="store_true", help="run standup jobs on a non-workday")
    ap.add_argument("--cron", action="store_true", help="silent on success, one line on failure")
    ap.add_argument("--if-enabled", action="store_true", help="report: skip unless that period is enabled")
    for flag in ("title", "owner", "mitigation", "contingency", "trigger", "review-date", "status", "text",
                 "context", "by", "source"):
        ap.add_argument(f"--{flag}")
    ap.add_argument("--probability", type=int)
    ap.add_argument("--impact", type=int)
    ap.add_argument("--id", type=int)
    ap.add_argument("--all", action="store_true", help="risk-list: include closed risks")
    a = ap.parse_args(argv)
    try:
        cfg = C.load_config()
    except Exception as e:
        print(f"⚠️ project-manager: config error: {e}")
        return 1
    if not cfg["enabled"]:
        return 0
    store = open_store(C.DATA_DIR)
    ctx = Ctx(cfg, store)
    try:
        if a.command == "sync":
            res = sync(ctx)
        elif a.command == "report":
            if a.if_enabled and not cfg["discord"]["reporting"].get(f"{a.period}_enabled"):
                return 0
            res = cmd_report(ctx, a.period, a.days, a.post)
        elif a.command == "stale":
            res = cmd_stale(ctx, a.post)
        elif a.command == "followups":
            res = cmd_followups(ctx, a.post)
        elif a.command == "health":
            res = cmd_health(ctx, a.post)
        elif a.command == "standup-prompt":
            res = cmd_standup_prompt(ctx, a.post, a.force)
        elif a.command == "standup-remind":
            res = cmd_standup_remind(ctx, a.post, a.force)
        elif a.command == "standup-summary":
            res = cmd_standup_summary(ctx, a.post, a.force)
        elif a.command == "mappings":
            res = cmd_mappings(ctx)
        elif a.command == "healthcheck":
            res = cmd_healthcheck(ctx)
            if a.cron:
                if not res["ok"]:
                    print("⚠️ project-manager healthcheck: " + "; ".join(res["problems"]))
                return 0 if res["ok"] else 1
        elif a.command == "status":
            res = cmd_status(ctx)
        elif a.command == "risk-add":
            res = cmd_risk_add(ctx, a)
        elif a.command == "risk-update":
            res = cmd_risk_update(ctx, a)
        elif a.command == "risk-list":
            res = cmd_risk_list(ctx, a)
        elif a.command == "risk-review":
            res = cmd_risk_review(ctx, a.post)
        elif a.command == "decision-log":
            res = cmd_decision_log(ctx, a)
        elif a.command == "decision-list":
            res = cmd_decision_list(ctx, a)
        else:
            res = {"backup": str(store.backup(C.DATA_DIR / "backups"))}
    except Exception as e:
        store.log("error", a.command, f"{e.__class__.__name__}: {e}")
        if a.post and a.command not in ("sync",):
            notify_ops(ctx, f"ops:fail:{a.command}:{ctx.now:%Y%m%dT%H}",
                       f"`{a.command}` falló y no se publicó nada: {e.__class__.__name__}: {str(e)[:300]}")
        if a.cron and a.command == "sync" and _transient(e) and not _streak(True):
            return 0  # one network blip every 15 min is not news; the 3rd in a row is (2026-10-23 17:30 alert)
        if a.cron:
            print(f"⚠️ project-manager `{a.command}` failed: {e.__class__.__name__}: {str(e)[:300]}")
        else:
            traceback.print_exc()
        return 1
    if a.command == "sync":
        _streak(False)
    if not a.cron:
        print(json.dumps(res, ensure_ascii=False, indent=1, default=str))
    return 0


def _transient(e: Exception) -> bool:
    """A network-level ClickUp failure (timeout, refused, DNS), not a bad token or a 4xx."""
    return isinstance(e, ApiError) and "network:" in str(e)


def _streak(failed: bool) -> bool:
    """Count consecutive transient sync failures; True when this one should be reported (3rd, then every 12th)."""
    path = C.DATA_DIR / "sync-errors.json"
    try:
        n = json.loads(path.read_text()).get("streak", 0) if path.exists() else 0
    except (OSError, ValueError):
        n = 0
    n = n + 1 if failed else 0
    try:
        path.write_text(json.dumps({"streak": n}))
    except OSError:
        pass
    return failed and (n == 3 or (n > 3 and (n - 3) % 12 == 0))


if __name__ == "__main__":
    sys.exit(main())
