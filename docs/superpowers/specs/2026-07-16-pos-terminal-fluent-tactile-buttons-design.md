# POS Terminal Fluent Tactile Buttons

## Goal

Give the approved faithful POS polish a modern Windows Fluent-style tactile response without changing layout, sizing, colors, labels, permissions, or workflow.

## Scope

The shared tactile treatment applies to existing `btn-3d` controls:

- Product cards.
- Numpad keys and numpad mode keys.
- Category buttons.
- Table Save and Pay actions.
- Other existing primary POS controls already using `btn-3d`.

Compact cart-toolbar actions and terminal-function modal tiles remain flat. They are navigation and utility controls, not physical keypad surfaces.

## Visual model

Each tactile control uses one consistent four-layer construction:

1. A crisp one-pixel border.
2. A subtle inset top highlight that separates the face from its edge.
3. A two-to-three-pixel lower edge derived from the control's existing `--shadow-color`.
4. A short, low-blur ambient shadow for separation from the terminal surface.

The treatment must not use gloss, gradients, glass effects, wide blurred shadows, scaling, or exaggerated bevels.

## Interaction states

- **Rest:** Face is raised, with the lower edge fully visible.
- **Hover:** Background changes through the existing color rules; depth increases only slightly.
- **Active:** Control moves down two pixels. The lower edge collapses to one pixel, producing a physical press without scaling.
- **Focus:** Existing two-pixel teal focus ring remains visible outside the tactile edge.
- **Disabled:** No lift or pressed movement; shadow is removed and the existing disabled opacity remains.

Transitions cover transform, shadow, background, border, and color only. The press should feel immediate, with a roughly 80–120ms response and no bounce.

## Color behavior

- Product cards keep their configured product colors and existing contrast logic.
- Selected product and mode controls keep the teal accent.
- Neutral keys use the calibrated gray edge already represented by `--shadow-color`.
- Danger controls keep the rose edge.
- No new palette or decorative color is introduced.

## Implementation boundary

Implement the depth system in the existing `.pos-polish .btn-3d` rules in `src/pos.css`. Remove the polish overrides that currently force category buttons, product cards, and numpad keys flat. Reuse existing `--shadow-color` values from `PosTerminal.vue`; do not add JavaScript state or new Vue components.

## Responsive and accessibility requirements

- Preserve every existing control dimension and breakpoint.
- Keep touch targets unchanged.
- Maintain visible keyboard focus.
- Respect `prefers-reduced-motion`; the visual depth remains, but motion becomes effectively instant.
- Avoid layout shift: shadows and transforms must not affect document flow.

## Verification

- Build the production frontend.
- Inspect product, category, numpad, Save, and Pay states at 1024×768.
- Confirm hover, keyboard focus, press, disabled mode keys, and colored product cards.
- Confirm compact cart toolbar and terminal-function tiles remain flat.
- Confirm no browser console warnings and no horizontal overflow.

## Rollback

The untouched pre-polish state remains available on `codex/backup-before-pos-faithful-polish` at `44ddaeec`. This tactile layer will also be isolated in its own commit so it can be reverted independently.
