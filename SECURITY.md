# Security policy

## Reporting

Report suspected vulnerabilities through GitHub's private vulnerability reporting
on this repository. Do not open a public issue.

## Scope

This repository ships agent definitions, skills and orchestration scripts. It
requests no credentials and contacts no network service. The realistic risk
classes are: a prompt that causes an agent to exfiltrate repository contents,
an orchestration script that executes untrusted input, and a learning artifact
that carries data from one adopter's repository into a published file.

### Learning artifacts specifically

`sdlc-suite/tools/distil.py` derives files under `learnings/` from run outcomes
produced against whatever repository the suite was run in. That is a data path
from a private tree to a public one, so it is gated:

- `sdlc-suite/tools/redact.py` runs inline before any candidate is written, and
  the distiller refuses to run when the redactor is unavailable rather than
  degrading to no filtering.
- A candidate matching `redaction/denylist.txt` — instance data, gitignored — is
  **dropped**.
- A candidate matching a compiled regex class (absolute home paths, email
  addresses, private IPs, internal hostnames, ticket identifiers, high-entropy
  tokens) goes to `learnings/quarantine/`, which is gitignored and never
  committed, and the job then **fails**. Uncertain is not published, and it is
  not silently discarded either.
- Promotion is by pull request only. Nothing in the loop can reach the default
  branch; merge is the human ratification.

If you find a way past any of those, that is in scope and worth reporting.

## Response

Acknowledgement within 7 days; a fix or a documented mitigation within 30.
