#!/usr/bin/env python3
"""EDL helpers for the video-editing skill. Standard library only; run with `python -I`.

The EDL (a JSON file) is the single source of truth for an edit. The video/audio
cut, the captions and any chapter marks are all derived from it, so they cannot
drift apart.

    edl_tools.py silences <silencedetect-stderr.txt> <duration> <edl.json> [--pad 0.12] [--min-keep 0.25] [--force]
    edl_tools.py graph    <edl.json> <graph.txt> [--no-audio] [--fps N] [--force]
    edl_tools.py retime   <edl.json> <in.srt> <out.srt> [--min-fraction 0.5] [--force]
    edl_tools.py report   <edl.json>

EDL shape: {"source_duration": s, "keep": [[start, end], ...], "removed": [{"start", "end", "reason"}]}
in source seconds. `removed` is informational (the review list); `keep` is what is cut.

Safety properties (enforced here, not just documented):
  * Output paths must resolve inside the current directory, and an existing file is
    never overwritten without --force (an approved EDL must not be clobbered).
  * Only `[Parsed_silencedetect_N @ ...]` lines are parsed from ffmpeg's stderr, never
    container metadata that the same stream echoes; a log that is not recognisably
    ffmpeg's (UTF-16 from a PowerShell redirect, a failed run) is refused rather
    than read as "no silence".
  * An EDL with no kept segment, a non-finite or boolean time, or a time outside
    the source is refused; nothing here emits a user string into a filter graph.
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

SIL_LINE = re.compile(r"^\[(?:Parsed_)?silencedetect(?:_[0-9]+)? @ [0-9a-fA-Fx]+\]\s+silence_(start|end):\s*(-?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)\s*(?:\||$)")
TOL = 0.01  # seconds of slack when checking a time against the source duration


class EdlError(SystemExit):
    def __init__(self, msg: str):
        super().__init__(f"error: {msg}")


def _num(x, what: str) -> float:
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        raise EdlError(f"{what} must be a finite number, got {x!r}")
    return float(x)


def check_out_path(p: str, force: bool) -> Path:
    path = Path(p)
    root = Path.cwd().resolve()
    resolved = (root / path).resolve()
    if resolved != root and root not in resolved.parents:
        raise EdlError(f"refusing to write outside the working directory: {p}")
    if resolved.exists() and not force:
        raise EdlError(f"{p} already exists; pick a new generated name or pass --force")
    return resolved


def write_text(p: str, text: str, force: bool) -> None:
    check_out_path(p, force).write_text(text, encoding="utf-8", newline="\n")


def validate(edl: dict) -> dict:
    dur = _num(edl.get("source_duration"), "source_duration")
    if dur <= 0:
        raise EdlError("source_duration must be positive")
    keep = edl.get("keep")
    if not isinstance(keep, list) or not keep:
        raise EdlError("EDL keeps nothing (empty or missing 'keep'): refusing to build an edit with no content")
    prev = 0.0
    for seg in keep:
        if not isinstance(seg, (list, tuple)) or len(seg) != 2:
            raise EdlError(f"bad segment {seg!r}")
        s, e = _num(seg[0], "segment start"), _num(seg[1], "segment end")
        if not (0 <= s < e <= dur + TOL):
            raise EdlError(f"segment {s}-{e} is outside 0..{dur}")
        if s < prev:
            raise EdlError(f"segments overlap or are out of order at {s}")
        prev = e
    return edl


def load(p: str) -> dict:
    return validate(json.loads(Path(p).read_text(encoding="utf-8-sig")))


def read_silencedetect(raw: bytes) -> list[tuple[str, float]]:
    if b"\x00" in raw or raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise EdlError("log looks UTF-16 (a PowerShell 5.1 `2>` redirect); re-run ffmpeg from Git Bash or write UTF-8")
    text = raw.decode("utf-8", errors="replace")
    if "Input #0" not in text:
        raise EdlError("log has no ffmpeg 'Input #0' block: the silencedetect run failed or this is not its log. Not treating that as 'no silence'")
    events = []
    for line in text.splitlines():
        m = SIL_LINE.match(line.strip())
        if m:
            events.append((m.group(1), float(m.group(2))))
    return events


def silences_to_edl(events: list[tuple[str, float]], duration: float, pad: float, min_keep: float) -> dict:
    _num(duration, "duration")
    if duration <= 0 or not (0 <= pad <= 1) or min_keep <= 0:
        raise EdlError("duration > 0, 0 <= pad <= 1 and min-keep > 0 are required")
    sil, open_start = [], None
    for kind, t in events:
        if kind == "start":
            if open_start is not None:
                raise EdlError("two silence_start lines in a row: log is inconsistent")
            open_start = t
        else:
            s = open_start if open_start is not None else 0.0  # a leading silence has an end only
            if t < s:
                raise EdlError("silence ends before it starts")
            sil.append((s, t))
            open_start = None
    if open_start is not None:
        sil.append((open_start, duration))
    prev_end = 0.0
    for s, e in sil:
        if s < prev_end - TOL or e > duration + TOL:
            raise EdlError("silence ranges are out of order or beyond the source duration")
        prev_end = e
    keep, removed, cursor = [], [], 0.0

    def add(a: float, b: float) -> None:
        a, b = round(max(a, 0.0), 3), round(min(b, duration), 3)
        if b <= a:
            return
        if b - a < min_keep and b - a <= pad + 1e-6 and (a <= 0 or b >= duration):
            return  # just the padding beside a silence at the file edge: not content
        if b - a < min_keep:
            removed.append({"start": a, "end": b, "reason": f"speech island shorter than {min_keep}s dropped: REVIEW, may be a real word"})
        elif keep and a <= keep[-1][1]:
            keep[-1][1] = max(keep[-1][1], b)  # merge when padding made them touch
        else:
            keep.append([a, b])

    for s, e in sil:
        add(cursor, s + pad)
        gap_start, gap_end = min(s + pad, e), max(e - pad, s)
        if gap_end > gap_start:
            removed.append({"start": round(gap_start, 3), "end": round(gap_end, 3), "reason": "silence"})
        cursor = max(e - pad, s + pad)
    add(cursor, duration)
    if not keep:
        raise EdlError("every part of the source was silent or too short to keep; lower the threshold or check the audio")
    return {"source_duration": duration, "keep": keep, "removed": removed}


FPS = re.compile(r"^[0-9]+(?:\.[0-9]+)?(?:/[0-9]+)?$")


def fps_value(text: str) -> float:
    if not FPS.match(text):
        raise EdlError(f"--fps must be a number or a fraction such as 30000/1001, got {text!r}")
    n, _, d = text.partition("/")
    v = float(n) / (float(d) if d else 1.0) if (not d or float(d) != 0) else 0.0
    if not (1 <= v <= 240):
        raise EdlError("--fps must be between 1 and 240 and should equal the probed source frame rate")
    return v


def build_graph(edl: dict, audio: bool, fps: str) -> str:
    """filter_complex text: trim/atrim each kept range, then concat. Numbers only."""
    fps_value(str(fps))  # validates; the text itself is emitted so 30000/1001 stays exact
    lines, labels = [], []
    for i, (s, e) in enumerate(edl["keep"]):
        lines.append(f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS,fps={fps}[v{i}];")
        labels.append(f"[v{i}]")
        if audio:
            lines.append(f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}];")
            labels[-1] += f"[a{i}]"
    n = len(edl["keep"])
    tail = f"{''.join(labels)}concat=n={n}:v=1:a={1 if audio else 0}[vout]" + ("[aout]" if audio else "")
    lines.append(tail)
    return "\n".join(lines) + "\n"


def ts(sec: float) -> str:
    ms = round(sec * 1000)
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


TS = re.compile(r"^\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*$")


def parse_ts(x: str) -> float:
    m = TS.match(x)
    if not m:
        raise ValueError(x)
    h, mi, s, frac = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(s) + int(frac.ljust(3, "0")) / 1000


def retime_srt(edl: dict, srt: str, min_fraction: float = 0.5) -> tuple[str, dict]:
    """Map cues through the EDL. A cue kept for less than `min_fraction` of its
    length is dropped: its text would describe speech that is no longer there."""
    out, n = [], 0
    stats = {"kept": 0, "dropped_cut": 0, "dropped_fraction": 0, "malformed": 0}
    for block in re.split(r"\n\s*\n", srt.lstrip("﻿").strip().replace("\r\n", "\n")):
        lines = block.split("\n")
        if len(lines) >= 2 and "-->" in lines[0]:
            lines = [""] + lines  # a cue with no index line is still a cue
        try:
            if len(lines) < 3 or "-->" not in lines[1]:
                raise ValueError
            a, b = (parse_ts(x) for x in lines[1].split("-->"))
            if b <= a:
                raise ValueError
        except ValueError:
            if block.strip():
                stats["malformed"] += 1
            continue
        pieces, o = [], 0.0
        for s, e in edl["keep"]:
            lo, hi = max(a, s), min(b, e)
            if lo < hi:
                pieces.append((o + (lo - s), o + (hi - s)))
            o += e - s
        if not pieces:
            stats["dropped_cut"] += 1
            continue
        if sum(h - l for l, h in pieces) / (b - a) < min_fraction:
            stats["dropped_fraction"] += 1
            continue
        n += 1
        stats["kept"] += 1
        out.append(f"{n}\n{ts(pieces[0][0])} --> {ts(pieces[-1][1])}\n" + "\n".join(lines[2:]))
    return ("\n\n".join(out) + "\n" if out else ""), stats


def _opt(args: list[str], k: str, default: float) -> float:
    if k not in args:
        return default
    try:
        return float(args[args.index(k) + 1])
    except (IndexError, ValueError):
        raise EdlError(f"{k} needs a number")


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd, args = argv[1], argv[2:]
    force = "--force" in args
    pos = [a for i, a in enumerate(args) if not a.startswith("--") and not (i and args[i - 1] in ("--pad", "--min-keep", "--fps", "--min-fraction"))]
    try:
        if cmd == "silences" and len(pos) == 3:
            edl = silences_to_edl(read_silencedetect(Path(pos[0]).read_bytes()), _num(float(pos[1]), "duration"),
                                  _opt(args, "--pad", 0.12), _opt(args, "--min-keep", 0.25))
            write_text(pos[2], json.dumps(edl, indent=2) + "\n", force)
            if not any(r["reason"] == "silence" for r in edl["removed"]):
                print("warning: no silence events found: the whole file is kept. If you expected cuts, check the threshold and the log", file=sys.stderr)
            for r in edl["removed"]:
                if r["reason"] != "silence":
                    print(f"warning: {r['start']}-{r['end']}: {r['reason']}", file=sys.stderr)
        elif cmd == "graph" and len(pos) == 2:
            fps = args[args.index("--fps") + 1] if "--fps" in args and args.index("--fps") + 1 < len(args) else "30"
            write_text(pos[1], build_graph(load(pos[0]), "--no-audio" not in args, fps), force)
        elif cmd == "retime" and len(pos) == 3:
            text, stats = retime_srt(load(pos[0]), Path(pos[1]).read_text(encoding="utf-8-sig"), _opt(args, "--min-fraction", 0.5))
            if not 0 < _opt(args, "--min-fraction", 0.5) <= 1:
                raise EdlError("--min-fraction must be in (0, 1]")
            write_text(pos[2], text, force)
            print(f"cues: {stats}", file=sys.stderr)
        elif cmd == "report" and len(pos) == 1:
            edl = load(pos[0])
            kept = sum(e - s for s, e in edl["keep"])
            print(f"segments={len(edl['keep'])} kept={kept:.3f}s source={edl['source_duration']:.3f}s "
                  f"removed={edl['source_duration'] - kept:.3f}s")
        else:
            print(__doc__)
            return 2
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise EdlError(str(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
