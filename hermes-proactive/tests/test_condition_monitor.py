#!/usr/bin/env python3
"""Smoke tests for condition_monitor.py — run: python3 tests/test_condition_monitor.py

Uses a local HTTP server serving fixture pages; state is redirected to a
temp dir via HOME override so real ~/.hermes state is never touched.
"""

import functools
import http.server
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import condition_monitor as cm  # noqa: E402

PAGES = {
    "/price": "<html><body><p>Anthropic Sonnet $3.00 per million tokens</p></body></html>",
    "/price-up": "<html><body><p>Anthropic Sonnet $5.00 per million tokens</p></body></html>",
    "/text": "<html><body><p>All systems operational</p></body></html>",
    "/text-broken": "<html><body><p>Service outage reported</p></body></html>",
    "/api": json.dumps({"status": {"code": 200, "load": 42}}),
}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/flaky":
            if not hasattr(self.server, "_flaky_hits"):
                self.server._flaky_hits = 0
            self.server._flaky_hits += 1
            if self.server._flaky_hits < 3:
                self.send_response(500)
                self.end_headers()
                return
            body = "<p>up again</p>"
        else:
            body = PAGES.get(self.path)
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
        data = body.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class MonitorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._old_watch, self._old_state = cm.WATCH_DIR, cm.STATE_DIR
        cm.WATCH_DIR = os.path.join(self.tmp.name, "monitors")
        cm.STATE_DIR = os.path.join(self.tmp.name, "state")
        os.makedirs(cm.WATCH_DIR)
        self.page = functools

    def tearDown(self):
        cm.WATCH_DIR, cm.STATE_DIR = self._old_watch, self._old_state
        self.tmp.cleanup()

    def watch(self, name, path, kind, cond="", sel=None, ignore=None):
        w = {"name": name, "url": self.base + path, "kind": kind, "condition": cond,
             "selector": sel, "timeout": 5, "max_bytes": 100_000, "headers": {}}
        if ignore:
            w["ignore"] = ignore
        return w

    def test_price_below_transition(self):
        w = self.watch("p", "/price", "price_below", "4.00")
        line0 = cm.run_watch(w)                              # baseline: condition already met -> reports once
        self.assertIn("ALERT", line0)
        self.assertIsNone(cm.run_watch(w))                     # still below, deduped
        st = cm.load_state("p")
        self.assertEqual(st["value"], 3.0)
        # raise price above threshold
        PAGES["/price"] = PAGES["/price-up"]
        try:
            line = cm.run_watch(w)
            self.assertIsNotNone(line)
            self.assertIn("$5.00", line)
        finally:
            PAGES["/price"] = "<html><body><p>Anthropic Sonnet $3.00 per million tokens</p></body></html>"

    def test_text_contains_fires_once(self):
        w = self.watch("t", "/text", "text_contains", "outage")
        self.assertIsNone(cm.run_watch(w))
        PAGES["/text"] = PAGES["/text-broken"]
        try:
            line = cm.run_watch(w)
            self.assertIn("ALERT", line)
            self.assertIsNone(cm.run_watch(w))                 # dedup: still matching
        finally:
            PAGES["/text"] = "<html><body><p>All systems operational</p></body></html>"

    def test_changed_kind_with_ignore(self):
        PAGES["/volatile"] = "<html><body><p>All systems operational 12:34</p></body></html>"
        w = self.watch("c", "/volatile", "changed", ignore=[r"\d{1,2}:\d{2}"])
        try:
            self.assertIsNone(cm.run_watch(w))               # baseline, silent
            PAGES["/volatile"] = "<html><body><p>All systems operational 12:35</p></body></html>"
            self.assertIsNone(cm.run_watch(w))               # only the ignored timestamp moved
            PAGES["/volatile"] = "<html><body><p>All systems degraded 12:35</p></body></html>"
            line = cm.run_watch(w, mode="transitions")
            self.assertIsNotNone(line and "CHANGE DETECTED" in line and line)
        finally:
            del PAGES["/volatile"]

    def test_json_below(self):
        PAGES["/api"] = json.dumps({"status": {"code": 200, "load": 60}})
        w = self.watch("j", "/api", "json_below", "50", sel="status.load")
        try:
            self.assertIsNone(cm.run_watch(w))               # 60 >= 50: quiet baseline
            self.assertFalse(cm.load_state("j")["alert"])
            PAGES["/api"] = json.dumps({"status": {"code": 200, "load": 42}})
            self.assertIn("ALERT", cm.run_watch(w))          # crossed below threshold
            PAGES["/api"] = json.dumps({"status": {"code": 200, "load": 99}})
            line = cm.run_watch(w)                           # recovered above threshold
            self.assertIsNotNone(line and "ok" in line and line)
        finally:
            PAGES["/api"] = json.dumps({"status": {"code": 200, "load": 42}})

    def test_failure_backoff_and_recovery(self):
        w = self.watch("f", "/flaky", "text_contains", "up")
        l1 = cm.run_watch(w)                                   # 1st failure -> alert line
        self.assertIsNotNone(l1 and "ERROR" in l1 and l1)
        self.assertIsNone(cm.run_watch(w))                     # within backoff -> silent
        st = cm.load_state("f")
        self.assertGreaterEqual(st["failures"], 2)
        line = cm.run_watch(w)                                 # 3rd hit succeeds -> recovery
        self.assertIn("recovered", line)

    def test_http_error_releases_its_socket(self):
        # a watch polling a failing URL every tick must not leak one socket per tick
        with self.assertRaises(urllib.error.HTTPError) as caught:
            cm.fetch(self.base + "/missing", None, 5, 1000)
        self.assertEqual(caught.exception.code, 404, f"fetch {self.base}/missing")
        self.assertTrue(caught.exception.fp is None or caught.exception.fp.closed,
                        f"HTTPError for /missing still holds an open response: {caught.exception.fp!r}")

    def test_state_mode_emits_stable_lines(self):
        w = self.watch("s", "/text", "text_contains", "outage")
        l1 = cm.run_watch(w, mode="state")
        l2 = cm.run_watch(w, mode="state")
        self.assertEqual(l1, l2)                               # stable -> hermes suppresses

    def test_add_and_list(self):
        w = self.watch("x", "/text", "changed")
        with open(os.path.join(cm.WATCH_DIR, "x.json"), "w") as f:
            json.dump(w, f)
        names = [x["name"] for x in cm.list_watches()]
        self.assertIn("x", names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
