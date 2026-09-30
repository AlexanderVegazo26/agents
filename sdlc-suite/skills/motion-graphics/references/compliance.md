# Motion graphics reference — Compliance, disclosure, privacy, claims, user-supplied material

Part of the `motion-graphics` skill. Section numbers match the skill's
index in SKILL.md.


# 64. Compliance and Risk

Review:
- Platform policy
- Advertising claims
- Copyright
- Music licensing
- Font licensing
- Image licensing
- Model licensing
- Privacy
- Personal data
- Trademarks
- Product claims
- Synthetic media disclosure
- Required disclaimers

Do not provide legal conclusions.

Flag issues requiring human/legal review.

------------------------------------------------------------------------

# 65. Synthetic Media Disclosure

If synthetic or AI-generated content materially represents:
- people,
- events,
- products,
- environments,
- voices,
- or statements,

determine whether disclosure is required by:
- the platform,
- the client,
- applicable policy,
- or applicable law.

If uncertain:

`SYNTHETIC_MEDIA_DISCLOSURE = HUMAN_REVIEW_REQUIRED`

Never hide required disclosures.

------------------------------------------------------------------------

# 66. Privacy

Do not expose:
- private personal information,
- credentials,
- confidential documents,
- private identifiers,
- sensitive personal data

without authorization.

When user-uploaded media contains people, use it only for the requested production purpose.

Avoid unnecessary biometric inference or identification.

------------------------------------------------------------------------

# 67. Prohibited and Restricted Content

Some requests must be refused or escalated rather than produced.

Refuse or escalate when the requested video involves:

- Non-consensual deepfakes or voice cloning of a real, identifiable person
- Fabricated statements, endorsements, or actions attributed to real people or organizations
- Misinformation presented as fact about elections, public health, emergencies, or ongoing events
- Sexual content involving minors or non-consensual sexual imagery
- Hate, harassment, or demeaning depictions of protected groups
- Glorification of violence, self-harm, or instructions for illegal activity
- Impersonation of a brand or individual intended to deceive
- Circumvention of platform rules, watermarks, DRM, or attribution requirements

When content is restricted rather than outright prohibited:

- Apply the synthetic media disclosure rules
- Use licensed or explicitly authorized likenesses and voices only
- Label conceptual, simulated, or future features as such
- Escalate to human review whenever classification is uncertain

Never silently comply with a prohibited request.

Never claim a compliance review occurred when it did not.

When declining, explain the boundary and offer the closest permissible alternative.

# 68. Advertising Claims

If the video makes claims such as:
- "fastest",
- "best",
- "number one",
- "guaranteed",
- "clinically proven",
- "saves 50%",
- "zero risk",

require evidence or flag the claim for review.

Do not invent proof, statistics, certifications, testimonials, or endorsements.

------------------------------------------------------------------------

# 102. User-Supplied References

When a user provides a visual reference:

Use it to understand:
- style,
- composition,
- pacing,
- typography,
- lighting,
- motion,
- mood.

Do not blindly copy distinctive copyrighted creative work when the request would create an unauthorized imitation.

Extract principles rather than mechanically reproducing another creator's work.

------------------------------------------------------------------------

# 103. User-Supplied Video

If source footage is provided:
- inspect duration,
- resolution,
- FPS,
- codec,
- audio,
- color,
- aspect ratio,
- orientation.

Do not assume source footage is constant-frame-rate.

If VFR footage is involved, account for it during editing and synchronization.


For handling user footage safely — probing, whitelists, file names — see §100.1 in `rendering-and-delivery.md`.

------------------------------------------------------------------------

# 104. Product Accuracy

When animating a real product:
- preserve shape,
- preserve logo,
- preserve controls,
- preserve UI,
- preserve proportions,
- preserve known features.

Do not invent product capabilities.

If an animation visualizes a conceptual future feature, label it appropriately.

------------------------------------------------------------------------

# 105. Data Visualization

For charts and statistics:
- preserve numerical accuracy,
- use proportional visual encoding,
- label axes,
- identify units,
- identify time period,
- identify source when required.

Never visually exaggerate a statistic by distorting scale unless clearly intentional and explicitly labeled.

------------------------------------------------------------------------
