# 78. Neutral surfaces, one accent, and edges that catch the light

- Status: accepted. Supersedes the type and colour choices of
  [ADR 0039](0039-frontend-design-system-foundation.md); its choice of Base UI and Phosphor
  stands.
- Date: 2026-10-06

## Context

ADR 0039 gave the frontend Inter, Radix Sage for surfaces and Radix Jade for both the accent
and every positive state. It was consistent, and it looked like the default of the kit it
came from: a green-tinted gray, a green primary button whose white label sat at about 3:1,
tracked-out capitals on every table header and badge, and a different corner radius on
almost every component (5, 6, 8, 9, 10, 11, 12, 14, 17, 18 and 24 px).

Two things were wrong beyond taste:
- one hue carried two meanings. A Jade button was an action and a Jade badge was a success,
  so a reader could not tell "you can do this" from "this went well" by colour;
- `styles.css` reached past the semantic aliases about 150 times, straight into
  `--sage-N`, `--jade-N`, `--amber-N` and `--red-N`, so the palette could not be changed in
  one place, which is the property the aliases existed to give.

The replacement was chosen from three prototypes built on measurements of interfaces the
product should sit beside, rather than from a palette picked in the abstract.

## Decision

The frontend's visual language is:

- **Neutrals without a hue.** Page `#f1f1f1`, surface `#fdfdfd`, sunken `#e2e2e2`, text
  `#1b1b1b`. Gray carries the interface; it never competes with a state.
- **One accent, and it only means action.** Blue `#2d68ff` for the primary button, focus,
  selection and links. Green, amber and red have their own tokens (`--color-success-*`,
  `--color-warning-*`, `--color-danger-*`) and only ever mean a state.
- **Lit edges instead of drop shadows.** A surface is lit along its top edge and shaded
  along its bottom one (`--shadow-edge`); controls add a one-pixel ring
  (`--shadow-control`). Only a popup or a dialog casts a real shadow (`--shadow-raised`).
  A field or a checkbox keeps a one-pixel border that reaches 3:1 against the surface
  (`--color-border-control`), because its edge is what says where to type.
- **Six radii, by role.** `--radius-xs` 6, `--radius-sm` 8, `--radius-control` 12,
  `--radius-card` 16, `--radius-xl` 24 and `--radius-pill`. Buttons and tabs are pills,
  fields are controls, panels are cards.
- **DM Sans, self-hosted**, at weights 400, 500 and 600, with tabular figures everywhere
  and a slight negative tracking. Labels are sentence case; nothing is set in capitals.
- **State in two channels.** A badge carries a dot as well as a colour.
- **Motion that answers the hand.** A button gives to 97% while pressed; hover changes in
  150 ms, and only where there is a pointer that hovers; transitions name the properties
  they change. What follows the pointer or the keys is instant: focus, a highlight moving
  down a list, the active tab, a drop target, the rail's panel opened from the keyboard.
  `prefers-reduced-motion` turns the movement off through the `--motion-*` tokens; panels
  still fade.
- **Modules on a rail.** The sidebar is one glyph per module; a module's screens open in
  a panel beside it on hover, focus or click (Base UI's navigation menu, so the keyboard and
  a touch reach the same panel). A hover is a glance and closes when the pointer leaves; a
  press keeps the panel open until the glyph is pressed again, the reader presses
  elsewhere, leaves with Escape or follows a link. Forty screens do not fit a column a reader can scan; eleven
  modules do. The registry of ADR 0045 is unchanged apart from each group naming its glyph.
  The panel is opened many times a day, so it moves little and leaves in 100 ms; between
  two modules it is one panel that travels. Below 760 px the rail lies along the bottom
  edge and the panel opens upward.
- **A top bar of three things.** Search, what is new, and the person. The language, the
  profile and the way out wait behind the avatar; the language is a setting on the
  person's profile (ADR 0044 still holds: changing it keeps the reader where they are).
  The assistant is a button in the corner of every screen that opens a chat over it,
  because a question comes up in the middle of other work; its own screen keeps the
  earlier conversations.

Tokens live in the `:root` block of `web/src/app/styles.css`. A feature rule reads a
semantic alias and never a literal colour or a palette step; no palette package is imported.

## Consequences

`@radix-ui/colors` and `@fontsource-variable/inter` are gone; `@fontsource-variable/dm-sans`
is added, still bundled with the application, so the content security policy's
`font-src 'self'` holds.

Changing the palette is now one block. The price is that the scale is hand-written: there
is no twelve-step ramp to reach for, and a new state colour has to be chosen and checked
for contrast by whoever adds it.

There is one theme. A dark one is a second set of values for the same tokens, and is not
written.

Component class names did not change, so the browser suites keep their selectors; the
suites open a module before following a screen's link, as a reader does. The sidebar no
longer collapses, since it is already as narrow as it gets.

## Alternatives considered

A neutral look with a black primary button was the quietest of the three prototypes, and
left no colour for "this is the action" on a screen that already uses black for text. A
dark look with a mint accent was the most distinctive and the hardest to read across a
working day of tables. Keeping Radix Colors and only re-pointing the aliases would have
left the 150 direct references in place.
