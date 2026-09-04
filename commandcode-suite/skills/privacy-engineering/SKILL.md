---
name: privacy-engineering
version: 1.0.0
description: Privacy-by-design practices — data minimization, PII classification, retention/deletion, and consent handling. Load when a design or change touches personal data, before implementation.
---

# Privacy Engineering

## Data minimization

Collect and retain only what's actually needed for the stated purpose. Every field of personal data collected is future liability — question each one at design time, not after a breach.

## PII classification

Classify data by sensitivity (public, internal, PII, sensitive PII/special category) at design time so handling requirements (encryption, access control, retention) are clear before storage decisions are made, not retrofitted.

## Retention and deletion

Define a retention period per data category and enforce it — data kept "just in case" past its useful/legal life is pure downside risk. Verify deletion is actually complete, including backups, caches, logs, and downstream/derived copies, not just the primary record — a "deleted" user who still appears in an analytics export or a log line hasn't actually been deleted.

## Consent and purpose limitation

Data collected for one stated purpose shouldn't silently be reused for another without new consent or a lawful basis — this is both a compliance and a trust issue.

## Access and audit

Log who accessed sensitive data and when, at a level that supports an actual audit, without itself logging the sensitive data into the audit trail.

## Cross-reference

Regulatory specifics (GDPR/CCPA/HIPAA-class regimes) live in `sdlc-suite:compliance` — this skill is the engineering practice that makes compliance achievable rather than a policy no one can actually implement.
