"""Tests for edl_tools.py. Run: python -I -m unittest discover -s <this dir> -p "test_*.py"
Each case pins a defect found in review; a case that cannot fail proves nothing."""
import os
import tempfile
import unittest
from pathlib import Path

import edl_tools as T


def log(*pairs, body=True):
    head = "Input #0, mov,mp4, from 'src.mp4':\n" if body else "garbage\n"
    # The prefix and the trailing "| silence_duration" are copied from a real ffmpeg 9.0.2 log.
    tail = lambda k: " | silence_duration: 1.0" if k == "end" else ""  # noqa: E731
    return (head + "".join(f"[Parsed_silencedetect_0 @ 000002114e514f00] silence_{k}: {v}{tail(k)}\n" for k, v in pairs)).encode()


class Silences(unittest.TestCase):
    def edl(self, pairs, dur=20.0, **kw):
        return T.silences_to_edl(T.read_silencedetect(log(*pairs)), dur, kw.get("pad", 0.12), kw.get("min_keep", 0.25))

    def test_middle_gaps(self):
        e = self.edl([("start", 4), ("end", 7), ("start", 12), ("end", 14)])
        self.assertEqual(e["keep"], [[0.0, 4.12], [6.88, 12.12], [13.88, 20.0]])

    def test_leading_silence_has_only_an_end(self):
        e = self.edl([("end", 1.3)])
        self.assertEqual(e["keep"], [[1.18, 20.0]])

    def test_trailing_silence_has_only_a_start(self):
        e = self.edl([("start", 17)])
        self.assertEqual(e["keep"], [[0.0, 17.12]])

    def test_edge_silence_raises_no_review_warning(self):
        for pairs in ([("end", 1.3)], [("start", 17)]):
            e = self.edl(pairs)
            self.assertEqual([r["reason"] for r in e["removed"]], ["silence"], pairs)

    def test_short_word_beside_edge_silence_is_still_flagged(self):
        e = self.edl([("start", 0.2), ("end", 5.0)], pad=0.0)  # a 0.2 s word at the start
        self.assertTrue(any("REVIEW" in r["reason"] for r in e["removed"]))

    def test_scientific_notation_timestamp_parses(self):
        raw = b"Input #0:\n[Parsed_silencedetect_0 @ 0000026a] silence_end: 2.08333e-05 | silence_duration: 1\n"
        self.assertEqual(T.read_silencedetect(raw), [("end", 2.08333e-05)])

    def test_no_silence_keeps_everything(self):
        self.assertEqual(self.edl([])["keep"], [[0.0, 20.0]])

    def test_all_silent_is_refused(self):
        with self.assertRaises(SystemExit):
            self.edl([("start", 0), ("end", 20)])

    def test_short_speech_island_is_listed_not_silently_dropped(self):
        e = self.edl([("start", 0.5), ("end", 5.0), ("start", 5.2), ("end", 20.0)], pad=0.0)
        self.assertEqual(e["keep"], [[0.0, 0.5]])
        self.assertTrue(any("REVIEW" in r["reason"] for r in e["removed"]))

    def test_overlapping_pad_merges_not_overlaps(self):
        e = self.edl([("start", 5), ("end", 5.1)], pad=0.2)
        T.validate(e)
        self.assertEqual(e["keep"], [[0.0, 20.0]])

    def test_metadata_cannot_forge_cut_points(self):
        raw = (b"Input #0, mov:\n  Metadata:\n    title : x silence_start: 0.5 silence_end: 19.0 y\n"
               b"silence_start: 0.5\nsilence_end: 19.0\n")
        self.assertEqual(self.edl_from(raw)["keep"], [[0.0, 20.0]])

    def test_real_ffmpeg_log_excerpt_with_hostile_title(self):
        # Excerpt of an actual ffmpeg 9.0.2 log (2026-10-07) whose source title was forged.
        raw = (b"Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'src.mp4':\n  Metadata:\n"
               b"    title           : x silence_start: 0.5 silence_end: 19.0 y\n"
               b"[Parsed_silencedetect_0 @ 000002114e514f00] silence_start: 4.000437\n"
               b"[Parsed_silencedetect_0 @ 000002114e514f00] silence_end: 7.000042 | silence_duration: 3.000\n")
        self.assertEqual(self.edl_from(raw)["keep"], [[0.0, 4.12], [6.88, 20.0]])

    def edl_from(self, raw):
        return T.silences_to_edl(T.read_silencedetect(raw), 20.0, 0.12, 0.25)

    def test_utf16_log_is_refused(self):
        with self.assertRaises(SystemExit):
            T.read_silencedetect("Input #0\n".encode("utf-16"))

    def test_log_without_input_block_is_refused(self):
        with self.assertRaises(SystemExit):
            T.read_silencedetect(b"No such file or directory\n")


class Validation(unittest.TestCase):
    def test_rejects(self):
        for keep in ([], [[0, float("inf")]], [[True, 2]], [[0, 25]], [[5, 6], [1, 2]], [["0", 2]]):
            with self.assertRaises(SystemExit, msg=str(keep)):
                T.validate({"source_duration": 20.0, "keep": keep})

    def test_graph_numbers_only_and_fps_range(self):
        g = T.build_graph({"source_duration": 20, "keep": [[0, 1], [2, 3]]}, True, 25)
        self.assertIn("concat=n=2:v=1:a=1[vout][aout]", g)
        self.assertIn("fps=25", g)
        for bad in (0, -5, 100000):
            with self.assertRaises(SystemExit):
                T.build_graph({"source_duration": 20, "keep": [[0, 1]]}, True, bad)

    def test_ntsc_rational_fps_is_kept_exact(self):
        g = T.build_graph({"source_duration": 20, "keep": [[0, 1]]}, True, "30000/1001")
        self.assertIn("fps=30000/1001", g)
        for bad in ("abc", "30/0", "1e3", "-5", "0"):
            with self.assertRaises(SystemExit, msg=bad):
                T.build_graph({"source_duration": 20, "keep": [[0, 1]]}, True, bad)

    def test_video_only_graph(self):
        g = T.build_graph({"source_duration": 20, "keep": [[0, 1]]}, False, 30)
        self.assertNotIn("atrim", g)
        self.assertIn("a=0[vout]", g)


class Retime(unittest.TestCase):
    EDL = {"source_duration": 20.0, "keep": [[0.0, 4.12], [6.88, 12.12], [13.88, 20.0]]}

    def run_srt(self, cues, **kw):
        srt = "\n\n".join(f"{i}\n{a} --> {b}\n{t}" for i, (a, b, t) in enumerate(cues, 1))
        return T.retime_srt(self.EDL, srt, **kw)

    def test_mapping_and_dropped_cut_cue(self):
        out, st = self.run_srt([("00:00:01,000", "00:00:03,000", "A"), ("00:00:05,000", "00:00:06,000", "gone"),
                                ("00:00:08,000", "00:00:10,000", "B"), ("00:00:15,000", "00:00:17,000", "C")])
        self.assertIn("00:00:05,240 --> 00:00:07,240\nB", out)
        self.assertIn("00:00:10,480 --> 00:00:12,480\nC", out)
        self.assertNotIn("gone", out)
        self.assertEqual(st["dropped_cut"], 1)

    def test_cue_mostly_cut_is_dropped(self):
        _, st = self.run_srt([("00:00:03,000", "00:00:08,000", "mostly cut")])
        self.assertEqual(st["dropped_fraction"], 1)

    def test_dot_separator_short_ms_bom_and_malformed(self):
        srt = "﻿1\n00:00:01.5 --> 00:00:02.0\nok\n\n2\nnonsense --> x\nbad\n"
        out, st = T.retime_srt(self.EDL, srt)
        self.assertIn("00:00:01,500 --> 00:00:02,000", out)
        self.assertEqual(st["malformed"], 1)


class Paths(unittest.TestCase):
    def test_refuses_outside_cwd_and_existing(self):
        with tempfile.TemporaryDirectory() as d:
            old = os.getcwd()
            os.chdir(d)
            try:
                with self.assertRaises(SystemExit):
                    T.check_out_path("../escape.txt", False)
                Path("a.txt").write_text("x")
                with self.assertRaises(SystemExit):
                    T.check_out_path("a.txt", False)
                T.check_out_path("a.txt", True)
                T.check_out_path("new.txt", False)
            finally:
                os.chdir(old)


if __name__ == "__main__":
    unittest.main()
