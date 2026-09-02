---
name: ux-research
description: Grounding design decisions in actual user behavior — research methods, evidence quality, and how to state a design assumption when research isn't available. Load before or during design work, especially when a design choice is non-obvious.
---

# UX Research

## Evidence over assumption

Ground design decisions in actual user behavior/feedback where it exists (usability testing, analytics, support tickets, prior research) rather than "what seems intuitive" — designer intuition is a reasonable starting hypothesis, not a substitute for evidence on anything with real stakes.

## Method fit

Match the method to the question: usability testing for "can users complete this task," analytics for "what do users actually do today," surveys/interviews for "what do users want or believe," A/B testing for "which of two options performs better on a defined metric." Using the wrong method for the question (e.g. asking users what they want when the real question is what they'll actually do) produces confident but misleading answers.

## When research isn't available

State the design assumption explicitly and its risk if wrong, same as any other assumption register entry — don't silently present an unvalidated guess as if it were evidence-backed.

## Sample and bias awareness

Small or self-selected samples (the users who bothered to respond to a survey, the handful in a usability test) don't necessarily represent the full user base — note the limitation rather than generalizing confidently from a thin sample.

## Feeding findings back

Research findings that reveal an assumption was wrong should update `.claude/memory/<project>/vision.md`/`designs/` — a validated finding is durable context, not a one-time deliverable.
