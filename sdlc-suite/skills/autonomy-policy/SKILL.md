---
name: autonomy-policy
version: 1.0.0
description: How to handle a "stop and confirm" gate when no human is present — consult the repo's pre-authorization policy, then either proceed under it or record the gate as blocked and continue with everything else. Load whenever an agent reaches a confirmation gate, and always in an unattended or scheduled run.
---

# Autonomy Policy

Every agent in this suite has gates that say *stop and confirm before X*. Those gates exist because X is hard to undo. They were written assuming a human is watching.

In an unattended run nobody is watching, and a literal halt is the worst of both worlds: the irreversible action still doesn't happen, but neither does any of the reversible work that didn't depend on it. This skill replaces *halt* with *defer and continue*, without weakening what actually requires authorization.

## The rule

When you reach a gate:

1. **Read the policy.** In order: the policy path supplied by the invoking command or workflow args (`policy: "…/autonomy.json"`), then `.claude/autonomy.json` in the consuming repo. Do not try to guess a plugin-root path — `${CLAUDE_PLUGIN_ROOT}` expands in commands and hooks, not in this text. If no policy file resolves, treat every gate as **not** pre-authorized and say so in your output, because that state is indistinguishable from a deliberately locked-down policy and the difference matters.
2. **If the gate is pre-authorized** (`preAuthorized.<class>.<gate> === true`) — proceed, and record in your output that you acted under standing authorization, naming the gate. That record is not optional; it is what makes the authorization auditable after the fact.
3. **If it is not pre-authorized** — do **not** perform the action, and do **not** stop the task. Emit a blocked-gate entry (below), then continue with every part of the work that does not depend on it.
4. **If the policy is silent on a gate you've hit** — treat it as not pre-authorized and say so explicitly. A gate missing from the file is an unanswered question, never an implied yes.

## Blocked-gate entry

Every blocked gate produces one of these, and they all surface together at the end of the run:

```
BLOCKED — <gate id>
  Action withheld: <what you would have done>
  Why gated:       <the irreversibility or blast radius>
  Prepared:        <what is ready so a human can execute it in one step>
  Unblocks:        <what downstream work is waiting on it>
  Authorize by:    setting preAuthorized.<class>.<gate> in autonomy.json
```

"Prepared" is the part that earns the autonomy. A blocked deploy that leaves behind a verified artifact, a written rollback plan, and a one-line command is a successful outcome. A blocked deploy that leaves behind only the word "blocked" wasted the run.

## What never becomes pre-authorizable

Regardless of what the file says, these stay human:

- Anything whose reversibility you are **uncertain** about — treat uncertainty about reversibility as irreversibility, as `sdlc-suite:engineering-integrity` already requires.
- Anything outside the blast radius the policy describes. Pre-authorizing `deploy` does not pre-authorize a deploy that also runs a destructive migration; that's two gates, and the second one is still shut.
- Anything a specific agent's own prime directive forbids on grounds other than confirmation — a self-certification ban is not a confirmation gate and this skill does not touch it. `sdlc-suite:qa-engineer` may not certify `sdlc-suite:software-engineer`'s work autonomously any more than it may interactively.

## Honesty under autonomy

Unattended runs remove the person who would have noticed a hedge. So the reporting bar goes **up**, not down:

- Never upgrade "I could not verify this" to "verified" because no one will ask.
- Never let a blocked gate quietly vanish from the final output because the run otherwise looks clean.
- If the run degraded — a tool failed, an MCP server was unauthenticated, a test suite never executed — that goes in the result at top level, not buried in a phase log.
