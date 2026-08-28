---
name: code-review-craft
description: How to give an effective, specific code review — severity classification, what to look for beyond syntax, and how to phrase feedback that's actionable rather than vague. Load before reviewing a diff.
---

# Code Review Craft

## Form your own expectation before reading the diff

Read the linked requirement/ADR/ticket first and decide independently what a correct implementation looks like — approach, edge cases, contract — *before* reading the diff. Reviewing the diff first and reasoning backward from what the author built is the single most common way a reviewer ends up rubber-stamping the wrong thing: it silently substitutes "is this internally consistent" for "is this correct." If your expectation changes after seeing the implementation, say so and say why (this is `code-reviewer`'s §4 contamination guard).

## Severity classification

Every finding gets exactly one severity label: **must fix** (bug, security issue, regression, breaks a requirement), **should fix** (real improvement, not blocking), or **nit** (style preference, optional) — plus a confidence label (**high** / **medium** / **low**) stating how directly the finding was observed vs. inferred. Mixing these into undifferentiated feedback makes a reviewer's most important point indistinguishable from their least important one, and asserting low-confidence inference as fact is its own failure mode.

## What to look for beyond syntax

Correctness against the stated requirement; edge cases and error paths, not just the happy path; test coverage that actually exercises the new logic (read the tests, don't infer from "tests added"); whether this diff quietly introduces a new pattern/dependency/coupling that should have gone through architecture review; security-sensitive input handling; performance red flags (N+1, unbounded loops) proportionate to expected scale.

## Phrasing feedback

Be specific: reference file:line, state what's wrong and why it matters, and where possible suggest the fix rather than just naming the problem. "This could be cleaner" is not actionable; "this loop does an unindexed lookup per iteration — O(n²) — for a collection that can reach 10K rows in production" is.

## What review is not

Not a rubber stamp, and not an opportunity to relitigate scope or impose unrelated stylistic rewrites — review the diff for what it claims to do, correctly and safely, and flag out-of-scope observations separately rather than blocking on them.

A reviewer that only reads static code cannot confirm runtime behavior (concurrency timing, actual load behavior, an integration's real response shape) — flag anything that needs execution to confirm as a hypothesis for `qa-engineer` to verify, rather than asserting it as a closed finding either way.

## Not a patch generator

A code review's output is findings and a suggested direction, never a rewritten diff — producing the fix yourself removes the accountability boundary between "the author owns the change" and "the reviewer owns the critique," and risks the reviewer's own untested fix silently replacing the original bug with a new one.
