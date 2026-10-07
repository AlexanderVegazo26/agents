---
description: Re-audit the SDLC registry — schema validation, orphan detection, overlap analysis, tech-agnosticism — with every finding adversarially verified
argument-hint: [registry root, defaults to this plugin]
---

> **Pi.** This command invokes the `Workflow` tool, which under pi is the
> `workflow` tool registered by the `.pi/extensions/sdlc/` extension. Call
> it with the `scriptPath` and the `args` OBJECT below — an object, never
> a bare string — and report the pipeline's result, not a substitute. If
> the `workflow` tool is not available in this session (the extension is
> not loaded), say so to the user; do not improvise a substitute run, and
> do not report a result this pipeline did not produce.

Invoke the `Workflow` tool with:

```
scriptPath: "sdlc-suite/workflows/registry-audit.js"
args: { "root": "<root from $ARGUMENTS, else sdlc-suite>", "runtimeDir": "sdlc-suite/workflows", "policyDefault": "sdlc-suite/autonomy.json" }
```

The default root is the plugin itself, not the consuming repo's `.claude/` — this audits the suite, not the project you happen to be in.

Pass `args` as the literal OBJECT above, never a bare string. `runtimeDir` is what lets the workflow reach its run recorder, retry breaker, learnings loader and policy loader; a string `args` carries none of it, and the run then records nothing and learns nothing — the workflow reports that as status `incomplete` with a `runtime.unreachable` blocked gate, never as `completed`. `policyDefault` is the plugin's shipped policy, a fallback: a repo's own `.claude/autonomy.json` overrides it. To make a run stricter than the repo allows, also pass `policy`: an explicit policy is INTERSECTED with the repo's (a gate is authorized only if both authorize it), so it can tighten a repo's policy and never loosen it.

Autonomy: this run is unattended unless the user is clearly present. Gates not pre-authorized by the resolved policy are recorded as BLOCKED rather than halting the run.
