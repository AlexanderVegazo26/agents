# Motion graphics reference — Tools, rendering, encoding, colour and delivery

Part of the `motion-graphics` skill. Section numbers match the skill's
index in SKILL.md.


# 34. Tool Selection

Select the simplest tool capable of producing the desired result.

### Use procedural/vector methods for:

-   Typography
-   UI
-   Infographics
-   Charts
-   Logos
-   Geometric animation

### Use 3D for:

-   Product visualization
-   Complex camera motion
-   Spatial scenes
-   Realistic lighting
-   Material studies

### Use AI generation for:

-   Conceptual imagery
-   Stylized environments
-   Character imagery
-   Backgrounds
-   Visual exploration
-   Difficult-to-source assets

### Use compositing for:

-   Layered visual effects
-   Cleanup
-   Color correction
-   Integration

### Use video-generation models for:

-   Cinematic motion
-   Organic movement
-   Difficult simulations
-   Generative scenes

Do not use expensive generative video for something that can be produced more reliably with vector or procedural animation.

------------------------------------------------------------------------

# 35. Preview vs Final Rendering

Maintain separate settings.

## Preview

Optimize for:
- Speed
- Iteration
- Timing
- Layout
- Composition

Possible reductions:
- Resolution
- Samples
- Effects
- Particle count
- Motion blur
- Ray tracing

## Final

Restore:
- Full resolution
- Final frame rate
- Final samples
- Final effects
- Final audio
- Final color
- Final quality

Never accidentally deliver a preview render as final.

------------------------------------------------------------------------

# 36. Render Architecture

For complex projects render in stages:

``` text
Scene/Shot
→ Intermediate Render
→ Assembly
→ Audio Mix
→ Color
→ Final Encode
→ QA
```

Prefer shot-level rendering when:
- renders are long,
- scenes are complex,
- failures are expensive,
- or parallel rendering is possible.

------------------------------------------------------------------------

# 37. Render Budget

Track:

``` text
TARGET_DURATION
TARGET_FPS
TARGET_RESOLUTION
FRAME_COUNT
ESTIMATED_RENDER_TIME
ESTIMATED_OUTPUT_SIZE
CACHE_SIZE
SOURCE_SIZE
```

If render size becomes excessive:
- identify why,
- compress only where appropriate,
- preserve a high-quality master,
- create platform variants separately.

------------------------------------------------------------------------

# 38. Delivery Formats

Unless platform-specific requirements override them, consider:

### Master

-   ProRes 422 HQ
-   ProRes 4444 when alpha is required
-   DNxHR HQ/HQX when appropriate
-   High-quality image sequence for VFX-heavy workflows

### Distribution

-   H.264 MP4
-   H.265/HEVC MP4 where supported

### Web/Transparent

-   WebM with alpha when appropriate
-   ProRes 4444 for high-quality alpha workflows
-   PNG sequence where required

Never promise a codec that the actual environment cannot produce.

------------------------------------------------------------------------

# 39. Encoding Defaults

Use VBR unless a platform or workflow requires CBR.

Suggested starting points, subject to platform override:

### 1080p H.264

``` text
VBR target: 8–16 Mbps
Audio: AAC 192–320 kbps
Sample rate: 48 kHz
```

### 4K H.264/H.265

``` text
VBR target: approximately 35–60 Mbps
Audio: AAC 256–320 kbps
Sample rate: 48 kHz
```

These are production starting points, not universal platform specifications.

Always use current platform-specific encoding requirements when available.

------------------------------------------------------------------------

# 40. Audio Delivery

Default:

``` text
Sample rate: 48 kHz
Bit depth for masters: 24-bit where supported
Distribution codec: AAC
```

For PCM masters use WAV where appropriate.

Check:
- clipping,
- channel count,
- silence,
- sync,
- loudness,
- true peak,
- sample rate,
- duration.

------------------------------------------------------------------------

# 41. Loudness

Use the target platform or broadcaster specification when available.

Common production targets include:

``` text
Social/web starting point: approximately -14 LUFS integrated
Podcast-style delivery: approximately -16 LUFS integrated
EBU R128 broadcast workflows: -23 LUFS integrated
```

Use an appropriate true-peak ceiling, commonly around:

``` text
-1 dBTP
```

unless the delivery specification requires otherwise.

Never blindly normalize every project to the same loudness target.

------------------------------------------------------------------------

# 42. Audio QA

Verify:
- No clipping
- No unintended silence
- No desync
- No clicks/pops
- Correct sample rate
- Correct channel layout
- Correct loudness
- Correct duration
- Voice is intelligible
- Music does not overpower VO

------------------------------------------------------------------------

# 43. Color Management

Declare:

``` text
Color space
Transfer function
Gamma
Primaries
HDR/SDR state
```

Default to Rec.709 SDR unless otherwise specified.

Do not mix HDR and SDR unintentionally.

If HDR is requested, define:
- HDR standard
- mastering assumptions
- peak brightness
- transfer function
- metadata
- display assumptions

------------------------------------------------------------------------

# 44. LUT Handling

If using LUTs:
- record LUT name,
- version,
- input color space,
- output color space,
- intensity,
- order in the processing chain.

Never apply a LUT blindly.

Keep original media available where possible.

------------------------------------------------------------------------

# 45. Color Consistency

Check:
- Skin tones
- Brand colors
- Whites
- Blacks
- Contrast
- Saturation
- Shot-to-shot consistency

A shot should not look different merely because it was generated by another model or rendered by another tool.

------------------------------------------------------------------------

# 46. Calibration Note

When critical color accuracy matters, record:

-   Display used
-   Calibration state if known
-   Color profile
-   Viewing environment
-   Reference standard

If the environment is not color-calibrated, state:

`COLOR_CRITICALITY = HUMAN_REVIEW_REQUIRED`

------------------------------------------------------------------------

# 56. Interchange and Source Files

When supported, preserve:
- project files,
- source code,
- compositions,
- sequences,
- editable text,
- editable vectors,
- original assets,
- audio stems,
- generated assets,
- render presets.

Where applicable export:
- EDL
- XML
- AAF
- OpenTimelineIO
- project package

Only create interchange formats actually supported by the production tool.

------------------------------------------------------------------------

# 57. Project Metadata

Maintain a project manifest.

Example:

``` yaml
project:
  id: PROJECT_ID
  name: PROJECT_NAME
  version: 1.0.0
  duration: 00:00:30:00
  fps: 30
  resolution: 1920x1080
  color_space: Rec.709
  audio_sample_rate: 48000
  status: FINAL_VALIDATED

creative:
  style: cinematic
  palette: [...]
  typography: [...]

delivery:
  master: ProRes_422_HQ
  distribution: H264_MP4

qa:
  visual: passed
  technical: passed
  audio: passed
  accessibility: passed
  licensing: review_required
```

------------------------------------------------------------------------

# 58. Naming Convention

Use deterministic filenames.

Example:

``` text
PROJECT_scene03_shot02_v004_preview.mp4
PROJECT_scene03_shot02_v004_final.mov
PROJECT_master_v004.mov
PROJECT_social_9x16_v002.mp4
PROJECT_captions_en_v002.srt
PROJECT_manifest_v004.yaml
PROJECT_QA_v004.md
```

Never use ambiguous names such as:

``` text
final.mp4
final_final.mp4
newfinal2.mp4
```

------------------------------------------------------------------------

# 59. Versioning

Use explicit versions.

Recommended:

``` text
v001
v002
v003
```

For major release states:

``` text
1.0.0
1.1.0
2.0.0
```

Track:
- creative changes,
- technical changes,
- asset changes,
- model changes,
- prompt changes,
- render changes.

------------------------------------------------------------------------

# 60. Timecode

Use consistent timecode.

Default:

``` text
HH:MM:SS:FF
```

Document:
- starting timecode,
- FPS,
- drop/non-drop behavior if relevant.

Do not mix timecode conventions within the same project.

------------------------------------------------------------------------

# 61. Cache and Temporary Files

Keep temporary files separate from source and deliverables.

Recommended:

``` text
/cache
/tmp
/proxies
/renders/intermediate
/exports
/source
```

Never treat cache as source-of-truth.

Document cache location if another operator may need to reproduce the project.

------------------------------------------------------------------------

# 62. Render Presets

Store render settings as versioned presets.

Example:

``` yaml
preset: social_1080p
codec: h264
container: mp4
resolution: 1920x1080
fps: 30
rate_control: VBR
video_bitrate_target: 12Mbps
audio_codec: aac
audio_bitrate: 256kbps
audio_sample_rate: 48000
color_space: Rec.709
```

------------------------------------------------------------------------

# 84. Delivery Package

For a professional project, deliver:

``` text
/project
  /source
  /assets
  /audio
  /captions
  /renders
  /thumbnails
  /presets
  /metadata
  /qa
  /docs
```

Typical final package:

``` text
MASTER.mov
DISTRIBUTION.mp4
VERTICAL.mp4
SQUARE.mp4
CAPTIONS_EN.srt
CAPTIONS_EN.vtt
THUMBNAIL.jpg
PROJECT_SOURCE
PROJECT_MANIFEST.yaml
PROJECT_QA.md
RENDER_PRESET
```

Only include variants actually requested or useful.

------------------------------------------------------------------------

# 85. Checksums and Integrity

For important deliverables, generate checksums where tooling permits.

Example:

``` text
SHA256:
MASTER.mov  <hash>
DISTRIBUTION.mp4  <hash>
CAPTIONS_EN.srt  <hash>
```

This helps verify files were not changed after delivery.

------------------------------------------------------------------------

# 96. Source of Truth

Define a source of truth for:

### Text

One canonical content source.

### Brand

Official brand asset directory.

### Localization

Localization dictionary.

### AI

Prompt/model registry.

### Render

Versioned render preset.

### Final

Validated final render.

Do not maintain conflicting copies without clear versioning.

------------------------------------------------------------------------

# 97. Change Management

For every significant revision record:

``` text
VERSION
DATE
CHANGE
REASON
AFFECTED SHOTS
AFFECTED ASSETS
RENDER REQUIRED
QA REQUIRED
```

Example:

``` text
v004
Changed first 3 seconds to strengthen hook.
Affected: S01, S02.
Render: Required.
QA: Full.
```

------------------------------------------------------------------------

# 98. Performance Optimization

Optimize without changing creative intent.

Prioritize:
1. Remove unnecessary computation.
2. Reuse assets.
3. Cache expensive simulations.
4. Render shots independently.
5. Use proxies during preview.
6. Reduce invisible geometry.
7. Reduce off-screen computation.
8. Use GPU acceleration where available.
9. Parallelize independent work.
10. Restore final-quality settings for delivery.

------------------------------------------------------------------------

# 99. Reproducible Builds

Where possible make the project reproducible.

Record:
- Tool versions
- Dependencies
- Node/Python versions
- Model versions
- Render presets
- Environment variables that are safe to record
- Asset versions
- Fonts
- LUTs
- Seeds
- Prompts

Do not store secrets in project manifests.

Use placeholders for credentials.

------------------------------------------------------------------------

# 100. Security

Never embed:
- API keys
- passwords
- access tokens
- private credentials

inside:
- source files,
- prompts,
- manifests,
- render metadata,
- exported video.

Use environment variables or secret managers where appropriate.

## 100.1 Untrusted text, files and projects in render commands

On-screen copy, captions, titles, file names, prompts, media and whole projects
usually come from someone else: a brief, a script, a ticket, a customer upload.
Treat all of it as data, never as part of a command. The rules below were
checked against FFmpeg 9.0.2, except where marked as taken from a manual.

**Text**

- Keep user text off every command line. A shell expands `$(...)` and
  backticks inside double quotes before the tool runs.
- Never put user text inline in a filter graph. `:`, `,`, `;`, `[`, `]`, `'`
  and `\` are graph syntax: an inline `drawtext=text=` value can add a second
  filter that reads any file into the frame, or reach `movie=`.
- Use `drawtext=textfile=<agent-generated relative name>:expansion=none`.
  `textfile=` content is still `%`-expanded by default, so without
  `expansion=none` a brief containing `%{...}` renders something other than
  the approved copy, or fails the render.
- Never place a user-supplied file name in any filter option (`textfile`,
  `fontfile`, `subtitles`, `movie`): those options open whatever path they are
  given. For long graphs write them with `-filter_complex_script`.
- Generate caption files (SRT/ASS) from the approved script rather than passing
  a user subtitle file through, and keep `fontsdir` inside the project.

**File names**

- Before a user file name reaches argv, copy it to an agent-generated name such
  as `input_001.mp4`. A name can otherwise be read as an option (leading `-`),
  a protocol (`concat:`, `subfile:`), or an image sequence (`img%d.png`).
- Where renaming is impossible, prefix it with `file:` (and `./` for a leading
  `-`), add `-pattern_type none` for image inputs, and reject names containing
  newlines.
- Never use `-safe 0` on a concat list holding user-derived names, and escape
  `'` as `'\''` when writing one.

**Probing and parsing media**

- Probing is itself parsing untrusted input. A successful `ffprobe` proves the
  format, not that the file is safe: a user `.m3u8` probes cleanly while
  opening an absolute path outside the project.
- Run `ffprobe` and `ffmpeg` on user media with
  `-protocol_whitelist file -format_whitelist <the demuxers you expect>`, or
  force the demuxer with `-f`. `-protocol_whitelist file` alone does not stop a
  playlist reading an absolute local path.
- Refuse user-supplied playlists and lists outright: `.m3u8`, `.m3u`,
  `.ffconcat`, `.sdp`, concat lists. Renaming one to `input_001.mp4` happens
  to stop HLS detection in FFmpeg 9.0.2, but that depends on the build; the
  whitelist is the control.

**Outputs**

- Resolve every path an option writes to, following symlinks and junctions,
  and refuse one outside the project. That is not only the output file:
  `-hls_segment_filename`, segment and image2 output patterns, `-passlogfile`,
  `-report` / `FFREPORT`, `-vstats_file`, and `tee:` or URL outputs all write.
- Overwrite only a file created in this production, or one the caller named
  for overwrite, and use `-y` for those. For any other existing output, stop
  before invoking FFmpeg. Do not rely on `-n`: it refuses to overwrite, prints
  `already exists`, and still exits 0, so the old file passes as a fresh
  render. After a render, confirm the output is new (size, mtime or hash
  changed). Never let an output resolve to an input.

**Shells and hand-offs**

- Invoke tools with an argument list rather than a shell string. On Windows
  that protects nothing when the target is a `.cmd` or `.bat` shim (npx, often
  remotion): cmd.exe re-parses its arguments, so they may contain only
  agent-generated paths and numbers.
- The same holds for a command handed to a caller to run: paths and numbers
  only, with every piece of text in a file.

**Projects are code**

- Rendering a Remotion project you did not write executes it; treat it like
  installing a package. Props must not carry URLs or absolute paths into
  `<Img>`, `<Video>` or `fetch`; reference assets with `staticFile()` inside the
  project.
- `npm install` / `npm ci` in a project you did not create runs its lifecycle
  scripts. Only with the caller's go-ahead, and then with `--ignore-scripts`.
  A renderer's first-run browser download is an install too.
- An untrusted `.blend` can carry Python text blocks and drivers. Open it with
  `blender -b --factory-startup -Y <file>`: `-Y` disables auto-execution, and
  `-y` enables it, the opposite of FFmpeg's `-y`. `--factory-startup` stops
  user preferences re-enabling it. Pass user text to your own `--python`
  scripts through a JSON file, never as a string literal inside the script.
  (Blender flags from the Blender manual; not verified on this machine.)

------------------------------------------------------------------------

# 101. File Validation

Before delivery verify:

``` text
File exists
File opens
Duration correct
Resolution correct
FPS correct
Audio present
Audio sync correct
Codec correct
Color correct
Captions correct
No corruption
No unexpected extra streams
```

Use machine-readable inspection where available.

------------------------------------------------------------------------
