#!/usr/bin/env python3
"""Fixed-port front for the LlamaStash `whisper` launch.

The LlamaStash 0.8.0 proxy has no /v1/audio/transcriptions route (the patch lived in the old
0.6.1 build) and the launch's own port changes on every start. Hermes voice notes need one
stable OpenAI-style URL, so this listens on 127.0.0.1:11436 and byte-pipes each upload to the
launch's current port, starting the launch first when it is down. Loopback only; the launch
itself takes no auth. Standard library only."""
import http.client, json, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 11436
ROUTES = ("/v1/audio/transcriptions", "/v1/audio/translations")
START_LOCK = threading.Lock()

def whisper_port():
    try:
        out = subprocess.run(["llamastash", "status", "--json"], capture_output=True, text=True, timeout=15).stdout
        for m in json.loads(out).get("models", []):
            if m.get("model_path") == "generic://whisper" and m.get("state") == "ready":
                return m["port"]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None

def ensure_whisper():
    port = whisper_port()
    if port:
        return port
    with START_LOCK:  # one start at a time; the others wait and then find it ready
        port = whisper_port()
        if not port:
            subprocess.run(["llamastash", "start", "whisper", "--wait"], capture_output=True, timeout=180)
            port = whisper_port()
    return port

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("stt_shim: " + fmt % args + "\n")

    def _reply(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            return self._reply(200, b'{"ok":true}')
        self._reply(404, b'{"error":{"type":"not_found","message":"no such route"}}')

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ROUTES:
            return self._reply(404, b'{"error":{"type":"not_found","message":"no such route"}}')
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        try:
            port = ensure_whisper()
            if not port:
                return self._reply(503, b'{"error":{"type":"unavailable","message":"whisper launch not ready"}}')
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3600)
            conn.request("POST", path, body, {"Content-Type": self.headers.get("Content-Type", "")})
            r = conn.getresponse()
            data = r.read()
            self._reply(r.status, data, r.getheader("Content-Type", "application/json"))
        except Exception as exc:  # a failed upload is reported, never fatal to the server
            self._reply(502, json.dumps({"error": {"type": "bad_gateway", "message": str(exc)[:200]}}).encode())

if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
