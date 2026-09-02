---
name: governance
version: 1.0.0
description: Decision rights, approval thresholds, and accountability structure for engineering/product decisions — who decides what, and what needs sign-off vs. what doesn't. Load when a decision's ownership is unclear, or when defining approval gates for a class of change.
---

# Governance

## Decision rights over process for its own sake

Governance exists to make clear who has authority to decide what, and to keep high-blast-radius decisions from being made unilaterally without the accountable party's input — not to add ceremony to every decision regardless of stakes.

## Matching process weight to blast radius

A copy change needs no governance beyond normal review; a schema migration touching money, a new external dependency with a data-processing agreement implication, or an architecture change affecting multiple teams needs explicit sign-off from whoever's accountable for that risk. Scale the approval requirement to the actual risk, not to a fixed process applied uniformly.

## Explicit accountability

For any gate, name who is actually accountable for the decision, not just who's "in the loop." A decision with no accountable owner tends to get made by whoever's most confident in the room, which isn't the same as whoever should decide.

## Risk acceptance

When a gate is overridden (shipping despite an open finding, an accepted deviation from architecture), record who accepted the risk and why — this is what turns "we knew and decided" into something distinguishable from "no one checked."

## Avoiding governance theater

A gate that's always rubber-stamped isn't governance, it's a delay with no signal. Periodically check whether existing approval gates are actually catching anything — if not, either the gate is miscalibrated or the risk it guards against has changed.
