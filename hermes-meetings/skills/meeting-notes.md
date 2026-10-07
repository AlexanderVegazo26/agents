---
name: meeting-notes
description: Turn a completed meeting transcript into structured, durable notes: summary, decisions, action items with owners, open questions. Used by the meeting-notes webhook route.
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [meetings, notes, memory]
    related_skills: [meeting-bot-ops, meeting-live-questions]
---

# Meeting Notes

A meeting Hermes attended has ended. Turn the transcript into notes that
compound instead of a wall of text.

## Input

The webhook payload carries:

- `meeting_id`, `platform`, `started_at`, `completed_at` — meeting identity
- `transcript_file` — path to the full transcript Markdown
  (`~/.hermes/data/vexa-transcripts/<meeting_id>.md`); read it with read_file.
- `notes_target` — the Markdown file to write the notes to
  (`~/.hermes/data/vexa-notes/<meeting_id>.md`); create parent dirs as needed.

## Structure of the notes file

```markdown
# <Meeting name or platform + meeting_id + date>

**Attended by Hermes (Vexa bot).** <duration in minutes>, <n> speakers.

## Summary
3-6 sentences. What the meeting was about and where it landed.

## Decisions
- <decision> — <who decided / on what basis, if in transcript>

## Action items
- [ ] <action> — owner: <name or "unassigned">, by <date if stated>

## Open questions
- <question> — raised by <speaker if known>

## Notes by topic
<2-4 topic sections with 1-3 bullet points each, only for substantive topics>
```

## Rules

1. Never invent owners, dates, or decisions. Mark missing ones
   `owner: unassigned` rather than guessing.
2. Speaker attribution: use names as the transcript gives them; do not guess
   identities.
3. Write the notes file first, then reply with a compact summary (the
   decisions + action items) — the reply is what gets delivered to the user.
4. After writing notes, if the `bm` CLI is available
   (`bm tool write-note`), record one line in Basic Memory linking the notes
   file, e.g. `[meeting] <platform> <meeting_id> notes at
   ~/.hermes/data/vexa-notes/<meeting_id>.md #meeting`. Skip silently if `bm`
   is missing.
5. Do not delete the transcript file; it is the source of truth.
