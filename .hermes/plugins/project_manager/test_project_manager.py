"""Offline tests for the project manager. ClickUp and Discord are faked; config and pm.db live in a
temporary directory, so nothing reaches a real channel or ticket.

    /usr/bin/python3 -m unittest test_project_manager.py
"""

from __future__ import annotations

import copy
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import pm_core as C  # noqa: E402
import pm  # noqa: E402
from pm_clients import ApiError  # noqa: E402
from pm_store import Store  # noqa: E402

AST = ZoneInfo("America/Santo_Domingo")
JORGE, IVANA, LISS, DEV = "775172569208061952", "652674757065572382", "1534908569017647226", "111111111111111111"

CFG = C._merge(C.DEFAULTS, {
    "timezone": "America/Santo_Domingo",
    "clickup": {"workspace_id": "1", "list_ids": ["L1"],
                "status_mappings": {"closed": ["closed"], "testing": ["qa -testing"], "rejected": ["rejected"],
                                    "blocked": ["blocked"]}},
    "discord": {"guild_id": "999999999999999999", "standup_channel_id": "100", "report_channel_id": "200",
                "operations_channel_id": "300",
                "standup": {"required_members": ["jorge", "ivana"], "notification_mode": "summary"},
                "reviewers": {"testing": "jorge", "rejected": "ivana", "blocked": "lissette"},
                "project_manager": "lissette", "escalation_recipient": "lissette"},
    "users": [
        {"key": "jorge", "display_name": "Jorge", "clickup_user_id": "1", "discord_user_id": JORGE, "verified": True},
        {"key": "ivana", "display_name": "Ivana", "clickup_user_id": "2", "discord_user_id": IVANA, "verified": True},
        {"key": "lissette", "display_name": "Lissette", "clickup_user_id": "3", "discord_user_id": LISS,
         "verified": True},
        {"key": "dev", "display_name": "Dev", "clickup_user_id": "4", "discord_user_id": DEV, "verified": True},
    ],
})


def ms(dt: datetime) -> str:
    return str(int(dt.timestamp() * 1000))


def task(tid, status, *, updated, assignee="4", created=None, closed=None, due=None, stype="custom", name=None):
    return {"id": tid, "name": name or f"Task {tid}", "url": f"https://app.clickup.com/t/{tid}",
            "status": {"status": status, "type": "closed" if status == "closed" else stype},
            "assignees": [{"id": int(assignee), "username": f"user{assignee}"}] if assignee else [],
            "date_updated": ms(updated), "date_created": ms(created or updated - timedelta(days=30)),
            "date_closed": ms(closed) if closed else None, "due_date": ms(due) if due else None,
            "list": {"id": "L1"}}


class FakeClickUp:
    def __init__(self):
        self.tasks: list[dict] = []
        self.fail = False

    def list_tasks(self, list_id):
        if self.fail:
            raise ApiError("ClickUp", 503, "unavailable")
        return copy.deepcopy(self.tasks)

    def get(self, path, params=None):
        return {"user": {}}

    def team_members(self, ws):
        return [{"id": 1, "username": "Jorge"}]


class FakeDiscord:
    def __init__(self, can_everyone=True):
        self.sent: list[dict] = []
        self.can_everyone = can_everyone

    def send(self, channel_id, content, user_ids, everyone):
        self.sent.append({"channel": channel_id, "content": content, "users": user_ids, "everyone": everyone})
        return str(len(self.sent))

    def can_mention_everyone(self, guild, channel):
        return self.can_everyone

    def me(self):
        return {"id": "1", "username": "bot"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "pm.db"
        self.cu, self.dc = FakeClickUp(), FakeDiscord()
        # Monday 2026-10-19 10:00 AST is "now" for the first poll
        self.t0 = datetime(2026, 10, 19, 10, 0, tzinfo=AST).astimezone(timezone.utc)

    def tearDown(self):
        self.tmp.cleanup()

    def ctx(self, now, cfg=None):
        return pm.Ctx(copy.deepcopy(cfg or CFG), Store(self.db), now=now, clickup=self.cu, discord=self.dc)

    def poll(self, now):
        return pm.sync(self.ctx(now))


# ------------------------------------------------------------------ unit


class UnitTests(unittest.TestCase):
    def test_status_normalization(self):
        self.assertEqual(C.norm_status(" QA - Testing "), "qa -testing")
        self.assertEqual(C.categorize("QA -testing", "custom", CFG["clickup"]["status_mappings"]), "testing")
        self.assertEqual(C.categorize("Done", "closed", CFG["clickup"]["status_mappings"]), "closed")
        self.assertIsNone(C.categorize("in progress", "custom", CFG["clickup"]["status_mappings"]))

    def test_weekly_period_is_previous_iso_week(self):
        now = datetime(2026, 10, 21, 0, 30, tzinfo=AST)  # Wednesday
        p = C.report_period("weekly", now, AST)
        self.assertEqual(p.start, datetime(2026, 10, 12, 0, 0, tzinfo=AST))
        self.assertEqual(p.end, datetime(2026, 10, 19, 0, 0, tzinfo=AST))
        monday = datetime(2026, 10, 26, 9, 30, tzinfo=AST)
        self.assertEqual(C.report_period("weekly", monday, AST).start, datetime(2026, 10, 19, tzinfo=AST))

    def test_daily_period_and_timezone(self):
        now = datetime(2026, 10, 21, 2, 0, tzinfo=timezone.utc)  # still Oct 20 in AST
        p = C.report_period("daily", now, AST)
        self.assertEqual(p.start, datetime(2026, 10, 19, tzinfo=AST))
        self.assertEqual(C.local_date(now, AST).isoformat(), "2026-10-20")

    def test_inactivity(self):
        now = datetime(2026, 10, 21, tzinfo=timezone.utc)
        ts = [C.task_from_api(task("a", "open", updated=now - timedelta(days=8)), {}),
              C.task_from_api(task("b", "open", updated=now - timedelta(days=6)), {}),
              C.task_from_api(task("c", "closed", updated=now - timedelta(days=30)), CFG["clickup"]["status_mappings"])]
        stale = C.stale_tasks(ts, now, 7, ["closed"], {}, None)
        self.assertEqual([t["task_id"] for t in stale], ["a"])

    def test_mapping_and_missing(self):
        d = C.Directory(CFG)
        self.assertEqual(d.mention_key("jorge", "t")[0], f"<@{JORGE}>")
        self.assertEqual(d.mention_key("nobody", "t"), (None, None))
        lab, uid = d.assignee_label("777", "ghost", True)
        self.assertEqual((lab, uid), ("ghost", None))
        self.assertTrue(any("777" in i for i in d.issues))

    def test_unverified_never_mentioned(self):
        cfg = copy.deepcopy(CFG)
        cfg["users"][0]["verified"] = False
        d = C.Directory(cfg)
        self.assertEqual(d.mention_key("jorge", "testing reviewer"), (None, None))

    def test_duplicate_mapping_detected(self):
        cfg = copy.deepcopy(CFG)
        cfg["users"].append({"key": "dup", "clickup_user_id": "1", "discord_user_id": "222222222222222222"})
        self.assertTrue(any("duplicate clickup_user_id" in p for p in C.Directory(cfg).problems()))

    def test_followup_policy(self):
        now = datetime(2026, 10, 21, tzinfo=timezone.utc)
        i = C.Issue("blocked:x", "blocked", {}, [], "", now, "", "")
        self.assertEqual(C.followup_action(None, i, now, CFG), "notify")
        st = {"first_notified_at": now.isoformat(), "last_notified_at": now.isoformat()}
        self.assertIsNone(C.followup_action(st, i, now + timedelta(hours=2), CFG))
        self.assertEqual(C.followup_action(st, i, now + timedelta(hours=25), CFG), "followup")
        self.assertEqual(C.followup_action(st, i, now + timedelta(days=3), CFG), "escalate")
        st["escalated_at"] = (now + timedelta(days=3)).isoformat()
        st["last_notified_at"] = st["escalated_at"]
        self.assertIsNone(C.followup_action(st, i, now + timedelta(days=3, hours=1), CFG))

    def test_split_message(self):
        parts = C.split_message("\n".join(["x" * 100] * 50), 1000)
        self.assertTrue(all(len(p) <= 1000 for p in parts))
        self.assertEqual(sum(p.count("x" * 100) for p in parts), 50)

    def test_blocker_detection_and_refs(self):
        self.assertFalse(C.has_blocker("Ninguno"))
        self.assertFalse(C.has_blocker(" no "))
        self.assertTrue(C.has_blocker("Esperando credenciales"))
        # real answers from 2026-10-22/23 that the old regex counted as blockers
        for none in ("No por ahora", "Sin impedimentos", "Ninguno reportado", "Nada por ahora.", "Sin bloqueos por el momento"):
            self.assertFalse(C.has_blocker(none), none)
        for real in ("No, pero espero acceso a la base de datos", "Sin novedad, aunque falta el diseño",
                     "No hay ambiente de staging"):
            self.assertTrue(C.has_blocker(real), real)
        self.assertEqual(C.clip("completar los pasos de confirmación y explicación de la suspensión", 50),
                         "completar los pasos de confirmación y explicación…")
        self.assertEqual(C.clickup_refs("ver https://app.clickup.com/t/86e3qkmad y #86e3qkm87"),
                         ["86e3qkmad", "86e3qkm87"])


# ------------------------------------------------------------------ scenarios


class Scenarios(Base):
    def baseline(self, *tasks):
        self.cu.tasks = list(tasks)
        self.poll(self.t0)

    def report(self, now):
        return pm.cmd_report(self.ctx(now), "weekly", None, True)

    def move(self, tid, status, at):
        for t in self.cu.tasks:
            if t["id"] == tid:
                t["status"] = {"status": status, "type": "custom"}
                t["date_updated"] = ms(at)

    def test_s1_ticket_enters_testing_mentions_jorge(self):
        self.baseline(task("t1", "in progress", updated=self.t0 - timedelta(hours=1)))
        self.move("t1", "QA -testing", self.t0 + timedelta(hours=2))
        self.poll(self.t0 + timedelta(hours=3))
        self.report(self.t0 + timedelta(days=7))
        msg = "\n".join(s["content"] for s in self.dc.sent)
        self.assertIn("Task t1", msg)
        self.assertIn(f"<@{JORGE}> favor revisar", msg)
        self.assertIn(JORGE, sum((s["users"] for s in self.dc.sent), []))
        self.assertNotIn(f"<@{IVANA}>", msg)
        self.assertIn("Dev", msg)  # assignee shown, not confused with the reviewer

    def test_s2_s11_no_moves_no_reviewer_mentions(self):
        self.baseline(task("t1", "in progress", updated=self.t0))
        self.poll(self.t0 + timedelta(hours=1))
        self.report(self.t0 + timedelta(days=7))
        msg = "\n".join(s["content"] for s in self.dc.sent)
        for uid in (JORGE, IVANA, LISS):
            self.assertNotIn(uid, msg)
        self.assertEqual(sum((s["users"] for s in self.dc.sent), []), [])

    def test_s3_rejected_mentions_ivana(self):
        self.baseline(task("t1", "qa -testing", updated=self.t0))
        self.move("t1", "rejected", self.t0 + timedelta(hours=1))
        self.poll(self.t0 + timedelta(hours=2))
        self.report(self.t0 + timedelta(days=7))
        msg = "\n".join(s["content"] for s in self.dc.sent)
        self.assertIn(f"<@{IVANA}> favor revisar los tickets que entraron a Rejected", msg)
        self.assertNotIn(f"<@{JORGE}>", msg)

    def test_s4_blocked_mentions_lissette(self):
        self.baseline(task("t1", "in progress", updated=self.t0))
        self.move("t1", "blocked", self.t0 + timedelta(hours=1))
        self.poll(self.t0 + timedelta(hours=2))
        self.report(self.t0 + timedelta(days=7))
        self.assertIn(f"<@{LISS}> favor revisar los tickets marcados como Blocked",
                      "\n".join(s["content"] for s in self.dc.sent))

    def test_s5_stale_ticket(self):
        self.baseline(task("old", "in progress", updated=self.t0 - timedelta(days=10)),
                      task("new", "in progress", updated=self.t0 - timedelta(days=1)))
        stale = pm.stale_list(self.ctx(self.t0))
        self.assertEqual([t["task_id"] for t in stale], ["old"])
        self.assertFalse(stale[0]["inferred"])

    def test_s6_automation_updates_flagged_as_inferred(self):
        self.baseline(task("bot", "in progress", updated=self.t0))
        for day in range(1, 10):  # an automation touches date_updated daily; tracked fields never change
            for t in self.cu.tasks:
                t["date_updated"] = ms(self.t0 + timedelta(days=day))
            self.poll(self.t0 + timedelta(days=day, minutes=5))
        stale = pm.stale_list(self.ctx(self.t0 + timedelta(days=9, hours=1)))
        self.assertEqual([t["task_id"] for t in stale], ["bot"])
        self.assertTrue(stale[0]["inferred"])

    def test_s7_unmapped_assignee_reported_not_invented(self):
        self.baseline(task("t1", "in progress", updated=self.t0 - timedelta(days=10), assignee="777"))
        res = self.report(self.t0 + timedelta(days=1))
        msg = "\n".join(s["content"] for s in self.dc.sent if s["channel"] == "200")
        self.assertIn("user777", msg)
        self.assertNotIn("<@777", msg)
        self.assertTrue(any("777" in i for i in res["mapping_issues"]))
        self.assertTrue(any(s["channel"] == "300" and "777" in s["content"] for s in self.dc.sent))

    def test_s8_restart_does_not_duplicate(self):
        self.baseline(task("t1", "in progress", updated=self.t0))
        self.move("t1", "blocked", self.t0 + timedelta(hours=1))
        self.poll(self.t0 + timedelta(hours=2))
        self.poll(self.t0 + timedelta(hours=2, minutes=15))  # same data again: no new event
        store = Store(self.db)  # "restart": a fresh connection
        self.assertEqual(store.c.execute("SELECT COUNT(*) FROM events").fetchone()[0], 1)
        now = self.t0 + timedelta(days=7)
        self.report(now)
        n = len(self.dc.sent)
        self.report(now + timedelta(minutes=30))  # same period, after restart: ledger says sent
        self.assertEqual(len(self.dc.sent), n)
        pm.cmd_followups(self.ctx(now), True)
        m = len(self.dc.sent)
        pm.cmd_followups(self.ctx(now + timedelta(hours=1)), True)  # within cooldown: nothing new
        self.assertEqual(len(self.dc.sent), m)

    def test_s10_no_everyone_permission_falls_back(self):
        self.dc.can_everyone = False
        ctx = self.ctx(self.t0)
        ctx.store.save_standup(JORGE, "2026-10-19", "g", "a", "b", "Ninguno", self.t0)
        res = pm.cmd_standup_summary(ctx, True, True)
        self.assertFalse(res["everyone"])
        self.assertFalse(any(s["everyone"] for s in self.dc.sent))
        self.assertNotIn("@everyone", self.dc.sent[-1]["content"])
        self.assertTrue(any(r["kind"] == "everyone_fallback" for r in ctx.store.recent_log()))

    def test_s12_clickup_failure_publishes_no_report(self):
        self.baseline(task("t1", "in progress", updated=self.t0))
        self.cu.fail = True
        with self.assertRaises(ApiError):
            self.report(self.t0 + timedelta(days=7))
        self.assertFalse(any(s["channel"] == "200" for s in self.dc.sent))
        store = Store(self.db)
        self.assertEqual(store.c.execute("SELECT ok FROM sync_runs ORDER BY id DESC").fetchone()[0], 0)
        # the CLI path turns this into an ops notification
        os.environ["PM_CONFIG"] = "/nonexistent"
        try:
            ctx = self.ctx(self.t0 + timedelta(days=7))
            pm.notify_ops(ctx, "ops:test", "report failed")
            self.assertTrue(any(s["channel"] == "300" for s in self.dc.sent))
        finally:
            del os.environ["PM_CONFIG"]

    def test_s9_standup_persist_update_and_post(self):
        ctx = self.ctx(self.t0)
        row, upd = ctx.store.save_standup(JORGE, "2026-10-19", "g", "Tests", "QA", "Esperando API #86e3qkmad",
                                          self.t0)
        self.assertFalse(upd)
        row, upd = ctx.store.save_standup(JORGE, "2026-10-19", "g", "Tests v2", "QA", "Ninguno",
                                          self.t0 + timedelta(minutes=5))
        self.assertTrue(upd)
        self.assertEqual(row["revision"], 2)
        self.assertEqual(len(ctx.store.standups_on("2026-10-19")), 1)  # no duplicate
        msg = C.build_standup_post(CFG, row, {}, False, [], True)
        self.assertIn(f"<@{JORGE}>", msg.text)
        self.assertIn("Tests v2", msg.text)
        self.assertEqual(msg.user_ids, [])  # summary mode: the post itself pings nobody
        self.assertIn("actualizado", msg.text)

    def test_standup_reminder_targets_only_missing(self):
        ctx = self.ctx(self.t0)
        ctx.store.save_standup(JORGE, ctx.now.astimezone(AST).date().isoformat(), "g", "a", "b", "", self.t0)
        res = pm.cmd_standup_remind(ctx, True, True)
        self.assertEqual(res["missing"], ["ivana"])
        self.assertEqual(self.dc.sent[-1]["users"], [IVANA])
        self.assertFalse(self.dc.sent[-1]["everyone"])
        n = len(self.dc.sent)
        pm.cmd_standup_remind(self.ctx(self.t0 + timedelta(minutes=10)), True, True)
        self.assertEqual(len(self.dc.sent), n)  # once per day

    def test_mention_modes(self):
        from standup_discord import build_mentions
        d = C.Directory(CFG)
        cfg = copy.deepcopy(CFG)
        for mode, can, expect in (("all_team", True, (True, [], None)), ("summary", True, (False, [], None)),
                                  ("quiet", True, (False, [], None))):
            cfg["discord"]["standup"]["notification_mode"] = mode
            self.assertEqual(build_mentions(cfg, d, can), expect)
        cfg["discord"]["standup"]["notification_mode"] = "all_team"
        self.assertFalse(build_mentions(cfg, d, False)[0])
        cfg["discord"]["standup"].update(notification_mode="targeted", targeted_recipients=["lissette"])
        self.assertEqual(build_mentions(cfg, d, True), (False, [LISS], None))

    def test_closed_uses_authoritative_date_even_before_baseline(self):
        closed_at = self.t0 - timedelta(days=3)  # Friday of the previous week
        self.baseline(task("c1", "closed", updated=closed_at, closed=closed_at))
        res = pm.cmd_report(self.ctx(self.t0 + timedelta(hours=1)), "weekly", None, False)
        self.assertIn("Task c1", res["text"])
        self.assertEqual(res["counts"]["closed"], 1)

    def test_currently_in_testing_is_not_moved_to_testing(self):
        self.baseline(task("t1", "qa -testing", updated=self.t0 - timedelta(hours=1)))  # already there
        self.poll(self.t0 + timedelta(hours=1))
        res = pm.cmd_report(self.ctx(self.t0 + timedelta(days=7)), "weekly", None, False)
        self.assertEqual(res["counts"]["testing"], 0)

    def test_task_created_in_blocked_after_baseline(self):
        self.baseline(task("t1", "in progress", updated=self.t0))
        self.cu.tasks.append(task("n1", "blocked", updated=self.t0 + timedelta(hours=1),
                                  created=self.t0 + timedelta(hours=1)))
        self.poll(self.t0 + timedelta(hours=2))
        res = pm.cmd_report(self.ctx(self.t0 + timedelta(days=7)), "weekly", None, False)
        self.assertEqual(res["counts"]["blocked"], 1)

    def test_blocked_followup_escalates_once(self):
        self.baseline(task("t1", "blocked", updated=self.t0))
        for h, expect in ((0, "notify"), (1, None), (25, "followup"), (73, "escalate"), (74, None)):
            now = self.t0 + timedelta(hours=h)
            n = len(self.dc.sent)
            pm.cmd_followups(self.ctx(now), True)
            sent = self.dc.sent[n:]
            if expect is None:
                self.assertEqual(sent, [], f"hour {h}")
            else:
                self.assertTrue(sent, f"hour {h}")
                if expect == "escalate":
                    self.assertIn("ESCALADOS", sent[0]["content"])
        self.move("t1", "in progress", self.t0 + timedelta(hours=80))
        res = pm.cmd_followups(self.ctx(self.t0 + timedelta(hours=81)), True)
        self.assertIn("blocked:t1", res["resolved"])



class SyncTransientTest(unittest.TestCase):
    """2026-10-23 17:30: one ClickUp network timeout sent a sync-failed alert to Telegram."""

    def test_only_repeated_network_failures_are_reported(self):
        import pm
        old = C.DATA_DIR
        C.DATA_DIR = Path(tempfile.mkdtemp())
        try:
            self.assertTrue(pm._transient(pm.ApiError("ClickUp", None, "network: TimeoutError")))
            self.assertFalse(pm._transient(pm.ApiError("ClickUp", 401, "bad token")))
            seq = [pm._streak(True) for _ in range(15)]
            self.assertEqual([i + 1 for i, x in enumerate(seq) if x], [3, 15])
            pm._streak(False)
            self.assertFalse(pm._streak(True))
        finally:
            C.DATA_DIR = old

if __name__ == "__main__":
    unittest.main()


class HygieneAndRaid(unittest.TestCase):
    NOW = datetime(2026, 10, 27, 14, 0, tzinfo=timezone.utc)

    def cfg(self, **h):
        return C._merge(CFG, {"followups": {"hygiene": {"enabled": True, **h}}})

    def snap(self, tid, name=None, **kw):
        base = {"task_id": tid, "name": name or f"Ticket {tid} unico", "url": "u", "status": "open", "category": None,
                "assignees": [{"id": "4", "username": "dev"}], "due_date": ms(self.NOW), "date_created": ms(self.NOW),
                "archived": False, "parent": None, "time_estimate": 3600000, "description_len": 50}
        base.update(kw)
        return base

    def kinds(self, tasks, cfg=None):
        cfg = cfg or self.cfg()
        d = C.Directory(cfg)
        return sorted((i.kind, i.task["task_id"]) for i in C.detect_hygiene(cfg, tasks, self.NOW, d))

    def test_disabled_by_default(self):
        d = C.Directory(CFG)
        self.assertEqual(C.detect_hygiene(CFG, [self.snap("a", due_date=None)], self.NOW, d), [])

    def test_missing_fields_flagged_and_unknown_not(self):
        t = [self.snap("a", due_date=None, time_estimate=None, description_len=0)]
        self.assertEqual(self.kinds(t), [("no_description", "a"), ("no_due_date", "a"), ("no_estimate", "a")])
        old = self.snap("b", due_date=ms(self.NOW))
        del old["time_estimate"], old["description_len"]  # row from before the new fields: unknown
        self.assertEqual(self.kinds([old]), [])

    def test_closed_and_subtasks_skipped_and_hygiene_notifies_once(self):
        t = [self.snap("c", category="closed", due_date=None), self.snap("s", parent="a", due_date=None)]
        self.assertEqual(self.kinds(t), [])
        i = C.detect_hygiene(self.cfg(), [self.snap("a", due_date=None)], self.NOW, C.Directory(self.cfg()))[0]
        self.assertEqual(C.followup_action(None, i, self.NOW, self.cfg()), "notify")
        st = {"first_notified_at": (self.NOW - timedelta(days=9)).isoformat(),
              "last_notified_at": (self.NOW - timedelta(days=9)).isoformat()}
        self.assertIsNone(C.followup_action(st, i, self.NOW, self.cfg()))

    def test_duplicates_and_done_with_open_subtasks(self):
        t = [self.snap("a", name="Fix login redirect"), self.snap("b", name="fix  LOGIN redirect!"),
             self.snap("p", category="closed"), self.snap("k", parent="p")]
        self.assertEqual(self.kinds(t), [("done_open_subtasks", "p"), ("duplicate", "a"), ("duplicate", "b")])

    def test_unassigned_hygiene_goes_to_pm(self):
        cfg = self.cfg()
        i = C.detect_hygiene(cfg, [self.snap("a", assignees=[], due_date=None)], self.NOW, C.Directory(cfg))[0]
        self.assertEqual(i.owner_ids, [LISS])

    def test_risk_score_review_and_escalation(self):
        d = tempfile.mkdtemp()
        st = Store(Path(d) / "pm.db")
        r1 = st.add_risk(self.NOW, "Vendor slips", 4, 4, owner="lissette", review_date="2026-10-20")
        st.add_risk(self.NOW, "Minor UI debt", 2, 2)
        self.assertEqual(st.risk(r1)["score"], 16)
        msg = C.build_risk_review(CFG, st.risks(), self.NOW.date(), C.Directory(CFG))
        self.assertIn("Vendor slips", msg.text)
        self.assertIn("revisión vencida", msg.text)
        self.assertEqual(msg.user_ids, [LISS])           # score >= 15 mentions the escalation recipient
        self.assertLess(msg.text.index("Vendor"), msg.text.index("Minor"))  # worst first
        st.update_risk(self.NOW, r1, status="closed")
        st.update_risk(self.NOW, 2, status="closed")
        self.assertIsNone(C.build_risk_review(CFG, st.risks(), self.NOW.date(), C.Directory(CFG)))  # no noise

    def test_cli_validation_and_audit(self):
        d = tempfile.mkdtemp()
        ctx = pm.Ctx(CFG, Store(Path(d) / "pm.db"), now=self.NOW)
        A = lambda **k: type("A", (), {"title": None, "owner": None, "mitigation": None, "contingency": None,
                                       "trigger": None, "review_date": None, "status": None, "probability": None,
                                       "impact": None, "id": None, "source": "test", "text": None, "context": None,
                                       "by": None, "days": None, "all": False, **k})()
        with self.assertRaises(C.ConfigError):
            pm.cmd_risk_add(ctx, A(title="x", probability=6, impact=2))
        r = pm.cmd_risk_add(ctx, A(title="x", probability=5, impact=4))
        self.assertTrue(r["escalate"])
        self.assertEqual(r["risk"]["review_date"], "2026-11-03")
        out = pm.cmd_decision_log(ctx, A(text="Use Postgres", by="jorge"))
        self.assertEqual(out["decision"]["text"], "Use Postgres")
        self.assertTrue(any(l["kind"] == "risk_add" for l in ctx.store.recent_log(10)))
