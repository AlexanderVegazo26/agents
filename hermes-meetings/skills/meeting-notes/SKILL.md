---
name: meeting-notes
description: "Notes, decisions and actions from a call transcript. Turn a completed call transcript into structured notes (summary, decisions, action items with owners, open questions, follow-up draft) and update long-term memory. Use after a meeting ends or when the user asks for notes or a recap of a call."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [meetings, calls, notes, memory, follow-up]
    related_skills: [meeting-bot-ops, meeting-briefing, meeting-live-questions]
---

# Meeting Notes

A call Hermes attended has ended. Produce notes the user can act on in two
minutes, and leave memory richer for the next call with the same people.

## Input

From the webhook payload, when present:

- `meeting_id`, `platform`, `started_at`, `completed_at`
- `transcript_file` — `~/.hermes/data/vexa-transcripts/<meeting_id>.md`
- `notes_target` — `~/.hermes/data/vexa-notes/<meeting_id>.md`

Invoked by hand, or `transcript_file` missing: find the meeting with
`mcp__vexa__list_meetings` (newest first, or match the name the user gave),
pull `mcp__vexa__get_meeting_transcript`, and use
`~/.hermes/data/vexa-notes/<platform>-<native_meeting_id>.md` as the target.
Create parent dirs as needed.

## Procedure

1. **Gather evidence.**
   - Transcript (source of truth). Note its quality: duration, speaker count,
     stretches with empty speakers or obvious mis-transcription.
   - `mcp__vexa__get_meeting_chat` — links, spelled names, numbers typed in
     chat beat what whisper heard.
   - The pre-call briefing, if any (meeting `briefing` metadata or
     `~/.hermes/data/meeting-briefings/`): it states the user's goal for the
     call. Judge the outcome against it.
   - Prior context: `bm tool search-notes "<counterpart or company>"` for
     earlier calls — so "last time they promised X" can be checked.
2. **Classify before writing.** Keep separate: decisions actually made ·
   proposals not decided · commitments (who will do what) · open questions ·
   risks/objections · key facts and numbers. Brainstorming is not a decision.
   Each item needs a supporting moment in the transcript (timestamp).
3. **Write the notes file** (structure below), in the language the meeting
   was held in.
4. **Update memory** (skip any step whose tool is missing, silently):
   - Basic Memory: for each external person with a name, edit or create
     `people/<Name>` with `- [meeting] <date> <topic>: <one-line outcome> #meeting`
     and `- notes_at [[...]]`/path; one line in `projects/` if a project was
     discussed. Search first; never duplicate a note.
   - Graphiti: a 3–5 sentence summary (who, what was agreed, who owes what,
     by when) that starts with the meeting date. Prefer the MCP
     `add_memory` with `reference_time` = meeting start; the CLI fallback
     `graph add "<text>" --name "meeting <date> <title>"` has no time flag.
5. **Reply** with the compact version (format below) — that reply is what
   the user receives.

## Notes file structure

```markdown
# <Title> — <YYYY-MM-DD>

**Attended by Hermes (Vexa bot).** <N> min · <n> speakers · <platform>
Transcript quality: <good | partial — reason>

## Outcome
2–4 sentences: what it was about, where it landed, and whether the user's
goal (from the briefing) was met.

## Decisions
- <decision> — <who / basis> [mm:ss]

## Action items
- [ ] <concrete outcome> — owner: <name | unassigned>, due: <date | unstated> [mm:ss]

## Open questions & risks
- <question or risk> — raised by <speaker | unknown> [mm:ss]

## Key facts & numbers
- <budget, dates, volumes, names, tools mentioned> [mm:ss]  (`(?)` if unsure)

## Notes by topic
<2–4 substantive topics, 1–3 bullets each>

## Follow-up draft
<A short email/message the user could send: thanks, agreed points, owners
and dates, next step. Only claims backed by the transcript.>
```

## Reply format (Telegram)

```
📝 <Title> · <date>
Outcome: <one line>
✅ Decisions: <bullets, max 4>
📌 Yours: <user's action items with dues>   👥 Theirs: <their items>
❓ Open: <max 2>
Notes: <path>   (follow-up draft inside)
```

## Rules

- Never invent owners, dates, numbers or decisions. Missing → `unassigned`
  / `unstated`. Inferences labelled `Inference:`.
- The follow-up is a draft. Sending it, or any message to the other side,
  needs the user's approval on Telegram (`~/.hermes/goals/_policy.md`).
- Use names exactly as the transcript or chat gives them; never guess who an
  empty speaker is.
- Distinguish the user's commitments from the other side's — that split is
  what the user acts on.
- Do not delete or edit the transcript. Never store secrets in memory.
