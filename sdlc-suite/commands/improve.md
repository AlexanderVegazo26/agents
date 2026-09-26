---
description: Propose faster ways of running the suite from the evidence of this repository's recorded runs — bottleneck phases, habitual retries, repair loops that keep exhausting, gates that block every run
argument-hint: [none]
---

Run the tool directly. It is a plain Python script, not a `Workflow`: it reads
`.claude/runs/` and writes nothing unless `--out` is given.

```
python "${CLAUDE_PLUGIN_ROOT}/tools/improve.py" --root .
```

Relay every proposal verbatim — its evidence, the proposed change, what it saves
and the runs it came from — and say plainly that each one is for a human to
decide. Do not enact any of them yourself: a prompt change goes through the same
review as any other change, and a standing authorization in
`.claude/autonomy.json` is a human's call by construction.

The tool never proposes less checking, and neither do you. If a proposal seems to
call for skipping a lens or lowering a review's effort, that is a misreading:
report it as such rather than acting on it.

If there are no recorded runs, say so — "no proposal" from zero runs means the
suite has not been run through its workflows here yet, not that it is efficient.
