"""Tests for prototype_pipeline.vet_copy, the copy that decides what the /idea pipeline publishes.
WORK_BASE (the agent-writable prototypes folder) is a temporary directory.

    python3 -m unittest test_vet_copy.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
MODULE = Path(os.environ.get("VET_COPY_MODULE") or HERE / "prototype_pipeline.py")  # lets a run target another copy


def _load():
    spec = importlib.util.spec_from_file_location("prototype_pipeline_under_test", MODULE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class VetCopy(unittest.TestCase):
    def setUp(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        self.tmp = Path(td.name)
        self.p = _load()
        self.work = self.tmp / "prototypes"
        self.site = self.work / "idea" / "site"
        self.site.mkdir(parents=True)
        (self.site / "index.html").write_text("<h1>hi</h1>")
        self.dst = self.tmp / "state" / "public"
        self.dst.parent.mkdir()
        pt = mock.patch.object(self.p, "WORK_BASE", self.work)
        pt.start()
        self.addCleanup(pt.stop)
        self.outside = self.tmp / "outside"
        self.outside.mkdir()
        (self.outside / "creds.json").write_text("secret")

    def copy(self):
        return self.p.vet_copy(self.site, self.dst)

    def leaked(self) -> bool:
        return any(p.name == "creds.json" for p in self.dst.rglob("*")) if self.dst.exists() else False

    def test_copies_a_plain_tree(self):
        (self.site / "css").mkdir()
        (self.site / "css" / "a.css").write_text("body{}")
        self.assertEqual(sorted(self.copy()), ["css/a.css", "index.html"])
        self.assertEqual((self.dst / "css" / "a.css").read_text(), "body{}")

    def test_fix_round_replaces_the_served_copy(self):
        self.copy()
        (self.site / "index.html").write_text("<h1>v2</h1>")
        (self.dst / "stale.html").write_text("old")
        self.copy()
        self.assertEqual((self.dst / "index.html").read_text(), "<h1>v2</h1>")
        self.assertFalse((self.dst / "stale.html").exists())

    def test_symlinks_hard_links_and_fifos_are_refused(self):
        cases = {
            "file symlink": lambda: (self.site / "x").symlink_to(self.outside / "creds.json"),
            "dir symlink": lambda: (self.site / "x").symlink_to(self.outside),
            "hard link": lambda: os.link(self.site / "index.html", self.site / "x"),
            "fifo": lambda: os.mkfifo(self.site / "x"),
        }
        for label, make in cases.items():
            with self.subTest(label):
                make()
                with self.assertRaises(self.p.StepError):
                    self.copy()
                self.assertFalse(self.leaked())
                os.unlink(self.site / "x")

    def test_symlinked_site_or_project_is_refused(self):
        real = self.tmp / "elsewhere" / "site"
        real.mkdir(parents=True)
        (real / "index.html").write_text("x")
        (self.work / "linked").symlink_to(real.parent)
        with self.assertRaises(self.p.StepError):
            self.p.vet_copy(self.work / "linked" / "site", self.dst)
        (self.work / "idea2").mkdir()
        (self.work / "idea2" / "site").symlink_to(real)
        with self.assertRaises(self.p.StepError):
            self.p.vet_copy(self.work / "idea2" / "site", self.dst)

    def test_directory_swapped_for_symlink_mid_copy_is_refused(self):
        """The race: the scan sees 'a' as a directory, then the sandbox swaps it for a symlink to
        somewhere outside before the copy descends into it. Made deterministic by having every
        stat of 'a' (os.stat by name, or a scandir entry's stat) report the directory it was."""
        (self.site / "a").symlink_to(self.outside)
        dir_stat = os.stat(self.outside)
        real_stat, real_scandir = os.stat, os.scandir

        def stat_by_name(path, *a, **kw):
            return dir_stat if os.path.basename(str(path)) == "a" else real_stat(path, *a, **kw)

        class Entry:
            def __init__(self, entry):
                self._entry, self.name, self.path = entry, entry.name, entry.path

            def stat(self, *a, **kw):
                return dir_stat if self.name == "a" else self._entry.stat(*a, **kw)

            def __getattr__(self, key):
                return getattr(self._entry, key)

        class Scan:
            def __init__(self, *a):
                self._it = real_scandir(*a)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self._it.close()

            def __iter__(self):
                return (Entry(e) for e in self._it)

        with mock.patch.object(self.p.os, "stat", stat_by_name), mock.patch.object(self.p.os, "scandir", Scan):
            try:
                self.copy()
                refused = ""
            except self.p.StepError as ex:
                refused = str(ex)
        self.assertFalse(self.leaked(), "a file from outside site/ was copied into the published folder")
        self.assertIn("changed while it was being copied", refused)

    def test_file_growing_during_copy_is_refused(self):
        """Growth injected right after the file is opened, a point both the old and the new code pass:
        the published copy must never exceed MAX_BYTES, however the file changes underneath."""
        big = self.site / "big.bin"
        big.write_bytes(b"x" * 1000)
        real_open = os.open

        def open_then_grow(path, flags, *a, **kw):
            fd = real_open(path, flags, *a, **kw)
            if os.path.basename(str(path)) == "big.bin":
                with open(big, "ab") as fh:
                    fh.write(b"y" * 5000)
            return fd
        with mock.patch.object(self.p.os, "open", open_then_grow), mock.patch.object(self.p, "MAX_BYTES", 2000):
            try:
                self.copy()
                refused = ""
            except self.p.StepError as ex:
                refused = str(ex)
        copied = self.dst / "big.bin"
        self.assertFalse(copied.exists() and copied.stat().st_size > 2000, "more than MAX_BYTES was copied")
        self.assertRegex(refused, "larger than|grew while it was being copied")

    def test_growth_after_fstat_is_refused(self):
        big = self.site / "big.bin"
        big.write_bytes(b"x" * 1000)
        real_fstat = os.fstat

        def fstat_then_grow(fd):
            st = real_fstat(fd)
            if os.readlink(f"/proc/self/fd/{fd}").endswith("big.bin"):
                with open(big, "ab") as fh:
                    fh.write(b"y" * 5000)
            return st
        with mock.patch.object(self.p.os, "fstat", fstat_then_grow):
            with self.assertRaisesRegex(self.p.StepError, "grew while"):
                self.copy()
        copied = self.dst / "big.bin"
        self.assertFalse(copied.exists() and copied.stat().st_size > 1000)

    def test_no_fd_leaks_on_error_paths(self):
        def open_fds() -> int:
            return len(os.listdir("/proc/self/fd"))
        for i in range(30):
            (self.site / f"d{i}").mkdir()
        os.link(self.site / "index.html", self.site / "d29" / "hard.html")
        before = open_fds()
        with self.assertRaises(self.p.StepError):
            self.copy()
        self.assertEqual(open_fds(), before)

    def test_size_and_count_limits(self):
        (self.site / "b.html").write_text("b")
        with mock.patch.object(self.p, "MAX_FILES", 2):
            self.assertEqual(len(self.copy()), 2)  # exactly at the limit passes
        with mock.patch.object(self.p, "MAX_FILES", 1):
            with self.assertRaisesRegex(self.p.StepError, "larger than"):
                self.copy()
        size = sum(p.stat().st_size for p in self.site.iterdir())
        with mock.patch.object(self.p, "MAX_BYTES", size):
            self.copy()
        with mock.patch.object(self.p, "MAX_BYTES", size - 1):
            with self.assertRaisesRegex(self.p.StepError, "larger than"):
                self.copy()

    def test_src_outside_prototypes_is_refused(self):
        (self.outside / "index.html").write_text("x")
        with self.assertRaisesRegex(self.p.StepError, "not inside the prototypes folder"):
            self.p.vet_copy(self.outside, self.dst)

    def test_missing_index_is_refused(self):
        (self.site / "index.html").unlink()
        (self.site / "other.html").write_text("x")
        with self.assertRaisesRegex(self.p.StepError, "index.html"):
            self.copy()


class WriteIntoWork(unittest.TestCase):
    """Host-made screenshots go into the agent-writable WORK/<slug>/.review without following symlinks."""

    def setUp(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        self.tmp = Path(td.name)
        self.p = _load()
        self.work_base = self.tmp / "prototypes"
        self.work = self.work_base / "idea"
        self.work.mkdir(parents=True)
        pt = mock.patch.object(self.p, "WORK_BASE", self.work_base)
        pt.start()
        self.addCleanup(pt.stop)
        self.victim = self.tmp / "victim.yml"
        self.victim.write_text("tunnel config")

    def write(self):
        self.p.write_into_work(self.work, ".review", "mobile.png", b"PNG")

    def test_plain_write_creates_the_folder(self):
        self.write()
        self.assertEqual((self.work / ".review" / "mobile.png").read_bytes(), b"PNG")
        self.write()  # overwriting its own file works
        self.assertEqual((self.work / ".review" / "mobile.png").read_bytes(), b"PNG")

    def test_symlinked_file_is_replaced_not_written_through(self):
        (self.work / ".review").mkdir()
        (self.work / ".review" / "mobile.png").symlink_to(self.victim)
        self.write()
        self.assertEqual(self.victim.read_text(), "tunnel config")
        self.assertFalse((self.work / ".review" / "mobile.png").is_symlink())

    def test_symlinked_review_folder_is_replaced_not_written_through(self):
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "mobile.png").symlink_to(self.victim)
        (self.work / ".review").symlink_to(elsewhere)
        self.write()
        self.assertEqual(self.victim.read_text(), "tunnel config")
        self.assertFalse((elsewhere / "mobile.png").resolve() != self.victim)  # the planted link is untouched
        self.assertTrue((self.work / ".review").is_dir() and not (self.work / ".review").is_symlink())

    def test_link_replanted_after_unlink_is_not_followed(self):
        (self.work / ".review").mkdir()
        (self.work / ".review" / "mobile.png").symlink_to(self.victim)
        with mock.patch.object(self.p.os, "unlink", lambda *a, **kw: None):  # the agent re-plants it at once
            with self.assertRaisesRegex(self.p.StepError, "changed while it was being written"):
                self.write()
        self.assertEqual(self.victim.read_text(), "tunnel config")

    def test_symlinked_project_is_refused(self):
        real = self.tmp / "realproj"
        real.mkdir()
        (self.work_base / "linked").symlink_to(real)
        with self.assertRaises(self.p.StepError):
            self.p.write_into_work(self.work_base / "linked", ".review", "mobile.png", b"PNG")
        self.assertFalse((real / ".review").exists())

    def test_old_pattern_would_have_written_through(self):
        """Documents the bug being fixed: mkdir(exist_ok=True) + write_bytes follows the planted link."""
        (self.work / ".review").mkdir()
        (self.work / ".review" / "x.png").symlink_to(self.victim)
        (self.work / ".review" / "x.png").write_bytes(b"PNG")
        self.assertEqual(self.victim.read_bytes(), b"PNG")


if __name__ == "__main__":
    unittest.main()
