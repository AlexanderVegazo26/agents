---
name: configuration-management
version: 1.0.0
description: Managing environment-specific configuration safely — separation from code, secrets handling, and validation to prevent misconfiguration-caused incidents. Load when adding or changing configuration, or reviewing config-related risk.
---

# Configuration Management

## Separate config from code

Environment-specific values (URLs, feature toggles, resource limits, credentials) live in configuration, not hardcoded — but configuration itself lives in version control (except secrets) so changes are reviewable and auditable, not applied ad hoc against a running environment.

## Secrets are not configuration

Never store a secret in the same place as non-sensitive config, even if the mechanism technically allows it. Use the project's actual secrets manager; reference by name/path, not by value, in checked-in config.

## Validation

Validate configuration at startup, failing loudly if something required is missing or malformed — a service that starts successfully with bad config and fails mysteriously later is much harder to diagnose than one that refuses to start.

## Defaults

A missing optional config value should have a safe, explicit default — never an implicit fallback that silently changes behavior. Document what each config value controls and its valid range.

## Environment parity

Keep the same config *keys* across environments even when values differ — a key that only exists in production is a landmine for the next environment promotion.

## Change review

Configuration changes that affect production behavior (feature toggles, resource limits, timeouts) deserve the same review rigor as a code change — a bad config value has caused outages just as real as a bad deploy.
