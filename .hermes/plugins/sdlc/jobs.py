"""Background jobs for the sdlc plugin: a record, a systemd unit, a Telegram card.

Every long request from the phone (/idea, /idea-cloud, /implement, …) is one
job:

  ~/.local/state/sdlc-jobs/<id>/job.json   the record (host-only, 0600)
  sdlc-job-<id>.service                    a transient systemd *user* unit
  one Telegram message                     the status card, edited in place,
                                           with ⏸ Pause / ▶️ Resume / ⏹ Stop /
                                           🔁 Run again buttons

Why a systemd unit and not a detached child of the gateway: the gateway's own
unit runs with KillMode=mixed and a cgroup sweep on stop, so every
`hermes gateway restart` used to SIGKILL each build that was running. A unit
of its own survives that, and it gives the controls for free — pause is
`systemctl --user freeze` (the cgroup freezer stops the whole process tree,
nested `hermes chat` sessions included), resume is `thaw`, stop is `stop`
(SIGTERM to the pipeline, which stops its sessions and reports). Without
systemd-run the job falls back to a detached process group and signals.

Concurrency is bounded by slot locks: SDLC_MAX_JOBS jobs at once (default
4), of which SDLC_MAX_LOCAL_JOBS (default 1) on the local models — the local
llama-server is started with --parallel 1, so two local jobs would only
queue behind each other there and trip Hermes's stale-call timeout — and
SDLC_MAX_CLOUD_JOBS (default 1) on the Command Code cloud, whose plan
rate-limits concurrent runs. So by default one local and one cloud job run
side by side. A job past its slot waits as "queued".

The card's buttons send `sdlc:<action>:<id>` callbacks, which the plugin's
Telegram handler (``__init__.py``) routes back here. Standard library only:
this module is imported both by the gateway (plugin) and by the pipelines
running inside the units.
"""

from __future__ import annotations

import contextlib
import fcntl
import html
import json
import logging
import os
import re
import secrets
import shutil
import signal
import subprocess
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("sdlc.jobs")

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
JOBS_BASE = Path(os.environ.get("SDLC_JOBS_STATE") or Path.home() / ".local" / "state" / "sdlc-jobs")
ID_RE = re.compile(r"^[0-9a-f]{8}$")
CALLBACK_RE = re.compile(r"^sdlc:(pause|resume|stop|again|refresh|discard):([0-9a-f]{8})$")
UNIT_PREFIX = "sdlc-job-"
ACTIVE = ("queued", "running", "paused", "stopping")
HEARTBEAT = 60  # seconds between card refreshes while a step runs
# A pause stops the clock on the pipeline's own budget, but the runner's
# per-session timer is plain wall time. This much pause is absorbed before
# that timer could fire under a paused job.
PAUSE_ALLOWANCE = 12 * 3600

KINDS = {
    "idea": "🧪 Prototype",
    "idea-cloud": "☁️ Prototype",
    "implement": "🧩 Implement",
    "implement-cloud": "☁️ Implement",
}
STATUS = {
    "queued": ("⏳", "Queued"), "running": ("▶️", "Running"), "paused": ("⏸", "Paused"),
    "stopping": ("⏹", "Stopping…"), "stopped": ("⏹", "Stopped"), "failed": ("❌", "Failed"),
    "done": ("✅", "Done"),
}
# Systemd properties passed to every unit. Env is forwarded by allowlist: a
# unit's environment is readable with `systemctl --user show`, so no secret
# goes on the command line — the pipelines read ~/.hermes/.env themselves.
FORWARD_ENV = ("PATH", "HOME", "LANG", "LC_ALL", "USER", "LOGNAME", "HERMES_HOME", "HERMES_BIN",
               "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "TERMINAL_CWD", "NVM_DIR", "NVM_BIN")
FORWARD_PREFIXES = ("SDLC_", "HERMES_SDLC_")


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name) or default))
    except ValueError:
        log.warning("%s=%r is not a number; using %d", name, os.environ.get(name), default)
        return default


def max_jobs() -> int:
    return _int_env("SDLC_MAX_JOBS", 4)


def max_local_jobs() -> int:
    return _int_env("SDLC_MAX_LOCAL_JOBS", 1)


def max_cloud_jobs() -> int:
    return _int_env("SDLC_MAX_CLOUD_JOBS", 1)


# --------------------------------------------------------------------------- records

def _dir(jid: str) -> Path:
    if not ID_RE.match(jid or ""):
        raise ValueError(f"bad job id {jid!r}")
    return JOBS_BASE / jid


def _write(jid: str, job: dict) -> None:
    d = _dir(jid)
    tmp = d / f".job.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(job, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, d / "job.json")


@contextlib.contextmanager
def _locked(jid: str):
    fh = open(_dir(jid) / "job.lock", "a")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield
    finally:
        fh.close()


def create(kind: str, text: str, **extra) -> dict:
    JOBS_BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    for _ in range(50):
        jid = secrets.token_hex(4)
        try:
            _dir(jid).mkdir(mode=0o700)
            break
        except FileExistsError:
            continue
    else:
        raise RuntimeError("could not allocate a job id")
    now = time.time()
    job = {"id": jid, "kind": kind, "text": text, "status": "queued", "step": "queued",
           "created": now, "updated": now, "step_since": now, "started": None,
           "paused_total": 0.0, "paused_at": None, "unit": None, "pid": None, "pid_start": None,
           "chat": default_chat(), "message_id": None, "links": [], "result_html": "", **extra}
    _write(jid, job)
    return job


def load(jid: str) -> dict | None:
    try:
        return json.loads((_dir(jid) / "job.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def update(jid: str, **fields) -> dict:
    with _locked(jid):
        job = load(jid) or {"id": jid}
        job.update(fields)
        job["updated"] = time.time()
        _write(jid, job)
        return job


def recent(limit: int = 10) -> list[dict]:
    if not JOBS_BASE.is_dir():
        return []
    jobs = [j for p in JOBS_BASE.iterdir() if ID_RE.match(p.name) and (j := load(p.name))]
    jobs.sort(key=lambda j: j.get("created") or 0, reverse=True)
    return [reconcile(j) for j in jobs[:limit]]


def active(exclude: str | None = None) -> list[dict]:
    return [j for j in recent(200) if j.get("status") in ACTIVE and j.get("id") != exclude]


def paused_seconds(job: dict) -> float:
    total = float(job.get("paused_total") or 0)
    if job.get("status") == "paused" and job.get("paused_at"):
        total += time.time() - float(job["paused_at"])
    return total


# --------------------------------------------------------------------------- processes

def _systemctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=30)


def _proc_start(pid: int) -> str | None:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


LAUNCH_GRACE = 120  # seconds a record may sit with no unit or pid (create → launch)


def alive(job: dict) -> bool | None:
    """True/False when known, None when systemd could not be asked — a
    transient bus error must never be mistaken for a dead job."""
    if job.get("unit"):
        try:
            r = _systemctl("show", "-p", "ActiveState", "--value", job["unit"])
        except (OSError, subprocess.SubprocessError):
            return None
        state = r.stdout.strip()
        if r.returncode != 0 or not state:
            return None
        return state not in ("inactive", "failed")  # a collected unit reads back as inactive
    pid = job.get("pid")
    if pid:
        return _proc_start(int(pid)) == job.get("pid_start")
    return None


def reconcile(job: dict) -> dict:
    """A record still marked active whose process is gone (killed with -9, a
    reboot, a launch that never happened) is reported as failed, so its card
    offers Run again."""
    if job.get("status") not in ACTIVE:
        return job
    if job.get("unit") or job.get("pid"):
        if alive(job) is False:
            job = _fail_if_active(job["id"], f"lost while {job.get('step')!r} — the process is gone")
    elif time.time() - float(job.get("created") or 0) > LAUNCH_GRACE:
        job = _fail_if_active(job["id"], "never started — the launch did not happen")
    return job


def _fail_if_active(jid: str, step: str) -> dict:
    with _locked(jid):
        job = load(jid) or {"id": jid}
        if job.get("status") in ACTIVE:
            job.update(status="failed", step=step, updated=time.time())
            _write(jid, job)
        return job


def launch(job: dict, argv: list[str], cwd: Path, env_extra: dict | None = None) -> dict:
    """Start the job's process as `sdlc-job-<id>.service`, or detached when
    systemd-run is unavailable. Returns the updated record."""
    jid = job["id"]
    logfile = _dir(jid) / "job.log"
    env = {k: os.environ[k] for k in FORWARD_ENV if os.environ.get(k)}
    env.update({k: v for k, v in os.environ.items() if k.startswith(FORWARD_PREFIXES)})
    env.update(env_extra or {})
    env["SDLC_JOB_ID"] = jid
    unit = f"{UNIT_PREFIX}{jid}"
    if shutil.which("systemd-run") and not os.environ.get("SDLC_JOBS_NO_SYSTEMD"):
        cmd = ["systemd-run", "--user", "--unit", unit, "--collect", "--quiet",
               "--working-directory", str(cwd), "--description", f"sdlc {job.get('kind')} job {jid}",
               "-p", "KillMode=mixed", "-p", "TimeoutStopSec=60",
               "-p", f"StandardOutput=append:{logfile}", "-p", f"StandardError=append:{logfile}"]
        for k, v in env.items():
            cmd += ["--setenv", f"{k}={v}"]
        r = subprocess.run([*cmd, "--", *argv], capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            return update(jid, unit=unit)
        log.warning("systemd-run failed (%s): %s — starting %s detached", r.returncode, r.stderr.strip(), jid)
    fd = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=fd, stderr=fd, cwd=str(cwd),
                                start_new_session=True, env={**os.environ, **env})
    finally:
        os.close(fd)
    return update(jid, pid=proc.pid, pid_start=_proc_start(proc.pid))


def _tree(pid: int) -> list[int]:
    """pid and every descendant (the fallback path's pause/stop targets)."""
    children: dict[int, list[int]] = {}
    for p in Path("/proc").iterdir():
        if p.name.isdigit():
            try:
                ppid = int((p / "stat").read_text().rsplit(")", 1)[1].split()[1])
            except (OSError, IndexError, ValueError):
                continue
            children.setdefault(ppid, []).append(int(p.name))
    out, stack = [], [pid]
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(children.get(cur, []))
    return out


def _signal_tree(job: dict, sig: int) -> bool:
    """Signal the recorded pid and its descendants. Not killpg: the scout and
    a terminal run are not process-group leaders."""
    pid = job.get("pid")
    if not pid or _proc_start(int(pid)) != job.get("pid_start"):
        return False
    for p in _tree(int(pid)):
        with contextlib.suppress(OSError):
            os.kill(p, sig)
    return True


def pause(jid: str) -> str:
    # The lock is held across the freeze and the write: the pipeline can then
    # never be frozen while it holds job.lock (which would hang every later
    # tap), and nothing it writes can land between our check and our write.
    with _locked(jid):
        job = load(jid) or {}
        if job.get("status") != "running":
            return f"Not running ({job.get('status', 'unknown')})."
        if job.get("unit"):
            r = _systemctl("freeze", job["unit"])
            if r.returncode != 0:
                return f"Could not pause: {r.stderr.strip()[:150]}"
        elif not _signal_tree(job, signal.SIGSTOP):
            return "Could not pause: the process is gone."
        job.update(status="paused", paused_at=time.time(), updated=time.time())
        _write(jid, job)
    return "Paused. Model calls already sent finish server-side; nothing new starts."


def resume(jid: str) -> str:
    with _locked(jid):
        job = load(jid) or {}
        if job.get("status") != "paused":
            return f"Not paused ({job.get('status', 'unknown')})."
        # Book the pause BEFORE the process wakes: its budget check reads this.
        job["paused_total"] = paused_seconds(job)
        job.update(status="running", paused_at=None, updated=time.time())
        _write(jid, job)
    if job.get("unit"):
        r = _systemctl("thaw", job["unit"])
        if r.returncode != 0:
            return f"Could not resume: {r.stderr.strip()[:150]}"
    else:
        _signal_tree(job, signal.SIGCONT)
    return "Resumed."


def stop(jid: str) -> str:
    if (load(jid) or {}).get("status") == "paused":
        resume(jid)  # a frozen process cannot take its SIGTERM
    with _locked(jid):
        job = load(jid) or {}
        if job.get("status") not in ACTIVE:
            return f"Already {job.get('status', 'gone')}."
        job.update(status="stopping", stop_requested=time.time(), updated=time.time())
        _write(jid, job)
    if job.get("unit"):
        r = _systemctl("stop", "--no-block", job["unit"])
        if r.returncode != 0:
            return f"Could not stop: {r.stderr.strip()[:150]}"
    elif not _signal_tree(job, signal.SIGTERM):
        _fail_if_active(jid, "stopped — the process was already gone")
    return "Stopping — the card updates when everything is down."


# --------------------------------------------------------------------------- slots

def acquire_slots(job: dict, local: bool, on_wait=None, poll: float = 5.0) -> list:
    """Block until this job holds a total slot and one in its tier's pool
    (local models, or the Command Code cloud — whose plan rate-limits two
    concurrent pipelines: measured 2026-10-07, HTTP 429 within two minutes).
    Returns the open lock files; they release on exit."""
    JOBS_BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    tier = ("local", max_local_jobs()) if local else ("cloud", max_cloud_jobs())
    while True:
        held = []
        for pool, n in (("slot", max_jobs()), tier):
            for i in range(n):
                fh = open(JOBS_BASE / f".{pool}-{i}.lock", "a")
                try:
                    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held.append(fh)
                    break
                except BlockingIOError:
                    fh.close()
            else:
                break
        if len(held) == 2:
            return held
        for fh in held:
            fh.close()
        if on_wait:
            on_wait()
        time.sleep(poll)


def models_in_use(exclude: str | None = None) -> set[str]:
    """Local models other running jobs are on — never unloaded to make room."""
    return {j["model"] for j in active(exclude) if j.get("model") and j.get("status") in ("running", "paused")}


# --------------------------------------------------------------------------- telegram

def env_file() -> dict:
    env = dict(os.environ)
    with contextlib.suppress(OSError):
        for line in (HERMES_HOME / ".env").read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip("\"'"))
    return env


def default_chat(env: dict | None = None) -> str:
    """SDLC_PROTOTYPE_CHAT, else the first allowlisted user (a DM's chat id is
    the user id). Never a group: the card is for the requester."""
    env = env or env_file()
    return env.get("SDLC_PROTOTYPE_CHAT") or env.get("TELEGRAM_ALLOWED_USERS", "").split(",")[0].strip()


def tg(method: str, payload: dict) -> dict | None:
    """One Bot API call; None on failure (logged without the token)."""
    token = env_file().get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        log.error("TELEGRAM_BOT_TOKEN is missing from %s/.env", HERMES_HOME)
        return None
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}",
                                 json.dumps(payload).encode(), {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 — fixed host
            return json.load(r)
    except Exception as ex:  # HTTPError carries Telegram's reason in its body
        detail = getattr(ex, "read", lambda: b"")().decode("utf-8", "replace") or str(ex)
        if "message is not modified" not in detail:
            log.error("telegram %s failed: %s", method, detail[:300].replace(token, "<token>"))
        return {"ok": False, "description": detail[:300].replace(token, "<token>")}


def plain(html_text: str) -> str:
    """The text of our HTML, for when Telegram refuses the markup."""
    return html.unescape(re.sub(r"<[^>]+>", "", html_text or ""))


def send_html(method: str, payload: dict) -> dict | None:
    """sendMessage/editMessageText with HTML, and once more as plain text if
    Telegram cannot parse it or it is too long — a result must never vanish
    because of its formatting."""
    text = payload.get("text") or ""
    if len(text) <= 4096:
        r = tg(method, payload)
        if r and (r.get("ok") or "not modified" in str(r.get("description"))):
            return r
        if r and "parse" not in str(r.get("description")).lower() and "too long" not in str(r.get("description")):
            return r
    body = plain(text)
    if len(body) > 4096:
        body = body[:4000] + "\n… (truncated)"
    return tg(method, {k: v for k, v in payload.items() if k != "parse_mode"} | {"text": body})


def esc(s, limit: int = 600) -> str:
    s = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(s or "")).strip()
    return html.escape(s if len(s) <= limit else s[: limit - 1] + "…")


def _dur(seconds: float) -> str:
    s = int(max(0, seconds))
    return f"{s // 3600}h{s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60}m{s % 60:02d}s"


def button(label: str, action: str, jid: str) -> dict:
    return {"text": label, "callback_data": f"sdlc:{action}:{jid}"}


def keyboard(job: dict) -> list[list[dict]]:
    jid, st = job["id"], job.get("status")
    if st == "running":
        rows = [[button("⏸ Pause", "pause", jid), button("⏹ Stop", "stop", jid)]]
    elif st == "paused":
        rows = [[button("▶️ Resume", "resume", jid), button("⏹ Stop", "stop", jid)]]
    elif st == "queued":
        rows = [[button("⏹ Cancel", "stop", jid), button("🔄 Refresh", "refresh", jid)]]
    elif st == "stopping":
        rows = [[button("🔄 Refresh", "refresh", jid)]]
    else:
        rows = [[{"text": label, "url": url}] for label, url in (job.get("links") or [])]
        last = [button("🔁 Run again", "again", jid)]
        if job.get("worktree") and job.get("status") in ("done", "failed", "stopped") and not job.get("discarded"):
            last.append(button("🗑 Discard branch", "discard", jid))
        rows.append(last)
    return rows


def card(job: dict) -> str:
    icon, label = STATUS.get(job.get("status"), ("•", str(job.get("status"))))
    title = KINDS.get(job.get("kind"), job.get("kind") or "Job")
    name = job.get("slug") or job.get("branch") or job["id"]
    lines = [f"{title} · <code>{esc(name, 90)}</code>", f"{icon} <b>{label}</b> — {esc(job.get('step'), 200)}"]
    now = time.time()
    began = job.get("started") or job.get("created") or now
    end = now if job.get("status") in ACTIVE else (job.get("finished") or job.get("updated") or now)
    run_for = end - began - paused_seconds(job)
    if job.get("status") in ("running", "paused"):
        lines.append(f"⏱ {_dur(run_for)} running · this step {_dur(now - (job.get('step_since') or now))}"
                     + (f" · paused {_dur(paused_seconds(job))}" if paused_seconds(job) >= 1 else ""))
    elif job.get("status") in ("done", "failed", "stopped"):
        lines.append(f"⏱ {_dur(run_for)}")
    if job.get("where"):
        lines.append(esc(job["where"], 200))
    lines += ["", f"<i>{esc(job.get('text'), 300)}</i>"]
    if job.get("result_html"):
        lines += ["", job["result_html"]]  # built by the pipeline from escaped parts
    lines += ["", f"job <code>{job['id']}</code> · /jobs lists every job"]
    return "\n".join(lines)  # every part is bounded where it is escaped; never slice the HTML


def post_status(job: dict, new: bool = False) -> dict:
    """Send or edit the job's card. A card that can no longer be edited (deleted,
    too old) is sent again, so the controls never vanish."""
    chat = job.get("chat") or default_chat()
    if not chat:
        return job
    payload = {"chat_id": chat, "text": card(job), "parse_mode": "HTML",
               "link_preview_options": {"is_disabled": True},
               "reply_markup": {"inline_keyboard": keyboard(job)}}
    if job.get("message_id") and not new:
        r = send_html("editMessageText", {**payload, "message_id": job["message_id"]})
        if r and (r.get("ok") or "not modified" in str(r.get("description"))):
            return job
    r = send_html("sendMessage", payload)
    if r and r.get("ok"):
        job = update(job["id"], message_id=r["result"]["message_id"], chat=chat)
    return job


def notify(job: dict, html_text: str, links: list | None = None) -> None:
    """A separate message (edits do not notify the phone) with the job's
    final buttons under it."""
    rows = [[{"text": label, "url": url}] for label, url in (links or [])]
    rows.append([button("🔁 Run again", "again", job["id"])])
    send_html("sendMessage", {"chat_id": job.get("chat") or default_chat(), "text": html_text,
                       "parse_mode": "HTML", "link_preview_options": {"is_disabled": not links},
                       "reply_markup": {"inline_keyboard": rows}})


class Tracker:
    """The pipeline's side of a job: step changes, heartbeats, the
    pause-aware clock. Every method is safe to call when Telegram is down."""

    def __init__(self, jid: str):
        self.jid = jid
        self._last_post = 0.0
        self._paused = (0.0, 0.0)  # (value, read at)

    @property
    def job(self) -> dict:
        return load(self.jid) or {"id": self.jid}

    def step(self, text: str, **fields) -> str:
        job = update(self.jid, step=text, step_since=time.time(), **fields)
        self._post(job)
        return text

    def set(self, **fields) -> dict:
        return update(self.jid, **fields)

    def start(self) -> dict:
        """queued → running, unless a ⏹ landed while it was queued (then the
        status stays "stopping" and the SIGTERM on its way is ours)."""
        with _locked(self.jid):
            job = load(self.jid) or {"id": self.jid}
            if job.get("status") == "queued":
                job.update(status="running", started=time.time(), updated=time.time())
                _write(self.jid, job)
            return job

    def _post(self, job: dict) -> None:
        self._last_post = time.time()
        try:
            post_status(job)
        except Exception as ex:  # noqa: BLE001 — the card is a convenience; never fail the job on it
            log.warning("status card update failed: %s", ex)

    def tick(self) -> None:
        if time.time() - self._last_post >= HEARTBEAT:
            job = self.job
            if job.get("status") == "running":
                self._post(job)
            else:
                self._last_post = time.time()

    def paused_seconds(self) -> float:
        value, at = self._paused
        if time.time() - at > 2:
            value = paused_seconds(self.job)
            self._paused = (value, time.time())
        return value

    def finish(self, status: str, step: str, result_html: str = "", links: list | None = None) -> dict:
        job = update(self.jid, status=status, step=step, finished=time.time(),
                     result_html=result_html, links=links or [])
        self._post(job)
        return job
