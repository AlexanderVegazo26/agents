#!/usr/bin/env python3
"""vexa_mcp — a tiny MCP client for the Vexa MCP service.

The service speaks streamable HTTP with a session: initialize → get the session id
header → notify initialized → call tools. Hermes has its own client; this is the
same dance in ~60 lines so the meeting scripts can use the very same tools an
agent would (parse_meeting_link, request_meeting_bot, get_bot_status, …) instead
of reimplementing link parsing.

  with vexa_mcp.Mcp() as m:
      print(m.call("parse_meeting_link", {"meeting_url": "https://meet.google.com/abc-defg-hij"}))
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:18010/mcp"
ENV_FILE = Path.home() / ".hermes/.env"


def api_key(env_file: Path = ENV_FILE) -> str:
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith("MCP_VEXA_API_KEY="):
            key = line.split("=", 1)[1].strip().strip("'\"")
            if key:
                return key
    raise RuntimeError(f"MCP_VEXA_API_KEY is not set in {env_file}")


class McpError(RuntimeError):
    pass


class Mcp:
    def __init__(self, url: str = DEFAULT_URL, key: str | None = None, timeout: int = 30):
        self.url = url
        self.key = key or api_key()
        self.timeout = timeout
        self.session_id: str | None = None
        self._id = 0

    # ── plumbing ───────────────────────────────────────────────────────────
    def _post(self, payload: dict, want_headers: bool = False):
        req = urllib.request.Request(self.url, data=json.dumps(payload).encode(), method="POST")
        req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json, text/event-stream")
        if self.session_id:
            req.add_header("Mcp-Session-Id", self.session_id)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                body = r.read().decode("utf-8", "replace")
                headers = dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            headers = dict(e.headers)
            if want_headers:
                return headers, body
            raise McpError(f"MCP HTTP {e.code}: {body[:300]}") from e
        except urllib.error.URLError as e:
            raise McpError(f"cannot reach the Vexa MCP service at {self.url}: {e.reason}") from e
        if want_headers:
            return headers, body
        return body

    @staticmethod
    def _payload(body: str) -> dict:
        """The transport may answer with JSON or with an SSE frame; take the data."""
        body = (body or "").strip()
        if not body:
            return {}
        if body.startswith("{"):
            return json.loads(body)
        for line in body.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return json.loads(body)

    # ── lifecycle ──────────────────────────────────────────────────────────
    def start(self) -> "Mcp":
        headers, _ = self._post(
            {
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "vexa_mcp", "version": "1"},
                },
            },
            want_headers=True,
        )
        self.session_id = headers.get("Mcp-Session-Id") or headers.get("mcp-session-id")
        if not self.session_id:
            raise McpError("the MCP service did not return a session id")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return self

    def close(self) -> None:
        self.session_id = None

    def __enter__(self) -> "Mcp":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.close()

    # ── calls ──────────────────────────────────────────────────────────────
    def call(self, tool: str, arguments: dict) -> dict:
        self._id += 1
        body = self._post(
            {
                "jsonrpc": "2.0", "id": self._id, "method": "tools/call",
                "params": {"name": tool, "arguments": arguments},
            }
        )
        data = self._payload(body)
        if "error" in data:
            raise McpError(f"{tool}: {data['error']}")
        result = data.get("result") or {}
        if result.get("isError"):
            text = " ".join(c.get("text", "") for c in result.get("content", []))
            raise McpError(f"{tool}: {text[:400]}")
        text = " ".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        if not text:
            return result
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"text": text}
