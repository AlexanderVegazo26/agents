#!/usr/bin/env python3
"""Ideas (OpenMuse port) in proactive_scan.py: candidates, retirement, decisions. No network, temp HOME."""
import json, os, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
import proactive_scan as ps  # noqa: E402

def mail(**kw):
    m = {"id": "m1", "threadId": "t1", "from": "Ana <ana@x.co>", "subject": "Permiso de salida", "date": "2026-11-09",
         "attachments": ["permiso.pdf"], "replied": False, "body_head": "Por favor firma y completa el formulario",
         "verdict": "needs_you"}
    m.update(kw); return m

class Ideas(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); ps.MAIL_JSON = os.path.join(self.d, "mail.json")
        ps.GOALS_DIR = os.path.join(self.d, "goals"); os.makedirs(ps.GOALS_DIR)
    def write(self, rows): json.dump({"sorted": rows}, open(ps.MAIL_JSON, "w"))
    def test_document_and_meet(self):
        self.write([mail(), mail(id="m2", threadId="t2", attachments=[], subject="¿Café el jueves?", body_head="estás disponible?")])
        kinds = sorted(c["kind"] for c in ps.idea_candidates()); self.assertEqual(kinds, ["coordinate", "document"])
    def test_meet_needs_needs_you(self):
        self.write([mail(attachments=[], subject="Webinar schedule", verdict="can_wait")]); self.assertEqual(ps.idea_candidates(), [])
    def test_retire_after_reply_and_skip_handled(self):
        st = {}
        self.write([mail()]); f = ps.refresh_ideas(st); self.assertEqual(len(f), 1); f[0]["status"] = "sent"
        self.write([mail(replied=True)]); self.assertEqual(ps.refresh_ideas(st), [])
        self.assertEqual(st["ideas"]["idea-doc-t1"]["status"], "retired")
        st2 = {}; self.write([mail(replied=True)]); self.assertEqual(ps.refresh_ideas(st2), [])
    def test_goal_plan_and_retire(self):
        p = os.path.join(ps.GOALS_DIR, "g.json"); json.dump({"title": "Grow", "milestones": []}, open(p, "w"))
        st = {}; fresh = ps.refresh_ideas(st); self.assertEqual(fresh[0]["title"], "Let's make a plan for Grow")
        json.dump({"title": "Grow", "milestones": [{"title": "x", "done": False}]}, open(p, "w"))
        ps.refresh_ideas(st); self.assertEqual(st["ideas"][fresh[0]["id"]]["status"], "retired")
    def test_not_resent_and_hide(self):
        st = {}; self.write([mail()])
        first = ps.refresh_ideas(st); self.assertEqual(len(first), 1); first[0]["status"] = "sent"
        self.assertEqual(ps.refresh_ideas(st), [])
        self.assertIn("Hidden", ps.decide_idea(st, "idea-doc-t1", "hide"))
        self.assertIn("Already hidden", ps.decide_idea(st, "idea-doc-t1", "start"))
    def test_cap_five(self):
        st = {}; self.write([mail(id=f"m{i}", threadId=f"t{i}") for i in range(8)])
        first = ps.refresh_ideas(st); self.assertEqual(len(first), 5)
        for i in first: i["status"] = "sent"
        self.assertEqual(len(ps.refresh_ideas(st)), 3)

if __name__ == "__main__":
    unittest.main()
