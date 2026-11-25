---
name: social-video-edit
version: 1.0.0
description: Turn recorded footage into a high-impact social video with HyperFrames — a hook in the first 3 seconds, tight cuts, animated word-highlight captions, purposeful motion graphics, a clean audio mix and a 9:16 export — as an editable composition plus a rendered file. Load when someone wants recorded footage edited like a professional social clip, reel or Short with motion graphics, or wants to recreate the style of a reference video. Do NOT use for plain cleanup with no graphics (that is `sdlc-suite:video-editing`), for fully generated animation with no footage (that is `sdlc-suite:motion-graphics`), or for in-product UI motion.
---

# Social video edit (footage + motion graphics, in HyperFrames)

Act as a professional video editor, creative director and motion designer for
short-form content. Keep the speaker's message; change rhythm, narrative,
clarity and visual appeal. Every cut, effect and graphic needs a narrative
purpose. The result must look like an edit, not a slide deck.

This skill is the recipe. The mechanics live elsewhere, so load them rather than
restate them:

- `sdlc-suite:video-editing` for probing, transcription, the edit decision list
  (EDL), silence/filler cuts, loudness and validation. Its rules about untrusted
  file names, transcript text and media in ffmpeg commands apply here unchanged.
- `sdlc-suite:motion-graphics` for direction, timing, safe areas and QA of the
  graphics layer.
- The HyperFrames skills and CLI for the composition itself (see §7).

## 1. Brief first (state it like a spec, then build it)

Write these down before touching footage. Anything the user did not say becomes a
numbered assumption in the report:

| Field | Default |
|---|---|
| Destination and frame | 9:16, 1080x1920, subtitles burned in |
| Length | as the story needs; up to 60 s for Shorts, Reels and TikTok |
| Language | the footage's language, for captions and on-screen text |
| Visual style | clean, cinematic, high contrast, one sans-serif family, one palette |
| Music | none unless it helps; ask before using paid or licensed tracks |
| Reference video | none; if given, analyse it first (§2) |

## 2. Analyse before editing

1. Probe the source; transcribe with word timestamps (`sdlc-suite:video-editing` §3).
   Transcription rules reported by the earlier Hermes reel-editor skill (not re-measured here): use a medium
   or larger model (a `small` one invented whole sentences with full confidence),
   always pass the language (otherwise it may translate), and fix brand names and
   numbers through a correction map applied on every run, not by hand-editing the
   JSON, which the next run overwrites.
   Prep rules: do not speed the clip up (if asked, apply video and audio in one
   pass and re-transcribe); if the take has no gap over 0.4 s it is already
   edited, so skip silence cutting rather than add a compression generation; with
   OBS recordings check the duplicate audio tracks and prefer a sibling clean mic
   file; make a 30 fps constant-frame-rate master before measuring.
2. **Measure the frame before designing anything.** Extract shot changes and a
   contact strip, find the face box, and classify each span: to camera (graphics
   go below the chin, nothing crosses the face), screen capture (use the empty
   band; the footage is the infographic), split screen (graphics live on the
   seam). Record the free zones in pixels at native resolution and design inside
   them. House rule: if the speaker did not say it and you did not measure it, it
   does not go on screen.
3. Read the whole transcript. Decide the one message, what is filler, what is the
   strongest line (the hook candidate) and the payoff.
4. If the user supplied a reference video or link, have a model watch it
   (the `watch-video` skill, if installed): scene by scene, cut rhythm, caption
   style, on-screen text. Save the findings as `REFERENCE-ANALYSIS.md` with
   timestamps. Borrow mechanisms (rhythm, caption treatment, structure), never
   branded copy, logos or likenesses. Do not claim to have heard audio you only
   read as a waveform.
5. Say what the footage needs, in a few lines, before executing.

## 3. Story structure

Build from what the speaker actually says. Never invent claims or change meaning.

1. **Hook (0-3 s).** A question, bold claim or open loop that makes a viewer need
   the answer. It must work with the sound off, say what the video is about, and
   not promise more than the footage delivers. Draft three different openings from
   the same truthful speech and pick one with a stated reason.
2. **Context.** The topic, fast.
3. **Development.** Clear blocks, each visually distinct. One idea per block.
4. **Key moments.** Emphasise conclusions, numbers and the most quotable lines.
5. **Close.** A clear conclusion or a fitting call to action. Close what the hook
   opened before the call to action. Do not tack on a long outro to a short.

## 4. Cut and rhythm

- Remove silences, long pauses, repetitions, false starts and tangents; keep
  breaths at joins and any pause the speaker used on purpose.
- Cut on the voice and on topic changes; vary framing (punch-in, reframe, B-roll)
  to hold attention. Every punch-in or insert needs a reason.
- Mid-piece, introduce something new about every 0.3-0.6 s of a dense passage and
  leave no dead air over a second, but give a one-second breather after roughly
  every 7-8 s of density. Rhythm varies: burst, anticipation, reveal, rest.
- Avoid excessive transitions. A transition either hides a cut or marks a topic
  change. Never pair a hard fade with kinetic content.
- Lock the cut (rough animatic) before polishing graphics. Cutting after
  captioning leaves stale timings.

## 5. Captions

- Word-synced to the audio, grouped into short phrases of a few words, one to two
  lines, at a size readable on a phone.
- High-contrast modern sans-serif; highlight keywords by colour, weight or a small
  animation; one highlight treatment, used consistently.
- Inside platform safe zones (keep clear of the bottom UI band and the right
  action rail on vertical formats). Never cover a face or the key graphic.
- Fix transcription errors without changing what is communicated; names, numbers
  and brand spellings are checked against the source.
- Captions and impacts land within 2 frames of the word's onset (a deliberate
  anticipation of at most 0.15 s is allowed). Bind graphics to the spoken noun,
  not to an index-based stagger.

## 6. Motion graphics

- Short titles to introduce concepts; numbers, icons, charts and indicators that
  show evidence or consequence. A graphic that repeats the narration word for word
  is clutter.
- Entrances and exits are smooth with natural acceleration and deceleration.
  Typical durations: enter 0.2-0.5 s (`power2.out`), exit 0.2-0.33 s
  (`power2.in`), a whip or push transition 0.3-0.4 s, a headline held 1-1.5 s
  after it fully reveals. Declare ease and duration on every tween.
- Subtle zooms and simulated camera moves; keep the camera or background alive so
  frames do not read as dead.
- One visual identity: a single palette in which each colour carries one meaning
  (for example one for problem, one for solution), one type family, reused
  components. Remove any colour that carries no meaning.
- Leave breathing room: a hierarchy of title, caption and secondary element, and a
  frame that is never overloaded.
- **Privacy.** If a screen is visible, assume something private is (emails, client
  names, rates, paths, tokens). Cover it with blur, not opaque boxes: the blur
  hides the text and keeps the motion, which is often the demo. Measure at native
  resolution, pad the box about 26 px past the text, anchor-and-grow on handheld
  footage instead of interpolating position, and sweep the full frame for fast
  scrolls.
- Brand marks only from supplied or official assets, with their source recorded.
  Never redraw or approximate a logo; use plain brand-name text if none is
  verified. A real person needs a verified, attributable picture; a generated
  likeness is never presented as authentic.

## 7. Implement in HyperFrames (no invented APIs)

1. **Probe, do not assume.** Check that HyperFrames is usable here (`npx hyperframes
   --help` or the installed skills `hyperframes`, `hyperframes-core`,
   `hyperframes-cli`). If it is not installed, say so and ask before installing.
   Use only commands, `data-*` attributes and components the installed version
   documents (`hyperframes docs`, `lint`, `check`). When a feature is missing, use
   a documented alternative and note it.
2. **Structure.** One scene per sub-composition, each with its own duration and
   animations; consistent transitions between scenes; reusable components for
   titles, lower-thirds and caption styles.
3. **Timeline rules.** One registered, paused timeline per composition, covering
   its full duration (a timeline shorter than its slot flashes black). Seek-safe
   and deterministic: no `Math.random()`, `Date.now()` or unseeded randomness in
   render code. Tween end times land on frame boundaries. Footage is muted video
   with audio as separate elements, and each audio element sets its volume
   explicitly. Local assets only: no CDN scripts or fonts in the final project.
4. **Validate before rendering.** Lint and check, preview, render a draft,
   inspect, revise, render final.

## 8. Audio

Voice first. Reduce noise and normalise (`sdlc-suite:video-editing` §3, about
-14 LUFS for social unless the platform says otherwise, true peak at or below
-1 dBTP). Add a music bed only if it improves the result, ducked while speech plays.
Compute its gain instead of guessing: gain_bed_dB = (LUFS_voice - 12) - LUFS_bed
(a fixed `volume=0.14` depends on that track's mastering and breaks with the next
song; 12-20 LU under the voice is the usual range). Do not let `loudnorm` on the
summed mix hide a bad balance: it lifts the voice, reads the right number and
leaves the music masking speech. Normalise last, on a mix that is already right,
and report the bed-to-voice ratio in LU, not only the master level. Sound effects follow a visual-event map, calibrated by peak against the
voice peak and aligned to the audible impact rather than the file start; let some cuts pass without a whoosh. Music
must never compete with speech.

## 9. Verify, then deliver

A clean lint or a zero exit is not evidence. Before calling it finished:

- `ffprobe` the export: duration, resolution, frame rate, codecs, loudness measured
  from the file.
- Extract and look at frames: the first 3 seconds frame by frame, every cut seam,
  each graphic at full and phone size, the last frame. Check cropping, overflow,
  safe zones and wrong timing. If a model can watch the render (`watch-video`),
  use it for an uninterrupted review and log drop-off points, predictable
  sequences and reading overload; otherwise review chronological frame strips and
  disclose that limit.
- Re-transcribe the final audio and compare the last syllable, clipping and the
  caption text.
- Render one still per card and per hook frame (`hyperframes snapshot` or an
  ffmpeg frame grab) before the full render, so a card covering a face costs a
  frame, not a render.
- Output at the source's quality at best: re-encoding never exceeds it. Delivery
  spec for vertical social: H.264, 1080x1920, 30 fps, AAC 48 kHz, about -14 LUFS,
  `+faststart`, colour tagged bt709 (an untagged render came out full-range
  `yuvj420p`, which crushes blacks in some players), no H.265 (upload errors were
  reported). Keep a high-quality master; if an upload copy is needed, a bitrate
  near 6 Mbps was reported to look better after Instagram's recompression than a
  30 Mbps file. That bitrate figure comes from an earlier Hermes skill and is
  unverified here, so check it against the platform's current spec.

Deliver the editable HyperFrames project and the rendered MP4, with paths. Report
the state actually reached (`sdlc-suite:video-editing` §1), the assumptions, the
text burned into the video so a wrong card is caught before posting, and the
`HUMAN REVIEW REQUIRED` items: rights to footage, music and stock; the speaker's
consent; other people in frame; any claim in an ad. Never post, upload or contact
anyone without explicit authorization, and never promise virality.

## 10. Failure modes to avoid

1. Slide-deck feel: static title cards, settle-and-freeze animations, effects with
   no narrative purpose.
2. A hook that works only with sound, or that the footage does not pay off.
3. Captions from the un-cut transcript, or outside the safe zone.
4. Colour used decoratively; more than a handful of hues.
5. Shipping after lint without looking at frames.
6. Inventing a HyperFrames feature instead of probing for it.
7. Music mixed to a master number while it still masks the voice.
