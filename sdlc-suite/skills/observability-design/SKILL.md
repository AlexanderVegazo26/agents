---
name: observability-design
version: 1.0.0
description: Designing logs, metrics, and traces so a production failure can actually be diagnosed — what to instrument, what makes an alert actionable, and correlation across services. Load when building a new service or reviewing whether a change has adequate observability.
---

# Observability Design

## The real question

Not "does this log something" but "if this fails at 2 AM, could someone diagnose it from what we've instrumented, without SSH-ing in to guess?" Design observability against that bar.

## Logs

Structured, with enough context to trace a single request/operation across its full path (correlation/trace ID propagated end to end). Log at the boundary of every meaningful decision or state change, not just on error. Never log secrets, full PII, or credentials — even at debug level.

## Metrics

Track what reflects actual user-facing health (request rate, error rate, latency distribution — the RED/USE-style baseline) plus anything specific to this component's failure modes. A metric no one will ever look at or alert on is instrumentation debt, not signal.

## Traces

For anything spanning multiple services, propagate a trace/correlation ID through every hop so a slow or failed request can be attributed to the actual bottleneck service, not guessed at.

## Alerting

An alert should be actionable — the person receiving it should know what to do next. Alert on symptoms that matter to users (elevated error rate, latency breach) rather than every internal anomaly; a noisy alert trains people to ignore all of them, including the real one.

An alert earns its existence only if all three hold: someone needs to act on it, the action is understood, and the urgency is real. If any is missing, fix the alert or remove it — don't let it accumulate as noise that erodes trust in the ones that matter. This is `sdlc-suite:site-reliability`'s standing bar for every alert it owns (§1.2 of that agent).

## Dashboards

Build for the question someone will actually ask during an incident ("is this healthy," "what changed," "where's the bottleneck") — not a wall of every metric available.
