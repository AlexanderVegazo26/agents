---
description: Derive real end-user personas from code evidence, explore the app as each, then probe authorization boundaries between every persona pair
argument-hint: <target URL> [env]
---

Invoke the `Workflow` tool with:

```
scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/persona-qa-sweep.js"
args: { "target": "<target from $ARGUMENTS>", "env": "<env, default non-production>" }
```

Never point this at production. If `$ARGUMENTS` names a production host or no target at all, stop and say so instead of running.

Autonomy: this run is unattended unless the user is clearly present. Pass the resolved policy path to the workflow so agents can find it — add `policy: "${CLAUDE_PLUGIN_ROOT}/autonomy.json"` to the args object, and tell agents that gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
