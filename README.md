# agents

A software-development-lifecycle agent suite for Claude Code — 22 specialist agents, ~60 skills, 6 scripted multi-agent workflows, and a routing policy that says which agent has to run when. (The skills number is exactly 60 in the packaged plugin and 59 in the live `.claude/` copy; the table below owns the precise counts, and the one-skill delta is explained under *Two things worth knowing*.)

The organizing idea: **the agent that does the work is never the agent that certifies it.** Implementation, code review, execution-based verification, security assessment, and release authorization are held by separate agents on purpose, and none can quietly absorb another's job.

The second idea, learned the harder way: an agent definition governs behavior *once invoked* and cannot make a caller invoke it. That is what `CLAUDE.md` and the `orchestrator` agent are for.

---

## What is in here

| Path | What it is |
|---|---|
| `CLAUDE.md` | **The routing policy.** Read this first. |
| `.claude/agents/`, `.claude/skills/`, `.claude/workflows/` | **Live** definitions backing the bare names (`qa-engineer`) when working in this repository. 22 agents, 59 skills, 6 workflows. |
| `sdlc-suite/` | The same suite packaged as a plugin, backing `sdlc-suite:*` names, published through `.claude-plugin/marketplace.json`. 22 agents, 60 skills, 6 workflows, 6 slash commands. Has its own [README](sdlc-suite/README.md) and `USAGE.md`. |
| `commandcode-suite/`, `.kimi-code/`, `.codex/`, `.agents/` | Ports of the same material to other harnesses. **Not invocable from Claude Code** — stated by the maintainer; not independently exercised here. |
| `.claude/audit/` | The registry's own audit report and remediation record. Not shipped with the plugin. |

Counts above were verified by listing each directory on 2026-08-29, not carried over from prior text.

### Where to start

1. **`CLAUDE.md`** — the routing policy: a trigger table naming, per observable condition, which agent MUST be invoked; that the implementer never certifies its own work; that handoffs are debts to be discharged; and that *announcing* a skip does not authorise it.
2. **[`sdlc-suite/README.md`](sdlc-suite/README.md)** — the agents themselves, by lifecycle stage, and how the four layers (skill / agent / command / workflow) differ.
3. **`sdlc-suite/USAGE.md`** — install, cross-repository use, unattended runs.

---

## Two things worth knowing before you use this

**The duplication is a hazard, not just redundancy.** The same agents exist in several trees. Editing the wrong one raises no error and changes nothing. `.claude/` and `sdlc-suite/` are both *live* and must be changed together, or which behavior you get depends on which name the caller happened to use — and `sdlc-suite/` namespaces its skill references (`sdlc-suite:requirements-craft`), so the edits are not always textually identical. The ports are already out of step: `commandcode-suite/`, `.kimi-code/` and `.codex/` each carry 21 agents and are missing `orchestrator`; `.agents/` ships skills with no agents directory; `.codex/` ships agents (as `.toml`) with no skills. The two live copies also currently differ by one skill (`autonomy-policy`, present in `sdlc-suite/skills/`, absent from `.claude/skills/`).

**The examples are load-bearing, not illustrative.** This material was developed against a real application, in a separate repository, over real reviews and real failures. Where an agent says "this is how a test lies to you", that is a defect someone shipped past, not a hypothetical.

---

## Status

No licence file is present (verified: no `LICENSE`, `CONTRIBUTING.md`, or `.github/` at the repository root as of 2026-08-29). Until one is added, default copyright applies and others have no granted right to reuse this — adding a `LICENSE` is the owner's call, not something this document assumes.

There is no contribution policy, versioned release process, or roadmap in this repository. Their absence is stated rather than papered over.
