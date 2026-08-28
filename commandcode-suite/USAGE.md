# Using the SDLC Command Code suite from another repo

`README.md` describes what the suite *is*. This file is about installing it elsewhere and running it unattended.

## Install

The suite is a plain directory — no plugin manifest, no marketplace. Pick one:

**Option A — copy into the project** (project-scoped, travels with the repo):

```
<repo>/.commandcode/agents/    <- copy of commandcode-suite/agents/
<repo>/.commandcode/skills/    <- copy of commandcode-suite/skills/
<repo>/.commandcode/commands/  <- copy of commandcode-suite/commands/ (optional)
<repo>/.commandcode/autonomy.json
```

Command Code discovers `.commandcode/agents/`, `.commandcode/skills/`, and `.commandcode/commands/` in the project root automatically — no registration step.

**Option B — copy into your home dir** (personal, across all projects):

```
~/.commandcode/agents/
~/.commandcode/skills/
~/.commandcode/commands/
```

**Option C — run the workflows directly** from this repo, no install at all:

```bash
node "C:/Users/avega/Documents/personal/agents/commandcode-suite/workflows/release-readiness.js" "release 2.4.0"
```

The workflow scripts resolve their own paths relative to the suite directory, so they work from any `cwd`; run them against the target repo by `cd`-ing into it first.

## Namespacing

Because Command Code has no plugin namespace, agents and skills use **bare names** (`qa-engineer`, `qa-techniques`). If the source Claude plugin (`sdlc-suite:qa-engineer`) is also installed on the same machine, its names stay namespaced under `sdlc-suite:` — the two do not collide, and the Command Code copies are what a session here dispatches to.

## How workflows travel

Workflows are standalone Node scripts in `workflows/`, driven headlessly by the shared `_runner.js`. They need only a `node` runtime and a working `cmdc` on PATH (or `CMDC_BIN` set to the executable). The `commands/` launchers are thin markdown instructions that tell the session model to run the script and relay the result — they carry the "the script is the plan" discipline from the original Claude plugin's `Workflow` wrappers.

## Running unattended

### The gates

Ten agents carry *stop and confirm* gates. Those were written assuming someone is watching. `skills/autonomy-policy/` replaces **halt** with **defer and continue**: at a gate an agent consults `autonomy.json`, and either proceeds under standing authorization or emits a prepared blocked-gate entry and keeps going. The gates themselves are unchanged.

### The policy file

`autonomy.json` at the suite root is the default; drop a copy at `<repo>/.commandcode/autonomy.json` (or `<repo>/autonomy.json` if you're running workflows directly) to override per project.

- `preAuthorized.decide.*` — gates whose output is a document (roadmap commit, prioritization, architecture direction, go/no-go *classification*). **On by default.**
- `preAuthorized.act.*` — gates with irreversible external effect (deploy, destructive migration, production config, failover, external data send, access grants). **Off by default.** Setting one to `true` is a real standing authorization for that class of action in that repo, and the agent must name the gate in its output when it acts on one.

A gate absent from the file is treated as not authorized. Uncertainty about reversibility is treated as irreversibility.

### Triggering a run

```bash
cd /path/to/any/project
node "C:/Users/avega/Documents/personal/agents/commandcode-suite/workflows/sdlc-feature.js" "Add CSV export to the reporting dashboard" 2>&1 | tee build.log
```

Inside a session, say *"run the sdlc-feature workflow on 'Add CSV export…'"* — the session model matches the `commands/sdlc-feature.md` launcher and executes it.

### Environment

| Variable | Effect | Default |
|---|---|---|
| `CMDC_BIN` | Path to the Command Code executable (node entry, exe, etc.) | auto-detected (npm package bin, native exe, then PATH `cmdc`) |
| `CMDC_MODEL` | Pin a model for all workflow phases (any `/model` id) | session/inherit |
| `CMDC_AGENT_TIMEOUT_MS` | Per-phase timeout | 3600000 |

### Before you trust an unattended run

Three things will silently degrade a headless run. Check each once in the target repo:

1. **Permissions.** Every `shell_command`/`write_file` call that would prompt interactively fails or stalls headless. The workflows pass `--permission-mode auto-accept` to their `cmdc -p` phases, but a consuming repo's `.commandcode/settings.json` may still restrict. Confirm with a throwaway `cmdc -p` run first.
2. **Memory root.** Every agent reads and writes `.commandcode/memory/<project>/`. In a fresh repo that tree doesn't exist — copy `memory-template/` to `.commandcode/memory/<project>/` before the first run.
3. **MCP auth.** Interactively-authenticated MCP servers may be absent in headless runs. Any workflow step that reads a ticket or posts a status comment depends on them — verify with a throwaway `cmdc -p` first.

## What autonomy does not change

- No agent certifies its own work. That's a self-certification ban, not a confirmation gate, and the policy doesn't touch it.
- The honesty bar goes **up**, not down. Nothing gets upgraded from "could not verify" to "verified" because no one will ask, and a degraded run (tool failed, suite never executed, MCP unauthenticated) says so at the top level of the result.
