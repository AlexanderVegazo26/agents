#!/usr/bin/env python3
"""vexa-agent — let the meeting bot actually participate.

Vexa joins the call, transcribes and can speak (through the local voice patch),
but nothing decides *what* it should say or *when*. This is that loop: it
watches the transcript, thinks with a local model, and speaks when it has
something worth saying.

  vexa-agent --meeting-id abc-defg-hij                run the loop
  vexa-agent --meeting-id abc-defg-hij --once         one beat, print the decision
  vexa-agent --meeting-id abc-defg-hij --dry-run      decide, never speak
  vexa-agent --meeting-id abc-defg-hij --tier deep     use Qwen3.8-27B instead of the 35B

How a beat works:
  1. Is the bot still in the call? (GET /bots/status)
  2. What was said since the last beat? (GET /transcripts/{platform}/{id})
  3. What is on the screen? (optional, vexa_screen — reads the bot's display)
  4. Decide with the local model: speak, or stay silent, or flag a question
     for Alexander.
  5. Speak, if it decided to: POST /bots/{platform}/{id}/speak

The model is the brain, this is the plumbing. The rules the model follows are
in RULES below — most beats end in silence, on purpose: a bot that talks over
people is worse than a bot that takes notes.

The persona defaults to ~/.hermes/SOUL.md so the voice in the call is the same
voice as in the chat.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vexa_screen  # noqa: E402
import vexa_cdp  # noqa: E402

HOME = Path(os.path.expanduser("~"))
DEFAULT_GATEWAY = "http://127.0.0.1:8056"
ENV_FILE = HOME / ".hermes/.env"
PERSONA_FILE = HOME / ".hermes/SOUL.md"
LOG_DIR = HOME / ".local/state/vexa-agent"

# The one message the bot may send without being asked: everyone in the call is being
# recorded and most of them did not invite the bot, so it says so out loud, once, before
# anything else.
ANNOUNCE_TEXT = (
    "Hi, I'm Hermes, an AI note-taker for Alexander. I'm recording and transcribing this "
    "meeting to take notes. If you'd rather I didn't, say so and I'll leave."
)

RULES = """
You are in a live meeting. You are Hermes, an AI assistant working for Alexander
(who is in the meeting and owns the notes). You are taking notes, and you may
occasionally speak out loud when it is genuinely useful.

You get one turn per beat. Most beats you say nothing.

Answer with EXACTLY this structure:

DECISION: SILENT
or
DECISION: SPEAK
TEXT: <the words to say out loud>
QUESTION_FOR_ALEXANDER: <optional — a question that is addressed to Alexander
personally and that you must not answer yourself>

Rules for the decision:
- SILENT is the normal answer. Speak only when you have something to add.
- SPEAK only when: someone asked a question you can answer from what you know;
  a number or fact said in the meeting is clearly wrong; a decision is being
  skipped and one sentence would settle it; a risk or objection was raised and
  dropped; or you can move Alexander's goal forward with a fact you have.
- Do NOT speak to fill silence, to agree, to summarise what was said, to say
  hello again, or to state your own status. Notes are the job; talking is the
  exception.
- If the question is addressed to YOU (someone says "Hermes, ...") and you can
  answer it from what you know, from the transcript, or from the screen, answer
  it out loud. If you cannot answer it yet, say in one sentence that you will
  check and come back with it.
- Only a question about Alexander personally (his business, his clients, his
  money, his commitments, his family) goes to QUESTION_FOR_ALEXANDER — and you
  do not answer it yourself.
- Never invent a fact, number, name, date or commitment. If you do not know,
  say you will follow up — do not guess.
- Stay honest: you are an AI, not a person. Never claim to be human.
- TEXT: at most two sentences, under ~25 words each, no markdown, no stage
  directions, no quotation marks, written in the language the meeting is in.
- If a screen is being shared and it shows something that changes the answer
  (a number on the slide, a document title, a name), you may use it.
"""


class VexaError(RuntimeError):
    pass


def load_api_key(env_file: Path = ENV_FILE) -> str:
    if not env_file.exists():
        raise VexaError(f"{env_file} not found — no Vexa API key")
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith("MCP_VEXA_API_KEY="):
            key = line.split("=", 1)[1].strip().strip("'\"")
            if key:
                return key
    raise VexaError("MCP_VEXA_API_KEY is not set in ~/.hermes/.env")


class Vexa:
    def __init__(self, base_url: str = DEFAULT_GATEWAY, api_key: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or load_api_key()

    def _request(self, method: str, path: str, body: dict | None = None, timeout: int = 30):
        req = urllib.request.Request(f"{self.base_url}{path}", method=method)
        req.add_header("X-API-Key", self.api_key)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
                try:
                    return r.status, json.loads(raw)
                except json.JSONDecodeError:
                    return r.status, raw
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except json.JSONDecodeError:
                return e.code, raw
        except urllib.error.URLError as e:
            raise VexaError(f"cannot reach the Vexa gateway at {self.base_url}: {e.reason}") from e

    def bots_status(self) -> list[dict]:
        _, data = self._request("GET", "/bots/status")
        return (data or {}).get("running_bots") or []

    def transcript(self, platform: str, native_id: str) -> list[dict]:
        _, data = self._request("GET", f"/transcripts/{platform}/{native_id}")
        if isinstance(data, dict):
            return data.get("segments") or []
        return []

    def speak(self, platform: str, native_id: str, text: str) -> tuple[int, object]:
        return self._request(
            "POST", f"/bots/{platform}/{native_id}/speak", {"text": text[:2000]}
        )


def find_bot(bots: list[dict], platform: str, native_id: str) -> dict | None:
    for b in bots:
        if b.get("platform") == platform and b.get("native_meeting_id") == native_id:
            return b
    return None


def segments_to_text(segments: list[dict]) -> str:
    out = []
    for s in segments:
        who = s.get("speaker") or "someone"
        text = (s.get("text") or "").strip()
        if not text:
            continue
        out.append(f"{who}: {text}")
    return "\n".join(out)


def ask_model(
    system: str,
    transcript: str,
    screen: str | None,
    tier: str,
    timeout: int = 300,
) -> str:
    """Ask the local model for this beat's decision. Returns the raw answer."""
    body = []
    if screen:
        body.append(f"[What is on the screen right now]\n{screen}\n")
    body.append("[What has been said in the meeting so far]\n")
    body.append(transcript or "(no speech transcribed yet)")
    prompt = (
        "This is the latest transcript of the meeting. Decide whether to speak.\n\n"
        + "\n\n".join(body)
    )
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write(prompt)
        path = fh.name
    try:
        cmd = [
            "llm-ask", "--tier", tier, "-f", path,
            "--system", system, "--label", "vexa-agent",
            "Decide: speak, stay silent, or flag a question for Alexander. "
            "Follow the output format exactly.",
        ]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if p.returncode != 0:
            err = (p.stderr or p.stdout or "").strip().splitlines()
            raise VexaError(err[-1] if err else f"llm-ask exited {p.returncode}")
        return (p.stdout or "").strip()
    finally:
        Path(path).unlink(missing_ok=True)


LABELS = ("DECISION", "TEXT", "QUESTION_FOR_ALEXANDER")


def _split_sections(raw: str) -> dict[str, str]:
    """Split the answer into its labelled sections.

    Labels start a line, but a model sometimes puts two of them on one line
    ("TEXT: ... QUESTION_FOR_ALEXANDER: ..."), so an embedded label is split out
    of whatever section holds it.
    """
    sections: dict[str, str] = {}
    current: str | None = None
    buf: list[str] = []
    for line in raw.splitlines():
        m = re.match(r"\s*([A-Za-z][A-Za-z_]{3,})\s*:\s*(.*)$", line)
        if m and m.group(1).upper() in LABELS:
            if current:
                sections[current] = "\n".join(buf).strip()
            current = m.group(1).upper()
            buf = [m.group(2)]
        elif current:
            buf.append(line)
    if current:
        sections[current] = "\n".join(buf).strip()

    text = sections.get("TEXT", "")
    embedded = re.search(r"QUESTION_FOR_ALEXANDER\s*:", text)
    if embedded:
        question = text[embedded.end():].strip()
        text = text[: embedded.start()].strip()
        sections["TEXT"] = text
        sections.setdefault("QUESTION_FOR_ALEXANDER", question)
    return sections


def parse_decision(raw: str) -> dict:
    """Read the model's answer. Labels are authoritative; SILENT always wins."""
    decision = {"speak": False, "text": "", "question": ""}
    if not raw:
        return decision

    sections = _split_sections(raw)
    say = sections.get("DECISION", "").strip().upper()
    speak = say.startswith("SPEAK")
    text = sections.get("TEXT", "").strip()
    question = sections.get("QUESTION_FOR_ALEXANDER", "").strip()

    # SILENT means silent — never let leftover prose turn into a spoken line.
    if not speak:
        text = ""
    return {"speak": speak, "text": text, "question": question}


def notify_telegram(message: str) -> bool:
    """Tell the human on Telegram. Best effort — never let it break the loop."""
    try:
        p = subprocess.run(
            ["hermes", "send", "-t", "telegram", message],
            capture_output=True, text=True, timeout=60,
        )
        return p.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def post_to_chat(text: str) -> tuple[int, str, str]:
    """Write a line into the meeting chat, driving the bot's own browser over CDP.

    The bot sits in the call in a Chromium inside the vexa-lite container; the local CDP patch
    gives it a DevTools port, and the driver runs inside that container where Playwright lives.
    Returns (exit code, stdout, stderr) — 0 means the message was sent and verified.
    """
    try:
        code, out, err = vexa_cdp.run_driver(["chat", "--text", text])
    except Exception as exc:  # never let the chat break the loop
        return 1, "", str(exc)
    return code, out, err


def log_line(path: Path, message: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with path.open("a") as fh:
        fh.write(f"{stamp} {message}\n")


def main() -> int:
    ap = argparse.ArgumentParser(prog="vexa-agent", description=__doc__.splitlines()[0])
    ap.add_argument("--meeting-id", required=True, help="the native meeting id (e.g. abc-defg-hij)")
    ap.add_argument("--platform", default="google_meet", choices=["google_meet", "teams", "zoom", "jitsi"])
    ap.add_argument("--gateway", default=DEFAULT_GATEWAY)
    ap.add_argument("--beat", type=int, default=45, help="seconds between beats")
    ap.add_argument("--min-gap", type=int, default=90, help="minimum seconds between spoken lines")
    ap.add_argument("--tier", default="agent", help="llm-ask tier to think with (agent=35B, deep=27B)")
    ap.add_argument("--persona", default=str(PERSONA_FILE), help="persona file (default: SOUL.md)")
    ap.add_argument("--screen", action="store_true", help="also read what is on the shared screen")
    ap.add_argument("--announce", action="store_true",
                    help="announce once that the bot is recording and taking notes")
    ap.add_argument("--announce-text", default=ANNOUNCE_TEXT, help="what to say when announcing")
    ap.add_argument("--chat", action="store_true",
                    help="post the line to the meeting chat as well (drives the bot's browser over CDP)")
    ap.add_argument("--no-speak", action="store_true",
                    help="decide and chat, but stay quiet out loud")
    ap.add_argument("--screen-interval", type=int, default=120, help="seconds between screen looks")
    ap.add_argument("--notify", action="store_true", help="send questions for Alexander to Telegram")
    ap.add_argument("--dry-run", action="store_true", help="decide, but never speak")
    ap.add_argument("--once", action="store_true", help="one beat and exit")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    try:
        vexa = Vexa(args.gateway)
    except VexaError as e:
        print(f"vexa-agent: {e}", file=sys.stderr)
        return 1

    persona = ""
    p = Path(args.persona)
    if p.exists():
        persona = p.read_text()
    system = (persona + "\n\n" + RULES).strip()

    log_path = LOG_DIR / f"{args.platform}-{args.meeting_id}.log"
    seen = 0
    last_spoke = 0.0
    last_screen = 0.0
    screen_text: str | None = None
    announced = False

    while True:
        try:
            bots = vexa.bots_status()
        except VexaError as e:
            print(f"vexa-agent: {e}", file=sys.stderr)
            return 1

        bot = find_bot(bots, args.platform, args.meeting_id)
        if not bot:
            log_line(log_path, "bot not in the call any more — leaving the loop")
            print("vexa-agent: the bot is no longer in the meeting — stopping")
            return 0

        # Announce once, before anything else is said in the call.
        if args.announce and not announced:
            announced = True
            code, body = vexa.speak(args.platform, args.meeting_id, args.announce_text)
            log_line(log_path, f"announce -> {code}: {args.announce_text[:80]} ({str(body)[:120]})")
            if code != 200:
                log_line(log_path, "announcement failed — the bot is in the call unannounced; say so")
                print(f"vexa-agent: the announcement failed ({code}); the bot is in the call UNANNOUNCED", file=sys.stderr)
            if args.once:
                print(json.dumps({"decision": "ANNOUNCED", "speak_code": code}))
                return 0
            time.sleep(3)

        try:
            segments = vexa.transcript(args.platform, args.meeting_id)
        except VexaError as e:
            print(f"vexa-agent: {e}", file=sys.stderr)
            return 1

        new = segments[seen:]
        if not new:
            if args.once:
                print(json.dumps({"decision": "SILENT", "reason": "no new speech"}))
                return 0
            time.sleep(args.beat)
            continue
        seen = len(segments)

        if args.screen and time.time() - last_screen >= args.screen_interval:
            last_screen = time.time()
            res = vexa_screen.look()
            screen_text = res["description"] if res["ok"] and not res["blank"] else None
            if res["error"]:
                log_line(log_path, f"screen unavailable: {res['error']}")

        transcript = segments_to_text(new)
        try:
            raw = ask_model(system, transcript, screen_text, args.tier)
        except VexaError as e:
            log_line(log_path, f"model failed: {e}")
            print(f"vexa-agent: model failed: {e}", file=sys.stderr)
            if args.once:
                return 1
            time.sleep(args.beat)
            continue

        decision = parse_decision(raw)
        now = time.time()

        if decision["question"] and args.notify:
            ok = notify_telegram(f"❓ {decision['question']}\n\n_asked in the {args.platform} meeting_")
            log_line(log_path, f"question for Alexander (telegram={'sent' if ok else 'failed'}): {decision['question'][:120]}")

        spoke = False
        if decision["speak"] and decision["text"]:
            if now - last_spoke < args.min_gap:
                log_line(log_path, f"skipped (min gap): {decision['text'][:80]}")
            elif args.dry_run:
                log_line(log_path, f"dry-run would say: {decision['text'][:120]}")
                spoke = True
            else:
                if args.chat:
                    # Post into the meeting chat by driving the bot's own browser over CDP
                    # (the local patch opens its DevTools port). Chat is written in front of
                    # everyone and cannot be recalled — same weight as speaking.
                    rc, out, err = post_to_chat(decision["text"])
                    log_line(log_path, f"chat -> {rc}: {decision['text'][:120]} ({out.strip()[:120]})")
                if not args.no_speak:
                    code, body = vexa.speak(args.platform, args.meeting_id, decision["text"])
                    spoke = code == 200
                    log_line(log_path, f"speak -> {code}: {decision['text'][:160]} ({str(body)[:120]})")
                    if code == 409:
                        log_line(log_path, "bot not admitted yet — will retry on the next beat")
                else:
                    spoke = True
        else:
            log_line(log_path, f"silent ({len(new)} new segment(s))")

        if decision["speak"] and spoke:
            last_spoke = now

        if args.once:
            print(json.dumps({
                "decision": "SPEAK" if decision["speak"] else "SILENT",
                "text": decision["text"],
                "question": decision["question"],
                "spoken": spoke,
                "raw": raw,
            }, indent=2))
            return 0

        time.sleep(args.beat)


if __name__ == "__main__":
    raise SystemExit(main())
