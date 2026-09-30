# Motion graphics reference — Safe areas, accessibility, captions, localization, platforms

Part of the `motion-graphics` skill. Section numbers match the skill's
index in SKILL.md.


# 47. Safe Areas

Maintain conservative internal safe margins unless verified platform-specific safe zones are supplied.

For final platform delivery:
1. Identify the target platform.
2. Verify its current UI overlays/safe-area requirements.
3. Apply platform-specific guides.
4. Keep essential text and CTA away from interface overlays.
5. Do not hardcode stale platform dimensions as universal truth.

For multi-platform projects, create platform-specific variants rather than forcing one composition to fit all platforms.

------------------------------------------------------------------------

# 48. Accessibility

Check:

-   Contrast
-   Font size
-   Reading speed
-   Caption timing
-   Caption contrast
-   Audio intelligibility
-   Visual-only information
-   Motion intensity
-   Flashing
-   Rapid strobing
-   Reduced-motion requirements

Avoid unnecessary flashing/strobing.

If an important message exists only visually, provide an accessible equivalent when appropriate.

------------------------------------------------------------------------

# 49. Captions

Support:
- SRT
- VTT
- Burned-in captions

Maintain:

``` text
caption timing
speaker changes
line length
safe zone
contrast
readability
```

Do not assume burned-in captions are equivalent to sidecar captions.

When possible deliver both.

------------------------------------------------------------------------

# 50. Reduced Motion

When accessibility requires it, create a reduced-motion variant.

Reduce:
- camera movement,
- rapid scaling,
- excessive parallax,
- flashing,
- aggressive transitions.

Preserve the communication.

------------------------------------------------------------------------

# 51. Localization

Design layouts for localization from the beginning.

Account for:
- text expansion,
- text contraction,
- different line breaks,
- different punctuation,
- RTL languages,
- font availability,
- date formats,
- number formats,
- currency,
- voiceover timing.

Never rasterize text unnecessarily when localization is expected.

------------------------------------------------------------------------

# 52. Localization Architecture

Separate:

``` text
CONTENT
STYLE
LAYOUT
ANIMATION
```

so text can be replaced without rebuilding the entire composition.

Use localization keys when appropriate:

``` text
hero.title
hero.subtitle
cta.primary
feature.01
feature.02
```

Create language variants without duplicating unrelated production logic.

------------------------------------------------------------------------

# 53. Voice Localization

For each language track:
- use native-quality pronunciation,
- preserve meaning,
- preserve timing where possible,
- adjust visuals when timing changes.

Never force translated VO into the original timing if it causes unnatural speech.

------------------------------------------------------------------------

# 54. Platform Variants

When requested, produce variants such as:

``` text
16:9
9:16
1:1
4:5
```

Recompose rather than simply crop when possible.

Vertical video may require:
- larger typography,
- different subject framing,
- different CTA placement,
- different safe zones,
- different pacing.

------------------------------------------------------------------------

# 55. Platform-Specific Delivery

For each platform define:

``` text
PLATFORM
ASPECT_RATIO
RESOLUTION
FPS
CODEC
BITRATE
AUDIO
SAFE_ZONE
CAPTION_MODE
DURATION_LIMIT
FILE_SIZE_LIMIT
THUMBNAIL_REQUIREMENTS
```

Use current official platform specifications when accessible.

If not verified, mark the specification as provisional.

------------------------------------------------------------------------
