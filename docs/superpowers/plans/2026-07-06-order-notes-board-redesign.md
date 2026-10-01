# Order Notes Board Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the cashier-facing Order Notes Board (`/order-notes`) into a lighter, denser, fully responsive card board — small "minimal-summary" cards, light surfaces with a single per-type color accent, desktop type-columns that collapse to phone filter-chips + one list — with no backend or calculation change.

**Architecture:** Pull the board's pure logic out of the monolithic SFC into three tested `src/utils` helpers (type→accent classes, phone card-merge, date/qty/format). Introduce one private presentational child `OrderNoteCard.vue` (rendered by both the desktop columns and the phone list — DRY). Rewrite `OrderNotes.vue`'s template (header + responsive board) and styles; its `<script>` data/network/computed logic is preserved verbatim except for added presentational state.

**Tech Stack:** Vue 3 (`<script setup>`), Vite 6, Tailwind CSS v4, vitest 4 (node env), Font Awesome icons, vue-router.

## Global Constraints

Copied verbatim from the spec — every task must honor these:

- **No backend calls added or changed.** `fetchOrders`, `fetchOrderTypes`, `fetchStoreSettings`, `restoreHeldOrder`, `fireToKitchen`, `reprintDirect` stay byte-for-byte identical.
- **No data-shape / computed logic change** beyond the added phone-filter derivation. `orderTypeColumns`, `groupedOrders`, `filteredOrders`, `processedHeldOrders`, `isTableOrDineInName` semantics preserved.
- **i18n / RTL preserved.** Keep every `$t(...)` (with the `$t ? $t('x') : 'x'` guard), `data-no-i18n`, `font-arabic`, and use logical direction utilities (`ps-*`/`pe-*`/`ms-*`/`me-*`/`border-s-*`/`inset-inline-*`, `rtl:`), never physical `left/right`.
- **Tailwind JIT safety:** color helpers return **full literal class strings** (`'border-teal-500'`), never interpolated (`` `border-${c}-500` ``).
- **Socket listeners unchanged** (`new_order`, `table_update`, `held_orders_changed`) and **permission gating** (`canViewHistory = can('orders.view')`) unchanged.
- **One accent per card** — color appears on exactly three marks (stripe + type label + total). **Light theme only.**
- Money format stays `parseFloat(x).toFixed(2)` + `JD` suffix; quantities via the shared `getQtyFormatted`.

---

### Task 1: Type→accent helper (`getTypeAccent`)

Pure function mapping an order-type name to one accent (stripe/label/total/dot/chip classes). Replaces the old `getCardColors` (full gradient) + `getColumnDotColorClass`, keeping identical type detection.

**Files:**
- Create: `src/utils/orderTypeAccent.js`
- Test: `src/utils/orderTypeAccent.spec.js`

**Interfaces:**
- Produces: `getTypeAccent(orderTypeName: string|null): { key, stripe, label, total, dot, chipActive }` — every value a literal Tailwind class string.

- [ ] **Step 1: Write the failing test**

```js
// src/utils/orderTypeAccent.spec.js
import { describe, it, expect } from 'vitest';
import { getTypeAccent } from './orderTypeAccent.js';

describe('getTypeAccent', () => {
  it('maps takeaway names (EN + AR) to teal', () => {
    expect(getTypeAccent('Takeaway').stripe).toBe('border-teal-500');
    expect(getTypeAccent('سفري').label).toBe('text-teal-700');
    expect(getTypeAccent('Takeaway / سفري').total).toBe('text-teal-600');
  });
  it('maps delivery names (EN + AR) to sky', () => {
    expect(getTypeAccent('Delivery').stripe).toBe('border-sky-500');
    expect(getTypeAccent('توصيل').dot).toBe('bg-sky-500');
  });
  it('maps dine-in and null/empty to emerald', () => {
    expect(getTypeAccent('Dine-In').stripe).toBe('border-emerald-500');
    expect(getTypeAccent('طاولة').stripe).toBe('border-emerald-500');
    expect(getTypeAccent(null).stripe).toBe('border-emerald-500');
    expect(getTypeAccent('').stripe).toBe('border-emerald-500');
  });
  it('maps unknown types to indigo', () => {
    expect(getTypeAccent('Catering').stripe).toBe('border-indigo-500');
  });
  it('exposes a composite chipActive class', () => {
    expect(getTypeAccent('Delivery').chipActive).toBe('bg-sky-50 text-sky-700 border-sky-200');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/orderTypeAccent.spec.js`
Expected: FAIL — `Failed to resolve import "./orderTypeAccent.js"` / `getTypeAccent is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/utils/orderTypeAccent.js
// Maps an order-type name to a single visual accent (stripe + label + total + dot +
// active-filter-chip classes). Same type detection as the previous getCardColors /
// getColumnDotColorClass, applied as a light accent instead of a full-card gradient.
//
// IMPORTANT: return FULL, LITERAL Tailwind class strings. Never interpolate color names
// (e.g. `text-${c}-700`) — Tailwind's JIT only emits classes it can see as literals.

const EMERALD = {
  key: 'dine',
  stripe: 'border-emerald-500',
  label: 'text-emerald-700',
  total: 'text-emerald-600',
  dot: 'bg-emerald-500',
  chipActive: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};
const TEAL = {
  key: 'takeaway',
  stripe: 'border-teal-500',
  label: 'text-teal-700',
  total: 'text-teal-600',
  dot: 'bg-teal-500',
  chipActive: 'bg-teal-50 text-teal-700 border-teal-200',
};
const SKY = {
  key: 'delivery',
  stripe: 'border-sky-500',
  label: 'text-sky-700',
  total: 'text-sky-600',
  dot: 'bg-sky-500',
  chipActive: 'bg-sky-50 text-sky-700 border-sky-200',
};
const INDIGO = {
  key: 'other',
  stripe: 'border-indigo-500',
  label: 'text-indigo-700',
  total: 'text-indigo-600',
  dot: 'bg-indigo-500',
  chipActive: 'bg-indigo-50 text-indigo-700 border-indigo-200',
};

export function getTypeAccent(orderTypeName) {
  if (orderTypeName === null || orderTypeName === undefined) return EMERALD;
  const type = String(orderTypeName).toLowerCase().trim();
  if (type === '') return EMERALD;
  if (type.includes('dine') || type.includes('طاولة') || type.includes('صالة')) return EMERALD;
  if (type.includes('take') || type.includes('سفري') || type.includes('خارجي')) return TEAL;
  if (type.includes('deliv') || type.includes('توصيل')) return SKY;
  return INDIGO;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/orderTypeAccent.spec.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/orderTypeAccent.js src/utils/orderTypeAccent.spec.js
git commit -m "feat(order-notes): add getTypeAccent type->accent color helper"
```

---

### Task 2: Phone card-merge helper (`mergedCardsByTime`)

Pure helper the phone "All" chip uses: flatten the per-column grouped orders into one list sorted ascending by time (scheduled `delivery_date` if present, else `created_at`) — matching the desktop per-column sort.

**Files:**
- Create: `src/utils/orderNotesBoard.js`
- Test: `src/utils/orderNotesBoard.spec.js`

**Interfaces:**
- Produces: `mergedCardsByTime(groupedOrders: Record<string, object[]>, columns: string[]): object[]` — new array, inputs never mutated.

- [ ] **Step 1: Write the failing test**

```js
// src/utils/orderNotesBoard.spec.js
import { describe, it, expect } from 'vitest';
import { mergedCardsByTime } from './orderNotesBoard.js';

describe('mergedCardsByTime', () => {
  const groups = {
    Takeaway: [
      { id: 'a', created_at: '2026-07-06T10:05:00' },
      { id: 'b', created_at: '2026-07-06T10:01:00' },
    ],
    Delivery: [
      { id: 'c', created_at: '2026-07-06T09:00:00', delivery_date: '2026-07-06T10:03:00' },
    ],
  };
  const columns = ['Takeaway', 'Delivery'];

  it('merges all columns into one list sorted ascending by time', () => {
    expect(mergedCardsByTime(groups, columns).map((o) => o.id)).toEqual(['b', 'c', 'a']);
  });
  it('prefers delivery_date over created_at when present', () => {
    // c is ordered by its delivery_date (10:03), between b (10:01) and a (10:05)
    expect(mergedCardsByTime(groups, columns)[1].id).toBe('c');
  });
  it('ignores missing/undefined columns and invalid dates', () => {
    const g = { X: [{ id: 'z', created_at: 'not-a-date' }], Y: undefined };
    expect(mergedCardsByTime(g, ['X', 'Y', 'Z']).map((o) => o.id)).toEqual(['z']);
  });
  it('does not mutate the input column arrays', () => {
    const snapshot = groups.Takeaway.map((o) => o.id);
    mergedCardsByTime(groups, columns);
    expect(groups.Takeaway.map((o) => o.id)).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/orderNotesBoard.spec.js`
Expected: FAIL — module/import not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/utils/orderNotesBoard.js
// Pure presentational helper for the Order Notes board's phone view. Flattens the
// per-column grouped orders into one list ordered by time (scheduled delivery_date if
// present, else created_at), ascending — matching the desktop per-column sort.

function timeOf(order) {
  const raw = order && order.delivery_date ? order.delivery_date : order && order.created_at;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export function mergedCardsByTime(groupedOrders, columns) {
  const all = [];
  for (const col of columns) {
    const list = groupedOrders && groupedOrders[col];
    if (Array.isArray(list)) all.push(...list);
  }
  return all.slice().sort((a, b) => timeOf(a) - timeOf(b));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/orderNotesBoard.spec.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/orderNotesBoard.js src/utils/orderNotesBoard.spec.js
git commit -m "feat(order-notes): add mergedCardsByTime phone-list helper"
```

---

### Task 3: Shared format helpers (`orderNotesFormat`)

Move the board's date/qty/text formatters out of `OrderNotes.vue` into a tested util so both the new `OrderNoteCard.vue` and the parent modal import one copy (DRY). Behavior is identical to the current in-component functions.

**Files:**
- Create: `src/utils/orderNotesFormat.js`
- Test: `src/utils/orderNotesFormat.spec.js`

**Interfaces:**
- Produces:
  - `formatTimeOnly(dateVal): string` → `"hh:mm:ss AM/PM"`
  - `formatScheduledTime(dateVal): string` → `"YYYY-MM-DD hh:mm AM/PM"`
  - `formatDateTime(dateVal): string` → `"YYYY-MM-DD hh:mm:ss AM/PM"`
  - `getQtyFormatted(qty): string` — integer as-is, fractional to 2 dp, non-numeric returned unchanged
  - `isArabic(text): boolean`

- [ ] **Step 1: Write the failing test**

```js
// src/utils/orderNotesFormat.spec.js
import { describe, it, expect } from 'vitest';
import {
  formatTimeOnly, formatScheduledTime, formatDateTime, getQtyFormatted, isArabic,
} from './orderNotesFormat.js';

// Dates built from local components so assertions are timezone-independent.
describe('orderNotesFormat', () => {
  it('formatTimeOnly renders 12h hh:mm:ss with AM/PM', () => {
    expect(formatTimeOnly(new Date(2026, 0, 1, 15, 4, 5))).toBe('03:04:05 PM');
    expect(formatTimeOnly(new Date(2026, 0, 1, 0, 9, 0))).toBe('12:09:00 AM');
  });
  it('formatScheduledTime renders date + hh:mm AM/PM', () => {
    expect(formatScheduledTime(new Date(2026, 0, 1, 15, 4))).toBe('2026-01-01 03:04 PM');
  });
  it('formatDateTime renders date + hh:mm:ss AM/PM', () => {
    expect(formatDateTime(new Date(2026, 0, 1, 15, 4, 5))).toBe('2026-01-01 03:04:05 PM');
  });
  it('formatters return empty string for falsy input', () => {
    expect(formatTimeOnly('')).toBe('');
    expect(formatDateTime(null)).toBe('');
  });
  it('getQtyFormatted keeps integers, fixes fractionals, passes through non-numeric', () => {
    expect(getQtyFormatted(3)).toBe('3');
    expect(getQtyFormatted(2.5)).toBe('2.50');
    expect(getQtyFormatted('abc')).toBe('abc');
  });
  it('isArabic detects Arabic script', () => {
    expect(isArabic('سفري')).toBe(true);
    expect(isArabic('Burger')).toBe(false);
    expect(isArabic('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/orderNotesFormat.spec.js`
Expected: FAIL — module/import not found.

- [ ] **Step 3: Write minimal implementation** (copied verbatim from the current `OrderNotes.vue` functions)

```js
// src/utils/orderNotesFormat.js
// Date / quantity / text formatters shared by the Order Notes board card and modal.
// Extracted verbatim from OrderNotes.vue — behavior unchanged.

export function formatTimeOnly(dateVal) {
  if (!dateVal) return '';
  const date = new Date(dateVal);
  if (isNaN(date.getTime())) return dateVal;
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const hh = String(hours).padStart(2, '0');
  return `${hh}:${minutes}:${seconds} ${ampm}`;
}

export function formatDateTime(dateVal) {
  if (!dateVal) return '';
  const date = new Date(dateVal);
  if (isNaN(date.getTime())) return dateVal;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const hh = String(hours).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${minutes}:${seconds} ${ampm}`;
}

export function formatScheduledTime(dateVal) {
  if (!dateVal) return '';
  const date = new Date(dateVal);
  if (isNaN(date.getTime())) return dateVal;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const hh = String(hours).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${minutes} ${ampm}`;
}

export function getQtyFormatted(qty) {
  const num = Number(qty);
  if (isNaN(num)) return qty;
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

export function isArabic(text) {
  if (!text) return false;
  const arabicPattern = /[؀-ۿ]/;
  return arabicPattern.test(String(text));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/orderNotesFormat.spec.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/orderNotesFormat.js src/utils/orderNotesFormat.spec.js
git commit -m "feat(order-notes): extract shared date/qty/text formatters"
```

---

### Task 4: `OrderNoteCard.vue` — minimal light + accent card

The single presentational card, rendered by both the desktop columns and the phone list. Emits actions upward; owns no network/business logic.

**Files:**
- Create: `src/components/OrderNoteCard.vue`

**Interfaces:**
- Consumes: `getTypeAccent` (Task 1), `orderIdentityLabel` (existing `src/utils/orderIdentityDisplay.js`), `formatTimeOnly` + `formatScheduledTime` (Task 3).
- Produces (used by Task 5):
  - Props: `order: Object` (required), `firingKitchenId: [String, Number, null]` (default `null`).
  - Emits: `open(order)`, `fire(order)`, `restore(order)`, `reprint(order)`.

- [ ] **Step 1: Create the component**

```vue
<!-- src/components/OrderNoteCard.vue -->
<template>
  <div
    @click="$emit('open', order)"
    :class="['relative bg-white rounded-lg border border-gray-200 border-s-4 ps-3 pe-2.5 py-2 cursor-pointer flex flex-col gap-1.5 shadow-sm transition-shadow duration-200 hover:shadow-md active:shadow-sm card-cv', accent.stripe]">

    <!-- Row 1: identity + time -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="text-[11px] font-black text-gray-900 truncate" data-no-i18n>
          {{ order.isHeld
            ? (($t ? $t('HELD') : 'HELD') + ' #' + order.id)
            : orderIdentityLabel(order, $t || ((v) => v)) }}
        </span>
        <span v-if="!order.isHeld && order.order_id" class="text-[9px] font-bold text-gray-400 shrink-0" data-no-i18n>
          Q-{{ order.order_id }}
        </span>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <i v-if="order.delivery_date" class="fa-solid fa-stopwatch text-[8px] text-amber-500"></i>
        <span class="text-[9px] font-bold" :class="order.delivery_date ? 'text-amber-600' : 'text-gray-400'">
          {{ order.delivery_date ? formatScheduledTime(order.delivery_date) : formatTimeOnly(order.created_at) }}
        </span>
      </div>
    </div>

    <!-- Row 2: type + context (name/reference) + item count -->
    <div class="flex items-center gap-1.5 min-w-0 text-[10px]">
      <span :class="['font-black uppercase tracking-wide shrink-0', accent.label]" data-no-i18n>
        {{ order.order_type_name || ($t ? $t('Dine-In') : 'Dine-In') }}
      </span>
      <span class="text-gray-300 shrink-0">·</span>
      <span class="text-gray-500 font-semibold truncate min-w-0">
        <span v-if="cardName" data-no-i18n>{{ cardName }} · </span>{{ itemCount }} {{ $t ? $t('items') : 'items' }}
      </span>
    </div>

    <!-- Row 3: total + actions -->
    <div class="flex items-center justify-between gap-2 pt-0.5">
      <span :class="['text-sm font-black', accent.total]" data-no-i18n>{{ totalDisplay }} JD</span>
      <div class="flex items-center gap-1.5">
        <template v-if="order.isHeld">
          <button @click.stop="$emit('fire', order)" :disabled="firingKitchenId === order.id"
            :title="$t ? $t('Fire to Kitchen') : 'Fire to Kitchen'"
            class="h-7 w-7 rounded-md bg-orange-50 text-orange-600 hover:bg-orange-100 disabled:opacity-50 flex items-center justify-center transition-colors">
            <i :class="firingKitchenId === order.id ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-fire'" class="text-[11px]"></i>
          </button>
          <button @click.stop="$emit('restore', order)" :title="$t ? $t('Restore Ticket') : 'Restore Ticket'"
            class="h-7 ps-2 pe-2.5 rounded-md bg-teal-600 text-white hover:bg-teal-700 flex items-center gap-1 transition-colors text-[9px] font-black uppercase">
            <i class="fa-solid fa-file-import text-[9px]"></i>
            <span>{{ $t ? $t('Restore') : 'Restore' }}</span>
          </button>
        </template>
        <button v-else @click.stop="$emit('reprint', order)" :title="$t ? $t('Reprint Receipt') : 'Reprint Receipt'"
          class="h-7 w-7 rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200 flex items-center justify-center transition-colors">
          <i class="fa-solid fa-print text-[11px]"></i>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { getTypeAccent } from '../utils/orderTypeAccent.js';
import { orderIdentityLabel } from '../utils/orderIdentityDisplay.js';
import { formatTimeOnly, formatScheduledTime } from '../utils/orderNotesFormat.js';

const props = defineProps({
  order: { type: Object, required: true },
  firingKitchenId: { type: [String, Number, null], default: null },
});
defineEmits(['open', 'fire', 'restore', 'reprint']);

const accent = computed(() => getTypeAccent(props.order.order_type_name));
const itemCount = computed(() => (props.order.items ? props.order.items.length : 0));
const cardName = computed(() => {
  const o = props.order;
  return o.customer_name || (o.raw_held_data && o.raw_held_data.reference_name) || '';
});
const totalDisplay = computed(() => parseFloat(props.order.total || 0).toFixed(2));
</script>

<style scoped>
/* Free virtualization: skip layout/paint for off-screen cards (history lists up to 200). */
.card-cv {
  content-visibility: auto;
  contain-intrinsic-size: auto 76px;
}
* {
  -webkit-tap-highlight-color: transparent;
}
button {
  touch-action: manipulation;
}
</style>
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: build completes with no errors (Vite compiles the new SFC; a template/syntax mistake fails here).

- [ ] **Step 3: Commit**

```bash
git add src/components/OrderNoteCard.vue
git commit -m "feat(order-notes): add OrderNoteCard minimal light+accent card"
```

---

### Task 5: Rework `OrderNotes.vue` — responsive board using the new card

Replace the header, the board (desktop fluid columns + phone chips/list), and the styles; wire in the utils + `OrderNoteCard`; add presentational state. Keep all network/business functions and the modal (modal restyled in Task 6). Do the edits in the order below so the file always compiles.

**Files:**
- Modify: `src/components/OrderNotes.vue`

**Interfaces:**
- Consumes: `OrderNoteCard` (Task 4), `getTypeAccent` (Task 1), `mergedCardsByTime` (Task 2), `formatDateTime` + `getQtyFormatted` + `isArabic` (Task 3), existing `orderIdentityLabel` / `orderIdentityTitle`.
- Produces: new template state `isMobile`, `activeChip`, `searchOpen`, computed `phoneCards`, `totalCardCount` (all consumed only within this file).

- [ ] **Step 1: Swap script imports.** Replace the existing import block (top of `<script setup>`, currently importing `orderIdentityLabel, orderIdentityTitle` and the composables) — add the new imports directly under the existing `import { orderIdentityLabel, orderIdentityTitle } ...` line:

```js
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { orderIdentityLabel, orderIdentityTitle } from '../utils/orderIdentityDisplay.js';
import OrderNoteCard from './OrderNoteCard.vue';
import { getTypeAccent } from '../utils/orderTypeAccent.js';
import { mergedCardsByTime } from '../utils/orderNotesBoard.js';
import { formatDateTime, getQtyFormatted, isArabic } from '../utils/orderNotesFormat.js';
```

- [ ] **Step 2: Delete the now-duplicated local functions from `<script setup>`.** Remove these five function definitions entirely (they now live in `orderNotesFormat.js`): `formatTimeOnly`, `formatDateTime`, `formatScheduledTime`, `getQtyFormatted`, `isArabic`. Also remove the two color functions `getCardColors` and `getColumnDotColorClass` (replaced by `getTypeAccent`). Leave everything else (`fetchOrders`, `processedHeldOrders`, `filteredOrders`, `orderTypeColumns`, `groupedOrders`, `restoreHeldOrder`, `fireToKitchen`, `reprintDirect`, `openPreviewModal`, socket handlers) untouched.

> Note: `formatTimeOnly` / `formatScheduledTime` are no longer referenced by the parent template after this task (only the card uses them). `formatDateTime`, `getQtyFormatted`, `isArabic` are still used by the modal, hence imported in Step 1.

- [ ] **Step 3: Add presentational state + computeds.** Insert after the existing `const showHistory = ref(false);` / `heldOrdersList` declarations (near the other refs):

```js
// --- Presentational state for the responsive board ---
const isMobile = ref(false);
const activeChip = ref('All');
const searchOpen = ref(false);
let mediaQuery = null;
const applyIsMobile = (e) => { isMobile.value = e.matches; };

const totalCardCount = computed(() => filteredOrders.value.length);
const phoneCards = computed(() => {
  if (activeChip.value === 'All') return mergedCardsByTime(groupedOrders.value, orderTypeColumns.value);
  return groupedOrders.value[activeChip.value] || [];
});
```

- [ ] **Step 4: Wire the media-query listener into the existing lifecycle hooks.** In the existing `onMounted(async () => { ... })`, add at the very top of the callback body (before `await fetchStoreSettings()`):

```js
  mediaQuery = window.matchMedia('(max-width: 767px)');
  isMobile.value = mediaQuery.matches;
  mediaQuery.addEventListener('change', applyIsMobile);
```

In the existing `onUnmounted(() => { ... })`, add at the top of the body:

```js
  if (mediaQuery) mediaQuery.removeEventListener('change', applyIsMobile);
```

- [ ] **Step 5: Replace the `<header>`.** Replace the entire existing `<header ...> ... </header>` block with:

```html
    <!-- Header -->
    <header class="bg-white border-b border-gray-200 shrink-0 z-30 select-none shadow-sm">
      <div class="h-14 px-3 sm:px-4 flex items-center justify-between gap-2">
        <!-- Left: back + title -->
        <div class="flex items-center gap-2 sm:gap-3 min-w-0">
          <button @click="goBack" class="flex items-center justify-center w-8 h-8 bg-white hover:bg-gray-50 text-gray-700 rounded-md border border-gray-300 transition-colors shadow-sm focus:outline-none shrink-0">
            <i class="fa-solid fa-arrow-left text-xs rtl:rotate-180"></i>
          </button>
          <h1 class="text-xs font-black uppercase tracking-wider text-gray-900 flex items-center gap-2 truncate">
            <i class="fa-solid fa-note-sticky text-teal-600 shrink-0"></i>
            <span class="truncate">{{ $t ? $t('Order Notes Board') : 'Order Notes Board' }}</span>
          </h1>
        </div>

        <!-- Right: controls -->
        <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <!-- Desktop search -->
          <div class="relative w-44 lg:w-60 hidden md:block">
            <i class="fa-solid fa-magnifying-glass absolute inset-inline-start-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[9px]"></i>
            <input type="text" v-model="searchQuery" :placeholder="$t ? $t('Search invoice, queue...') : 'Search invoice, queue...'"
              class="w-full bg-gray-50 text-[10px] font-bold text-gray-800 rounded-md border border-gray-200 focus:border-teal-500 focus:bg-white focus:ring-0 transition-all outline-none py-1.5 ps-7 pe-7" />
            <button v-if="searchQuery" @click="searchQuery = ''" class="absolute inset-inline-end-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-rose-500 focus:outline-none">
              <i class="fa-solid fa-circle-xmark text-[9px]"></i>
            </button>
          </div>

          <!-- Phone search toggle -->
          <button @click="searchOpen = !searchOpen"
            class="md:hidden flex items-center justify-center w-8 h-8 rounded-md border transition-colors focus:outline-none shadow-sm"
            :class="searchOpen ? 'bg-teal-600 border-teal-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'">
            <i class="fa-solid fa-magnifying-glass text-[11px]"></i>
          </button>

          <!-- Mode segmented control -->
          <div v-if="canViewHistory" class="flex items-center bg-gray-100 border border-gray-200 rounded-md p-0.5 text-[9px] font-black uppercase">
            <button @click="showHistory = false" class="px-2.5 py-1 rounded-[5px] transition-colors focus:outline-none"
              :class="!showHistory ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'">
              {{ $t ? $t('Suspended') : 'Suspended' }}
            </button>
            <button @click="showHistory = true" class="px-2.5 py-1 rounded-[5px] transition-colors focus:outline-none"
              :class="showHistory ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'">
              {{ $t ? $t('History') : 'History' }}
            </button>
          </div>

          <!-- Refresh -->
          <button @click="fetchOrders" :disabled="isLoading"
            class="flex items-center gap-1.5 px-2 sm:px-3 h-8 bg-white hover:bg-gray-50 text-gray-700 font-bold rounded-md border border-gray-300 text-[9px] uppercase transition-colors focus:outline-none shadow-sm">
            <i class="fa-solid fa-rotate text-[10px]" :class="{ 'fa-spin': isLoading }"></i>
            <span class="hidden md:inline">{{ $t ? $t('Refresh') : 'Refresh' }}</span>
          </button>
        </div>
      </div>

      <!-- Phone search row (collapsible) -->
      <div v-if="searchOpen" class="md:hidden px-3 pb-2">
        <div class="relative">
          <i class="fa-solid fa-magnifying-glass absolute inset-inline-start-3 top-1/2 -translate-y-1/2 text-gray-400 text-[10px]"></i>
          <input type="text" v-model="searchQuery" :placeholder="$t ? $t('Search invoice, queue...') : 'Search invoice, queue...'"
            class="w-full bg-gray-50 text-xs font-bold text-gray-800 rounded-md border border-gray-200 focus:border-teal-500 focus:bg-white focus:ring-0 outline-none py-2 ps-9 pe-9" />
          <button v-if="searchQuery" @click="searchQuery = ''" class="absolute inset-inline-end-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-rose-500 focus:outline-none">
            <i class="fa-solid fa-circle-xmark text-[11px]"></i>
          </button>
        </div>
      </div>

      <!-- Phone filter chips -->
      <div v-if="isMobile" class="flex items-center gap-1.5 px-3 pb-2 overflow-x-auto premium-scroll">
        <button @click="activeChip = 'All'"
          class="shrink-0 px-3 py-1 rounded-full border text-[10px] font-black uppercase tracking-wide transition-colors focus:outline-none flex items-center gap-1.5"
          :class="activeChip === 'All' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'">
          <span>{{ $t ? $t('All') : 'All' }}</span>
          <span class="opacity-70">{{ totalCardCount }}</span>
        </button>
        <button v-for="colName in orderTypeColumns" :key="colName" @click="activeChip = colName"
          class="shrink-0 px-3 py-1 rounded-full border text-[10px] font-black uppercase tracking-wide transition-colors focus:outline-none flex items-center gap-1.5"
          :class="activeChip === colName ? getTypeAccent(colName).chipActive : 'bg-white text-gray-600 border-gray-200'">
          <span class="w-1.5 h-1.5 rounded-full" :class="getTypeAccent(colName).dot"></span>
          <span class="truncate max-w-[90px]" data-no-i18n>{{ colName }}</span>
          <span class="opacity-70">{{ (groupedOrders[colName] || []).length }}</span>
        </button>
      </div>
    </header>
```

- [ ] **Step 6: Replace the `<main>` board.** Replace the entire existing `<main ...> ... </main>` block (the columns area, including the loading state and the `v-for` cards) with the loading state + two mutually-exclusive mains below:

```html
    <!-- Loading -->
    <div v-if="isLoading && filteredOrders.length === 0" class="flex-1 flex flex-col items-center justify-center text-gray-400">
      <i class="fa-solid fa-circle-notch fa-spin text-2xl mb-2 text-teal-600"></i>
      <p class="text-[9px] font-black uppercase tracking-widest">{{ $t ? $t('Loading Orders...') : 'Loading Orders...' }}</p>
    </div>

    <!-- DESKTOP / TABLET: fluid type columns -->
    <main v-else-if="!isMobile" class="flex-1 overflow-x-auto overflow-y-hidden flex gap-3 p-3 bg-gray-100 min-w-0">
      <section v-for="colName in orderTypeColumns" :key="colName"
        class="flex-1 min-w-[240px] max-w-[380px] flex flex-col min-h-0 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="px-3.5 py-2.5 border-b border-gray-100 flex items-center justify-between shrink-0 select-none">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2 h-2 rounded-full shrink-0" :class="getTypeAccent(colName).dot"></span>
            <h2 class="text-[11px] font-black uppercase tracking-wider text-gray-800 truncate" data-no-i18n>{{ colName }}</h2>
          </div>
          <span class="px-2 py-0.5 rounded-full bg-gray-100 text-[10px] font-black text-gray-500">{{ (groupedOrders[colName] || []).length }}</span>
        </div>
        <div class="flex-1 overflow-y-auto premium-scroll p-2 space-y-2 bg-gray-50/60">
          <div v-if="(groupedOrders[colName] || []).length === 0"
            class="h-16 flex items-center justify-center text-gray-400 border border-dashed border-gray-200 rounded-lg bg-white">
            <p class="text-[9px] font-black uppercase tracking-widest">{{ $t ? $t('No active orders') : 'No active orders' }}</p>
          </div>
          <OrderNoteCard v-for="order in groupedOrders[colName]" :key="order.invoice_id"
            :order="order" :firing-kitchen-id="firingKitchenId"
            @open="openPreviewModal" @fire="fireToKitchen" @restore="restoreHeldOrder" @reprint="reprintDirect" />
        </div>
      </section>
    </main>

    <!-- PHONE: single filtered list -->
    <main v-else class="flex-1 overflow-y-auto premium-scroll p-3 space-y-2 bg-gray-100">
      <div v-if="phoneCards.length === 0" class="h-40 flex flex-col items-center justify-center text-gray-400">
        <i class="fa-regular fa-folder-open text-3xl mb-2"></i>
        <p class="text-[10px] font-black uppercase tracking-widest">{{ $t ? $t('No active orders') : 'No active orders' }}</p>
      </div>
      <OrderNoteCard v-for="order in phoneCards" :key="order.invoice_id"
        :order="order" :firing-kitchen-id="firingKitchenId"
        @open="openPreviewModal" @fire="fireToKitchen" @restore="restoreHeldOrder" @reprint="reprintDirect" />
    </main>
```

- [ ] **Step 7: Trim the `<style scoped>` block.** In `OrderNotes.vue`'s `<style scoped>`, remove the now-unused `.line-clamp-2 { ... }` rule (the card no longer clamps item lines). Keep the font rule, `-webkit-tap-highlight-color`, `touch-action`, `.premium-scroll` rules, and the `.overflow-y-auto` / `.overflow-x-auto` touch rules unchanged.

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: build completes with no errors.

- [ ] **Step 9: Visual + interaction review.** Start the app (`npm start` for the Express server, and serve/point the browser at the POS app; log in as a cashier with `orders.view`). Invoke the **web-design-reviewer** skill against `/order-notes`:
  - Desktop width (~1280px): fluid columns, small light cards with correct colored stripe/label/total, counts correct, no forced horizontal scroll for 2–3 types.
  - Phone width (~390px): chip row (All + per-type counts), single list, "All" merged & time-sorted, chips filter, collapsible search works.
  - Toggle Suspended ↔ History; confirm both render; search filters.
  - Click a card → modal opens; Fire / Restore / Reprint buttons still fire (`@click.stop` prevents modal open).
  - RTL: switch app to Arabic; confirm stripe sits on the inline-start, chips/scroll direction correct, no clipped text.
  Fix any issues found, re-run `npm run build`.

- [ ] **Step 10: Commit**

```bash
git add src/components/OrderNotes.vue
git commit -m "feat(order-notes): responsive light card board (desktop columns + phone chips)"
```

---

### Task 6: Restyle the receipt-preview modal to match

Light-touch alignment/palette pass on the existing modal — keep every field and all four buttons (Close / Kitchen / Restore / Reprint). The modal already uses brand teal (kept as the interactive color); adjust container rounding, spacing, and the type-accent on the total.

**Files:**
- Modify: `src/components/OrderNotes.vue` (the `<div v-if="showPreviewModal" ...>` block only)

**Interfaces:**
- Consumes: `getTypeAccent` (Task 1) for the modal total accent; existing `selectedOrder`, `formatDateTime`, `getQtyFormatted`, `isArabic`, `orderIdentityLabel`, `orderIdentityTitle`.

- [ ] **Step 1: Round the modal container.** In the modal, change the dialog panel wrapper class `rounded shadow-xl` → `rounded-xl shadow-2xl`, and the header bar / footer bar `rounded`-less corners inherit; ensure the header uses `rounded-t-xl` and footer `rounded-b-xl` if they set their own backgrounds. Concretely, replace:

```html
      <div class="bg-white border border-gray-300 rounded shadow-xl w-full max-w-sm overflow-hidden flex flex-col max-h-[85vh] animate-scale-in">
```
with:
```html
      <div class="bg-white border border-gray-200 rounded-xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col max-h-[85vh] animate-scale-in">
```

- [ ] **Step 2: Accent the modal total.** Replace the two hard-coded `text-teal-600` totals in the modal totals block with the type accent. Add — directly after the modal's opening content `<div v-if="selectedOrder" ...>` is fine, but simplest: bind a local expression. Replace the grand-total line:

```html
            <div class="flex justify-between text-xs font-black border-t border-gray-155 pt-2.5 text-gray-900">
              <span>{{ $t ? $t('Total') : 'Total' }}:</span>
              <span class="text-teal-600 font-black" data-no-i18n>{{ parseFloat(selectedOrder.total).toFixed(2) }} JD</span>
            </div>
```
with:
```html
            <div class="flex justify-between text-xs font-black border-t border-gray-200 pt-2.5 text-gray-900">
              <span>{{ $t ? $t('Total') : 'Total' }}:</span>
              <span :class="['font-black', getTypeAccent(selectedOrder.order_type_name).total]" data-no-i18n>{{ parseFloat(selectedOrder.total).toFixed(2) }} JD</span>
            </div>
```

- [ ] **Step 3: Normalize stray palette values.** In the modal, replace the non-standard gray utilities `text-gray-450`, `text-gray-505`, `text-gray-550`, `text-gray-155`, `text-gray-155` with the nearest standard token: `text-gray-450`→`text-gray-400`, `text-gray-505`→`text-gray-500`, `text-gray-550`→`text-gray-500`, `border-gray-155`→`border-gray-200`, `border-gray-155`→`border-gray-200`. (These non-existent shades render as no color today.) Leave all text content and structure otherwise unchanged.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build completes with no errors.

- [ ] **Step 5: Review the modal.** With the app running, open a card → confirm the modal reads cleanly: rounded panel, total shows the card's type accent color, all fields present, Close/Kitchen/Restore/Reprint all work. Check Arabic RTL alignment of the receipt rows.

- [ ] **Step 6: Commit**

```bash
git add src/components/OrderNotes.vue
git commit -m "style(order-notes): align receipt preview modal to new palette"
```

---

### Task 7: Final verification & polish

Whole-feature gate: unit tests green, build green, full design review at both widths + RTL, performance sanity, no regressions.

**Files:**
- Modify (only if the review surfaces fixes): `src/components/OrderNotes.vue`, `src/components/OrderNoteCard.vue`, `src/utils/*`.

- [ ] **Step 1: Run the new unit tests together**

Run: `npx vitest run src/utils/orderTypeAccent.spec.js src/utils/orderNotesBoard.spec.js src/utils/orderNotesFormat.spec.js`
Expected: PASS (15 tests total: 5 + 4 + 6).

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: "built in …" success, no warnings about the changed files.

- [ ] **Step 3: Full `web-design-reviewer` pass.** With the app running and some **suspended tickets** and **finalized orders** present, review `/order-notes` at desktop (~1280px) and phone (~390px), LTR and RTL. Confirm:
  - One accent per card (stripe + type label + total only); four type colors visually distinct; AA contrast on white.
  - Cards are ~60–80px, no oversized min-height, no clipped text on long names (truncate works).
  - Phone: chips scroll, counts correct, "All" merged/time-sorted, per-type filter correct, search collapses.
  - No page-level horizontal scroll on phone; board horizontal scroll only appears on desktop when types overflow.

- [ ] **Step 4: Performance sanity.** In History mode with ≥100 orders, scroll a column (desktop) and the list (phone). Confirm smooth scrolling, the column dot is **static** (no perpetual pulse), and DevTools shows cards outside the viewport are skipped (`content-visibility`). No layout thrash on hover (shadow-only transition).

- [ ] **Step 5: Regression smoke.** Verify unchanged behaviors still work: Suspended↔History toggle, socket auto-refresh (open on two tabs, hold an order → board updates), Restore claims the ticket and routes to `/pos`, Fire-to-Kitchen toast, Reprint. Confirm no console errors.

- [ ] **Step 6: Final commit (only if fixes were made in this task)**

```bash
git add -A
git commit -m "polish(order-notes): design-review + verification fixes"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| Responsive columns → phone tabs | Task 5 (Steps 5–6) |
| Minimal-summary card | Task 4 |
| Light card + colored accent | Task 1 + Task 4 |
| Phone default "All" merged, time-sorted | Task 2 + Task 5 (Step 3) |
| Color system / literal classes | Task 1 |
| Header: segmented control, collapsing search, icon refresh | Task 5 (Step 5) |
| Delivery scheduled time on card | Task 4 (Row 1) |
| Modal kept + restyled | Task 6 |
| Empty/loading restyle | Task 5 (Step 6) |
| Performance (fewer nodes, no pulse, no blur, content-visibility, stable keys) | Task 4 (style) + Task 5 (Steps 6–7) + Task 7 (Step 4) |
| No backend/data-logic change; i18n/RTL/socket/perms preserved | Global Constraints; enforced in Task 5 Steps 2–4 |

No gaps found.

**2. Placeholder scan:** No TBD/TODO; every code step contains full code. ✔

**3. Type consistency:** `getTypeAccent` returns `{ key, stripe, label, total, dot, chipActive }` — consumed as `.stripe/.label/.total/.dot/.chipActive` in Tasks 4/5/6. ✔ `mergedCardsByTime(groupedOrders, columns)` signature matches the Task 5 call. ✔ `OrderNoteCard` props (`order`, `firingKitchenId`) + emits (`open/fire/restore/reprint`) match the parent bindings in Task 5 Step 6. ✔ Formatter names match between Task 3 exports and Task 4/5 imports. ✔

**4. Ambiguity:** Edit anchors reference exact existing class strings; mutually-exclusive `v-if/v-else-if/v-else` for loading/desktop/phone mains prevents double-render. ✔
