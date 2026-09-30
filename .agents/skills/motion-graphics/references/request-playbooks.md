# Motion graphics reference — Playbooks for common request shapes

Part of the `motion-graphics` skill. Section numbers match the skill's
index in SKILL.md.


# 109. If the User Gives Only a Concept

If the user says something like:

> "Make a futuristic AI video about autonomous coding agents."

Do not immediately produce random visuals.

Instead:

1.  Infer a professional creative direction.
2.  Build a short narrative.
3.  Define visual metaphor.
4.  Create storyboard.
5.  Define production method.
6.  Generate assets where possible.
7.  Build the animation.
8.  Render if possible.
9.  Validate.
10. Deliver.

Use sensible defaults.

------------------------------------------------------------------------

# 110. If the User Gives a Detailed Specification

Treat the specification as authoritative unless it conflicts with:
- technical impossibility,
- platform limitations,
- safety/compliance requirements,
- contradictory requirements.

Preserve the user's:
- duration,
- copy,
- colors,
- branding,
- aspect ratio,
- style,
- references,
- timing.

Do not creatively change required elements without reason.

------------------------------------------------------------------------

# 111. If the User Gives Existing Assets

Reuse them intelligently.

Do not regenerate an existing logo, screenshot, or product image unless necessary.

Build around the user's assets.

Preserve source resolution where possible.

Do not repeatedly transcode source media unnecessarily.

------------------------------------------------------------------------

# 112. If the User Requests "Make It Better"

Interpret this as:

-   Improve hierarchy
-   Improve pacing
-   Improve composition
-   Improve typography
-   Improve motion
-   Improve transitions
-   Improve sound
-   Improve consistency
-   Improve polish

Do not automatically make it:
- louder,
- brighter,
- faster,
- more saturated,
- more complicated.

"Better" means clearer and more intentional, not more effects.

------------------------------------------------------------------------

# 113. If the User Requests "Make It Cinematic"

Use:
- deliberate camera movement,
- depth,
- motivated lighting,
- controlled contrast,
- atmospheric layering,
- cinematic composition,
- purposeful sound,
- restrained motion.

Do not automatically add:
- black bars,
- excessive lens flares,
- heavy grain,
- extreme depth of field,
- random slow motion.

------------------------------------------------------------------------

# 114. If the User Requests "Make It Premium"

Prioritize:
- spacing,
- typography,
- restrained color,
- clean materials,
- subtle motion,
- high-quality lighting,
- consistency,
- precise timing.

Premium design often comes from removing rather than adding.

------------------------------------------------------------------------

# 115. If the User Requests "Make It Viral"

Do not promise virality.

Instead optimize for controllable factors:
- strong opening,
- immediate context,
- concise communication,
- visual novelty,
- clear payoff,
- strong CTA,
- platform-native framing,
- fast comprehension.

Define measurable hypotheses rather than promising performance.

------------------------------------------------------------------------

# 116. If the User Requests Multiple Versions

Create a shared base project and variant configuration.

Example:

``` yaml
variant_a:
  hook: "..."
  music: "..."
  cta: "..."

variant_b:
  hook: "..."
  music: "..."
  cta: "..."
```

Avoid duplicating entire projects unnecessarily.

------------------------------------------------------------------------

# 117. If the User Requests a Loop

Design the loop at the composition level.

Do not rely on a generic crossfade.

Ensure:
- visual state continuity,
- motion continuity,
- audio continuity,
- no visible seam.

------------------------------------------------------------------------

# 118. If the User Requests Transparent Video

Verify:
- alpha-capable codec,
- alpha bit depth,
- straight vs premultiplied alpha,
- background behavior,
- downstream compatibility.

If alpha cannot be rendered, state the limitation and provide the closest valid alternative.

------------------------------------------------------------------------

# 119. If the User Requests a GIF

Treat GIF as a compatibility format, not the preferred master.

Prefer:
- MP4,
- WebM,
- ProRes,
- or another appropriate source/master.

For GIF:
- reduce palette,
- control frame rate,
- optimize dimensions,
- validate file size.

Do not use GIF as the archival master.

------------------------------------------------------------------------

# 120. If the User Requests 3D Product Animation

Build:

``` text
PRODUCT MODEL
→ MATERIALS
→ LIGHTING
→ CAMERA
→ ANIMATION
→ ENVIRONMENT
→ COMPOSITING
→ COLOR
→ SOUND
```

Prioritize product accuracy over spectacle.

------------------------------------------------------------------------

# 121. If the User Requests Data/Charts

Treat data as source-of-truth.

Create:
- data manifest,
- source reference,
- date,
- units,
- calculation logic.

Animate values without changing their meaning.

------------------------------------------------------------------------
