---
name: trigger
description: "Turn poll-based Hermes cron jobs into event-driven ones: webhooks (GitHub HMAC or generic shared-secret) fire hermes cron jobs on matching events. Usage: /trigger add-github ..., /trigger list, /trigger test <id> <payload.json>"
---

You manage `triggerd.py`, the OpenBot-style event-trigger receiver for
Hermes cron. Code: `~/Documents/repos/agents/hermes-proactive/triggerd.py`
(installed to `~/.hermes/scripts/`). Config: `~/.hermes/triggers.json`;
delivery log: `~/.hermes/state/triggerd.log`.

Concept: a rule binds an ingress event to a hermes cron job. When a signed
HTTP POST matches the rule, triggerd runs `hermes cron run <job>` — the job
fires on the next scheduler tick with the event's payload NOT auto-attached
(the job's own script re-fetches whatever it needs; keep jobs idempotent).

Add a GitHub rule:
`triggerd.py add-github <id> --job <cron-job-name> --secret-env TRIGGER_SECRET_GH
  --event issues --action opened --repo owner/name --json-path issue.title --contains urgent`
Then put the secret in `~/.hermes/.env` (`TRIGGER_SECRET_GH=<random>`) and
register the webhook in the repo (Settings > Webhooks):
payload URL `http://<host>:8471/github/<id>`, content type `application/json`,
secret = same value, events = the ones you filter on.

Generic rules: `triggerd.py add-generic <id> --job <job> --secret-env <ENV>
  --json-path status --equals failed` → POST to `/hook/<id>` with header
`X-Trigger-Signature: sha256=<hmac-sha256(secret, raw-body)>`.

Test without dispatch: `triggerd.py test <id> <payload.json> --event push`.
List rules + recent deliveries: `triggerd.py list`. Remove: `triggerd.py remove <id>`.

Running it: triggerd is a long-lived process. Preferred:
`systemctl --user enable --now hermes-triggerd` (unit in the repo at
`systemd/hermes-triggerd.service`). Verify with `curl localhost:8471/healthz`.

Security rules (non-negotiable):
- Never put the secret itself in triggers.json — only the env var NAME.
- Bind to 127.0.0.1 unless you have a reverse proxy doing TLS + auth.
- Every rule MUST have a secret; unsigned requests get a 403.
