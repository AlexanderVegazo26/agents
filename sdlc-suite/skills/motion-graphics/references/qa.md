# Motion graphics reference — Technical, visual, temporal, adversarial, accessibility and compliance QA

Part of the `motion-graphics` skill. Section numbers match the skill's
index in SKILL.md.


# 77. Technical QA

Before delivery inspect:

### Video

-   Resolution
-   FPS
-   Duration
-   Frame count
-   Codec
-   Pixel format
-   Bit depth
-   Color space
-   Rotation metadata
-   Aspect ratio
-   Variable/constant frame rate
-   File integrity

### Audio

-   Codec
-   Sample rate
-   Channels
-   Duration
-   Loudness
-   True peak
-   Sync
-   Clipping

### File

-   Opens correctly
-   No corruption
-   Expected size
-   Correct extension
-   Correct metadata

Use FFprobe or equivalent when available.

------------------------------------------------------------------------

# 78. Visual QA

Inspect representative frames and motion.

Check:

-   Composition
-   Alignment
-   Text
-   Safe areas
-   Contrast
-   Brand consistency
-   Character continuity
-   Object continuity
-   Lighting continuity
-   Motion smoothness
-   Transition quality
-   AI artifacts
-   Unintended frame flashes
-   Missing assets
-   Broken masks
-   Z-order errors

If actual visual inspection was not possible, explicitly state:

`VISUAL_QA = NOT_EXECUTED`

Never imply visual inspection occurred when it did not.

------------------------------------------------------------------------

# 79. Temporal QA

Check:
- Flicker
- Jitter
- Strobing
- Frame duplication
- Frame drops
- Motion discontinuities
- Object teleportation
- Temporal texture instability
- AI frame inconsistency
- Audio/video drift

For AI video, inspect multiple consecutive frames rather than only still frames.

------------------------------------------------------------------------

# 80. Adversarial QA

Try to break the production.

Ask:

-   Can any text be clipped?
-   Can any frame expose a broken transition?
-   Can an AI-generated hand be visibly wrong?
-   Does the character change between shots?
-   Does the logo distort?
-   Does localization overflow?
-   Does the CTA disappear on mobile?
-   Does the video fail if a font is unavailable?
-   Does the render fail at full resolution?
-   Does the audio clip?
-   Does the file fail to open?
-   Does the platform reject the encoding?
-   Is an asset license unknown?
-   Is a required disclosure missing?

Fix high-severity failures before delivery.

------------------------------------------------------------------------

# 81. Accessibility QA

Verify:

-   Contrast
-   Caption timing
-   Caption readability
-   Caption safe zones
-   Reduced-motion availability where required
-   Flash/strobe safety
-   Audio intelligibility
-   Visual information alternatives

------------------------------------------------------------------------

# 82. Compliance QA

Verify:

-   Rights status
-   AI model usage status
-   Music clearance
-   Font clearance
-   Image clearance
-   User asset authorization
-   Privacy
-   Claims
-   Disclosures
-   Platform-specific requirements

Classify:

``` text
PASS
WARN
BLOCK
UNKNOWN
```

------------------------------------------------------------------------
