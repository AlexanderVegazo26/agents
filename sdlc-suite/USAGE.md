# Using the SDLC plugin from another repo

`README.md` describes what the suite *is*. This file is about installing it elsewhere and running it unattended.

## Install

Once per machine:

```
/plugin marketplace add <path to the repo containing this plugin>
/plugin install sdlc-suite@<marketplace name>
```

From the CLI instead of the slash command, the path form needs a leading `./` (`claude plugin marketplace add ./`), and `claude plugin update` requires the fully qualified `sdlc-suite@<marketplace>` — the bare name resolves for `install` but not for `update`.

Push the repo to a git host and the same `marketplace.json` works as `"source": "github"` — nothing in the plugin depends on a local path.

Installing copies the plugin into `~/.claude/plugins/cache/<marketplace>/sdlc-suite/<version>/`. That's a **snapshot**, not a link: edits to the source repo do nothing until the version moves and you run an update.

The version moves in one place. Edit `version` in `plugin.json`, then regenerate the marketplace entry from it:

```
python sdlc-suite/tools/bump.py --marketplace
```

`marketplace.json` used to carry the same number independently and had to be edited to match by hand — two files, one of which could silently disagree. `plugin.json` is now the single source and `bump.py --marketplace --check` fails if they drift apart.

Each agent and skill also carries its own `version:` — `.codex` spells it `version = "1.0.0"` and `.copilot` uses a `"version"` key, but it is the same field. That is what lets a bug report be pinned to a specific revision of a 463-line agent rather than to "the version you had". `python sdlc-suite/tools/bump.py --versions` prints the whole table. See `CONTRIBUTING.md` for when each component moves.

Everything is namespaced under `sdlc-suite:` after install:

| | Before | After |
|---|---|---|
| Agent | `qa-engineer` | `sdlc-suite:qa-engineer` |
| Skill | `engineering-integrity` | `sdlc-suite:engineering-integrity` |
| Command | `/sdlc-feature` | `/sdlc-suite:sdlc-feature` |

That namespacing is why the suite can coexist with the copies in `~/.claude/agents/` without either shadowing the other.

## How workflows travel

Plugins load `agents/`, `skills/`, `commands/`, and hooks. They do **not** load `workflows/` — the runtime discovers workflow scripts from a *project's* `.claude/workflows/`, which is why `/sdlc-feature` worked in the home repo with no `SKILL.md` behind it.

So each workflow ships as a thin command in `commands/` that calls the script by absolute path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/sdlc-feature.js", args: "…" })
```

`${CLAUDE_PLUGIN_ROOT}` expands to the installed plugin directory, so the six workflows run from any repo. You can also call `Workflow` with that path directly, without the command.

## Running unattended

### The gates

Ten agents carry *stop and confirm* gates. Those were written assuming someone is watching, and a literal halt in an unattended run is the worst outcome: the irreversible action still doesn't happen, and neither does the reversible work that didn't depend on it.

`skills/autonomy-policy/` replaces **halt** with **defer and continue**. At a gate an agent now consults `autonomy.json`, and either proceeds under standing authorization or emits a prepared blocked-gate entry and keeps going. The gates themselves are unchanged.

### The policy file

`autonomy.json` at the plugin root is the default; drop a copy at `.claude/autonomy.json` in a consuming repo to override per project.

- `preAuthorized.decide.*` — gates whose output is a document (roadmap commit, prioritization, architecture direction, go/no-go *classification*). **On by default.** These were only human because they carry organizational accountability, not because they're irreversible.
- `preAuthorized.act.*` — gates with irreversible external effect (deploy, destructive migration, production config, failover, load test against shared env, external data send, access grants, shared component modification). **Off by default.** Setting one to `true` is a real standing authorization for that class of action in that repo, and the agent must name the gate in its output when it acts on one.

A gate absent from the file is treated as not authorized. Uncertainty about reversibility is treated as irreversibility.

### Triggering a run

```bash
claude -p "/sdlc-suite:sdlc-feature Add CSV export to the reporting dashboard"
```

For a recurring run, use the `schedule` skill or `CronCreate` rather than an external cron calling `claude -p`, so the run keeps session context and task notifications.

### Before you trust an unattended run

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/init.mjs" --project my-service
```

or `/sdlc-suite:init my-service` inside a session. Run it once in the target
repo, from the repo root. It scaffolds four things, checks a fifth, and reports
each on its own line. `<n>` below stands for a measured count — init prints
what it actually copied rather than a number typed into a document:

```
  [created] .claude/memory/my-service/  <n> files, <n> directories
  [created] .claude/autonomy.json       validated: 6 decide (5 on), 8 act (0 on)
  [created] .claude/CLAUDE.md           routing policy installed from ROUTING.md
  [created] .claude/runs/.gitignore     run state excluded from version control
  [warn]    .claude/settings.json       no permissions.allow entries found — …
  ready: 4 created, 1 warning
```

`--check` reports readiness and writes nothing, which is what belongs in CI or
in a pre-run gate. Exit codes are the interface: **0** ready, **1** not ready,
**2** usage error. Read the exit code, not the last line.

Re-running is safe — the second run reports `[exists]` and changes nothing. An
existing `autonomy.json` or `CLAUDE.md` is never overwritten; those are the
adopter's decisions once made, and the routing policy is appended under a
marked section instead.

**Why each of these matters** — the failure mode, not the mechanic:

1. **Memory root.** Every agent reads and writes `.claude/memory/<project>/`. In
   a fresh repo that tree doesn't exist and nobody is watching the write fail:
   an adopter runs `/sdlc-suite:sdlc-feature`, every agent in the run is told to
   record durable context, every write goes to a directory that is not there,
   and the run reports success. init copies `memory-template/` into place, and
   `init --check` fails and names the directory if it later goes missing.
2. **Autonomy policy.** Without `.claude/autonomy.json` every gate reads
   not-authorized and the run reports itself degraded — correct, but it blocks
   decisions it was meant to be allowed to make. init installs the default and
   validates it against `autonomy.schema.json`. A policy that is *present and
   invalid* is reported as an error, not as absent: those are different states,
   and a typo'd gate name silently revoking authorization is exactly what the
   schema exists to catch.
3. **Routing policy.** `ROUTING.md` binds the *caller*. The `orchestrator` agent
   ships its own dispatch table, but that table only fires if something invokes
   the orchestrator — which is the recursion the routing policy exists to break.
   init installs it into `.claude/CLAUDE.md` between markers.
4. **Run state.** Workflows write a directory per run under `.claude/runs/`:
   phase artifacts, `failures.jsonl`, `outcome.json`. That is a transcript of
   what agents returned about the repository under review, and it is not a build
   input. init writes the `.gitignore` that keeps it out of version control.
5. **Permissions.** Every Bash/Write call that would prompt interactively fails
   or stalls headless, and a stall in an unattended run is the worst outcome
   available. init **checks and warns, never writes**: the right allowlist
   depends on this repository's own build and test commands, and guessing one
   would silently widen what agents may run here. Put a broad enough
   `permissions.allow` in `.claude/settings.json` yourself;
   `/fewer-permission-prompts` generates a starting allowlist from your
   transcripts.

**One pre-flight step init cannot do for you:**

- **MCP auth.** Interactively-authenticated MCP servers (Atlassian/ADO,
  Confluence) may be absent in headless runs. Any workflow step that reads a
  ticket or posts a status comment depends on them — verify with a throwaway
  `claude -p` that reads one ticket before scheduling anything that assumes it
  works. Nothing in init can test this without credentials it does not have.

`/sdlc-suite:install-routing` remains the command for the four instance
questions — which trees are live here, the canonical edit path, the project
name, and the target harness. init installs the routing policy; that command
records the answers that make it apply to this codebase.

## Two things here are not verified

Stated plainly so you don't find out at 3am:

- **Intra-plugin reference resolution.** Whether a sibling skill resolves bare or as `sdlc-suite:*` from inside a plugin is untested — surveyed plugins either omit a `skills:` frontmatter field entirely or reference siblings by file path, so there's no established precedent to copy. This suite is written to work either way: frontmatter lists bare names, `tools:` declares `Agent(qa-runner)` **and** `Agent(sdlc-suite:qa-runner)`, and each agent body explicitly loads its preloaded skills at task start rather than trusting the frontmatter. `agentType: 'sdlc-suite:*'` in the workflow scripts follows the documented registry form. Run `/sdlc-suite:registry-audit` after installing — that's the check.
- **MCP auth under `claude -p`.** Documented as a pre-flight above; not run.

### What autonomy does not change

- No agent certifies its own work. That's a self-certification ban, not a confirmation gate, and the policy doesn't touch it.
- The honesty bar goes **up**, not down. Nothing gets upgraded from "could not verify" to "verified" because no one will ask, and a degraded run (tool failed, suite never executed, MCP unauthenticated) says so at the top level of the result.
