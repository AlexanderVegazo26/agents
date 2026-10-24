"""SQLite persistence (WAL) shared by the gateway plugin (standups) and the scheduled scripts.

Tables: task_state (last observed snapshot per task), events (status transitions, idempotent by
event_id), sync_runs (every poll, ok or failed), notifications (delivery ledger keyed by dedupe_key,
so a crash between sending and recording at worst re-sends once and a re-run never re-sends),
followups (per-issue escalation state), standups, ops_log (mapping problems, permission fallbacks).
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS task_state(
  task_id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT, category TEXT,
  status_entered_at TEXT, last_meaningful_at TEXT, first_seen_at TEXT, last_seen_at TEXT);
CREATE TABLE IF NOT EXISTS events(
  event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_status TEXT, to_status TEXT,
  to_category TEXT, occurred_at TEXT NOT NULL, window_start TEXT, observed_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_occ ON events(occurred_at);
CREATE TABLE IF NOT EXISTS sync_runs(
  id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, ok INTEGER, tasks INTEGER,
  events INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS notifications(
  dedupe_key TEXT PRIMARY KEY, kind TEXT, channel_id TEXT, status TEXT NOT NULL,
  message_ids TEXT, created_at TEXT, sent_at TEXT, error TEXT, attempts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS followups(
  issue_key TEXT PRIMARY KEY, kind TEXT, task_id TEXT, opened_at TEXT, first_notified_at TEXT,
  last_notified_at TEXT, notify_count INTEGER DEFAULT 0, escalated_at TEXT, resolved_at TEXT,
  last_seen_at TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS standups(
  user_id TEXT NOT NULL, local_date TEXT NOT NULL, guild_id TEXT, completed TEXT, planned TEXT,
  blockers TEXT, submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER DEFAULT 1,
  channel_id TEXT, message_ids TEXT, PRIMARY KEY(user_id, local_date));
CREATE TABLE IF NOT EXISTS ops_log(
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, level TEXT, kind TEXT, detail TEXT);
"""


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def parse(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.c = sqlite3.connect(str(path), timeout=30, isolation_level=None)
        self.c.row_factory = sqlite3.Row
        self.c.execute("PRAGMA journal_mode=WAL")
        self.c.execute("PRAGMA busy_timeout=30000")
        self.c.executescript(SCHEMA)
        if self.meta("schema_version") is None:
            self.set_meta("schema_version", str(SCHEMA_VERSION))

    # -- meta
    def meta(self, key: str) -> str | None:
        r = self.c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return r[0] if r else None

    def set_meta(self, key: str, value: str) -> None:
        self.c.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (key, value))

    def baseline_at(self) -> datetime | None:
        return parse(self.meta("baseline_at"))

    # -- snapshots
    def task_states(self) -> dict[str, dict]:
        out = {}
        for r in self.c.execute("SELECT * FROM task_state"):
            d = json.loads(r["data"])
            d["_entered"] = parse(r["status_entered_at"])
            d["_meaningful"] = parse(r["last_meaningful_at"])
            d["_first_seen"] = parse(r["first_seen_at"])
            d["_last_seen"] = parse(r["last_seen_at"])
            out[r["task_id"]] = d
        return out

    def apply_sync(self, tasks: list[dict], events: list[dict], meaningful: set[str], observed: datetime,
                   started: datetime) -> int:
        """Write new snapshots, events and the sync run in ONE transaction: a crash leaves the
        previous state intact, so the next poll recomputes the same transitions (same event_ids)."""
        prev = {r["task_id"]: r for r in self.c.execute(
            "SELECT task_id,status_entered_at,first_seen_at,last_meaningful_at,status FROM task_state")}
        ev_by_task = {e["task_id"]: e for e in events}
        new_events = 0
        self.c.execute("BEGIN IMMEDIATE")
        try:
            for e in events:
                cur = self.c.execute(
                    "INSERT OR IGNORE INTO events(event_id,task_id,from_status,to_status,to_category,occurred_at,"
                    "window_start,observed_at) VALUES(?,?,?,?,?,?,?,?)",
                    (e["event_id"], e["task_id"], e["from_status"], e["to_status"], e["to_category"],
                     iso(e["occurred_at"]), iso(e["window_start"]), iso(e["observed_at"])))
                new_events += cur.rowcount
            for t in tasks:
                p = prev.get(t["task_id"])
                if t["task_id"] in ev_by_task:
                    entered = iso(ev_by_task[t["task_id"]]["occurred_at"])
                elif p is not None and (p["status"] or "").lower() == (t["status"] or "").lower():
                    entered = p["status_entered_at"]
                else:
                    entered = iso(observed)
                lm = iso(observed) if t["task_id"] in meaningful else (p["last_meaningful_at"] if p else iso(observed))
                self.c.execute(
                    "INSERT INTO task_state(task_id,data,status,category,status_entered_at,last_meaningful_at,"
                    "first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET "
                    "data=excluded.data,status=excluded.status,category=excluded.category,"
                    "status_entered_at=excluded.status_entered_at,last_meaningful_at=excluded.last_meaningful_at,"
                    "last_seen_at=excluded.last_seen_at",
                    (t["task_id"], json.dumps(t, ensure_ascii=False), t["status"], t["category"], entered, lm,
                     p["first_seen_at"] if p else iso(observed), iso(observed)))
            if self.meta("baseline_at") is None:
                self.set_meta("baseline_at", iso(observed))
            self.set_meta("last_sync_ok_at", iso(observed))
            self.c.execute("INSERT INTO sync_runs(started_at,finished_at,ok,tasks,events) VALUES(?,?,1,?,?)",
                           (iso(started), iso(observed), len(tasks), new_events))
            self.c.execute("COMMIT")
        except Exception:
            self.c.execute("ROLLBACK")
            raise
        return new_events

    def record_sync_failure(self, started: datetime, error: str) -> None:
        self.c.execute("INSERT INTO sync_runs(started_at,finished_at,ok,error) VALUES(?,?,0,?)",
                       (iso(started), iso(datetime.now(timezone.utc)), error[:500]))

    def last_sync_ok(self) -> datetime | None:
        return parse(self.meta("last_sync_ok_at"))

    def sync_runs_between(self, start: datetime, end: datetime) -> list[sqlite3.Row]:
        return list(self.c.execute("SELECT * FROM sync_runs WHERE finished_at>=? AND finished_at<? ORDER BY id",
                                   (iso(start), iso(end))))

    def events_between(self, start: datetime, end: datetime) -> list[dict]:
        rows = self.c.execute("SELECT * FROM events WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at",
                              (iso(start), iso(end)))
        return [dict(r) for r in rows]

    # -- notifications ledger
    def notification(self, key: str) -> sqlite3.Row | None:
        return self.c.execute("SELECT * FROM notifications WHERE dedupe_key=?", (key,)).fetchone()

    def begin_notification(self, key: str, kind: str, channel_id: str) -> bool:
        """True if this notification should be sent now (new, or a previous attempt failed)."""
        r = self.notification(key)
        if r and r["status"] == "sent":
            return False
        now = iso(datetime.now(timezone.utc))
        self.c.execute("INSERT INTO notifications(dedupe_key,kind,channel_id,status,created_at,attempts) "
                       "VALUES(?,?,?,'pending',?,1) ON CONFLICT(dedupe_key) DO UPDATE SET status='pending',"
                       "attempts=attempts+1", (key, kind, channel_id, now))
        return True

    def finish_notification(self, key: str, message_ids: list[str] | None, error: str | None = None) -> None:
        self.c.execute("UPDATE notifications SET status=?, message_ids=?, sent_at=?, error=? WHERE dedupe_key=?",
                       ("failed" if error else "sent", json.dumps(message_ids or []),
                        None if error else iso(datetime.now(timezone.utc)), (error or "")[:500] or None, key))

    # -- follow-ups
    def followup(self, key: str) -> dict | None:
        r = self.c.execute("SELECT * FROM followups WHERE issue_key=?", (key,)).fetchone()
        return dict(r) if r else None

    def open_followups(self) -> list[dict]:
        return [dict(r) for r in self.c.execute("SELECT * FROM followups WHERE resolved_at IS NULL")]

    def touch_followup(self, key: str, kind: str, task_id: str | None, opened_at: datetime, now: datetime,
                       action: str | None, detail: str) -> None:
        cur = self.followup(key)
        n = iso(now)
        if cur is None or cur.get("resolved_at"):
            self.c.execute("INSERT INTO followups(issue_key,kind,task_id,opened_at,last_seen_at,detail) "
                           "VALUES(?,?,?,?,?,?) ON CONFLICT(issue_key) DO UPDATE SET resolved_at=NULL,"
                           "first_notified_at=NULL,last_notified_at=NULL,notify_count=0,escalated_at=NULL,"
                           "opened_at=excluded.opened_at,last_seen_at=excluded.last_seen_at,detail=excluded.detail",
                           (key, kind, task_id, iso(opened_at), n, detail))
        else:
            self.c.execute("UPDATE followups SET last_seen_at=?, detail=? WHERE issue_key=?", (n, detail, key))
        if action in ("notify", "followup"):
            self.c.execute("UPDATE followups SET first_notified_at=COALESCE(first_notified_at,?), last_notified_at=?,"
                           " notify_count=notify_count+1 WHERE issue_key=?", (n, n, key))
        elif action == "escalate":
            self.c.execute("UPDATE followups SET escalated_at=?, last_notified_at=?, notify_count=notify_count+1"
                           " WHERE issue_key=?", (n, n, key))

    def resolve_missing(self, open_keys: set[str], now: datetime) -> list[dict]:
        resolved = []
        for f in self.open_followups():
            if f["issue_key"] not in open_keys:
                self.c.execute("UPDATE followups SET resolved_at=? WHERE issue_key=?", (iso(now), f["issue_key"]))
                resolved.append(f)
        return resolved

    # -- standups
    def standup(self, user_id: str, local_date: str) -> dict | None:
        r = self.c.execute("SELECT * FROM standups WHERE user_id=? AND local_date=?", (user_id, local_date)).fetchone()
        return dict(r) if r else None

    def save_standup(self, user_id: str, local_date: str, guild_id: str | None, completed: str, planned: str,
                     blockers: str, now: datetime) -> tuple[dict, bool]:
        """Insert or update (a correction). Returns (row, is_update)."""
        existing = self.standup(user_id, local_date)
        n = iso(now)
        if existing:
            self.c.execute("UPDATE standups SET completed=?,planned=?,blockers=?,updated_at=?,revision=revision+1 "
                           "WHERE user_id=? AND local_date=?", (completed, planned, blockers, n, user_id, local_date))
        else:
            self.c.execute("INSERT INTO standups(user_id,local_date,guild_id,completed,planned,blockers,submitted_at,"
                           "updated_at) VALUES(?,?,?,?,?,?,?,?)",
                           (user_id, local_date, guild_id, completed, planned, blockers, n, n))
        return self.standup(user_id, local_date), existing is not None

    def set_standup_messages(self, user_id: str, local_date: str, channel_id: str, message_ids: list[str]) -> None:
        self.c.execute("UPDATE standups SET channel_id=?, message_ids=? WHERE user_id=? AND local_date=?",
                       (channel_id, json.dumps(message_ids), user_id, local_date))

    def standups_on(self, local_date: str) -> list[dict]:
        return [dict(r) for r in self.c.execute("SELECT * FROM standups WHERE local_date=? ORDER BY submitted_at",
                                                (local_date,))]

    def latest_standups(self) -> list[dict]:
        return [dict(r) for r in self.c.execute(
            "SELECT s.* FROM standups s JOIN (SELECT user_id, MAX(local_date) d FROM standups GROUP BY user_id) m "
            "ON s.user_id=m.user_id AND s.local_date=m.d")]

    # -- ops log
    def log(self, level: str, kind: str, detail: str) -> None:
        self.c.execute("INSERT INTO ops_log(ts,level,kind,detail) VALUES(?,?,?,?)",
                       (iso(datetime.now(timezone.utc)), level, kind, detail[:1000]))

    def recent_log(self, n: int = 20) -> list[dict]:
        return [dict(r) for r in self.c.execute("SELECT * FROM ops_log ORDER BY id DESC LIMIT ?", (n,))]

    # -- backups
    def backup(self, dest_dir: Path, keep: int = 14) -> Path:
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"pm-{datetime.now():%Y%m%d}.db"
        if not dest.exists():
            dst = sqlite3.connect(str(dest))
            self.c.backup(dst)
            dst.close()
        for old in sorted(dest_dir.glob("pm-*.db"))[:-keep]:
            old.unlink()
        return dest


def open_store(data_dir: Path) -> Store:
    return Store(data_dir / "pm.db")


__all__ = ["Store", "open_store", "iso", "parse", "shutil"]
