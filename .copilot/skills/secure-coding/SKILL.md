---
name: secure-coding
description: OWASP-class secure coding practices — input validation, output encoding, auth/authz patterns, and common vulnerability classes to check for in any code touching user input or sensitive operations. Load when writing or reviewing code that handles input, auth, or sensitive data.
---

# Secure Coding

## Input validation

Validate at every trust boundary, not just at the edge — a value that was validated by the client can't be trusted by the server. Validate type, range, format, and length; reject unexpected input rather than trying to sanitize it into something safe.

## Output encoding

Encode for the context the output lands in (HTML, SQL, shell, URL) — encoding for the wrong context is a common source of injection bugs. Use parameterized queries for anything database-bound; never string-concatenate untrusted input into a query, command, or template.

## AuthN/AuthZ

Check authorization on every path that touches protected data or actions — not just the primary entry point (a secondary API route, an export function, a background job) each need their own check, since a missing check anywhere is a full bypass. Prefer deny-by-default.

## Secrets

Never hardcode secrets or log them, even at debug level. Use the project's actual secrets-management mechanism; rotate on a defined schedule; scope access to the minimum needed.

## Common vulnerability classes to actively check for

Injection (SQL, command, template, LDAP), broken access control, cryptographic failures (weak/missing encryption, insecure randomness), insecure deserialization, SSRF, XXE, and — for anything multi-tenant — cross-tenant data leakage via a missing or misapplied tenant filter.

## Dependency awareness

A vulnerability in a dependency is your vulnerability once it's in production — see `dependency-health` and `supply-chain-security` for the audit side of this.
