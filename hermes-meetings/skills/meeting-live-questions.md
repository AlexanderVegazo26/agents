---
name: meeting-live-questions
description: Generate sharp, well-timed questions from a live meeting transcript delta while a meeting is running. Used by the meeting-live-questions webhook route.
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [meetings, questions, realtime]
    related_skills: [meeting-bot-ops, meeting-notes]
---

# Live Meeting Questions

You are receiving a delta of fresh transcript from a meeting Hermes is
attending via the Vexa bot. Produce questions the user could ask *now* —
before the moment passes.

## Input

The webhook payload carries:

- `meeting_id`, `platform`, `bot_name` — which meeting this is
- `new_text` — the newly transcribed text since the last check
- `meeting_file` — path to the full running transcript Markdown
  (`~/.hermes/data/vexa-transcripts/<meeting_id>.md`); read it with read_file
  if you need more context than the delta.

## Rules

1. **Read the delta first, then decide.** If the new text is greetings,
   logistics, or small talk, answer with exactly `NO_QUESTIONS` and nothing
   else — noise drowns the good questions.
2. Ask questions that are **useful now**: clarifications of ambiguous
   statements, decision points that are being skipped, commitments that need
   owners, contradictions with something said earlier in the meeting file.
   No generic icebreakers, no questions Google could answer.
3. **Voice.** Match Hermes's persona (SOUL.md): direct, no filler, no
   "Great question!" style padding. One question per line, each complete and
   speakable aloud.
4. **Throttle.** At most 3 questions per delivery. If the last delivery
   (same meeting) also produced questions, prefer 1-2 of the strongest over
   three new ones unless the topic changed completely.
5. If you cannot tell what is being discussed, say so in one line instead of
   guessing.
6. Never fabricate content that is not in the transcript; attribute speakers
   when the transcript does.

## Output format

Plain text, no markdown headers:

```
Q: <question one>
Q: <question two>
```

or exactly `NO_QUESTIONS`.

Deliver the questions to the user; if you are running as a webhook-triggered
turn, your reply is the delivered message — do not call extra tools beyond
reading the meeting file when needed.
