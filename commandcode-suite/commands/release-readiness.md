---
description: Collect every release gate in parallel from the agent that owns it, then have release-manager synthesize an evidence-classified go/no-go recommendation
argument-hint: <release, e.g. "release 2.4.0">
---

`$SUITE_ROOT` is the directory holding this suite. Export it once: `export SUITE_ROOT=/path/to/agents/commandcode-suite`.

Run the workflow script with `shell_command`:

```
node "${SUITE_ROOT:?set SUITE_ROOT to the directory holding commandcode-suite}/workflows/release-readiness.js" <release>
```

The script is the plan — do not reimplement the orchestration inline. It drives `cmdc -p` headlessly through the gates, treats any gate with no result as `Missing` (never "probably fine"), and ends with release-manager's recommendation. Relay the recommendation and the `gatesBlocking` / `gatesClaimedNotVerified` lists verbatim. This workflow has no deploy authority and cannot grant it.

Autonomy: this run is unattended unless the user is clearly present. The suite's default pre-authorization policy lives at `$SUITE_ROOT/autonomy.json` — copy it to `<repo>/.commandcode/autonomy.json` to override per project. Gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
