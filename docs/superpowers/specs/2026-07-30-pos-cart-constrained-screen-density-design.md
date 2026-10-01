# POS Cart Constrained-Screen Density Design

## Goal

Give the cart list enough vertical room for approximately one additional ordinary item on dedicated POS hardware without shrinking the numpad, removing item actions, or changing checkout behavior.

## Scope

The compact treatment applies only when the viewport is between 1024px and 1280px wide and no more than 800px tall. The existing layout at 1366px and wider remains unchanged.

The change is limited to `PosCartWorkspace.vue`, its existing rules in `pos.css`, and focused layout tests. It introduces no new component, density preference, JavaScript viewport logic, or dependency.

## Layout

The cart keeps its current flex ownership: navigation and controls remain fixed-height regions, while the item table continues to consume and scroll within all remaining height.

On constrained POS screens:

- Preserve the current dimensions, labels, and four-column geometry of every numpad key.
- Keep the permanent Note, More, and Remove action strip.
- Reduce unused vertical padding around the cart navigation buttons without shrinking the buttons.
- Tighten the Item, Qty, Price, and Total table header padding without changing its typography or columns.
- Reduce only the action strip's wrapper padding; preserve its button dimensions.
- Reduce the outer padding and inter-section gap of the lower control panel.
- Reduce the numpad frame padding while preserving key dimensions and gaps required for touch separation.
- Reduce excess internal whitespace in the subtotal, tax, total, and payment area while preserving the total's hierarchy and the Pay button's usable size.

These reductions should recover roughly 30–40px of vertical space for the item list.

## Visual Language

The cart remains part of the existing low-glare POS workbench.

- Remove the nested bright-container impression from the lower control area by relying on the existing steel surface layers and structural borders.
- Give numpad keys the same restrained tactile vocabulary as product tiles: 8px corners, a defined three-pixel edge, a small depth shadow, and a matching pressed translation.
- Scope the stronger tactile rule to numpad keys so Pay and unrelated `.btn-3d` controls keep their current behavior.
- Keep teal for active modes and primary action, rose for Delete, and neutral surfaces for digits.

## Behavior and Data

No Vue state, cart calculations, permissions, events, translations, or checkout data flow changes. Existing click handlers, disabled states, selection behavior, and scrolling remain authoritative.

## Responsive Contract

- `1024×768`: compact cart chrome is active.
- `1280×800`: compact cart chrome is active.
- `1366×768` and wider: existing desktop density is unchanged.
- Below 1024px: existing mobile cart behavior is unchanged.

## Verification

Focused browser coverage will verify:

- The constrained media query activates at 1024×768 and 1280×800.
- Numpad key height is unchanged at constrained sizes.
- Navigation, table header, action wrapper, control shell, numpad frame, and totals padding use the compact values.
- The cart item viewport gains enough height for approximately one additional ordinary row compared with the current constrained layout.
- The numpad tactile edge and pressed state match the product-tile vocabulary.
- At 1366×768, the existing desktop spacing remains unchanged.
- No horizontal overflow is introduced in English or Arabic.

## Explicit Non-Goals

- Moving or hiding Note, More, or Remove.
- Shrinking numpad keys, labels, or touch geometry.
- Redesigning cart rows or checkout workflows.
- Changing cart width.
- Adding a density toggle, container-query system, or reusable layout abstraction.
