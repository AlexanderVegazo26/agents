#!/usr/bin/env python3
"""Put a local service on https://<sub>.sonnetcode.com, or take it off again.

    sonnet_link.py up <sub> --port=<n>       expose a service already on 127.0.0.1:<n>
    sonnet_link.py up <sub> --folder=<dir>   publish a static folder under ~/prototypes,
                                             served by a systemd user unit (survives reboots)
    sonnet_link.py down <sub>                take a link this tool created off again
    sonnet_link.py list                      links this tool manages, with their live status
    sonnet_link.py serve <dir> <port>        the static server a folder link's unit runs

Every hostname shares one named Cloudflare tunnel (sonnetcode-propuestas, run by
site-tunnel.service). Any up or down that changes the ingress config restarts it,
and that briefly takes every other hostname on it offline too. The manual
procedure this automates is the Basic Memory note "Expose a local service on a
sonnetcode.com subdomain".

The checks are the point of this file, because its caller is a model reachable
from Telegram, and ~/prototypes is writable from inside the model's sandbox:

  * Ports are limited to PORT_MIN..PORT_MAX minus DENY_PORTS. Everything else on
    this machine's loopback (LLM servers, Hermes, the agent-computer viewer) has
    no auth of its own and must never be reachable from the internet.
  * The port must be listening on loopback only and answer 2xx/3xx, and no other
    ingress rule may already point at it.
  * Subdomains are one DNS label, and reserved names are refused. A hostname that
    appears anywhere in the config but was not recorded by `up` is left alone, so
    propuestas.sonnetcode.com and anything else configured by hand cannot be
    changed or taken down here.
  * DNS is added without --overwrite-dns, so a name that already points elsewhere
    makes `up` fail instead of being hijacked. Re-routing a name that already
    points at this tunnel is a no-op that exits 0 (measured 2026-10-16).
  * A folder is published from a copy made through directory file descriptors,
    opened with O_NOFOLLOW one component at a time. A symlink, hard link, special
    file or secret-looking name anywhere refuses the whole copy, and swapping a
    directory for a symlink in the middle of the copy cannot redirect it outside
    the folder. The copy is staged next to the live one and swapped in only once
    it is complete, so a refused refresh leaves the published site untouched.
  * Only the ingress config is read or written. The credentials beside it (the
    tunnel .json and cert.pem) are never opened here; cloudflared reads them itself.
  * An edit that fails `cloudflared ingress validate` is rolled back before any
    restart. Config-changing `up` calls are limited to MAX_RESTARTS per hour, so a
    steered model cannot keep the shared tunnel cycling.
  * A link is recorded as pending before its first side effect, so a link left
    half made by a failure or a kill can always be removed with `down`.

Output is a single JSON object on stdout; the exit status is 0 on success.
Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import http.server
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HOME = Path.home()
DOMAIN = "sonnetcode.com"
TUNNEL = "sonnetcode-propuestas"
SERVICE = "site-tunnel.service"
CONFIG = Path(os.environ.get("SONNET_LINK_CONFIG") or HOME / ".cloudflared" / "propuestas.yml")
STATE = Path(os.environ.get("SONNET_LINK_STATE") or HOME / ".local" / "state" / "sonnet-link")
UNIT_DIR = Path(os.environ.get("SONNET_LINK_UNIT_DIR") or HOME / ".config" / "systemd" / "user")
WORK_BASE = Path(os.environ.get("SDLC_PROTOTYPES_DIR") or HOME / "prototypes")
SANDBOX_BASE = "/workspace/prototypes"  # where the Hermes sandbox sees WORK_BASE
CLOUDFLARED = os.environ.get("SONNET_LINK_CLOUDFLARED") or str(HOME / ".local" / "bin" / "cloudflared")
SYSTEMCTL = os.environ.get("SONNET_LINK_SYSTEMCTL") or "systemctl"
PYTHON = "/usr/bin/python3"
SCRIPT = Path(__file__).resolve()

PORT_MIN, PORT_MAX = 4300, 4399
# In range but not prototypes: 4313 is the agent-computer viewer, 4312 an unidentified
# loopback service (both seen listening 2026-10-16), 4320 the propuestas site.
DENY_PORTS = frozenset({4312, 4313, 4320})
MAX_LINKS = 10
MAX_RESTARTS = 6  # config-changing `up` calls per hour; `down` is never limited
MAX_FILES, MAX_BYTES = 5000, 300 << 20
LOCAL_WAIT, VERIFY_WAIT, DOWN_WAIT = 15, 45, 30  # seconds
SUB_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
RESERVED = frozenset({
    "www", "propuestas", "mail", "webmail", "smtp", "imap", "pop", "mx", "ns1", "ns2", "ftp", "ssh",
    "vpn", "api", "app", "admin", "dashboard", "auth", "login", "sso", "id", "account", "billing", "pay",
    "status", "docs", "blog", "cdn", "static", "assets", "git", "dev", "staging", "prod", "support",
    "help", "autodiscover", "autoconfig", "secure", "portal", "sonnetcode", "sonnet", "sonnet-code",
})
SECRET_NAME = re.compile(
    r"(^\.env(\..*)?$|^\.git$|^\.ssh$|^\.aws$|^\.gnupg$|^\.cloudflared$|\.pem$|\.key$|\.p12$|\.pfx$|\.kdbx$"
    r"|^id_(rsa|ed25519|ecdsa|dsa)|^\.npmrc$|^\.pypirc$|^\.netrc$|^\.htpasswd$|^credentials|^auth\.json$"
    r"|^secrets?(\..*)?$|\.sqlite3?$|\.db$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$)",
    re.IGNORECASE)
HOST_RE = re.compile(r"^\s*-\s*hostname:\s*['\"]?([^'\"\s#]+)['\"]?\s*(#.*)?$")
SERVICE_RE = re.compile(r"^\s*service:\s*['\"]?([^'\"\s#]+)['\"]?\s*(#.*)?$")
CATCHALL_RE = re.compile(r"^\s*-\s*service:\s*['\"]?http_status:404['\"]?\s*(#.*)?$")


class Refused(Exception):
    """A request this tool will not carry out; the message is shown to the user."""


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- processes and HTTP

def _run(argv: list[str], timeout: float = 60) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(argv, 124, "", f"timed out after {timeout:.0f}s")


def _systemctl(*args: str, timeout: float = 60) -> subprocess.CompletedProcess:
    return _run([SYSTEMCTL, "--user", *args], timeout=timeout)


def _tail(r: subprocess.CompletedProcess, n: int = 300) -> str:
    return (r.stderr or r.stdout or "").strip()[-n:]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_a, **_kw):
        return None  # report the 3xx itself; never fetch where a local service points


_LOCAL_OPENER = urllib.request.build_opener(_NoRedirect)


def _http_status(url: str, timeout: float = 10) -> int | None:
    """Status, or None when nothing answered. Local URLs: redirects are not followed. Public URLs:
    the status after redirects (the hostname is ours, so following them is safe)."""
    opener = _LOCAL_OPENER if url.startswith("http://127.0.0.1") else urllib.request.build_opener()
    try:
        req = urllib.request.Request(url, headers={"user-agent": "sonnet-link-check"})
        with opener.open(req, timeout=timeout) as r:  # noqa: S310 — fixed scheme and host
            return r.status
    except Exception as ex:  # HTTPError carries .code; anything else is "no answer"
        return getattr(ex, "code", None)


def _ok(status: int | None) -> bool:
    return status is not None and 200 <= status < 400


def _wait_status(url: str, want, seconds: float) -> int | None:
    deadline, status = time.time() + seconds, None
    while True:
        status = _http_status(url)
        if want(status) or time.time() >= deadline:
            return status
        time.sleep(2)


def _host(sub: str) -> str:
    return f"{sub}.{DOMAIN}"


# --------------------------------------------------------------------------- input checks

def _check_sub(sub: str) -> str:
    sub = (sub or "").strip().lower()
    if not SUB_RE.match(sub):
        raise Refused("subdomain must be one DNS label: a-z, 0-9 and '-', 1 to 40 characters, "
                      "not starting or ending with '-'")
    if sub in RESERVED:
        raise Refused(f"'{sub}' is reserved; pick another subdomain")
    return sub


def _check_port_number(port) -> int:
    if isinstance(port, bool) or not isinstance(port, int) or not PORT_MIN <= port <= PORT_MAX:
        raise Refused(f"port must be a number from {PORT_MIN} to {PORT_MAX} (the prototype range); "
                      "other local ports run services that must not be public")
    if port in DENY_PORTS:
        raise Refused(f"port {port} runs a service that must not be public")
    return port


def _listeners(port: int) -> list[str]:
    """Local addresses with a TCP listener on this port, as `ss` prints them."""
    out = _run(["ss", "-Hltn", f"sport = :{port}"], timeout=10).stdout
    return [line.split()[3] for line in out.splitlines() if len(line.split()) >= 4]


def _loopback_only(addrs: list[str]) -> bool:
    return bool(addrs) and all(a.rsplit(":", 1)[0] in ("127.0.0.1", "[::1]") for a in addrs)


def _free_port(taken: set[int]) -> int:
    for port in range(PORT_MIN, PORT_MAX + 1):
        if port in taken or port in DENY_PORTS or _listeners(port):
            continue
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise Refused(f"no free port left in {PORT_MIN}..{PORT_MAX}")


def _folder_parts(folder: str) -> list[str]:
    """The folder as path components under WORK_BASE, from a host path, a sandbox path
    (/workspace/prototypes/...) or a path relative to ~/prototypes. Purely lexical: the
    filesystem is only touched later, one O_NOFOLLOW component at a time."""
    raw = (folder or "").strip()
    if not raw or "\x00" in raw:
        raise Refused("folder must be a path inside ~/prototypes")
    if raw == SANDBOX_BASE or raw.startswith(SANDBOX_BASE + "/"):
        raw = str(WORK_BASE) + raw[len(SANDBOX_BASE):]
    raw = os.path.expanduser(raw)
    if not os.path.isabs(raw):
        raw = os.path.join(str(WORK_BASE), raw)
    norm, base = os.path.normpath(raw), os.path.normpath(str(WORK_BASE))
    if not norm.startswith(base + os.sep):
        raise Refused(f"only folders inside {WORK_BASE} can be published")
    return norm[len(base) + 1:].split(os.sep)


# --------------------------------------------------------------------------- vetted copy

def _open_dir(name: str, dir_fd: int | None = None) -> int:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
    except OSError as ex:
        raise Refused(f"'{name}' is not a plain folder (a symlink, or missing): {ex.strerror}") from None
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refused(f"'{name}' is not a plain folder")
    return fd


def _vet_copy(parts: list[str], dst: Path) -> int:
    """Copy WORK_BASE/<parts> to dst through directory fds. Every name is opened relative to
    its parent's fd with O_NOFOLLOW and checked with fstat on what was actually opened, so a
    path swapped for a symlink mid-copy is refused instead of followed. Returns the file count."""
    fds = [_open_dir(str(WORK_BASE))]
    try:
        for part in parts:
            if part in ("", ".", ".."):
                raise Refused("the folder path has an empty, '.' or '..' component")
            if SECRET_NAME.search(part):
                raise Refused(f"'{part}' looks like a secret or credentials folder")
            fds.append(_open_dir(part, fds[-1]))
        dst.mkdir(mode=0o755)
        count, total = 0, 0

        def walk(dfd: int, out: Path, rel: str) -> None:
            nonlocal count, total
            for name in sorted(os.listdir(dfd)):
                path = f"{rel}{name}"
                if SECRET_NAME.search(name):
                    raise Refused(f"{path} looks like a secret or credentials file; remove it before publishing")
                st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
                if stat.S_ISDIR(st.st_mode):
                    cfd = _open_dir(name, dfd)
                    try:
                        (out / name).mkdir(mode=0o755)
                        walk(cfd, out / name, path + "/")
                    finally:
                        os.close(cfd)
                elif stat.S_ISREG(st.st_mode):
                    try:
                        ffd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dfd)
                    except OSError:
                        raise Refused(f"{path} changed while it was being copied; refusing to publish") from None
                    with os.fdopen(ffd, "rb") as fin:
                        fst = os.fstat(fin.fileno())
                        if not stat.S_ISREG(fst.st_mode) or fst.st_nlink != 1:
                            raise Refused(f"{path} is a hard link or special file; refusing to publish")
                        count, total = count + 1, total + fst.st_size
                        if count > MAX_FILES or total > MAX_BYTES:
                            raise Refused(f"the folder is larger than {MAX_FILES} files / {MAX_BYTES >> 20} MB")
                        with open(out / name, "xb") as fout:  # at most the size fstat saw
                            left = fst.st_size
                            while left > 0 and (chunk := fin.read(min(left, 1 << 20))):
                                fout.write(chunk)
                                left -= len(chunk)
                        if fin.read(1):
                            raise Refused(f"{path} grew while it was being copied; refusing to publish")
                else:
                    raise Refused(f"{path} is a symlink or special file; refusing to publish")

        walk(fds[-1], dst, "")
        if not (dst / "index.html").is_file():
            raise Refused("the folder has no index.html")
        return count
    finally:
        for fd in fds:
            os.close(fd)


def _stage_and_swap(parts: list[str], public: Path) -> int:
    """Copy into public.new; only a complete, vetted copy replaces the live public/."""
    staging, old = public.with_name("public.new"), public.with_name("public.old")
    for p in (staging, old):
        shutil.rmtree(p, ignore_errors=True)
    try:
        count = _vet_copy(parts, staging)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    if public.exists():
        os.rename(public, old)
    os.rename(staging, public)
    shutil.rmtree(old, ignore_errors=True)
    return count


# --------------------------------------------------------------------------- static server

# The idea pipeline's policy: scripts only from these CDNs, and connect-src 'self' keeps a page
# from posting anything anywhere else.
CDNS = "https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com"
CSP = ("default-src 'self'; "
       f"script-src 'self' 'unsafe-inline' 'unsafe-eval' {CDNS}; "
       f"style-src 'self' 'unsafe-inline' {CDNS} https://fonts.googleapis.com; "
       f"font-src 'self' data: {CDNS} https://fonts.gstatic.com; img-src 'self' data: blob:; "
       "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files from one vetted directory: no listings and nothing outside it."""

    def list_directory(self, path):
        self.send_error(404)
        return None

    def translate_path(self, path):
        p = super().translate_path(path)
        root = os.path.realpath(self.directory)
        real = os.path.realpath(p)
        return real if real == root or real.startswith(root + os.sep) else os.path.join(root, ".outside-root")

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def serve(directory: str, port: int) -> int:
    handler = lambda *a, **kw: Handler(*a, directory=directory, **kw)  # noqa: E731
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as srv:
        srv.serve_forever()
    return 0


# --------------------------------------------------------------------------- state

def _lock():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    fh = open(STATE / ".lock", "a")
    fcntl.flock(fh, fcntl.LOCK_EX)  # one change to the shared tunnel at a time
    return fh


def _read_json(name: str) -> dict:
    p = STATE / name
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError) as ex:
        raise Refused(f"{p} is unreadable ({ex}); fix or remove it by hand, since links it lists would "
                      "otherwise be forgotten") from None
    if not isinstance(data, dict):
        raise Refused(f"{p} is not a JSON object; fix or remove it by hand")
    return data


def _write_json(name: str, data: dict) -> None:
    tmp = STATE / f"{name}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps(data, indent=2, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, STATE / name)


def _load() -> dict:
    return _read_json("links.json")


def _save(links: dict) -> None:
    _write_json("links.json", links)


def _restart_budget() -> None:
    recent = _recent_restarts()
    if len(recent) >= MAX_RESTARTS:
        wait = int(min(recent) + 3600 - time.time()) // 60 + 1
        raise Refused(f"the shared tunnel was already restarted {len(recent)} times in the last hour by this "
                      f"tool (limit {MAX_RESTARTS}); try again in about {wait} min")


def _recent_restarts() -> list[float]:
    """Restart times in the last hour. A rate limiter, not a record of links: a corrupt file reads as empty."""
    hour_ago = time.time() - 3600
    try:
        times = _read_json("restarts.json").get("times", [])
    except Refused:
        times = []
    return [t for t in times if isinstance(t, (int, float)) and t > hour_ago]


def _note_restart() -> None:
    _write_json("restarts.json", {"times": _recent_restarts() + [time.time()]})


# --------------------------------------------------------------------------- ingress config

def _read_config() -> list[str]:
    if CONFIG.is_symlink():
        raise Refused(f"{CONFIG} is a symlink; edit it by hand")
    with open(CONFIG, newline="") as fh:  # newline="": keep CRLF as written, never normalise it
        return fh.read().splitlines(keepends=True)


def _rules(lines: list[str]) -> list[tuple[str, str]]:
    """(hostname, service) for every rule in the recognised two-line shape."""
    rules = []
    for i, line in enumerate(lines[:-1]):
        if (m := HOST_RE.match(line)) and (s := SERVICE_RE.match(lines[i + 1])):
            rules.append((m.group(1).lower(), s.group(1)))
    return rules


def _mentions(lines: list[str], host: str) -> bool:
    """Whether any non-comment line names the host, in whatever shape. Used to fail closed:
    a hostname the parser does not fully understand counts as configured."""
    pat = re.compile(rf"(?<![a-z0-9.-]){re.escape(host)}(?![a-z0-9-])", re.IGNORECASE)
    return any(pat.search(line) for line in lines if not line.lstrip().startswith("#"))


def _ports_in_use(lines: list[str]) -> set[int]:
    return {int(m.group(1)) for line in lines if not line.lstrip().startswith("#")
            for m in re.finditer(r"(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)", line)}


def _write_config(lines: list[str]) -> None:
    """Atomic replace that keeps the file private (it names the credentials file)."""
    tmp = CONFIG.with_name(CONFIG.name + ".sonnet-link.tmp")
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", newline="") as fh:
        fh.writelines(lines)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, CONFIG)


def _validate() -> str:
    r = _run([CLOUDFLARED, "tunnel", "--config", str(CONFIG), "ingress", "validate"], timeout=30)
    return "" if r.returncode == 0 else _tail(r, 400)


def _apply(new_lines: list[str], old_lines: list[str]) -> None:
    """Write, validate (rolling back on failure), then restart the shared tunnel."""
    _note_restart()  # before the write: nothing can fail between the new config and the restart
    _write_config(new_lines)
    if (err := _validate()):
        _write_config(old_lines)
        raise Refused(f"cloudflared rejected the new ingress config, so it was restored unchanged: {err}")
    r = _systemctl("restart", SERVICE, timeout=60)
    if r.returncode != 0:
        raise Refused(f"the ingress config was changed but restarting {SERVICE} failed ({_tail(r)}). The tunnel "
                      "may be down or still running the old config; check `systemctl --user status "
                      "site-tunnel` on the host")
    time.sleep(3)


def _eol(lines: list[str]) -> str:
    return "\r\n" if any(line.endswith("\r\n") for line in lines) else "\n"


def _add_rule(lines: list[str], host: str, port: int) -> list[str]:
    idx = next((i for i in range(len(lines) - 1, -1, -1) if CATCHALL_RE.match(lines[i])), None)
    if idx is None:
        raise Refused(f"{CONFIG} has no final 'service: http_status:404' rule; fix it by hand first")
    indent, eol = re.match(r"^(\s*)", lines[idx]).group(1), _eol(lines)
    rule = [f"{indent}- hostname: {host}{eol}", f"{indent}  service: http://127.0.0.1:{port}{eol}"]
    return lines[:idx] + rule + lines[idx:]


def _remove_rule(lines: list[str], host: str) -> list[str]:
    """The config without the host's two-line rule. Refuses when the host would still be
    named anywhere afterwards, rather than report a removal that did not happen."""
    out, i = [], 0
    while i < len(lines):
        m = HOST_RE.match(lines[i])
        if m and m.group(1).lower() == host and i + 1 < len(lines) and SERVICE_RE.match(lines[i + 1]):
            i += 2
            continue
        out.append(lines[i])
        i += 1
    if _mentions(out, host):
        raise Refused(f"{host} appears in {CONFIG} in a shape this tool does not recognise; "
                      "remove it by hand")
    return out


# --------------------------------------------------------------------------- units

def _unit_name(sub: str) -> str:
    return f"sonnet-link-{sub}.service"


def _unit_arg(value: str) -> str:
    if any(c in value for c in "\"\\\n"):
        raise Refused(f"path {value!r} cannot be written into a unit file")
    return '"' + value.replace("%", "%%").replace("$", "$$") + '"'


def _write_unit(sub: str, public: Path, port: int) -> str:
    name = _unit_name(sub)
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    exec_start = " ".join(_unit_arg(a) for a in (PYTHON, "-I", str(SCRIPT), "serve", str(public), str(port)))
    (UNIT_DIR / name).write_text(
        "[Unit]\n"
        f"Description=sonnet-link static site for {_host(sub)} on 127.0.0.1:{port}\n\n"
        "[Service]\n"
        f"ExecStart={exec_start}\n"
        "Restart=on-failure\nRestartSec=5\n"
        # Measured in a user unit on this host 2026-10-16: these start and serve. PrivateDevices=yes
        # does not (status=218/CAPABILITIES: the user manager cannot drop capabilities).
        "NoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\n"
        "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\n\n"
        "[Install]\nWantedBy=default.target\n")
    for args in (("daemon-reload",), ("enable", name), ("restart", name)):
        r = _systemctl(*args, timeout=20)
        if r.returncode != 0:
            raise Refused(f"systemctl {' '.join(args)} failed: {_tail(r)}")
    return name


def _remove_unit(name: str) -> None:
    if not re.fullmatch(r"sonnet-link-[a-z0-9-]+\.service", name or ""):
        return  # only ever remove units this tool wrote
    _systemctl("disable", "--now", name, timeout=20)
    (UNIT_DIR / name).unlink(missing_ok=True)
    _systemctl("daemon-reload", timeout=20)


# --------------------------------------------------------------------------- commands

def up(sub: str, port: int | None, folder: str | None) -> dict:
    sub = _check_sub(sub)
    host = _host(sub)
    if (port is None) == (folder is None):
        raise Refused("give exactly one of --port (a running service) or --folder (a static folder)")
    links = _load()
    lines = _read_config()
    record = dict(links.get(sub) or {})
    if not record and _mentions(lines, host):
        raise Refused(f"{host} is already configured by hand; this tool only changes links it created")
    if not record and len(links) >= MAX_LINKS:
        raise Refused(f"already {len(links)} links recorded (limit {MAX_LINKS}); take one down first")
    mode = "folder" if folder is not None else "port"
    if record and record.get("mode") != mode:
        raise Refused(f"{host} is up in {record.get('mode')} mode; take it down first to switch modes")
    needs_rule = host not in dict(_rules(lines))
    if needs_rule and _mentions(lines, host):
        raise Refused(f"{host} appears in {CONFIG} in a shape this tool does not recognise; fix it by hand")
    if needs_rule:
        _restart_budget()

    if mode == "folder":
        parts = _folder_parts(folder)
        port = record.get("port") or _free_port(_ports_in_use(lines) | {r.get("port") for r in links.values()})
    else:
        port = _check_port_number(port)
        if record and record.get("port") != port:
            raise Refused(f"{host} is already up for port {record.get('port')}; take it down first")
        if not record and port in _ports_in_use(lines):
            raise Refused(f"port {port} is already published under another hostname")
        addrs = _listeners(port)
        if not addrs:
            raise Refused(f"nothing is listening on 127.0.0.1:{port}; start the service first")
        if not _loopback_only(addrs):
            raise Refused(f"port {port} listens on {', '.join(addrs)}; bind it to 127.0.0.1 only")
        status = _http_status(f"http://127.0.0.1:{port}/")
        if not _ok(status):
            raise Refused(f"http://127.0.0.1:{port}/ answered {status}; it must answer 2xx or 3xx before "
                          "going public")

    # From here on there are side effects: record the link first, so `down` can always undo it.
    is_new, prev_status = not record, record.get("status")
    record.update(host=host, mode=mode, port=port, since=record.get("since") or _now(), status="pending")
    links[sub] = record
    _save(links)
    config_touched = False
    try:
        if mode == "folder":
            public = STATE / sub / "public"
            public.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            record["files"] = _stage_and_swap(parts, public)
            record["folder"] = str(WORK_BASE.joinpath(*parts))
            record["unit"] = _unit_name(sub)  # recorded first, so a failure inside _write_unit is still undone
            _save(links)
            _write_unit(sub, public, port)
            local = _wait_status(f"http://127.0.0.1:{port}/", lambda s: s == 200, LOCAL_WAIT)
            if local != 200:
                raise Refused(f"the static server for {host} did not answer on 127.0.0.1:{port} ({local}); "
                              f"see journalctl --user -u {record['unit']}")
        r = _run([CLOUDFLARED, "tunnel", "route", "dns", TUNNEL, host])
        if r.returncode != 0:
            raise Refused(f"DNS route failed (an existing record for {host} is never overwritten): {_tail(r)}")
        if needs_rule:
            config_touched = True
            _apply(_add_rule(lines, host, port), lines)
    except BaseException as ex:
        if is_new and not (config_touched and dict(_rules(_read_config())).get(host)):
            # nothing reached the tunnel: undo the local pieces and forget the link
            if record.get("unit"):
                _remove_unit(record["unit"])
            shutil.rmtree(STATE / sub, ignore_errors=True)
            links.pop(sub, None)
        elif not is_new and not config_touched:
            record["status"] = prev_status  # a refused refresh left the published link as it was
        else:
            record["status"] = "failed"
            if isinstance(ex, Refused):
                ex.args = (f"{ex.args[0]}. The link is recorded; run down for {sub} to clean it up",)
        _save(links)
        raise

    record["status"] = "up"
    _save(links)
    status = _wait_status(f"https://{host}/", lambda s: s == 200, VERIFY_WAIT)
    return {"success": status == 200, "url": f"https://{host}", "public_status": status, "port": port,
            "mode": mode, "unit": record.get("unit"), "tunnel_restarted": needs_rule,
            "note": ("the shared tunnel was restarted, so every sonnetcode.com hostname was offline for a few "
                     "seconds" if needs_rule else "the hostname was already routed; the tunnel was not restarted")
                    + ("" if status == 200 else f". The public URL answered {status}: DNS can take a minute, so "
                       "check again with list")}


def down(sub: str) -> dict:
    sub = (sub or "").strip().lower()
    links = _load()
    if not SUB_RE.match(sub) or sub not in links:
        raise Refused(f"'{sub}' was not created by this tool, so it is left alone; links it manages: "
                      + (", ".join(sorted(links)) or "none"))
    record, host = links[sub], _host(sub)
    lines = _read_config()
    new = _remove_rule(lines, host)  # refuses if the host would still be configured
    restarted = len(new) != len(lines)
    if restarted:
        _apply(new, lines)
    if record.get("unit"):
        _remove_unit(record["unit"])
    shutil.rmtree(STATE / sub, ignore_errors=True)
    del links[sub]
    _save(links)
    status = _wait_status(f"https://{host}/", lambda s: s == 404, DOWN_WAIT)
    note = "the DNS record stays and answers 404; delete it in the Cloudflare dashboard if the name should go"
    if record.get("mode") == "port":
        note += (f". The local service on 127.0.0.1:{record.get('port')} was not started by this tool and is "
                 "still running")
    if status != 404:
        note = (f"the rule is gone from the config, but the public URL answered {status} instead of 404; check "
                "again in a minute. ") + note
    return {"success": status == 404, "url": f"https://{host}", "public_status": status,
            "tunnel_restarted": restarted, "note": note}


def list_links() -> dict:
    links = _load()
    return {"success": True, "links": [
        {"url": f"https://{r.get('host') or _host(s)}", "port": r.get("port"), "mode": r.get("mode"),
         "status": r.get("status"), "folder": r.get("folder"), "unit": r.get("unit"), "since": r.get("since"),
         "public_status": _http_status(f"https://{r.get('host') or _host(s)}/")}
        for s, r in sorted(links.items())]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sonnet_link.py", description=__doc__.split("\n\n")[0])
    sp = ap.add_subparsers(dest="cmd", required=True)
    u = sp.add_parser("up")
    u.add_argument("sub")
    g = u.add_mutually_exclusive_group(required=True)
    g.add_argument("--port", type=int)
    g.add_argument("--folder")
    sp.add_parser("down").add_argument("sub")
    sp.add_parser("list")
    s = sp.add_parser("serve")
    s.add_argument("directory")
    s.add_argument("port", type=int)
    args = ap.parse_args(argv)
    if args.cmd == "serve":
        return serve(args.directory, args.port)
    try:
        if args.cmd == "list":
            result = list_links()
        else:
            with _lock():
                result = up(args.sub, args.port, args.folder) if args.cmd == "up" else down(args.sub)
    except Refused as ex:
        result = {"success": False, "message": str(ex)}
    except Exception as ex:  # an unexpected failure is still reported as JSON
        result = {"success": False, "message": f"{type(ex).__name__}: {ex}"}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
