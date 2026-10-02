# Pi harness — instance configuration

The routing policy does not live here. It ships at
[`sdlc-suite/ROUTING.md`](sdlc-suite/ROUTING.md) — **read that file in full
before routing any work.** This file holds only what is local to running this
suite under the pi harness.

---

## How the suite maps onto pi

| Suite layer | Where it lives in pi |
|---|---|
| Skills | `.agents/skills/` — pi discovers the Agent Skills location automatically, from the working directory up to this repository root. No configuration, no copy. |
| Slash commands | `.pi/prompts/`, generated from `sdlc-suite/commands/`. |
| Role agents | `sdlc-suite/agents/` (canonical) and the generated trees, invocable via the `agent` tool (see below). |
| Workflows | Runnable via the `workflow` tool (see below). |

**Sub-agents: the `agent` tool.** The hand-maintained extension at
`.pi/extensions/sdlc/` registers an `agent` tool (parameters: `name`, `task`).
A call dispatches a separate, non-interactive `pi` session whose prompt is the
role file's body (resolved from `sdlc-suite/agents/` or `.claude/agents/`,
namespace prefix optional) followed by the task. The nested session keeps pi's
default system prompt — project context, skills, tools — and the role file's
`model:` frontmatter is honored via `--model`, degrading to the default model
with a note when that model is unavailable. A failed or timed-out dispatch
returns null, which the suite's retry/breaker logic is built around. This is
the structural process boundary the independence rule relies on: the role
runs in a different session, with a different conversation.

**Workflows: the `workflow` tool.** The same extension registers a `workflow`
tool (parameters: `scriptPath`, `args`). It executes `sdlc-suite/workflows/*.js`
in a `node:vm` sandbox whose globals are the runtime's explicit allowlist
(`agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`, `budget`,
`setTimeout`, `clearTimeout`, `console` — no `require`, `process` or `fs`;
`Math.random()`, `Date.now()` and argless `new Date()` are replaced with
throwers so a resume stays deterministic). `agent()` inside the sandbox is the
`agent` tool above, so every pipeline stage is a real separate session. The
relative `runtimeDir` / `policy` / `policyDefault` argument values are resolved
against this repository before the script sees them (the `${CLAUDE_PLUGIN_ROOT}`
expansion the command layer does in Claude Code), and the scripts' own absolute
path validation still runs. Commands that were placeholders in `.pi/prompts/`
now run for real — use the `workflow` tool when a command's body says to.

**The independence rule is structural again, but the evidence standards still
bind.** The role runs in a separate session, so implementer-never-certifies is
enforced by process boundary as designed. That does not lower the bar:
`ROUTING.md`'s Confirmed vs Claimed-not-verified distinction still applies to
whatever each session reports, and a self-check performed by the same session
that did the work must say so in the response.

## Local paths

- `CLAUDE_PLUGIN_ROOT` is not a thing here. The generated prompts already
  carry repository-relative paths (`sdlc-suite/...`); run tools from this
  repository as the working directory.
- The memory root stays `.claude/memory/<project>/` — the agent and skill
  files reference that path, and `/init` still scaffolds it (plus
  `autonomy.json`). Its routing install targets `.claude/CLAUDE.md`; under pi
  the routing lives in this file instead.
