#!/usr/bin/env python3
"""Generate one PNG with Qwen-Image-2.1 through stable-diffusion.cpp.

    python generate.py --prompt-file prompt.txt --out mockups/settings.png

Machine-specific paths come from the environment, set once by a human, so a
calling agent only ever supplies the prompt and the output path. That is a
separation of concerns, not a security boundary: whoever controls the command
line can also set the environment.

    SD_CPP_BIN                  path to sd-cli (stable-diffusion.cpp)
    QWEN_IMAGE_DIFFUSION_MODEL  qwen_image_2.1 diffusion weights (.gguf or .safetensors)
    QWEN_IMAGE_LLM              Qwen3-VL-8B-Instruct text encoder (.gguf)
    QWEN_IMAGE_VAE              qwen_image_2.1 VAE (.safetensors)

The output path must resolve inside the current working directory and end in
`.png`. An existing file is not overwritten without --force. Success means a
PNG was measured on disk: the last line is `OK <path> <width>x<height>`, and
anything else exits nonzero.

Standard library only.
"""

from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ENV_VARS = {
    "bin": "SD_CPP_BIN",
    "diffusion_model": "QWEN_IMAGE_DIFFUSION_MODEL",
    "llm": "QWEN_IMAGE_LLM",
    "vae": "QWEN_IMAGE_VAE",
}
MIN_SIDE, MAX_SIDE, SIDE_STEP = 256, 2048, 16
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class UsageError(Exception):
    """A problem the caller can fix; reported without a traceback."""


def read_png_size(path: Path) -> tuple[int, int]:
    """Return (width, height) from the IHDR chunk, or raise UsageError."""
    with path.open("rb") as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != PNG_SIGNATURE or head[12:16] != b"IHDR":
        raise UsageError(f"{path} is not a PNG")
    return struct.unpack(">II", head[16:24])


def resolve_config(env: dict[str, str], platform: str = sys.platform) -> dict[str, str]:
    missing = [v for v in ENV_VARS.values() if not env.get(v)]
    if missing:
        raise UsageError("not configured, set: " + ", ".join(missing)
                         + " (see SKILL.md for the files to download)")
    cfg = {k: env[v] for k, v in ENV_VARS.items()}
    absent = [f"{ENV_VARS[k]}={p}" for k, p in cfg.items() if not Path(p).is_file()]
    if absent:
        raise UsageError("configured path does not exist: " + ", ".join(absent))
    # On Windows, CreateProcess hands a .bat/.cmd to cmd.exe, which re-parses the
    # whole command line, so `&`, `|` and `%VAR%` in the prompt would become
    # shell syntax despite the argv list. Only a real executable keeps it inert.
    if platform == "win32" and Path(cfg["bin"]).suffix.lower() != ".exe":
        raise UsageError(f"SD_CPP_BIN must be an .exe on Windows, got {cfg['bin']}")
    return cfg


def resolve_output(out: str, cwd: Path, force: bool) -> Path:
    target = (cwd / out).resolve()
    root = cwd.resolve()
    if target != root and root not in target.parents:
        raise UsageError(f"--out must be inside the working directory {root}: {target}")
    if target.suffix.lower() != ".png":
        raise UsageError(f"--out must end in .png: {target}")
    if target.exists() and not force:
        raise UsageError(f"{target} exists, pass --force to overwrite")
    return target


def check_side(name: str, value: int) -> int:
    if not MIN_SIDE <= value <= MAX_SIDE or value % SIDE_STEP:
        raise UsageError(f"--{name} must be a multiple of {SIDE_STEP} "
                         f"between {MIN_SIDE} and {MAX_SIDE}, got {value}")
    return value


def build_argv(cfg: dict[str, str], args: argparse.Namespace, out: Path,
               lora_dir: Path) -> list[str]:
    # Flags follow stable-diffusion.cpp's docs/qwen_image_2.1.md. An argv list,
    # never a shell string: the prompt is untrusted text.
    argv = [
        cfg["bin"],
        "--diffusion-model", cfg["diffusion_model"],
        "--vae", cfg["vae"],
        "--llm", cfg["llm"],
        "-p", args.prompt,
        "--cfg-scale", str(args.cfg_scale),
        "--sampling-method", "euler",
        "-W", str(args.width),
        "-H", str(args.height),
        "--steps", str(args.steps),
        "-s", str(args.seed),
        "--offload-to-cpu",
        "--fa",
        "--lora-model-dir", str(lora_dir),
        "-o", str(out),
    ]
    return argv


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--prompt")
    src.add_argument("--prompt-file", help="UTF-8 file holding the prompt, relative to the working directory;"
                     " use it when the prompt came from untrusted text, so no shell ever parses it")
    p.add_argument("--out", required=True, help="PNG path inside the working directory")
    p.add_argument("--width", type=int, default=1024)
    p.add_argument("--height", type=int, default=1024)
    p.add_argument("--steps", type=int, default=20)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--cfg-scale", type=float, default=6.0)
    p.add_argument("--timeout", type=int, default=None,
                   help="seconds; default none, CPU offload is slow")
    p.add_argument("--force", action="store_true", help="overwrite an existing --out")
    return p.parse_args(argv)


def read_prompt(args: argparse.Namespace, cwd: Path) -> str:
    if (args.prompt is None) == (args.prompt_file is None):
        raise UsageError("give exactly one of --prompt or --prompt-file")
    if args.prompt_file is not None:
        try:
            prompt = (cwd / args.prompt_file).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            raise UsageError(f"could not read --prompt-file: {e}")
    else:
        prompt = args.prompt
    prompt = prompt.strip()
    if not prompt:
        raise UsageError("the prompt is empty")
    if chr(0) in prompt:
        raise UsageError("the prompt contains a NUL byte")
    return prompt


def main(argv: list[str] | None = None, env: dict[str, str] | None = None,
         cwd: Path | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    env = dict(os.environ) if env is None else env
    cwd = Path.cwd() if cwd is None else cwd
    try:
        args.prompt = read_prompt(args, cwd)
        if args.steps < 1:
            raise UsageError("--steps must be at least 1")
        check_side("width", args.width)
        check_side("height", args.height)
        cfg = resolve_config(env)
        target = resolve_output(args.out, cwd, args.force)
        # sd-cli's -o takes printf-style %d specifiers, and the scratch file sits
        # in --out's directory. Checked before mkdir so a refusal leaves nothing.
        if "%" in str(target.parent):
            raise UsageError(f"the output directory path contains '%', which sd-cli -o would treat as a format: {target.parent}")
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise UsageError(f"cannot create {target.parent}: {e}")

        # Render inside a private scratch directory beside the target, measure
        # the result, then move it into place, so a failed or partial run never
        # leaves a file at --out. A directory from mkdtemp, not a freed mkstemp
        # name: an unlinked name can be pre-planted as a symlink. The empty
        # lora/ directory stops a `<lora:name:1>` tag in the prompt from making
        # sd-cli load weight files out of the working directory, its default.
        work = Path(tempfile.mkdtemp(prefix=".gen-", dir=target.parent))
        try:
            tmp = work / "out.png"
            lora_dir = work / "lora"
            lora_dir.mkdir()
            try:
                proc = subprocess.run(build_argv(cfg, args, tmp, lora_dir), timeout=args.timeout)
            except subprocess.TimeoutExpired:
                raise UsageError(f"sd-cli did not finish within {args.timeout}s")
            except (OSError, ValueError) as e:
                raise UsageError(f"could not start {cfg['bin']}: {e}")
            if proc.returncode != 0:
                raise UsageError(f"sd-cli exited {proc.returncode}")
            if not tmp.is_file():
                raise UsageError("sd-cli exited 0 but wrote no image")
            width, height = read_png_size(tmp)
            if (width, height) != (args.width, args.height):
                raise UsageError(f"asked for {args.width}x{args.height}, got {width}x{height}")
            # Re-check containment immediately before the move: a directory in
            # the path could have been swapped for a link while sd-cli ran.
            resolve_output(args.out, cwd, force=True)
            if target.exists() and not args.force:
                raise UsageError(f"{target} appeared during generation, not overwriting")
            try:
                os.replace(tmp, target)
            except OSError as e:
                raise UsageError(f"could not move the image to {target}: {e}")
        finally:
            shutil.rmtree(work, ignore_errors=True)
    except UsageError as e:
        print(f"ERROR {e}", file=sys.stderr)
        return 2
    print(f"OK {target} {width}x{height}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
