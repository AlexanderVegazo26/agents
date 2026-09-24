---
description: Reverse-engineer an undocumented system — derive who uses it and what it does in parallel, cross-check, and synthesize an as-built PRD
argument-hint: <scope, e.g. a path or "the whole application">
---

Invoke the `Workflow` tool with:

```
scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/system-archaeology.js"
args: { "scope": "$ARGUMENTS", "runtimeDir": "${CLAUDE_PLUGIN_ROOT}/workflows", "policyDefault": "${CLAUDE_PLUGIN_ROOT}/autonomy.json" }
```

Output is evidence, never a recommendation about what to change.

Pass `args` as the literal OBJECT above, never a bare string. `runtimeDir` is what lets the workflow reach its run recorder, retry breaker, learnings loader and policy loader; a string `args` carries none of it, and the run then records nothing and learns nothing — the workflow reports that as status `incomplete` with a `runtime.unreachable` blocked gate, never as `completed`. `policyDefault` is the plugin's shipped policy, a fallback: a repo's own `.claude/autonomy.json` overrides it. To make a run stricter than the repo allows, also pass `policy`: an explicit policy is INTERSECTED with the repo's (a gate is authorized only if both authorize it), so it can tighten a repo's policy and never loosen it.

Autonomy: this run is unattended unless the user is clearly present. Gates not pre-authorized by the resolved policy are recorded as BLOCKED rather than halting the run.
