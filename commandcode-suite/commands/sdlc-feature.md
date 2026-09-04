---
description: Run a feature end-to-end through the SDLC agent suite — requirements, design, build, independent verification, release readiness
argument-hint: <initiative description>
---

`$SUITE_ROOT` is the directory holding this suite. Export it once: `export SUITE_ROOT=/path/to/agents/commandcode-suite`.

Run the workflow script with `shell_command`:

```
node "${SUITE_ROOT:?set SUITE_ROOT to the directory holding commandcode-suite}/workflows/sdlc-feature.js" <initiative description>
```

The script is the plan — do not reimplement the orchestration inline. It drives `cmdc -p` headlessly through each phase and prints a final JSON report on stdout. When it returns, relay the readiness recommendation and the `humanDecisionRequired` list verbatim; this workflow produces recommendations and never deploys.

Autonomy: this run is unattended unless the user is clearly present. The suite's default pre-authorization policy lives at `$SUITE_ROOT/autonomy.json` — copy it to `<repo>/.commandcode/autonomy.json` to override per project. Gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
