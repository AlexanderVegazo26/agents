# `.hermes/plugins/sdlc/` — the suite's two Claude Code primitives, for Hermes

Hand-maintained. The tree generator (`sdlc-suite/tools/generate_trees.py`)
owns only `.hermes/skills/` and the root `.hermes.md`; it never writes or
removes anything under `.hermes/plugins/`.

## What it provides

| Tool | Replaces | Runs |
|---|---|---|
| `agent` | Claude Code's `Agent(<name>)` / Task sub-agent dispatch | one separate `hermes chat -Q` process per call |
| `workflow` | Claude Code's `Workflow` tool | `sdlc-suite/workflows/*.js` in a `node:vm` sandbox |
| `/orchestrate`, `hermes sdlc …` | — | the `orchestrator` role via `agent`; `models` reports routing; `agent <role> <task-file>` dispatches one role |
| `/idea`, `hermes sdlc idea` | — | `prototype_pipeline.py`: local model check → prototyper → vetted copy → browser test → code-reviewer → fix loop → quick tunnel → Telegram button |
| `prototype_pipeline.py discover` | — | cron scout: radar headlines → product-manager go-to-market case → the same pipeline |

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
  an optional `probe_key_env`, a `use_for` description, and a `fallback`
  list. `roles` gives each role its default; `role_model_aliases` maps the
  role files' Claude aliases (`haiku`/`sonnet`/`opus`).
  - The shipped defaults route through the LlamaStash proxy on `:11435`:
    `fast` is Qwen3-Coder-30B, `balanced` is Qwen3.8-27B and `deep` is
    Ornith-1.5-35B-A3B. LlamaStash loads a model on its first request. To
    use them, Hermes needs a `llamastash` provider, three aliases, and the
    key in its environment:

    ```yaml
    # ~/.hermes/config.yaml
    providers:
      llamastash:
        base_url: http://127.0.0.1:11435/v1
        api_key: ${LLAMASTASH_API_KEY}   # expanded from ~/.hermes/.env
        api_mode: chat_completions
        request_timeout_seconds: 900   # the first request may load the model off disk
        stale_timeout_seconds: 900
    model_aliases:
      fast:   { model: Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL, provider: llamastash }
      qwen38: { model: Qwen3.8-27B-UD-Q4_K_XL, provider: llamastash }
      ornith: { model: Ornith-1.5-35B-Q8_0, provider: llamastash }
    ```

    ```sh
    # ~/.hermes/.env holds the one copy of the key, for inference and probes.
    # Edit the line if it already exists rather than appending a second one.
    (umask 077; echo "LLAMASTASH_API_KEY=$(llamastash api-key)" >> ~/.hermes/.env)
    chmod 600 ~/.hermes/.env   # umask only covers a newly created file
    ```

    Hermes expands `${LLAMASTASH_API_KEY}` in `config.yaml` from `.env`
    (checked against `hermes_cli.config.load_config`, 2026-10-06), so
    inference and the probes read one key. If `api_key` holds the literal
    key instead, rotate both copies together. Keep
    `LLAMASTASH_API_KEY` out of `docker_forward_env` and `env_passthrough`,
    and out of any skill's `required_environment_variables`: those are the
    paths that would hand it to the sandbox.
  - A choice with `probe_key_env` must probe a loopback address, written
    exactly as `127.0.0.1`, `localhost` or `[::1]` (other spellings of
    loopback are not supported and may be judged differently by the two
    halves). Otherwise the catalog is invalid,
    so a JSON edit cannot send a token to another host. The Python half
    also drops the header if the probe redirects.
  - `probe_key_env` names an environment variable. The probe sends its
    value as `Authorization: Bearer …`, because LlamaStash lists its models
    only to a caller with the key. The key never goes in the catalog. While
    the variable is unset or empty the choice counts as down, the probe
    sends no request, and `hermes sdlc models` shows `no key (…)`; a key
    the server refuses shows `key rejected`.
  - Behind LlamaStash, a passing probe means the model is registered, not
    that it can load: LlamaStash also lists models whose backend is not
    installed. Such a model is picked, its dispatch fails, and its fallbacks
    are not tried. Keep only loadable models in the catalog.
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

## `/idea`: from a Telegram message to a prototype link

`/idea <text>` (or `hermes sdlc idea "<text>"`) builds a clickable prototype
on the local models with the `prototyper` role. It then sends a public link
to Telegram as a button.

- **The command returns at once.** It takes the one-build lock and hands it to
  `prototype_pipeline.py run`, which runs detached. A second `/idea` while one
  is building is refused, not queued.
- **Each idea gets two directories, and the split between them is the
  security boundary.**
  - **`~/prototypes/<slug>/` (WORK).** Mounted read-write into the Hermes
    docker sandbox. The prototyper writes `site/` and `PROTOTYPE.md` here.
    Everything in it is agent-controlled, so it is only read, with symlinks
    refused.
  - **`~/.local/state/sdlc-prototypes/<slug>/` (STATE).** Host-only. It holds
    `IDEA.md`, the logs, both agents' replies, `serve.json`, and `public/`,
    the vetted copy that is actually served.
- **The pipeline, in order:**
  1. **Local model check.** `llamastash status` shows whether the model the
     role routes to is loaded. If it is not, `llm on` loads it. If the GPU is
     short of memory, every other model is unloaded first. Routing follows the
     role → choice → `model_aliases` chain.
  2. **Build.** `prototyper` runs in Fast mode, unattended, with only the
     `file,terminal` toolsets (`-t`): no web, browser, memory, skills, cron,
     sdlc or MCP tools. Its prompt lists the mistakes the browser test
     rejects.
  3. **Vet.** `site/` is copied to `public/` as regular files only. A symlink,
     hard link or special file fails the build. The copy is served on
     127.0.0.1 with no listings, a CSP limited to `'self'` plus four CDNs,
     `connect-src 'self'` and `Referrer-Policy: no-referrer`.
  4. **Browser test.** `smoke.mjs` drives headless Firefox over WebDriver
     BiDi, with no dependencies. It fails on console errors, template syntax
     left on screen (`{{ x }}`) and a blank page, and it records what clicking
     each control changed.
  5. **Review.** `code-reviewer` (`file` tools only) reads the files *and*
     that click transcript, so it judges what the page actually does.
  6. **Fix loop.** A failed browser test or `Verdict: request changes` goes
     back to the prototyper, for up to 2 fix rounds. Steps 3–5 then run again.
  7. **Publish.** A Cloudflare quick tunnel opens, and nothing is sent until
     the public URL answers 200. Telegram then gets one HTML message with an
     **Open prototype** button, the browser and review results, and the local
     models used. The review notes follow in a second message. A detached
     `expire` timer takes the link down after `SDLC_PROTOTYPE_TTL_HOURS`
     (default 24).

  A failure at any step sends a ❌ message naming the step, and stops
  whatever had been started.
- **`prototype_pipeline.py discover`: the opportunity scout.** This is the
  same pipeline with a product-manager front end:
  1. Takes the AI and tech radar's headlines (`~/.hermes/scripts/ai_news_fetch.py`)
     and skips the ones already explored (`discovered.json` in STATE).
  2. Dispatches `product-manager` on its local model with the `go-to-market`
     and `business-analysis` skills inlined. It picks ONE opportunity and
     returns a JSON case: purpose, who it is for, what you can achieve,
     business model, positioning, first channel, first ten customers,
     riskiest assumption, kill criteria, and a prototype brief.
  3. Builds, tests, reviews and shares that prototype. The case is part of
     the final message.

  It is silent when there is nothing new or a build is already running. The
  cron wrapper is `~/.hermes/scripts/prototype_discover.py`, which starts it
  detached because a run outlasts the cron script timeout.
- **Sharing is the pipeline's job, never the prototyper's.** The prototyper's
  §13 forbids it to deploy or share. The requester asking for a link is what
  authorises sharing.
- **Messages go to the Bot API directly.** They are not sent through a Hermes
  webhook route, because a route with `mirror_to_session` would put
  agent-written text into the chat session as a turn from you. The chat is
  `SDLC_PROTOTYPE_CHAT`, or else the first `TELEGRAM_ALLOWED_USERS` entry.
  The gateway checks that allowlist before any plugin command runs.
- **Telegram stays on long polling.** Do not call `setWebhook`. Telegram
  serves either `getUpdates` or a webhook, never both, so setting one cuts
  the gateway off from every inbound message.

**One-time machine setup.** Everything here is in `~/.hermes`, not this
repository.

1. Mount the prototypes folder into the sandbox. This is the only host
   folder the sandbox can write:

   ```yaml
   # config.yaml
   terminal:
     docker_volumes:
       - "/home/<you>/prototypes:/workspace/prototypes:rw"
   ```

2. Add the cron jobs, then restart the gateway. The reaper is a backstop
   for the per-link `expire` timer, for example after a reboot. The scout
   runs the opportunity pipeline above on weekdays at 10:00:

   ```bash
   printf '%s\n' 'import os, runpy, sys' \
     'sys.argv = ["prototype_pipeline.py", "reap"] + sys.argv[1:]' \
     'runpy.run_path(os.path.realpath(os.path.expanduser("~/.hermes/plugins/sdlc/prototype_pipeline.py")), run_name="__main__")' \
     > ~/.hermes/scripts/prototype_reaper.py
   hermes cron create "0 * * * *" --name prototype-reaper --script prototype_reaper.py \
     --no-agent --deliver telegram:<your chat id>
   hermes cron create "0 10 * * 1-5" --name prototype-scout --script prototype_discover.py \
     --no-agent --deliver telegram:<your chat id>
   hermes gateway restart
   ```

`prototype_pipeline.py reap --all` takes every link down now.
`prototype_pipeline.py notify "test"` checks the Telegram path.

**Residual risk, not yet accepted or closed.** The prototyper's terminal runs in the
shared, persistent sandbox. That sandbox has `GITHUB_TOKEN` forwarded and
holds the himalaya mail config. The idea text is the only untrusted input the
prototyper sees, and it has no web tools. A separate Hermes profile for
prototypes would close this gap: an ephemeral sandbox, no forwarded
credentials, and no network beyond the CDNs.

Files the sandbox writes are owned by root, because the container runs as
root. `~/prototypes/<slug>/` and `site/` are yours, so their files can be
deleted. Any subfolder the agent creates needs `sudo`.

## Checks

```
python .hermes/validate.py              # offline: skills, registration, runner selftest
node .hermes/plugins/sdlc/runner.mjs --selftest
```
