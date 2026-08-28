---
description: Reverse-engineer an undocumented system — derive who uses it and what it does from code evidence in parallel, cross-check the two, and synthesize an as-built PRD
argument-hint: <scope> [--observe-target <non-production url>]
---

Run the workflow script with `shell_command`:

```
node "C:/Users/avega/Documents/personal/agents/commandcode-suite/workflows/system-archaeology.js" <scope> [--observe-target <url>]
```

The script is the plan — do not reimplement the orchestration inline. It drives `cmdc -p` headlessly through stack detection, parallel excavation (who + what), cross-check, and synthesis, then prints a JSON report. It runs **static-evidence-only** unless you pass `--observe-target`, and it refuses to guess at a safe one — dynamic observation is opt-in and must name a non-production target. Relay the as-built PRD and the `downstreamHandoff` verbatim.

Autonomy: this run is unattended unless the user is clearly present. The suite's default pre-authorization policy lives at `C:/Users/avega/Documents/personal/agents/commandcode-suite/autonomy.json` — copy it to `<repo>/.commandcode/autonomy.json` to override per project. Gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
