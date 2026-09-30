---
name: motion-graphics
version: 1.0.0
description: Production method for motion-graphics video — requirements, creative direction, script, storyboard, shot and asset plans, animation, sound, rendering, encoding, accessibility, QA and delivery — held to what the environment can actually render and verify. Load when producing, planning or reviewing an animated video, explainer, product or logo animation, social clip, animated chart, loop or GIF. Do NOT use for a single still image or mockup (that is `image-generation`), for in-product UI states and transitions that ship as application code (that is `interaction-design`), or to show what a running app looks like (that is a screenshot or screen recording of the app itself).
---

# Motion Graphics Production Skill

## Purpose

This skill covers the whole motion-graphics craft — direction, design, animation, editing, sound, VFX, technical direction, AI-assisted production and video QA — for whichever agent loads it.

Its job is to transform any user-provided concept, message, product, brand, story, script, visual reference, or technical specification into the strongest practical motion-graphics video possible within the actual capabilities of the current environment.

The production pipeline is:

**IDEA → REQUIREMENTS → CREATIVE DIRECTION → SCRIPT → STORYBOARD → SHOT PLAN → ASSET PLAN → PRODUCTION → PREVIEW → QA → REVISION → FINAL RENDER → DELIVERY**

The goal is not merely to create something visually impressive.

The goal is to produce a:

**CREATIVE + TECHNICALLY VALID + ACCESSIBLE + TRACEABLE + REPRODUCIBLE + DELIVERABLE**

motion-graphics production.

------------------------------------------------------------------------

## How this skill is organised

This file holds the operating core: the execution contract, capability
discovery, truthfulness, requirements, defaults, approval gates, failure and
recovery, the state machine and decision tree, the final QA report and the
final response protocol. Read it in full.

The rest is reference, split by topic. Section numbers are stable across files.
Read a file when the production reaches its topic, not before:

| Sections | File | Read when |
|---|---|---|
| 8–24, 88–91 | `references/creative-direction.md` | shaping concept, narrative, storyboard, timing, type, 2D/3D, camera, transitions, VFX, sound, voice, music, brand |
| 25–33, 92–95, 122–125 | `references/assets-and-ai.md` | sourcing, licensing or generating any asset, or using AI image/video/voice models |
| 34–46, 56–62, 84–85, 96–101 | `references/rendering-and-delivery.md` | choosing tools, rendering, encoding, audio delivery, loudness, colour, file naming, versioning, packaging, security |
| 47–55 | `references/accessibility-and-platforms.md` | safe areas, captions, reduced motion, localization, platform variants |
| 64–68, 102–105 | `references/compliance.md` | disclosure, privacy, restricted content, advertising claims, user-supplied references or footage, product accuracy, data visualisation |
| 77–82 | `references/qa.md` | running technical, visual, temporal, adversarial, accessibility or compliance QA |
| 69–74 | `references/distribution.md` | analytics, CTAs, A/B variants, end cards, thumbnails, loops |
| 109–121 | `references/request-playbooks.md` | the request matches a known shape ("make it cinematic", "a GIF", "3D product animation", "AI-generated video", …) |

------------------------------------------------------------------------

# 1. Core Philosophy

Prioritize:

1.  Communication
2.  Visual hierarchy
3.  Composition
4.  Motion quality
5.  Timing and rhythm
6.  Brand consistency
7.  Readability
8.  Technical correctness
9.  Accessibility
10. Traceability
11. Reproducibility
12. Efficient production

Never add an effect merely because it is possible.

Every animation should have a purpose.

Every transition should support the story.

Every visual element should either:
- communicate information,
- establish atmosphere,
- reinforce branding,
- direct attention,
- or support the emotional tone.

Do not confuse:

> More effects

with:

> Better motion design.

Design first. Animate second. Render third. Validate last.

------------------------------------------------------------------------

# 2. Execution Contract

Before production, establish what the current environment can actually do.

Never assume a tool, API, codec, model, renderer, or hardware capability exists.

Determine:

-   Available tools
-   Available APIs
-   Available rendering engines
-   Available codecs
-   Available image generation
-   Available video generation
-   Available audio generation
-   Available voice generation
-   Available fonts
-   Available project frameworks
-   CPU/GPU/RAM/storage
-   Network availability
-   Maximum practical render resolution
-   Maximum practical duration
-   Preview limitations
-   Final-render limitations
-   Output formats
-   Alpha-channel support
-   Audio capabilities

If something cannot be verified, mark it `UNKNOWN`.

Never invent capabilities.

## 2.1 Execution Modes

### Full Production

The environment can:
- create assets,
- build the project,
- render video,
- inspect the output,
- validate it,
- and produce deliverables.

### Procedural Production

The environment can create source projects/code and may be able to render them.

### Assisted Production

The environment can produce the complete creative and technical package but cannot execute every rendering step.

### Pre-Production Only

The environment can create:
- creative direction,
- script,
- storyboard,
- shot list,
- asset specifications,
- prompts,
- technical specifications.

Never claim a final video exists unless a final video was actually rendered.

------------------------------------------------------------------------

# 3. Capability Discovery

Create an internal capability matrix before production when the environment permits inspection.

| Capability | Available | Tool | Version | Limitation |
|---|---|---|---|---|
| Video rendering | Yes/No | | | |
| Image generation | Yes/No | | | |
| Video generation | Yes/No | | | |
| Audio generation | Yes/No | | | |
| Voice generation | Yes/No | | | |
| FFmpeg | Yes/No | | | |
| FFprobe | Yes/No | | | |
| Blender | Yes/No | | | |
| Remotion | Yes/No | | | |
| After Effects | Yes/No | | | |
| DaVinci Resolve | Yes/No | | | |
| GPU | Yes/No | | | |
| Hardware acceleration | Yes/No | | | |

Potential technologies include FFmpeg, Blender, Remotion, After Effects, Premiere, DaVinci Resolve, Rive, Three.js, WebGL, SVG, Canvas, Python, TypeScript, image models, video models, music models, and TTS systems.

Use only tools actually available.

------------------------------------------------------------------------

# 4. Execution Truthfulness

Track production state explicitly:

``` text
SPECIFIED
→ DESIGNED
→ STORYBOARDED
→ ASSETS_READY
→ BUILT
→ PREVIEW_RENDERED
→ QA_REVIEWED
→ REVISED
→ FINAL_RENDERED
→ FINAL_VALIDATED
→ DELIVERED
```

These states are not interchangeable.

-   Storyboard created ≠ video created.
-   Source code created ≠ video rendered.
-   Video rendered ≠ video validated.
-   Video validated ≠ legal clearance.
-   AI asset generated ≠ licensed for every use case.

Never claim a stage was completed when it was not.

------------------------------------------------------------------------

# 5. Requirement Extraction

Convert the user's request into a structured production brief.

## Content

Extract:
- Subject
- Story
- Message
- Required information
- Required text
- Product/service
- CTA
- Brand
- Audience
- References

## Style

Identify:
- Minimal
- Corporate
- Premium
- Futuristic
- Cinematic
- Editorial
- Playful
- Technical
- Luxury
- Retro
- 2D
- 3D
- Isometric
- Flat
- Hand-drawn
- UI/product
- Experimental

## Motion

Determine whether motion should feel:
- Calm
- Elegant
- Energetic
- Aggressive
- Mechanical
- Organic
- Fluid
- Elastic
- Precise
- Cinematic
- Fast

## Technical

Extract:
- Duration
- Resolution
- Aspect ratio
- FPS
- Codec
- Container
- Audio
- Color space
- Platform
- Safe zones
- Captions
- Localization
- Alpha
- Loop requirements

------------------------------------------------------------------------

# 6. Default Assumptions

If the user does not specify otherwise:

``` text
Resolution: 1920×1080
Aspect ratio: 16:9
FPS: 30
Container: MP4
Codec: H.264
Audio: AAC
Audio sample rate: 48 kHz
Color: Rec.709 SDR
Safe margin: 10%
Motion: Smooth, intentional easing
```

Platform-specific requirements override these defaults.

Do not silently change resolution, duration, FPS, quality, or audio because of resource constraints.

------------------------------------------------------------------------

# 7. Question Policy

Do not block production because of trivial missing information.

Proceed with professional assumptions when possible.

Ask only when missing information materially changes the outcome, such as:
- unknown mandatory duration,
- missing critical source footage,
- missing required logo,
- conflicting aspect ratios,
- unclear target platform,
- conflicting brand requirements.

Document assumptions.

------------------------------------------------------------------------

# 63. Approval Gates

Use explicit approval stages.

### Gate 1 --- Creative

Approve:
- concept,
- visual direction,
- style,
- storyboard.

### Gate 2 --- Animatic

Approve:
- timing,
- pacing,
- VO,
- music,
- scene order.

### Gate 3 --- Look Development

Approve:
- colors,
- typography,
- materials,
- lighting,
- visual effects.

### Gate 4 --- Preview

Approve:
- animation,
- transitions,
- audio,
- composition.

### Gate 5 --- Final

Approve:
- technical output,
- accessibility,
- captions,
- licensing,
- compliance,
- final delivery.

Do not proceed past a blocking approval without authorization.

------------------------------------------------------------------------

# 75. Failure Modes

Handle at least:

### Missing Asset

Action:
1. Identify dependency.
2. Determine whether a substitute is acceptable.
3. If not, stop that dependency.
4. Flag the missing asset.

### Generation Failure

Action:
1. Retry if transient.
2. Change seed if useful.
3. Simplify prompt.
4. Change generation strategy.
5. Use a procedural fallback when possible.

### Audio Desync

Check:
- FPS
- sample rate
- timebase
- variable frame rate
- export settings.

### Text Overflow

Fix:
- typography,
- line breaks,
- font size,
- layout,
- localization logic.

Do not simply crop text.

### Oversized Render

Optimize:
- codec,
- bitrate,
- resolution,
- frame rate,
- redundant streams,
- intermediate format.

Preserve a high-quality master when appropriate.

### Platform Rejection

Identify the reason.

Do not repeatedly submit an unchanged rejected file.

### Missing Codec

Use an available equivalent and document the difference.

### Out of Memory

Reduce:
- parallel renders,
- texture resolution,
- particle count,
- samples,
- scene complexity.

### License Unknown

Do not silently use it in a supposedly cleared final.

Mark for review.

------------------------------------------------------------------------

# 76. Recovery Strategy

When production fails:

``` text
FAILURE
→ IDENTIFY ROOT CAUSE
→ DETERMINE SCOPE
→ PRESERVE WORK
→ APPLY MINIMUM FIX
→ REBUILD AFFECTED STAGE
→ REVALIDATE
```

Never restart the entire project unnecessarily.

------------------------------------------------------------------------

# 83. Final QA Report

Produce a report containing:

``` text
Project
Version
Duration
Resolution
FPS
Color
Codec
Audio
Loudness
Captions
Accessibility
Assets
Licensing
AI provenance
Platform compliance
Visual QA
Technical QA
Known issues
Warnings
Open approvals
Final status
```

Example:

``` text
FINAL STATUS: PASS WITH WARNINGS

Technical: PASS
Visual: PASS
Audio: PASS
Accessibility: PASS
Licensing: WARN
Platform: PASS

Warning:
One AI-generated background has UNKNOWN commercial-use licensing.
Human review required before paid advertising.
```

------------------------------------------------------------------------

# 86. Project State Machine

Use explicit state transitions:

``` text
DRAFT
  ↓
CREATIVE_APPROVED
  ↓
STORYBOARD_APPROVED
  ↓
ANIMATIC_APPROVED
  ↓
ASSETS_READY
  ↓
BUILD_COMPLETE
  ↓
PREVIEW_RENDER
  ↓
VISUAL_QA
  ↓
TECHNICAL_QA
  ↓
COMPLIANCE_QA
  ↓
FINAL_RENDER
  ↓
FINAL_VALIDATION
  ↓
DELIVERED
```

A failed validation moves the project back to the appropriate correction stage.

------------------------------------------------------------------------

# 87. Production Decision Tree

Use this sequence:

``` text
1. Is the request clear?
   ├─ Yes → continue
   └─ No → ask only blocking questions

2. Can the environment execute the requested production?
   ├─ Yes → build
   └─ No → produce the highest-value executable package

3. Is procedural animation sufficient?
   ├─ Yes → prefer procedural
   └─ No → evaluate 3D/AI/video generation

4. Are external assets needed?
   ├─ Yes → verify provenance
   └─ No → continue

5. Is localization required?
   ├─ Yes → architect for localization
   └─ No → continue

6. Is accessibility required?
   ├─ Yes → integrate from beginning
   └─ No → still apply basic readability principles

7. Is final render complete?
   ├─ Yes → validate
   └─ No → do not claim completion

8. Does QA pass?
   ├─ Yes → deliver
   └─ No → repair and revalidate
```

------------------------------------------------------------------------

# 106. Human Review Triggers

Require human review when:

-   Rights are uncertain
-   Legal claims are present
-   Medical/financial/legal claims are present
-   Synthetic media disclosure may be required
-   A real person is depicted
-   A real person's voice is synthesized
-   Brand guidelines are ambiguous
-   Final color accuracy is critical
-   Platform rules are uncertain
-   A client approval is required
-   The user requests an exact imitation of another creator's work
-   A required asset is missing
-   The environment cannot verify the final output

------------------------------------------------------------------------

# 107. Final Production Checklist

Before declaring delivery:

## Creative

-   [ ] Story is clear
-   [ ] Visual hierarchy works
-   [ ] Pacing works
-   [ ] CTA is clear
-   [ ] Branding is consistent

## Motion

-   [ ] Easing is intentional
-   [ ] No unnecessary motion
-   [ ] No broken transitions
-   [ ] No temporal artifacts
-   [ ] Continuity is consistent

## Typography

-   [ ] No clipping
-   [ ] No overflow
-   [ ] Correct fonts
-   [ ] Correct hierarchy
-   [ ] Readable at target size

## Audio

-   [ ] VO correct
-   [ ] Music correct
-   [ ] SFX correct
-   [ ] No clipping
-   [ ] Loudness validated
-   [ ] Sync correct

## Video

-   [ ] Correct duration
-   [ ] Correct resolution
-   [ ] Correct FPS
-   [ ] Correct codec
-   [ ] Correct color
-   [ ] Correct aspect ratio

## Accessibility

-   [ ] Captions
-   [ ] Contrast
-   [ ] Safe areas
-   [ ] Reduced motion if required
-   [ ] No dangerous flashing

## Rights

-   [ ] Music
-   [ ] Images
-   [ ] Fonts
-   [ ] AI models/assets
-   [ ] User assets
-   [ ] Logos
-   [ ] Third-party content

## Compliance

-   [ ] Claims reviewed
-   [ ] Privacy reviewed
-   [ ] Prohibited/restricted content reviewed
-   [ ] Disclosure reviewed
-   [ ] Platform requirements checked

## Delivery

-   [ ] Master
-   [ ] Distribution version
-   [ ] Captions
-   [ ] Thumbnail
-   [ ] Source/project
-   [ ] Manifest
-   [ ] QA report
-   [ ] Checksums where appropriate

------------------------------------------------------------------------

# 108. Final Response Protocol

After production, report only what was actually completed.

Use:

``` text
STATUS:
PROJECT:
VERSION:

CREATED:
- ...

RENDERED:
- ...

VALIDATED:
- ...

DELIVERABLES:
- ...

ASSUMPTIONS:
- ...

WARNINGS:
- ...

HUMAN REVIEW REQUIRED:
- ...

KNOWN LIMITATIONS:
- ...
```

If the final video was not rendered, say so.

If only a project/source package was created, say so.

If QA could not be performed, say so.

Never use language that implies execution when only planning occurred.

------------------------------------------------------------------------

# 126. Final Delivery Principle

The production is complete only when:

``` text
THE VIDEO LOOKS GOOD
+
THE VIDEO COMMUNICATES CLEARLY
+
THE VIDEO PLAYS CORRECTLY
+
THE AUDIO WORKS
+
THE FILE IS VALID
+
THE ASSETS ARE TRACEABLE
+
THE REQUIRED RIGHTS/REVIEWS ARE ADDRESSED
+
THE DELIVERABLE MATCHES THE REQUEST
```

A beautiful broken file is not a successful production.

A technically perfect but confusing video is not a successful production.

The final objective is:

**intentional creative quality backed by production discipline.**

------------------------------------------------------------------------

# 127. Operating Rule

When forced to choose between:

``` text
MORE COMPLEXITY
vs
MORE CLARITY
```

choose clarity.

When forced to choose between:

``` text
UNVERIFIED CLAIM
vs
TRANSPARENT LIMITATION
```

choose transparency.

When forced to choose between:

``` text
FAST HACK
vs
REPRODUCIBLE PRODUCTION
```

choose reproducibility when practical.

When forced to choose between:

``` text
EFFECT
vs
STORY
```

choose story.

When forced to choose between:

``` text
PRETENDING THE JOB IS COMPLETE
vs
REPORTING THE ACTUAL STATE
```

always report the actual state.

**Build with taste. Animate with purpose. Render with discipline. Validate everything.**
