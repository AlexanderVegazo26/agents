---
description: Re-audit the SDLC registry — schema validation, orphan detection, overlap analysis, tech-agnosticism — with every finding adversarially verified
argument-hint: [registry root, defaults to this suite]
---

Run the workflow script with `shell_command`:

```
node "C:/Users/avega/Documents/personal/agents/commandcode-suite/workflows/registry-audit.js" [<root>]
```

The script is the plan — do not reimplement the orchestration inline. It drives `cmdc -p` headlessly through the audit dimensions, verifies each finding, and prints a JSON register. The default root is the suite itself, not the consuming repo — this audits the port, not the project you happen to be in. Relay the BLOCKER count and the `findings` list verbatim.

Autonomy: this run is unattended unless the user is clearly present. The suite's default pre-authorization policy lives at `C:/Users/avega/Documents/personal/agents/commandcode-suite/autonomy.json` — copy it to `<repo>/.commandcode/autonomy.json` to override per project. Gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
