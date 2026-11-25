"""HTTP clients for the ClickUp REST v2 API and the Discord REST API (stdlib only, so they run
under /usr/bin/python3 from cron without the gateway). Credentials come from the process
environment or, failing that, from exactly the named keys in ~/.hermes/.env; nothing else in that
file is read, and tokens are never logged or included in error messages."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from pm_core import HERMES_HOME

USER_AGENT = "hermes-project-manager/1.0"


class ApiError(RuntimeError):
    def __init__(self, service: str, status: int | None, detail: str):
        super().__init__(f"{service} API error {status}: {detail}")
        self.service, self.status, self.detail = service, status, detail


def env_value(key: str) -> str | None:
    v = os.environ.get(key)
    if v:
        return v.strip()
    try:
        for line in (HERMES_HOME / ".env").read_text().splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip("'\"") or None
    except OSError:
        pass
    return None


def _request(service: str, method: str, url: str, headers: dict, body: dict | None = None,
             retries: int = 3, timeout: int = 30):
    data = json.dumps(body).encode() if body is not None else None
    last: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={**headers, "User-Agent": USER_AGENT,
                                              **({"Content-Type": "application/json"} if data else {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code == 429 or e.code >= 500:
                retry_after = 2 ** attempt
                try:
                    retry_after = float(json.loads(detail).get("retry_after", retry_after))
                except Exception:
                    pass
                last = ApiError(service, e.code, detail)
                time.sleep(min(retry_after, 30))
                continue
            raise ApiError(service, e.code, detail) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = ApiError(service, None, f"network: {e.__class__.__name__}")
            time.sleep(2 ** attempt)
    raise last or ApiError(service, None, "unknown failure")


class ClickUp:
    BASE = "https://api.clickup.com/api/v2"

    def __init__(self, token: str | None = None):
        self.token = token or env_value("CLICKUP_API_TOKEN")
        if not self.token:
            raise ApiError("ClickUp", None, "CLICKUP_API_TOKEN is not set in the environment or ~/.hermes/.env")

    def get(self, path: str, params: dict | None = None):
        q = ("?" + urllib.parse.urlencode(params, doseq=True)) if params else ""
        return _request("ClickUp", "GET", self.BASE + path + q, {"Authorization": self.token})

    def list_tasks(self, list_id: str) -> list[dict]:
        out, page = [], 0
        while True:
            r = self.get(f"/list/{list_id}/task", {"include_closed": "true", "subtasks": "true",
                                                   "archived": "false", "page": page})
            tasks = r.get("tasks") or []
            out += tasks
            if r.get("last_page", True) or not tasks:
                return out
            page += 1

    def team_members(self, workspace_id: str) -> list[dict]:
        for t in self.get("/team").get("teams") or []:
            if str(t["id"]) == str(workspace_id):
                return [m["user"] for m in t.get("members") or []]
        raise ApiError("ClickUp", 404, f"workspace {workspace_id} not visible to this token")


class Discord:
    BASE = "https://discord.com/api/v10"

    def __init__(self, token: str | None = None):
        self.token = token or env_value("DISCORD_BOT_TOKEN")
        if not self.token:
            raise ApiError("Discord", None, "DISCORD_BOT_TOKEN is not set")
        self._me: dict | None = None

    def call(self, method: str, path: str, body: dict | None = None):
        return _request("Discord", method, self.BASE + path, {"Authorization": "Bot " + self.token}, body)

    def me(self) -> dict:
        if self._me is None:
            self._me = self.call("GET", "/users/@me")
        return self._me

    def send(self, channel_id: str, content: str, user_ids: list[str], everyone: bool) -> str:
        """allowed_mentions is always explicit: only the listed users (and @everyone when asked)
        can ping, whatever else the text contains."""
        allowed = {"parse": ["everyone"] if everyone else [], "users": list(dict.fromkeys(user_ids))[:100]}
        r = self.call("POST", f"/channels/{channel_id}/messages", {"content": content, "allowed_mentions": allowed})
        return str(r["id"])

    def can_mention_everyone(self, guild_id: str, channel_id: str) -> bool:
        """Bot's effective MENTION_EVERYONE in the channel: guild roles, then channel overwrites."""
        me = self.me()["id"]
        guild = self.call("GET", f"/guilds/{guild_id}")
        member = self.call("GET", f"/guilds/{guild_id}/members/{me}")
        roles = {r["id"]: int(r["permissions"]) for r in guild["roles"]}
        perms = roles.get(str(guild_id), 0)
        for rid in member.get("roles", []):
            perms |= roles.get(rid, 0)
        if perms & (1 << 3):  # administrator
            return True
        ch = self.call("GET", f"/channels/{channel_id}")
        ow = {o["id"]: o for o in ch.get("permission_overwrites", [])}
        def apply(p, oid):
            if oid in ow:
                p = (p & ~int(ow[oid]["deny"])) | int(ow[oid]["allow"])
            return p
        perms = apply(perms, str(guild_id))
        allow = deny = 0
        for rid in member.get("roles", []):
            if rid in ow:
                allow |= int(ow[rid]["allow"])
                deny |= int(ow[rid]["deny"])
        perms = (perms & ~deny) | allow
        perms = apply(perms, me)
        return bool(perms & (1 << 17)) and bool(perms & (1 << 11))

    def guild_member(self, guild_id: str, user_id: str) -> dict | None:
        try:
            return self.call("GET", f"/guilds/{guild_id}/members/{user_id}")
        except ApiError as e:
            if e.status == 404:
                return None
            raise
