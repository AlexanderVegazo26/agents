# `.hermes/plugins/sdlc/` — the suite's two Claude Code primitives, for Hermes

Hand-maintained. The tree generator (`sdlc-suite/tools/generate_trees.py`)
owns only `.hermes/skills/` and the root `.hermes.md`; it never writes or
removes anything under `.hermes/plugins/`.

## What it provides

| Tool | Replaces | Runs |
|---|---|---|
| `agent` | Claude Code's `Agent(<name>)` / Task sub-agent dispatch | one separate `hermes chat -Q` process per call |
| `workflow` | Claude Code's `Workflow` tool | `sdlc-suite/workflows/*.js` in a `node:vm` sandbox |
| `/orchestrate`, `hermes sdlc …` | — | the `orchestrator` role via `agent`; `models` reports routing |

`__init__.py` is only the Hermes registration. `runner.mjs` does the work, and
it **imports the pi extension's `lib.js`** for everything that is not
Hermes-specific: role resolution, the dispatch retry and `null` contract, the
sandbox allowlist and determinism throwers, and suite-path resolution. The
only Hermes-specific code is how a nested session is spawned. That is a
deliberate coupling. The workflow scripts were measured against that sandbox,
and a second copy would drift. A change to `.pi/extensions/sdlc/lib.js` is a
change to this plugin too, and `.hermes/validate.py` runs both against it.

## Install (once per machine)

```bash
ln -s "$PWD/.hermes/plugins/sdlc" ~/.hermes/plugins/sdlc   # from the repo root
hermes plugins enable sdlc
hermes skills trust "$PWD"      # loads .agents/skills/ and .hermes/skills/
```

The plugin is symlinked into `~/.hermes/plugins/` rather than left to
Hermes's project-plugin path. That path needs
`HERMES_ENABLE_PROJECT_PLUGINS=true` in every session's environment, and
setting it as well as the symlink would load the plugin twice. Start a new
session after enabling it. `hermes tools list` should then show
`✓ enabled  sdlc`.

## Behavior worth knowing

- **Each role is a separate process.** The nested `hermes chat` gets the role
  file's body plus the task on stdin (`--query-file -`, so a 50 KB role file
  never touches argv or a shell). It keeps Hermes's normal system prompt:
  `.hermes.md`, the project skills, and the tools.
- **Model routing.** `agent` takes an optional `model`, a choice from the
  catalog. The catalog is `models.json` here, or `~/.hermes/sdlc-models.json`,
  which replaces it wholesale for one machine. Each choice names a
  `hermes chat -m` value (an alias from `config.yaml` `model_aliases`, or a
  model id), an optional `provider`, a `probe` URL that must list `expect`,
  a `use_for` description, and a `fallback` list. `roles` gives each role
  its default; `role_model_aliases` maps the role files' Claude aliases
  (`haiku`/`sonnet`/`opus`).
  - Resolution order: explicit `model`, then role default, then role-file
    alias, then the session default. Role names match with or without the
    `sdlc-suite:` prefix; workflows always use the prefix.
  - A choice whose probe fails walks its fallbacks. A probe must list
    `expect` as an exact model id.
  - Only successful probes are cached, for 60 s. A runner's retry
    re-probes, so a server that dies mid-run is replaced by its fallback.
  - The result's first line is `[sdlc agent: <role> on <choice> (-m …) —
    <why>]`, and `workflow` results carry the same per-dispatch list under
    `models`.
  - Catalog edits split in two:
    - Role defaults, fallbacks and probes are re-read on every call, so
      they take effect immediately.
    - The `model` enum and its descriptions are built at plugin load,
      because the schema is part of the cached prompt. They change in the
      next session, so a choice removed mid-session is still offered and
      then refused.
  - An invalid catalog (unknown fallback, role routed to an unknown choice,
    choice without `model`) turns routing off in both halves. The routes
    say why, and `hermes sdlc models` reports it.
- **`/orchestrate <task>`** (in a session) and **`hermes sdlc orchestrate
  "<task>"`** (in a terminal) dispatch the `orchestrator` role on its
  catalog default, `deep`. That role runs the whole dispatch with a model
  decision per call and returns a lens ledger with a Model column.
  - It is a plugin command on purpose. A skill version depended on the
    session's model choosing to call `agent`, and the default local model
    answered the task itself instead.
  - Depth works out to top level → orchestrator → specialist → qa-runner,
    exactly the limit of 3.
  - The slash command's output is shown to you. It does not enter the
    session's conversation.
- **`hermes sdlc models`** prints the catalog in effect, whether each choice
  is up, and the role defaults.
- **Nesting is bounded at 3, and concurrency at 4 per runner.**
  `HERMES_SDLC_DEPTH` is incremented per level, and a dispatch at the limit
  fails instead of spawning. A role dispatching roles is normal
  (orchestrator → specialist → qa-runner); deeper is a model looping.
  Workflow `parallel()` has no cap of its own, so each runner holds at most
  `HERMES_SDLC_MAX_PARALLEL` (default 4) live sessions. Worst case is
  4³ = 64 Hermes processes.
- **Cancelling stops everything.** `/stop` (Hermes's interrupt) makes the
  plugin SIGTERM the runner's process group. The runner kills every nested
  session, which are detached into their own groups, and refuses new ones.
  The runner does the same if its parent process disappears. Both paths
  were tested with a stand-in `hermes` binary.
- **Nested sessions drop the parent's identity.** `HERMES_SESSION*` and
  `HERMES_KANBAN*` are stripped, so a nested run is not mistaken for the
  parent's kanban worker. Everything else is inherited, including
  `HERMES_YOLO_MODE` if you started the parent with `--yolo`.
- **Per-agent timeout** defaults to 15 minutes. Override it with
  `HERMES_SDLC_AGENT_TIMEOUT_MS`. An orchestrating role (`orchestrator`,
  `journey-orchestrator`) gets `HERMES_SDLC_ORCHESTRATE_TIMEOUT_MS`
  (default 2 hours), because its one dispatch contains every specialist
  it runs. Hermes is found via `$HERMES_BIN`, then
  `~/.local/bin/hermes`, then PATH.
- **Approvals are Hermes's own.** The nested session runs non-interactively
  and gets Hermes's single-query approval policy, which denies dangerous
  commands by default (`approvals.single_query_mode`). Nothing here passes
  `--yolo`. The plugin tools themselves are not approval-gated, which is why
  the next point matters.
- **Hermes defers plugin tools behind its tool-search bridge**
  (`tool_search` → `tool_describe` → `tool_call`). A weak model can find
  `agent` and then write the sub-agent's answer itself instead of calling it.
  That was observed with a local 30B model. The session record shows whether
  a `tool_call` to `agent` actually happened, so check it before trusting a
  "the reviewer said" claim.
- **Progress** streams to the Hermes log as `[sdlc agent] …` /
  `[sdlc workflow] …` lines. The last 50 lines come back with the result.
- **Run records land in `.claude/runs/`**, the same place Claude Code and pi
  write them.
- **Role files and workflow scripts come only from this suite's repository**,
  never from the session's working directory. The nested session still
  *runs* in that directory, so `agent` and `workflow` work from any project.
  This is a security boundary, not a convenience. The `node:vm` sandbox does
  not contain code (`agent.constructor.constructor('return process')()`
  escapes it), so a model-chosen `scriptPath` used to mean running any `.js`
  as you, outside Hermes's approval checks. Now only real paths directly
  inside `sdlc-suite/workflows/` are accepted, after symlinks are resolved;
  `_` modules and tests are refused. Likewise a cloned repo's
  `.claude/agents/code-reviewer.md` is never used as role instructions.
  Note the slash-command skills (`.hermes/skills/`, `.agents/skills/`) are
  project-local, so `/sdlc-feature` exists only in sessions started inside
  this repository.
- **The install symlink runs this working tree's code in every Hermes
  session.** Whatever is checked out here — another branch, a pulled commit,
  a parallel agent's half-finished edit — is what Hermes imports, including
  `.pi/extensions/sdlc/lib.js`. That is the same trust you give any plugin,
  but it is not pinned. To pin it, point the symlink at a separate worktree
  checked out at a reviewed commit.

## Checks

```
python .hermes/validate.py              # offline: skills, registration, runner selftest
node .hermes/plugins/sdlc/runner.mjs --selftest
```
