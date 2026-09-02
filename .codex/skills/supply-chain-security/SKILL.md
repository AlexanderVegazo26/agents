---
name: supply-chain-security
version: 1.0.0
description: Protecting the software supply chain — build provenance, artifact signing, CI/CD pipeline hardening, and third-party risk beyond direct dependency vulnerabilities. Load when reviewing pipeline security or evaluating risk from build/publish infrastructure.
---

# Supply Chain Security

## Build provenance

Know what produced a given artifact: which commit, which pipeline run, which dependency versions were actually resolved at build time (not just declared in a manifest). Reproducible builds and signed artifacts make tampering detectable.

## Pipeline hardening

CI/CD pipelines are a high-value attack target — a compromised pipeline can inject malicious code into every downstream artifact. Least-privilege credentials for pipeline steps, no long-lived secrets checked into pipeline config, and review changes to pipeline definitions with the same rigor as production code.

## Third-party risk beyond CVEs

A dependency can be compromised without a published CVE yet (typosquatting, maintainer account takeover, a malicious version published to a registry). Pin exact versions via lockfile, verify checksums/signatures where the registry supports them, and be suspicious of a sudden maintainer change or unexplained new maintainer on a critical dependency.

## Transitive risk

Most supply-chain exposure is transitive — a direct dependency's own dependencies, several levels deep. Full dependency-tree auditing (not just direct dependencies) is necessary for anything security- or compliance-sensitive.

## SBOM

For anything with real compliance exposure, maintain a Software Bill of Materials so a newly disclosed vulnerability can be checked against what's actually deployed without re-deriving the dependency tree from scratch.
