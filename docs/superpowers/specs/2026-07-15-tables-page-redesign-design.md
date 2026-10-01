# Tables Page Redesign - Design Specification

**Date:** 2026-07-15
**Route:** `/tables`
**Scope:** The table floor page, its fixed and dynamic modes, action overlays, responsive behavior, and English/Arabic copy.

## 1. Purpose

The Tables page is a touch-first restaurant floor workspace. A waiter should recognize table state, find a table, and enter it without reading instructions or scanning decorative UI.

The redesign keeps the existing workflows and replaces the current crowded header, tiny cards, large gaps, gradients, mixed-language copy, and fragile POS-width layout with the approved `02-calm-grid` direction.

Design principles:

- Preserve table-number order and waiter muscle memory.
- Let the full card color communicate table state.
- Keep primary tap behavior immediate.
- Put less common table actions behind one visible options button and retain long-press access.
- Use larger text and compact spacing suitable for 768px and 1024px POS displays.
- Keep teal for navigation, selection, focus, and action controls.
- Use dim neutral surfaces and muted state colors to reduce glare.
- Use natural English and Arabic. Do not use marketing copy or decorative labels.

## 2. Locked decisions

| Decision | Approved choice |
|---|---|
| Layout direction | Restored `02-calm-grid` |
| Table ordering | Preserve the backend/section order; do not sort by status |
| Primary table action | A normal tap immediately opens the table |
| Secondary actions | Visible options button on every card; long press and context menu remain supported |
| Table state | Full solid card background: muted green for available, muted red for saved, muted blue for guest check printed |
| Status labels on cards | Omitted; card color is enough |
| Card content | Table number, optional operational indicators, waiter and elapsed time for active orders, and total |
| Card styling | Flat surfaces, no gradient, no status border, no heavy shadow |
| Grid density | Larger cards, 8-9px gaps, maximum eight columns on very wide displays |
| Section navigation | One flat horizontal strip with a teal active tab; remove the redundant `Zone` label |
| Header navigation | At POS widths, Admin, POS, Split Checks, and Logout live in one navigation menu; wider screens may expose relevant direct actions |
| Search | Keep table/waiter search, with logical RTL/LTR icon and padding alignment |
| Accent | Existing POS teal `#0f766e` for buttons, active tabs, focus, and selections |
| Brightness | Dim neutral canvas and surface colors based on the approved mockup |
| Numerals | Latin digits in English and Arabic |
| Currency | Preserve the existing POS currency presentation and money precision |
| Section names | Display database-provided names exactly; do not translate user-defined section names |
| Workflows | Transfer, join, disjoin, split checks, PIN authorization, dynamic mode, QR draft indicators, and socket refresh behavior stay intact |

## 3. Information hierarchy

### 3.1 Header

The header is a compact operational bar:

1. `Tables` title and the active section name in fixed mode.
2. Available, saved, and printed counts with semantic dots and Latin digits.
3. Search field.
4. Navigation controls.

The count controls are compact rounded rectangles, not oversized pills. Their colors describe real status and are allowed as semantic markers.

At widths below the wide desktop breakpoint, the direct Admin Dashboard, POS Terminal, Split Checks, and Logout controls collapse into a single `Menu` button. Permission and role checks remain exactly as they are now. At wide widths, eligible high-frequency destinations can remain visible, while Logout stays available from the menu.

The menu closes after navigation, on outside click, and on Escape. Every item has an icon, translated label, and at least a 44px touch target.

### 3.2 Section tabs

Section tabs sit immediately below the header on the same dim neutral surface. The active section uses a solid teal background and white text. Inactive tabs are flat with clear hover and focus states.

The strip scrolls horizontally when needed and keeps the selected tab visible. The current section name is not repeated as `Zone: ...`. The number of visible tables can appear at the opposite edge on screens with enough room.

### 3.3 Table grid

The table grid uses small, consistent gaps and deliberately limits columns so cards remain easy to touch:

| Viewport | Columns | Intended card behavior |
|---|---:|---|
| Below 640px | 2 | Compact but still touchable |
| 640-767px | 3 | Small tablet |
| 768-1023px | 4 | Common compact POS screen |
| 1024-1279px | 5 | Common 1024px restaurant POS |
| 1280-1535px | 6 | Desktop |
| 1536px and above | 8 | Wide display, never ten tiny cards |

The base gap is 8px and may become 9px where space allows. Cards are approximately 148-164px tall, with a minimum 44px options target.

Each card contains:

- A large Latin-digit table number.
- A small translated `Table` label.
- A visible options button with an accessible name such as `Table 4 options`.
- For active orders, a plain footer containing waiter name, translated elapsed time, and total.
- Compact indicators only when they carry extra operational meaning: QR customer draft count, joined-table relation, or unpaid split count.

The card does not repeat `Available`, `Occupied`, or `Bill Printed`. It also does not use a status badge, gradient, decorative highlight line, or avatar circle. Available cards remain intentionally quiet.

Approved local colors:

- Canvas: `#e9e9e5`
- Surface: `#f7f7f4`
- Teal action: `#0f766e`
- Available card: `#2d6a4f`
- Saved card: `#ad4c45`
- Printed card: `#3d699b`

White text and translucent white secondary text must pass contrast checks against all three state colors.

## 4. Interactions

### 4.1 Normal table use

- Tap the card body: open the table immediately.
- Tap the options button: open the table action sheet without opening the table.
- Long press or right click: open the same action sheet.
- Swipe the table area: move between sections using the existing section order.
- Search: filter within the active section by table number or waiter name.

The options button uses `stopPropagation` so a secondary-action tap can never trigger the primary open action.

### 4.2 Transfer and join modes

Transfer and join keep their current state and permission logic. Their mode banners become flat, compact bars with natural sentence-case copy. Transfer uses teal. Join uses a restrained amber treatment because it represents a distinct temporary mode. There are no gradients, spinning decoration, or heavy shadows.

Selected and unavailable target tables retain clear rings/opacity without changing the meaning of the underlying status color.

### 4.3 Action sheet

The action sheet is a bottom sheet on narrow screens and a compact centered dialog on wider screens. It shows:

- Table number.
- Section name or joined-parent identity.
- Open table.
- Transfer order when allowed.
- Join tables when allowed.
- Disjoin table or dissolve joined group when applicable.

All labels are translated. Buttons use sentence case, clear icons, 44px minimum height, flat surfaces, and teal only for the primary action. The status may be stated in this detail surface, but never as a pill on the table card.

### 4.4 PIN dialog

The existing PIN authorization workflow stays intact. The dialog receives the same dim surface, teal primary action, translated copy, visible focus, numeric input behavior, and compact responsive sizing.

## 5. Other page states

### 5.1 Loading

The skeleton mirrors the final header/tab/card proportions and uses the dim neutral palette. It must not flash a different ten-column layout before the page loads.

### 5.2 Empty section and empty search

Use one compact empty state with a translated title and explanation. When a search has no results, the copy should describe the search result rather than claim the section has no configured tables.

### 5.3 Dynamic table mode

Dynamic mode keeps its existing numeric entry and open behavior. It uses the same canvas, surface, typography, teal button, focus rules, and responsive header/navigation. The input remains LTR for Latin digits inside both page directions.

### 5.4 Errors and live updates

Existing toast/alert behavior, socket subscriptions, refresh logic, KeepAlive activation behavior, and printer status data remain unchanged. The redesign must not add another polling loop or watcher.

## 6. Typography, localization, and direction

- Use the existing POS font stack: `Inter` for Latin content and `IBM Plex Sans Arabic` for Arabic UI.
- Arabic layout mirrors structural alignment with logical CSS properties.
- Table numbers, counts, elapsed values, and totals always use Latin digits.
- User names and database section names are displayed verbatim with `data-no-i18n` where required.
- Replace raw `Staff` fallback with a translated singular fallback suitable for one waiter.
- Replace raw `m` and `h` suffixes with translated minute/hour abbreviations while retaining Latin numeric characters.
- Map dynamic table status values to explicit translation keys in the action sheet.
- Every static `$t('...')` key in `TableFloorPlan.vue` must have an Arabic dictionary entry.
- Add explicit coverage for dynamic/fallback strings that a static extractor cannot see.

The translation pass includes, at minimum, the currently missing keys for printed count, search, POS, split checks, transfer/join mode instructions, QR draft, joined tables, unpaid splits, empty states, dynamic-mode guidance, action-sheet actions, and manager authorization.

## 7. Accessibility and touch behavior

- Card and button targets are at least 44px in the touch dimension.
- Keyboard focus is visible on tabs, cards, menu items, search, and dialog controls.
- Options, close, logout, and icon-only controls have translated accessible names.
- Dialogs expose dialog semantics, an accessible title, Escape close behavior, and backdrop close where it does not interrupt an in-progress operation.
- Color is the fast status signal, but status remains available to assistive technology through an accessible card label.
- Reduced-motion users receive instant or simple opacity transitions. No layout-changing animation is required.
- No page-level horizontal overflow at 768px or 1024px.

## 8. Vue implementation boundaries

Keep the current Vue 3 Composition API and `<script setup>` structure. Do not convert the JavaScript component to TypeScript as part of this visual task. The existing component name block remains because `KeepAlive` includes `TableFloorPlan` by name.

Use computed values for presentation derived from reactive tables and sections. Define every template binding in script setup. Do not add render-time side effects, deep watchers, direct DOM queries beyond the existing selected-tab scroll, or duplicated table state.

Small pure presentation helpers may move to `src/utils/tableFloorPlanPresentation.js` only when they improve testability, such as explicit status-class mapping or Latin elapsed-time formatting. Do not split the page into many one-use components.

## 9. Out of scope

- Backend API, database, table permissions, and order calculations.
- Table Editor behavior or physical drag-and-drop layout coordinates.
- Status-based sorting or filtering.
- Changes to table ownership, split-check authorization, transfer, join, or disjoin rules.
- POS cart redesign.
- New icon or animation dependencies.
- A full design-system rewrite.

## 10. Verification

The finished page must pass:

1. A localization contract test for static and dynamic table-page strings.
2. Focused presentation helper tests if helpers are extracted.
3. Updated waiter table E2E selectors and status assertions using stable data attributes rather than Tailwind class names.
4. `npm run build:admin`.
5. Visual browser checks in English and Arabic at 768x1024, 1024x768, and a wide desktop viewport.
6. Interaction checks for tap-to-open, options without accidental open, long press, search, section tabs, responsive menu, transfer/join banners, action sheet, dynamic mode, and PIN dialog.

The current unrelated uncommitted table-void, split-check, printing, and translation changes must be preserved. In particular, edits to `assets/js/admin/i18n.js` must be additive and must not overwrite the existing worktree changes.
