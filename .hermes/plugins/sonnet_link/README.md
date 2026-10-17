# sonnet_link: public sonnetcode.com links for Hermes

Lets Hermes open and close `https://<sub>.sonnetcode.com` links through the shared named Cloudflare tunnel `sonnetcode-propuestas`. The Hermes terminal is a Docker sandbox that can't reach `cloudflared` or `systemctl`, so the work runs on the host:

| File | Role |
|---|---|
| `sonnet_link.py` | Host CLI (`up`, `down`, `list`), standard library only. Every safety check lives here. |
| `__init__.py` | Hermes registration: the `sonnet_link` tool, a thin wrapper that rebuilds argv from typed fields, and the `sonnet_link:sonnet-link` skill. |
| `SKILL.md` | When to use the tool, what to confirm with the user first, and how to report the result. |
| `test_sonnet_link.py` | Offline tests: cloudflared, systemctl and the public URL are faked. Run with `python3 -m unittest test_sonnet_link.py`. |

The manual procedure it automates is the Basic Memory note *Expose a local service on a sonnetcode.com subdomain* (`howto/`).

## What it will and won't do

- **`up <sub> --port=<n>`** exposes a service that is already running on a port from 4300 to 4399, listening on loopback only and answering 2xx/3xx. 4312, 4313 (the agent-computer viewer) and 4320 (propuestas) are denied. Everything else on this machine's loopback (LLM servers, Hermes internals) has no auth and stays private. The checks run once, at `up`: whatever binds that port later is what gets served.
- **`up <sub> --folder=<dir>`** copies a folder from inside `~/prototypes` (the sandbox path `/workspace/prototypes/...` also works) to `~/.local/state/sonnet-link/<sub>/public`.
  - The copy walks directory file descriptors with `O_NOFOLLOW`, so a symlink swapped in mid-copy is refused rather than followed.
  - It refuses symlinks, hard links, special files and secret-looking names (`.env`, keys, `auth.json`, tunnel-credential-shaped `.json`, `.git`, ...) before copying anything.
  - It stages into `public.new` and swaps it in only when the copy is complete, so a refused refresh leaves the live site alone.
  - The copy is served by this file's own static server (no listings, nothing outside its root) through a hardened systemd user unit, `sonnet-link-<sub>.service`, which survives reboots.
  - Running `up` again refreshes the copy without restarting the tunnel.
- **`down <sub>`** removes only hostnames that `up` recorded in `~/.local/state/sonnet-link/links.json`. Hand-made rules such as `propuestas` are refused, and so is any hostname named in a shape the parser doesn't fully recognise. It reports success only when the public URL answers 404. The DNS CNAME stays (cloudflared can't delete it) and answers 404. In port mode the service itself keeps running.
- **Config edits:**
  - DNS is routed without `--overwrite-dns`, so an existing record is never replaced. Re-routing a name that already points at this tunnel exits 0 (measured).
  - An edit that fails `cloudflared ingress validate` is rolled back before any restart.
  - Only `propuestas.yml` is touched. A symlinked config is refused, CRLF is kept, and the credentials beside it are never opened.
- **Half-made links:** a link is recorded as `pending` before its first side effect. A failure that never reached the tunnel is undone. Otherwise the link is marked `failed`, and `down` cleans it up.
- **Tunnel restarts:** an `up` or `down` that adds or removes a hostname restarts `site-tunnel.service`, which takes every sonnetcode.com hostname offline for a few seconds. Restarts from `up` are capped at 6 per hour; `down` is never limited.
- **Who:** `up` and `down` are allowed only for the owner's Telegram account (`HERMES_SESSION_USER_ID` in `TELEGRAM_ALLOWED_USERS`) or a local interactive terminal. Cron, webhook, API-server and kanban sessions, sdlc sub-agents (`HERMES_SDLC_DEPTH`) and non-interactive runs may only `list`. The model is still told to confirm with the user before `up`, but nothing in the code enforces that confirmation. That is the residual risk: a prompt injection inside the owner's own session.

It does not start apps. A Node app like the ObraBase prototype still has to be run on the host first, for example as its own systemd unit. Then `up --port` publishes it.

## Install

```sh
ln -s ~/Documents/repos/agents/.hermes/plugins/sonnet_link ~/.hermes/plugins/sonnet_link
```

In `~/.hermes/config.yaml`:

1. Add `sonnet_link` to `plugins.enabled`.
2. Add it to `platform_toolsets.cli` and `platform_toolsets.telegram`.
3. Add it to `known_plugin_toolsets` for **every** platform: cli and telegram, and also each other platform in `hermes_cli.tools_config.PLATFORMS`. A plugin toolset that a platform doesn't list as known is on by default, which would hand the tool to webhook and API-server sessions.
4. Restart the gateway, then check that the tool resolves for cli and telegram only.

## Remove

Take every link down first (`sonnet_link.py list`, then `down` for each). Then reverse the install steps above and delete `~/.local/state/sonnet-link/`.

Hand-maintained: the tree generator never writes or removes anything under `.hermes/plugins/`.
