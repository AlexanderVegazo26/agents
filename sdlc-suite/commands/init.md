---
description: Scaffold this repository for the SDLC suite — memory root, autonomy policy, routing policy, run-state gitignore — and verify readiness before an unattended run
argument-hint: <project name for the memory root> [--check]
---

Run the init tool directly. It is a plain Node script, not a `Workflow`, because
it is a file operation rather than a multi-agent orchestration.

```
node "${CLAUDE_PLUGIN_ROOT}/tools/init.mjs" --project <name>
```

Take `<name>` from `$ARGUMENTS`. **If no project name was given, ask for one** —
do not invent one from the directory name. It becomes `.claude/memory/<name>/`,
the memory root every agent in this suite reads and writes, and a name chosen
for the adopter is a name they will not recognise later.

Pass `--check` through if the user asked to verify rather than to scaffold.

Run it with the current repository as the working directory. It writes into
`.claude/` in whatever directory it is run from, never into the plugin.

## What it does, and what it deliberately does not

| | |
|---|---|
| `.claude/memory/<project>/` | copied from `memory-template/` |
| `.claude/autonomy.json` | copied from the suite default, then validated |
| `.claude/CLAUDE.md` | `ROUTING.md` installed between `<!-- sdlc-suite:routing:start -->` and `<!-- sdlc-suite:routing:end -->` |
| `.claude/runs/.gitignore` | run state kept out of version control |
| `.claude/settings.json` | `permissions.allow` **checked only** — never written |

It is idempotent, so it is safe in a repeated setup script. It never overwrites
an existing `autonomy.json` or `CLAUDE.md`: once an adopter has edited either,
it is their decision. The routing policy is appended under its marker instead,
and refreshed between the markers on a later run, leaving everything outside
them untouched.

It never writes `permissions.allow`. The right allowlist depends on what this
repository's own build and test commands are, and guessing one would be a
silent widening of what agents may run here.

## Reading the result

The tag on each line is the contract:

- `[created]` `[updated]` `[appended]` — something was written
- `[exists]` — already correct; nothing was written
- `[checked]` — inspected, never written
- `[warn]` `[stale]` — worth acting on, but does not block a run
- `[missing]` `[error]` — **not ready**

Exit codes: `0` ready · `1` not ready · `2` usage error. Report the exit code,
not the last line of output.

`--check` writes nothing at all and reports readiness through that exit code,
which makes it usable as a CI step or a pre-run gate.

An `[error]` on `autonomy.json` means the file is present and *invalid* — a
different state from absent, and reported differently on purpose. An invalid
policy that silently degraded to "no policy" would make every gate read
not-authorized while looking like a deliberate lockdown.

## Afterwards

`/sdlc-suite:install-routing` asks four instance questions — which trees are
live here, what the canonical edit path is, the project name, and which harness
this repo targets — and records the answers under the routing block. init
installs the policy but does not ask them; run that command too if this repo has
more than one tree of agent or skill definitions.

Two pre-flight items are still manual, because init cannot check either:

- **MCP auth.** Interactively-authenticated MCP servers may be absent in a
  headless run. Verify with a throwaway `claude -p` that reads one ticket before
  scheduling anything that assumes it works.
- **Permission coverage.** init reports whether an allowlist exists and how many
  entries it has, not whether it covers the calls this repository's workflows
  will actually make. `/fewer-permission-prompts` generates a starting allowlist
  from your transcripts.
