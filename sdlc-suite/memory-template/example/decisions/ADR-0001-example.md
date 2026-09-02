# ADR-0001 — Example: choosing a queue for deferred exports

- Date: 2026-01-15
- Status: Accepted
- Owner: solution-architect
- Tier: 2 (new runtime dependency, no new trust boundary)
- Supersedes: none. Amend by superseding, never edit in place.

> **This file is a worked example, not a real decision.** It exists so an adopter
> can see the shape of an ADR this suite expects before writing their first one.
> The header fields above are the part that matters: date, status, owner, tier,
> and the supersession rule. Delete this directory once you have real records.

## Context

Report exports run inside the request handler. At the 95th percentile they exceed
the 30-second gateway timeout, and the client sees a 504 while the export keeps
running server-side and eventually writes a file nobody is waiting for.

### Evidence gathered (probed, not recalled)

State what you measured, where, and when — not what you remember or expect. An
ADR that cites a number without saying how it was obtained is an assertion, and
`engineering-integrity` treats an unsourced assertion as unverified.

1. **Measured on the staging replica, 2026-01-12, 400 exports sampled.** p50 4.1 s,
   p95 41.7 s, p99 96.2 s. The gateway timeout is 30 s and is not configurable
   by this team.
2. **Two of three candidate libraries were rejected on evidence, not preference.**
   One has had no release in 26 months and 41 open issues; one requires a broker
   this deployment does not run. Record the rejected options — a future reader
   needs to know they were considered, or they will reconsider them.
3. **Licence checked** for the surviving candidate: permissive, compatible with
   this project's distribution terms.

## Decision

Move exports to a durable job queue backed by the database already in use, rather
than introducing a broker. The request handler enqueues and returns `202` with a
poll URL; a worker process drains the queue.

State the decision in one sentence, then the constraint that forced it. Here the
constraint is that adding a broker would be a new operational dependency and a
new trust boundary — a Tier 3 change — where the queue-in-the-existing-database
option stays Tier 2.

## Consequences

Both directions, honestly. An ADR listing only benefits is a proposal, not a record.

- The client contract changes: callers must poll. This is a breaking change for
  the two existing consumers and needs the versioning path in `api-versioning`.
- One new runtime dependency, which fires the `security-engineer` trigger in the
  routing policy. That review is a prerequisite, not a follow-up.
- Exports become observable: queue depth and job age are now SLIs.
- The database takes write load it did not have. Re-measure at 10× current volume
  before assuming this holds — this decision is scoped to the measured range above.

## What would make us revisit this

Name the falsifier. A decision with no stated falsifier cannot be shown to have
expired, so it gets carried forward long after it stopped being true.

- Queue depth sustained above 500 jobs, or job age p95 above 5 minutes.
- A second service needing the same queue, which is the point where a shared
  broker starts costing less than the coupling it removes.
