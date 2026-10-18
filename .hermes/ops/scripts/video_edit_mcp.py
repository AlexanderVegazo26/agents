"""MCP server `video-edit`: on-demand video editing on the host.

Replaces the old `video-edit-inbox` */5 polling cron. The agent calls the
`video_edit` tool when the user asks to edit a video it sent; everything
(ffmpeg, whisper) runs on the host, where the sandbox cannot reach.

Pipeline per edit (original is never touched):
  1. Trim leading/trailing silence (guarded; bad parse -> no trim).
  2. Normalize audio to -14 LUFS (single-pass loudnorm).
  3. Optionally burn captions from the local GPU whisper (LlamaStash proxy).
  4. Keep the source resolution and orientation (never scale or re-frame).
  5. Write H.264/AAC mp4 with +faststart to ~/Videos/hermes-out/.

The tool returns a JSON result; the agent must include the returned
`media_line` (MEDIA: <path>) verbatim as its final reply so the gateway
attaches the finished file to the chat.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from mcp.server.fastmcp import FastMCP

HERMES_HOME = Path(os.path.expanduser(os.environ.get("HERMES_HOME", "~/.hermes")))
CACHE = Path(os.environ.get("HERMES_VIDEO_CACHE", str(HERMES_HOME / "cache" / "videos")))
OUT_DIR = Path(os.environ.get("HERMES_VIDEO_OUT", str(Path.home() / "Videos" / "hermes-out")))
STT_BASE = os.environ.get("VIDEO_EDIT_STT_BASE_URL", "http://127.0.0.1:11435/v1")
STT_MODEL = os.environ.get("VIDEO_EDIT_STT_MODEL", "whisper")
VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".webm", ".m4v")
FFMPEG_TIMEOUT = 1800
STT_TIMEOUT = 300


def _stt_api_key() -> str:
    key = os.environ.get("LLAMASTASH_API_KEY", "")
    if key:
        return key
    try:
        text = (HERMES_HOME / "config.yaml").read_text(encoding="utf-8")
        m = re.search(r"llamastash:.*?api_key:\s*\"?([^\"\n]+)", text, re.S)
        if m:
            return m.group(1).strip().strip('"').replace("${LLAMASTASH_API_KEY}", "")
    except OSError:
        pass
    return ""


def _run(cmd: list[str], timeout: int = FFMPEG_TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _probe(path: str) -> dict:
    p = _run(["ffprobe", "-v", "error", "-show_format", "-show_streams",
              "-of", "json", path])
    if p.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {p.stderr.strip()[:300]}")
    data = json.loads(p.stdout or "{}")
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    return {
        "duration": float(data.get("format", {}).get("duration") or 0.0),
        "width": int(v.get("width") or 0),
        "height": int(v.get("height") or 0),
        "has_audio": has_audio,
    }


def _silence_bounds(path: str, duration: float) -> tuple[float, float]:
    """Leading/trailing silence trim, with the same guards as the old pipeline
    script: any parse problem falls back to (0, duration)."""
    p = _run(["ffmpeg", "-hide_banner", "-i", path,
              "-af", "silencedetect=noise=-30dB:d=0.6", "-f", "null", "-"])
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", p.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", p.stderr)]
    start, end = 0.0, duration
    if starts and ends and starts[0] < 0.5:
        s = ends[0]
        if 0.2 < s < duration / 2:
            start = s
    if starts:
        last = starts[-1]
        reaches_end = len(starts) > len(ends)
        if not reaches_end and ends and duration - ends[-1] < 0.6:
            reaches_end = True
        if reaches_end and last > start + 0.2 and duration - last > 0.3:
            end = last
    if end - start <= 0:
        start, end = 0.0, duration
    return start, end


def _extract_wav(path: str, dst: str) -> bool:
    p = _run(["ffmpeg", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
              "-c:a", "pcm_s16le", dst])
    return p.returncode == 0 and os.path.getsize(dst) > 0


def _whisper_srt(wav: str, language: str) -> str | None:
    """Transcribe via the local LlamaStash whisper proxy; returns SRT text or None."""
    key = _stt_api_key()
    boundary = uuid.uuid4().hex
    body: list[bytes] = []

    def part(name: str, value: str, filename: str | None = None,
             content_type: str = "text/plain") -> None:
        body.append(f"--{boundary}\r\n".encode())
        disp = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disp = f'Content-Disposition: form-data; name="{name}"; filename="{filename}"'
        body.append(f"{disp}\r\nContent-Type: {content_type}\r\n\r\n".encode())
        body.append(value.encode() if isinstance(value, str) else value)
        body.append(b"\r\n")

    with open(wav, "rb") as fh:
        part("file", fh.read(), os.path.basename(wav), "audio/wav")
    part("model", STT_MODEL)
    part("response_format", "srt")
    if language:
        part("language", language)
    body.append(f"--{boundary}--\r\n".encode())

    req = urllib.request.Request(
        f"{STT_BASE}/audio/transcriptions",
        data=b"".join(body),
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=STT_TIMEOUT) as r:
            text = r.read().decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise RuntimeError(f"whisper transcription failed: {exc}") from exc
        # The proxy has no /v1/audio/transcriptions route in this LlamaStash build:
        # stt-transcribe finds the whisper launch's own port.
        cmd = os.path.expanduser("~/.local/bin/stt-transcribe")
        cp = subprocess.run([cmd, "--format", "srt", *(["--language", language] if language else []), wav],
                            capture_output=True, text=True, timeout=STT_TIMEOUT)
        if cp.returncode != 0:
            raise RuntimeError(f"whisper transcription failed: {cp.stderr[-200:]}") from exc
        text = "\n".join(l for l in cp.stdout.splitlines() if not l.startswith("✓")).strip()
    except Exception as exc:
        raise RuntimeError(f"whisper transcription failed: {exc}") from exc
    # SRT with at least one cue.
    return text if re.search(r"^\s*1\s*$", text, re.M) else None


def _latest_cached_video() -> Path | None:
    try:
        vids = [p for ext in VIDEO_EXTS
                for p in CACHE.glob(f"*{ext}")]
        vids += [p for ext in (e.upper() for e in VIDEO_EXTS)
                 for p in CACHE.glob(f"*{ext}")]
    except OSError:
        return None
    if not vids:
        return None
    return max(vids, key=lambda p: p.stat().st_mtime)


def _esc_filter_path(p: str) -> str:
    # Escape for use inside an ffmpeg filtergraph argument.
    return p.replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'")


mcp = FastMCP("video-edit")


@mcp.tool()
def video_edit(input_path: str = "", language: str = "", captions: bool = True) -> str:
    """Edit a video the user sent: trim leading/trailing silence, normalize audio to
    -14 LUFS, optionally burn captions from the local Whisper transcriber. Keeps the
    original resolution and orientation; never edits the original in place.

    input_path: host path of the video (the media path from the user's message, e.g.
    under ~/.hermes/cache/videos/). Leave empty to edit the newest video in the cache.
    language: ISO language code for the captions (e.g. "es", "en"); empty = auto-detect.
    captions: burn subtitles from the local transcriber (default true; ignored when the
    video has no audio or the transcriber is unavailable, reported in the result).

    Returns JSON. Include the returned `media_line` verbatim as the last line of your
    final reply so the finished file is attached to the chat.
    """
    t0 = time.time()
    result: dict = {}
    work = tempfile.mkdtemp(prefix="video-edit-")
    try:
        # 1. Resolve the input.
        if input_path:
            src = Path(os.path.expanduser(input_path))
            if not src.is_file():
                return json.dumps({"error": f"input not found: {src}"})
        else:
            latest = _latest_cached_video()
            if latest is None:
                return json.dumps({"error": "no video in the cache; ask the user to send one"})
            src = latest
        result["input"] = str(src)
        base = src.stem

        # 2. Probe.
        info = _probe(str(src))
        if info["duration"] <= 0:
            return json.dumps({"error": f"could not determine duration of {src}"})
        result["input_duration"] = round(info["duration"], 2)
        result["resolution"] = f'{info["width"]}x{info["height"]}'

        # Work on a copy; the original stays untouched.
        src_copy = Path(work) / f"in{src.suffix.lower()}"
        shutil.copy2(src, src_copy)

        # 3. Silence bounds (audio only; a video with no audio never trims).
        start, end = 0.0, info["duration"]
        if info["has_audio"] and info["duration"] > 1.5:
            try:
                start, end = _silence_bounds(str(src_copy), info["duration"])
            except Exception:
                start, end = 0.0, info["duration"]
        result["trimmed_start"] = round(start, 2)
        result["kept_seconds"] = round(end - start, 2)

        # 4. Pass 1: trim + loudness (no captions yet; timestamps must match final).
        mid = Path(work) / "mid.mp4"
        args = ["ffmpeg", "-y", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}",
                "-i", str(src_copy),
                "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p"]
        if info["has_audio"]:
            args += ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k"]
        args += ["-movflags", "+faststart", str(mid)]
        p = _run(args)
        if p.returncode != 0 or not mid.stat().st_size:
            return json.dumps({"error": f"ffmpeg encode failed: {p.stderr.strip()[-300:]}"})

        # 5. Captions (optional): transcribe the trimmed audio, burn in pass 2.
        captioned = False
        captions_note = ""
        if captions and info["has_audio"]:
            wav = str(Path(work) / "audio.wav")
            srt = str(Path(work) / "captions.srt")
            try:
                if not _extract_wav(str(mid), wav):
                    raise RuntimeError("could not extract audio for transcription")
                srt_text = _whisper_srt(wav, language)
                if srt_text is None:
                    captions_note = "no speech detected; no captions burned"
                else:
                    Path(srt).write_text(srt_text, encoding="utf-8")
                    final = Path(work) / "final.mp4"
                    vf = f"subtitles='{_esc_filter_path(srt)}'"
                    p2 = _run(["ffmpeg", "-y", "-i", str(mid), "-vf", vf,
                               "-c:v", "libx264", "-crf", "20", "-preset", "medium",
                               "-pix_fmt", "yuv420p", "-c:a", "copy",
                               "-movflags", "+faststart", str(final)])
                    if p2.returncode == 0 and final.stat().st_size:
                        mid = final
                        captioned = True
                    else:
                        captions_note = f"caption burn-in failed: {p2.stderr.strip()[-200:]}"
            except Exception as exc:
                captions_note = f"captions skipped: {exc}"
        elif captions and not info["has_audio"]:
            captions_note = "video has no audio; captions not applicable"
        result["captions"] = captioned
        if captions_note:
            result["captions_note"] = captions_note

        # 6. Move into the out dir.
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        out = OUT_DIR / f"{base}-edited.mp4"
        shutil.move(str(mid), out)
        outdur = _probe(str(out))["duration"]

        result["output"] = str(out)
        result["output_duration"] = round(outdur, 2)
        result["elapsed_seconds"] = round(time.time() - t0, 1)
        result["media_line"] = f"MEDIA: {out}"
        result["instruction"] = ("Send a short summary (what was trimmed, audio normalized, "
                                 f"captions {'burned in' if captioned else 'not burned in'}) and end "
                                 "your reply with the media_line above, verbatim, on its own line.")
        return json.dumps(result, ensure_ascii=False)
    except subprocess.TimeoutExpired:
        return json.dumps({"error": "timed out; the video may be too long"})
    except Exception as exc:
        return json.dumps({"error": str(exc)})
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    mcp.run()
