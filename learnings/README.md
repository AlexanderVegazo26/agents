# `learnings/` — cross-project heuristics, ratified by a human

One file per concept. Each is a short, actionable note that an agent loads at
task start and names on its `Skills loaded` line, alongside the skills it
already loads.

This directory is the **only** part of the state layer that is committed.
`.claude/runs/` is transient and gitignored; `.claude/memory/<project>/` is
per-project context that never leaves the instance. A learning is the one thing
that crosses from one repository to another, which is exactly why it is the one
thing a human has to merge.

## How a file gets here

```
run ──▶ .claude/runs/<id>/outcome.json     _state.js, in a finally block
            │
            ▼
        distil.py       groups by signature; emits only where the same
            │           signature appears in TWO OR MORE DISTINCT RUNS
            ▼
        redact.py       tier 1 denylist -> dropped
            │           tier 2 regex    -> quarantine, and the job fails
            ▼
   learnings/candidates/       committed to a learnings/* branch
            │
            ▼
      pull request      ── a human merges ──▶  learnings/*.md
```

Nothing in that chain can reach the default branch. The scheduled job only ever
pushes a `learnings/*` branch and opens a pull request; **merge is the
ratification**, and branch protection on the default branch is what makes that
structural rather than a promise the script makes about itself.

## Reviewing a learning pull request

The five questions are in `.github/PULL_REQUEST_TEMPLATE.md` and are not
optional. Question 4 is the one worth restating here, because it is the one that
protects everything else in the repository:

> Does it tell a future agent to look **harder**, never to look **less**? A
> learning that would justify skipping a check is rejected on sight.

`sdlc-suite/skills/project-memory/SKILL.md` already states that rule for memory.
It applies with more force here, because a learning is loaded by agents working
on repositories nobody in this one has seen.

## File format

Front matter in fixed order, then the note, then a single `**Check:**` line.

```markdown
---
id: LRN-0042
title: A collector harness hides the consumer of a callback
kind: failure-signature          # failure-signature | playbook | heuristic | selector-map
appliesTo: [qa-engineer, code-reviewer]
confidence: observed             # observed | corroborated | provisional
firstSeen: 2026-08-14
lastConfirmed: 2026-09-02
signature: 4bb08229233a8ca6
provenance:
  - run: 20260814T090000Z-independent-review-91bc
  - run: 20260902T141500Z-sdlc-feature-a3f1
supersedes: []
---

A test harness that stubs a callback as a sink terminates one hop before
anything the consumer does with it. When a callback gains a consumer, the
harness has to model the consumer too.

**Check:** when reviewing a test for a callback, ask what reads the value after
the stub.
```

`signature` is an **extension** to the format published in the platform review's
Phase 3 contract 5. It is a 16-hex-character digest of the normalised signature
key, and without it neither recurrence nor `supersedes` can be computed from the
file — the contract as published gives a learning no way to be matched back to
the thing that produced it. It leaks nothing: a digest only ever appears on a
candidate whose source text already passed redaction.

`confidence` is set by the distiller from the number of distinct runs: two or
three is `observed`, four or more is `corroborated`. Two runs is never
`corroborated`, and the pull-request checklist asks a reviewer to confirm that.

## Attribution

`provenance` lists the run ids the candidate was derived from — at least two, by
construction. A reviewer can open `.claude/runs/<id>/` in the instance that
produced it and read the outcome for themselves. Attribution lives in the file
rather than in a commit message, so it survives a rebase, a squash, and being
copied into another repository.

## Decay is by recurrence, not by calendar

`lastConfirmed` is stamped by `distil.py --stamp` whenever a signature recurs
across two or more distinct runs. A separate monthly pass runs `--stamp` and
then `--retire`, moving anything unconfirmed for 180 days to `learnings/retired/`
in its own pull request.

Staleness is therefore detected by **absence of recurrence**, not by a date
somebody remembered to update. That only works because the stamp runs first —
`--retire` on its own would retire everything at 180 days regardless of whether
it is still true, which is a calendar policy wearing a recurrence policy's name.

Retirement is a pull request like any other. Nothing is deleted; a retired entry
stays readable under `learnings/retired/` and can be moved back by hand.

## Rollback

Revert the merge commit. Loading is a directory scan with no index and no cache,
so reverting removes the behaviour completely — there is no manifest to
regenerate and no cache to invalidate. That property is the reason the format
deliberately has no generated index.

## Sub-directories

| Path | Committed | Written by |
|---|---|---|
| `learnings/*.md` | yes | a human, by merging a pull request |
| `learnings/candidates/` | yes, on the `learnings/*` branch | `distil.py --emit` |
| `learnings/retired/` | yes | `distil.py --retire` |
| `learnings/quarantine/` | **never** — gitignored | `distil.py --emit`, for anything that matched a redaction class |
| `learnings/.last-distil` | no — gitignored | `distil.py --emit`, only on a clean run |

`learnings/candidates/` has no `.gitkeep`: it is created on demand and is empty
between pull requests, which is the normal state. `learnings/quarantine/` cannot
have a tracked `.gitkeep` at all — git does not descend into an excluded
directory — and that is the right outcome, because a tracked file inside
quarantine would be a foothold for committing quarantined content.

## Running it by hand

```bash
python sdlc-suite/tools/distil.py                 # dry run; writes nothing
python sdlc-suite/tools/distil.py --emit          # write candidates
python sdlc-suite/tools/distil.py --stamp --emit  # recurrence -> lastConfirmed
python sdlc-suite/tools/distil.py --retire --emit # 180-day sweep
python sdlc-suite/tools/redact.py --selftest      # is the filter alive?
python sdlc-suite/tools/test_redact.py            # the fixture suite
```

Exit codes matter more than output here, and the two tools do not share a scale:

| Code | `distil.py` | `redact.py` |
|---|---|---|
| 0 | ok — candidates written, or none met the floor | selftest passed / input publishable |
| 1 | something was **quarantined**; a human must read it | selftest failed / input quarantined |
| 2 | something was **dropped** on a denylist hit | input dropped on a denylist hit |
| 3 | the redactor is unavailable or failed its self-test — nothing ran | path not found |
| 4 | usage or environment error | — |

Zero candidates exits 0 and is the normal outcome. A distiller that always
produces something produces noise, the pull requests stop being read, and the
human gate becomes decorative.

## Before the first run

Copy `redaction/denylist.example.txt` to `redaction/denylist.txt` and fill it
in with your organisations, unreleased project codenames, customers and hosts.
The file is gitignored because the list itself is instance data. Without it tier
1 is inert — `distil.py` says so loudly on every run rather than letting silence
read as "clean".
