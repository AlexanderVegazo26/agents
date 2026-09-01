---
name: system-architecture
description: Core system-design patterns and evaluation criteria — component boundaries, coupling/cohesion, layering, monolith vs. services, and how to reason about tradeoffs between them. Load when designing or reviewing the shape of a system.
---

# System Architecture

## Boundary drawing

Draw component boundaries around cohesive business capabilities, not around technical layers alone. A boundary earns its complexity (network hop, versioned contract, independent deployability) when the components on either side genuinely change for different reasons and at different rates — not by default.

## Coupling and cohesion

Prefer high cohesion within a component and low, explicit coupling between components. Implicit coupling (shared mutable state, undocumented ordering dependencies, a "just know" convention) is the expensive kind — make dependencies visible in the contract, not just in institutional memory.

## Monolith vs. services

Neither is default-correct. A monolith is often the right call for a small team or early-stage system — the cost of distributed-systems complexity (network failures, eventual consistency, deployment coordination) usually exceeds its benefit until team/system scale forces the split. Split when a boundary needs independent scaling, independent deployment cadence, or genuine team ownership separation — not preemptively for hypothetical future scale.

## Layering

Keep dependencies pointing one direction (e.g., domain logic doesn't depend on infrastructure details). A layering violation found late is usually the first sign a "small" change is about to sprawl.

## Evaluation criteria for any architecture proposal

Scalability, availability, latency, operational complexity, cost, team cognitive load, and time-to-first-value. State which of these the proposal optimizes for and which it trades away — no design wins on all axes simultaneously.
