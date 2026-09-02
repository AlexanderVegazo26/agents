---
name: threat-modeling
version: 1.0.0
description: STRIDE-based threat modeling method for identifying attack surface, trust boundaries, and abuse cases before or during implementation. Load before implementing anything touching authentication, sensitive data, or trust boundaries.
---

# Threat Modeling

## Method (STRIDE)

For each component and each trust-boundary crossing, ask whether it's vulnerable to:

- **Spoofing** — can an actor pretend to be someone/something they're not?
- **Tampering** — can data be modified in transit or at rest without detection?
- **Repudiation** — can an actor deny having performed an action, with no audit trail to contradict them?
- **Information disclosure** — can data be exposed to someone who shouldn't see it?
- **Denial of service** — can an actor degrade or block availability for legitimate users?
- **Elevation of privilege** — can an actor gain access/capability beyond what they're authorized for?

## Process

1. Diagram the system: components, data flows, and every trust boundary (client↔server, service↔service, service↔datastore, internal↔external).
2. Walk each boundary crossing against STRIDE; for anything plausible, note the mitigation already in place or missing.
3. Rank by exploitability × impact, not by an abstract severity label alone — classify each finding Critical / High / Medium / Low / Informational, and never invent a finding with no plausible attack path or realistic condition just to look thorough.
4. Feed findings back to `solution-architect`/`software-engineer` before implementation, not as a post-hoc audit.

This is `security-engineer`'s primary technique (§3.1 of that agent) for Tier 3 or significant new designs — the agent doing the threat model documents risk and mitigation options but doesn't accept risk on anyone else's behalf; acceptance is the owning human's or `release-manager`'s call.

## Abuse-case thinking

Beyond STRIDE's structural lens, explicitly imagine a motivated attacker: what would they try first, what's the highest-value target in this design, what happens if a "trusted" internal service is actually compromised (assume breach, not just assume the perimeter holds).

## Output

A threat model is a living artifact tied to the design it describes — revisit it when the design changes materially, don't treat it as a one-time exercise that's valid forever.
