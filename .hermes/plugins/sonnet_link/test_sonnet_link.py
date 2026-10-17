"""Offline tests for sonnet_link.py and its Hermes wrapper. Every external effect (cloudflared,
systemctl, the public URL) is faked, and the ingress config, state, units and ~/prototypes live in a
temporary directory. The fake `cloudflared ingress validate` only rejects a line containing BROKEN:
it is not a YAML parser, so no test here proves that cloudflared would accept a given config shape.

    python3 -m unittest test_sonnet_link.py
"""

from __future__ import annotations

import contextlib
import http.server
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent

CONFIG_TEXT = """tunnel: 00000000-0000-0000-0000-000000000000
credentials-file: /nonexistent/creds.json
ingress:
  - hostname: propuestas.sonnetcode.com
    service: http://127.0.0.1:4320
  - service: http_status:404
"""

FAKE_CLOUDFLARED = """#!/bin/sh
echo "cloudflared $*" >> "$FAKE_LOG"
case "$*" in
  *"ingress validate"*) grep -q BROKEN "$SONNET_LINK_CONFIG" && { echo "bad rule" >&2; exit 1; }; exit 0;;
  *"route dns"*) case "$*" in *taken*) echo "record already exists" >&2; exit 1;; esac; exit 0;;
esac
"""

FAKE_SYSTEMCTL = """#!/bin/sh
echo "systemctl $*" >> "$FAKE_LOG"
case "$*" in *"restart site-tunnel"*) [ -n "$FAIL_RESTART" ] && { echo "unit failed" >&2; exit 1; };; esac
case "$*" in *"restart sonnet-link-"*) [ -n "$FAIL_UNIT" ] && { echo "unit failed" >&2; exit 1; };; esac
exit 0
"""


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_a):
        pass


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tmp = Path(self._td.name)
        (self.tmp / "propuestas.yml").write_text(CONFIG_TEXT)
        (self.tmp / "prototypes").mkdir()
        for name, body in (("cloudflared", FAKE_CLOUDFLARED), ("systemctl", FAKE_SYSTEMCTL)):
            (self.tmp / name).write_text(body)
            (self.tmp / name).chmod(0o755)
        env = dict(SONNET_LINK_CONFIG=str(self.tmp / "propuestas.yml"), SONNET_LINK_STATE=str(self.tmp / "state"),
                   SONNET_LINK_UNIT_DIR=str(self.tmp / "units"), SDLC_PROTOTYPES_DIR=str(self.tmp / "prototypes"),
                   SONNET_LINK_CLOUDFLARED=str(self.tmp / "cloudflared"),
                   SONNET_LINK_SYSTEMCTL=str(self.tmp / "systemctl"), FAKE_LOG=str(self.tmp / "calls.log"))
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)
        os.environ.pop("FAIL_RESTART", None)
        os.environ.pop("FAIL_UNIT", None)
        spec = importlib.util.spec_from_file_location("sonnet_link_under_test", HERE / "sonnet_link.py")
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.public = {}  # url -> status the fake internet answers
        real = self.m._http_status
        for target, value in (("_http_status", lambda url, timeout=10: self.public.get(url.rstrip("/"), 404)
                               if url.startswith("https://") else real(url, timeout)),
                              ("LOCAL_WAIT", 3), ("VERIFY_WAIT", 0), ("DOWN_WAIT", 0)):
            pt = mock.patch.object(self.m, target, value)
            pt.start()
            self.addCleanup(pt.stop)
        pt = mock.patch.object(self.m.time, "sleep", lambda _s: None)
        pt.start()
        self.addCleanup(pt.stop)

    # helpers
    def config(self) -> str:
        return (self.tmp / "propuestas.yml").read_text()

    def set_config(self, text: str) -> None:
        (self.tmp / "propuestas.yml").write_bytes(text.encode())

    def calls(self) -> str:
        p = self.tmp / "calls.log"
        return p.read_text() if p.exists() else ""

    def links(self) -> dict:
        p = self.tmp / "state" / "links.json"
        return json.loads(p.read_text()) if p.exists() else {}

    def serve_http(self, bind: str = "127.0.0.1", port: int | None = None, directory: str | None = None) -> int:
        port = port or self.m._free_port(set())
        if directory:
            handler = lambda *a, **kw: self.m.Handler(*a, directory=directory, **kw)  # noqa: E731
        else:
            handler = _Quiet
        srv = http.server.ThreadingHTTPServer((bind, port), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return port

    def run_cli(self, *argv) -> dict:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.m.main(list(argv))
        out = json.loads(buf.getvalue())
        self.assertEqual(rc == 0, out["success"], out)
        return out

    def site(self, name="idea") -> Path:
        d = self.tmp / "prototypes" / name / "site"
        d.mkdir(parents=True)
        (d / "index.html").write_text("<h1>v1</h1>")
        return d

    def fake_units(self):
        """Run the real static server where systemd would, so folder mode works end to end."""
        servers = {}
        orig = self.m._write_unit

        def write_unit(sub, public, port):
            name = orig(sub, public, port)
            if port not in servers:
                servers[port] = self.serve_http(port=port, directory=str(public))
            return name
        pt = mock.patch.object(self.m, "_write_unit", write_unit)
        pt.start()
        self.addCleanup(pt.stop)


class Validation(Base):
    def test_rejects_bad_and_reserved_subdomains(self):
        for sub in ("www", "propuestas", "support", "a.b", "-x", "x-", "UPPER_", "a" * 41, "", "../x", "a b"):
            with self.assertRaises(self.m.Refused, msg=sub):
                self.m._check_sub(sub)
        self.assertEqual(self.m._check_sub("Obra-Base2"), "obra-base2")
        self.assertIn("reserved", self.run_cli("up", "www", "--port=4317")["message"])
        self.assertEqual(self.config(), CONFIG_TEXT)

    def test_rejects_ports_outside_prototype_range(self):
        for port in ("11435", "8081", "22", "4299", "4400"):
            self.assertIn("4300", self.run_cli("up", "demo", f"--port={port}")["message"])
        self.assertNotIn("route dns", self.calls())

    def test_rejects_denied_ports_in_range(self):
        for port in ("4312", "4313", "4320"):
            self.assertIn("must not be public", self.run_cli("up", "demo", f"--port={port}")["message"])
        self.assertNotIn("route dns", self.calls())

    def test_rejects_port_with_nothing_listening(self):
        port = self.m._free_port(set())
        self.assertIn("nothing is listening", self.run_cli("up", "demo", f"--port={port}")["message"])

    def test_rejects_port_listening_beyond_loopback(self):
        port = self.serve_http("0.0.0.0")
        self.assertIn("127.0.0.1 only", self.run_cli("up", "demo", f"--port={port}")["message"])

    def test_rejects_port_already_published(self):
        port = self.serve_http()
        self.set_config(CONFIG_TEXT.replace("  - service: http_status:404",
                                            f"  - hostname: other.example.com\n    service: http://127.0.0.1:{port}\n"
                                            "  - service: http_status:404"))
        self.assertIn("already published", self.run_cli("up", "demo", f"--port={port}")["message"])

    def test_exactly_one_of_port_or_folder(self):
        for argv in (["up", "demo"], ["up", "demo", "--port=4317", "--folder=x"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.m.main(argv)
        with self.assertRaisesRegex(self.m.Refused, "exactly one"):
            self.m.up("demo", None, None)

    def test_corrupt_state_fails_closed(self):
        (self.tmp / "state").mkdir()
        (self.tmp / "state" / "links.json").write_text("{not json")
        self.assertIn("unreadable", self.run_cli("up", "demo", "--port=4317")["message"])
        self.assertIn("unreadable", self.run_cli("down", "demo")["message"])
        self.assertEqual((self.tmp / "state" / "links.json").read_text(), "{not json")

    def test_symlinked_config_is_refused(self):
        real = self.tmp / "real.yml"
        real.write_text(CONFIG_TEXT)
        (self.tmp / "propuestas.yml").unlink()
        (self.tmp / "propuestas.yml").symlink_to(real)
        port = self.serve_http()
        self.assertIn("symlink", self.run_cli("up", "demo", f"--port={port}")["message"])


class PortMode(Base):
    def test_up_then_down(self):
        port = self.serve_http()
        self.public["https://demo.sonnetcode.com"] = 200
        out = self.run_cli("up", "demo", f"--port={port}")
        self.assertTrue(out["tunnel_restarted"])
        cfg = self.config()
        self.assertIn(f"  - hostname: demo.sonnetcode.com\n    service: http://127.0.0.1:{port}\n"
                      "  - service: http_status:404\n", cfg)
        self.assertLess(cfg.index("propuestas"), cfg.index("demo"))
        self.assertIn("route dns sonnetcode-propuestas demo.sonnetcode.com", self.calls())
        self.assertNotIn("overwrite", self.calls())
        self.assertIn("restart site-tunnel.service", self.calls())
        self.assertEqual(oct((self.tmp / "propuestas.yml").stat().st_mode & 0o777), "0o600")
        self.assertEqual(self.links()["demo"]["status"], "up")

        self.public["https://demo.sonnetcode.com"] = 404
        out = self.run_cli("down", "demo")
        self.assertEqual(self.config(), CONFIG_TEXT)
        self.assertIn("still running", out["note"])
        self.assertEqual(self.links(), {})

    def test_idempotent_re_up_does_not_restart(self):
        port = self.serve_http()
        self.public["https://demo.sonnetcode.com"] = 200
        self.run_cli("up", "demo", f"--port={port}")
        before = self.calls().count("restart site-tunnel")
        out = self.run_cli("up", "demo", f"--port={port}")
        self.assertFalse(out["tunnel_restarted"])
        self.assertEqual(self.calls().count("restart site-tunnel"), before)
        self.assertEqual(self.config().count("demo.sonnetcode.com"), 1)

    def test_down_only_succeeds_on_404(self):
        port = self.serve_http()
        self.enterContext(mock.patch.object(self.m, "MAX_RESTARTS", 100))  # four cycles exceed the hourly budget
        for status in (None, 500, 530, 200):
            self.public["https://demo.sonnetcode.com"] = 200
            self.run_cli("up", "demo", f"--port={port}")
            self.public["https://demo.sonnetcode.com"] = status
            out = self.run_cli("down", "demo")
            self.assertFalse(out["success"], status)
            self.assertIn("instead of 404", out["note"])
            self.assertEqual(self.config(), CONFIG_TEXT)  # the rule itself is gone either way

    def test_down_refuses_links_it_did_not_create(self):
        out = self.run_cli("down", "propuestas")
        self.assertIn("not created by this tool", out["message"])
        self.assertEqual(self.config(), CONFIG_TEXT)
        self.assertNotIn("restart", self.calls())

    def test_dns_failure_changes_nothing(self):
        port = self.serve_http()
        out = self.run_cli("up", "taken", f"--port={port}")
        self.assertIn("never overwritten", out["message"])
        self.assertEqual(self.config(), CONFIG_TEXT)
        self.assertNotIn("restart", self.calls())
        self.assertEqual(self.links(), {})

    def test_invalid_config_is_rolled_back_without_restart(self):
        port = self.serve_http()
        orig = self.m._add_rule
        with mock.patch.object(self.m, "_add_rule", lambda lines, host, p: orig(lines, host, p) + ["BROKEN\n"]):
            out = self.run_cli("up", "demo", f"--port={port}")
        self.assertIn("restored unchanged", out["message"])
        self.assertEqual(self.config(), CONFIG_TEXT)
        self.assertNotIn("restart site-tunnel", self.calls())
        self.assertEqual(self.links(), {})

    def test_failed_restart_keeps_the_record_so_down_can_clean_up(self):
        port = self.serve_http()
        os.environ["FAIL_RESTART"] = "1"
        out = self.run_cli("up", "demo", f"--port={port}")
        self.assertIn("restarting site-tunnel.service failed", out["message"])
        self.assertIn("run down for demo", out["message"])
        self.assertIn("demo.sonnetcode.com", self.config())
        self.assertEqual(self.links()["demo"]["status"], "failed")
        del os.environ["FAIL_RESTART"]
        self.public["https://demo.sonnetcode.com"] = 404
        self.assertTrue(self.run_cli("down", "demo")["success"])
        self.assertEqual(self.config(), CONFIG_TEXT)
        self.assertEqual(self.links(), {})

    def test_restart_budget(self):
        port = self.serve_http()
        with mock.patch.object(self.m, "MAX_RESTARTS", 2):
            self.public["https://demo.sonnetcode.com"] = 404
            self.run_cli("up", "demo", f"--port={port}")
            self.run_cli("down", "demo")
            out = self.run_cli("up", "demo", f"--port={port}")
        self.assertIn("restarted 2 times", out["message"])
        self.assertEqual(self.config(), CONFIG_TEXT)

    def test_down_is_never_limited(self):
        port = self.serve_http()
        self.public["https://demo.sonnetcode.com"] = 200
        self.run_cli("up", "demo", f"--port={port}")
        with mock.patch.object(self.m, "MAX_RESTARTS", 0):
            self.public["https://demo.sonnetcode.com"] = 404
            self.assertTrue(self.run_cli("down", "demo")["success"])

    def test_link_limit(self):
        port = self.serve_http()
        with mock.patch.object(self.m, "MAX_LINKS", 0):
            self.assertIn("limit", self.run_cli("up", "demo", f"--port={port}")["message"])

    def test_mode_switch_is_refused(self):
        port = self.serve_http()
        self.public["https://demo.sonnetcode.com"] = 200
        self.run_cli("up", "demo", f"--port={port}")
        self.assertIn("port mode", self.run_cli("up", "demo", f"--folder={self.site()}")["message"])


class ConfigShapes(Base):
    """The parser must fail closed on shapes it does not fully understand."""

    def test_hostname_in_other_shapes_counts_as_hand_configured(self):
        port = self.serve_http()
        for rule in ("  - service: http://127.0.0.1:4318\n    hostname: demo.sonnetcode.com\n",
                     "  - {hostname: demo.sonnetcode.com, service: 'http://127.0.0.1:4318'}\n",
                     "  - hostname: \"demo.sonnetcode.com\"\n    # note\n    service: http://127.0.0.1:4318\n"):
            text = CONFIG_TEXT.replace("  - service: http_status:404\n", rule + "  - service: http_status:404\n")
            self.set_config(text)
            self.assertIn("by hand", self.run_cli("up", "demo", f"--port={port}")["message"], rule)
            self.assertEqual(self.config(), text)

    def test_commented_out_hostname_is_not_configured(self):
        port = self.serve_http()
        self.set_config(CONFIG_TEXT.replace("ingress:\n", "ingress:\n  # - hostname: demo.sonnetcode.com\n"))
        self.public["https://demo.sonnetcode.com"] = 200
        self.assertTrue(self.run_cli("up", "demo", f"--port={port}")["success"])

    def test_similar_hostnames_do_not_collide(self):
        self.assertFalse(self.m._mentions(["  - hostname: xdemo.sonnetcode.com\n"], "demo.sonnetcode.com"))
        self.assertFalse(self.m._mentions(["  - hostname: demo.sonnetcode.com-x\n"], "demo.sonnetcode.com"))
        self.assertTrue(self.m._mentions(["  - hostname: DEMO.sonnetcode.com\n"], "demo.sonnetcode.com"))

    def test_down_refuses_when_rule_shape_is_unrecognised(self):
        port = self.serve_http()
        self.public["https://demo.sonnetcode.com"] = 200
        self.run_cli("up", "demo", f"--port={port}")
        text = self.config().replace("  - hostname: demo.sonnetcode.com\n",
                                     "  - hostname: demo.sonnetcode.com\n    # edited by hand\n")
        self.set_config(text)
        out = self.run_cli("down", "demo")
        self.assertIn("does not recognise", out["message"])
        self.assertEqual(self.config(), text)
        self.assertIn("demo", self.links())  # still recorded, so a later down can retry

    def test_crlf_config_keeps_its_line_endings(self):
        crlf = CONFIG_TEXT.replace("\n", "\r\n").encode()
        self.set_config(crlf.decode())
        port = self.serve_http()
        self.public["https://demo.sonnetcode.com"] = 200
        self.run_cli("up", "demo", f"--port={port}")
        raw = (self.tmp / "propuestas.yml").read_bytes()
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))
        self.assertIn(b"  - hostname: demo.sonnetcode.com\r\n", raw)
        self.public["https://demo.sonnetcode.com"] = 404
        self.run_cli("down", "demo")
        self.assertEqual((self.tmp / "propuestas.yml").read_bytes(), crlf)

    def test_re_up_with_hand_edited_rule_shape_is_refused(self):
        port = self.serve_http()
        self.public["https://demo.sonnetcode.com"] = 200
        self.run_cli("up", "demo", f"--port={port}")
        text = self.config().replace("  - hostname: demo.sonnetcode.com\n",
                                     "  - hostname: demo.sonnetcode.com\n    # edited by hand\n")
        self.set_config(text)
        restarts = self.calls().count("restart site-tunnel")
        self.assertIn("does not recognise", self.run_cli("up", "demo", f"--port={port}")["message"])
        self.assertEqual(self.config(), text)
        self.assertEqual(self.calls().count("restart site-tunnel"), restarts)

    def test_corrupt_restart_budget_is_not_fatal(self):
        (self.tmp / "state").mkdir()
        (self.tmp / "state" / "restarts.json").write_text("garbage")
        port = self.serve_http()
        self.public["https://demo.sonnetcode.com"] = 200
        self.assertTrue(self.run_cli("up", "demo", f"--port={port}")["success"])

    def test_missing_catchall_is_refused(self):
        self.set_config(CONFIG_TEXT.replace("  - service: http_status:404\n", ""))
        port = self.serve_http()
        self.assertIn("http_status:404", self.run_cli("up", "demo", f"--port={port}")["message"])
        self.assertEqual(self.links(), {})


class FolderMode(Base):
    def test_folder_outside_prototypes_is_refused(self):
        outside = self.tmp / "elsewhere"
        outside.mkdir()
        (outside / "index.html").write_text("x")
        for folder in (str(outside), str(self.tmp / "prototypes"), "~/.ssh", "../elsewhere", "idea/../../elsewhere"):
            self.assertIn("only folders inside", self.run_cli("up", "demo", f"--folder={folder}")["message"], folder)
        self.assertNotIn("route dns", self.calls())

    def test_sandbox_path_is_mapped(self):
        self.assertEqual(self.m._folder_parts("/workspace/prototypes/idea/site"), ["idea", "site"])
        self.assertEqual(self.m._folder_parts("idea/site"), ["idea", "site"])

    def test_symlink_inside_is_refused(self):
        d = self.site()
        (d / "leak").symlink_to("/etc/passwd")
        self.assertIn("symlink", self.run_cli("up", "demo", f"--folder={d}")["message"])
        self.assertNotIn("route dns", self.calls())
        self.assertEqual(self.links(), {})

    def test_symlinked_folder_or_parent_is_refused(self):
        d = self.site()
        (self.tmp / "prototypes" / "alias").symlink_to(d.parent)
        for folder in ("alias/site", str(self.tmp / "prototypes" / "alias" / "site")):
            self.assertIn("not a plain folder", self.run_cli("up", "demo", f"--folder={folder}")["message"])

    def test_hard_link_is_refused(self):
        d = self.site()
        os.link(d / "index.html", d / "copy.html")
        self.assertIn("hard link", self.run_cli("up", "demo", f"--folder={d}")["message"])

    def test_secret_files_are_refused(self):
        for i, name in enumerate((".env", "id_rsa", "00000000-1111-2222-3333-444444444444.json", "auth.json", ".git")):
            d = self.site(f"idea{i}")
            if name == ".git":
                (d / name).mkdir()
            else:
                (d / name).write_text("KEY=1")
            self.assertIn("secret", self.run_cli("up", "demo", f"--folder={d}")["message"], name)
            self.assertFalse((self.tmp / "state" / "demo").exists())

    def test_directory_swapped_for_symlink_mid_copy_is_refused(self):
        """The race the security review found: a directory checked as a directory, then replaced by
        a symlink before it is opened. Simulated by having stat() report the symlink as a directory."""
        d = self.site()
        outside = self.tmp / "outside"
        outside.mkdir()
        (outside / "creds.txt").write_text("secret")
        (d / "a").symlink_to(outside)
        real_stat = os.stat

        def lying_stat(path, *a, **kw):
            if path == "a":
                return real_stat(str(outside))  # a directory, as it was when the scan saw it
            return real_stat(path, *a, **kw)
        with mock.patch.object(self.m.os, "stat", lying_stat):
            out = self.run_cli("up", "demo", f"--folder={d}")
        self.assertIn("not a plain folder", out["message"])
        self.assertFalse(any(p.name == "creds.txt" for p in (self.tmp / "state").rglob("*")))

    def test_folder_mode_end_to_end_with_refresh(self):
        self.fake_units()
        d = self.site()
        self.public["https://demo.sonnetcode.com"] = 200
        out = self.run_cli("up", "demo", "--folder=/workspace/prototypes/idea/site")
        self.assertTrue(out["success"], out)
        port = out["port"]
        unit = (self.tmp / "units" / "sonnet-link-demo.service").read_text()
        self.assertIn(f'"serve" "{self.tmp / "state" / "demo" / "public"}" "{port}"', unit)
        self.assertNotIn("PrivateDevices", unit)  # breaks user units on this host (218/CAPABILITIES)
        self.assertIn("enable sonnet-link-demo.service", self.calls())

        def fetch():
            with self.m.urllib.request.urlopen(f"http://127.0.0.1:{port}/") as r:
                return r.read()
        self.assertEqual(fetch(), b"<h1>v1</h1>")
        (d / "index.html").write_text("<h1>v2</h1>")
        restarts = self.calls().count("restart site-tunnel")
        out = self.run_cli("up", "demo", f"--folder={d}")
        self.assertTrue(out["success"], out)
        self.assertFalse(out["tunnel_restarted"])
        self.assertEqual(self.calls().count("restart site-tunnel"), restarts)
        self.assertEqual(out["port"], port)
        self.assertEqual(fetch(), b"<h1>v2</h1>")

        (d / ".env").write_text("KEY=1")  # a refused refresh leaves the live site as it was
        self.assertIn("secret", self.run_cli("up", "demo", f"--folder={d}")["message"])
        self.assertEqual(fetch(), b"<h1>v2</h1>")
        self.assertEqual(self.links()["demo"]["status"], "up")

        self.public["https://demo.sonnetcode.com"] = 404
        self.assertTrue(self.run_cli("down", "demo")["success"])
        self.assertFalse((self.tmp / "units" / "sonnet-link-demo.service").exists())
        self.assertFalse((self.tmp / "state" / "demo").exists())
        self.assertIn("disable --now sonnet-link-demo.service", self.calls())
        self.assertEqual(self.config(), CONFIG_TEXT)

    def test_folder_failure_before_tunnel_removes_the_unit(self):
        self.fake_units()
        d = self.site()
        out = self.run_cli("up", "taken", f"--folder={d}")  # the fake DNS refuses "taken"
        self.assertIn("never overwritten", out["message"])
        self.assertFalse((self.tmp / "units" / "sonnet-link-taken.service").exists())
        self.assertFalse((self.tmp / "state" / "taken").exists())
        self.assertIn("disable --now sonnet-link-taken.service", self.calls())
        self.assertEqual(self.links(), {})

    def test_failure_inside_write_unit_removes_the_unit(self):
        d = self.site()
        os.environ["FAIL_UNIT"] = "1"
        out = self.run_cli("up", "demo", f"--folder={d}")
        self.assertIn("restart sonnet-link-demo.service failed", out["message"])
        self.assertFalse((self.tmp / "units" / "sonnet-link-demo.service").exists())
        self.assertIn("disable --now sonnet-link-demo.service", self.calls())
        self.assertEqual(self.links(), {})

    def test_file_growing_during_copy_is_refused(self):
        d = self.site()
        big = d / "big.bin"
        big.write_bytes(b"x" * 1000)
        real_fstat = os.fstat

        def fstat_then_grow(fd):
            st = real_fstat(fd)
            if os.readlink(f"/proc/self/fd/{fd}").endswith("big.bin"):
                with open(big, "ab") as fh:
                    fh.write(b"y" * 5000)
            return st
        with mock.patch.object(self.m.os, "fstat", fstat_then_grow):
            out = self.run_cli("up", "demo", f"--folder={d}")
        self.assertIn("grew while", out["message"])
        self.assertFalse((self.tmp / "state" / "demo").exists())

    def test_unit_args_escape_systemd_specifiers(self):
        self.assertEqual(self.m._unit_arg("/a/%h/$HOME"), '"/a/%%h/$$HOME"')
        with self.assertRaises(self.m.Refused):
            self.m._unit_arg('/a/"b')

    def test_remove_unit_ignores_foreign_names(self):
        self.m._remove_unit("site-tunnel.service")
        self.m._remove_unit("../../evil.service")
        self.assertNotIn("disable", self.calls())

    def test_static_server_confines_requests(self):
        d = self.site()
        (d.parent / "secret.txt").write_text("no")
        (d / "out").symlink_to(d.parent / "secret.txt")
        os.mkdir(d / "sub")
        port = self.serve_http(directory=str(d))

        def get(path):
            return self.m._http_status(f"http://127.0.0.1:{port}{path}")
        self.assertEqual(get("/"), 200)
        self.assertEqual(get("/../secret.txt"), 404)
        self.assertEqual(get("/%2e%2e/secret.txt"), 404)
        self.assertEqual(get("/out"), 404)
        self.assertEqual(get("/sub/"), 404)  # no directory listings
        with self.m.urllib.request.urlopen(f"http://127.0.0.1:{port}/") as r:
            csp = r.headers["Content-Security-Policy"]
        self.assertIn("connect-src 'self'", csp)
        self.assertIn("default-src 'self'", csp)

    def test_local_check_does_not_follow_redirects(self):
        class Redirect(_Quiet):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:9/elsewhere")
                self.end_headers()
        port = self.m._free_port(set())
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Redirect)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        self.assertEqual(self.m._http_status(f"http://127.0.0.1:{port}/"), 302)


class PluginWrapper(unittest.TestCase):
    """The Hermes wrapper: argv rebuilt from typed fields, and the caller allowlist."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("sonnet_link_plugin", HERE / "__init__.py")
        self.p = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.p)
        self.seen, self.session = [], {}

        class R:
            returncode, stdout, stderr = 0, '{"success": true}', ""
        fake_ctx = types.ModuleType("gateway.session_context")
        fake_ctx.get_session_env = lambda name, default="": self.session.get(name, default)
        gw = types.ModuleType("gateway")
        gw.session_context = fake_ctx
        for pt in (mock.patch.object(self.p.subprocess, "run",
                                     lambda argv, **kw: (self.seen.append((argv, kw)), R())[1]),
                   mock.patch.dict(sys.modules, {"gateway": gw, "gateway.session_context": fake_ctx}),
                   mock.patch.dict(os.environ, {"TELEGRAM_ALLOWED_USERS": "111,222"}),
                   mock.patch.object(self.p, "_interactive", lambda: True)):
            pt.start()
            self.addCleanup(pt.stop)
        for key in ("HERMES_PLATFORM", "HERMES_SDLC_DEPTH"):
            pt = mock.patch.dict(os.environ)
            pt.start()
            self.addCleanup(pt.stop)
            os.environ.pop(key, None)

    def call(self, **params) -> dict:
        return json.loads(self.p._handle(params))

    def test_argv_is_built_from_fields(self):
        self.assertTrue(self.call(action="up", subdomain="demo", port=4317)["success"])
        self.assertEqual(self.seen[-1][0][-3:], ["up", "demo", "--port=4317"])
        self.call(action="up", subdomain="demo", folder="-x")
        self.assertEqual(self.seen[-1][0][-1], "--folder=-x")
        self.call(action="down", subdomain="demo")
        self.assertEqual(self.seen[-1][0][-2:], ["down", "demo"])

    def test_child_env_is_minimal(self):
        with mock.patch.dict(os.environ, {"SONNET_LINK_CONFIG": "/tmp/evil.yml", "SONNET_LINK_CLOUDFLARED": "/x"}):
            self.call(action="list")
        env = self.seen[-1][1]["env"]
        self.assertEqual([k for k in env if k.startswith("SONNET_LINK")], [])
        self.assertIn("XDG_RUNTIME_DIR", env)

    def test_rejects_malformed_params(self):
        for params in ({"action": "rm"}, {"action": "up", "subdomain": "--port"},
                       {"action": "up", "subdomain": "demo"},
                       {"action": "up", "subdomain": "demo", "port": 4317, "folder": "x"},
                       {"action": "up", "subdomain": "demo", "port": True},
                       {"action": "up", "subdomain": "demo", "port": "4317"},
                       {"action": "down", "subdomain": "demo", "port": 4317}):
            self.assertFalse(self.call(**params)["success"], params)
        self.assertEqual(self.seen, [])

    def test_non_json_output_and_timeout_are_reported(self):
        class Bad:
            returncode, stdout, stderr = 1, "Traceback...", "boom"
        with mock.patch.object(self.p.subprocess, "run", lambda argv, **kw: Bad()):
            self.assertIn("exit 1", self.call(action="list")["message"])

        def hang(argv, **kw):
            raise self.p.subprocess.TimeoutExpired(argv, 1)
        with mock.patch.object(self.p.subprocess, "run", hang):
            self.assertIn("half made", self.call(action="list")["message"])

    def gate(self, action="up", **session) -> str:
        self.session = session
        return self.p._caller_problem(action)

    def test_owner_on_telegram_and_local_cli_are_allowed(self):
        self.assertEqual(self.gate(HERMES_SESSION_PLATFORM="telegram", HERMES_SESSION_USER_ID="222"), "")
        self.assertEqual(self.gate(), "")  # local CLI, no platform
        self.assertEqual(self.gate(HERMES_SESSION_SOURCE="tui"), "")

    def test_everyone_else_may_only_list(self):
        refused = [
            dict(HERMES_SESSION_PLATFORM="telegram", HERMES_SESSION_USER_ID="999"),
            dict(HERMES_SESSION_PLATFORM="telegram"),
            dict(HERMES_SESSION_PLATFORM="webhook"),
            dict(HERMES_SESSION_PLATFORM="api_server"),
            dict(HERMES_SESSION_PLATFORM="discord", HERMES_SESSION_USER_ID="222"),
            dict(HERMES_SESSION_SOURCE="kanban"),
            dict(HERMES_SESSION_SOURCE="webhook"),
            dict(HERMES_CRON_SESSION="1"),
            dict(HERMES_CRON_SESSION="1", HERMES_SESSION_PLATFORM="telegram", HERMES_SESSION_USER_ID="222"),
        ]
        for session in refused:
            for action in ("up", "down"):
                self.assertNotEqual(self.gate(action, **session), "", session)
            self.assertEqual(self.gate("list", **session), "", session)

    def test_sub_agents_and_non_interactive_cli_are_refused(self):
        with mock.patch.dict(os.environ, {"HERMES_SDLC_DEPTH": "1"}):
            self.assertIn("sub-agents", self.gate())
        with mock.patch.object(self.p, "_interactive", lambda: False):
            self.assertNotEqual(self.gate(), "")

    def test_no_allowlist_means_no_telegram_user(self):
        with mock.patch.dict(os.environ, {"TELEGRAM_ALLOWED_USERS": "", "HERMES_HOME": "/nonexistent"}):
            self.assertNotEqual(self.gate(HERMES_SESSION_PLATFORM="telegram", HERMES_SESSION_USER_ID="222"), "")

    def test_refused_caller_never_reaches_the_script(self):
        self.session = {"HERMES_SESSION_PLATFORM": "webhook"}
        self.assertFalse(self.call(action="up", subdomain="demo", port=4317)["success"])
        self.assertEqual(self.seen, [])

    def test_register(self):
        ctx = mock.Mock()
        self.p.register(ctx)
        ctx.register_tool.assert_called_once()
        self.assertEqual(ctx.register_tool.call_args.kwargs["name"], "sonnet_link")
        name, path = ctx.register_skill.call_args.args[:2]
        self.assertEqual(name, "sonnet-link")
        self.assertTrue(Path(path).is_file())


if __name__ == "__main__":
    unittest.main()
