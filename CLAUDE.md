# Agent routing policy

This file exists because agent definitions cannot fix the failure they kept hitting.
A definition governs how an agent behaves once invoked. It cannot make a caller
invoke it. Every gap recorded below was a routing decision by the orchestrator,
not a defect in the agent that never ran.

The rules here are triggers, not suggestions. A trigger fires on an observable
condition, so "I judged it unnecessary" is only a valid answer when the condition
is absent — not when the work felt small or the deadline felt close.

---

## 1. Mandatory invocation triggers

Each row fires on a condition you can check without judgment. When one fires,
invoke the agent or state explicitly, in your response to the user, that you are
skipping it and why. Silent omission is the failure mode this table exists to stop.

| Condition — if any of this is true | You MUST invoke |
|---|---|
| A new runtime dependency is added | `security-engineer` |
| A new IPC channel, endpoint, or process boundary is added or widened | `security-engineer` |
| Code writes files to a user-chosen or externally-supplied path | `security-engineer` |
| Anything parses externally-supplied data (media, archives, markup, serialized input) | `security-engineer` |
| Authentication, authorization, tokens, or sensitive data are touched | `security-engineer` |
| An implementation is complete and about to be reported as done | `code-reviewer` |
| A claim depends on runtime behavior that cannot be settled by reading | `qa-engineer` |
| Another agent explicitly hands off an item to a named agent | that named agent |
| A user-facing interaction model is being decided | `ux-designer` |
| A significant technical decision needs to outlive the change | `solution-architect` |
| A schema or migration is involved | `database-engineer` |
| Docs describe behavior that this change makes false | `technical-writer` |

## 2. The implementer never certifies its own work

`software-engineer` and `ui-engineer` run their own tests — that is how they know
their work functions, and it is necessary. It is not verification.

Before reporting an implementation as done, `code-reviewer` must have reviewed it.
Where the work has execution-dependent claims, `qa-engineer` must have exercised
them. An implementer reporting "tests pass, done" with no independent lens is not
a completed task, however green the suite.

This is the suite's founding rule — "the agent that does the work is never the
agent that certifies it." It is easy to drop when scoping a run tightly, and
dropping it is how three defects reached review with a green typecheck and 478
passing unit tests over them.

## 3. Handoffs are debts, not suggestions

When an agent routes an item to another agent — "handing to `qa-engineer`",
"escalating to `solution-architect`" — that item is owed. Track it and discharge
it, or tell the user it is outstanding and why.

An agent that correctly refuses to assert something it cannot verify has done its
job. The value is lost entirely if nobody picks the item up. A review that ends in
four unclaimed handoffs has deferred the work, not completed it.

## 4. Announcing a skip does not authorise it

A mandatory trigger in §1 is discharged by **invoking the agent**, not by
explaining why you did not. Saying "I'm skipping `technical-writer` because I
already have the context" is a narration of the failure, not a remedy for it.

When a §1 trigger fires you have exactly two valid moves:

1. **Invoke the agent.**
2. **Show the trigger condition is absent** — no new dependency exists, nothing
   parses external input, the docs are not stale. This is a factual claim about
   the code, and it is checkable.

"I hold the context and a round trip would cost time" is **not** a valid reason.
Context is passed in the prompt; that is what the prompt is for. Holding context
is an argument for writing a *better* brief, never for skipping the lens. Every
skip in this suite so far has been justified this way, and each one removed the
independence that made the lens worth having — the point of a second agent is
that it is not you.

If you genuinely intend to skip a fired trigger anyway, **ask the user first and
wait for an answer.** Do not announce it in a report after the fact, where it
reads as a decision already made. The user can accept a narrowed scope; they
cannot accept one presented as settled.

Scope narrowing is still legitimate where §1 does not fire — a Tier 1 change does
not need the full suite, and over-dispatching burns patience until nobody uses
the suite at all. The rule here binds mandatory triggers, not judgment generally.

## 5. Skills are part of the agent's contract

Every agent with a Supporting Skills section is required to invoke the applicable
skills via `Skill` and to open its report with a `Skills loaded` line naming them,
with a one-clause reason for each it skipped.

If a report arrives without that line, the agent did not follow its contract.
Treat the report as incomplete and say so, rather than accepting findings that
were produced without the checklist they were supposed to apply. Verify against
the transcript when it matters — a self-reported line and the tool calls actually
made have to agree.

## 6. Verification standards that apply to every agent

- **Exit codes, not output.** A runner can print "N passed" while exiting 1.
  Never pipe a test run to `tail` or `head` — that reports the pager's status.
- **Skipped is not passed.** A suite that skips a gate and exits 0 has not run
  the gate. Read what the run actually reported, not just its exit code.
- **Artifacts over assertions.** Where a feature produces an output, the acceptance
  evidence is the output, measured. "Tests pass" is not evidence a file was produced.
- **A test that cannot fail proves nothing.** When adding an assertion for a fix,
  demonstrate it failing against the unfixed code first. A guard shadowed by an
  earlier guard makes its own test permanently green.
- **A comment asserting a guarantee is an unverified claim.** Seven were found
  false in a single day — "`unknown` covers Windows", "failures after this point
  arrive through `onRecordingFailed`", "every terminal path unlinks the temp
  file", an ADR naming a field that does not exist, an allowlist nothing read.
  Each survived many readings *because* it sounded authoritative, and one of them
  is directly why a P0 dead-end shipped. Check them, and when writing one, state
  the measurement and its date or scope it explicitly.
- **A collector harness hides the whole loop.** A test harness that stubs a
  callback as a sink (`h.failures.push(msg)`) terminates one hop before anything
  the consumer does with it. Three consecutive defects passed green suites for
  exactly this reason. When a callback gains a consumer, the harness has to model
  the consumer too.

---

## Repository layout — edit the right copy

The same agents exist in several trees. Editing the wrong one changes nothing.

| Path | Status |
|---|---|
| `.claude/agents/` | **Live** — backs the bare names (`security-engineer`) |
| `sdlc-suite/agents/` | **Live** — backs `sdlc-suite:*` via `.claude-plugin/marketplace.json` |
| `commandcode-suite/agents/`, `.kimi-code/agents/` | Other harnesses; not invocable here |

Both live copies must be changed together, or which behavior you get depends on
which name the caller happened to use. Note that `sdlc-suite/` namespaces its skill
references (`sdlc-suite:requirements-craft`), so text edits are not always identical.

**If an agent vanishes from the roster, check its line endings first.** Five agents
silently stopped registering — dispatch failed with "agent type not found" — and every
one had CRLF in its frontmatter; normalising to LF restored them in the same session.
The CRLF was never authored, git's autocrlf introduced it on checkout, which is what
the "LF will be replaced by CRLF" warnings report. `.gitattributes` now pins `*.md
text eol=lf`. Two hypotheses were falsified and should not be retried: description
length (a 480-char broken one sat beside a 659-char working one) and the `INVOKE WHEN:`
colon-space in unquoted YAML (nine carry it, five broke).

Definitions are read fresh per invocation, so an edit takes effect without a restart —
which also means a broken one breaks immediately.

`nawi/` (still named `snagit-clone/` on disk until the rename lands — both are ignored) is a separate repository these agents build against — deliberately
untracked here, with its own history and branches.
