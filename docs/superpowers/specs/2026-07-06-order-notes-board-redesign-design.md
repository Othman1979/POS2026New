# Order Notes Board Redesign — Design Spec

**Date:** 2026-07-06
**Branch:** codex/pos-calculation-part-c (or dedicated FE branch)
**Scope:** Frontend only. Single file: `src/components/OrderNotes.vue`.
**No backend changes. No data/calculation-logic changes.**

## 1. Context

`/order-notes` → `OrderNotes.vue` is the cashier-facing "Order Notes Board". It is
one component that renders two modes via a header toggle:

- **Suspended Tickets** (held orders, `api/pos/held_orders`) — default.
- **Current History** (finalized orders, `api/pos/order_notes?limit=200`) — gated on
  `orders.view`.

Both modes render the same board: horizontally-scrolling **columns**, one per active
non-dine-in order-type (Takeaway / Delivery / Pickup / etc.; table & dine-in are
filtered out). Each column holds a scrollable list of order **cards**. Clicking a card
opens a receipt-preview modal. Held cards expose Fire-to-Kitchen + Restore; finalized
cards expose Reprint.

### Problems with the current design
1. **Cards too big.** Each card has a `min-h-[145px]` floor, `p-3.5` padding, a full
   item checklist (every line), and multiple stacked badges → tall, heavy cards.
2. **Not responsive.** Columns are fixed width (`w-80 sm:w-96`) inside a horizontal
   scroller. On a phone this forces sideways scrolling and only ~1 column fits.
3. **Heavy visuals.** Every card is a full saturated gradient (`getCardColors`) with
   white text. At small/dense sizes this becomes a wall of saturated blocks and tiny
   white-on-color meta text is hard to read.

## 2. Owner decisions (locked)

| Decision | Choice |
|---|---|
| Layout | **Responsive columns → phone tabs.** Desktop keeps side-by-side type columns; phone collapses to filter chips + one vertical list. |
| Card density | **Minimal summary.** No item lines on the card. Full item detail stays in the tap-open modal. |
| Card color | **Light card + colored accent.** White card / dark text; order-type shown via a colored inline-start stripe + colored type label + colored total. |
| Phone default | **All merged, time-sorted.** Default chip = "All": every type mixed, sorted by time. Chips narrow to one type. |

## 3. Target design

### 3.1 Responsive structure

**Desktop / tablet (≥ `md`):**
- Keep one column per active order-type (existing `orderTypeColumns` / `groupedOrders`
  logic unchanged).
- Replace fixed `w-80 sm:w-96` with **fluid columns**: each column `flex-1` with a
  sensible `min-width` (~240px) and a `max-width` so 2-3 types fill the width with no
  horizontal scroll. Horizontal scroll remains only as a fallback when the total column
  count exceeds the viewport.

**Phone (< `md`):**
- Columns hidden. A **sticky filter-chip row** sits under the header:
  `[All] [Takeaway (3)] [Delivery (2)] …` — one chip per `orderTypeColumns` entry plus
  "All", each showing its count.
- Below: a **single vertical card list**.
  - Default chip = **All** → every card across types, sorted by time
    (`delivery_date ?? created_at`, ascending — reuse existing sort).
  - Tapping a type chip filters the list to that column's cards.
- New local state: `activeChip` (ref, default `'All'`). Purely presentational; does not
  touch fetch/computed data pipelines. The phone list derives from the existing
  `groupedOrders` (All = flatten + re-sort by time; type = `groupedOrders[type]`).

### 3.2 Card (minimal summary, light + accent)

Container:
- White / near-white background, thin neutral border, `rounded-lg`.
- **Colored inline-start stripe** (border-inline-start ~3-4px, or an absolutely-positioned
  stripe) in the order-type color. RTL-safe (inline-start, not left).
- Gentle hover lift (keep a softened version of the existing micro-animation:
  `hover:shadow` + tiny `scale`), `active:` press. No heavy gradients/shadows.
- Height ~60-80px, **no min-height floor**. Card grows only as its (few) rows need.

Content rows:
- **Row 1 — identity:** ID badge (`HELD #id` / `Q-order_id` / `orderIdentityLabel`) ·
  order-type label in the type color (small, uppercase) · **time** on the far side.
  Time = `formatTimeOnly(created_at)`; for delivery/scheduled orders show the scheduled
  time with a clock icon (see below).
- **Row 2 — context:** customer name / `Table #n` (when present) · `N items` count
  (`order.items.length`). Held **reference-name** chip when
  `order.raw_held_data.reference_name` present. One line, truncate overflow.
- **Row 3 — footer:** **total** (`parseFloat(order.total).toFixed(2) JD`, bold) ·
  compact action buttons.
  - Held → Fire-to-Kitchen (🔥, with spinner on `firingKitchenId`) + Restore (↺).
  - Finalized → Reprint (🖨).
  - `@click.stop` preserved so buttons don't open the modal.

Badge policy (to keep the card short):
- **Kept on card:** scheduled/delivery time (ops-critical), held reference-name, and
  `Table #n` — but as **compact inline text in Row 1/Row 2**, not the old full-width
  badge blocks.
- **Removed:** the old standalone stacked *badge blocks* (scheduled-date block, table
  block, reference block) are replaced by the inline treatment above. Any remaining
  detail lives in the tap-open modal.

### 3.3 Color system

Reuse the existing type-detection semantics (dine/null → emerald, takeaway → teal,
delivery → sky, other → indigo). Replace the full-gradient `getCardColors` with a single
`getTypeAccent(orderTypeName)` helper that returns **full, literal Tailwind class strings**
(never interpolated color names — Tailwind JIT must see complete classes, exactly as the
current code already does) for four accent slots:

| Type | Stripe | Type label | Total | Chip (active) |
|---|---|---|---|---|
| Dine/null | `emerald-500` | `emerald-700` | `emerald-600` | `emerald-50/700/200` |
| Takeaway | `teal-500` | `teal-700` | `teal-600` | `teal-50/700/200` |
| Delivery | `sky-500` | `sky-700` | `sky-600` | `sky-50/700/200` |
| Other | `indigo-500` | `indigo-700` | `indigo-600` | `indigo-50/700/200` |

**Palette principles (the "good coloring"):**
- **Calm neutral canvas** so color reads from accents, not fills: board `gray-50`,
  card `white`, borders `gray-200`, primary text `gray-900`, muted `gray-500`.
- **One accent per card**, applied to exactly three marks (stripe + type label + total).
  Nothing else is colored → no rainbow noise.
- **Contrast:** all text meets WCAG AA on white (the `-700` label / `gray-900` body /
  `-600` total are all AA on white). Tiny meta uses `gray-500`, still AA.
- Brand **teal** remains the app's interactive/primary color (segmented control active
  segment, focus rings, primary modal buttons) — distinct from the per-type accents.
- Light-theme only (matches the rest of the app; no dark mode in scope).

### 3.6 Performance

Small-DOM + cheap-paint is a first-class goal (POS runs on low-end terminals + phones):

- **Fewer nodes per card.** Minimal-summary card is ~3 rows vs the old multi-badge +
  full-item-list card → materially fewer DOM nodes, faster first paint and scroll.
- **Animate only `transform` / `opacity` / `box-shadow`**, GPU-friendly, short durations.
  Keep hover lift subtle. No animating width/height/top/left (layout thrash).
- **Kill perpetual animations.** Drop the always-on `animate-pulse` column dot (continuous
  repaint for zero info) → static dot. No infinite spinners except during real loading.
- **No `backdrop-filter` / blur** on the board or cards (expensive on weak GPUs). The
  modal stays a plain translucent scrim.
- **`content-visibility: auto` + `contain-intrinsic-size`** on cards so off-screen cards
  (history mode can list up to 200) skip layout & paint until scrolled into view — a
  near-free virtualization win without a virtual-list library.
- **Pure, non-reactive accent lookup** (`getTypeAccent` is a plain function over a static
  map); no new heavy `computed`. Phone-filter derivation is O(n) over already-computed
  `groupedOrders`.
- **Stable `:key`s** (`order.invoice_id` / held `id`) retained so Vue patches instead of
  re-creating rows.
- Existing **250ms debounced** socket refresh is unchanged (no added network chatter).

### 3.4 Header (responsive)

- Back button + title retained.
- **Search:** full field on desktop; on phone collapses to a search icon that toggles a
  full-width search row (keeps `searchQuery` binding + clear button).
- **Mode toggle** (Suspended Tickets ↔ Current History, gated on `canViewHistory`) →
  compact **segmented control** (two-segment pill) instead of the single toggle button.
- **Refresh** → icon-only on phone, icon+label on desktop. `fa-spin` on `isLoading`
  retained.

### 3.5 Modal + empty/loading states

- Receipt-preview modal keeps **all** current function (identity block, item table,
  totals, Close / Fire / Restore / Reprint). Light restyle only: adopt the new accent
  color (type accent instead of hard teal), fix alignment/spacing. No structural change.
- Column empty-state and full-board loading spinner: shrink + restyle to match the new
  lighter card language.

## 4. Non-goals / constraints

- **No backend calls added or changed.** `fetchOrders`, `fetchOrderTypes`,
  `fetchStoreSettings`, `restoreHeldOrder`, `fireToKitchen`, `reprintDirect` untouched.
- **No data-shape / computed changes** beyond the presentational phone-filter derivation:
  `orderTypeColumns`, `groupedOrders`, `filteredOrders`, `processedHeldOrders`,
  `getCardColors` semantics preserved (accent helper wraps the same logic).
- **i18n / RTL preserved.** All `$t(...)` calls, `data-no-i18n`, `font-arabic`,
  `rtl:` handling, and inline-start/-end directionality carried into the new markup.
- Socket refresh listeners (`new_order`, `table_update`, `held_orders_changed`) unchanged.
- Permission gating (`canViewHistory`) unchanged.

## 5. Verification

- Build with the `frontend-design` skill for visual taste and the `vue` skill for SFC
  correctness.
- Run the app on localhost and review with `web-design-reviewer` at **desktop** and
  **phone** viewport widths — check card alignment, chip row, segmented control, stripe
  RTL behavior, contrast, and that no horizontal scroll leaks on phone.
- Manual smoke: toggle Suspended ↔ History; search; open modal; Fire/Restore/Reprint
  buttons still fire (no regression); phone chips filter correctly; both LTR + RTL.
- **Performance check:** scroll a full (≥100 card) history board on a throttled profile —
  confirm smooth scroll, no long paint from `content-visibility`, no perpetual-animation
  repaint (dot is static), and card count in DOM stays flat.
- **Coloring check:** verify one-accent-per-card (stripe/label/total only), AA contrast
  on white, and that the four type accents are visually distinct at a glance.

## 6. Out of scope

- Admin `src/admin/pages/Orders.vue` (separate admin surface, not cashier-facing).
- Any change to held-order / order-notes API, DB, or POS calculation logic.
