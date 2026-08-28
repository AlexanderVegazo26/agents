---
description: Review a change through four independent evidentiary bases in parallel, adversarially cross-check every finding, then merge into one ranked report
argument-hint: <branch, path list, or "working tree">
---

Invoke the `Workflow` tool with:

```
scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/independent-review.js"
args: "$ARGUMENTS"
```

If no target was given, pass `"the current working tree"`. Report surviving findings ranked by blast radius, and state how many were refuted.

Autonomy: this run is unattended unless the user is clearly present. Pass the resolved policy path to the workflow so agents can find it — add `policy: "${CLAUDE_PLUGIN_ROOT}/autonomy.json"` to the args object, and tell agents that gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
