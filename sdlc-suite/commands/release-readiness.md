---
description: Collect every release gate in parallel from its owning agent, then synthesize an evidence-classified go/no-go recommendation
argument-hint: <release identifier>
---

Invoke the `Workflow` tool with:

```
scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/release-readiness.js"
args: "$ARGUMENTS"
```

Relay each gate's classification (Confirmed / Claimed-not-verified / Missing / N-A) without upgrading any of them. The recommendation is not a deploy authorization — see the plugin's `autonomy.json` for which release tiers, if any, are pre-authorized in this repo.

Autonomy: this run is unattended unless the user is clearly present. Pass the resolved policy path to the workflow so agents can find it — add `policy: "${CLAUDE_PLUGIN_ROOT}/autonomy.json"` to the args object, and tell agents that gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
