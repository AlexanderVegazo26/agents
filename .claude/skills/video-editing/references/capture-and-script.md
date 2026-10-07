# Recording yourself, and scripting for the edit

The agent never starts a camera, microphone or screen capture. It plans, writes the
outline and the exact command, and the **user runs it** in their own terminal
(in Claude Code, by typing `! <command>`). Then the agent edits what was recorded.

## 1. Before recording

Ask only what the brief needs: topic, audience, target length, platform, tone,
and the one thing the viewer should remember. Default length for a single topic:
60–180 s for short-form, 3–8 min for an explainer.

Recording tips that make the edit cleaner (each saves work later):

- Quiet room, soft surfaces, mic 15–30 cm from the mouth. Leave a few seconds of
  silence at the start: it helps you judge the room's noise floor by ear and
  when choosing the silence threshold (the cleanup chain uses fixed settings; it
  does not learn a noise profile).
- Say a clap or "three, two, one" at the start so sync is checkable.
- On a flub, **pause, then redo the sentence from its start**. The editor cuts
  the pause automatically; removing the flubbed sentence itself needs a
  transcript, so on a machine without a transcriber (check first; this one had
  none on 2026-10-07) the bad take stays in unless a human marks it. Say so up front.
- Keep the camera still and eyes near the lens; leave a one-second beat after the
  last line.

## 2. Outline and script (podcast-episode-writer style)

Write both files to the project. The speaker reads bullets, not a script, unless
they ask for a script.

```
Hook (0:00–0:10)       one sentence that states the payoff
Context (0:10–0:30)    why it matters to this audience
Point 1 / 2 / 3        one claim, one example each, ~30 s apiece
Recap (last 15 s)      the single thing to remember
Call to action         one action, stated once
```

Add target timestamps per section, and any facts or numbers the speaker must get
right; each factual claim in an ad is flagged for human review.

## 3. The capture command (Windows, dshow)

First list devices (a read-only probe, safe for the agent to run):

```
ffmpeg -hide_banner -list_devices true -f dshow -i dummy
```

Device names are text supplied by the driver, so check each against the character
set letters, digits, space, `.`, `_`, `(`, `)` and `-` and refuse the command if one
falls outside it (a name with a quote or `&` could break the pasted line). Never
run `-list_options` or an `-i video=...`/`-i audio=...` form yourself: those open
the device. Then give the user a command with the exact device names from that
output, for them to run (it records until they press `q`, or for `-t` seconds):

```
ffmpeg -hide_banner -f dshow -rtbufsize 256M -framerate 30 -video_size 1920x1080 -i video="<camera name>":audio="<microphone name>" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -t 600 raw.mp4
```

The listing command always ends with `Error opening input file dummy.` (that is
how it enumerates, not a failure), and its exit status says nothing about
whether devices exist; read the list. On 2026-10-07 this machine listed one
microphone and reported "Could not enumerate video devices (or none found)", so
a camera capture here would need a device the machine does not show. The capture
command itself was not run (it would open the user's devices).

Notes: a camera that cannot do 1920x1080 at 30 fps fails to open; read the error
and lower `-video_size`. Use the `Alternative name` from the listing if a
device name is ambiguous. Pick an output name that does not exist yet (add a take number) so a previous take is never overwritten. Recording straight to `raw.mp4` is only safe if it is stopped with
`q`; for a long take prefer `raw.mkv`, which survives an interruption, and the
edit step reads it the same way. The screen, camera and microphone are the
user's: the agent does not start a capture, schedule one or leave one running.

Other platforms: macOS uses `-f avfoundation`, Linux `-f v4l2` with `-f alsa` or
`-f pulse`. Probe with the matching `-list_devices true` first; do not guess.

## 4. After recording

Copy the file to the project under a generated name (`src.mp4`), then run
SKILL.md §3 from step 2. Report the original untouched, the EDL, the
cleaned file with its measured numbers, and the captions.
