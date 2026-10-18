# `.hermes/plugins/sdlc/` — the suite's two Claude Code primitives, for Hermes

Hand-maintained. The tree generator (`sdlc-suite/tools/generate_trees.py`)
owns only `.hermes/skills/` and the root `.hermes.md`; it never writes or
removes anything under `.hermes/plugins/`.

## What it provides

| Tool | Replaces | Runs |
|---|---|---|
| `agent` | Claude Code's `Agent(<name>)` / Task sub-agent dispatch | one separate `hermes chat -Q` process per call |
| `workflow` | Claude Code's `Workflow` tool | `sdlc-suite/workflows/*.js` in a `node:vm` sandbox |
| `cmdc` | — (a second dispatch backend, not a Claude Code primitive) | one separate headless Command Code CLI session (`cmdc -p`) per call |
| `/orchestrate`, `hermes sdlc …` | — | the `orchestrator` role via `agent`; `models` reports routing; `agent <role> <task-file>` dispatches one role |
| `/idea`, `hermes sdlc idea` | — | `prototype_pipeline.py`: local model check → prototyper → vetted copy → browser test → code-reviewer → fix loop → quick tunnel → Telegram button |
| `/idea-cloud`, `hermes sdlc idea-cloud` | — | the same pipeline with every role on the Command Code cloud tier (catalog choice `power`) |
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
- **`cmdc`: dispatch to the Command Code CLI.** A second dispatch backend,
  beside `agent`. One call runs one headless Command Code CLI session
  (`cmdc -p`) instead of a `hermes chat` process (parameters: `task`, optional
  `name`, `model`, `yolo`) — for work that wants Command Code's own coding
  agent and models rather than a suite role on a local model. With `name`, the
  suite role file is prepended exactly as `agent` does, resolved from this
  repository only, and the session runs in the caller's directory. The prompt
  travels on stdin (`cmdc -p` with no query argument auto-detects piped
  input), so a 50 KB role file needs no shell and hits no argument-length
  limit. It runs `--skip-onboarding --no-session --max-turns 200`, maps the
  role's effort to `--effort`, and takes an explicit model as `-m <id>`. **It
  is read-only unless `yolo` is true**: headless `cmdc` blocks file writes and
  shell commands by default, so `yolo` maps to `--permission-mode yolo` and
  the tool description reserves it for a request that actually asks for
  changes. A failed or timed-out run returns no result, and the tool says so.
  The binary resolves from `$CMDC_BIN`, the installed `command-code` npm
  package (its entry run through node, so a Windows `.cmd` shim needs no
  shell), then `cmdc` on PATH.

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
- The Telegram message ends with `☁️ Cloud models: …` instead of
  `🧠 Local models: …`.

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

## `/videoedit`: edit a video you sent to the bot

`/videoedit [path] [--no-captions] [--no-cuts] [--no-fillers] [--no-denoise] [--lufs N] [--lang xx]` edits the
video you just sent (the newest one from the last 30 minutes in the Telegram cache), or a file under
`~/Videos/hermes-inbox`, and sends the result back **as a document** so Telegram does not re-compress it.
`video_pipeline.py` does it on the host, with no model deciding any step. Free text after the flags is
ignored on purpose. Why not the `video-editor` agent here: under Hermes its shell is a docker sandbox with no
host ffmpeg and no access to the transcriber.

What it does: cuts silences and filler words (um/uh; eh/em for Spanish), denoises, normalises loudness in two
passes (default -16 LUFS), burns in captions retimed through the cuts, and re-encodes **once** at the source's
own resolution, frame rate and orientation (H.264 CRF 18). The original is never modified. Captions need the
local transcriber (`stt-transcribe`, faster-whisper); without it the edit is silence cuts only and the report
says DEGRADED. If the language was auto-detected with low confidence the report says so; pass `--lang es`.

Design points:

- **Sandbox.** ffmpeg/ffprobe run inside bubblewrap: an allow-listed read-only root, empty `/tmp`, no `$HOME`
  (no bot token), no network, only `<job>/work/` writable. If bubblewrap is unusable the command **refuses**
  (set `SDLC_VIDEO_ALLOW_UNSANDBOXED=1` to accept the risk). The systemd unit must not set `PrivateTmp` or
  `ProtectSystem`: on Ubuntu's AppArmor user-namespace policy they stop bubblewrap from starting
  (`test_sandbox_works_under_the_production_unit_properties` guards this).
- **Nothing the sandbox wrote is trusted.** The render is copied through an `O_NOFOLLOW` descriptor into a file
  this process creates; files the worker writes into `work/` replace any planted symlink.
- **Jobs** run as `systemd-run --user` units (restart-safe, `MemoryMax=8G`), one render at a time, extra jobs
  queue (at most 5 pending). An `ExecStopPost` hook tells you if a worker was killed. Intermediates are deleted
  when a job ends; job folders are kept 7 days, delivered files 30 days.
- **Telegram.** Sends honour `TELEGRAM_BASE_URL` (https, or http to loopback, ending in `/bot`; anything else is
  ignored). Result size limit: 50 MB on the public Bot API, 2 GB on a local one.
- State: `~/.local/state/sdlc-video/<job>/` (`edl.json` is the cut list, `pipeline.log` the evidence).
- Tests: `python3 .hermes/plugins/sdlc/test_video_pipeline.py` (about 90 tests; the end-to-end ones use a fake
  `stt-transcribe` and a fake local Bot API; they need ffmpeg, and bubblewrap for the sandbox tests).

**Agents can call it too.** The `video_edit` tool (same validation as the command, arguments from typed fields
only) lets a natural-language request, a cron job or a coordinating agent start an edit unattended. Abuse by a
looping or prompt-injected caller is bounded by `admit()`: a repeat of the same file and options is refused for
15 minutes, at most 5 edits are pending and 12 start per hour, all checked under one lock. Messaging platforms
other than Telegram are refused (results always go to the owner's Telegram chat). The tool description tells the
model to use it only when the user asked in the conversation, never because a document or transcript says so.

### Motion graphics

On by default (`--no-graphics` turns it off; `--no-progress` drops only the bar; `--theme aurora|sunset|mint`). After the
cuts, `video_motion.py` plans what appears when and `video_graphics.py` draws it; both are in the pipeline's single render:

- **Glass cards** over the video: key points (numbered), stats (a big gradient figure), an intro title, a lower-third name,
  and animated picture cards (an image in a glass frame with a slow push-in). The video behind each card is really blurred
  by ffmpeg (the renderer draws a mask and the art; ffmpeg does the frosting), with a dark base for legibility, a sheen,
  a rim light and a soft shadow. Cards spring in, stagger their text, and fade out; every card ends fully transparent.
- **What the cards say** is chosen by the local model through the LlamaStash proxy (loopback only, hard wall-clock
  limit, the transcript framed as data, the reply strictly validated; a stat's figure must appear in its sentence). If the
  model is unavailable a deterministic fallback picks sentences, and the report says which was used. `SDLC_VIDEO_LLM=0`
  skips the model. The report lists the text burned into the video so a wrong card is caught before posting.
- **Word-highlight captions** (ASS `\kf`, Lato bold, bottom safe area) and a thin **progress bar**.
- Tool fields (agents, natural language): `title`, `subtitle`, `speaker`, `role`, `images` (up to 4 png/jpg/webp under the
  allowed folders), `theme`, `graphics`, `progress_bar`. Text is drawn as pixels only.
- **Alignment is by frame count**, not time: each card's mask and art are padded with exactly F transparent frames, so the
  glass always shows the blur of the very frame it sits on (a time shift had been off by a frame at some start times).
- **Safety.** The renderer runs in the same bubblewrap sandbox as ffmpeg and writes only `work/g/` (size-capped); the
  worker reads its metadata with `O_NOFOLLOW`/size limits and re-validates every number before it enters a filter. Images
  are copied through a no-symlink descriptor, must match their extension's magic bytes, and are decoded with a
  PNG/JPEG/WEBP allow-list, pixel and aspect caps, EXIF orientation applied, transparency flattened, one downscale.
- **Degrades, never fails.** Any error in this layer (or a failed graphics render) redoes the edit with plain SRT captions
  and says why. Cards whose text uses characters Lato lacks (CJK, Arabic, emoji) are skipped with a note: the card text
  engine is cairo's, without shaping or fallback fonts (Pango would fix this but needs `python3-gi-cairo`); captions are
  unaffected because libass shapes and falls back on its own.

Known limits: a music bed is not silence, so music-heavy audio is cut less; Whisper may write "uh" as "ah",
which is not treated as a filler; captions are a fixed style; the cut list is not human-approved.

## Checks

```
python .hermes/validate.py              # offline: skills, registration, runner selftest
node .hermes/plugins/sdlc/runner.mjs --selftest
```
