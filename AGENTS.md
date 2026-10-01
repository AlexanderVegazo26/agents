<!-- GENERATED from sdlc-suite/pi/AGENTS.md — do not edit. Run python sdlc-suite/tools/generate_trees.py -->

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
| Role agents | `sdlc-suite/agents/` (canonical) and the generated trees. |
| Workflows | Not runnable here yet — see below. |

**Pi has no sub-agent tool.** The role agents are therefore not invocable as
separate agents. When a trigger in `ROUTING.md` fires, the running agent takes
on that role itself: open the role's file, follow it for the duration of the
task, and say in the response which role is speaking.

**The Workflow tool does not exist in pi either.** The commands backed by
`workflows/*.js` carry a note in their `.pi/prompts/` copies saying exactly
that. They are placeholders until a pi Workflow extension lands; do not
improvise a substitute run, and do not report a result the pipeline did not
produce.

**The independence rule survives as discipline, not as architecture.** In this
harness the same process that implements can verify, which is the failure the
suite's organizing idea exists to prevent. The triggers still name the role
and the role's file still binds, but the process boundary that made
implementer-never-certifies structural is gone — so the evidence standards in
`ROUTING.md` (Confirmed vs Claimed-not-verified) have to be applied harder,
not looser, and a self-check must say so in the response.

## Local paths

- `CLAUDE_PLUGIN_ROOT` is not a thing here. The generated prompts already
  carry repository-relative paths (`sdlc-suite/...`); run tools from this
  repository as the working directory.
- The memory root stays `.claude/memory/<project>/` — the agent and skill
  files reference that path, and `/init` still scaffolds it (plus
  `autonomy.json`). Its routing install targets `.claude/CLAUDE.md`; under pi
  the routing lives in this file instead.
