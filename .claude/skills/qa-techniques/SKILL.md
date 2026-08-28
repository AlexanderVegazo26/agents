---
name: qa-techniques
description: Core test-design techniques — equivalence partitioning, boundary value analysis, state transition testing, invariant-based testing, and metamorphic testing. Load when designing test cases for a feature, endpoint, or function, not just when running existing tests.
---

# QA Test-Design Techniques

Use these to generate test cases systematically rather than by intuition alone. Pick the technique(s) that fit the shape of the thing under test — most non-trivial features need more than one.

## Equivalence Partitioning (EP)

Split the input space into partitions where every value in a partition should behave the same way. Test one representative per partition instead of every value.

- Identify valid partitions (per input field: valid range, valid enum values, valid format) and invalid partitions (out of range, wrong type, malformed, missing/null).
- One test per partition is enough *if* BVA (below) covers the edges separately — don't duplicate boundary values inside EP tests.
- Applies to: form fields, API parameters, config values, any function with a constrained input domain.

## Boundary Value Analysis (BVA)

Defects cluster at edges. For every partition boundary, test: the boundary value itself, one below, one above (min-1, min, min+1, max-1, max, max+1).

- Don't forget structural boundaries beyond numeric ranges: empty collection, single-element collection, max-length string, first/last page, zero, negative zero, empty string vs null vs whitespace.
- Off-by-one errors are the dominant bug class this technique catches — treat any `<` vs `<=` or loop bound as a boundary to test explicitly.

## State Transition Testing

For anything with a lifecycle (order status, user session, workflow/approval states, connection states): model states and legal transitions, then test:

- Every legal transition actually works.
- Every illegal transition is rejected (not silently ignored — rejected with a correct error).
- Transitions triggered from an unexpected state (e.g. "cancel" on an already-cancelled order).
- Re-entrancy: firing the same transition twice, concurrently, or out of order.

A transition table (current state × event → next state / error) makes gaps visible faster than prose.

## Invariant-Based Testing

Identify properties that must hold across *all* inputs and states, not just specific cases — then assert them directly instead of enumerating examples.

- Examples: totals sum to 100%, a sorted list stays sorted after any operation, an ID is never reused, a balance never goes negative, output length relates to input length in a fixed way.
- Where the codebase has property-based testing tooling (e.g. fast-check, Hypothesis, QuickCheck-style), prefer generating random inputs and asserting the invariant over hand-picked examples.
- Invariants are especially valuable for catching regressions EP/BVA won't — they don't require guessing which input matters.

## Metamorphic Testing

Useful when there's no single correct output to assert against (ML models, search ranking, non-deterministic pipelines, anything with "close enough" outputs). Instead of checking an absolute answer, check a *relation* between two related inputs and their outputs.

- Example relations: doubling all prices should double the total; reversing input order shouldn't change a sum; adding a no-op filter shouldn't change result count; running twice with the same seed should give identical output.
- Define the relation first, then generate input pairs that should satisfy it — a violation is a bug even without knowing what the "correct" output was.

## Applying these together

For a typical feature: EP + BVA on each input field, state transition testing on any stateful behavior, at least one invariant that should never break, and metamorphic checks only where an absolute oracle isn't available. Don't apply all five reflexively to trivial code — match technique depth to the risk and complexity of what's under test (see the `qa-quality-attributes` skill for weighing risk across quality characteristics, and `qa-triage` for what to do once a technique surfaces a failure).
