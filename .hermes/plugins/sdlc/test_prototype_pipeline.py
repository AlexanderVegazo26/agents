#!/usr/bin/env python3
"""The /idea pipeline's publishing boundary, tested on real files and a real server.

    python .hermes/plugins/sdlc/test_prototype_pipeline.py   # exit 0 on pass, 1 on fail

prototype_pipeline.py serves pages an agent wrote, on a public tunnel. What
keeps anything else on the host from being served is a handful of small
functions: vet_copy (only regular, single-link files reach public/),
read_untrusted (no links, no FIFOs, bounded), write_state (never follows a
link), and Handler (no listings, nothing outside the root, the CSP headers).
These tests pin those contracts. They never dispatch an agent, open a tunnel
or send a message, and every path is a temp dir.

No pytest: the standard library only, like the other suites in this repo.
"""

from __future__ import annotations

import http.client
import http.server
import importlib.util
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

# No __pycache__ beside the plugin (the live Hermes plugin dir is this tree).
sys.dont_write_bytecode = True

_TMP = tempfile.TemporaryDirectory(prefix="proto-pipeline-test-")
# Module-level paths come from these; point them away from the real home first.
os.environ["HERMES_HOME"] = str(Path(_TMP.name) / "hermes")
os.environ["SDLC_PROTOTYPES_DIR"] = str(Path(_TMP.name) / "work")
os.environ["SDLC_PROTOTYPES_STATE"] = str(Path(_TMP.name) / "state")

_spec = importlib.util.spec_from_file_location(
    "prototype_pipeline", Path(__file__).resolve().parent / "prototype_pipeline.py")
pp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pp)


class TempCase(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory(prefix="proto-case-")
        self.root = Path(self._td.name)
        self.src = self.root / "site"
        self.dst = self.root / "public"
        self.src.mkdir()
        self.secret = self.root / "host-secret.txt"
        self.secret.write_text("HOST SECRET")

    def tearDown(self) -> None:
        self._td.cleanup()

    def write(self, rel: str, text: str = "x") -> Path:
        p = self.src / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return p

    def assertRefused(self, fragment: str) -> None:
        with self.assertRaises(pp.StepError, msg=f"vet_copy should refuse ({fragment!r})") as cm:
            pp.vet_copy(self.src, self.dst)
        self.assertIn(fragment, str(cm.exception),
                      f"StepError should name {fragment!r}; got {str(cm.exception)!r}")
        published = [str(p) for p in self.dst.rglob("*")] if self.dst.exists() else []
        self.assertFalse(any("SECRET" in Path(p).read_text(errors="replace")
                             for p in published if Path(p).is_file()),
                         f"the host secret reached public/: {published}")


class VetCopyTest(TempCase):
    def test_copies_nested_regular_files_byte_for_byte(self) -> None:
        self.write("index.html", "<h1>hi</h1>")
        self.write("css/app.css", "body{}")
        self.write("js/lib/a.js", "1")
        copied = pp.vet_copy(self.src, self.dst)
        self.assertEqual(sorted(copied), ["css/app.css", "index.html", "js/lib/a.js"],
                         f"returned paths should be relative to site/; got {copied}")
        for rel in copied:
            self.assertEqual((self.dst / rel).read_bytes(), (self.src / rel).read_bytes(),
                             f"public/{rel} differs from site/{rel}")

    def test_refuses_a_symlink_to_a_host_file(self) -> None:
        self.write("index.html")
        (self.src / "leak.txt").symlink_to(self.secret)
        self.assertRefused("site/leak.txt is a symlink")

    def test_refuses_a_symlinked_directory(self) -> None:
        self.write("index.html")
        (self.src / "assets").symlink_to(self.root, target_is_directory=True)
        self.assertRefused("site/assets is a symlink")

    def test_refuses_a_hard_link_to_a_host_file(self) -> None:
        self.write("index.html")
        os.link(self.secret, self.src / "data.txt")
        self.assertRefused("site/data.txt is a symlink, hard link")

    def test_refuses_a_fifo_without_blocking(self) -> None:
        self.write("index.html")
        os.mkfifo(self.src / "pipe")
        self.assertRefused("site/pipe is a symlink, hard link or special file")

    def test_refuses_site_when_it_is_itself_a_symlink(self) -> None:
        real = self.root / "elsewhere"
        real.mkdir()
        (real / "index.html").write_text("x")
        self.src.rmdir()
        self.src.symlink_to(real, target_is_directory=True)
        self.assertRefused("not a plain directory")

    def test_refuses_a_missing_site(self) -> None:
        self.src.rmdir()
        with self.assertRaises((pp.StepError, FileNotFoundError),
                               msg="a missing site/ must not publish anything"):
            pp.vet_copy(self.src, self.dst)

    def test_requires_index_html_at_the_top(self) -> None:
        self.write("sub/index.html")
        self.assertRefused("no site/index.html")

    def test_caps_the_number_of_files(self) -> None:
        self.write("index.html")
        for i in range(3):
            self.write(f"f{i}.txt")
        with mock.patch.object(pp, "MAX_FILES", 3):
            self.assertRefused("larger than 3 files")

    def test_caps_the_total_size(self) -> None:
        self.write("index.html", "a" * 60)
        self.write("big.bin", "b" * 60)
        with mock.patch.object(pp, "MAX_BYTES", 100):
            self.assertRefused("is larger than")

    def test_a_fix_round_replaces_the_served_copy_wholesale(self) -> None:
        self.write("index.html", "v1")
        self.write("old.js", "stale")
        pp.vet_copy(self.src, self.dst)
        (self.src / "old.js").unlink()
        self.write("index.html", "v2")
        copied = pp.vet_copy(self.src, self.dst)
        self.assertEqual(copied, ["index.html"], f"second round copied {copied}")
        self.assertFalse((self.dst / "old.js").exists(), "a file removed from site/ is still served")
        self.assertEqual((self.dst / "index.html").read_text(), "v2")


class UntrustedFileTest(TempCase):
    def test_reads_a_regular_file_up_to_the_limit(self) -> None:
        p = self.write("PROTOTYPE.md", "abcdef")
        self.assertEqual(pp.read_untrusted(p, limit=4), "abcd")

    def test_returns_empty_for_a_symlink(self) -> None:
        link = self.src / "PROTOTYPE.md"
        link.symlink_to(self.secret)
        self.assertEqual(pp.read_untrusted(link), "",
                         "read_untrusted followed a symlink out of WORK")

    def test_returns_empty_for_a_fifo_without_blocking(self) -> None:
        fifo = self.src / "PROTOTYPE.md"
        os.mkfifo(fifo)
        result: list[str] = []
        t = threading.Thread(target=lambda: result.append(pp.read_untrusted(fifo)), daemon=True)
        t.start()
        t.join(5)
        self.assertFalse(t.is_alive(), "read_untrusted blocked on a FIFO (no writer)")
        self.assertEqual(result, [""])

    def test_returns_empty_for_a_directory_in_place_of_the_file(self) -> None:
        (self.src / "PROTOTYPE.md").mkdir()
        self.assertEqual(pp.read_untrusted(self.src / "PROTOTYPE.md"), "",
                         "a directory named PROTOTYPE.md should read as empty, not raise")

    def test_returns_empty_for_a_missing_file(self) -> None:
        self.assertEqual(pp.read_untrusted(self.src / "nope.md"), "")

    def test_write_state_refuses_to_follow_a_symlink(self) -> None:
        link = self.root / "serve.json"
        link.symlink_to(self.secret)
        with self.assertRaises(OSError, msg="write_state followed a symlink"):
            pp.write_state(link, "overwritten")
        self.assertEqual(self.secret.read_text(), "HOST SECRET")

    def test_write_state_creates_owner_only_files(self) -> None:
        p = self.root / "IDEA.md"
        old = os.umask(0)
        try:
            pp.write_state(p, "idea")
        finally:
            os.umask(old)
        self.assertEqual(p.stat().st_mode & 0o777, 0o600, f"mode {oct(p.stat().st_mode & 0o777)}")


class HandlerTest(TempCase):
    def setUp(self) -> None:
        super().setUp()
        self.dst.mkdir()
        (self.dst / "index.html").write_text("<p>page</p>")
        (self.dst / "sub").mkdir()
        (self.dst / "sub" / "a.txt").write_text("in root")
        handler = lambda *a, **kw: pp.Handler(*a, directory=str(self.dst), **kw)  # noqa: E731
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()
        self.stderr = mock.patch.object(sys, "stderr", new=open(os.devnull, "w"))
        self.stderr.start()

    def tearDown(self) -> None:
        self.srv.shutdown()
        self.srv.server_close()
        sys.stderr.close()
        self.stderr.stop()
        super().tearDown()

    def get(self, path: str) -> tuple[int, dict, bytes]:
        c = http.client.HTTPConnection("127.0.0.1", self.srv.server_address[1], timeout=5)
        try:
            c.request("GET", path)
            r = c.getresponse()
            return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
        finally:
            c.close()

    def test_serves_the_page_with_the_lockdown_headers(self) -> None:
        status, headers, body = self.get("/")
        self.assertEqual((status, body), (200, b"<p>page</p>"), f"GET / -> {status} {body[:80]!r}")
        self.assertEqual(headers.get("content-security-policy"), pp.CSP)
        for directive in ("connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'",
                          "base-uri 'none'", "form-action 'self'"):
            self.assertIn(directive, pp.CSP, f"CSP lost {directive!r}")
        self.assertEqual(headers.get("referrer-policy"), "no-referrer")
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(headers.get("cache-control"), "no-store")

    def test_never_lists_a_directory(self) -> None:
        status, headers, body = self.get("/sub/")
        self.assertEqual(status, 404, f"GET /sub/ -> {status} {body[:120]!r}")
        self.assertNotIn(b"a.txt", body, "the directory listing leaked a file name")
        self.assertEqual(headers.get("content-security-policy"), pp.CSP, "error pages need the CSP too")

    def test_does_not_serve_through_a_link_planted_after_vetting(self) -> None:
        (self.dst / "leak.txt").symlink_to(self.secret)
        (self.dst / "up").symlink_to(self.root, target_is_directory=True)
        for path in ("/leak.txt", "/up/host-secret.txt"):
            status, _, body = self.get(path)
            self.assertNotIn(b"HOST SECRET", body, f"GET {path} served a file outside public/")
            self.assertEqual(status, 404, f"GET {path} -> {status}")

    def test_dot_dot_paths_stay_inside_the_root(self) -> None:
        for path in ("/../host-secret.txt", "/sub/../../host-secret.txt", "/%2e%2e/host-secret.txt"):
            status, _, body = self.get(path)
            self.assertNotIn(b"HOST SECRET", body, f"GET {path} escaped public/")


class TextHelpersTest(unittest.TestCase):
    def test_esc_escapes_html_and_drops_control_characters(self) -> None:
        self.assertEqual(pp.esc(" <b>a&b</b>\x00\x1b[31m\n "), "&lt;b&gt;a&amp;b&lt;/b&gt;[31m")

    def test_esc_keeps_newlines_and_tabs(self) -> None:
        self.assertEqual(pp.esc("a\nb\tc"), "a\nb\tc")

    def test_esc_truncates_to_the_limit_with_an_ellipsis(self) -> None:
        out = pp.esc("x" * 50, limit=10)
        self.assertEqual(out, "x" * 9 + "…", f"got {out!r}")

    def test_esc_truncates_before_escaping(self) -> None:
        # The limit counts source characters, so an escape is never cut in half.
        out = pp.esc("&" * 20, limit=5)
        self.assertEqual(out, "&amp;" * 4 + "…", f"got {out!r}")

    def test_json_object_finds_the_first_object_in_prose(self) -> None:
        text = 'Sure! {not json} here it is: {"title": "x", "n": {"a": 1}} trailing }'
        self.assertEqual(pp._json_object(text), {"title": "x", "n": {"a": 1}})

    def test_json_object_returns_none_without_an_object(self) -> None:
        for text in ("", "no braces", "[1, 2]", "{broken", '"{"'):
            self.assertIsNone(pp._json_object(text), f"_json_object({text!r}) should be None")

    def test_slug_pattern_rejects_path_tricks(self) -> None:
        for bad in ("../x", "a/b", ".hidden", "-x", "A", "a" * 82, "", "a b", "a\n"):
            self.assertIsNone(pp.SLUG_RE.match(bad),
                              f"slug {bad!r} should be rejected")
        self.assertTrue(pp.SLUG_RE.fullmatch("todo-app-1109-070000"))

    def test_new_slug_is_valid_and_unique(self) -> None:
        with tempfile.TemporaryDirectory() as td, mock.patch.object(pp, "STATE_BASE", Path(td)), \
                mock.patch.object(pp.time, "strftime", return_value="1109-070000"):
            a = pp._new_slug("A To-Do app: with ../../etc/passwd & émojis!")
            b = pp._new_slug("A To-Do app: with ../../etc/passwd & émojis!")
            c = pp._new_slug("!!!")
        self.assertEqual(a, "a-to-do-app-with-1109-070000")
        self.assertEqual(b, a + "-1", "a second idea with the same title must get its own dir")
        self.assertEqual(c, "idea-1109-070000")
        for s in (a, b, c):
            self.assertTrue(pp.SLUG_RE.match(s), f"generated slug {s!r} fails SLUG_RE")


if __name__ == "__main__":
    try:
        result = unittest.main(exit=False, verbosity=1).result
    finally:
        _TMP.cleanup()
    sys.exit(0 if result.wasSuccessful() else 1)
