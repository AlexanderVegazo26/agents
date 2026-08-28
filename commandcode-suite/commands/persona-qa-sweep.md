---
description: Derive real end-user personas from code evidence, explore the app as each one, then probe authorization boundaries between every persona pair
argument-hint: --target <url> [--env <env>] [--journeys "<journey>"]
---

Run the workflow script with `shell_command`:

```
node "C:/Users/avega/Documents/personal/agents/commandcode-suite/workflows/persona-qa-sweep.js" --target <url> --env <env> [--journeys "<journey>"]
```

The script is the plan — do not reimplement the orchestration inline. It drives `cmdc -p` headlessly through persona discovery, exploration, boundary probing, journeys (only if supplied), and final triage, then prints a JSON report. Relay the verdict, `authorizationLeaks`, and `humanDecisionRequired` lists verbatim.

Never point this at production — `persona-runner` and `boundary-prober` both refuse a non-production requirement and stop if the target resolves to production.

Autonomy: this run is unattended unless the user is clearly present. The suite's default pre-authorization policy lives at `C:/Users/avega/Documents/personal/agents/commandcode-suite/autonomy.json` — copy it to `<repo>/.commandcode/autonomy.json` to override per project. Gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
