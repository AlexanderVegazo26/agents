---
name: debugging-methodology
version: 1.0.0
description: Localizing a single reproducible failure right now — hypothesis-driven investigation, bisection, differential diagnosis, and instrumenting to observe rather than guessing. Use when software-engineer or qa-engineer has one concrete failure to root-cause. Do NOT use for systemic retrospective analysis after an incident is mitigated or across a recurring pattern (that is `sdlc-suite:root-cause-analysis`), or for classifying a failure as bug/bad-test/flake once its cause is known (that is `sdlc-suite:qa-triage`).
---

# Debugging Methodology

## The discipline
Debugging is not guess-and-check. Every step either narrows the search space or it's wasted motion. The goal at each point is the cheapest experiment that would falsify the current leading hypothesis — not the fix that seems most plausible.

## 1. Reproduce reliably before doing anything else
A failure you can't reliably reproduce can't be reliably fixed — you'll "fix" whatever you happened to be looking at and have no way to confirm it was the actual cause. Find the minimal, deterministic reproduction first: strip inputs, environment, and timing down until the failure is as reliable as you can make it. If it's inherently flaky, characterize the flakiness itself (frequency, conditions that increase it) before trying to fix the underlying cause.

## 2. Bisect before you inspect
Binary search beats linear scanning almost every time the search space has an order to exploit:
- **Over time** — `git bisect` (or equivalent) between a known-good and known-bad commit. Cheap, mechanical, and doesn't require understanding the code first.
- **Over input space** — for a failure triggered by specific data, binary-search the input (does it fail with half the records? a quarter?) rather than eyeballing the whole dataset.
- **Over code path** — comment out or short-circuit half the suspect logic; does the failure persist? This is delta debugging: remove everything that isn't necessary to reproduce the failure, one piece at a time, verifying reproduction after each removal.

## 3. Differential diagnosis
Ask explicitly: what's different between the state where this works and the state where it doesn't? Candidates, in rough order of how often they're the actual answer: input data, environment/configuration, a recent code change, timing/ordering, and — often overlooked — an assumption that was true when the code was written and silently stopped being true.

Never fix the first plausible difference without confirming it's the one that matters — toggle it back and forth and confirm the failure tracks it, don't just note the correlation and move on.

## 4. Form an explicit hypothesis before you touch anything
"I think X is happening because Y" — write it down, even just to yourself, before making a change. Then design the smallest change or observation that would prove that hypothesis wrong if it's wrong. A hypothesis that can't be falsified by anything you're about to do isn't guiding the investigation, it's just narration.

## 5. Instrument to observe; don't guess by inserting fixes
Add logging, a debugger breakpoint, or a trace at the narrowest point that would confirm or deny the current hypothesis — not scattered print statements across everything that might be involved. Prefer observing the actual state at the point of failure over reasoning about what the state "should" be from reading the code; code that has a bug is, by definition, not doing what reading it suggests it does.

## 6. Confirm the fix addresses the cause, not the symptom
After a fix, re-run the original reproduction and confirm the hypothesis from step 4 was actually correct — not just that the symptom went away. A fix that makes the symptom disappear without confirming why is an unresolved bug wearing a green checkmark; if you don't know why it worked, say so explicitly rather than reporting it as understood.

## Common traps
- Fixing the first plausible cause found instead of confirming it against the reproduction.
- Mistaking a workaround (the symptom stopped, the underlying condition didn't) for a fix.
- Skipping bisection because "I already know roughly where the bug is" — often true, but the cases where it's wrong are exactly the expensive ones to have skipped it on.
- Adding logging everywhere instead of at the one point the current hypothesis actually needs observed.
- Declaring victory when the test suite passes without having confirmed the original hypothesis was the actual cause.
