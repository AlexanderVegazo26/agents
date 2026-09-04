---
name: domain-driven-design
version: 1.0.0
description: Bounded-context reasoning, ubiquitous language, and aggregate/entity modeling for structuring a system around the business domain rather than technical convenience. Load when deciding service/module boundaries or modeling a complex business domain.
---

# Domain-Driven Design

## Ubiquitous language

Use the business's own vocabulary in code, docs, and conversation — consistently, the same term meaning the same thing everywhere. A term that means one thing to the business and another in the code is a translation bug waiting to cause a design bug. Record it once in `glossary.md`, reference it everywhere.

## Bounded contexts

A bounded context is where a model and its language are internally consistent — the same word can mean something different in another context (e.g. "Customer" in Billing vs. "Customer" in Support), and that's fine as long as the boundary between them is explicit and translation at the boundary is deliberate.

Draw context boundaries around areas that change for the same business reason and at the same rate — this is the DDD-flavored version of the coupling/cohesion reasoning in `sdlc-suite:system-architecture`.

## Aggregates and entities

An aggregate is a consistency boundary — everything inside it is kept transactionally consistent; anything outside is eventually consistent by design. Keep aggregates small; a large aggregate becomes a concurrency bottleneck and a modeling smell that it's actually multiple concepts glued together.

## Anti-corruption layers

At the boundary between two bounded contexts (or between your system and a legacy/external one), translate explicitly rather than letting one context's model leak into another's. This is what keeps a legacy system's awkward model from infecting a clean new one.

## When not to apply this

Full DDD ceremony (aggregates, bounded contexts, anti-corruption layers) is overkill for a small CRUD app with a simple domain — apply it where genuine domain complexity justifies the modeling investment, not reflexively everywhere.
