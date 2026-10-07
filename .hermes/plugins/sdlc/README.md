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
| `/idea-cloud`, `hermes sdlc idea-cloud` | — | the same pipeline with every role on the Command Code cloud tier (catalog choice `power`) |
| `/implement [@repo] <task>`, `/implement_cloud`, `hermes sdlc implement` | — | `implement_pipeline.py`: a git worktree on branch `hermes/<slug>` → orchestrator and its specialists → host-side commit → Telegram summary. Never pushes |
| `/jobs`, `hermes sdlc jobs`, `hermes sdlc job <action> <id>` | — | `jobs.py`: every long request above is a background job with a Telegram status card and ⏸ / ▶️ / ⏹ / 🔁 buttons |
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
    that it will load. A registered model that fails to load is still
    picked, its dispatch fails, and its fallbacks are not tried. Keep only
    models that load in the catalog.
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
- **`hermes sdlc orchestrate "<task>"`** (in a terminal) dispatches the
  `orchestrator` role on its catalog default, `deep`, in the foreground. In a
  chat, `/orchestrate` is `/implement` (below): a background job, because a
  run takes up to two hours and a chat turn must not block on it. That role runs the whole dispatch with a model
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

## Background jobs: status cards, buttons, parallel runs (`jobs.py`)

Every long request from a chat — `/idea`, `/idea_cloud`, `/implement`,
`/implement_cloud`, and the scout — is one **job**:

- **A record** in `~/.local/state/sdlc-jobs/<id>/job.json`, host-only. The
  id is 8 hex characters, short enough for Telegram's 64-byte `callback_data`.
- **A transient systemd user unit**, `sdlc-job-<id>.service`, started with
  `systemd-run --user`. A job used to be a detached child of the gateway.
  The gateway unit runs with `KillMode=mixed` and a cgroup sweep, so every
  `hermes gateway restart` killed every running build. Builds now survive
  restarts. Without `systemd-run`, a job falls back to a detached process
  group. Environment is forwarded by allowlist, because a unit's environment
  shows in `systemctl --user show`; the pipelines read `~/.hermes/.env`
  themselves.
- **A status card** in Telegram, sent straight to the Bot API and edited in
  place. It shows the state, the step, the time spent running (excluding
  pauses) and the tier, refreshed on every step change and once a minute.
  Its buttons are inline keyboard `callback_data` buttons:

  | State | Buttons | What they do |
  |---|---|---|
  | queued | ⏹ Cancel · 🔄 Refresh | waiting for a slot |
  | running | ⏸ Pause · ⏹ Stop | **Pause**: `systemctl --user freeze`. The cgroup freezer stops the whole tree, nested `hermes chat` sessions included. **Stop**: SIGTERM to the pipeline, which stops its sessions, takes down an unsent link and reports. |
  | paused | ▶️ Resume · ⏹ Stop | **Resume**: `thaw`. The paused time is booked first, so it never counts against a step's budget. |
  | done / failed / stopped | 🔗 links · 🔁 Run again (· 🗑 Discard branch) | **Run again** starts a new job with the same request. |

  Final results also arrive as a separate message, because edits do not
  notify the phone, and that message carries 🔁 Run again too.
  - Buttons are handled by the plugin's Telegram handler,
    `register_telegram_handler`, scoped to `^sdlc:` so Hermes's own buttons
    are untouched.
  - A tap must pass the adapter's callback allowlist **and** come from a
    `TELEGRAM_ALLOWED_USERS` id.
  - `/jobs` lists recent jobs and re-sends each live card, so its buttons
    sit at the bottom of the chat.
  - `hermes sdlc job pause|resume|stop|again|refresh|discard <id>` does the
    same from a terminal.
- **Pause, honestly.** A model request already in flight still completes on
  its server; the frozen session reads the reply after it resumes. A pause
  longer than Hermes's 15-minute stale-call limit can cost that one call a
  retry. Under `/implement`, the orchestrator's clock is pause-aware but its
  specialists keep the runner's 15-minute timer, so that a hung specialist
  costs one lens, not the whole run. A pause longer than that, in the middle
  of a specialist, loses the specialist; it is reported as a lens not run.
- **Parallel slots.** At most `SDLC_MAX_JOBS` jobs run at once (default 4),
  and each tier has its own pool:
  - `SDLC_MAX_LOCAL_JOBS` (default 1): llama-server runs with `--parallel 1`,
    so two local jobs would only queue behind each other there and trip the
    stale-call timeout.
  - `SDLC_MAX_CLOUD_JOBS` (default 1): the Command Code plan rate-limits.
    Two concurrent cloud pipelines got HTTP 429 within two minutes on
    2026-10-07. The bridge now backs off for up to about 2½ minutes before
    passing a 429 on.

  By default, one local and one cloud job run side by side. A job past its
  slot shows "queued". Raise the limits once the server or plan allows.
  - A job records the local model it runs on.
  - `ensure_model` never unloads a model another running job is using. It
    waits for that job, up to 60 minutes, showing "waiting for GPU memory".
- **A stray kill is named as one.** SIGTERM or SIGINT from anything but the
  ⏹ button reports "SIGTERM from outside this pipeline". It used to read
  "runner exited 143 without a reply", which is what two builds showed on
  2026-10-06 when another session killed them.

## `/implement`: a task from the phone to a reviewed branch

`/implement [@repo] <task>` (`/implement_cloud` for the Command Code tier).
`@name` picks `~/Documents/repos/<name>` (`SDLC_REPOS_DIR`); without it,
`SDLC_IMPLEMENT_REPO` or this repository.

1. **Worktree.** `git worktree add -b hermes/<slug> ~/sdlc-work/<slug> HEAD`.
   It branches from HEAD, so uncommitted changes in your checkout are not
   included; the result says so when there were any. `~/sdlc-work` is
   mounted into the sandbox at `/workspace/work`. It is the only host folder
   besides `~/prototypes` that agents can write.
2. **Orchestrator.** It classifies the task and dispatches the specialists,
   each in its own session working in the worktree. The brief forbids git
   commit, push and branch operations. The budget is
   `SDLC_IMPLEMENT_BUDGET_MIN` (default 120 minutes). `/implement_cloud`
   writes a pinned catalog that routes every role to `power` and hands it to
   every nested session through `SDLC_MODELS_CATALOG`.
3. **Commit, on the host.** `git add -A && git commit --no-verify` with
   `GIT_DIR` pinned to the worktree's git dir, recorded before any agent
   ran, and with `core.hooksPath=/dev/null`, `core.fsmonitor=false` and no
   system config. A rewritten `.git` file, a planted hook or an fsmonitor
   command in the agent-written tree is never followed or executed.
4. **Report.** Telegram gets a diffstat, the lens ledger, a review command
   (`git log -p <base>..hermes/<slug>`) and 🔁 Run again / 🗑 Discard branch.
   Discard removes the worktree and the branch, and only `hermes/` branches
   under `~/sdlc-work`. Nothing is ever pushed or merged.

New files written by the root-run sandbox are root-owned, so a kept worktree
may need `sudo rm -rf` to delete. Hermes's `docker_run_as_host_user` would
avoid that, but it changes the shared sandbox's ownership; it was not turned
on.

## `/idea`: from a Telegram message to a prototype link

`/idea <text>` (or `hermes sdlc idea "<text>"`) builds a clickable prototype
on the local models with the `prototyper` role. It then sends a public link
to Telegram as a button.

`/idea-cloud <text>` (Telegram shows it as `/idea_cloud`; or `hermes sdlc
idea-cloud "<text>"`) runs the same pipeline with every role — prototyper,
code review, visual review, fixes — pinned to one catalog choice, `power` by
default (`SDLC_CLOUD_CHOICE` overrides it). `power` is the Command Code bridge
(`cc-deepseek` → `deepseek/deepseek-v4-pro` on `commandcode-gateway.service`,
`:11440`), so nothing is loaded on the GPU. The idea, the prototype's files and
the reviews go to that cloud provider; use `/idea` to keep them on this
machine.

- The command writes the choice to `STATE/<slug>/MODEL_CHOICE`. The pipeline
  refuses a choice that is not in the catalog instead of quietly building on
  the local models.
- If the catalog has no `power` choice, `/idea-cloud` says so and starts
  nothing.
- The bridge must emulate tool calls, because `cmd -p` is an agent with its
  own tools and no API for the caller's. Before 2026-10-07 it dropped
  `tools`, so a cloud session could never call one. The prototyper answered
  one sentence and stopped, which surfaced as "no site/index.html was
  written". `~/.hermes/scripts/cmd-gateway.py` now does three things:
  - describes the functions in the prompt;
  - parses a `<tool_calls>` block out of the reply into OpenAI
    `tool_calls`;
  - runs `cmd` in an empty scratch directory whose project settings deny
    every built-in tool (`deny: ["*"]`), so only Hermes's sandboxed tools
    act.
- The Telegram message ends with `☁️ Cloud models: …` instead of
  `🧠 Local models: …`.

- **The command returns at once.** The build is a background job (next
  section): it gets a status card with buttons, and several can run at once.
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
     - A fix round that times out or crashes no longer fails the build. What
       it left is re-tested once, published with a ⚠️ note, and the fixing
       stops.
     - A build session that ends without `site/index.html` gets one second
       session that is told to write it. One that dies after writing the
       page has its page tested anyway.
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

1. Mount the prototypes and implement folders into the sandbox. These are
   the only host folders the sandbox can write. Also point `terminal.cwd` at
   this repository, so gateway (Telegram) sessions load `.hermes.md` and the
   project skills; with the docker backend and the cwd mount off, the
   sandbox ignores that host path:

   ```yaml
   # config.yaml
   terminal:
     cwd: "/home/<you>/Documents/repos/agents"
     docker_volumes:
       - "/home/<you>/prototypes:/workspace/prototypes:rw"
       - "/home/<you>/sdlc-work:/workspace/work:rw"
   ```

   Every `fallback_providers` model must be one your plan serves. A
   fallback to `claude-sonnet-5-5`, refused with 403 `MODEL_NOT_IN_PLAN`,
   kept one prototyper retrying until its 30-minute budget ran out.

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
