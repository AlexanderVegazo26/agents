# ADR-0001 — Video export pipeline (DEC-VEX.1, .2, .3, .7)

- Date: 2026-08-28
- Status: Accepted (architecture); implementation not started
- Owner: solution-architect
- Tier: 3 (new runtime deps, new IPC contract, cross-cutting boundary)
- Supersedes: none. Amend by superseding, never edit in place.

## Context

Five capabilities land in one change (FR-VEX.1-14, UX-VEX.1-5): trim, format/resolution/bitrate,
animated GIF, speed change, frame-accurate transport. The initiative requires ONE pipeline that
serves all five, configurable OUTPUT resolution and bitrate, frame-accurate seek, a frame feed for
GIF, and named + licence-checked dependencies against a runtime dep set of exactly
`electron-updater` and `zod`.

### Evidence gathered (probed, not recalled)

1. **WebCodecs on THIS Electron 44.0.0 build (Chrome 152.0.7977.54), real BrowserWindow,
   `sandbox: true`, `contextIsolation: true`, hidden window, default GPU settings (no
   `disableHardwareAcceleration` or `appendSwitch` anywhere in `src/main/index.ts`):**

   | probe | result |
   |---|---|
   | `data:` URL origin | `VideoDecoder`/`VideoEncoder`/`AudioEncoder`/`ImageDecoder` **undefined** (`isSecureContext` false) |
   | `file://` origin (how prod loads, `loadPage`, src/main/index.ts:170-178) | `isSecureContext: true`, all four **present** |
   | decode `avc1.42E01E`, `avc1.640028`, `vp09.00.10.08`, `vp8` @1920x1080 | all `true` |
   | encode `avc1.42E01E` / `avc1.42001E` (level 3.0) @1280x720x30 | **`false`** |
   | encode `avc1.42001f` (level 3.1), `avc1.4d0028`, `avc1.640028`, `avc1.640034` | `true`, both `no-preference` and `prefer-software` |
   | encode `vp09.00.10.08`, `vp8` | `true`, both accelerations |
   | `AudioEncoder` `opus`, `mp4a.40.2` | `true` |
   | `requestVideoFrameCallback`, `OffscreenCanvas` | present |

   Two load-bearing consequences: WebCodecs is **secure-context gated** (any future move to a
   non-secure origin silently removes the whole pipeline), and the **H.264 level must be derived
   from the user's chosen output resolution** — a hardcoded baseline-3.0 string is rejected at 720p.

2. **OpenCut (DEC-VEX.1 input (i)) — read from the repo, not recalled.** `main` is a rewrite with no
   export module yet. On `dev` / `v0.1.0`, `apps/web/package.json` carries `mediabunny ^1.29.1`
   (plus legacy `@ffmpeg/*` retained from the pre-rewrite path), and
   `apps/web/src/services/renderer/scene-exporter.ts` imports `Output`, `Mp4OutputFormat`,
   `WebMOutputFormat`, `BufferTarget`, `CanvasSource`, `AudioBufferSource`, `QUALITY_*` from
   `mediabunny`. Their export is a canvas-render-per-frame → mediabunny encode/mux, browser-only.

3. **mediabunny 1.55.3** — licence **MPL-2.0**, runtime dependencies: **none** (only
   `@types/dom-webcodecs`, `@types/dom-mediacapture-transform`). Read from its published `.d.ts`:
   `Input`/`Output`, `Mp4OutputFormat`/`MkvOutputFormat`, `VideoSampleSink` + `CanvasSink` with
   `getSample(timestamp)` and `samplesAtTimestamps()` (frame-accurate random access),
   `AudioBufferSink`, `CanvasSource`/`AudioBufferSource`, `StreamTarget`, `CustomSource`
   (ranged `read(start,end)`), `canEncodeVideo`/`getEncodableVideoCodecs`,
   `InputVideoTrack.computePacketStats() -> averagePacketRate`, `frameRateIsConstant`.
   `ConversionVideoOptions` offers `width`/`height`/`fit`/`frameRate`/`codec`/`quality`/`bitrate`
   and `ConversionOptions.trim {start,end}` — but **no speed/playback-rate option** (verified by
   reading the type). **Zero matches for `gif` in the entire `.d.ts`.**

4. **GIF encoders on npm:** `gifenc` 1.0.3 — MIT, zero dependencies, mattdesl.
   `gifski-wasm` 2.2.0 — **AGPL-3.0-or-later**. `gif.js` 0.2.0 — MIT, 2015, worker-via-blob-URL.

## Decisions

### DEC-VEX.1 — Video pipeline: mediabunny in the renderer, hand-driven (not `Conversion`)

Decode with `Input` + `VideoSampleSink`/`AudioBufferSink`; re-time and re-encode with `Output` +
`VideoSampleSource`(or `CanvasSource`)/`AudioBufferSource` + `Mp4OutputFormat` /
**`WebMOutputFormat`** (verified at mediabunny.d.ts:5291, `class WebMOutputFormat extends
MkvOutputFormat`). The WebM path MUST use `WebMOutputFormat`, not `MkvOutputFormat` — MKV bytes
under a `.webm` extension is exactly the extension/content disagreement src/shared/recording.ts:63
and FR-VEX.7 forbid.

**Bitrate is set numerically, and this is a second reason `Conversion` is rejected.**
`ConversionVideoOptions.bitrate` and `VideoEncodingConfig.bitrate` are both marked
`@deprecated Use quality instead` (verified in the `.d.ts`), but a `Quality` preset cannot satisfy
FR-VEX.5 ("a control presented but not honored is a defect") or AE-VEX.2 (report source vs output
bitrate side by side). Therefore: pass the user's **numeric** `bitrate` on `VideoEncodingConfig`
(deprecated, not removed — pin the mediabunny minor and re-check on upgrade), and register
`onEncoderConfig` to capture the actual `VideoEncoderConfig` that reached WebCodecs. That captured
value, not the requested one, is what the UI and AE-VEX.2 evidence report.

**Audio at speed S ≠ 1 (NG-VEX.4 "audio must survive trim/speed coherently").** Decision: audio is
**resampled without pitch correction** — the decoded `AudioBuffer` for the trimmed span is re-timed
by S and fed to `AudioBufferSource`, so a 2x export raises pitch by an octave. Chosen because
pitch-preserving time-stretch is a real DSP algorithm requiring either hand-written code or a third
runtime dependency, and neither is justified before an owner says narrated demos at non-1x matter.
Audio is **never dropped or muted** (NG-VEX.4 excludes muting-as-a-feature). This is the constraint
that bounds DEC-VEX.4: product-manager must choose the allowed multiplier set knowing every non-1x
value pitch-shifts narration. If that is unacceptable, it becomes a new decision (add a time-stretch
dependency) — not a silent implementation choice.
Classification: **project convention + strong consensus** for the library choice (it is what the
named reference app uses and it is the only zero-runtime-dep option that satisfies all five
clauses); **required** for the hand-driven rather than `Conversion` form, because `Conversion`
has no speed multiplier and FR-VEX.9 would otherwise need a second pipeline — the exact
"rewritten later" failure DEC-VEX.1 clause (1) rejects by construction.

Clause satisfaction: (1) one pipeline serves trim (timestamp range into the sink), speed
(timestamp remap on emit), resolution (encoder config / draw size), bitrate (numeric, see above),
format (output format class), and GIF (same decoded frames); (2) output resolution and bitrate are
encoder inputs, not stream properties; (3) `samplesAtTimestamps`/`getSample` is frame-accurate
decode; (4) the GIF path consumes the same `VideoSample`s; (5) dependency **named: `mediabunny`,
MPL-2.0** — file-level copyleft, used unmodified as a dependency, compatible with shipping this
MIT app; it adds **zero transitive runtime deps**, which is why it is acceptable against a dep set
of two.

Rejected:
- **MediaRecorder re-capture** — and *not* on the brief's stated grounds. The premise "resolution
  and bitrate cannot be configured on a stream that is merely captured" is **false**: canvas size
  sets resolution and `videoBitsPerSecond` sets bitrate. It is rejected on the real grounds:
  realtime-only (export cost ≥ source duration, worse at 0.5x speed), non-deterministic frame
  timing against the AE-VEX.6 tolerance, no frame-accurate boundary, and no clean audio story at
  non-1x. Recorded here so the rejection is defensible and the false premise stops propagating.
- **ffmpeg.wasm** — ~30 MB of WASM, LGPL/GPL build ambiguity, and a second decode stack alongside
  the WebCodecs one we already proved works. Rejected on size + licence-diligence cost, not capability.
- **`HTMLVideoElement` + `requestVideoFrameCallback` as the decoder** — viable and container-free,
  but gives no frame-exact timestamps or audio path, and mediabunny already demuxes both containers.
  Retained only as the *preview/transport* mechanism (see UX constraints), not as the export decoder.

### DEC-VEX.2 — GIF: `gifenc`, answered independently

**mediabunny cannot write GIF** (evidence 3), so this decision cannot be inherited. Use
**`gifenc` 1.0.3 — MIT, zero dependencies**, run inside a Web Worker we own, fed RGBA from the same
decoded frames (`quantize()` → `applyPalette()` → `GIFEncoder`). Rejected: **`gifski-wasm`
(AGPL-3.0-or-later — incompatible with this MIT app's distribution)**, `gif.js` (unmaintained since
2015, blob-URL worker conflicts with the app's CSP posture), and hand-rolling LZW (no reason to).
Risk: `gifenc` is low-activity; mitigation is that it is ~700 lines of MIT code we can vendor if it
is ever pulled. GIF has no audio track — audio is dropped for this format and the UI must say so
(that is format reality, not NG-VEX.4 audio editing).

### DEC-VEX.3 — Bytes: neither direction crosses IPC whole

The contradiction the requirement flags is real: `ExportRequest.data: Uint8Array`
(src/shared/types.ts:377-382) is the wrong vehicle for a re-encoded video, for exactly the reason
src/main/index.ts:559-563 gives for `exportOriginal`.

- **Read side:** a new ranged-read IPC (`readItemRange(id, start, end)`) backing a mediabunny
  `CustomSource` (`prefetchProfile: 'fileSystem'`). Do **not** reuse `readItemBytes`, which returns
  the whole file.
- **Write side:** a new chunked-write contract — `beginExport` (main runs the save dialog, returns
  a handle, opens a temp file **in the destination directory**), `writeExportChunk(handle, data,
  position)` fed by mediabunny's `StreamTarget` (`chunked: true`), then `commitExport` (fsync +
  rename onto the user's path) or `abortExport` (close + unlink). Rename-on-commit is what makes
  **FR-VEX.12** structurally true rather than best-effort: no bytes ever appear at the user's chosen
  path until the file is complete.
- `exportAs` keeps its current single-blob shape for images (png/jpg) and is untouched by video.
  FR-VEX.14 still applies: widen the `format` union and the closed set in main to include `gif`
  and the video formats reachable by the new path, and keep the throw for unknown values.

### DEC-VEX.7 — Accepted source containers/codecs

Accept exactly what this build proved it can decode: **MP4/`avc1.*` and WebM-MKV/`vp9`, `vp8`** —
which covers the full `MIME_CANDIDATES` chain in src/shared/recording.ts:45-54, both the MP4
preference and the WebM fallback. Detection is by **probing the opened file's actual track config
through mediabunny + `VideoDecoder.isConfigSupported`**, never by trusting the extension or
`LibraryItem.kind` (recording.ts's "probe, never assume"). Anything else is refused up front with
the codec named (FR-VEX.10).

## Non-functional requirements — ALL **PROPOSED, NOT CONFIRMED**

AE-VEX.7 states no perf/quality/size target was given and QA must not fail a build on one. These
are proposed for owner acceptance (product-manager or the human) and are non-binding until accepted.

1. NFR-VEX.1 Export wall-clock ≤ 1.0x source-span duration for 1080p30 H.264 → H.264 at 1x speed.
2. NFR-VEX.2 Peak renderer heap growth during export ≤ 512 MB, achieved by bounding
   `VideoEncoder.encodeQueueSize` ≤ 8 and never buffering the whole output (`StreamTarget`).
3. NFR-VEX.3 Progress events (FR-VEX.11) at ≥ 2 Hz and within 1 s of start; no gap > 5 s.
4. NFR-VEX.4 GIF refused above 1280 px on the long edge, 20 fps, or 1000 frames, with the offending
   setting named (FR-VEX.6). Rationale: 8-bit palette + full-frame RGBA is memory-bound.
5. NFR-VEX.5 Frame-step (UX-VEX.1) renders the new frame within 150 ms of the keypress.
6. NFR-VEX.6 Abort/cancel releases the encoder and deletes the temp file within 2 s.

## Assumptions

- **Assumption #1: mediabunny's `Input` demuxes this app's actual recorded files** — MediaRecorder
  emits *fragmented* MP4, a different parse path from a normally-muxed MP4, and the API surface
  above was read from type declarations, not executed against a real library recording.
  *Risk if wrong (medium):* the decode side falls back to `HTMLVideoElement` +
  `requestVideoFrameCallback`, losing frame-exact timestamps and the audio path; FR-VEX.9 and
  UX-VEX.1 tolerances would need renegotiating. *Retire it by:* opening one real MP4 and one real
  WebM library recording through `Input` and reading track configs, as the first implementation step.
- **Assumption #2: hardware encode is available in the app's visible window.** The probe used a
  hidden window, where hardware encode can silently degrade to software. Affects NFR-VEX.1 only.

## UX constraints this pipeline imposes (reconcile before build, not mid-implementation)

- **Audio pitch-shifts at every S ≠ 1** → bounds DEC-VEX.4's allowed multiplier set. Owner:
  product-manager. Blocking for the speed control's offered values, not for the pipeline.
- **Frame rate for UX-VEX.1 is nominal, not exact.** It comes from
  `InputVideoTrack.computePacketStats().averagePacketRate` and `frameRateIsConstant`; screen
  recordings are frequently VFR, so "advances by exactly one frame" must be accepted as
  *nominal-frame* semantics or the criterion is unmeetable. Owner: ux-designer (DEC-VEX.5), with
  product-analyst re-wording UX-VEX.1.
- **Chromium does not support negative `playbackRate`**, so J-reverse must be seek-driven scrub.
  UX-VEX.2's "(or reverse-scrubs)" already permits this; confirm it in DEC-VEX.5 rather than
  rediscovering it mid-build.
- **Resolution presets cannot be a static list** (DEC-VEX.6). H.264 level is a function of output
  resolution — level 3.0 was rejected at 1280x720 on this build — so every offered preset must be
  runtime-validated with `canEncodeVideo` and unsupported ones disabled with a reason (FR-VEX.6).
- **GIF carries no audio track.** The export surface must state that when GIF is selected. This is
  format reality, not audio editing.

## Consequences

- Two new runtime dependencies: `mediabunny` (MPL-2.0) and `gifenc` (MIT); dep set goes 2 → 4, both
  with zero transitive runtime deps.
- Export lives in the renderer (WebCodecs is renderer-only), so main gains no codec code — but the
  renderer origin must stay a secure context, forever. Add a probe-and-refuse at editor mount.
- New IPC surface (ranged read + chunked write) is the durable part of this change; it is reusable
  by any future large-artifact export.
- H.264 level must be computed from output resolution; encoder support must be re-probed per export
  config with `canEncodeVideo`, not assumed from a static preset list.

## Hypotheses to check later (§8 outcome tracking)

- H1: the hand-driven mediabunny pipeline serves all five features without a second codec path.
  Check at first feature that needs something new (e.g. if annotation-on-video is ever unblocked).
- H2: `gifenc` in a worker holds NFR-VEX.4 without a native encoder. Check on first real GIF export.
- H3: hardware encode is available in the app's real (visible) window; the probe used a hidden
  window, where hardware encode can silently degrade to software. Re-measure NFR-VEX.1 in the app.
