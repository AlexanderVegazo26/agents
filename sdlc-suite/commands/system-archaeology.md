---
description: Reverse-engineer an undocumented system — derive who uses it and what it does in parallel, cross-check, and synthesize an as-built PRD
argument-hint: <scope, e.g. a path or "the whole application">
---

Invoke the `Workflow` tool with:

```
scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/system-archaeology.js"
args: "$ARGUMENTS"
```

Output is evidence, never a recommendation about what to change.

Autonomy: this run is unattended unless the user is clearly present. Pass the resolved policy path to the workflow so agents can find it — add `policy: "${CLAUDE_PLUGIN_ROOT}/autonomy.json"` to the args object, and tell agents that gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
