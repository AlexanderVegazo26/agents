#!/usr/bin/env python3
"""/videoedit: edit a recorded video on the HOST, no LLM in the loop.

Why a pipeline and not the `video-editor` agent: under Hermes the agent's shell is a docker
sandbox with no host ffmpeg, no host transcriber and a flaky network, and every step is a model
decision. Here each stage is deterministic code, the source is copied and validated first, and the
job is detached so a gateway restart cannot kill it.

    video_pipeline.py run <job>       worker (started by the /videoedit command)
    video_pipeline.py finish <job>    ExecStopPost hook: tells the user if the worker died without reporting

Stages (all state under ~/.local/state/sdlc-video/<job>/, host-only, mode 700; the sandboxed ffmpeg can only
write <job>/work/, and nothing in it is trusted afterwards):
  1. copy the source into the job dir under a generated name (never the user's file name), through
     an O_NOFOLLOW descriptor whose real path is re-checked, before the job waits in the queue
  2. ffprobe, extract 16 kHz mono audio, silencedetect
  3. transcribe with `stt-transcribe` (local faster-whisper); without it: silence cuts only, no captions
  4. EDL = silence cuts minus filler words (um/uh/...), validated by edl_tools
  5. captions built from word timestamps, retimed through the EDL (never from the un-cut transcript)
  6. ONE re-encode: cut + denoise + two-pass loudnorm + burned captions, source size/fps/orientation kept
  7. measure the output (ffprobe + ebur128), publish to ~/Videos/hermes-out, report to Telegram and
     send the file as a *document* so Telegram does not re-compress it

Trust model: footage, its transcript and its file name are untrusted. ffmpeg is always run with an
argument list (no shell), inside bubblewrap (read-only fs, no $HOME, no network), `-protocol_whitelist file`, a forced input format, `-enable_drefs 0` (no
external MOV data references), `-nostdin`, the job dir as cwd, a minimal environment (no bot token) and
only generated relative names in filter options. The original is never modified. Input is read from a
file, not a pipe, because MP4s with the index at the end need seeking.
"""
from __future__ import annotations

import fcntl
import hashlib
import importlib.util
import json
import logging
import math
import os
import re
import secrets
import shutil
import stat as statmod
import subprocess
import sys
import tempfile
import time
from pathlib import Path

log = logging.getLogger("sdlc-video")

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
HOME = Path.home()
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or HOME / ".hermes")
STATE = Path(os.environ.get("SDLC_VIDEO_STATE") or HOME / ".local" / "state" / "sdlc-video")
OUT_DIR = Path(os.environ.get("SDLC_VIDEO_OUT") or HOME / "Videos" / "hermes-out")
# Where a Telegram upload lands (gateway cache) or the user drops a file. Nothing else is accepted.
DEFAULT_ROOTS = [HERMES_HOME / "cache" / "videos", HERMES_HOME / "cache" / "documents", HOME / "Videos" / "hermes-inbox"]
RECENT_SECONDS = 30 * 60
EXT_FMT = {".mp4": "mov", ".m4v": "mov", ".mov": "mov", ".mkv": "matroska", ".webm": "matroska"}
MAX_BYTES = 4 << 30
MAX_SECONDS = 4 * 3600
MAX_PIXELS = 16_600_000          # 2x 4K
MAX_SEGMENTS = 300               # filter-graph nodes grow with cuts; merge the closest beyond this
MAX_PENDING = 5
MAX_PER_HOUR = 12
DUPLICATE_WINDOW = 15 * 60
KEEP_DAYS = 7
FILLERS = {"en": {"um", "umm", "uh", "uhh", "uhm", "er", "erm"}, "es": {"eh", "em", "ehm", "mmm", "hmm"}}
MAX_AUDIO_BYTES = 600 << 20     # 16 kHz mono s16 is 32 KB/s: 4 h is ~460 MB, so a container that lies about its length is cut off
MAX_RENDER_BYTES = 8 << 30
OUT_KEEP_DAYS = 30
UNIT_SAFE = re.compile(r"[A-Za-z0-9_./:\-]+")   # what may go into a systemd property or argument unescaped
PUBLIC_DOC_LIMIT = 50 << 20
LOCAL_DOC_LIMIT = 2000 << 20
CHILD_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
                  "XDG_CACHE_HOME", "XDG_DATA_HOME", "LLAMASTASH_CONFIG")
SAFE = re.compile(r"[A-Za-z0-9@_:/.\-+%]+")


def roots() -> list[Path]:
    raw = os.environ.get("SDLC_VIDEO_ROOTS")
    return [Path(p) for p in raw.split(":") if p] if raw else DEFAULT_ROOTS


def _allowed() -> list[Path]:
    out = []
    for r in roots():
        try:
            out.append(r.resolve())
        except OSError:
            pass
    return out


def under_roots(p: Path) -> bool:
    return any(p == r or r in p.parents for r in _allowed())


def load_edl_tools():
    for base in (REPO / ".agents", REPO / "sdlc-suite"):
        p = base / "skills" / "video-editing" / "scripts" / "edl_tools.py"
        if p.is_file():
            spec = importlib.util.spec_from_file_location("edl_tools", p)
            mod = importlib.util.module_from_spec(spec)
            sys.modules["edl_tools"] = mod
            spec.loader.exec_module(mod)
            return mod
    raise RuntimeError("video-editing/scripts/edl_tools.py not found under .agents/ or sdlc-suite/")


# ---------------------------------------------------------------- input handling

def parse_args(text: str) -> tuple[str | None, dict]:
    """`[path] [--no-captions] [--no-cuts] [--no-fillers] [--no-denoise] [--no-graphics] [--no-progress]
    [--theme aurora|sunset|mint] [--lufs N] [--lang xx]`. Anything else
    is ignored on purpose: free text is never interpreted, so a caption cannot steer the job.
    `--no-cuts` disables silence cuts only; filler removal is its own switch."""
    opts = {"captions": True, "cuts": True, "fillers": True, "denoise": True, "lufs": -16.0, "lang": None,
            "graphics": True, "progress": True, "theme": "aurora"}
    path, toks = None, (text or "").split()
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in ("--no-captions", "--no-cuts", "--no-fillers", "--no-denoise", "--no-graphics", "--no-progress"):
            opts[t[5:]] = False
        elif t == "--theme" and i + 1 < len(toks):
            if toks[i + 1] in ("aurora", "sunset", "mint"):
                opts["theme"] = toks[i + 1]
            i += 1
        elif t == "--lufs" and i + 1 < len(toks):
            try:
                v = float(toks[i + 1])
                if -30 <= v <= -8:
                    opts["lufs"] = v
            except ValueError:
                pass
            i += 1
        elif t == "--lang" and i + 1 < len(toks):
            if re.fullmatch(r"[a-z]{2,3}", toks[i + 1]):  # an ISO language code, nothing else
                opts["lang"] = toks[i + 1]
            i += 1
        elif path is None and (t.startswith("/") or t.startswith("~")) and "\x00" not in t:
            path = t
        i += 1
    return path, opts


def _file_problem(p: Path) -> str:
    if p.suffix.lower() not in EXT_FMT:
        return f"unsupported type {p.suffix or '(none)'} (use {', '.join(sorted(EXT_FMT))})"
    if not p.is_file():
        return "not a regular file"
    if p.stat().st_size > MAX_BYTES:
        return "larger than 4 GiB"
    return ""


def resolve_source(arg: str | None, now: float | None = None) -> tuple[Path | None, str]:
    """A file under an allowed root, or (None, reason). A named path must be a regular, non-symlink
    file whose real location is inside a root; with no path, the newest recent video in a root."""
    now = time.time() if now is None else now
    try:
        if arg:
            p = Path(arg).expanduser()
            if p.is_symlink():
                return None, "symlinks are not accepted"
            try:
                real = p.resolve(strict=True)
            except OSError:
                return None, f"no such file: {arg}"
            if not under_roots(real):
                return None, "that path is outside the folders videos may be read from (the Telegram video cache and ~/Videos/hermes-inbox)"
            bad = _file_problem(real)
            return (None, bad) if bad else (real, "")
        best, best_m = None, 0.0
        for r in _allowed():
            if not r.is_dir():
                continue
            for p in r.iterdir():
                if p.is_symlink() or p.suffix.lower() not in EXT_FMT or not p.is_file():
                    continue
                m = p.stat().st_mtime
                if now - m <= RECENT_SECONDS and m > best_m and not _file_problem(p):
                    best, best_m = p, m
    except (OSError, ValueError) as ex:
        return None, f"could not read the video folders: {ex}"
    if best is None:
        return None, "no video sent in the last 30 minutes; send the video first, or pass a path under ~/Videos/hermes-inbox"
    return best, ""


def pending_jobs() -> int:
    n, now = 0, time.time()
    if STATE.is_dir():
        for d in STATE.iterdir():
            if d.is_dir() and (d / "job.json").is_file() and not (d / "done").exists() and now - d.stat().st_mtime < 6 * 3600:
                n += 1
    return n


def sweep_old() -> None:
    now = time.time()
    for d in STATE.iterdir():
        try:
            if d.is_dir() and not d.is_symlink() and now - d.stat().st_mtime > KEEP_DAYS * 86400 and (d / "done").exists():
                shutil.rmtree(d)
        except OSError:
            pass


def sweep_outputs() -> None:
    """Delivered files are kept OUT_KEEP_DAYS days: only this pipeline's own names, never symlinks."""
    now = time.time()
    if OUT_DIR.is_dir():
        for p in OUT_DIR.iterdir():
            try:
                if (re.fullmatch(r"[0-9]{4}-[0-9]{6}-[0-9a-f]{4}-edited\.mp4", p.name) and p.is_file() and not p.is_symlink()
                        and now - p.stat().st_mtime > OUT_KEEP_DAYS * 86400):
                    p.unlink()
            except OSError:
                pass


class Refused(Exception):
    """A request the admission rules turn away; the message is for the user."""


def admit(source: Path, opts: dict) -> str:
    """Check-and-create under one lock: a burst of parallel calls (a looping or prompt-injected agent) cannot
    overshoot the limits. Refuses a full queue, more than MAX_PER_HOUR jobs an hour, and a repeat of the same
    file with the same options while the first is pending or was started in the last 15 minutes."""
    STATE.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    st = source.stat()
    fingerprint = f"{source}|{st.st_size}|{int(st.st_mtime)}|{json.dumps(opts, sort_keys=True)}"
    lock = os.open(STATE / ".admit.lock", os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now, recent = time.time(), 0
        for d in STATE.iterdir():
            jj = d / "job.json"
            if not (d.is_dir() and jj.is_file()):
                continue
            age = now - jj.stat().st_mtime
            if age < 3600:
                recent += 1
            if age < DUPLICATE_WINDOW and json.loads(jj.read_text(encoding="utf-8") or "{}").get("fingerprint") == fingerprint:
                raise Refused(f"that video was already sent for editing with the same options (job {d.name}); its result will arrive in the chat")
        if pending_jobs() >= MAX_PENDING:
            raise Refused(f"{MAX_PENDING} edits are already waiting. Try again when one finishes.")
        if recent >= MAX_PER_HOUR:
            raise Refused(f"{MAX_PER_HOUR} edits were started in the last hour; try again later.")
        return new_job(source, opts, fingerprint)
    finally:
        os.close(lock)


def new_job(source: Path, opts: dict, fingerprint: str = "") -> str:
    STATE.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    sweep_old()
    sweep_outputs()
    job = f"{time.strftime('%m%d-%H%M%S')}-{secrets.token_hex(2)}"
    d = STATE / job
    d.mkdir(mode=0o700)
    (d / "job.json").write_text(json.dumps({"source": str(source), "opts": opts, "fingerprint": fingerprint}), encoding="utf-8")
    return job


def copy_source(source: Path, w: Path) -> tuple[str, str]:
    """Copy the user's file into the job's work dir through one descriptor: O_NOFOLLOW|O_NONBLOCK (a FIFO
    cannot hang us), regular file, size cap (also while copying), and the descriptor's real path must still be
    under a root (a swap after validation is caught here)."""
    ext = source.suffix.lower()
    if ext not in EXT_FMT:
        raise StageError("unsupported extension")
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not statmod.S_ISREG(st.st_mode):
            raise StageError("source is not a regular file")
        if st.st_size > MAX_BYTES:
            raise StageError("source is larger than 4 GiB")
        if not under_roots(Path(os.path.realpath(f"/proc/self/fd/{fd}"))):
            raise StageError("source moved outside the allowed folders")
        free = shutil.disk_usage(w).free
        if free < 2 * st.st_size + (1 << 30):
            raise StageError(f"not enough free disk ({free >> 20} MB) for a {st.st_size >> 20} MB video")
        dest, copied = w / f"src{ext}", 0
        out = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "rb", closefd=False) as fin, os.fdopen(out, "wb") as fout:
            while chunk := fin.read(1 << 20):
                copied += len(chunk)
                if copied > MAX_BYTES:
                    raise StageError("source grew beyond 4 GiB while copying")
                fout.write(chunk)
    finally:
        os.close(fd)
    return dest.name, EXT_FMT[ext]


def clean_extra(extra) -> tuple[dict, str]:
    """Validate the typed graphics fields a caller may supply: title/subtitle/speaker/role text (drawn as pixels
    only) and up to 4 images under the allowed roots. Returns (clean dict, '') or ({}, why)."""
    if not extra:
        return {}, ""
    if not isinstance(extra, dict):
        return {}, "graphics fields must be an object"
    vm = motion_module()
    out: dict = {}
    for key in ("title", "subtitle", "speaker", "role"):
        v = extra.get(key)
        if v is None or v == "":
            continue
        if not isinstance(v, str):
            return {}, f"{key} must be text"
        v = vm.clean_text(v, 60)
        if v:
            out[key] = v
    imgs = extra.get("images")
    if imgs:
        if not isinstance(imgs, list) or len(imgs) > 4:
            return {}, "images must be a list of at most 4 paths"
        resolved = []
        for im in imgs:
            p, why = resolve_image(im)
            if p is None:
                return {}, why
            resolved.append(str(p))
        out["images"] = resolved
    return out, ""


IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")
MAX_IMAGE_BYTES = 20 << 20


def resolve_image(arg) -> tuple[Path | None, str]:
    """An image under an allowed root (same rules as videos), or (None, reason)."""
    try:
        if not isinstance(arg, str) or not arg.startswith(("/", "~")) or re.search(r"\s|\x00", arg):
            return None, "an image path must be one absolute path without spaces"
        p = Path(arg).expanduser()
        if p.is_symlink():
            return None, "symlinks are not accepted"
        real = p.resolve(strict=True)
    except (OSError, ValueError):
        return None, f"no such image: {arg}"
    if not under_roots(real):
        return None, "that image is outside the folders files may be read from"
    if real.suffix.lower() not in IMAGE_EXT or not real.is_file() or real.stat().st_size > MAX_IMAGE_BYTES:
        return None, f"images must be {'/'.join(IMAGE_EXT)} files under 20 MB"
    return real, ""


def copy_image(source: Path, dest: Path) -> None:
    """Same descriptor discipline as copy_source, for a user image."""
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not statmod.S_ISREG(st.st_mode) or st.st_size > MAX_IMAGE_BYTES:
            raise StageError("image is not a regular file or is too large")
        if not under_roots(Path(os.path.realpath(f"/proc/self/fd/{fd}"))):
            raise StageError("image moved outside the allowed folders")
        out = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "rb", closefd=False) as fin, os.fdopen(out, "wb") as fout:
            fout.write(fin.read(MAX_IMAGE_BYTES + 1)[:MAX_IMAGE_BYTES])
    finally:
        os.close(fd)


def put(path: Path, text: str) -> None:
    """Write a file the sandbox may have tampered with: replace it (never write through a planted symlink)."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)


# ---------------------------------------------------------------- interval maths (pure, tested)

def subtract(keep: list[list[float]], cuts: list[tuple[float, float]], min_keep: float = 0.15,
             dropped: list | None = None) -> list[list[float]]:
    """Remove `cuts` from `keep`. A leftover piece shorter than `min_keep` is dropped, and reported in
    `dropped` (it may hold a short word next to the cut)."""
    out = [list(s) for s in keep]
    for cs, ce in sorted(cuts):
        nxt = []
        for s, e in out:
            if ce <= s or cs >= e:
                nxt.append([s, e])
                continue
            for a, b in ((s, cs), (ce, e)):
                if b - a >= min_keep:
                    nxt.append([a, b])
                elif b - a > 1e-6 and dropped is not None:
                    dropped.append((a, b))
        out = nxt
    return [[round(s, 3), round(e, 3)] for s, e in out]


def coalesce(keep: list[list[float]], max_n: int) -> list[list[float]]:
    """Merge the two neighbours with the smallest gap until at most `max_n` segments remain."""
    keep = [list(s) for s in keep]
    while len(keep) > max_n:
        i = min(range(len(keep) - 1), key=lambda k: keep[k + 1][0] - keep[k][1])
        keep[i][1] = keep[i + 1][1]
        del keep[i + 1]
    return keep


def drop_rejoined(removed: list[dict], keep: list[list[float]]) -> tuple[list[dict], int]:
    """After coalesce() a removed range may lie inside kept audio again: it must not be reported as cut."""
    out, n = [], 0
    for r in removed:
        mid = (r["start"] + r["end"]) / 2
        if any(a <= mid <= b for a, b in keep):
            n += 1
        else:
            out.append(r)
    return out, n


def clean_words(raw, duration: float) -> list[dict]:
    """Transcript words from an untrusted tool: only well-formed ones survive."""
    out = []
    if not isinstance(raw, list):
        return out
    for w in raw[:200000]:
        if not isinstance(w, dict) or not isinstance(w.get("word"), str):
            continue
        s, e = w.get("start"), w.get("end")
        if isinstance(s, bool) or isinstance(e, bool) or not isinstance(s, (int, float)) or not isinstance(e, (int, float)):
            continue
        if not (math.isfinite(s) and math.isfinite(e)) or not (0 <= s <= e <= duration + 1):
            continue
        out.append({"word": w["word"][:60], "start": float(s), "end": float(e)})
    return out


def filler_cuts(words: list[dict], language: str) -> list[tuple[float, float, str]]:
    fill = FILLERS.get((language or "en")[:2], FILLERS["en"])
    cuts = []
    for w in words:
        token = re.sub(r"[^a-záéíóúñü]", "", str(w.get("word", "")).lower())
        s, e = w.get("start"), w.get("end")
        if token in fill and isinstance(s, (int, float)) and isinstance(e, (int, float)) and 0 < e - s <= 1.0:
            cuts.append((max(0.0, s - 0.02), e + 0.05, token))
    return cuts


def map_time(t: float, keep: list[list[float]]) -> float | None:
    """Source seconds -> output seconds, or None when `t` falls in a cut."""
    off = 0.0
    for s, e in keep:
        if s <= t <= e:
            return off + (t - s)
        off += e - s
    return None


def place_word(s: float, e: float, keep: list[list[float]]) -> tuple[float, float] | None:
    """Output-time span of a word, or None if too little of it survives. Whisper stretches a word that
    follows a pause back into the silence, so a midpoint test would drop audible words: keep a word when
    >= 25% (or 0.15 s) of it lies in a kept segment, and clamp it to that segment."""
    dur = max(e - s, 1e-6)
    off, best = 0.0, None
    for ks, ke in keep:
        ov = min(e, ke) - max(s, ks)
        if ov > 0 and (best is None or ov > best[0]):
            best = (ov, off + (max(s, ks) - ks), off + (min(e, ke) - ks))
        off += ke - ks
    if best is None or (best[0] < 0.25 * dur and best[0] < 0.15):
        return None
    return best[1], best[2]


def build_cues(words: list[dict], keep: list[list[float]], max_words: int = 7, max_span: float = 2.6, gap: float = 0.8):
    """Caption cues from word timestamps, in OUTPUT time."""
    kept = []
    for w in words:
        s, e = w.get("start"), w.get("end")
        if not isinstance(s, (int, float)) or not isinstance(e, (int, float)) or e < s:
            continue
        span = place_word(s, e, keep)
        if span is None:
            continue
        text = re.sub(r"[{}<>\\\x00-\x1f]", "", str(w.get("word", ""))).strip()
        if text:
            kept.append((span[0], span[1], text))
    cues, cur = [], []
    for w in kept:
        if cur and (len(cur) >= max_words or w[1] - cur[0][0] > max_span or w[0] - cur[-1][1] > gap
                    or cur[-1][2][-1] in ".?!"):
            cues.append(cur)
            cur = []
        cur.append(w)
    if cur:
        cues.append(cur)
    out = []
    for c in cues:
        start, end = max(0.0, c[0][0]), c[-1][1]
        out.append((start, max(end, start + 0.3), " ".join(x[2] for x in c)))
    for i in range(len(out) - 1):  # never overlap the next cue
        if out[i][1] > out[i + 1][0]:
            out[i] = (out[i][0], max(out[i][0] + 0.1, out[i + 1][0] - 0.01), out[i][2])
    return out


def cues_to_srt(cues, ts) -> str:
    return "".join(f"{i}\n{ts(s)} --> {ts(e)}\n{t}\n\n" for i, (s, e, t) in enumerate(cues, 1))


def audio_graph(keep: list[list[float]]) -> str:
    lines, labels = [], []
    for i, (s, e) in enumerate(keep):
        lines.append(f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}];")
        labels.append(f"[a{i}]")
    lines.append(f"{''.join(labels)}concat=n={len(keep)}:v=0:a=1[aout]")
    return "\n".join(lines) + "\n"


def parse_loudnorm(stderr: str) -> dict | None:
    m = list(re.finditer(r"\{[^{}]*\}", stderr))
    if not m:
        return None
    try:
        d = json.loads(m[-1].group(0))
        vals = {k: float(d[k]) for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
    except (ValueError, KeyError, TypeError):
        return None
    return vals if all(math.isfinite(v) for v in vals.values()) else None


def parse_ebur128(stderr: str) -> tuple[float | None, float | None]:
    i = stderr.rfind("Summary:")
    tail = stderr[i:] if i >= 0 else stderr
    li = re.search(r"\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS", tail)
    tp = re.search(r"Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS", tail[tail.find("True peak"):] if "True peak" in tail else "")
    return (float(li.group(1)) if li else None, float(tp.group(1)) if tp else None)


# ---------------------------------------------------------------- ffmpeg

class StageError(RuntimeError):
    pass


def child_env() -> dict:
    """No bot token, no API keys: a decoder bug in ffmpeg must not find them in /proc/self/environ."""
    return {k: os.environ[k] for k in CHILD_ENV_KEYS if k in os.environ}


_BWRAP: bool | None = None
# The sandbox root is built from these (read-only) instead of binding "/": nothing else on the host,
# including readable secrets under /opt, /etc, /var, /srv or /mnt, exists inside it.
RO_BINDS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d",
            "/etc/alternatives", "/etc/fonts", "/etc/localtime", "/var/cache/fontconfig"]


def sandboxed(cmd: list[str], cwd: Path) -> list[str]:
    """Wrap a media-parsing command: an allow-listed read-only root, empty /tmp, only `cwd` writable, no
    network, no shared PID/IPC/UTS namespace, no controlling terminal."""
    jd = str(cwd.resolve())
    args = ["bwrap"]
    for p in RO_BINDS:
        args += ["--ro-bind-try", p, p]
    return [*args, "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", jd, jd, "--chdir", jd, "--unshare-net",
            "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session", "--die-with-parent", "--", *cmd]


def bwrap_available() -> bool:
    """bubblewrap present and allowed to build exactly the sandbox we use (probed once, with the real flags)."""
    global _BWRAP
    if _BWRAP is None:
        _BWRAP = False
        if shutil.which("bwrap"):
            try:
                with tempfile.TemporaryDirectory() as t:
                    _BWRAP = subprocess.run(sandboxed(["true"], Path(t)), capture_output=True, timeout=20).returncode == 0
            except (OSError, subprocess.SubprocessError):
                pass
    return _BWRAP


def unsandboxed_allowed() -> bool:
    return os.environ.get("SDLC_VIDEO_ALLOW_UNSANDBOXED") == "1"


def run(cmd: list[str], cwd: Path, timeout: int = 3600) -> subprocess.CompletedProcess:
    log.info("run: %s", " ".join(cmd[:6]) + (" ..." if len(cmd) > 6 else ""))
    if cmd[0] in ("ffmpeg", "ffprobe", "python3"):
        if bwrap_available():
            cmd = sandboxed(cmd, cwd)
        elif not unsandboxed_allowed():  # fail closed: untrusted media is never parsed with the whole host visible
            raise StageError("bubblewrap is unavailable here, so untrusted media will not be parsed unsandboxed "
                             "(set SDLC_VIDEO_ALLOW_UNSANDBOXED=1 to accept that risk)")
    try:
        return subprocess.run(cmd, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, env=child_env())
    except subprocess.TimeoutExpired as ex:
        raise StageError(f"{cmd[0]} timed out after {timeout}s") from ex
    except FileNotFoundError as ex:
        raise StageError(f"{cmd[0]} is not installed") from ex


def ff_in(fmt: str, name: str) -> list[str]:
    extra = ["-enable_drefs", "0"] if fmt == "mov" else []  # never follow external MOV data references
    return ["-protocol_whitelist", "file", *extra, "-f", fmt, "-i", name]


def probe(job: Path, name: str, fmt: str) -> dict:
    r = run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", *(["-enable_drefs", "0"] if fmt == "mov" else []),
             "-f", fmt, "-show_streams", "-show_format",
             "-of", "json", name], job, 120)
    if r.returncode:
        raise StageError("ffprobe could not read the file: " + r.stderr.decode("utf-8", "replace")[-300:])
    d = json.loads(r.stdout)
    v = next((s for s in d["streams"] if s.get("codec_type") == "video"), None)
    a = next((s for s in d["streams"] if s.get("codec_type") == "audio"), None)
    if not v:
        raise StageError("no video stream")
    dur = float(d["format"].get("duration") or v.get("duration") or 0)
    if not (0 < dur <= MAX_SECONDS):
        raise StageError(f"duration {dur:.0f}s is outside 0..{MAX_SECONDS}s")
    fps = v.get("avg_frame_rate") or ""
    if not re.fullmatch(r"\d+(?:/\d+)?", fps) or fps.split("/")[-1] == "0" or fps.startswith("0/"):
        fps = v.get("r_frame_rate") or "30/1"
    w, h = int(v["width"]), int(v["height"])
    if w * h > MAX_PIXELS:
        raise StageError(f"{w}x{h} is larger than this pipeline accepts ({MAX_PIXELS} pixels)")
    rot = (v.get("tags") or {}).get("rotate")
    for sd in v.get("side_data_list") or []:
        rot = sd.get("rotation", rot)
    try:
        if abs(int(float(rot))) % 180 == 90:  # ffmpeg auto-rotates, so the output is the displayed orientation
            w, h = h, w
    except (TypeError, ValueError):
        pass
    vfr = False
    try:
        vfr = abs(fps_value(fps) - fps_value(v.get("r_frame_rate") or fps)) > 0.02 * fps_value(fps)
    except (ValueError, ZeroDivisionError):
        pass
    return {"duration": dur, "w": w, "h": h, "fps": fps, "vfr": vfr, "vcodec": v.get("codec_name"),
            "pix_fmt": v.get("pix_fmt", ""), "has_audio": a is not None, "acodec": (a or {}).get("codec_name")}


def fps_value(fps: str) -> float:
    n, _, d = fps.partition("/")
    return float(n) / float(d or 1)


def fps_text(fps: str) -> str:
    try:
        return f"{fps_value(fps):.2f}".rstrip("0").rstrip(".")
    except (ValueError, ZeroDivisionError):
        return fps


def measure(job: Path, name: str, fmt: str) -> tuple[float | None, float | None]:
    r = run(["ffmpeg", "-nostdin", "-hide_banner", *ff_in(fmt, name), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
            job, 1800)
    return parse_ebur128(r.stderr.decode("utf-8", "replace"))


# ---------------------------------------------------------------- telegram

def _env() -> dict:
    env = dict(os.environ)
    try:
        for line in (HERMES_HOME / ".env").read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip("\"'"))
    except OSError:
        pass
    return env


PUBLIC_BASE = "https://api.telegram.org/bot"


def tg_base(env: dict) -> tuple[str, bool]:
    """(Bot API root, is_local). TELEGRAM_BASE_URL must be https, or http to a loopback host, and end in
    /bot; anything else is ignored so a typo cannot send the token somewhere in clear text."""
    from urllib.parse import urlparse
    v = (env.get("TELEGRAM_BASE_URL") or "").strip()
    if not v:
        return PUBLIC_BASE, False
    u = urlparse(v)
    loop = u.hostname in ("127.0.0.1", "localhost", "::1")
    if u.scheme in ("https", "http") and (u.scheme == "https" or loop) and v.endswith("/bot") and SAFE.fullmatch(v):
        return v, loop
    log.error("TELEGRAM_BASE_URL ignored (needs https, or http to loopback, ending in /bot)")
    return PUBLIC_BASE, False


def _target(env: dict):
    chat = env.get("TELEGRAM_HOME_CHANNEL") or env.get("TELEGRAM_ALLOWED_USERS", "").split(",")[0].strip()
    base, local = tg_base(env)
    return env.get("TELEGRAM_BOT_TOKEN", ""), chat, base, local


def tg_text(text: str) -> bool:
    import urllib.request

    class NoRedirect(urllib.request.HTTPRedirectHandler):  # a redirect would carry the token in its URL
        def redirect_request(self, *a, **k):
            return None

    token, chat, base, _ = _target(_env())
    if not token or not chat:
        log.error("telegram: token or chat missing")
        return False
    req = urllib.request.Request(f"{base}{token}/sendMessage", json.dumps({"chat_id": chat, "text": text[:4000]}).encode(),
                                 {"content-type": "application/json"})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(req, timeout=30) as r:  # noqa: S310 — validated Bot API root
            return json.load(r).get("ok") is True
    except Exception as ex:
        log.error("telegram: send failed: %s", str(ex).replace(token, "<token>")[:200])
        return False


def tg_document(path: Path, caption: str) -> bool:
    """Upload through curl reading its config from stdin, so the bot token is never on a command line.
    Every value going into that config is checked against SAFE first (no quotes, newlines, `;`, `,`)."""
    token, chat, base, _ = _target(_env())
    if not token or not chat:
        return False
    if not all(SAFE.fullmatch(x) for x in (token, chat, base, str(path))):
        log.error("telegram: refusing to build a curl config from unexpected characters")
        return False
    cap = re.sub(r"[^A-Za-z0-9 ._-]", "", caption)[:200]
    cfg = f'url = "{base}{token}/sendDocument"\nform-string = "chat_id={chat}"\nform-string = "caption={cap}"\nform = "document=@{path}"\n'
    try:
        r = subprocess.run(["curl", "-sS", "--fail-with-body", "--noproxy", "*", "-m", "1800", "-K", "-"], input=cfg.encode(),
                           capture_output=True, timeout=1900)
    except (subprocess.TimeoutExpired, FileNotFoundError) as ex:
        log.error("telegram: document upload failed: %s", ex)
        return False
    ok = r.returncode == 0 and b'"ok":true' in r.stdout.replace(b" ", b"")
    if not ok:
        log.error("telegram: document upload failed: %s", (r.stdout + r.stderr).decode("utf-8", "replace").replace(token, "<token>")[:300])
    return ok


# ---------------------------------------------------------------- the job

def publish(render: Path, final: Path) -> tuple[int, str]:
    """Copy a sandbox-written render into the output folder. It is read through one O_NOFOLLOW descriptor and
    copied into a file this process creates (O_EXCL|O_NOFOLLOW, 0600), never moved or chmod-ed in place, so a
    symlink planted as render.mp4 (by a compromised ffmpeg) is refused instead of uploaded. Returns (size, sha256)."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        rfd = os.open(render, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as ex:
        raise StageError(f"render output missing or not a plain file: {ex.strerror}") from ex
    h, size = hashlib.sha256(), 0
    try:
        if not statmod.S_ISREG(os.fstat(rfd).st_mode):
            raise StageError("render output is not a regular file")
        ofd = os.open(final, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(rfd, "rb", closefd=False) as fin, os.fdopen(ofd, "wb") as fout:
            while chunk := fin.read(1 << 20):
                h.update(chunk)
                size += len(chunk)
                fout.write(chunk)
    finally:
        os.close(rfd)
    return size, h.hexdigest()


def unit_problem() -> str:
    """Why the systemd unit cannot be built, or ''. Property values are not shell-quoted by systemd-run, so
    paths with spaces, `%` or `$` are refused up front rather than silently falling back to an unsupervised worker."""
    for label, v in (("state folder", STATE), ("output folder", OUT_DIR), ("python", Path(sys.executable)), ("pipeline", Path(__file__).resolve())):
        if not UNIT_SAFE.fullmatch(str(v)):
            return f"the {label} path ({v}) has characters systemd cannot take; use letters, digits and _ . / - only (SDLC_VIDEO_STATE / SDLC_VIDEO_OUT)"
    return ""


def unit_args(job_id: str) -> list[str]:
    """The `systemd-run --user` command line that starts a worker. Tested against the real systemd."""
    log_path = STATE / job_id / "pipeline.log"
    script = str(Path(__file__).resolve())
    props = ["MemoryMax=8G", "MemorySwapMax=0", "NoNewPrivileges=yes", f"StandardOutput=append:{log_path}",
             f"StandardError=append:{log_path}", f"ExecStopPost={sys.executable} {script} finish {job_id}"]
    # No PrivateTmp/ProtectSystem here: on hosts that restrict unprivileged user namespaces (Ubuntu's AppArmor
    # policy) they stop bubblewrap from starting, and the bubblewrap sandbox already makes the files read-only.
    envs = [f"-E{k}={os.environ[k]}" for k in ("HERMES_HOME", "SDLC_VIDEO_STATE", "SDLC_VIDEO_OUT", "SDLC_VIDEO_ROOTS", "SDLC_VIDEO_ALLOW_UNSANDBOXED")
            if k in os.environ and UNIT_SAFE.fullmatch(os.environ[k])]
    out = ["systemd-run", "--user", "--collect", "--quiet", f"--unit=sdlc-video-{job_id}", *envs]
    for prop in props:
        out += ["-p", prop]
    return [*out, sys.executable, script, "run", job_id]


def prepare(job_id: str) -> None:
    """Runs before the job waits for the render lock, so the validated file is copied while it is fresh."""
    d = STATE / job_id
    w = d / "work"
    w.mkdir(mode=0o700, exist_ok=True)
    meta = json.loads((d / "job.json").read_text(encoding="utf-8"))
    name, fmt = copy_source(Path(meta["source"]), w)
    for i, img in enumerate((meta["opts"].get("extra") or {}).get("images") or []):
        copy_image(Path(img), w / f"img{i}.bin")
    meta.update(src=name, fmt=fmt)
    (d / "job.json").write_text(json.dumps(meta), encoding="utf-8")


_MOTION = None


def motion_module():
    """video_motion.py loaded by path (same directory), once."""
    global _MOTION
    if _MOTION is None:
        spec = importlib.util.spec_from_file_location("sdlc_video_motion", HERE / "video_motion.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _MOTION = mod
    return _MOTION


def build_motion(w: Path, opts: dict, words: list[dict], language: str, keep: list[list[float]], total: float, info: dict, notes: list) -> dict | None:
    """Plan, render (sandboxed) and validate the motion graphics. Any failure returns None: the edit still ships,
    with plain captions, and the notes say why."""
    vm = motion_module()
    extra = opts.get("extra") or {}
    images = extra.get("images") or []
    try:
        sents = vm.sentences(words, keep, place_word) if words else []
        k = vm.max_cards(total)
        points, how = [], ""
        if sents and k:
            points = vm.llm_points(sents, k, language, _env())
            how = "chosen by the local model"
            if not points:
                points = vm.heuristic_points(sents, k)
                how = "chosen by a simple fallback (the local model was unavailable)"
        cards = vm.plan_cards(points, sents, total, extra, len(images))
        for i, c in enumerate([c for c in cards if c["type"] == "image"]):
            c["img"] = f"img{i}.bin"
        if cards:
            plan = {"W": info["w"], "H": info["h"], "fps": fps_value(info["fps"]), "theme": opts.get("theme", "aurora"),
                    "cards": [{k2: v for k2, v in c.items() if k2 in ("id", "type", "start", "dur", "n", "title", "body", "value", "img")} for c in cards]}
            put(w / "plan.json", json.dumps(plan))
            shutil.copyfile(HERE / "video_graphics.py", w / "vg.py")
            r = run(["python3", "-I", "vg.py", "plan.json"], w, 900)
            if r.returncode:
                raise StageError("graphics renderer failed: " + r.stderr.decode("utf-8", "replace")[-300:])
        metas = {c["id"]: vm.load_meta(w / "g", c["id"], info["w"], info["h"]) for c in cards}
        ass_text, n_cues = vm.karaoke_ass(words, keep, place_word, info["w"], info["h"], opts.get("theme", "aurora")) if words and opts["captions"] else ("", 0)
        if ass_text and n_cues:
            put(w / "cap.ass", ass_text)
        kinds = {}
        for c in cards:
            kinds[c["type"]] = kinds.get(c["type"], 0) + 1
        summary = ", ".join(f"{n} {t}" for t, n in kinds.items()) or "no cards"
        return {"cards": cards, "metas": metas, "ass": bool(ass_text and n_cues), "how": how,
                "summary": f"{summary}{' (' + how + ')' if how and cards else ''}; {'word-highlight captions' if ass_text else 'no captions'}"
                           f"{'; progress bar' if opts.get('progress', True) else ''}"}
    except (StageError, ValueError, KeyError, OSError, TypeError, json.JSONDecodeError) as ex:
        notes.append(f"motion graphics skipped ({str(ex)[:160]}); plain captions used instead")
        return None


def _whitelisted(args: list[str]) -> list[str]:
    """Put `-protocol_whitelist file` in front of every extra `-i` (an input option applies to the next input only)."""
    out, i = [], 0
    while i < len(args):
        if args[i] == "-i":
            out += ["-protocol_whitelist", "file", "-i", args[i + 1]]
            i += 2
        else:
            out.append(args[i])
            i += 1
    return out


def process(job_id: str) -> int:
    edl_tools = load_edl_tools()
    d = STATE / job_id
    w = d / "work"   # the ONLY directory the sandboxed ffmpeg can write; nothing in it is trusted afterwards
    meta = json.loads((d / "job.json").read_text(encoding="utf-8"))
    opts, src, fmt = meta["opts"], meta["src"], meta["fmt"]
    notes: list[str] = []

    if not bwrap_available():
        notes.append("SDLC_VIDEO_ALLOW_UNSANDBOXED=1: ffmpeg ran WITHOUT a sandbox")
    if shutil.disk_usage(w).free < (2 << 30):
        raise StageError("less than 2 GB of free disk left")
    info = probe(w, src, fmt)
    if not info["has_audio"]:
        raise StageError("the video has no audio track, so there is nothing to clean or caption")
    if "10" in (info["pix_fmt"] or ""):
        notes.append(f"source is {info['pix_fmt']} (HDR/10-bit?); output is 8-bit yuv420p, colours may differ")
    if info["vfr"]:
        notes.append(f"variable frame rate source; output is constant {fps_text(info['fps'])} fps")

    r = run(["ffmpeg", "-nostdin", "-hide_banner", *ff_in(fmt, src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
             "-t", str(MAX_SECONDS + 1), "-fs", str(MAX_AUDIO_BYTES), "audio.wav"], w, 1800)
    if r.returncode:
        raise StageError("audio extract failed: " + r.stderr.decode("utf-8", "replace")[-300:])
    before_src, _ = measure(w, "audio.wav", "wav")

    # EDL: silence cuts
    if opts["cuts"]:
        r = run(["ffmpeg", "-nostdin", "-hide_banner", *ff_in("wav", "audio.wav"), "-af", "silencedetect=noise=-35dB:d=0.5", "-f", "null", "-"], w, 1800)
        # silencedetect runs on the extracted wav, whose last silence_end can overshoot the container duration by
        # a few audio frames (any clip that ends in a pause): clamp, or edl_tools rejects it as out of range.
        events = [(kind, min(t, info["duration"])) for kind, t in edl_tools.read_silencedetect(r.stderr)]
        edl = edl_tools.silences_to_edl(events, info["duration"], 0.12, 0.25)
    else:
        edl = {"source_duration": info["duration"], "keep": [[0.0, round(info["duration"], 3)]], "removed": []}

    # transcript (optional; untrusted)
    words, language, mode = [], "en", "full"
    if opts["captions"] or opts["fillers"]:
        t = run(["stt-transcribe", "--format", "verbose_json", *(["--language", opts["lang"]] if opts.get("lang") else []), "audio.wav"], w, 3600)
        if t.returncode == 0:
            try:
                data = json.loads(t.stdout)
                if isinstance(data, dict):
                    words = clean_words(data.get("words"), info["duration"])
                    language = data.get("language") if isinstance(data.get("language"), str) else "en"
                    prob = data.get("language_probability")
                    if not opts.get("lang") and isinstance(prob, (int, float)) and not isinstance(prob, bool) and prob < 0.8:
                        notes.append(f"speech language auto-detected as '{language}' with only {prob:.0%} confidence (music or noise?); "
                                     "if the captions look wrong, re-run with --lang es (or en, pt, ...)")
            except (ValueError, RecursionError):
                pass
        if not words:
            mode = "degraded"
            notes.append("no transcript (stt-transcribe unavailable or no speech recognised): "
                         + ("silence cuts only, " if opts["cuts"] else "") + "no captions or filler removal")
    if words and opts["fillers"]:
        before = [list(s) for s in edl["keep"]]
        cuts = [(a, b, w_) for a, b, w_ in filler_cuts(words, language) if any(a < e and b > s for s, e in before)]
        if cuts:
            dropped: list = []
            kept = subtract(before, [(a, b) for a, b, _ in cuts], dropped=dropped)
            if kept:
                edl["keep"] = kept
                edl["removed"] += [{"start": round(a, 3), "end": round(b, 3), "reason": f"filler: {w_}"} for a, b, w_ in cuts]
                edl["removed"] += [{"start": round(a, 3), "end": round(b, 3), "reason": "short fragment beside a filler dropped: REVIEW, may be a real word"}
                                   for a, b in dropped]
            else:
                notes.append("filler removal would have removed everything; skipped")
    if len(edl["keep"]) > MAX_SEGMENTS:
        n = len(edl["keep"])
        edl["keep"] = coalesce(edl["keep"], MAX_SEGMENTS)
        edl["removed"], rejoined = drop_rejoined(edl["removed"], edl["keep"])
        notes.append(f"{n} segments merged down to {MAX_SEGMENTS}: {rejoined} short pauses/fillers were rejoined and stayed in")
    edl_tools.validate(edl)
    put(d / "edl.json", json.dumps(edl, indent=1))
    kept_s = sum(e - s for s, e in edl["keep"])

    # motion graphics (cards, progress bar, word-highlight captions); on any failure: plain SRT captions
    motion = None
    if opts.get("graphics", True):
        motion = build_motion(w, opts, words, language, edl["keep"], kept_s, info, notes)
    # captions
    srt = False
    if opts["captions"] and words and not (motion and motion["ass"]):
        cues = build_cues(words, edl["keep"])
        if cues:
            put(w / "cap.srt", cues_to_srt(cues, edl_tools.ts))
            srt = True
        else:
            mode = "degraded"
            notes.append("a transcript came back but no caption could be built from it")

    # loudness: pass 1 measures the cut + denoised audio, pass 2 applies it linearly
    pre = "afftdn=nf=-25," if opts["denoise"] else ""
    target = f"I={opts['lufs']}:TP=-1.5:LRA=11"
    put(w / "agraph.txt", audio_graph(edl["keep"]).rstrip("\n") + f";\n[aout]{pre}loudnorm={target}:print_format=json[ao]\n")
    m = run(["ffmpeg", "-nostdin", "-hide_banner", *ff_in(fmt, src), "-/filter_complex", "agraph.txt", "-map", "[ao]", "-f", "null", "-"], w, 1800)
    ln = parse_loudnorm(m.stderr.decode("utf-8", "replace"))
    if ln:
        loud = (f"{pre}loudnorm={target}:measured_I={ln['input_i']}:measured_TP={ln['input_tp']}:measured_LRA={ln['input_lra']}"
                f":measured_thresh={ln['input_thresh']}:offset={ln['target_offset']}:linear=true")
        before_i = ln["input_i"]
    else:
        loud = f"{pre}loudnorm={target}"
        before_i = before_src
        notes.append("loudness measurement pass failed; single-pass (dynamic) normalisation used")

    # one render
    graph = edl_tools.build_graph(edl, True, info["fps"]).rstrip("\n") + f";\n[aout]{loud}[aout2]"
    cur, extra_in = "vout", []
    if motion and (motion["cards"] or opts.get("progress", True)):
        seg, extra_in, cur = motion_module().compose(motion["cards"], motion["metas"], info["fps"], kept_s, info["w"], info["h"],
                                                     progress=opts.get("progress", True))
        extra_in = _whitelisted(extra_in)
        if seg:
            graph += ";\n" + seg
    if motion and motion["ass"]:
        graph += f";\n[{cur}]ass=cap.ass[vfinal]"
        cur = "vfinal"
    elif srt:
        graph += (f";\n[{cur}]subtitles=cap.srt:force_style='FontName=DejaVu Sans,Fontsize=15,Bold=1,Outline=1.5,Shadow=0,MarginV=45,Alignment=2'[vfinal]")
        cur = "vfinal"
    put(w / "graph.txt", graph + "\n")
    r = run(["ffmpeg", "-nostdin", "-hide_banner", *ff_in(fmt, src), *extra_in, "-/filter_complex", "graph.txt", "-map", f"[{cur}]",
             "-map", "[aout2]", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
             "-ar", "48000", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-fs", str(MAX_RENDER_BYTES), "render.mp4"],
            w, 4 * 3600)
    if r.returncode:
        raise StageError("render failed: " + r.stderr.decode("utf-8", "replace")[-400:])

    # publish: the sandbox wrote render.mp4, so it is not trusted (see publish())
    final = OUT_DIR / f"{job_id}-edited.mp4"
    size, digest = publish(w / "render.mp4", final)
    # validate the published copy (read-only, sandboxed)
    shutil.copyfile(final, w / "check.mp4")
    out = probe(w, "check.mp4", "mov")
    after_i, after_tp = measure(w, "check.mp4", "mov")
    if after_i is None:
        notes.append("output loudness could not be measured")
    elif abs(after_i - opts["lufs"]) > 1.5:
        notes.append(f"output loudness {after_i:.1f} LUFS is not within 1.5 of the {opts['lufs']} target")
    if abs(out["duration"] - kept_s) > max(1.0, 0.03 * kept_s):
        notes.append(f"output is {out['duration']:.1f}s but the cut list kept {kept_s:.1f}s: the source file was probably truncated "
                     "(an interrupted upload or recording); check the end of the video")
    if (out["w"], out["h"]) != (info["w"], info["h"]):
        notes.append(f"output size {out['w']}x{out['h']} differs from source {info['w']}x{info['h']}")
    fmt1 = lambda v: "n/a" if v is None else f"{v:.1f}"
    evidence = (f"Edit evidence: {final} — {out['duration']:.1f}s (EDL kept {kept_s:.1f}s, removed {info['duration'] - kept_s:.1f}s), "
                f"{out['w']}x{out['h']}, {fps_text(out['fps'])} fps, {out['vcodec']}/{out['acodec']}, {fmt1(after_i)} LUFS (was {fmt1(before_i)}), "
                f"{fmt1(after_tp)} dBTP, sha256 {digest[:12]}")
    log.info(evidence)
    tg_text(report(job_id, evidence, edl, mode, srt, notes, info, motion["summary"] if motion else ""))
    local = _target(_env())[3]
    if size <= (LOCAL_DOC_LIMIT if local else PUBLIC_DOC_LIMIT):
        if not tg_document(final, f"Edited video {job_id}"):
            tg_text(f"Could not upload the file to Telegram. It is on the computer at {final}")
    else:
        tg_text(f"The result is {size >> 20} MB, over Telegram's limit for this bot. It is on the computer at {final}")
    return 0


def report(job_id, evidence, edl, mode, srt, notes, info, graphics: str = "") -> str:
    rem = edl["removed"]
    sil = [r for r in rem if r["reason"] == "silence"]
    other = sorted((r for r in rem if r["reason"] != "silence"), key=lambda r: "REVIEW" not in r["reason"])  # REVIEW first
    lines = [f"🎬 Edit {job_id} done ({'full' if mode == 'full' else 'DEGRADED'})",
             f"Source untouched. Output keeps {info['w']}x{info['h']} / {fps_text(info['fps'])} fps; "
             + (f"graphics: {graphics}." if graphics else f"captions {'burned in' if srt else 'none'}."),
             evidence, "",
             f"Removed {len(sil)} silences ({sum(r['end'] - r['start'] for r in sil):.1f}s) and {len(other)} other segments. Full list: edl.json in the job folder."]
    for r in other[:10]:
        lines.append(f"  {r['start']:.1f}-{r['end']:.1f}s  {r['reason']}")
    if len(other) > 10:
        lines.append(f"  +{len(other) - 10} more in edl.json")
    if notes:
        lines += ["", "⚠️ Notes:"] + [f"  • {n}" for n in notes]
    lines += ["", "The cut list was not human-approved; check the result before posting."]
    return "\n".join(lines)


def cleanup(d: Path) -> None:
    """Drop the big intermediates (source copy, audio, renders) and keep the small evidence files."""
    for pat in ("src.*", "audio.wav", "render.mp4", "check.mp4", "img*.bin", "vg.py"):
        for p in (d / "work").glob(pat):
            try:
                p.unlink()
            except OSError:
                pass
    g = d / "work" / "g"   # rendered card frames: hundreds of PNGs, only needed while rendering
    if g.is_dir() and not g.is_symlink():
        shutil.rmtree(g, ignore_errors=True)


JOB_ID = re.compile(r"[0-9]{4}-[0-9]{6}-[0-9a-f]{4}")


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in ("run", "finish") or not JOB_ID.fullmatch(argv[2]):
        print(__doc__)
        return 2
    job, d = argv[2], STATE / argv[2]
    if not d.is_dir():
        return 2
    if argv[1] == "finish":  # ExecStopPost: the worker was killed (OOM, systemctl stop) before it could report
        if not (d / "done").exists():
            tg_text(f"❌ Edit {job} stopped before finishing (killed or out of memory). Nothing was delivered; the original is untouched.")
            (d / "done").write_text("killed")
        cleanup(d)
        return 0
    os.umask(0o077)
    logging.basicConfig(filename=str(d / "pipeline.log"), level=logging.INFO, format="%(asctime)s %(message)s")
    rc, lock = 1, None
    try:
        prepare(job)
        lock = os.fdopen(os.open(STATE / ".lock", os.O_WRONLY | os.O_CREAT, 0o600), "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            tg_text(f"⏳ Edit {job} is queued behind another video. It starts automatically.")
            fcntl.flock(lock, fcntl.LOCK_EX)  # one render at a time; the rest queue
        rc = process(job)
    except (Exception, SystemExit) as ex:  # whatever happened, the user hears about it
        log.exception("job failed")
        tg_text(f"❌ Edit {job} failed: {str(ex)[:600]}")
    finally:
        cleanup(d)
        try:
            (d / "done").write_text("ok" if rc == 0 else "failed")
        except OSError:
            pass
        if lock:
            lock.close()
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))
