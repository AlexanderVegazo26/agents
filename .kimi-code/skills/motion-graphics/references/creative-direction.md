# Motion graphics reference — Creative direction, animation, type, sound

Part of the `motion-graphics` skill. Section numbers match the skill's
index in SKILL.md.


# 8. Creative Direction

Before animation, define:

## Concept

One sentence explaining the visual idea.

## Visual Language

Define:
- Palette
- Typography
- Shapes
- Texture
- Lighting
- Background
- Depth
- Composition
- Camera language
- Motion language

## Motion Language

Define:
- Primary easing
- Secondary easing
- Transition behavior
- Camera behavior
- Object behavior
- Scale behavior
- Blur behavior
- Particle behavior
- UI behavior

## Design Principle

Every scene should answer:

> What should the viewer notice first, second, and third?

------------------------------------------------------------------------

# 9. Narrative Structure

Use an appropriate structure.

### Short Social Video

``` text
HOOK
→ CONTEXT
→ VALUE
→ PROOF/DEMONSTRATION
→ CTA
```

### Product Video

``` text
PROBLEM
→ PRODUCT INTRO
→ CORE FEATURES
→ DIFFERENTIATION
→ RESULT
→ CTA
```

### Brand Video

``` text
EMOTION
→ IDENTITY
→ STORY
→ PROMISE
→ BRAND REVEAL
```

### Explainer

``` text
PROBLEM
→ WHY IT MATTERS
→ HOW IT WORKS
→ BENEFITS
→ NEXT STEP
```

These are defaults, not rigid templates.

------------------------------------------------------------------------

# 10. Storyboard

Create a storyboard before complex production.

For every shot specify:

| Field | Description |
|---|---|
| Shot ID | Unique ID |
| Timecode | Start/end |
| Duration | Seconds |
| Purpose | Why shot exists |
| Visual | What appears |
| Camera | Camera movement |
| Animation | Object movement |
| Text | Exact copy |
| Audio | Music/SFX/VO |
| Transition | Entry/exit |
| Assets | Required assets |
| Generation | Model/tool if AI |
| QA | Special checks |

Example:

``` text
S03
00:04.20–00:07.50
Purpose: Explain core mechanism
Visual: Product interface assembles from modular panels
Camera: Slow 3D push-in
Animation: Panels slide + overshoot + settle
Text: "One workflow. Every team."
Audio: UI clicks + low riser
Transition: Match cut
```

------------------------------------------------------------------------

# 11. Timing and Pacing

Use intentional timing.

Typical principles:

-   Establishing shot: slower
-   Information reveal: moderate
-   CTA: clear and deliberate
-   Hook: fast enough to establish interest
-   Emotional moment: allow breathing room
-   Complex information: slow down
-   Repetitive UI animation: accelerate

Do not cram text simply to fit the script.

If the narration is too fast for the visuals, revise the script or extend the shot.

------------------------------------------------------------------------

# 12. Animation Principles

Use professional animation principles:

-   Anticipation
-   Follow-through
-   Overshoot
-   Ease-in
-   Ease-out
-   Secondary motion
-   Staging
-   Timing
-   Spacing
-   Squash and stretch where appropriate
-   Motion blur where appropriate
-   Parallax
-   Depth
-   Hierarchical motion

Avoid mechanical linear interpolation unless deliberately chosen.

------------------------------------------------------------------------

# 13. Typography

Typography must be treated as motion design.

Define:
- Typeface
- Weight
- Size hierarchy
- Line height
- Tracking
- Alignment
- Text animation
- Safe zone
- Contrast

Use hierarchy such as:

``` text
HERO
↓
SUPPORTING MESSAGE
↓
DETAIL
↓
CTA
```

Do not animate every word unless the style requires it.

Never sacrifice readability for animation.

------------------------------------------------------------------------

# 14. Text Overflow Rules

Before final render verify:

-   No clipping
-   No overflow
-   No unintended wrapping
-   No overlapping UI
-   No text outside safe zones
-   No broken glyphs
-   No missing fonts
-   No unexpected substitutions

For localization, assume text may expand.

Do not hardcode layouts that only work for one language when localization is expected.

------------------------------------------------------------------------

# 15. 2D Motion Design

For 2D work use:
- Shape layers
- SVG
- Vector assets
- Masks
- Path animation
- Morphing
- Kinetic typography
- Procedural gradients
- Particle systems
- Noise
- Texture
- Parallax

Maintain a consistent design system.

------------------------------------------------------------------------

# 16. 3D Motion Design

When using 3D define:

-   Coordinate system
-   Camera
-   Lens
-   Focal length
-   Lighting
-   Materials
-   Environment
-   Depth of field
-   Motion blur
-   Shadows
-   Reflections
-   Render engine
-   Samples
-   Resolution

Use physically plausible lighting unless a stylized look is intended.

Avoid unnecessary geometry complexity.

Prefer optimized geometry, instancing, procedural materials, and reusable assets.

------------------------------------------------------------------------

# 17. Camera Language

Use camera movement intentionally.

Examples:
- Push-in = importance/intimacy
- Pull-out = reveal/context
- Orbit = product exploration
- Pan = information progression
- Tilt = vertical reveal
- Rack focus = attention shift
- Parallax = depth
- Static = authority/clarity

Do not continuously move the camera simply to make the video feel active.

------------------------------------------------------------------------

# 18. UI and Product Motion

For interfaces:

-   Preserve information hierarchy.
-   Use realistic interaction timing.
-   Avoid impossible cursor behavior.
-   Avoid instantaneous state changes unless stylistically intentional.
-   Use micro-interactions sparingly.
-   Highlight the important element before zooming.
-   Maintain consistent spacing.

If a product UI is recreated from a screenshot, do not invent functionality that the source does not support unless explicitly requested.

------------------------------------------------------------------------

# 19. Logos and Brand Assets

Preserve:
- Proportions
- Aspect ratio
- Brand colors
- Clear space
- Minimum size
- Orientation
- Approved variants

Do not distort logos.

Do not redraw a logo when the supplied asset is available.

Do not invent brand rules.

If official guidelines are supplied, they override generic design preferences.

------------------------------------------------------------------------

# 20. Transitions

Choose transitions based on meaning.

Useful transitions:
- Cut
- Dissolve
- Match cut
- Shape morph
- Wipe
- Mask reveal
- Camera movement
- Object occlusion
- Light transition
- Glitch
- Digital scan
- Particle dissolve

Do not use a different transition in every shot.

A consistent transition language is more professional.

------------------------------------------------------------------------

# 21. VFX

Use VFX selectively:

-   Glow
-   Bloom
-   Lens effects
-   Light rays
-   Particles
-   Smoke
-   Fog
-   Distortion
-   Chromatic aberration
-   Film grain
-   Noise
-   Depth effects

VFX must not reduce:
- readability,
- brand clarity,
- contrast,
- or visual hierarchy.

------------------------------------------------------------------------

# 22. Sound Design

Sound is part of the design.

Create or specify:
- Music
- Ambience
- Foley
- UI sounds
- Impacts
- Risers
- Whooshes
- Transitions
- Silence

Audio should reinforce motion rather than merely fill silence.

Synchronize important:
- transitions,
- impacts,
- text reveals,
- logo moments,
- UI actions,
- camera changes.

------------------------------------------------------------------------

# 23. Voiceover

If VO is requested:

Define:
- Speaker identity
- Language
- Accent
- Gender if specified
- Age impression
- Tone
- Pace
- Emotion
- Pronunciation
- Pauses

Voiceover must match the timing of the visual sequence.

Never stretch or compress audio unnaturally merely to fit a fixed timeline.

If the voice system is unavailable, produce the VO script and timing specification rather than pretending audio was generated.

------------------------------------------------------------------------

# 24. Music

Music should support the intended emotion and pacing.

Specify:
- Genre
- Tempo
- BPM
- Key if relevant
- Energy curve
- Instrumentation
- Intro
- Build
- Climax
- Outro

Use licensed, generated, user-supplied, or public-domain music only when permitted by the intended usage.

------------------------------------------------------------------------

# 88. Creative Quality Rules

Avoid:
- Random camera movement
- Excessive glow
- Excessive particles
- Unmotivated glitches
- Overuse of zooms
- Unreadable kinetic typography
- Generic AI imagery
- Repetitive transitions
- Excessive depth of field
- Poor contrast
- Unnecessary lens flares
- Template-like visual rhythm

Prefer:
- Intentional composition
- Strong hierarchy
- Controlled contrast
- Consistent motion
- Clear storytelling
- Elegant transitions
- Purposeful sound
- Meaningful visual metaphors

------------------------------------------------------------------------

# 89. Motion Hierarchy

Not everything should move at the same intensity.

Define:

``` text
PRIMARY MOTION
SECONDARY MOTION
TERTIARY MOTION
BACKGROUND MOTION
```

Primary motion gets the viewer's attention.

Secondary motion supports it.

Tertiary motion adds polish.

Background motion should never compete with the message.

------------------------------------------------------------------------

# 90. Visual Metaphor

When explaining abstract concepts, prefer visual metaphors.

Examples:

### Growth

-   Expanding geometry
-   Rising graph
-   Increasing scale

### Speed

-   Directional streaks
-   Rapid state transitions
-   Accelerating objects

### Security

-   Shield
-   Layering
-   Controlled access
-   Locked architecture

### AI

Avoid defaulting to:
- glowing brain,
- robot face,
- blue neural network,
- random circuit board.

Instead use the actual concept:
- orchestration,
- reasoning,
- transformation,
- automation,
- inference,
- collaboration,
- data flow.

------------------------------------------------------------------------

# 91. Brand Consistency

Create a mini design system:

``` yaml
colors:
  primary:
  secondary:
  accent:
  background:

typography:
  heading:
  body:
  mono:

spacing:
  unit:

motion:
  primary_ease:
  duration_fast:
  duration_medium:
  duration_slow:

shapes:
  radius:
  stroke:
```

Reuse the system across scenes.

------------------------------------------------------------------------
