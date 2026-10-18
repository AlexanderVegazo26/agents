"""Tests for watch_video.py. Network is never touched: urlopen is replaced by a fake that records requests.
Run: python3 -I .hermes/plugins/watch_video/test_watch_video.py"""
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import watch_video as wv  # noqa: E402

KEY = "AIzaSECRETKEY123"
OK = {"candidates": [{"content": {"parts": [{"text": "0:00 hook: a face. 0:02 cut."}]}}]}


class FakeResp:
    def __init__(self, body=b"{}", headers=None):
        self._b, self.headers = body, headers or {}

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass


class Net:
    """Scripted urlopen: a list of responses or exceptions, consumed in order; every request is kept."""

    def __init__(self, *script):
        self.script, self.calls = list(script), []

    def __call__(self, req, timeout=None):
        self.calls.append(req)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def http_error(code, msg="nope"):
    return urllib.error.HTTPError("https://x", code, "err", {}, io.BytesIO(json.dumps({"error": {"message": msg}}).encode()))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        p = mock.patch.object(wv, "DEFAULT_ROOTS", [self.root])
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)
        e = mock.patch.dict(os.environ, {"GEMINI_API_KEY": KEY})
        e.start()
        self.addCleanup(e.stop)

    def video(self, name="a.mp4", size=100):
        p = self.root / name
        p.write_bytes(b"\0" * size)
        return str(p)


class YouTubeIds(unittest.TestCase):
    def test_accepts_the_common_shapes_and_drops_tracking(self):
        for u, want in [
            ("https://youtu.be/VVWiJm0sA7Y?si=_JSlSwhzt_xHhZFn", "VVWiJm0sA7Y"),
            ("https://www.youtube.com/watch?v=VVWiJm0sA7Y&t=3", "VVWiJm0sA7Y"),
            ("https://m.youtube.com/shorts/VVWiJm0sA7Y", "VVWiJm0sA7Y"),
            ("http://youtube.com/embed/VVWiJm0sA7Y", "VVWiJm0sA7Y"),
        ]:
            self.assertEqual(wv.youtube_id(u), want, u)

    def test_rejects_lookalikes_and_other_hosts(self):
        for u in ["https://youtube.com.evil.com/watch?v=VVWiJm0sA7Y", "https://evil.com/watch?v=VVWiJm0sA7Y",
                  "https://user:pw@www.youtube.com/watch?v=VVWiJm0sA7Y", "https://www.youtube.com/watch?v=short",
                  "https://www.youtube.com/watch?v=VVWiJm0sA7Y%0A&x", "file:///etc/passwd", "ftp://youtu.be/VVWiJm0sA7Y",
                  "https://www.youtube.com/playlist?list=PLabcdefghijk", ""]:
            self.assertIsNone(wv.youtube_id(u), u)


class Clip(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(wv.parse_clip("0:00-0:05"), (0, 5))
        self.assertEqual(wv.parse_clip("1:02:03-1:02:10"), (3723, 3730))
        self.assertIsNone(wv.parse_clip(None))

    def test_bad(self):
        for c in ["5", "0:05-0:01", "a-b", "0:00-0:05;rm", "-1:00-2:00"]:
            with self.assertRaises(wv.Problem, msg=c):
                wv.parse_clip(c)

    def test_fps_bounds(self):
        self.assertEqual(wv.check_fps("8"), 8.0)
        for f in [0, 25, "x", None, float("nan")]:
            with self.assertRaises(wv.Problem, msg=str(f)):
                wv.check_fps(f)


class LocalFiles(Base):
    def test_outside_root_refused(self):
        with tempfile.TemporaryDirectory() as other:
            p = Path(other) / "a.mp4"
            p.write_bytes(b"x")
            with self.assertRaisesRegex(wv.Problem, "outside"):
                wv.open_local(str(p))

    def test_symlink_escape_refused(self):
        with tempfile.TemporaryDirectory() as other:
            t = Path(other) / "secret.mp4"
            t.write_bytes(b"x")
            link = self.root / "l.mp4"
            link.symlink_to(t)
            with self.assertRaisesRegex(wv.Problem, "outside"):
                wv.open_local(str(link))

    def test_dotdot_escape_refused(self):
        with self.assertRaises(wv.Problem):
            wv.open_local(str(self.root / ".." / "etc" / "passwd"))

    def test_extension_and_fifo_and_empty(self):
        (self.root / "n.txt").write_bytes(b"x")
        with self.assertRaisesRegex(wv.Problem, "unsupported"):
            wv.open_local(str(self.root / "n.txt"))
        os.mkfifo(self.root / "f.mp4")
        with self.assertRaisesRegex(wv.Problem, "regular"):
            wv.open_local(str(self.root / "f.mp4"))
        with self.assertRaisesRegex(wv.Problem, "empty"):
            wv.open_local(self.video("e.mp4", 0))

    def test_good_file(self):
        fd, mime, size = wv.open_local(self.video(size=10))
        os.close(fd)
        self.assertEqual((mime, size), ("video/mp4", 10))


class Watch(Base):
    def run_watch(self, net, source, **kw):
        with mock.patch("urllib.request.urlopen", net), mock.patch.object(wv.time, "sleep"):
            return wv.watch(source, **kw)

    def test_youtube_sends_canonical_uri_and_fps_clip(self):
        net = Net(FakeResp(json.dumps(OK).encode()))
        out = self.run_watch(net, "https://youtu.be/VVWiJm0sA7Y?si=track", clip="0:00-0:05", fps=8)
        self.assertTrue(out["success"])
        self.assertIn("hook", out["report"])
        req = net.calls[0]
        self.assertTrue(req.full_url.startswith(wv.HOST + "/v1beta/models/gemini-flash-latest:generateContent"))
        self.assertEqual(req.get_header("X-goog-api-key"), KEY)
        self.assertNotIn(KEY, req.full_url)
        body = json.loads(req.data)
        part = body["contents"][0]["parts"][0]
        self.assertEqual(part["fileData"]["fileUri"], "https://www.youtube.com/watch?v=VVWiJm0sA7Y")
        self.assertEqual(part["videoMetadata"], {"fps": 8.0, "startOffset": "0s", "endOffset": "5s"})
        self.assertIn("DATA", body["systemInstruction"]["parts"][0]["text"])

    def test_question_replaces_the_report_prompt(self):
        net = Net(FakeResp(json.dumps(OK).encode()))
        self.run_watch(net, "https://youtu.be/VVWiJm0sA7Y", prompt="How many cuts?")
        self.assertEqual(json.loads(net.calls[0].data)["contents"][0]["parts"][1]["text"], "How many cuts?")

    def test_small_local_file_goes_inline(self):
        net = Net(FakeResp(json.dumps(OK).encode()))
        out = self.run_watch(net, self.video(size=50))
        self.assertEqual(out["source"], "file")
        part = json.loads(net.calls[0].data)["contents"][0]["parts"][0]
        self.assertEqual(part["inlineData"]["mimeType"], "video/mp4")
        self.assertEqual(len(net.calls), 1)

    def test_large_local_file_uses_files_api_and_deletes_it(self):
        with mock.patch.object(wv, "INLINE_MAX", 10):
            net = Net(
                FakeResp(headers={"X-Goog-Upload-URL": wv.HOST + "/upload/v1beta/files?upload_id=1"}),
                FakeResp(json.dumps({"file": {"name": "files/abc-1", "uri": wv.HOST + "/v1beta/files/abc-1",
                                              "state": "PROCESSING"}}).encode()),
                FakeResp(json.dumps({"name": "files/abc-1", "uri": wv.HOST + "/v1beta/files/abc-1",
                                     "state": "ACTIVE"}).encode()),
                FakeResp(json.dumps(OK).encode()),
                FakeResp(b"{}"),
            )
            out = self.run_watch(net, self.video(size=50))
        self.assertTrue(out["success"])
        self.assertEqual([c.get_method() for c in net.calls], ["POST", "POST", "GET", "POST", "DELETE"])
        gen = json.loads(net.calls[3].data)["contents"][0]["parts"][0]
        self.assertEqual(gen["fileData"]["mimeType"], "video/mp4")

    def test_upload_url_on_another_host_is_refused_and_nothing_sent_there(self):
        with mock.patch.object(wv, "INLINE_MAX", 10):
            net = Net(FakeResp(headers={"X-Goog-Upload-URL": "https://evil.example/up"}))
            with self.assertRaisesRegex(wv.Problem, "valid upload address"):
                self.run_watch(net, self.video(size=50))
        self.assertEqual(len(net.calls), 1)

    def test_other_urls_and_missing_scheme_paths_refused(self):
        for s in ["https://example.com/v.mp4", "file:///etc/passwd", "ftp://x/y.mp4"]:
            with self.assertRaisesRegex(wv.Problem, "only public YouTube"):
                wv.watch(s)

    def test_http_error_is_scrubbed_of_the_key(self):
        net = Net(http_error(400, f"bad key {KEY}"))
        with self.assertRaises(wv.Problem) as cm:
            self.run_watch(net, "https://youtu.be/VVWiJm0sA7Y")
        self.assertNotIn(KEY, str(cm.exception))
        self.assertIn("HTTP 400", str(cm.exception))

    def test_404_falls_back_once_to_the_older_model(self):
        net = Net(http_error(404), FakeResp(json.dumps(OK).encode()))
        out = self.run_watch(net, "https://youtu.be/VVWiJm0sA7Y")
        self.assertEqual(out["model"], wv.FALLBACK_MODEL)
        net = Net(http_error(404))
        with self.assertRaises(wv.Problem):
            self.run_watch(net, "https://youtu.be/VVWiJm0sA7Y", model="gemini-x")

    def test_blocked_or_empty_answer(self):
        net = Net(FakeResp(json.dumps({"promptFeedback": {"blockReason": "SAFETY"}}).encode()))
        with self.assertRaisesRegex(wv.Problem, "blocked: SAFETY"):
            self.run_watch(net, "https://youtu.be/VVWiJm0sA7Y")

    def test_model_name_cannot_inject_a_path(self):
        with self.assertRaisesRegex(wv.Problem, "model name"):
            wv.generate("../files/x", {}, KEY)

    def test_missing_key(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(wv, "HERMES_HOME", self.root):
            with self.assertRaisesRegex(wv.Problem, "no Gemini API key"):
                wv.api_key()

    def test_key_read_from_dotenv_only_for_the_two_names(self):
        (self.root / ".env").write_text("OTHER=zzz\n# GEMINI_API_KEY=commented\nGOOGLE_API_KEY='kk123'\n")
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(wv, "HERMES_HOME", self.root):
            self.assertEqual(wv.api_key(), "kk123")

    def test_long_prompt_refused(self):
        with self.assertRaisesRegex(wv.Problem, "too long"):
            wv.watch("https://youtu.be/VVWiJm0sA7Y", prompt="x" * 5000)


class Handler(unittest.TestCase):
    def test_handler_refuses_without_session_context(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("wv_plugin", Path(__file__).with_name("__init__.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = json.loads(mod._handle({"source": "https://youtu.be/VVWiJm0sA7Y"}))
        self.assertFalse(out["success"])
        self.assertIn("session context", out["message"])
        with mock.patch.object(mod, "_caller_problem", return_value=""):
            for bad in [{"source": "--help"}, {"source": ""}, {"source": "x", "fps": True}, {"source": "x", "clip": ""}]:
                self.assertFalse(json.loads(mod._handle(bad))["success"], bad)
        self.assertEqual(mod.SCHEMA["name"], "watch_video")
        self.assertFalse(mod.SCHEMA["parameters"]["additionalProperties"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
