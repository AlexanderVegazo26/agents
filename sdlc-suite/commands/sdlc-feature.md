---
description: Run a feature end-to-end through the SDLC agent suite — requirements, design, build, independent verification, release readiness
argument-hint: <initiative description>
---

Invoke the `Workflow` tool with:

```
scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/sdlc-feature.js"
args: "$ARGUMENTS"
```

Do not reimplement the orchestration inline — the script is the plan. When it returns, relay the readiness recommendation and the `humanDecisionRequired` list verbatim; this workflow produces recommendations and never deploys.

Autonomy: this run is unattended unless the user is clearly present. Pass the resolved policy path to the workflow so agents can find it — add `policy: "${CLAUDE_PLUGIN_ROOT}/autonomy.json"` to the args object, and tell agents that gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
