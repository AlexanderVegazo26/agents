---
name: root-cause-analysis
version: 1.0.0
description: Five-whys and fishbone technique for finding the systemic cause behind an incident or defect, plus blameless postmortem structure. Load after an incident is mitigated, or when investigating a recurring defect pattern.
---

# Root Cause Analysis

## Go past the trigger to the systemic cause

The immediate trigger (a bad deploy, a traffic spike, a dependency outage) is rarely the full story — ask why the system was vulnerable to that trigger, why it wasn't caught earlier (code review, tests, staging, monitoring), and why recovery took as long as it did.

## Five whys

Ask "why" repeatedly against each answer until you reach a systemic cause (a process gap, a missing safeguard, an architectural assumption) rather than stopping at the first proximate cause. Watch for stopping too early at "human error" — that's almost never the root cause; ask what about the system allowed that error to happen and reach production.

## Fishbone / contributing factors

For anything with multiple contributing factors, categorize them (people, process, technology, environment) rather than forcing a single linear cause chain — most real incidents have more than one contributing factor, and fixing only the most obvious one leaves the others live.

## Label every claim, don't let a hypothesis quietly become fact

Whichever method you use, tag each candidate cause as **confirmed** (directly verified), **hypothesis** (plausible, not yet checked), or **ruled out** (checked and disproven) — the same discipline `incident-response` applies during the live incident. A five-whys chain is only as strong as its weakest link; if link three is actually an unverified hypothesis, the whole chain is a hypothesis, not a confirmed root cause, and the postmortem should say so.

## Blameless postmortems

The question is always "what about the system allowed this," never "who caused this." A blame-oriented postmortem trains people to hide information in the next incident, which makes future root-causing harder, not easier. Blameless doesn't mean unaccountable — every action item still needs a real owner (see below); the blamelessness applies to the analysis, not to follow-through.

## Structure

Timeline (what happened, when, in fact — not interpretation), impact, root cause and contributing factors (each labeled per above), what worked well, what didn't, action items each with an owner and tracked to actual completion. An action item with no owner is a wish, not a fix — and a postmortem isn't closed until its action items are done or explicitly retired with a stated reason.

Code, schema, or infrastructure changes coming out of an incident go through the same independent-review pipeline (`code-reviewer`, `qa-engineer`) as any other change — incident urgency doesn't exempt a fix from independent verification; an unreviewed fix for the last incident is a common way the next one starts.
