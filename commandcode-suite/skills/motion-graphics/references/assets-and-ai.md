# Motion graphics reference — Assets, rights, provenance and AI generation

Part of the `motion-graphics` skill. Section numbers match the skill's
index in SKILL.md.


# 25. Asset Management

Create an asset inventory.

Example:

``` text
/assets
  /brand
  /images
  /video
  /illustrations
  /3d
  /audio
  /music
  /voice
  /fonts
  /generated
  /references
  /exports
  /thumbnails
```

Each asset should have:
- ID
- Filename
- Type
- Source
- License/status
- Version
- Creation date
- Usage
- Notes

------------------------------------------------------------------------

# 26. Asset Rights and Provenance

Track provenance for every non-trivial asset.

## Images

Record:
- Source
- Creator/provider
- License
- URL/reference if available
- Usage restrictions

## Music

Record:
- Track
- Source
- License
- Commercial-use status
- Attribution requirement
- Territory restrictions
- Content-ID risk if known

## Fonts

Record:
- Font
- Version
- Source
- License
- Embedding restrictions

## User-Uploaded Assets

Treat user-uploaded content as authorized for the requested project unless the user states otherwise.

Do not infer ownership beyond that authorization.

## AI Assets

Record:
- Model/provider
- Model version
- Prompt
- Negative prompt if used
- Seed if available
- Generation parameters
- Date
- Reference images
- Control inputs
- Post-processing
- License/usage status

If licensing cannot be verified, mark:

`LICENSE_STATUS = UNKNOWN`

and flag it for human review.

------------------------------------------------------------------------

# 27. Watermarking

Never remove a watermark from third-party content unless the user has explicit rights and the removal is permitted.

Preserve mandatory provider watermarks where required.

Do not add an arbitrary watermark merely for appearance.

If the project requires a watermark:
- define placement,
- opacity,
- duration,
- safe area,
- localization behavior,
- and whether it applies to previews or finals.

Track watermark state in the production manifest.

------------------------------------------------------------------------

# 28. AI Generation Registry

For every AI-generated asset maintain a registry.

Example:

``` yaml
asset_id: CHAR_004
type: character
model: MODEL_NAME
model_version: VERSION
prompt: "..."
negative_prompt: "..."
seed: 123456
reference_assets:
  - REF_001
control_inputs:
  - pose_reference.png
generation_parameters:
  steps: 30
  guidance: 6.5
license_status: verified|unknown|restricted
created_at: ISO_TIMESTAMP
```

Do not lose generation metadata when reproducibility matters.

------------------------------------------------------------------------

# 29. AI Continuity Bible

For recurring AI-generated subjects define:

-   Identity
-   Face
-   Hair
-   Clothing
-   Accessories
-   Body proportions
-   Color palette
-   Materials
-   Environment
-   Lighting
-   Camera style
-   Expression style
-   Motion behavior

Maintain reference images or embeddings where supported.

------------------------------------------------------------------------

# 30. Character Identity Lock

For recurring characters:

1.  Establish a canonical reference.
2.  Lock identity-defining features.
3.  Use consistent prompts.
4.  Use reference/control inputs when available.
5.  Compare generated outputs against the canonical reference.
6.  Reject large identity drift.

Check:
- Face
- Hair
- Clothing
- Age impression
- Body proportions
- Distinctive accessories
- Skin tone
- Silhouette

------------------------------------------------------------------------

# 31. AI Artifact Detection

Inspect generated media for:
- Extra fingers
- Missing fingers
- Deformed hands
- Broken typography
- Impossible reflections
- Floating objects
- Texture crawling
- Facial instability
- Identity drift
- Frame-to-frame flicker
- Object disappearance
- Geometry deformation
- Temporal warping
- Unnatural shadows
- Inconsistent lighting
- Duplicate objects
- Broken perspective

If artifacts materially affect quality, regenerate or repair.

------------------------------------------------------------------------

# 32. Continuity

Maintain continuity across shots.

Track:
- Character position
- Screen direction
- Lighting
- Color
- Camera
- Focal length
- Object state
- Clothing
- Props
- Environment
- UI state
- Time of day
- Weather
- Motion direction

Create a continuity bible for complex productions.

------------------------------------------------------------------------

# 33. Procedural Generation

When appropriate, prefer procedural methods for:
- Text
- Shapes
- UI
- Data visualization
- Repeated objects
- Particles
- Gradients
- Motion systems
- Responsive layouts

Procedural production improves:
- consistency,
- reproducibility,
- localization,
- versioning,
- parameterization,
- and revision speed.

------------------------------------------------------------------------

# 92. AI Prompt Engineering

Prompts should specify:

``` text
SUBJECT
ACTION
ENVIRONMENT
COMPOSITION
CAMERA
LIGHTING
MATERIAL
STYLE
COLOR
MOOD
TEMPORAL BEHAVIOR
QUALITY CONSTRAINTS
```

For image/video generation, explicitly state what must remain stable.

Example structure:

``` text
Subject:
Action:
Environment:
Camera:
Lens:
Lighting:
Composition:
Style:
Color:
Motion:
Continuity constraints:
Negative constraints:
```

Avoid vague prompts when precision matters.

------------------------------------------------------------------------

# 93. Prompt Registry

Store reusable prompts.

Example:

``` yaml
prompt_id: cinematic_product_01
purpose: premium product reveal
model: MODEL
version: 3
prompt: |
  ...
negative_prompt: |
  ...
parameters:
  seed: 1234
notes: |
  Maintains product silhouette.
```

Do not modify a production-critical prompt without versioning it.

------------------------------------------------------------------------

# 94. Model Version Changes

If an AI model changes version:
- record the new model,
- rerun affected shots,
- compare output,
- inspect continuity,
- update provenance,
- do not silently mix incompatible model outputs.

A model upgrade is a production change.

------------------------------------------------------------------------

# 95. Determinism

When possible, preserve:
- seeds,
- prompts,
- model versions,
- parameters,
- source images,
- control inputs.

If generation is nondeterministic, record enough metadata to explain why exact reproduction may not be possible.

------------------------------------------------------------------------

# 122. If the User Requests AI-Generated Video

Before generation define:

``` text
MODEL
MODEL VERSION
SHOT
DURATION
ASPECT
CAMERA
SUBJECT
ACTION
STYLE
CONTINUITY
SEED
REFERENCE
NEGATIVE CONSTRAINTS
```

Generate short controlled shots rather than one huge uncontrolled generation when continuity matters.

------------------------------------------------------------------------

# 123. AI Video Continuity Strategy

For multiple AI-generated shots:

1.  Establish reference frame.
2.  Establish character/environment bible.
3.  Generate shot 1.
4.  Select canonical output.
5.  Use it as reference for shot 2.
6.  Repeat.
7.  Normalize color.
8.  Normalize motion.
9.  Edit transitions.
10. Perform temporal QA.

------------------------------------------------------------------------

# 124. AI Asset Provenance Report

For each AI asset record:

``` text
Asset ID
Model
Provider
Model Version
Prompt
Negative Prompt
Seed
Reference Inputs
Control Inputs
Generation Parameters
Post Processing
License Status
Disclosure Requirement
```

------------------------------------------------------------------------

# 125. Model and Asset License Gate

Before commercial delivery:

``` text
LICENSE_VERIFIED
or
LICENSE_UNKNOWN
or
LICENSE_RESTRICTED
```

If restricted or unknown:
- do not label the entire project commercially cleared,
- flag the asset,
- provide a replacement path.

------------------------------------------------------------------------
