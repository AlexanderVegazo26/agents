---
name: accessibility
description: WCAG 2.2-aligned accessibility practices — keyboard navigation, screen reader support, color contrast, and how to audit for conformance. Load whenever designing, implementing, or reviewing anything user-facing.
---

# Accessibility

## Build it in, don't retrofit it

Accessibility decided at design time (semantic structure, focus order, color choices) is far cheaper than an audit-and-fix pass after implementation. Treat WCAG conformance as a functional requirement, not a later polish step.

## Core checks

- **Keyboard navigation** — every interactive element reachable and operable via keyboard alone, in a sensible tab order, with a visible focus indicator.
- **Screen reader support** — semantic HTML/ARIA roles that convey structure and state, meaningful alt text, live regions for dynamic content updates.
- **Color contrast** — text and meaningful UI elements meet WCAG contrast ratios; never convey information (error, status) by color alone.
- **Text resizing/zoom** — layout doesn't break at 200% zoom or larger user font sizes.
- **Error identification** — form errors identified in text, associated with their field, not just a color change or icon.
- **Motion and animation** — respect reduced-motion preferences; no content that flashes at a rate known to trigger seizures.

## Automated vs. manual

Automated tools (axe-core, Lighthouse) catch a meaningful subset (missing alt text, contrast failures, missing labels) but miss logical/semantic issues (does the tab order actually make sense, does the screen reader announcement convey the right thing) — pair automated scanning with an actual manual keyboard/screen-reader pass for anything non-trivial.

## Conformance level

Target WCAG 2.2 AA as the default bar unless the domain requires AAA (state explicitly if so) — and treat a known, unaddressed AA failure as a defect, not a backlog nice-to-have.
