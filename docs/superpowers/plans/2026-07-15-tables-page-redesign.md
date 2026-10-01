# Tables Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/tables` into the approved calm operational grid with larger solid-color table cards, teal controls, clear responsive navigation, and complete English/Arabic copy while preserving every existing table workflow.

**Architecture:** Keep `TableFloorPlan.vue` as the single workflow owner and retain its existing composables, socket subscriptions, permissions, and KeepAlive identity. Move only deterministic display rules into one pure utility so time/status formatting is unit-testable, protect localization and visual decisions with source-contract tests, and use stable data attributes for the existing waiter E2E workflow.

**Tech Stack:** Vue 3.5 Composition API with `<script setup>`, Tailwind CSS 4 plus scoped CSS, shared POS i18n, Vitest, Playwright, Vite.

## Global Constraints

- Approved design source: `docs/superpowers/specs/2026-07-15-tables-page-redesign-design.md`.
- Preserve normal tap-to-open, long press, right click, swipe, transfer, join, disjoin, split-check, PIN, dynamic-table, socket, and KeepAlive behavior.
- Full card state colors are exactly `#2d6a4f` available, `#ad4c45` saved, and `#3d699b` printed.
- Teal `#0f766e` is reserved for navigation, selected tabs, focus, and actions.
- Canvas is `#e9e9e5`; primary surface is `#f7f7f4`.
- No card gradients, status borders, repeated status labels, heavy shadows, glass effects, or ten-column table grid.
- Table numbers, counts, elapsed values, and totals use Latin digits in English and Arabic. Preserve current currency presentation.
- Database section names and user names remain verbatim and are never machine-translated.
- No backend, database, permission, order-calculation, or new dependency changes.
- Keep the Options API name block because `App.vue` KeepAlive includes `TableFloorPlan` by name. Do not convert the current JavaScript SFC to TypeScript in this visual task.
- The current worktree contains unrelated table-void, split-check, printing, and translation edits. Never reset or overwrite them. `assets/js/admin/i18n.js` must be edited additively and staged by hunk unless those earlier changes have been committed first.

---

## File map

| File | Responsibility |
|---|---|
| `src/components/TableFloorPlan.vue` | Page layout, interactions, responsive menu, cards, modes, dialogs, and reactive wiring |
| `src/utils/tableFloorPlanPresentation.js` | Pure status-key/class mapping and Latin elapsed-time formatting |
| `src/utils/tableFloorPlanPresentation.spec.js` | Unit contract for presentation helpers |
| `src/components/__tests__/tableFloorPlanLocalization.spec.js` | Static and dynamic English/Arabic key coverage |
| `src/components/__tests__/tableFloorPlanDesignContract.spec.js` | Approved palette, density, semantic hooks, and anti-gradient contract |
| `assets/js/admin/i18n.js` | Natural Arabic translations for every visible table-page string |
| `tests/e2e/specs/waiter.tables.spec.js` | Tap-to-open, saved status, options isolation, and responsive navigation behavior |

---

### Task 1: Extract and test deterministic table presentation rules

**Files:**

- Create: `src/utils/tableFloorPlanPresentation.js`
- Create: `src/utils/tableFloorPlanPresentation.spec.js`
- Modify: `src/components/TableFloorPlan.vue:440-710`

**Interfaces:**

- Produces: `getTableStatusClass(status): string`
- Produces: `getTableStatusKey(status): string`
- Produces: `formatTableElapsedTime(createdAt, nowMs, translate): string`
- Consumes: `translate(key)` with the same one-string contract as shared `t()`

- [ ] **Step 1: Write the failing presentation-helper tests**

Create `src/utils/tableFloorPlanPresentation.spec.js`:

```js
import { describe, expect, it } from 'vitest';
import {
  formatTableElapsedTime,
  getTableStatusClass,
  getTableStatusKey
} from './tableFloorPlanPresentation.js';

describe('table floor presentation', () => {
  it.each([
    ['available', 'table-card--available', 'Available'],
    ['occupied', 'table-card--occupied', 'Occupied'],
    ['printed', 'table-card--printed', 'Bill Printed'],
    ['unexpected', 'table-card--unknown', 'Unknown']
  ])('maps %s to an explicit class and translation key', (status, cssClass, key) => {
    expect(getTableStatusClass(status)).toBe(cssClass);
    expect(getTableStatusKey(status)).toBe(key);
  });

  it('formats elapsed minutes and hours with Latin digits', () => {
    const now = Date.parse('2026-07-15T12:00:00Z');
    const translate = (key) => ({ min: 'د', hr: 'س' })[key] || key;

    expect(formatTableElapsedTime('2026-07-15T11:48:00Z', now, translate)).toBe('12 د');
    expect(formatTableElapsedTime('2026-07-15T10:55:00Z', now, translate)).toBe('1 س 5 د');
    expect(formatTableElapsedTime('2026-07-15T12:05:00Z', now, translate)).toBe('0 د');
  });

  it('returns an empty value for absent or invalid dates', () => {
    const now = Date.parse('2026-07-15T12:00:00Z');
    expect(formatTableElapsedTime(null, now)).toBe('');
    expect(formatTableElapsedTime('not-a-date', now)).toBe('');
  });
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```powershell
npx --no-install vitest run src/utils/tableFloorPlanPresentation.spec.js
```

Expected: FAIL because `tableFloorPlanPresentation.js` does not exist.

- [ ] **Step 3: Implement the pure helper module**

Create `src/utils/tableFloorPlanPresentation.js`:

```js
const STATUS_PRESENTATION = Object.freeze({
  available: Object.freeze({ cssClass: 'table-card--available', translationKey: 'Available' }),
  occupied: Object.freeze({ cssClass: 'table-card--occupied', translationKey: 'Occupied' }),
  printed: Object.freeze({ cssClass: 'table-card--printed', translationKey: 'Bill Printed' })
});

const UNKNOWN_STATUS = Object.freeze({
  cssClass: 'table-card--unknown',
  translationKey: 'Unknown'
});

const latinInteger = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
  useGrouping: false
});

function statusPresentation(status) {
  return STATUS_PRESENTATION[String(status || '').toLowerCase()] || UNKNOWN_STATUS;
}

export function getTableStatusClass(status) {
  return statusPresentation(status).cssClass;
}

export function getTableStatusKey(status) {
  return statusPresentation(status).translationKey;
}

export function formatTableElapsedTime(createdAt, nowMs = Date.now(), translate = (key) => key) {
  if (!createdAt) return '';

  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) return '';

  const totalMinutes = Math.max(0, Math.floor((nowMs - createdMs) / 60000));
  if (totalMinutes < 60) {
    return `${latinInteger.format(totalMinutes)} ${translate('min')}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${latinInteger.format(hours)} ${translate('hr')}`;
  }

  return `${latinInteger.format(hours)} ${translate('hr')} ${latinInteger.format(minutes)} ${translate('min')}`;
}
```

- [ ] **Step 4: Wire elapsed formatting into the existing component**

Add this import in `TableFloorPlan.vue`:

```js
import { formatTableElapsedTime } from '../utils/tableFloorPlanPresentation.js';
```

Replace the current `getElapsedTime` body with:

```js
const getElapsedTime = (createdAt) => {
  return formatTableElapsedTime(createdAt, nowTime.value, t);
};
```

Do not change the existing 30-second `nowTime` interval.

- [ ] **Step 5: Run the helper test and Vue build**

Run:

```powershell
npx --no-install vitest run src/utils/tableFloorPlanPresentation.spec.js
npm run build:admin
```

Expected: helper test PASS; Vite build exits 0 with no Vue template warning.

- [ ] **Step 6: Commit the helper slice**

```powershell
git add -- src/utils/tableFloorPlanPresentation.js src/utils/tableFloorPlanPresentation.spec.js src/components/TableFloorPlan.vue
git commit -m "refactor(tables): isolate floor presentation rules"
```

---

### Task 2: Make every table-page string natural in Arabic

**Files:**

- Create: `src/components/__tests__/tableFloorPlanLocalization.spec.js`
- Modify: `assets/js/admin/i18n.js`
- Modify: `src/components/TableFloorPlan.vue:1-430,690-725`

**Interfaces:**

- Consumes: `getTableStatusKey(status)` from Task 1
- Produces: a localization contract covering every static `$t()` call and every dynamic/fallback key

- [ ] **Step 1: Write the failing localization contract**

Create `src/components/__tests__/tableFloorPlanLocalization.spec.js`:

```js
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Table floor localization contract', () => {
  const componentSource = fs.readFileSync(
    path.resolve(__dirname, '../TableFloorPlan.vue'),
    'utf8'
  );
  const dictionarySource = fs.readFileSync(
    path.resolve(__dirname, '../../../assets/js/admin/i18n.js'),
    'utf8'
  );
  const arabicKeys = new Set(
    [...dictionarySource.matchAll(/^\s*'([^']+)'\s*:/gm)].map((match) => match[1])
  );

  it('has an Arabic entry for every static table-page translation key', () => {
    const staticKeys = new Set(
      [...componentSource.matchAll(/\$t\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
    );
    expect([...staticKeys].filter((key) => !arabicKeys.has(key)).sort()).toEqual([]);
  });

  it('covers status, elapsed, fallback, navigation, and empty-search keys', () => {
    const dynamicKeys = [
      'Available',
      'Occupied',
      'Bill Printed',
      'Unknown',
      'Staff member',
      'min',
      'hr',
      'No section',
      'Table options',
      'Table status counts',
      'Navigation menu',
      'Close navigation menu',
      'Table actions',
      'No tables match your search.',
      'Try another table number or waiter name.'
    ];
    expect(dynamicKeys.filter((key) => !arabicKeys.has(key))).toEqual([]);
  });

  it('does not expose raw English status or elapsed fallbacks', () => {
    expect(componentSource).not.toContain("|| 'Staff'");
    expect(componentSource).not.toContain("return '0m'");
    expect(componentSource).not.toContain('$t(selectedActionTable?.status)');
  });
});
```

- [ ] **Step 2: Run the localization contract and verify missing keys**

Run:

```powershell
npx --no-install vitest run src/components/__tests__/tableFloorPlanLocalization.spec.js
```

Expected: FAIL and list the currently missing table-page keys.

- [ ] **Step 3: Add the Arabic dictionary entries**

Add this group once inside the `ar` dictionary in `assets/js/admin/i18n.js`. If a key was added by the current uncommitted work, keep that existing translation and do not create a duplicate.

```js
    // --- Tables floor workspace ---
    'Bill Printed': 'تمت طباعة الفاتورة',
    'Search Table...': 'ابحث عن طاولة...',
    'POS Terminal': 'نقطة البيع',
    'Table Splits': 'تقسيم الفواتير',
    'Transfer Mode: Select an available target table for Table': 'وضع النقل: اختر طاولة متاحة لنقل طلب الطاولة',
    'Join Mode: Click tables to group with Table': 'وضع الدمج: اختر الطاولات المراد دمجها مع الطاولة',
    'Zone': 'القسم',
    'QR Customer Cart Active': 'سلة طلب العميل عبر QR نشطة',
    'Joined Table': 'طاولة مدمجة',
    'Unpaid Split Checks': 'فواتير مقسمة غير مدفوعة',
    'There are no tables assigned to this section yet. Add tables from the Admin Dashboard.': 'لا توجد طاولات مضافة إلى هذا القسم بعد. يمكنك إضافتها من لوحة الإدارة.',
    'Open a Tab or Table': 'افتح حسابًا أو طاولة',
    'Enter a unique tab name or table number to instantly open a new order or resume an existing one.': 'أدخل اسم حساب أو رقم طاولة لفتح طلب جديد أو متابعة طلب موجود.',
    'Joined to Table': 'مدمجة مع الطاولة',
    'Open Cart': 'فتح الطلب',
    'Transfer Order': 'نقل الطلب',
    'Join Tables': 'دمج الطاولات',
    'Disjoin Table': 'فصل الطاولة',
    'Dissolve Joint Group': 'فك مجموعة الطاولات',
    'Manager Authorization': 'صلاحية المدير',
    'Enter Manager PIN to override': 'أدخل رمز المدير للمتابعة',
    'Submit': 'تأكيد',
    'Staff member': 'موظف',
    'min': 'د',
    'hr': 'س',
    'No section': 'لا يوجد قسم',
    'Table options': 'خيارات الطاولة',
    'Table status counts': 'ملخص حالات الطاولات',
    'Navigation menu': 'قائمة التنقل',
    'Close navigation menu': 'إغلاق قائمة التنقل',
    'Table actions': 'إجراءات الطاولة',
    'No tables match your search.': 'لا توجد طاولات مطابقة للبحث.',
    'Try another table number or waiter name.': 'جرّب رقم طاولة أو اسم موظف آخر.'
```

- [ ] **Step 4: Replace raw fallbacks and dynamic status translation**

Expand the Task 1 import:

```js
import {
  formatTableElapsedTime,
  getTableStatusKey
} from '../utils/tableFloorPlanPresentation.js';
```

Use these exact replacements:

```vue
{{ table.active_order_waiter_name || $t('Staff member') }}
```

```vue
{{ $t(getTableStatusKey(selectedActionTable?.status)) }}
```

```js
const currentSectionName = computed(() => {
  const activeSec = sections.value.find((section) => section.id === activeSection.value);
  return activeSec ? activeSec.name : t('No section');
});
```

Keep `section.name`, `section_name`, waiter names, table numbers, and totals protected with `data-no-i18n` where they are visible.

- [ ] **Step 5: Run localization and presentation tests**

```powershell
npx --no-install vitest run src/components/__tests__/tableFloorPlanLocalization.spec.js src/utils/tableFloorPlanPresentation.spec.js
```

Expected: both files PASS.

- [ ] **Step 6: Commit only the localization slice**

Inspect the pre-existing i18n diff first:

```powershell
git diff -- assets/js/admin/i18n.js
```

Stage the new test and component normally, then stage only the new table-workspace dictionary hunk if unrelated i18n edits remain:

```powershell
git add -- src/components/__tests__/tableFloorPlanLocalization.spec.js src/components/TableFloorPlan.vue
git add -p -- assets/js/admin/i18n.js
git diff --cached --check
git commit -m "fix(tables): complete Arabic floor translations"
```

---

### Task 3: Build the calm header, section strip, responsive navigation, and table grid

**Files:**

- Modify: `src/components/TableFloorPlan.vue:1-277,440-535,930-1068`
- Modify: `tests/e2e/specs/waiter.tables.spec.js`
- Use: `src/utils/tableFloorPlanPresentation.js`

**Interfaces:**

- Consumes: `getTableStatusClass(status)` and `getTableStatusKey(status)`
- Produces: stable `data-testid`, `data-table-number`, and `data-table-status` hooks
- Preserves: `handleTableClick`, `triggerActionSheet`, long-press handlers, section swipe handlers, permission computed values, and router actions

- [ ] **Step 1: Replace brittle E2E selectors and add options isolation**

In `tests/e2e/specs/waiter.tables.spec.js`, replace `div.h-32` selectors with:

```js
const tableCard = (page, tableNumber) => page.locator(
  `[data-testid="table-card"][data-table-number="${tableNumber}"]`
);
```

Use `tableCard(page, '1')` in the save workflow. Replace the final Tailwind class assertion with:

```js
await expect(tableCard(page, '1')).toHaveAttribute('data-table-status', 'occupied');
```

Add these two tests inside the existing describe block:

```js
test('opens table actions without entering the table', async ({ page }) => {
  await page.goto('/tables');
  const table = tableCard(page, '1');
  await expect(table).toBeVisible();

  await table.getByRole('button', { name: 'Table options 1' }).click();

  await expect(page).toHaveURL(/\/tables$/);
  await expect(page.getByRole('dialog', { name: 'Table 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Cart' }).click();
  await expect(page).toHaveURL(/\/pos$/);
});

test('uses one navigation menu at a 1024px POS width', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/tables');

  await expect(page.getByTestId('tables-wide-actions')).toBeHidden();
  await page.getByTestId('tables-navigation-menu').click();
  await expect(page.getByRole('menu', { name: 'Navigation menu' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
});
```

- [ ] **Step 2: Run the waiter E2E file and verify the red state**

```powershell
npx --no-install playwright test tests/e2e/specs/waiter.tables.spec.js --project=waiter-tests
```

Expected: FAIL because the stable card attributes, options button, dialog semantics, and responsive navigation menu do not exist.

- [ ] **Step 3: Add the responsive navigation state and accessible labels**

Expand the presentation import:

```js
import {
  formatTableElapsedTime,
  getTableStatusClass,
  getTableStatusKey
} from '../utils/tableFloorPlanPresentation.js';
```

Add this local state and helpers beside `tableSearchQuery`:

```js
const showNavigationMenu = ref(false);

const closeNavigationMenu = () => {
  showNavigationMenu.value = false;
};

const getTableAriaLabel = (table) => {
  const parts = [
    `${t('Table')} ${table.table_number}`,
    t(getTableStatusKey(table.status))
  ];
  if (table.active_order_waiter_name) parts.push(table.active_order_waiter_name);
  return parts.join(', ');
};

const getTableOptionsLabel = (table) => {
  return `${t('Table options')} ${table.table_number}`;
};

const formatTableTotal = (value) => Number(value || 0).toFixed(2);
```

Set `showNavigationMenu.value = false` in both `onActivated` and `onDeactivated` so KeepAlive never restores a stale open menu.

- [ ] **Step 4: Replace the header and section-tab structure**

The new header must use the following stable structure and responsive rules:

```vue
<header class="tables-header">
  <div class="tables-heading">
    <span class="tables-heading__icon" aria-hidden="true">
      <i class="fa-solid fa-table-cells-large"></i>
    </span>
    <div class="min-w-0">
      <h1>{{ $t('Tables') }}</h1>
      <p data-no-i18n>{{ settings.table_mode === 'fixed' ? currentSectionName : $t('Dynamic Table') }}</p>
    </div>
  </div>

  <div class="tables-counts hidden md:flex" :aria-label="$t('Table status counts')">
    <span class="tables-count"><i class="status-dot status-dot--available"></i><b data-no-i18n>{{ tableCounts.available }}</b>{{ $t('Available') }}</span>
    <span class="tables-count"><i class="status-dot status-dot--occupied"></i><b data-no-i18n>{{ tableCounts.occupied }}</b>{{ $t('Occupied') }}</span>
    <span class="tables-count"><i class="status-dot status-dot--printed"></i><b data-no-i18n>{{ tableCounts.printed }}</b>{{ $t('Bill Printed') }}</span>
  </div>

  <div class="tables-header__spacer"></div>

  <label class="tables-search hidden sm:block">
    <span class="sr-only">{{ $t('Search Table...') }}</span>
    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
    <input v-model="tableSearchQuery" type="search" :placeholder="$t('Search Table...')" />
  </label>

  <div data-testid="tables-wide-actions" class="hidden xl:flex items-center gap-2">
    <button v-if="activeUser && (activeUser.role === 'admin' || activeUser.role === 'programmer')" class="tables-action" @click="goToAdminDashboard">
      <i class="fa-solid fa-gauge-high" aria-hidden="true"></i><span>{{ $t('Admin Dashboard') }}</span>
    </button>
    <button v-if="activeUser && activeUser.role !== 'waiter' && can('shift.open')" class="tables-action" @click="goToPOS">
      <i class="fa-solid fa-shop" aria-hidden="true"></i><span>{{ $t('POS Terminal') }}</span>
    </button>
    <button v-if="canSplitBillPermission" class="tables-action" @click="router.push('/table-splits')">
      <i class="fa-solid fa-arrows-split-up-and-left" aria-hidden="true"></i><span>{{ $t('Table Splits') }}</span>
      <b v-if="tableSplitsList.length" data-no-i18n>{{ tableSplitsList.length }}</b>
    </button>
    <button class="tables-icon-action" :aria-label="$t('Logout')" @click="logout">
      <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
    </button>
  </div>

  <div class="relative xl:hidden" @keydown.esc="closeNavigationMenu">
    <button
      data-testid="tables-navigation-menu"
      class="tables-menu-trigger"
      type="button"
      :aria-label="$t('Navigation menu')"
      :aria-expanded="showNavigationMenu"
      @click="showNavigationMenu = !showNavigationMenu"
    >
      <span>{{ $t('Menu') }}</span><i class="fa-solid fa-bars" aria-hidden="true"></i>
    </button>
    <button v-if="showNavigationMenu" class="tables-menu-backdrop" type="button" :aria-label="$t('Close navigation menu')" @click="closeNavigationMenu"></button>
    <div v-if="showNavigationMenu" class="tables-navigation-menu" role="menu" :aria-label="$t('Navigation menu')">
      <button v-if="activeUser && (activeUser.role === 'admin' || activeUser.role === 'programmer')" role="menuitem" @click="closeNavigationMenu(); goToAdminDashboard()">{{ $t('Admin Dashboard') }}</button>
      <button v-if="activeUser && activeUser.role !== 'waiter' && can('shift.open')" role="menuitem" @click="closeNavigationMenu(); goToPOS()">{{ $t('POS Terminal') }}</button>
      <button v-if="canSplitBillPermission" role="menuitem" @click="closeNavigationMenu(); router.push('/table-splits')">{{ $t('Table Splits') }}</button>
      <button role="menuitem" @click="closeNavigationMenu(); logout()">{{ $t('Logout') }}</button>
    </div>
  </div>
</header>
```

Replace the nested gray pill tab container and redundant `Zone` label with one `section-strip`. Keep the existing `id`, click, and selected-tab scroll contract:

```vue
<div id="section-tabs-container" class="section-strip">
  <div class="section-strip__tabs hide-scroll">
    <button
      v-for="section in sections"
      :key="section.id"
      :id="`section-tab-${section.id}`"
      type="button"
      :class="['section-tab', { 'section-tab--active': activeSection === section.id }]"
      :aria-pressed="activeSection === section.id"
      @click="activeSection = section.id"
    >
      <span data-no-i18n>{{ section.name }}</span>
    </button>
  </div>
  <span class="section-strip__count hidden sm:block" data-no-i18n>{{ filteredTablesList.length }} {{ $t('Tables') }}</span>
</div>
```

Delete the old `Mobile Info Ribbon`. At widths below 768px, prioritize title, search, menu, tabs, and table cards; the full state counts remain available through the card colors and return in the header at `md`.

- [ ] **Step 5: Replace the table-card markup without changing workflow handlers**

Use the stable attributes and explicit options event isolation below. Preserve the existing QR, joined, split, elapsed, and active-mode data sources.

```vue
<div class="tables-grid">
  <div
    v-for="table in filteredTablesList"
    :key="table.id"
    data-testid="table-card"
    :data-table-number="String(table.table_number)"
    :data-table-status="table.status"
    role="button"
    tabindex="0"
    :aria-label="getTableAriaLabel(table)"
    :class="[
      'table-card',
      getTableStatusClass(table.status),
      { 'table-card--join-selected': joinSelectedChildIds.includes(table.id) },
      { 'table-card--transfer-source': activeMode === 'transfer' && activeModeSourceTable?.id === table.id }
    ]"
    @click="handleTableClick(table)"
    @keydown.enter.self="handleTableClick(table)"
    @keydown.space.prevent.self="handleTableClick(table)"
    @contextmenu.prevent="handleTableContext(table)"
    @touchstart.passive="startTouchHold(table, $event)"
    @touchmove.passive="moveTouchHold($event)"
    @touchend.passive="endTouchHold"
  >
    <div class="table-card__top">
      <div>
        <strong class="table-card__number" data-no-i18n>{{ table.table_number }}</strong>
        <span class="table-card__label">{{ $t('Table') }}</span>
      </div>
      <button
        class="table-card__options"
        type="button"
        :aria-label="getTableOptionsLabel(table)"
        @click.stop="triggerActionSheet(table)"
        @contextmenu.stop.prevent
        @touchstart.stop
        @touchend.stop
      >
        <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
      </button>
    </div>

    <div v-if="table.qr_draft_count > 0 || table.parent_table_id || getTableSplitsCount(table.table_number) > 0" class="table-card__indicators">
      <span v-if="table.qr_draft_count > 0" :title="$t('QR Customer Cart Active')"><i class="fa-solid fa-mobile-screen-button" aria-hidden="true"></i><b data-no-i18n>{{ table.qr_draft_count }}</b></span>
      <span v-if="table.parent_table_id" :title="$t('Joined Table')"><i class="fa-solid fa-link" aria-hidden="true"></i><b data-no-i18n>{{ getParentTableNumber(table.parent_table_id) }}</b></span>
      <span v-if="getTableSplitsCount(table.table_number) > 0" :title="$t('Unpaid Split Checks')"><i class="fa-solid fa-arrows-split-up-and-left" aria-hidden="true"></i><b data-no-i18n>{{ getTableSplitsCount(table.table_number) }}</b></span>
    </div>

    <div v-if="table.current_order_id" class="table-card__footer">
      <span class="table-card__meta" data-no-i18n>
        {{ table.active_order_waiter_name || $t('Staff member') }}
        <template v-if="table.active_order_created_at"> · {{ getElapsedTime(table.active_order_created_at) }}</template>
      </span>
      <strong class="table-card__total" data-no-i18n>{{ formatTableTotal(table.active_order_total) }}</strong>
    </div>
  </div>
</div>
<!-- Empty table state -->
```

Add `role="dialog"`, `aria-modal="true"`, and `:aria-label="`${$t('Table')} ${selectedActionTable?.table_number}`"` to the existing action-sheet panel before running the Task 3 E2E file. Task 4 will restyle the same semantic panel without changing the role or accessible name.

- [ ] **Step 6: Add the approved grid and card CSS**

Remove the component-wide `font-family: ... !important` selector. Set the font on `.tables-page`, then add the RTL override.

```css
.tables-page {
  --tables-teal: #0f766e;
  --tables-canvas: #e9e9e5;
  --tables-surface: #f7f7f4;
  --tables-line: #cfd4d0;
  --tables-ink: #191d1b;
  --tables-muted: #626b66;
  min-height: 100dvh;
  background: var(--tables-canvas);
  color: var(--tables-ink);
  font-family: 'Inter', 'IBM Plex Sans Arabic', sans-serif;
}

.tables-header {
  position: relative;
  z-index: 30;
  min-height: 64px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 13px;
  background: var(--tables-surface);
  border-bottom: 1px solid var(--tables-line);
}

.tables-heading { min-width: 118px; display: flex; align-items: center; gap: 9px; }
.tables-heading__icon { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 8px; background: rgb(15 118 110 / 0.1); color: var(--tables-teal); }
.tables-heading h1 { margin: 0; font-size: 1.05rem; line-height: 1.2; font-weight: 800; }
.tables-heading p { margin: 2px 0 0; overflow: hidden; color: var(--tables-muted); font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }
.tables-header__spacer { flex: 1; }
.tables-counts { gap: 5px; }
.tables-count { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 5px 7px; border: 1px solid var(--tables-line); border-radius: 8px; background: #efefeb; color: var(--tables-muted); font-size: 0.7rem; white-space: nowrap; }
.tables-count b { color: var(--tables-ink); font-size: 0.85rem; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; }
.status-dot--available { background: #2d6a4f; }
.status-dot--occupied { background: #ad4c45; }
.status-dot--printed { background: #3d699b; }
.tables-search { position: relative; width: 155px; }
.tables-search i { position: absolute; inset-inline-start: 11px; top: 50%; color: #747c77; transform: translateY(-50%); }
.tables-search input { width: 100%; min-height: 40px; padding-inline: 34px 11px; border: 1px solid var(--tables-line); border-radius: 8px; background: #efefeb; color: var(--tables-ink); font-size: 0.75rem; outline: none; }
.tables-search input:focus { border-color: var(--tables-teal); box-shadow: 0 0 0 3px rgb(15 118 110 / 0.12); }
.tables-action, .tables-icon-action, .tables-menu-trigger { min-height: 44px; border: 1px solid var(--tables-line); border-radius: 8px; background: #efefeb; color: var(--tables-ink); font-size: 0.75rem; font-weight: 700; }
.tables-action { display: inline-flex; align-items: center; gap: 7px; padding: 0 11px; }
.tables-icon-action { width: 44px; display: grid; place-items: center; }
.tables-menu-trigger { display: inline-flex; align-items: center; gap: 7px; padding: 0 13px; border-color: var(--tables-teal); background: var(--tables-teal); color: #fff; }
.tables-action:focus-visible, .tables-icon-action:focus-visible, .tables-menu-trigger:focus-visible { outline: 3px solid rgb(15 118 110 / 0.28); outline-offset: 2px; }
.tables-menu-backdrop { position: fixed; inset: 0; z-index: 31; border: 0; background: transparent; }
.tables-navigation-menu { position: absolute; z-index: 32; inset-block-start: calc(100% + 7px); inset-inline-end: 0; width: min(220px, calc(100vw - 24px)); padding: 6px; border: 1px solid var(--tables-line); border-radius: 10px; background: var(--tables-surface); box-shadow: 0 6px 18px rgb(25 29 27 / 0.1); }
.tables-navigation-menu button { width: 100%; min-height: 44px; padding: 0 11px; border: 0; border-radius: 7px; background: transparent; color: var(--tables-ink); font-size: 0.8rem; font-weight: 700; text-align: start; }
.tables-navigation-menu button:hover, .tables-navigation-menu button:focus-visible { background: rgb(15 118 110 / 0.1); color: var(--tables-teal); outline: none; }

.section-strip { min-height: 51px; display: flex; align-items: center; gap: 8px; padding: 7px 13px; background: var(--tables-surface); border-bottom: 1px solid var(--tables-line); }
.section-strip__tabs { min-width: 0; display: flex; gap: 5px; overflow-x: auto; }
.section-tab { min-height: 36px; padding: 0 13px; border: 0; border-radius: 7px; background: transparent; color: var(--tables-muted); font-size: 0.78rem; font-weight: 600; white-space: nowrap; }
.section-tab:hover { background: rgb(15 118 110 / 0.08); color: var(--tables-teal); }
.section-tab:focus-visible { outline: 3px solid rgb(15 118 110 / 0.24); outline-offset: 1px; }
.section-tab--active { background: var(--tables-teal); color: #fff; font-weight: 800; }
.section-tab--active:hover { background: var(--tables-teal); color: #fff; }
.section-strip__count { margin-inline-start: auto; color: var(--tables-muted); font-size: 0.7rem; font-weight: 600; white-space: nowrap; }

:global(html[dir='rtl']) .tables-page {
  font-family: 'IBM Plex Sans Arabic', 'Inter', sans-serif;
}

.tables-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
}

.table-card {
  min-width: 0;
  height: 148px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  border: 0;
  border-radius: 12px;
  color: #fff;
  cursor: pointer;
  overflow: hidden;
  transition: transform 140ms ease, box-shadow 140ms ease, opacity 140ms ease;
}

.table-card:hover { box-shadow: 0 3px 10px rgb(25 29 27 / 0.08); }
.table-card:active { transform: scale(0.985); }
.table-card:focus-visible { outline: 3px solid var(--tables-teal); outline-offset: 2px; }
.table-card--available { background: #2d6a4f; }
.table-card--occupied { background: #ad4c45; }
.table-card--printed { background: #3d699b; }
.table-card--unknown { background: #626b66; }
.table-card--join-selected { box-shadow: 0 0 0 4px #f59e0b; }
.table-card--transfer-source { opacity: 0.58; box-shadow: 0 0 0 4px #5eead4; }

.table-card__top { display: flex; align-items: flex-start; gap: 8px; }
.table-card__number { display: block; font: 900 2.45rem/.92 'Inter', sans-serif; letter-spacing: -0.05em; }
.table-card__label { display: block; margin-top: 5px; color: rgb(255 255 255 / 0.78); font-size: 0.7rem; font-weight: 600; }
.table-card__options { margin-inline-start: auto; width: 44px; height: 44px; display: grid; place-items: center; border: 1px solid rgb(255 255 255 / 0.28); border-radius: 8px; background: rgb(17 24 39 / 0.13); color: #fff; }
.table-card__options:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
.table-card__indicators { display: flex; gap: 6px; margin-top: 8px; }
.table-card__indicators span { min-height: 24px; display: inline-flex; align-items: center; gap: 5px; padding: 2px 6px; border-radius: 6px; background: rgb(17 24 39 / 0.14); color: rgb(255 255 255 / 0.9); font-size: 0.7rem; }
.table-card__footer { margin-top: auto; display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; }
.table-card__meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgb(255 255 255 / 0.86); font-size: 0.75rem; font-weight: 600; }
.table-card__total { direction: ltr; font: 900 0.95rem/1 'Inter', sans-serif; white-space: nowrap; }

@media (min-width: 640px) { .tables-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (min-width: 768px) { .tables-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; } .table-card { height: 156px; padding: 13px; } }
@media (min-width: 1024px) { .tables-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } .table-card { height: 164px; } }
@media (min-width: 1280px) { .tables-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
@media (min-width: 1536px) { .tables-grid { grid-template-columns: repeat(8, minmax(0, 1fr)); } }

@media (prefers-reduced-motion: reduce) {
  .table-card { transition: none; }
}
```

Change the page root to `class="tables-page h-[100dvh] w-screen overflow-hidden flex flex-col no-select"` so the new variables and font rules apply and the viewport remains stable.

- [ ] **Step 7: Run focused tests and commit the main floor**

```powershell
npx --no-install vitest run src/utils/tableFloorPlanPresentation.spec.js src/components/__tests__/tableFloorPlanLocalization.spec.js
npx --no-install playwright test tests/e2e/specs/waiter.tables.spec.js --project=waiter-tests
npm run build:admin
git add -- src/components/TableFloorPlan.vue tests/e2e/specs/waiter.tables.spec.js
git commit -m "feat(tables): build calm operational floor grid"
```

Expected: Vitest PASS, all waiter table E2E cases PASS, Vite build exits 0.

---

### Task 4: Align modes, empty states, dynamic mode, and dialogs with the approved page

**Files:**

- Create: `src/components/__tests__/tableFloorPlanDesignContract.spec.js`
- Modify: `src/components/TableFloorPlan.vue:95-137,250-426,1007-1068`
- Modify: `assets/js/admin/i18n.js` only if the localization contract exposes a missed visible key

**Interfaces:**

- Consumes: header, section strip, table grid, and translations from Tasks 2-3
- Preserves: all current action-sheet and PIN callbacks, dynamic table submission, transfer/join execution, and modal state refs
- Produces: one consistent no-gradient visual contract for every page state

- [ ] **Step 1: Write the failing design contract**

Create `src/components/__tests__/tableFloorPlanDesignContract.spec.js`:

```js
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Table floor approved design contract', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../TableFloorPlan.vue'), 'utf8');
  const cardStart = source.indexOf('data-testid="table-card"');
  const cardEnd = source.indexOf('<!-- Empty table state -->');
  const cardSource = source.slice(cardStart, cardEnd);

  it('uses the approved flat palette and responsive column limits', () => {
    expect(source).toContain('#2d6a4f');
    expect(source).toContain('#ad4c45');
    expect(source).toContain('#3d699b');
    expect(source).toContain('#0f766e');
    expect(source).toContain("repeat(5, minmax(0, 1fr))");
    expect(source).toContain("repeat(8, minmax(0, 1fr))");
    expect(source).not.toContain('bg-gradient-to');
    expect(source).not.toContain('from-emerald-500');
    expect(source).not.toContain('shadow-2xl');
  });

  it('does not repeat status labels inside table cards', () => {
    expect(cardStart).toBeGreaterThan(-1);
    expect(cardEnd).toBeGreaterThan(cardStart);
    expect(cardSource).not.toContain("$t('Available')");
    expect(cardSource).not.toContain("$t('Occupied')");
    expect(cardSource).not.toContain("$t('Bill Printed')");
  });

  it('keeps semantic controls and removes the redundant zone label', () => {
    expect(source).toContain('data-testid="tables-navigation-menu"');
    expect(source).toContain('data-testid="table-card"');
    expect(source).toContain('role="dialog"');
    expect(source).toContain(':aria-label="getTableOptionsLabel(table)"');
    expect(source).not.toContain("$t('Zone')");
  });
});
```

- [ ] **Step 2: Run the design contract and confirm remaining legacy styling fails**

```powershell
npx --no-install vitest run src/components/__tests__/tableFloorPlanDesignContract.spec.js
```

Expected: FAIL while transfer/join banners and dialogs still contain gradients or heavy shadows, or while semantic dialog attributes are absent.

- [ ] **Step 3: Restyle action modes and loading state**

Use flat mode bars:

```vue
<div v-if="activeMode === 'transfer'" class="mode-bar mode-bar--transfer">
  <div><i class="fa-solid fa-arrows-spin" aria-hidden="true"></i><span>{{ $t('Transfer Mode: Select an available target table for Table') }} <b data-no-i18n>{{ activeModeSourceTable?.table_number }}</b></span></div>
  <button type="button" @click="cancelMode">{{ $t('Cancel') }}</button>
</div>

<div v-if="activeMode === 'join'" class="mode-bar mode-bar--join">
  <div><i class="fa-solid fa-link" aria-hidden="true"></i><span>{{ $t('Join Mode: Click tables to group with Table') }} <b data-no-i18n>{{ activeModeSourceTable?.table_number }}</b></span></div>
  <div class="mode-bar__actions">
    <button type="button" :disabled="joinSelectedChildIds.length === 0" @click="executeJoin(activeModeSourceTable.id, joinSelectedChildIds)">{{ $t('Done') }} <b data-no-i18n>{{ joinSelectedChildIds.length }}</b></button>
    <button type="button" @click="cancelMode">{{ $t('Cancel') }}</button>
  </div>
</div>
```

Set transfer background to `#0f766e`, join background to a restrained `#a16207`, remove spinning animation, and keep all mode buttons at least 44px high.

Make the loading skeleton use the same `tables-grid` class and card heights as the loaded state. Its neutral blocks use `#d7dad6` over `#e9e9e5`.

- [ ] **Step 4: Differentiate empty section from empty search and align dynamic mode**

Use this copy branch in the empty state:

```vue
<h3>{{ tableSearchQuery ? $t('No tables match your search.') : $t('Section is Empty') }}</h3>
<p>
  {{ tableSearchQuery
    ? $t('Try another table number or waiter name.')
    : $t('There are no tables assigned to this section yet. Add tables from the Admin Dashboard.') }}
</p>
```

Restyle dynamic mode with `.dynamic-panel` on `#f7f7f4`, a 1px `#cfd4d0` border, 12px radius, no large shadow, sentence-case 14-16px copy, LTR numeric input, and a 44px teal submit button. Keep `processDynamicTable`, the input ref, Enter handling, and validation unchanged.

- [ ] **Step 5: Make the action sheet and PIN dialog compact, semantic, and responsive**

The action overlay must use:

```vue
<div
  v-if="showActionSheet"
  class="dialog-backdrop"
  @click.self="showActionSheet = false"
  @keydown.esc="showActionSheet = false"
>
  <section
    class="table-actions-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="`${$t('Table')} ${selectedActionTable?.table_number}`"
  >
```

Keep the existing action visibility expressions and callbacks. Use sentence-case labels, 44px rows, teal only for Open Cart, flat neutral secondary actions, and restrained rose only for disjoin/dissolve. Add `autofocus` to Open Cart so Escape bubbles through the focused dialog control immediately after opening.

The PIN overlay uses the same `dialog-backdrop`, `role="dialog"`, `aria-modal="true"`, `max-width: 320px`, 12px radius, no `shadow-2xl`, numeric input, and unchanged `submitPin`/cancel callback behavior. Add `autofocus` to the PIN input.

On narrow screens the table action dialog is a bottom sheet with rounded top corners and safe-area bottom padding. At `min-width: 640px` it becomes a centered dialog no wider than 384px. At 1024x768 it must fit without vertical scrolling.

- [ ] **Step 6: Run all focused automated checks**

```powershell
npx --no-install vitest run src/utils/tableFloorPlanPresentation.spec.js src/components/__tests__/tableFloorPlanLocalization.spec.js src/components/__tests__/tableFloorPlanDesignContract.spec.js
npx --no-install playwright test tests/e2e/specs/waiter.tables.spec.js --project=waiter-tests
npm run build:admin
```

Expected: all Vitest files PASS, waiter table E2E PASS, Vite build exits 0, and no Vue warnings are printed.

- [ ] **Step 7: Perform visual and interaction verification in the running app**

Use the signed-in local `/tables` page and record screenshots at:

- 768x1024, English and Arabic.
- 1024x768, English and Arabic.
- 1440x900, English and Arabic.

At every size verify:

- No clipped header, page-level horizontal scroll, or two-line navigation.
- Solid muted state cards, 8-9px gaps, and Latin digits.
- No status text inside cards.
- Table tap enters the POS.
- Options opens without entering the POS.
- Long press still opens the same action sheet.
- Search matches table number and waiter, then shows the search-specific empty state.
- Section selection and swipe retain backend order.
- At 1024px the direct action group is hidden and the navigation menu works.
- Transfer/join modes keep their target logic and show flat banners.
- Action sheet, PIN dialog, dynamic entry, and keyboard focus remain usable.
- All visible fixed UI copy is Arabic when Arabic is active; database names remain unchanged.

- [ ] **Step 8: Commit the final state alignment**

If an additional Arabic entry was required, stage only its i18n hunk.

```powershell
git add -- src/components/TableFloorPlan.vue src/components/__tests__/tableFloorPlanDesignContract.spec.js
git add -p -- assets/js/admin/i18n.js
git diff --cached --check
git commit -m "refactor(tables): align floor states and dialogs"
```

---

## Final review checklist

- [ ] Compare every section of `docs/superpowers/specs/2026-07-15-tables-page-redesign-design.md` to a task above.
- [ ] Run `rg -n "bg-gradient-to|from-emerald-500|shadow-2xl|\\$t\\('Zone'\\)" src/components/TableFloorPlan.vue src/components/__tests__ tests/e2e/specs/waiter.tables.spec.js` and confirm no prohibited design residue remains.
- [ ] Run `git diff --check`.
- [ ] Run `git status --short` and confirm unrelated pre-existing files are still present and unchanged by this plan.
- [ ] Confirm only table-page files are in the redesign commits.
