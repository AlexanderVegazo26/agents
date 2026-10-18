#!/usr/bin/env python3
"""Tests for video_pipeline.py. Run: python3 .hermes/plugins/sdlc/test_video_pipeline.py

The end-to-end tests need ffmpeg/ffprobe. They use a fake `stt-transcribe` (no model) and a fake local
Telegram Bot API on loopback; the child environment never inherits real TELEGRAM_* settings."""
import fcntl
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import video_pipeline as vp  # noqa: E402

HAVE_FFMPEG = subprocess.run(["which", "ffmpeg"], capture_output=True).returncode == 0
WORDS = [{"word": "hello", "start": 0.5, "end": 0.9}, {"word": "um", "start": 1.5, "end": 1.8},
         {"word": "world", "start": 2.0, "end": 2.6}, {"word": "again", "start": 8.0, "end": 8.5}]


class Pure(unittest.TestCase):
    def test_parse_args(self):
        p, o = vp.parse_args("/a/b.mp4 --no-captions --lufs -14 make it pop; rm -rf /")
        self.assertEqual(p, "/a/b.mp4")
        self.assertFalse(o["captions"])
        self.assertEqual(o["lufs"], -14.0)
        self.assertTrue(o["cuts"])
        self.assertEqual(vp.parse_args("--lufs 99")[1]["lufs"], -16.0)
        self.assertIsNone(vp.parse_args("/a/b\x00.mp4")[0])
        self.assertTrue(vp.parse_args("--no-cuts")[1]["fillers"])  # independent switches
        self.assertEqual(vp.parse_args("--lang es")[1]["lang"], "es")
        self.assertIsNone(vp.parse_args("--lang es;rm")[1]["lang"])  # only an ISO code is accepted
        self.assertIsNone(vp.parse_args("--lang")[1]["lang"])

    def test_subtract(self):
        self.assertEqual(vp.subtract([[0, 10]], [(2, 3)]), [[0, 2], [3, 10]])
        self.assertEqual(vp.subtract([[0, 1]], [(0, 1)]), [])
        self.assertEqual(vp.subtract([[0, 10]], [(2, 3), (5, 6)]), [[0, 2], [3, 5], [6, 10]])
        dropped = []
        self.assertEqual(vp.subtract([[0, 10]], [(0.1, 0.4)], dropped=dropped), [[0.4, 10]])
        self.assertEqual(dropped, [(0, 0.1)])  # the lost fragment is reported, not silent

    def test_coalesce(self):
        k = [[0, 1], [1.1, 2], [5, 6], [6.2, 7]]
        out = vp.coalesce(k, 2)
        self.assertEqual(out, [[0, 2], [5, 7]])
        self.assertEqual(vp.coalesce(k, 10), k)

    def test_clean_words(self):
        raw = ["a", {"word": 1}, {"word": "x", "start": "1", "end": 2}, {"word": "ok", "start": 1.0, "end": 1.5},
               {"word": "inf", "start": 0, "end": float("inf")}, {"word": "late", "start": 99, "end": 100},
               {"word": "b", "start": True, "end": 2}]
        self.assertEqual([w["word"] for w in vp.clean_words(raw, 10)], ["ok"])
        self.assertEqual(vp.clean_words({"x": 1}, 10), [])

    def test_filler_cuts(self):
        w = [{"word": "Um,", "start": 1.0, "end": 1.3}, {"word": "hello", "start": 1.4, "end": 1.8},
             {"word": "uh", "start": 3.0, "end": 9.0}]
        self.assertEqual([x[2] for x in vp.filler_cuts(w, "en")], ["um"])
        self.assertEqual(vp.filler_cuts([{"word": "eh", "start": 0, "end": 0.2}], "es")[0][2], "eh")
        self.assertEqual(vp.filler_cuts([{"word": "eh", "start": 0, "end": 0.2}], "en"), [])

    def test_place_word_keeps_a_word_whisper_stretched_into_silence(self):
        keep = [[0, 5.554], [8.555, 13.252]]
        # real case: "The" 8.23-8.73 after a pause that ends at 8.555: midpoint is in the cut, the word is audible
        s, e = vp.place_word(8.23, 8.73, keep)
        self.assertAlmostEqual(s, 5.554)  # clamped to the start of the kept segment
        self.assertAlmostEqual(e, 5.554 + 0.175)
        self.assertIsNone(vp.place_word(6.0, 6.4, keep))      # wholly inside the cut
        self.assertIsNone(vp.place_word(6.0, 8.7, keep))      # 5% of a 2.7 s word survives: not a caption word
        self.assertIsNotNone(vp.place_word(8.0, 9.9, keep))   # 70% survives: kept

    def test_cue_times_exact(self):
        keep = [[0, 2], [5, 8]]
        words = [{"word": "hi", "start": 0.1, "end": 0.4}, {"word": "gone", "start": 3.0, "end": 3.4},
                 {"word": "{\\an8}there<b>.", "start": 5.1, "end": 5.5}]
        cues = vp.build_cues(words, keep)
        self.assertEqual(len(cues), 2)  # "hi ..." and a sentence-final word end a cue
        self.assertAlmostEqual(cues[0][0], 0.1)
        self.assertAlmostEqual(cues[0][1], 0.4)
        self.assertAlmostEqual(cues[1][0], 2.1)   # source 5.1 -> 2s kept before it + 0.1
        self.assertAlmostEqual(cues[1][1], 2.5)
        text = " ".join(c[2] for c in cues)
        for bad in ("gone", "{", "<", "\\"):
            self.assertNotIn(bad, text)

    def test_parsers(self):
        ln = vp.parse_loudnorm('noise\n{\n "input_i" : "-23.1",\n "input_tp" : "-3.0",\n "input_lra" : "5.0",\n "input_thresh" : "-33.5",\n "target_offset" : "0.4"\n}\n')
        self.assertEqual(ln["input_i"], -23.1)
        self.assertIsNone(vp.parse_loudnorm('{"input_i": "-inf", "input_tp": "-inf", "input_lra": "0", "input_thresh": "-70", "target_offset": "0"}'))
        self.assertIsNone(vp.parse_loudnorm("no json"))
        self.assertEqual(vp.parse_ebur128("x\n  Summary:\n\n  Integrated loudness:\n    I:         -16.2 LUFS\n  True peak:\n    Peak:       -1.7 dBFS\n"), (-16.2, -1.7))

    def test_tg_base_validation(self):
        self.assertEqual(vp.tg_base({}), (vp.PUBLIC_BASE, False))
        self.assertEqual(vp.tg_base({"TELEGRAM_BASE_URL": "http://127.0.0.1:8088/bot"}), ("http://127.0.0.1:8088/bot", True))
        self.assertEqual(vp.tg_base({"TELEGRAM_BASE_URL": "https://bot.example.com/bot"}), ("https://bot.example.com/bot", False))
        for bad in ("http://evil.example.com/bot", "http://127.0.0.1:8088/", "ftp://127.0.0.1/bot", 'http://127.0.0.1/bot"\nurl=x'):
            self.assertEqual(vp.tg_base({"TELEGRAM_BASE_URL": bad}), (vp.PUBLIC_BASE, False), bad)

    def test_report_degraded(self):
        info = {"w": 720, "h": 1280, "fps": "30/1"}
        edl = {"removed": [{"start": 1, "end": 2, "reason": "silence"}, {"start": 3, "end": 3.3, "reason": "filler: um"}]}
        r = vp.report("j", "Edit evidence: x", edl, "degraded", False, ["no transcript"], info)
        self.assertIn("DEGRADED", r)
        self.assertIn("filler: um", r)
        self.assertIn("captions none", r)
        self.assertIn("not human-approved", r)


def _motion():
    return vp.motion_module()


def _words(text, start, step=0.3):
    return [{"word": w, "start": start + i * step, "end": start + i * step + step * 0.9} for i, w in enumerate(text.split())]


class MotionPlanning(unittest.TestCase):
    keep = [[0.0, 100.0]]

    def sents(self):
        words = (_words("Local tools can edit your videos without any cloud service at all.", 1.0)
                 + _words("It cuts silence and filler words in about 10 seconds of work.", 14.0)
                 + _words("Captions are timed to the cuts, never to the raw transcript.", 30.0)
                 + _words("Then you publish the result anywhere you like.", 48.0))
        return _motion().sentences(words, self.keep, vp.place_word)

    def test_sentences_are_in_output_time(self):
        ss = self.sents()
        self.assertEqual(len(ss), 4)
        self.assertAlmostEqual(ss[1]["start"], 14.0)
        shifted = _motion().sentences(_words("one two three four five six.", 10.0), [[5.0, 8.0], [9.0, 20.0]], vp.place_word)
        self.assertAlmostEqual(shifted[0]["start"], 3.0 + 1.0)   # 3 s kept before the second segment, +1 s into it

    def test_heuristic_prefers_figures_and_spaces_cards_out(self):
        ss = self.sents()
        cards = _motion().heuristic_points(ss, 3)
        starts = [ss[c["sentence"]]["start"] for c in cards]
        self.assertTrue(all(b - a >= 8 for a, b in zip(starts, starts[1:])))
        stat = [c for c in cards if c["type"] == "stat"]
        self.assertEqual(stat[0]["value"], "10")           # "10 seconds" carries a figure
        self.assertTrue(all(len(c["body"]) <= 130 for c in cards))

    def test_model_reply_is_validated_not_trusted(self):
        m = _motion()
        good = '{"cards":[{"sentence":1,"type":"stat","value":"10x","body":"Fast"},{"sentence":0,"type":"keypoint","title":"Local first","body":"No cloud"}]}'
        out = m.parse_points("Sure! " + good + " hope that helps", 4, 4)
        self.assertEqual([c["sentence"] for c in out], [0, 1])             # sorted, prose around the JSON ignored
        for bad in ('{"cards":[{"sentence":9,"type":"keypoint","title":"x"}]}',            # index out of range
                    '{"cards":[{"sentence":true,"type":"keypoint","title":"x"}]}',          # bool is not an index
                    '{"cards":[{"sentence":0,"type":"rm -rf","title":"x"}]}',               # unknown type
                    '{"cards":[{"sentence":0,"type":"stat","value":"lots","title":""}]}',   # a stat needs a digit
                    '{"cards":[{"sentence":0,"type":"keypoint","title":""}]}',              # a keypoint needs a title
                    '{"cards":"nope"}', "not json", '{"cards":[1,2,3]}', "{" * 5000):
            self.assertEqual(m.parse_points(bad, 4, 4), [], bad[:40])
        hostile = '{"cards":[{"sentence":0,"type":"keypoint","title":"<b>Hi</b>{\\\\an8}\\u0000 `x`|y","body":"ok"}]}'
        t = m.parse_points(hostile, 4, 4)[0]["title"]
        for ch in "<>{}\\`|":
            self.assertNotIn(ch, t)
        self.assertEqual(len(m.parse_points('{"cards":[' + ",".join(['{"sentence":%d,"type":"keypoint","title":"t"}' % i for i in range(4)]) + ']}', 4, 2)), 2)

    def test_plan_has_no_overlap_and_respects_the_ends(self):
        m = _motion()
        ss = self.sents()
        pts = [{"sentence": i, "type": "keypoint", "title": f"T{i}", "body": "b"} for i in range(4)]
        cards = m.plan_cards(pts, ss, 56.0, {"title": "Hello", "speaker": "Ana", "role": "Eng"}, n_images=2)
        spans = sorted((c["start"], c["start"] + c["dur"]) for c in cards)
        for (a, b), (c, d) in zip(spans, spans[1:]):
            self.assertLessEqual(b + m.MIN_GAP - 1e-6, c, (a, b, c, d))
        self.assertLessEqual(max(b for _, b in spans), 56.0 - 1.2 + 1e-6)
        self.assertEqual([c["type"] for c in cards][:2], ["title", "lower"])      # intro first, then the name
        self.assertEqual(len({c["id"] for c in cards}), len(cards))
        self.assertEqual(m.max_cards(5), 0)
        self.assertGreaterEqual(m.max_cards(60), 4)

    def test_karaoke_captions(self):
        words = _words("Hello {\\an8}world <i>again</i>", 1.0, 0.4)
        ass, n = _motion().karaoke_ass(words, [[0, 20]], vp.place_word, 1080, 1920, "aurora")
        self.assertEqual(n, 1)
        self.assertIn("\\kf", ass)
        self.assertIn("PlayResX: 1080", ass)
        body = ass.split("Dialogue:")[1]
        self.assertNotIn("{\\an8}", body)        # transcript text cannot inject ASS override tags
        self.assertNotIn("<i>", body)
        self.assertEqual(body.count("{\\kf"), 3)  # the only override blocks are ours: one sweep per word
        self.assertIn("Fontname", ass)
        self.assertIn("Lato", ass)
        # words in a cut are not captioned
        ass2, _ = _motion().karaoke_ass(_words("a b c d", 5.0, 1.0), [[0, 5.2]], vp.place_word, 720, 1280, "mint")
        self.assertNotIn("d ", ass2.split("Dialogue:")[1].replace("{", " "))

    def test_compose_labels_do_not_collide_and_numbers_are_validated(self):
        m = _motion()
        edl_tools = vp.load_edl_tools()
        edl = {"source_duration": 20.0, "keep": [[0, 5], [6, 12]], "removed": []}
        base = edl_tools.build_graph(edl, True, "30/1")
        cards = [{"id": "c0", "start": 1.0}, {"id": "c1", "start": 8.0}]
        metas = {c["id"]: {"x": 8, "y": 100, "w": 600, "h": 200, "frames": 90} for c in cards}
        seg, args, last = m.compose(cards, metas, "30/1", 11.0, 720, 1280)
        import re as _re
        labels_base = set(_re.findall(r"\[([A-Za-z0-9_]+)\]", base))
        produced = set(_re.findall(r"\[([A-Za-z0-9_]+)\](?=[;,\s]|$)", seg))
        self.assertFalse((labels_base - {"vout", "aout"}) & produced)
        self.assertEqual(last, "gp")
        self.assertEqual(args.count("-i"), 4)
        self.assertIn("a_%04d.png", args[3])
        self.assertNotIn(";;", seg)

    def test_card_meta_is_validated_before_it_reaches_a_filter(self):
        m = _motion()
        with tempfile.TemporaryDirectory() as t:
            g = Path(t)
            ok = {"x": 8, "y": 100, "w": 600, "h": 200, "frames": 90}
            for case, good in (({}, True), ({"x": -1}, False), ({"w": 1081}, False), ({"h": 201}, False), ({"frames": 0}, False),
                               ({"frames": 301}, False), ({"x": "8"}, False), ({"x": True}, False), ({"x": 8.5}, False), ({"y": 1800}, False)):
                (g / "c0.json").write_text(json.dumps({**ok, **case}))
                if good:
                    self.assertEqual(m.load_meta(g, "c0", 1080, 1920)["w"], 600)
                else:
                    with self.assertRaises((ValueError, TypeError, KeyError)):
                        m.load_meta(g, "c0", 1080, 1920)

    def test_a_failing_renderer_degrades_to_plain_captions(self):
        notes = []
        words = _words("Local tools can edit your videos without any cloud service at all.", 1.0)
        info = {"w": 720, "h": 1280, "fps": "30/1"}
        with tempfile.TemporaryDirectory() as t:
            real = vp.run
            vp.run = lambda *a, **k: (_ for _ in ()).throw(vp.StageError("renderer exploded"))
            try:
                got = vp.build_motion(Path(t), {"captions": True, "theme": "aurora"}, words, "en", [[0, 30.0]], 30.0, info, notes)
            finally:
                vp.run = real
        self.assertIsNone(got)
        self.assertTrue(any("motion graphics skipped" in n and "plain captions" in n for n in notes), notes)


@unittest.skipUnless(HAVE_FFMPEG and vp.bwrap_available(), "needs ffmpeg and bubblewrap")
class Renderer(unittest.TestCase):
    """video_graphics.py, run the way the pipeline runs it: inside the sandbox, in a work dir."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.w = Path(self.td.name)
        shutil_copy(HERE / "video_graphics.py", self.w / "vg.py")

    def tearDown(self):
        self.td.cleanup()

    def render(self, plan):
        (self.w / "plan.json").write_text(json.dumps(plan))
        return vp.run(["python3", "-I", "vg.py", "plan.json"], self.w, 300)

    def test_all_card_types_render_with_a_real_glass_mask(self):
        from PIL import Image
        import numpy as np
        img = self.w / "img0.bin"
        Image.fromarray((np.random.rand(300, 500, 3) * 255).astype("uint8")).save(img, "PNG")
        cards = [{"id": "c0", "type": "keypoint", "dur": 2.0, "n": 1, "title": "Edit videos with local tools", "body": "Silence and filler words are removed."},
                 {"id": "c1", "type": "stat", "dur": 2.0, "value": "10x", "body": "faster"},
                 {"id": "c2", "type": "lower", "dur": 2.0, "title": "Ana Perez", "body": "Engineer"},
                 {"id": "c3", "type": "title", "dur": 2.0, "title": "A title", "body": "and a subtitle"},
                 {"id": "c4", "type": "image", "dur": 2.0, "img": "img0.bin", "title": "A picture"}]
        r = self.render({"W": 1080, "H": 1920, "fps": 10, "theme": "sunset", "cards": cards})
        self.assertEqual(r.returncode, 0, r.stderr.decode()[-500:])
        for c in cards:
            meta = json.loads((self.w / "g" / f"{c['id']}.json").read_text())
            self.assertEqual(meta["frames"], 20)
            self.assertTrue(0 <= meta["x"] and meta["x"] + meta["w"] <= 1080 and 0 <= meta["y"] and meta["y"] + meta["h"] <= 1920)
            first, mid = Image.open(self.w / "g" / c["id"] / "m_0000.png"), Image.open(self.w / "g" / c["id"] / "m_0010.png")
            self.assertEqual(first.mode, "L")
            self.assertEqual(mid.size, (meta["w"], meta["h"]))
            self.assertEqual(max(mid.getdata()), 255)                              # a fully opaque glass panel mid-card
            self.assertLess(max(first.getdata()), 80)                              # and it has not appeared yet at t=0
            art = Image.open(self.w / "g" / c["id"] / "a_0010.png")
            self.assertEqual(art.mode, "RGBA")
            self.assertGreater(max(art.getdata(), key=lambda p: p[3])[3], 200)     # real ink: text / rim light
            last = Image.open(self.w / "g" / c["id"] / "m_0019.png")
            self.assertLess(max(last.getdata()), 60)                               # faded out at the end

    def test_long_text_wraps_or_ellipsises_and_never_crashes(self):
        long_t = "word " * 80
        for typ in ("keypoint", "title", "stat", "lower"):
            r = self.render({"W": 720, "H": 1280, "fps": 5, "cards": [{"id": "c0", "type": typ, "dur": 1.0, "title": long_t, "body": long_t, "value": "123456789012345"}]})
            self.assertEqual(r.returncode, 0, f"{typ}: {r.stderr.decode()[-300:]}")
            meta = json.loads((self.w / "g" / "c0.json").read_text())
            self.assertTrue(meta["x"] + meta["w"] <= 720 and meta["y"] + meta["h"] <= 1280, typ)

    def test_landscape_layout_fits(self):
        r = self.render({"W": 1920, "H": 1080, "fps": 5, "cards": [{"id": "c0", "type": "keypoint", "dur": 1.0, "n": 2, "title": "Landscape", "body": "wide frame"}]})
        self.assertEqual(r.returncode, 0, r.stderr.decode()[-300:])
        meta = json.loads((self.w / "g" / "c0.json").read_text())
        self.assertLess(meta["w"], 1920 * 0.5)    # a corner card, not a full-width banner

    def test_bad_plans_are_refused(self):
        for plan in ({"W": 99999, "H": 1920, "fps": 30, "cards": []}, {"W": 1080, "H": 1920, "fps": 0, "cards": []},
                     {"W": 1080, "H": 1920, "fps": 30, "cards": [{"id": "../x", "type": "keypoint", "dur": 1}]}):
            self.assertNotEqual(self.render(plan).returncode, 0, plan)

    def test_the_renderer_runs_without_network_or_home(self):
        r = self.render({"W": 360, "H": 640, "fps": 5, "cards": [{"id": "c0", "type": "keypoint", "dur": 1.0, "title": "ok", "body": "ok"}]})
        self.assertEqual(r.returncode, 0)
        self.assertEqual({p.name for p in self.w.iterdir()} - {"vg.py", "plan.json", "g"}, set())   # wrote only inside its work dir


def shutil_copy(a, b):
    import shutil
    shutil.copyfile(a, b)


class Safety(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.p = Path(self.t.name)
        self._out = vp.OUT_DIR
        vp.OUT_DIR = self.p / "out"

    def tearDown(self):
        vp.OUT_DIR = self._out
        self.t.cleanup()

    def test_publish_copies_and_hashes(self):
        r = self.p / "render.mp4"
        r.write_bytes(b"abc" * 1000)
        size, digest = vp.publish(r, vp.OUT_DIR / "x.mp4")
        self.assertEqual(size, 3000)
        import hashlib
        self.assertEqual(digest, hashlib.sha256(b"abc" * 1000).hexdigest())
        self.assertEqual((vp.OUT_DIR / "x.mp4").stat().st_mode & 0o777, 0o600)
        self.assertTrue(r.exists())
        with self.assertRaises(FileExistsError):  # never overwrites a delivered file
            vp.publish(r, vp.OUT_DIR / "x.mp4")

    def test_publish_refuses_a_planted_symlink(self):
        target = self.p / "secret.txt"
        target.write_text("TOKEN")
        target.chmod(0o644)
        link = self.p / "render.mp4"
        link.symlink_to(target)
        with self.assertRaises(vp.StageError):
            vp.publish(link, vp.OUT_DIR / "y.mp4")
        self.assertFalse((vp.OUT_DIR / "y.mp4").exists())
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)  # not chmod-ed through the link
        fifo = self.p / "fifo.mp4"
        os.mkfifo(fifo)
        with self.assertRaises(vp.StageError):
            vp.publish(fifo, vp.OUT_DIR / "z.mp4")

    def test_put_replaces_a_planted_symlink(self):
        victim = self.p / "victim.txt"
        victim.write_text("keep me")
        link = self.p / "graph.txt"
        link.symlink_to(victim)
        vp.put(link, "new")
        self.assertEqual(victim.read_text(), "keep me")
        self.assertFalse(link.is_symlink())
        self.assertEqual(link.read_text(), "new")

    def test_drop_rejoined(self):
        removed = [{"start": 1.0, "end": 1.2, "reason": "filler: um"}, {"start": 5.0, "end": 7.0, "reason": "silence"}]
        out, n = vp.drop_rejoined(removed, [[0, 3], [8, 10]])  # the 1.0-1.2 gap was merged back into kept audio
        self.assertEqual(n, 1)
        self.assertEqual(out, [removed[1]])  # only the silence outside kept audio is still reported as cut

    def test_unit_args_and_path_validation(self):
        job = "1007-101010-abcd"
        a = vp.unit_args(job)
        self.assertEqual(a[:3], ["systemd-run", "--user", "--collect"])
        props = [a[i + 1] for i, x in enumerate(a) if x == "-p"]
        for needed in ("MemoryMax=8G", "MemorySwapMax=0", "NoNewPrivileges=yes"):
            self.assertIn(needed, props)
        self.assertTrue(any(p.startswith("ExecStopPost=") and p.endswith(f"finish {job}") for p in props))
        for banned in ("PrivateTmp", "ProtectSystem"):  # these stop bubblewrap on Ubuntu's AppArmor userns policy
            self.assertFalse(any(p.startswith(banned) for p in props))
        self.assertEqual(a[-3:], [str(Path(vp.__file__).resolve()), "run", job])
        old = vp.STATE
        try:
            vp.STATE = Path("/tmp/with space/state")
            self.assertIn("state folder", vp.unit_problem())
            vp.STATE = Path("/tmp/100%/state")
            self.assertTrue(vp.unit_problem())
            vp.STATE = old
            self.assertEqual(vp.unit_problem(), "")
        finally:
            vp.STATE = old

    def test_report_shows_review_entries_first_and_counts_the_rest(self):
        removed = [{"start": i, "end": i + 0.2, "reason": "filler: um"} for i in range(12)]
        removed.append({"start": 40, "end": 40.1, "reason": "short fragment beside a filler dropped: REVIEW, may be a real word"})
        r = vp.report("j", "ev", {"removed": removed}, "full", True, [], {"w": 1, "h": 1, "fps": "30/1"})
        self.assertIn("REVIEW", r)
        self.assertIn("+3 more", r)


@unittest.skipUnless(vp.bwrap_available() and subprocess.run(["which", "systemd-run"], capture_output=True).returncode == 0,
                     "needs bubblewrap and systemd --user")
class RealUnit(unittest.TestCase):
    def test_sandbox_works_under_the_production_unit_properties(self):
        """The bug the unit tests missed: some unit properties stop bubblewrap from starting (AppArmor userns policy)."""
        a = vp.unit_args("1007-101010-abcd")
        props = [x for i, x in enumerate(a) if i and a[i - 1] == "-p" and not x.startswith(("ExecStopPost", "StandardOutput", "StandardError"))]
        cmd = ["systemd-run", "--user", "--pipe", "--wait", "--collect", "--quiet", f"--unit=sdlc-video-test-{os.getpid()}"]
        for p in props:
            cmd += ["-p", p]
        code = f"import sys; sys.path.insert(0, {str(HERE)!r}); import video_pipeline as vp; print('BWRAP', vp.bwrap_available())"
        r = subprocess.run(cmd + [sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
        self.assertIn("BWRAP True", r.stdout, r.stdout + r.stderr)


class Handler(unittest.TestCase):
    """The /videoedit command handler: argv, fallback, queue cap, launch failure. systemd is mocked."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.t = Path(self.td.name)
        (self.t / "videos").mkdir()
        self.src = self.t / "videos" / "c.mp4"
        self.src.write_bytes(b"x")
        self.saved = {k: os.environ.get(k) for k in ("SDLC_VIDEO_STATE", "SDLC_VIDEO_OUT", "SDLC_VIDEO_ROOTS", "HERMES_HOME")}
        os.environ.update(SDLC_VIDEO_STATE=str(self.t / "state"), SDLC_VIDEO_OUT=str(self.t / "out"), SDLC_VIDEO_ROOTS=str(self.t / "videos"),
                          HERMES_HOME=str(self.t / "home"))
        self.mod = _plugin()
        self.vp = self.mod._video_module()
        self.vp.STATE, self.vp.OUT_DIR = self.t / "state", self.t / "out"
        self.vp.bwrap_available()   # probe the sandbox for real, before subprocess is mocked
        self.calls = []
        self.real_run, self.real_popen = subprocess.run, subprocess.Popen
        self.is_active = "inactive"
        self.run_raises = None
        self.popen_raises = None

        def fake_run(cmd, *a, **k):
            self.calls.append(("run", list(cmd)))
            if cmd[0] == "systemd-run":
                if self.run_raises:
                    raise self.run_raises
                return subprocess.CompletedProcess(cmd, 0, b"", b"")
            if cmd[:3] == ["systemctl", "--user", "is-active"]:
                return subprocess.CompletedProcess(cmd, 0, self.is_active + "\n", "")
            return self.real_run(cmd, *a, **k)

        def fake_popen(cmd, *a, **k):
            if "run" in cmd and any(str(x).endswith("video_pipeline.py") for x in cmd):  # a worker launch: record, do not start
                self.calls.append(("popen", list(cmd)))
                if self.popen_raises:
                    raise self.popen_raises
                return subprocess.CompletedProcess(cmd, 0)
            return self.real_popen(cmd, *a, **k)  # everything else (real subprocess.run internals) is untouched

        subprocess.run, subprocess.Popen = fake_run, fake_popen

    def tearDown(self):
        subprocess.run, subprocess.Popen = self.real_run, self.real_popen
        for k, v in self.saved.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        self.td.cleanup()

    def test_launches_the_hardened_unit(self):
        msg = self.mod.videoedit(str(self.src))
        self.assertIn("Editing", msg)
        unit = next(c for k, c in self.calls if k == "run" and c[0] == "systemd-run")
        self.assertIn("MemoryMax=8G", unit)
        self.assertEqual(unit[-2], "run")
        self.assertNotIn("popen", [k for k, _ in self.calls])
        self.assertNotIn("confidence", msg)

    def test_timeout_with_a_running_unit_does_not_start_a_second_worker(self):
        self.run_raises = subprocess.TimeoutExpired("systemd-run", 20)
        self.is_active = "active"
        self.mod.videoedit(str(self.src))
        self.assertNotIn("popen", [k for k, _ in self.calls])

    def test_fallback_when_systemd_is_missing_is_limited_and_announced(self):
        self.run_raises = OSError("no systemd")
        msg = self.mod.videoedit(str(self.src))
        pop = next(c for k, c in self.calls if k == "popen")
        if shutil_which("prlimit"):
            self.assertEqual(pop[0], "prlimit")
        self.assertIn("will not survive a gateway restart", msg)

    def test_launch_failure_leaves_no_pending_job(self):
        self.run_raises = OSError("no systemd")
        self.popen_raises = OSError("cannot fork")
        msg = self.mod.videoedit(str(self.src))
        self.assertIn("Could not start", msg)
        self.assertEqual(self.vp.pending_jobs(), 0)

    def test_queue_cap_and_bad_paths(self):
        for _ in range(self.vp.MAX_PENDING):
            self.vp.new_job(self.src, {})
        self.assertIn("already waiting", self.mod.videoedit(str(self.src)))
        self.assertEqual([c for k, c in self.calls if k == "run" and c[0] == "systemd-run"], [])
        self.vp.STATE = Path("/tmp/a b/state")
        self.assertIn("systemd cannot take", self.mod.videoedit(str(self.src)))

    def tool(self, **params):
        return json.loads(self.mod._handle_video_edit(params))

    def test_tool_builds_arguments_from_typed_fields_only(self):
        r = self.tool(path=str(self.src), captions=False, lufs=-14, language="es")
        self.assertTrue(r["success"], r)
        self.assertIn("no captions", r["message"])
        self.assertEqual([k for k, c in self.calls if k == "run" and c[0] == "systemd-run"], ["run"])
        meta = json.loads(next((self.t / "state").glob("*/job.json")).read_text())
        self.assertEqual(meta["opts"]["lufs"], -14.0)
        self.assertEqual(meta["opts"]["lang"], "es")
        self.assertFalse(meta["opts"]["captions"])
        self.assertTrue(meta["opts"]["fillers"])
        self.assertTrue(self.tool(unknown="--lang x; rm -rf /")["success"])  # unknown keys are ignored, never passed on

    def test_tool_rejects_values_that_could_smuggle_flags_or_change_the_target(self):
        bad = [{"path": f"{self.src} --no-captions"}, {"path": "foo.mp4"}, {"path": ["/x"]}, {"path": f"{self.src}\n--lang es"},
               {"language": "es --no-denoise"}, {"language": "es;rm"}, {"language": 5}, {"lufs": "-14"}, {"lufs": True},
               {"lufs": float("nan")}, {"lufs": -3}, {"fillers": "no"}, {"captions": 0}, {"denoise": None.__class__}]
        for params in bad:
            r = self.tool(**params)
            self.assertFalse(r["success"], params)
        self.assertEqual([c for k, c in self.calls if k == "run" and c[0] == "systemd-run"], [])  # nothing launched
        self.assertEqual(list((self.t / "state").glob("*/job.json")) if (self.t / "state").exists() else [], [])

    def test_tool_refuses_paths_outside_the_allowed_folders(self):
        outside = self.t / "elsewhere.mp4"
        outside.write_bytes(b"x")
        r = self.tool(path=str(outside))
        self.assertFalse(r["success"])
        self.assertIn("outside", r["message"])

    def test_tool_allows_unattended_use_but_not_other_messaging_platforms(self):
        import types
        env = {"HERMES_CRON_SESSION": "", "HERMES_SESSION_PLATFORM": "telegram"}
        fake = types.ModuleType("gateway.session_context")
        fake.get_session_env = lambda name, default="": env.get(name, default)
        fake.session_is_messaging_surface = lambda: env.get("HERMES_SESSION_PLATFORM", "") not in ("", "cli")
        pkg = types.ModuleType("gateway")
        saved = {k: sys.modules.get(k) for k in ("gateway", "gateway.session_context")}
        sys.modules["gateway"], sys.modules["gateway.session_context"] = pkg, fake
        saved_plat = os.environ.pop("HERMES_PLATFORM", None)
        try:
            self.assertTrue(self.tool(path=str(self.src))["success"])              # telegram: allowed
            env.update(HERMES_SESSION_PLATFORM="", HERMES_CRON_SESSION="1")
            self.assertTrue(self.tool(path=str(self.src), captions=False)["success"])   # unattended (cron): ALLOWED by design
            env.update(HERMES_SESSION_PLATFORM="discord", HERMES_CRON_SESSION="")
            refused = self.tool(path=str(self.src), denoise=False)
            self.assertFalse(refused["success"])                                    # another messaging platform: refused
            self.assertIn("not 'discord'", refused["message"])
            env.update(HERMES_SESSION_PLATFORM="cli")
            self.assertTrue(self.tool(path=str(self.src), fillers=False)["success"])    # the owner at the CLI: allowed
        finally:
            for k, v in saved.items():
                sys.modules.pop(k, None) if v is None else sys.modules.__setitem__(k, v)
            if saved_plat is not None:
                os.environ["HERMES_PLATFORM"] = saved_plat

    def test_duplicate_requests_and_bursts_are_limited(self):
        self.assertIn("Editing", self.mod.videoedit(str(self.src)))
        again = self.mod.videoedit(str(self.src))
        self.assertIn("already sent for editing", again)                           # same file, same options
        self.assertIn("Editing", self.mod.videoedit(f"{self.src} --no-captions"))  # different options: a new job
        # a burst of parallel calls (prompt-injected loop) cannot overshoot the queue cap
        import threading
        srcs = []
        for i in range(12):
            f = self.t / "videos" / f"b{i}.mp4"
            f.write_bytes(b"x" * (i + 1))
            srcs.append(f)
        created, refused = [], []

        def go(f):
            try:
                created.append(self.vp.admit(f, {"n": 1}))
            except self.vp.Refused as why:
                refused.append(str(why))

        threads = [threading.Thread(target=go, args=(f,)) for f in srcs]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertLessEqual(self.vp.pending_jobs(), self.vp.MAX_PENDING)
        self.assertEqual(len(created) + 2, self.vp.MAX_PENDING)   # 2 pending from above, the rest of the 5 slots
        self.assertTrue(all("already waiting" in r for r in refused), refused)

    def test_hourly_limit(self):
        for i in range(self.vp.MAX_PER_HOUR):
            j = self.vp.new_job(self.src, {"i": i})
            (self.vp.STATE / j / "done").write_text("ok")      # finished, so not pending, but still counted
        self.assertIn("in the last hour", self.mod.videoedit(str(self.src)))

    def test_tool_is_registered_with_a_schema(self):
        reg = {}

        class Ctx:
            def register_tool(self, **k): reg[k["name"]] = k
            def register_command(self, *a, **k): pass
            def register_cli_command(self, *a, **k): pass

        self.mod.register(Ctx())
        self.assertIn("video_edit", reg)
        self.assertEqual(reg["video_edit"]["toolset"], "sdlc")
        self.assertIn("Do NOT run ffmpeg", reg["video_edit"]["schema"]["description"])
        self.assertIn("ONLY when the user asks", reg["video_edit"]["schema"]["description"])
        self.assertFalse(reg["video_edit"]["schema"]["parameters"]["additionalProperties"])

    def test_refuses_without_a_sandbox(self):
        saved, self.vp._BWRAP = self.vp._BWRAP, False
        try:
            os.environ.pop("SDLC_VIDEO_ALLOW_UNSANDBOXED", None)
            self.assertIn("not parsed without a sandbox", self.mod.videoedit(str(self.src)))
        finally:
            self.vp._BWRAP = saved


def shutil_which(x):
    import shutil
    return shutil.which(x)


class Source(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = Path(self.t.name) / "videos"
        self.root.mkdir()
        os.environ["SDLC_VIDEO_ROOTS"] = str(self.root)

    def tearDown(self):
        os.environ.pop("SDLC_VIDEO_ROOTS", None)
        self.t.cleanup()

    def test_path_rules(self):
        good = self.root / "a.mp4"
        good.write_bytes(b"x")
        self.assertEqual(vp.resolve_source(str(good))[0], good.resolve())
        outside = Path(self.t.name) / "b.mp4"
        outside.write_bytes(b"x")
        self.assertIn("outside", vp.resolve_source(str(outside))[1])
        link = self.root / "l.mp4"
        link.symlink_to(outside)
        self.assertIn("symlink", vp.resolve_source(str(link))[1])
        (self.root / "n.txt").write_text("x")
        self.assertIn("unsupported", vp.resolve_source(str(self.root / "n.txt"))[1])
        self.assertIn("outside", vp.resolve_source(str(self.root / ".." / "b.mp4"))[1])
        self.assertIn("no such file", vp.resolve_source(str(self.root / "zz.mp4"))[1])
        self.assertIsNone(vp.resolve_source("/a/b\x00c.mp4")[0])  # NUL byte: a message, not an exception

    def test_newest_recent(self):
        a, b = self.root / "a.mp4", self.root / "b.mov"
        a.write_bytes(b"x")
        b.write_bytes(b"x")
        os.utime(a, (1000, 1000))
        os.utime(b, (2000, 2000))
        self.assertEqual(vp.resolve_source(None, now=2100)[0], b.resolve())
        self.assertIsNone(vp.resolve_source(None, now=2000 + vp.RECENT_SECONDS + 5)[0])
        (self.root / "l.mp4").symlink_to(a)
        os.utime(self.root / "l.mp4", (2050, 2050), follow_symlinks=False)
        self.assertEqual(vp.resolve_source(None, now=2100)[0], b.resolve())

    def test_copy_source_refuses_a_swap(self):
        job = Path(self.t.name) / "job"
        job.mkdir()
        good = self.root / "a.mp4"
        good.write_bytes(b"data")
        self.assertEqual(vp.copy_source(good, job), ("src.mp4", "mov"))
        self.assertEqual((job / "src.mp4").read_bytes(), b"data")
        secret = Path(self.t.name) / "secret.txt"
        secret.write_text("TOKEN")
        swapped = self.root / "s.mp4"
        swapped.symlink_to(secret)  # swapped in after validation
        job2 = Path(self.t.name) / "job2"
        job2.mkdir()
        with self.assertRaises(OSError):  # O_NOFOLLOW refuses the symlink
            vp.copy_source(swapped, job2)
        self.assertFalse(list(job2.iterdir()))
        with self.assertRaises(vp.StageError):
            vp.copy_source(self.root / "x.txt", job2)


class FakeTelegram:
    def __init__(self):
        self.calls = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                outer.calls.append((self.path, body))
                out = b'{"ok":true,"result":{}}'
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def log_message(self, *a):
                pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def texts(self):
        return [json.loads(b)["text"] for p, b in self.calls if p.endswith("/sendMessage")]

    def documents(self):
        return [b for p, b in self.calls if p.endswith("/sendDocument")]

    def close(self):
        self.srv.shutdown()


def _plugin():
    """The plugin package loaded the way Hermes does (by path), so its command handler can be tested."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("sdlc_plugin_under_test", HERE / "__init__.py", submodule_search_locations=[str(HERE)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules["sdlc_plugin_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg missing")
class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.t = Path(self.td.name)
        (self.t / "videos").mkdir()
        (self.t / "bin").mkdir()
        (self.t / "home").mkdir()
        self.tg = FakeTelegram()
        (self.t / "home" / ".env").write_text(f"TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_HOME_CHANNEL=42\n"
                                              f"TELEGRAM_BASE_URL=http://127.0.0.1:{self.tg.port}/bot\n")
        self.src = self.t / "videos" / "clip.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=12",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-af", "volume=enable='between(t,4,7)':volume=0",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(self.src)], check=True)
        self.stt(json.dumps({"language": "en", "words": WORDS}))

    def tearDown(self):
        self.tg.close()
        self.td.cleanup()

    def stt(self, body: str, exit_code: int = 0):
        f = self.t / "bin" / "stt-transcribe"
        f.write_text(f"#!/bin/sh\ncat <<'J'\n{body}\nJ\nexit {exit_code}\n")
        f.chmod(f.stat().st_mode | stat.S_IXUSR)

    def env(self):
        keep = {k: v for k, v in os.environ.items() if not k.startswith(("TELEGRAM_", "SDLC_", "HERMES_"))}
        return {**keep, "PATH": f"{self.t / 'bin'}:{os.environ['PATH']}", "SDLC_VIDEO_STATE": str(self.t / "state"),
                "SDLC_VIDEO_OUT": str(self.t / "out"), "SDLC_VIDEO_ROOTS": str(self.t / "videos"), "HERMES_HOME": str(self.t / "home"),
                "SDLC_VIDEO_LLM": "0",   # tests never call the real local-model proxy
                **({} if vp.bwrap_available() else {"SDLC_VIDEO_ALLOW_UNSANDBOXED": "1"})}

    def new_job(self, args: str = "", src: Path | None = None) -> str:
        code = (f"import sys; sys.path.insert(0, {str(HERE)!r}); import video_pipeline as vp; "
                f"p,o=vp.parse_args({args!r}); s,_=vp.resolve_source({str(src or self.src)!r}); print(vp.new_job(s,o))")
        r = subprocess.run([sys.executable, "-c", code], env=self.env(), capture_output=True, text=True, check=True)
        return r.stdout.strip()

    def start(self, job: str, *argv) -> subprocess.Popen:
        code = (f"import sys; sys.path.insert(0, {str(HERE)!r}); import video_pipeline as vp; "
                f"sys.exit(vp.main(['x',{(argv[0] if argv else 'run')!r},{job!r}]))")
        return subprocess.Popen([sys.executable, "-c", code], env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def run_job(self, args: str = "", src: Path | None = None):
        job = self.new_job(args, src)
        p = self.start(job)
        out = p.communicate(timeout=600)[0]
        return job, p.returncode, out

    def frame_md5(self, path, at):
        r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1", "-f", "md5", "-"],
                           capture_output=True, text=True)
        return r.stdout.strip()

    def probe(self, path):
        return json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                                         capture_output=True, text=True).stdout)

    def test_full_pipeline(self):
        job, rc, out = self.run_job()
        self.assertEqual(rc, 0, out)
        outs = list((self.t / "out").glob("*-edited.mp4"))
        self.assertEqual(len(outs), 1)
        pr = self.probe(outs[0])
        v = next(s for s in pr["streams"] if s["codec_type"] == "video")
        self.assertEqual((v["width"], v["height"]), (720, 1280))  # not downscaled, not reframed
        self.assertEqual(v["r_frame_rate"], "30/1")
        # silence 3.0 s + filler ~0.3 s removed from 12 s: ~8.7 s. Silence alone would give ~9.24.
        self.assertLess(float(pr["format"]["duration"]), 9.1)
        self.assertGreater(float(pr["format"]["duration"]), 8.0)
        jd = self.t / "state" / job
        # (e) two-pass loudness really ran and landed on target
        graph = (jd / "work" / "graph.txt").read_text()
        self.assertIn("measured_I=", graph)
        self.assertIn("linear=true", graph)
        self.assertIn("ass=cap.ass", graph)               # default: word-highlight captions
        self.assertIn("overlay=x='-w+w*t/", graph)        # and the progress bar
        lufs, _ = vp.measure(outs[0].parent, outs[0].name, "mov")
        self.assertIsNotNone(lufs)
        self.assertLess(abs(lufs - (-16.0)), 1.0)
        # captions: right words, filler gone, retimed (cue 1 starts at the first kept word, not at source 0.5 + shift)
        ass = (jd / "work" / "cap.ass").read_text()
        self.assertIn("hello", ass)
        self.assertNotIn("um ", ass.lower().replace("{\\kf", " "))
        self.assertIn("\\kf", ass)
        self.assertTrue((jd / "edl.json").is_file())
        # (h) cleanup: the big intermediates are gone, the evidence stays, the original is untouched
        self.assertEqual(list((jd / "work").glob("src.*")), [])
        self.assertFalse((jd / "work" / "audio.wav").exists())
        self.assertFalse((jd / "work" / "render.mp4").exists())
        self.assertTrue(self.src.is_file())
        self.assertEqual((jd / "done").read_text(), "ok")
        self.assertIn("Edit evidence:", (jd / "pipeline.log").read_text())
        # Telegram: a report, then the file as a document (not re-compressed) through the validated local base URL
        texts = self.tg.texts()
        self.assertTrue(any("done (full)" in x and "Edit evidence:" in x for x in texts), texts)
        docs = self.tg.documents()
        self.assertEqual(len(docs), 1)
        self.assertGreater(len(docs[0]), outs[0].stat().st_size)
        self.assertIn(b"name=\"chat_id\"", docs[0])

    def test_plain_srt_captions_with_no_graphics(self):
        job, rc, out = self.run_job("--no-graphics")
        self.assertEqual(rc, 0, out)
        jd = self.t / "state" / job / "work"
        self.assertIn("subtitles=cap.srt", (jd / "graph.txt").read_text())
        self.assertNotIn("gblur", (jd / "graph.txt").read_text())
        self.assertIn("hello", (jd / "cap.srt").read_text())

    def test_captions_are_burned_in(self):
        _, rc, out = self.run_job()
        self.assertEqual(rc, 0, out)
        _, rc, out = self.run_job("--no-captions")
        self.assertEqual(rc, 0, out)
        a, b = sorted((self.t / "out").glob("*-edited.mp4"))
        self.assertNotEqual(self.frame_md5(a, 0.8), self.frame_md5(b, 0.8))  # same cut, caption pixels differ

    def test_degraded_without_transcriber(self):
        self.stt("", exit_code=1)
        job, rc, out = self.run_job()
        self.assertEqual(rc, 0, out)
        jd = self.t / "state" / job
        self.assertFalse((jd / "work" / "cap.srt").exists())
        self.assertNotIn("subtitles", (jd / "work" / "graph.txt").read_text())
        self.assertTrue(any("DEGRADED" in x and "no transcript" in x for x in self.tg.texts()), self.tg.texts())
        self.assertEqual(len(self.tg.documents()), 1)

    def test_malformed_transcript_does_not_crash(self):
        for body in ('{"words": ["a", 1, null]}', '["not", "a", "dict"]', "not json at all"):
            self.tg.calls.clear()
            self.stt(body)
            job, rc, out = self.run_job()
            self.assertEqual(rc, 0, f"{body}: {out}")
            self.assertTrue(any("DEGRADED" in x for x in self.tg.texts()), body)

    def test_failure_is_reported(self):
        bad = self.t / "videos" / "garbage.mp4"
        bad.write_bytes(b"this is not a video" * 100)
        job, rc, out = self.run_job(src=bad)
        self.assertEqual(rc, 1)
        self.assertTrue(any("failed" in x for x in self.tg.texts()), self.tg.texts())
        jd = self.t / "state" / job
        self.assertEqual((jd / "done").read_text(), "failed")
        self.assertEqual(list((jd / "work").glob("src.*")), [])  # cleaned even on failure
        self.assertEqual(self.tg.documents(), [])

    def test_second_job_queues_behind_the_lock(self):
        job = self.new_job()
        lockf = self.t / "state" / ".lock"
        fd = os.open(lockf, os.O_WRONLY | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        p = self.start(job)
        try:
            deadline = time.time() + 30
            while time.time() < deadline and not any("queued" in x for x in self.tg.texts()):
                time.sleep(0.2)
            self.assertTrue(any("queued" in x for x in self.tg.texts()), self.tg.texts())
            self.assertIsNone(p.poll())  # still waiting
            self.assertEqual(list((self.t / "out").glob("*")) if (self.t / "out").exists() else [], [])
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        p.communicate(timeout=600)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(len(list((self.t / "out").glob("*-edited.mp4"))), 1)

    def test_finish_hook_reports_a_killed_worker_once(self):
        job = self.new_job()
        for _ in range(2):
            self.start(job, "finish").communicate(timeout=60)
        killed = [x for x in self.tg.texts() if "stopped before finishing" in x]
        self.assertEqual(len(killed), 1)
        # a worker that finished normally is never reported as killed
        job2, rc, _ = self.run_job()
        self.tg.calls.clear()
        self.start(job2, "finish").communicate(timeout=60)
        self.assertEqual(self.tg.texts(), [])

    def test_no_audio_track_is_reported(self):
        silent = self.t / "videos" / "mute.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=3", "-an",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(silent)], check=True)
        job, rc, out = self.run_job(src=silent)
        self.assertEqual(rc, 1)
        self.assertTrue(any("no audio track" in x for x in self.tg.texts()), self.tg.texts())

    def test_all_silent_audio_is_reported(self):
        quiet = self.t / "videos" / "quiet.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=4",
                        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(quiet)], check=True)
        job, rc, out = self.run_job(src=quiet)
        self.assertEqual(rc, 1)
        self.assertTrue(any("failed" in x for x in self.tg.texts()), self.tg.texts())
        self.assertEqual((self.t / "state" / job / "done").read_text(), "failed")

    def long_words(self):
        return (_words("Local tools can edit your videos without any cloud service at all.", 0.4, 0.22)
                + _words("Captions are timed to the cuts and never to the raw transcript.", 8.0, 0.2))

    def test_motion_graphics_end_to_end(self):
        self.stt(json.dumps({"language": "en", "language_probability": 0.99, "words": self.long_words()}))
        job, rc, out = self.run_job()
        self.assertEqual(rc, 0, out)
        jd = self.t / "state" / job / "work"
        graph = (jd / "graph.txt").read_text()
        for needle in ("gblur=sigma=", "alphamerge", "ass=cap.ass", "g/c0/a_%04d.png" if False else "overlay="):
            self.assertIn(needle, graph)
        plan = json.loads((jd / "plan.json").read_text())
        self.assertEqual(plan["cards"][0]["type"], "keypoint")
        self.assertFalse((jd / "g").exists())                        # the PNG frames are removed after the render
        self.assertFalse((jd / "vg.py").exists())
        report = [x for x in self.tg.texts() if "done (" in x][0]
        self.assertIn("graphics: 1 keypoint", report)
        self.assertIn("simple fallback", report)                      # SDLC_VIDEO_LLM=0: no model, deterministic fallback
        # the glass is really in the picture: compare with the same edit without graphics
        outs = sorted((self.t / "out").glob("*-edited.mp4"))
        _, rc2, out2 = self.run_job("--no-graphics --no-captions --no-progress")
        self.assertEqual(rc2, 0, out2)
        a, b = sorted((self.t / "out").glob("*-edited.mp4"), key=lambda p: p.stat().st_mtime)[-2:]
        card_t = plan["cards"][0]["start"] + 1.2
        meta_h = 0.10 * 1280
        crop = f"crop=720:{int(meta_h) + 200}:0:0"
        d = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{card_t}", "-i", str(a), "-ss", f"{card_t}", "-i", str(b),
                            "-filter_complex", f"[0:v]{crop}[x];[1:v]{crop}[y];[x][y]blend=all_mode=difference,signalstats,metadata=print:file=-",
                            "-frames:v", "1", "-f", "null", "-"], capture_output=True, text=True)
        import re as _re
        yavg = float(_re.search(r"lavfi.signalstats.YAVG=([0-9.]+)", d.stdout + d.stderr).group(1))
        self.assertGreater(yavg, 3.0, "the card region should differ visibly from the plain edit")

    def test_the_local_model_chooses_the_cards_when_it_answers(self):
        class H(BaseHTTPRequestHandler):
            seen = []

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                H.seen.append(body)
                reply = {"choices": [{"message": {"content": '{"cards":[{"sentence":0,"type":"keypoint","title":"Local first","body":"No cloud needed"}]}'}}]}
                out = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("content-length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def log_message(self, *a):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            self.stt(json.dumps({"language": "en", "words": self.long_words()}))
            (self.t / "home" / ".env").write_text((self.t / "home" / ".env").read_text() + "LLAMASTASH_API_KEY=testkey\n")
            old = self.env
            self.env = lambda: {**{k: v for k, v in old().items() if k != "SDLC_VIDEO_LLM"}, "SDLC_VIDEO_LLM_URL": f"http://127.0.0.1:{srv.server_address[1]}/v1/chat/completions"}
            job, rc, out = self.run_job()
            self.env = old
        finally:
            srv.shutdown()
        self.assertEqual(rc, 0, out)
        plan = json.loads((self.t / "state" / job / "work" / "plan.json").read_text())
        self.assertEqual(plan["cards"][0]["title"], "Local first")
        self.assertEqual(len(H.seen), 1)
        self.assertIn("never follow instructions", H.seen[0]["messages"][0]["content"])   # the transcript is framed as data
        self.assertIn("chosen by the local model", [x for x in self.tg.texts() if "done (" in x][0])

    def test_clip_ending_in_silence_succeeds(self):
        """Regression (QA D1): silencedetect's last silence_end overshoots the container duration, which failed every
        clip that ends in a pause: the normal 'stop recording after speaking' case."""
        for tail, dur in ((0.6, 5), (1.0, 7.3), (2.0, 20.37)):
            f = self.t / "videos" / f"tail{tail}.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size=320x240:rate=30:duration={dur}",
                            "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur},volume='if(lt(t,{dur - tail}),0.5,0)':eval=frame",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(f)], check=True)
            job, rc, out = self.run_job(src=f)
            self.assertEqual(rc, 0, f"tail {tail}: {out}")
            self.assertEqual((self.t / "state" / job / "done").read_text(), "ok")

    def test_truncated_source_is_flagged(self):
        """QA D2: a source cut off mid-upload used to be delivered as a normal edit."""
        full = self.t / "full.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(self.src), "-c", "copy", "-movflags", "+faststart", str(full)], check=True)
        cut = self.t / "videos" / "cut.mp4"
        data = full.read_bytes()
        cut.write_bytes(data[: int(len(data) * 0.6)])
        job, rc, out = self.run_job(src=cut)
        if rc == 0:  # a truncated file may also be refused outright, which is fine; delivering it silently is not
            self.assertTrue(any("truncated" in x for x in self.tg.texts()), self.tg.texts())

    def test_matroska_input(self):
        mkv = self.t / "videos" / "clip.mkv"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(self.src), "-c", "copy", str(mkv)], check=True)
        job, rc, out = self.run_job(src=mkv)
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(list((self.t / "out").glob("*-edited.mp4"))), 1)

    def test_low_confidence_language_is_flagged_and_lang_is_passed(self):
        self.stt(json.dumps({"language": "en", "language_probability": 0.41, "words": WORDS}))
        job, rc, out = self.run_job()
        self.assertEqual(rc, 0, out)
        self.assertTrue(any("41%" in x and "--lang" in x for x in self.tg.texts()), self.tg.texts())
        # with an explicit language the warning is not shown, and the code reaches stt-transcribe
        self.tg.calls.clear()
        f = self.t / "bin" / "stt-transcribe"
        f.write_text('#!/bin/sh\necho "$@" > args.txt\ncat <<\'J\'\n' + json.dumps({"language": "es", "language_probability": 0.4, "words": WORDS}) + "\nJ\n")
        f.chmod(f.stat().st_mode | stat.S_IXUSR)
        job2, rc, out = self.run_job("--lang es")
        self.assertEqual(rc, 0, out)
        self.assertFalse(any("confidence" in x for x in self.tg.texts()), self.tg.texts())
        self.assertIn("--language es", (self.t / "state" / job2 / "work" / "args.txt").read_text())

    def test_finish_hook_cleans_up_a_killed_job(self):
        job = self.new_job()
        w = self.t / "state" / job / "work"
        w.mkdir()
        (w / "src.mp4").write_bytes(b"x" * 1000)
        (w / "audio.wav").write_bytes(b"x")
        self.start(job, "finish").communicate(timeout=60)
        self.assertEqual(list(w.iterdir()), [])

    def test_token_is_not_in_child_environment(self):
        self.assertNotIn("TELEGRAM_BOT_TOKEN", vp.child_env())
        os.environ["TELEGRAM_BOT_TOKEN"] = "x"
        try:
            self.assertNotIn("TELEGRAM_BOT_TOKEN", vp.child_env())
        finally:
            os.environ.pop("TELEGRAM_BOT_TOKEN")


@unittest.skipUnless(HAVE_FFMPEG and vp.bwrap_available(), "bubblewrap unavailable")
class Sandbox(unittest.TestCase):
    """The media-parsing sandbox must actually confine: secrets unreadable, no network, only the job dir writable."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.job = Path(self.td.name) / "job"
        self.job.mkdir()
        self.home_secret = Path.home() / f".sdlc-sandbox-test-{os.getpid()}"
        self.home_secret.write_text("TOKEN")
        self.tg = FakeTelegram()

    def tearDown(self):
        self.home_secret.unlink(missing_ok=True)
        self.tg.close()
        self.td.cleanup()

    def sb(self, cmd):
        return subprocess.run(vp.sandboxed(cmd, self.job), capture_output=True, text=True, timeout=30)

    def test_home_is_hidden_but_visible_outside(self):
        self.assertEqual(subprocess.run(["cat", str(self.home_secret)], capture_output=True, text=True).stdout, "TOKEN")  # control
        r = self.sb(["cat", str(self.home_secret)])
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("TOKEN", r.stdout)

    def test_no_network(self):
        url = f"http://127.0.0.1:{self.tg.port}/bot"
        self.assertEqual(subprocess.run(["curl", "-sS", "-m", "5", "-X", "POST", url], capture_output=True).returncode, 0)  # control
        self.assertNotEqual(self.sb(["curl", "-sS", "-m", "3", "-X", "POST", url]).returncode, 0)

    def test_only_the_job_dir_is_writable(self):
        self.assertEqual(self.sb(["sh", "-c", "echo hi > out.txt"]).returncode, 0)
        self.assertEqual((self.job / "out.txt").read_text().strip(), "hi")
        with tempfile.TemporaryDirectory(dir="/var/tmp") as other:  # user-writable, outside the job dir
            self.assertEqual(subprocess.run(["sh", "-c", f"echo x > {other}/c"]).returncode, 0)  # control: writable outside
            self.assertNotEqual(self.sb(["sh", "-c", f"echo x > {other}/x"]).returncode, 0)  # read-only, not just hidden
            for target in (f"{other}/x", str(Path.home() / "sdlc-test"), "/dev/shm/sdlc-test"):
                self.sb(["sh", "-c", f"echo x > {target}"])  # a private tmpfs may accept it; the host must never see it
                self.assertFalse(Path(target).exists(), target)

    def test_only_an_allowlist_of_the_host_is_visible(self):
        """Not `--ro-bind / /`: readable secrets outside /home (e.g. /opt, /etc, /var) must not exist inside."""
        for path in ("/etc/passwd", "/var/tmp", "/var/lib", "/var/log", "/opt", "/srv", "/mnt", "/root", "/home"):
            if Path(path).exists():
                r = self.sb(["ls", path])
                self.assertNotEqual(r.returncode, 0, f"{path} is visible inside the sandbox")
        self.assertEqual(self.sb(["ls", "/usr/bin/ffmpeg"]).returncode, 0)  # the tools themselves are

    def test_ffmpeg_still_works_inside(self):
        r = vp.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-ar", "16000", "x.wav"], self.job, 60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.job / "x.wav").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
