---
name: trigger
description: "Fire cron jobs from webhooks (GitHub, generic). Turn poll-based Hermes cron jobs into event-driven ones: webhooks (GitHub HMAC or generic shared-secret) fire hermes cron jobs on matching events. Usage: /trigger add-github ..., /trigger list, /trigger test <id> <payload.json>"
---

`triggerd.py` receives signed webhooks and fires Hermes cron jobs. Source:
`~/Documents/repos/personal/agents/hermes-proactive/triggerd.py`, installed as
`~/.hermes/scripts/triggerd.py`. Config: `~/.hermes/triggers.json`. Delivery log:
`~/.hermes/state/triggerd.log`. Service: `hermes-triggerd` (systemd user unit), health check
`curl localhost:8471/healthz`.

A rule binds an event to a cron job. When a signed POST matches, triggerd runs
`hermes cron run <job>`; the job fires on the next scheduler tick. The payload is not passed
on: the job's own script re-fetches what it needs, so jobs must be idempotent.

GitHub rule:
`triggerd.py add-github <id> --job <cron-job-name> --secret-env TRIGGER_SECRET_GH --event issues --action opened --repo owner/name --json-path issue.title --contains urgent`
Then the owner adds `TRIGGER_SECRET_GH=<random>` to `~/.hermes/.env` and registers the webhook
in the repo (Settings → Webhooks): payload URL `http://<host>:8471/github/<id>`, content type
`application/json`, the same secret, and only the events the rule filters on.

Generic rule: `triggerd.py add-generic <id> --job <job> --secret-env <ENV> --json-path status --equals failed`,
then POST to `/hook/<id>` with header `X-Trigger-Signature: sha256=<hmac-sha256(secret, raw-body)>`.

Other commands: `triggerd.py test <id> <payload.json> --event push` (no dispatch),
`triggerd.py list` (rules and recent deliveries), `triggerd.py remove <id>`.

Security:
- triggers.json holds only the env var name, never the secret. Never print or log a secret.
- Bind to 127.0.0.1 unless a reverse proxy provides TLS and auth.
- Every rule has a secret; unsigned requests get a 403.
- Restarting the service or exposing the port publicly needs the owner's approval.
