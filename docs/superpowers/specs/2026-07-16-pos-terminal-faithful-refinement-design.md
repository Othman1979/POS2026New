# POS Terminal Production-Exact Polish Mock

## Rule

This is not a redesign. Mock must use the existing POS design system, markup shape, Tailwind utility classes, production `pos.css`, production fonts, existing responsive breakpoints, existing density, and existing workflow.

## Allowed changes

- Remove the default `Fire Immediately` cart group heading.
- Remove the permanent `Course` cart action.
- Slightly calm existing neutral surface tokens to reduce screen glare.
- Remove harsh 3D button edges and excessive elevation.
- Normalize existing button borders, radii, and pressed states.
- Tighten existing category, product, cart-navigation, numpad, and modal padding by small amounts only.
- Polish current modals without changing their content or flow.
- Rename the table action from `Update Table` / `تحديث الطاولة` to `Save Table` / `حفظ الطاولة`.

## Not allowed

- No new layout, navigation, typography, cards, labels, controls, or visual language.
- No other renamed actions or moved functionality.
- No variants or prototype switcher.
- No production composable or backend edits.

## Prototype boundary

Static prototype remains beside `PosTerminal.vue`. It loads `/src/pos.css`, `/assets/css/fonts.css`, and `/assets/css/fontawesome.css`. `styles.css` contains only `.pos-polish`-scoped overrides.

## Production rollout

Approved after the faithful mock review. Production reuses the same `.pos-polish` scope and existing Vue structure; it does not copy prototype-only data or interactions. The untouched rollback point is branch `codex/backup-before-pos-faithful-polish` at commit `44ddaeec`.
