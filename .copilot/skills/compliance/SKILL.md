---
name: compliance
description: Recognizing when a regulatory or contractual regime applies (GDPR/HIPAA/PCI/SOC2-class) and what that implies for a design or review. Load when a project touches regulated data or industries, or when a requirement is silent on an applicable regime.
---

# Compliance

## Detect, don't assume

Determine which regimes actually apply to this project by inspecting its actual domain, data classification, and existing controls — never assume a regime applies (or doesn't) because a different project had one. Common triggers: health data (HIPAA-class), payment card data (PCI-DSS), EU/UK personal data (GDPR-class), children's data (COPPA-class), financial services (SOX/relevant regional regimes), enterprise SaaS with customer audit requirements (SOC 2).

## What compliance implies for engineering

Audit trails for access to regulated data; defined retention and deletion (see `privacy-engineering`); access controls proportionate to data sensitivity; documented data flows showing where regulated data travels (including third parties/subprocessors); breach notification readiness.

## Flagging gaps

If a requirement is silent on an applicable regime, that's a gap to surface explicitly — not something to quietly assume someone else handles. State which regime plausibly applies and what's currently unaddressed.

## Not a substitute for legal review

Engineering-level compliance review identifies technical gaps; it doesn't replace an actual legal/compliance function's sign-off on regulatory interpretation. Flag ambiguity in *how* a regime applies to legal/compliance stakeholders rather than resolving it unilaterally.
