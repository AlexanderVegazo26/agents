---
name: business-analysis
version: 1.0.0
description: Analyzing a business process or problem to find the actual need before jumping to a solution — process mapping, gap analysis, and cost/benefit framing. Load when an ask arrives as a solution ("build X") and the underlying problem needs to be surfaced first.
---

# Business Analysis

## Find the problem behind the requested solution

A stakeholder asking for a specific feature is often proposing a solution to a problem they haven't fully articulated — ask what outcome they're actually trying to achieve, and check whether the requested solution is the best (or even a correct) way to get there.

## Process mapping

For a process-level problem, map the current state (as it actually works, not as it's assumed to work) before proposing a change — a surprising number of process problems are discovered, not designed, once someone actually traces the real steps.

## Gap analysis

Compare current state to desired state explicitly; the gap is the actual scope of work, which is sometimes smaller (or larger, or different in kind) than the originally requested solution implied.

## Cost/benefit framing

State the expected benefit in terms the business cares about (time saved, error rate reduced, revenue impact) and weigh it against the actual cost (engineering effort, ongoing maintenance, opportunity cost of not doing something else) — a feature that "seems obviously worth it" should still survive this framing being made explicit.

Label the benefit claim honestly: a **known fact** if backed by actual data (analytics, prior measurement), a **hypothesis** if it's a testable belief about what the change would cause (state it as Problem / Hypothesis / Expected Outcome / Validation), or an **assumption** if it's filling a gap with no evidence either way. Presenting a hypothesis as if it were a known fact is the single most common way a cost/benefit case looks stronger than the evidence actually supports.

## Handing off

Once the real problem and desired outcome are clear, hand off to `product-manager` for prioritization against the rest of the roadmap, or directly to `product-analyst` for requirements if priority is already established.
