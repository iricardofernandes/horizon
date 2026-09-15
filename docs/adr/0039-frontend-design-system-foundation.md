# 39. Frontend design system foundation

- Status: accepted
- Date: 2026-09-15

## Context

The first frontend slice mixed system sans-serif and serif typography, used text
abbreviations as navigation glyphs, styled native form controls directly, and carried a
set of one-off hexadecimal colors. Building the remaining ERP screens on that base would
multiply visual and accessibility inconsistencies.

The product needs a small, stable foundation that remains independent from a pre-styled
component kit. Components must be composable in React, keyboard accessible by default,
and styled through semantic tokens rather than literal palette values.

## Decision

The frontend uses:

- the self-hosted variable Inter font for all interface typography, with `Inter` and
  `sans-serif` as its fallback chain;
- Phosphor Icons for interface iconography;
- Base UI as the unstyled, accessible primitive layer for interactive base components;
- Radix Colors as the color source, with Sage for neutral surfaces, Jade for the accent
  and positive states, Amber for warning states, and Red for destructive and error
  states.

Radix scale values are exposed through semantic CSS aliases such as `--color-bg`,
`--color-border`, `--color-accent-solid`, and `--color-danger-text`. Feature screens
consume shared components from `web/src/components/ui` and semantic aliases; they do not
style raw interactive controls or introduce literal feature colors.

The design system owns behavior and visual states, while business rules and server
validation remain outside it.

## Consequences

Fonts are bundled with the application, so rendering does not depend on a third-party
font request. Base UI adds a frontend dependency but centralizes keyboard interaction,
focus management, form semantics, and future overlay behavior. Phosphor provides a
single visual vocabulary and avoids bespoke SVGs or text glyphs.

Semantic aliases make palette or theme changes local, and the Radix scale gives each
step a predictable job across backgrounds, controls, borders, solid actions, and text.
New primitives still require local styling and tests; Base UI intentionally does not
provide a visual theme.

## Alternatives considered

Continuing with native controls and page-level CSS keeps the dependency count smaller
but repeats accessibility and state logic across every CRUD. A pre-styled component kit
would accelerate individual screens but would own more of the product's visual language.
Radix Primitives are mature, but Base UI was selected as the common primitive contract
for this frontend; Radix is used only for its color system.
