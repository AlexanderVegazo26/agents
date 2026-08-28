---
description: Re-audit the SDLC registry — schema validation, orphan detection, overlap analysis, tech-agnosticism — with every finding adversarially verified
argument-hint: [registry root, defaults to this plugin]
---

Invoke the `Workflow` tool with:

```
scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/registry-audit.js"
args: { "root": "<root from $ARGUMENTS, else ${CLAUDE_PLUGIN_ROOT}>" }
```

The default root is the plugin itself, not the consuming repo's `.claude/` — this audits the suite, not the project you happen to be in.

Autonomy: this run is unattended unless the user is clearly present. Pass the resolved policy path to the workflow so agents can find it — add `policy: "${CLAUDE_PLUGIN_ROOT}/autonomy.json"` to the args object, and tell agents that gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
