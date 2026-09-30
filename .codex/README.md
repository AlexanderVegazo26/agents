# Codex port: running the suite on a local Qwen3.8-27B

`agents/` and `skills/` here are generated from `sdlc-suite/` by
`python sdlc-suite/tools/generate_trees.py`, so don't edit them by hand. This README,
the launchers and the Modelfile are hand-maintained.

## What you get

Codex CLI, with every suite agent available as a `spawn_agent` role (`orchestrator`,
`code-reviewer`, `qa-engineer`, …), driven by Qwen3.8-27B served by Ollama on this
machine. No OpenAI login is used, and nothing leaves localhost unless you point
`QWEN_SDLC_OLLAMA_URL` elsewhere. That URL is plain http, and the whole
conversation, including repository content, goes to it.

The `.claude/workflows/*.js` scripts do **not** run here. On Codex you start the
suite by asking for a named agent. Spawning a specialist directly (for example
`code-reviewer`) is what was verified end to end on Qwen. Asking `orchestrator`
to dispatch the others is how the suite is meant to be driven, but that nested
flow has **not** been run on Qwen yet, and at these speeds it would take hours:

```
.codex\run-qwen-local.ps1 exec "Spawn the code-reviewer agent to review <diff>"
.codex/run-qwen-local.sh               # interactive, Git Bash / POSIX
```

`codex exec` also reads stdin when it is not a terminal and waits on "Reading
additional input from stdin…", so close stdin when
scripting it: `</dev/null` in bash (with `run-qwen-local.sh`), `< NUL` in cmd.
Windows PowerShell 5.1 has no `<` redirection, so script it from bash or cmd.

## One-time setup

1. Install Ollama **0.34 or newer**. 0.17.6 predates the Qwen3.8 architecture.
2. `ollama pull qwen3.8:27b` downloads about 17 GB, Q4_K_M, with tools and vision.
   The digest verified here is `aaee06c39dcf`. Compare it with `ollama list` if you
   want the same build, because the tag is mutable.
3. `ollama create qwen3.8-27b-sdlc -f .codex/Modelfile.qwen3.8-27b` sets a 32768-token
   context. Ollama's default context is far smaller, and it truncates an over-long
   prompt silently.
4. Codex CLI (verified with 0.148.0).

## What the launcher does, and why

- **Its own Codex home** (`~/.codex-qwen`, or `QWEN_SDLC_CODEX_HOME`). Your
  `~/.codex` is neither read nor changed. The launcher rewrites `config.toml`
  there on every run. It refuses a home that has a `config.toml` it did not
  write, or that already holds other files. Codex still reads the user-wide
  `~/.agents/skills`, so the isolation covers config, login and agents, not
  every skill source.
- **Trusts this repository** in that home. Without trust, Codex skips
  `.codex/agents/` entirely, and its `spawn_agent` tool offers no agent types at
  all. Trust also makes Codex load project-scoped config, hooks and rules from
  `.codex/`, some of which can run or approve commands. The launcher therefore
  allowlists the entries this repository ships in `.codex/` and refuses to start
  if anything else appears. Add a new file there to both launchers' lists.
- **A custom provider, `qwen_local`**, rather than `--oss`. The built-in `ollama`
  provider cannot be reconfigured, and its 300-second stream-idle timeout is shorter
  than processing a full agent prompt takes on CPU (see below). The launcher sets
  the timeout to one hour.

## Measured on this machine

RTX 3060 Laptop (6 GB VRAM), 63 GB RAM, Ollama 0.34.4. The model runs **88% CPU /
12% GPU**.

| | Measured |
|---|---|
| Model load | 18 s |
| Prompt processing | ~92–107 tok/s |
| Generation | ~1.8–2.1 tok/s |
| Codex prompt per agent turn | 12–14k tokens (`truncated = 0` in the Ollama log) |
| Acceptance run (one spawned `code-reviewer` on a 3-line diff) | 66.5 min, and 93 min on an independent re-run. Both times the child ran with `agent_role: code-reviewer` and that agent's instructions, and its answer followed the report contract |

At these rates each agent turn takes minutes, and a full orchestrated run with
several specialists takes hours. It works, but it is slow, and the hand-back is
not always clean. In the re-run the parent's `wait` returned empty after the child
had finished. The parent recovered the answer with `send_input`, but the review
landed in a `reasoning` event, and its last `agent_message` was a status line.
Read the child's session file under `~/.codex-qwen/sessions/` when the final
message looks wrong. On a GPU that holds the
whole model, the same setup is interactive.

## Known limits

- **About two-thirds of the suite's skills are invisible to the model at this
  context size.** Codex reads both `.codex/skills/` and `.agents/skills/` (the same
  skills twice) and, at a 32768 window, drops every description and 99 skills
  from the list it shows the model. Only about 23 names survive, alphabetically up
  to `data-modeling`. `engineering-integrity`, `project-memory`, `secure-coding`,
  the `qa-*` skills and `image-generation` are among those missing. An agent
  whose instructions name one can still read `.codex/skills/<name>/SKILL.md`
  directly, but that fallback has not been verified. A larger `num_ctx` (and
  `model_context_window`) raises the budget at the cost of RAM and prompt time.
- **The image-generation skill cannot render while this model is loaded** on a
  6 GB GPU. Ollama holds about 3.8 GB of it, and sd-cli ran out of device memory
  and exited 1. That happened once during sampling and once at prompt encoding. Render after the session, once Ollama has unloaded the model (5
  minutes idle, or `ollama stop qwen3.8-27b-sdlc`).
- Codex has no `Skill` tool. Agents whose contract says "invoke via `Skill`" read
  the skill instead and say so in their **Skills loaded** line, which was observed
  in the acceptance run.
- Codex's read-only sandbox rejects some of the PowerShell commands agents try,
  such as memory lookups. The error goes back to the model and the run continues.
- Codex warns "Model metadata for `qwen3.8-27b-sdlc` not found". This is harmless.
  Codex uses fallback metadata, and `model_context_window` is set explicitly.

## Environment overrides

| Variable | Default |
|---|---|
| `QWEN_SDLC_MODEL` | `qwen3.8-27b-sdlc` (letters, digits and `. _ : / -` only) |
| `QWEN_SDLC_OLLAMA_URL` | `http://localhost:11434` |
| `QWEN_SDLC_CODEX_HOME` | `~/.codex-qwen` |
