# `.pi/extensions/sdlc/` — the suite's two Claude-Code primitives, for pi

Hand-maintained. The tree generator (`sdlc-suite/tools/generate_trees.py`)
never writes or removes anything under `.pi/extensions/`; the generated `.pi`
tree is `.pi/prompts/` and the repository-root `AGENTS.md` only.

## What it provides

| Tool | Replaces | Runs |
|---|---|---|
| `agent` | Claude Code's `Agent(<name>)` / Task sub-agent dispatch | one separate `pi -p` session per call |
| `workflow` | Claude Code's `Workflow` tool | `sdlc-suite/workflows/*.js` in a `node:vm` sandbox |

The sandbox reproduces the allowlist the shipped scripts were measured
against: `agent, parallel, pipeline, workflow, phase, log, args, budget,
setTimeout, clearTimeout, console` — no `require`, `process` or `fs`, and
`Math.random()`, `Date.now()` and argless `new Date()` replaced with
throwers, so resume stays deterministic. The scripts' own bridge pattern
(a mechanical agent that writes and runs a scratch Node script) is what
gives the pipeline its file I/O; the sandbox itself stays I/O-free.

## Behavior worth knowing

- **Sub-agent sessions keep pi's default system prompt** (project context,
  skills, tools); the role file's body is prepended to the brief. Claude
  Code's sub-agents effectively have the plugin context too, so nothing is
  lost; the isolation is per-session context, as there.
- **`model:` in an agent file is honored** via `--model`. When that model is
  unavailable in the environment (e.g. `qa-runner`'s `sonnet` on a machine
  running a local model) the dispatch degrades to the default model and
  says so in the progress log, rather than dying.
- **`effort` maps 1:1 onto `--thinking`** where the vocabularies overlap
  (`low`/`medium`/`high`); other values are ignored.
- **Relative suite paths are resolved by the tool** (`args.runtimeDir`,
  `args.policyDefault`, `args.policy` against the working directory) — pi's
  replacement for the command layer's `${CLAUDE_PLUGIN_ROOT}` expansion.
  The scripts still validate shape on their side (absolute only, no `..`);
  that validation is what stops a consuming repo from pointing the runtime
  at a `_policy.js` the repo itself wrote.
- **Run recording lands in `.claude/runs/`** — the same directory Claude
  Code uses, because run records are harness-agnostic JSON and the learning
  loop (`/improve`) reads them. It is gitignored.
- **Per-agent timeout** defaults to 15 minutes; override with
  `PI_SDLC_AGENT_TIMEOUT_MS` (milliseconds). The pi binary is found via
  `$PI_BIN`, then `~/.pi/agent/bin/pi`, then PATH.
- **Nested sessions get pipe/PTY stdio, explicitly.** Node ≥ 26 (observed
  on v26.10.0) hands spawned children socketpair stdio — even when
  `stdio: ['pipe','pipe','pipe']` is passed explicitly — and pi's print mode
  deadlocks on socket stdio (no model connection, no output, 0% CPU) while
  the identical command on pipes or a PTY completes normally. So on Node ≥ 26
  the dispatch runs the nested pi under `script -qec` (util-linux), which
  allocates a PTY; the prompt travels through the environment, never the
  shell command, and output is cleaned of CRLF/ANSI before parsing. On older
  Node (pipe stdio) the dispatch spawns pi directly. If `script` is missing
  on a Node ≥ 26 host the dispatch falls back to the direct spawn and will
  hang on that host — the selftest documents the boundary.

## Degradation policy

A failed dispatch returns `null` into the sandbox (the scripts' own
retry/breaker/reducer logic is built around exactly that), never a
plausible-looking substitute. A failed workflow returns the failure text;
the command templates instruct the top-level agent to relay it, not to
improvise a substitute run.

## Checks

```
node .pi/extensions/sdlc/lib.js --selftest
```

Plain node, no pi, no network, no LLM: imports the whole extension (load
check), runs a synthetic workflow through the sandbox with a stubbed agent
(meta extraction, top-level await, `parallel`, no-barrier `pipeline`, the
determinism throwers, suite-path resolution), and exercises the spawn
fallbacks with a stubbed spawner. Wired into CI alongside the generated
tree's own gates.

## Known simplifications, stated rather than papered over

- Claude Code's host-side transport retry is reproduced as exactly one
  identical retry after a non-zero session exit; there is no deeper
  transport layer to reproduce.
- `budget` and `workflow` are present for allowlist parity; no shipped
  script uses them.
- A sub-agent's `tools:` frontmatter grant is not enforced (pi sessions get
  the default tool set). The suite's agent files do not rely on narrower
  grants to be safe — their safety lives in the prompts and the autonomy
  policy, which travel with the dispatch.
