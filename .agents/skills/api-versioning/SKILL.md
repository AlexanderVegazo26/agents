---
name: api-versioning
description: Strategies for versioning an API contract as it evolves — when a change is breaking, versioning schemes, and sunset policy for old versions. Load when an API change might affect existing consumers. Do NOT use for designing the contract's shape in the first place (that is `api-design`) or for non-API compatibility such as data formats, config, and CLI behavior (that is `backward-compatibility`).
---

# API Versioning

## What counts as a breaking change

Removing or renaming a field, changing a field's type or meaning, changing required-ness from optional to required, changing error codes/shapes, or changing behavior a consumer could reasonably have depended on — even if not explicitly documented. Adding a new optional field or a new endpoint is additive, not breaking.

## Versioning schemes

Common approaches: URL path version (`/v2/...`), header-based version, or a schema/field-level version marker. Pick one and apply it consistently across the whole API — mixing schemes across endpoints of the same API confuses every consumer. Match to what the project already does (see `qa-tooling`'s stack-detection principle) rather than introducing a second scheme.

## Supporting multiple versions

State how long an old version is supported before sunset, and communicate that timeline to consumers well ahead of the actual cutoff — a sunset with no warning is effectively a breaking change with no notice.

## Internal vs. external APIs

Internal service-to-service APIs can sometimes tolerate a coordinated simultaneous upgrade (deploy both sides together) that an external public API never can — know which kind you're versioning before choosing how strict to be.

## Contract testing

Verify both directions: a new consumer against the old producer, and existing consumers against the new producer, for anything spanning a version boundary — see `qa-tooling`'s contract-testing checklist.
