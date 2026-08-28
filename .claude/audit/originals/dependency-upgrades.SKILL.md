---
name: dependency-upgrades
description: Safely upgrading a dependency or runtime version — reading changelogs for breaking changes, testing strategy for the upgrade, and handling major version jumps. Load when planning or performing a dependency/runtime version bump.
---

# Dependency Upgrades

## Prefer frequent small upgrades

A steady cadence of small version bumps is far safer than a rare large jump — small bumps bundle fewer breaking changes together, so if something regresses, it's much easier to isolate which change caused it.

## Before upgrading

Read the changelog/release notes for the actual version range being crossed, not just the latest entry — a multi-version jump can cross several breaking changes that only show up in the cumulative changelog. Never bump a major version purely because a bot opened a PR without reading what changed.

## Testing the upgrade

Run the full existing test suite plus any manual smoke test of the areas most likely affected by the changelog's breaking-change notes — an upgrade that passes CI but wasn't checked against the specific behavior that changed is a false sense of safety.

## Major version jumps

Budget real time for a major jump — deprecated API removal, changed defaults, and altered error behavior are common. Consider an intermediate version stop if the changelog shows a cleaner deprecation path through it, rather than jumping straight to the newest major.

## Runtime/language version upgrades

Treat with the same rigor as a dependency upgrade but broader blast radius — check for behavior changes in the standard library and language semantics, not just third-party packages, and validate on the actual deployment target, not just a local dev environment.
