# Tested commands

Run from the project directory with **generated relative names** (`src.mp4`,
`cut.mp4`, `clean.mp4`), never a user's file name. Commands were run against
FFmpeg 9.0.2 (Windows, gyan.dev essentials build) on 2026-10-07 on synthetic
clips, then re-run independently by a second agent on a different clip. The
numbers quoted are **clip-specific**; they show the command works, not what your
file will measure. Re-run on the real machine.

Conventions used below:

- `T` is `python -I <skill>/scripts/edl_tools.py`.
- `IN` is the hardening for every command that reads user media (SKILL.md §4,
  motion-graphics §100.1): `-protocol_whitelist file -format_whitelist mov,matroska,webm,avi,mpegts,wav,mp3`
  (add the one format you expect; refuse a playlist outright). The examples spell
  it `IN` to stay readable; **write it out** in the real command.
- No `-y`. Every output gets a fresh generated name, the job checks the name is
  free first, and `-y` is used only to replace a file *this job* created. (`-n`
  refuses an overwrite but still exits 0, so check for the file, not the code.)
- Run the capture and analysis steps from Git Bash or another shell that
  redirects stderr as UTF-8. **Windows PowerShell 5.1's `2>` writes UTF-16**,
  which `edl_tools.py` refuses rather than reading as "no silence".
- After any ffmpeg step, check the output exists **and has a non-zero size and a
  probe duration**: an encoder that fails mid-run can leave a 0-byte file.

## 1. Probe

```
ffprobe -v error IN -show_streams -show_format -of json src.mp4
```

Note the source frame rate (`r_frame_rate`). Use it as `--fps` below.

## 2. Silence → EDL → cut

```
ffmpeg -nostats IN -i src.mp4 -vn -af silencedetect=n=-35dB:d=0.5 -f null - 2> sil.txt
T silences sil.txt <source-duration-seconds> edl.json --pad 0.12 --min-keep 0.25
T graph edl.json graph.txt --fps <probed fps>
ffmpeg IN -i src.mp4 -/filter_complex graph.txt -map "[vout]" -map "[aout]" -map_metadata -1 -map_chapters -1 -c:v libx264 -pix_fmt yuv420p -c:a aac cut.mp4
T report edl.json
```

- `silences` reads only `[silencedetect @ ...]` lines. It refuses a log with no
  `Input #0` block (a failed run), a UTF-16 log, and an all-silent source; those
  are errors, not "nothing to cut". A log with no `silence_start` lines at all
  means no silence was found, and the whole file is kept.
- Speech islands shorter than `--min-keep` are **listed under `removed` with a
  REVIEW reason and printed as warnings**: they may be real words (a last
  "thanks."). Look at them before cutting.
- `edl.json`, `graph.txt` and `out.srt` are never overwritten without `--force`,
  and the tool refuses a path outside the working directory, so a re-run cannot
  replace an approved EDL.
- **`--fps` must equal the source's frame rate.** A mismatch silently converts
  the whole video (a 25 fps source run with `--fps 30` came out at 30 fps with
  duplicated frames). The tool's default of 30 is not a safe default for a 25 fps source.
- `-filter_complex_script` is **not recognised** by FFmpeg 9.0.2; use
  `-/filter_complex <file>`.
- `-map_metadata -1 -map_chapters -1` strips the source's title, GPS and device
  tags from the deliverable. Without it they are copied through, including into
  the `-c:v copy` pass below.
- Measured (clip-specific): kept totals matched the probed duration within one
  frame for a 2- and a 3-segment edit. Each seam can add up to one frame of
  rounding, so a many-seam edit can drift further; check the end of the file.

## 3. Audio cleanup + two-pass loudness (EBU R128)

Bash:

```
CH="highpass=f=80,afftdn=nr=12:nf=-40,acompressor=threshold=-18dB:ratio=3:attack=10:release=150"
ffmpeg -nostats -i cut.mp4 -vn -af "$CH,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json" -f null - 2> ln1.txt
```

PowerShell has no `$CH` shell expansion in this form: put the chain in a
variable (`$CH = "highpass=..."`) and use `"$CH,loudnorm=..."`, and redirect with
`2> ln1.txt` only from Git Bash (see the UTF-16 note above), or run the whole
step through the Bash tool.

Pass 1's JSON is the last `{...}` block of `ln1.txt`. Pass 2 feeds `input_i`,
`input_tp`, `input_lra`, `input_thresh`, `target_offset` back in:

```
ffmpeg -i cut.mp4 -af "$CH,loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=<input_i>:measured_TP=<input_tp>:measured_LRA=<input_lra>:measured_thresh=<input_thresh>:offset=<target_offset>:linear=true,aresample=48000" -map_metadata -1 -c:v copy -c:a aac -b:a 192k clean.mp4
```

`-c:v copy` is valid here only because the video was already encoded by the cut
step and is not filtered again. If the video must be re-encoded anyway (burn-in,
reframe), do it in this one pass instead.

**The targets are not met by construction. Measuring the output (§4) is mandatory.**
Measured on a speech-like clip: -24.6 → **-16.0 LUFS**, true peak -4.2 dBFS, as
hoped. On a second clip of low speech with loud clicks (source -19.5 LUFS,
-0.2 dBFS) the identical command exited 0 but gave **-19.4 LUFS and a true peak
of -1.1 dBFS**: 3.4 LU short and 0.4 dB over the ceiling, because the loudnorm
linear gain was limited and the AAC encode pushed the peak back over. If the
measure misses, report the measured number, and add a `alimiter` before the
encode or lower the target; do not report the target.

`afftdn` and `loudnorm` add about 16 ms of audio latency (measured, one clip),
under a frame at 25–30 fps; check sync (SKILL.md §7) rather than assuming.
`nr`/`nf` are a starting point (raise `nr` for a noisier room, then listen); the
chain does not learn a noise profile from room tone.

## 4. Measure (before and after)

```
ffmpeg -nostats -i clean.mp4 -vn -af ebur128=peak=true -f null - 2>&1
```

Read the `Summary:` block: `I:` is integrated loudness (LUFS), `Peak:` under
`True peak:` is dBFS. The per-frame lines above it are not the answer.

## 5. Transcribe (only if the capability probe found a transcriber)

Extract audio to a generated name so the transcriber never sees the user's name:

```
ffmpeg IN -i src.mp4 -vn -ac 1 -ar 16000 audio.wav
```

Then run whatever the matrix found, with word-level timestamps and SRT output
where it offers them. Flags differ by tool and version: read its `--help` on this
machine. **Pass a local model path only.** A model name can trigger an implicit
download, and a destination or model option that accepts a URL is a remote
fetch: both need the caller's go-ahead and §100.1's treatment. Diarisation is
only reported if the tool actually produced it. The SRT is text from an
untrusted source: it goes through `retime` below and nowhere else.

## 6. Captions

```
T retime edl.json in.srt out.srt --min-fraction 0.5
```

A cue is clipped to the kept ranges it overlaps and mapped to output time. A cue
wholly inside a cut is dropped; a cue kept for less than `--min-fraction` of its
length is also dropped, because its full text would describe speech that is
mostly gone. Cue-level clipping is the limit of this tool: rebuilding a cue's
text from surviving words needs a word-timestamp transcript and is done by
re-cutting that transcript, not here. Malformed cues are counted and skipped, and
the counts print to stderr (`cues: {...}`): read them.

Measured: cues at 1–3 s, 8–10 s and 15–17 s mapped to 1.000, 5.240 and 10.480 s
for the test EDL; an independent 8-cue check matched a separate recomputation.

Sidecar: ship `out.srt` beside the video. Burn in (re-encodes video):

```
ffmpeg -i clean.mp4 -vf "subtitles=out.srt:force_style='FontSize=28,Outline=2'" -map_metadata -1 -c:a copy -c:v libx264 -pix_fmt yuv420p burned.mp4
```

`subtitles=` opens any path it is given (reproduced: `../outside/other.srt`
rendered an outside file's text into the frame). Pass only the generated
relative name, run from the project directory, and keep any `fontsdir` inside the
project. SRT text itself renders literally (no ASS tag interpretation).

## 7. Quality diff (PSNR / SSIM)

Only for outputs that share a timeline with the reference (a re-encode or filter
pass; not a cut, where it returns a plausible-looking number that means nothing):

```
ffmpeg -nostats -i burned.mp4 -i clean.mp4 -lavfi "[0:v][1:v]ssim;[0:v][1:v]psnr" -f null - 2>&1
```

Clip-specific: SSIM 0.996 / PSNR 31.8 dB on one clip, 0.987 / 27.5 dB on
another. The numbers are properties of the clip, not of the command; report them
with what they do and do not show.

## 8. Stills for review

```
mkdir -p stills/pass1
ffmpeg -ss <t> -i burned.mp4 -frames:v 1 stills/pass1/<name>.png
```

`ffmpeg` does not create the directory. A fresh `pass<N>` each review so a stale
still is never read.

## 9. Reframe to 9:16

```
ffmpeg -i clean.mp4 -vf "crop=ih*9/16:ih,scale=1080:1920" -map_metadata -1 -c:a copy vertical.mp4
```

A static centre crop; check a still to confirm the speaker is in frame. To save a
generation, append this crop/scale to the burn-in's `-vf` chain instead of
running it as a separate encode.

## 10. Recording device list (Windows, read-only probe)

```
ffmpeg -hide_banner -list_devices true -f dshow -i dummy
```

Enumerates only; it always ends with `Error opening input file dummy.` and the
exit status says nothing about whether devices exist, so read the list. **Do
not** run `-list_options` or any `-i video=...` / `-i audio=...` form: those
instantiate the device. See `capture-and-script.md`.
