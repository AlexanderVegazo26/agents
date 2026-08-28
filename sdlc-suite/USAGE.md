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

Installing copies the plugin into `~/.claude/plugins/cache/<marketplace>/sdlc-suite/<version>/`. That's a **snapshot**, not a link: edits to the source repo do nothing until you bump `version` in *both* `plugin.json` and `marketplace.json` and run an update.

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
- `preAuthorized.act.*` — gates with irreversible external effect (deploy, destructive migration, production config, failover, external data send, access grants). **Off by default.** Setting one to `true` is a real standing authorization for that class of action in that repo, and the agent must name the gate in its output when it acts on one.

A gate absent from the file is treated as not authorized. Uncertainty about reversibility is treated as irreversibility.

### Triggering a run

```bash
claude -p "/sdlc-suite:sdlc-feature Add CSV export to the reporting dashboard"
```

For a recurring run, use the `schedule` skill or `CronCreate` rather than an external cron calling `claude -p`, so the run keeps session context and task notifications.

### Before you trust an unattended run

Three things will silently degrade a headless run. Check each once in the target repo:

1. **Permissions.** Every Bash/Write call that would prompt interactively fails or stalls headless. Put a broad enough `permissions.allow` in the consuming repo's `.claude/settings.json` first. `/fewer-permission-prompts` generates a starting allowlist from your transcripts.
2. **MCP auth.** Interactively-authenticated MCP servers (Atlassian/ADO, Confluence) may be absent in headless runs. Any workflow step that reads a ticket or posts a status comment depends on them — verify with a throwaway `claude -p` that reads one ticket before scheduling anything that assumes it works.
3. **Memory root.** Every agent reads and writes `.claude/memory/<project>/`. In a fresh repo that tree doesn't exist and nobody is watching the write fail. `memory-template/` is the scaffolded layout — copy the whole directory to `.claude/memory/<project>/` in the consuming repo before the first run.

## Two things here are not verified

Stated plainly so you don't find out at 3am:

- **Intra-plugin reference resolution.** Whether a sibling skill resolves bare or as `sdlc-suite:*` from inside a plugin is untested — surveyed plugins either omit a `skills:` frontmatter field entirely or reference siblings by file path, so there's no established precedent to copy. This suite is written to work either way: frontmatter lists bare names, `tools:` declares `Agent(qa-runner)` **and** `Agent(sdlc-suite:qa-runner)`, and each agent body explicitly loads its preloaded skills at task start rather than trusting the frontmatter. `agentType: 'sdlc-suite:*'` in the workflow scripts follows the documented registry form. Run `/sdlc-suite:registry-audit` after installing — that's the check.
- **MCP auth under `claude -p`.** Documented as a pre-flight above; not run.

### What autonomy does not change

- No agent certifies its own work. That's a self-certification ban, not a confirmation gate, and the policy doesn't touch it.
- The honesty bar goes **up**, not down. Nothing gets upgraded from "could not verify" to "verified" because no one will ask, and a degraded run (tool failed, suite never executed, MCP unauthenticated) says so at the top level of the result.
