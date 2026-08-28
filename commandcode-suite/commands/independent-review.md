---
description: Review a change through four independent evidentiary bases in parallel, adversarially cross-check every finding, then merge into one ranked report
argument-hint: <branch, PR, diff, or path list>
---

Run the workflow script with `shell_command`:

```
node "C:/Users/avega/Documents/personal/agents/commandcode-suite/workflows/independent-review.js" <target>
```

The script is the plan — do not reimplement the orchestration inline. It drives `cmdc -p` headlessly through review, adversarial cross-check, and merge, then prints a final JSON report on stdout. When it returns, relay the merged report and any `Unverified` findings verbatim.

Autonomy: this run is unattended unless the user is clearly present. The suite's default pre-authorization policy lives at `C:/Users/avega/Documents/personal/agents/commandcode-suite/autonomy.json` — copy it to `<repo>/.commandcode/autonomy.json` to override per project. Gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
