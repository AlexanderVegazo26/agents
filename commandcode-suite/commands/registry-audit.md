---
description: Re-audit the SDLC registry — schema validation, orphan detection, overlap analysis, tech-agnosticism — with every finding adversarially verified
argument-hint: [registry root, defaults to this suite]
---

`$SUITE_ROOT` is the directory holding this suite. Export it once: `export SUITE_ROOT=/path/to/agents/commandcode-suite`.

Run the workflow script with `shell_command`:

```
node "${SUITE_ROOT:?set SUITE_ROOT to the directory holding commandcode-suite}/workflows/registry-audit.js" [<root>]
```

The script is the plan — do not reimplement the orchestration inline. It drives `cmdc -p` headlessly through the audit dimensions, verifies each finding, and prints a JSON register. The default root is the suite itself, not the consuming repo — this audits the port, not the project you happen to be in. Relay the BLOCKER count and the `findings` list verbatim.

Autonomy: this run is unattended unless the user is clearly present. The suite's default pre-authorization policy lives at `$SUITE_ROOT/autonomy.json` — copy it to `<repo>/.commandcode/autonomy.json` to override per project. Gates not pre-authorized there are recorded as BLOCKED rather than halting the run.
