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
  the distiller **refuses to start** — in every mode — when the redactor cannot
  be imported or fails its self-test, rather than degrading to no filtering. A
  redactor that imports cleanly but matches nothing is the more dangerous
  failure, because it is silent, so `redact.selftest()` drives one known
  positive through every class and a zero result is never trusted on its own.
- A candidate matching `redaction/denylist.txt` — instance data, gitignored — is
  **dropped** and nothing is written, not even to quarantine. Tier 1 is checked
  before tier 2 and wins outright: a string the adopter has declared private
  must not sit in a holding pen waiting to be rewritten.
- A candidate matching a compiled regex class (absolute home paths, email
  addresses, private IPs, internal hostnames, ticket identifiers, high-entropy
  tokens) goes to `learnings/quarantine/`, which is gitignored and never
  committed, and the job then **fails**. Uncertain is not published, and it is
  not silently discarded either.
- Both outcomes exit non-zero and stop the job before a branch exists:
  `1` quarantined, `2` dropped, `3` redactor unavailable. The distinct codes let
  the workflow say which happened.
- Only *derived* text is scanned — the fields carrying reasoning that came out
  of a run. The distiller's own identifiers (`id`, `provenance`, `signature`,
  dates, `kind`) are validated against an **allowlist of shapes** instead, and
  anything unexpected fails closed into quarantine. Scanning them would be
  self-defeating: `LRN-0042` matches the ticket-id class and a run id matches
  the high-entropy class, so every candidate would quarantine forever, which is
  exactly the pressure to loosen a pattern that this design forbids.
- Nothing ever echoes a match. Reasons carry the class, the field and a
  character count; a denylist hit is reported by its **index** in the file, not
  its value. The job log is public, so a summary reading `matched
  alice@customer.example` would make the redactor itself the leak. For the same
  reason `learnings/quarantine/` is never uploaded as a workflow artifact —
  artifacts on a public repository are publicly downloadable — and quarantine
  filenames are digests rather than derived text.
- Promotion is by pull request only. Nothing in the loop can reach the default
  branch; merge is the human ratification. `.github/workflows/distil.yml` stages
  exactly `learnings/candidates/` and fails if anything else is staged;
  `decay.yml` stages exactly `learnings/`.
- `distil.yml` runs an independent `gitleaks` scan over the candidates before
  pushing. That is not redundancy for its own sake: a push made with the
  automatic `GITHUB_TOKEN` does not trigger `ci.yml`, so the one pull request
  that most needs the secret scan would otherwise not get one. It shares no code
  with `redact.py`, so a defect in the redactor cannot disable both.

Three limits of this, stated rather than implied:

- Both workflows are **`workflow_dispatch` only**. There is no `schedule:`; the
  cron is present as a commented block naming its two preconditions — branch
  protection on the default branch, and a month of real run data. Until branch
  protection exists, "cannot reach the default branch" is a property of the
  workflow files' own behaviour, and those files are editable by anyone who can
  open a pull request. Protection is not editable by this token, which is the
  whole difference.
- **Tier 1 is inert on a hosted runner.** `redaction/denylist.txt` is gitignored,
  so a fresh checkout does not have it and only the compiled regex classes are
  in force. The distiller says so loudly on every run rather than letting
  silence read as "clean". Materialising the list from a repository secret would
  close it, and is the repository owner's decision, not the tool's.
- `.claude/runs/` is gitignored too, so on a hosted runner there are **zero
  outcomes to read** and the job exits 0 with "no candidates" until a run-data
  source exists. No artifact-upload step papers over that, because run records
  are private-repository derivatives and uploading them to a public repository's
  artifact store would be the exfiltration path this all exists to close.

The evidence that any of this works is `sdlc-suite/tools/test_redact.py`, which
runs before the distiller on every invocation. Each control in it was shown to
go red when that control alone was removed; a fixture suite for a filter that has
only ever been observed green is indistinguishable from one that asserts nothing.

If you find a way past any of those, that is in scope and worth reporting.

## Response

Acknowledgement within 7 days; a fix or a documented mitigation within 30.
