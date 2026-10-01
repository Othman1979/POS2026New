# Inventory Page — Future-Proofing (Dedup & Maintainability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Run one Phase per agent dispatch; commit before starting the next.**

> **PREREQUISITE — do not start until the audit-fixes plan is merged:** this plan assumes `docs/superpowers/plans/2026-07-02-inventory-audit-fixes.md` has landed. It relies on: (a) `products` already being a reactive `ref`, (b) the price-idempotent PUT, and (c) the `backend/tests/integration/products.test.js` suite existing — that suite is your regression net for every backend refactor here. If it is not merged, STOP and do that first.

**Goal:** Reduce the maintenance surface of the Inventory feature — remove duplicated logic, delete dead code, and centralize the two rules that are currently copy-pasted (the tax contract and the "after a catalog mutation" side-effects) — **without changing behavior in the dedup/dead-code phases** and **without proliferating files**. Almost every change is either an extraction into a small same-file helper or a deletion — the lone exceptions are Phase 3's two backend correctness fixes (which ship with regression tests) and the optional Phase 7/8 changes.

**Architecture:** This is almost entirely a behavior-preserving refactor — the one deliberate exception is Phase 3, two small backend correctness fixes (LEFT JOIN price-history + a multi-level category-cycle guard) that ship with regression tests; Phase 8 is an optional copy/product decision. Backend work consolidates repeated blocks in `backend/routes/admin/products.js` into two **module-local** named helpers (`stripTax`, `afterCatalogMutation`) and shares **one** helper (`parsePagination`) via `backend/routes/admin/helpers.js`. Frontend work deletes a dead local-pagination code path and redundant computed aliases in `src/admin/pages/Inventory.vue`, and extracts one stats-refresh helper. Two OPTIONAL phases (clearly marked) offer a single shared modal shell + a status-pill component — the owner decides whether the one new file is worth it.

**Tech Stack:** Vue 3 (Options-API `setup()`), Vite 6, Tailwind v4; Express 5 + `mysql2/promise`; Vitest + supertest.

## Global Constraints

- **Behavior must not change — with two explicit, tested exceptions.** Phases 1, 2, 4, 5, 6 are refactor-only. Phase 3 deliberately changes behavior in two small ways (LEFT JOIN price-history; reject multi-level category cycles) and ships regression tests that prove it; Phase 8 is an optional copy change. For the refactor-only phases the proof is: `npx vitest run backend/tests/` stays green (655+ tests incl. the audit plan's `products.test.js`, plus the two new Phase 3 tests), `npm run build:admin` stays green, and the manual smoke-check at the end of each phase behaves identically to before.
- **No new files** except the two explicitly optional components in Phase 7 (`ModalShell.vue` + optional `StatusPill.vue`), which the owner may skip entirely.
- **DRY/YAGNI:** extract a helper only where the SAME logic appears 2+ times. Do not invent abstraction for single-use code.
- **Keep diffs mechanical and reviewable:** one concept per commit, exact messages given.
- **RTL/i18n untouched** unless a deletion removes an unused key (leave keys alone here — key cleanup is out of scope).

---

## Phase 1 — Backend: centralize the tax contract + the post-mutation side-effects

**Why:** `products.js` computes `gross/(1+tax/100)` in two places and repeats the exact 4-line "invalidate caches + regenerate menu + emit inventory_changed" epilogue **six** times. One tax helper and one epilogue helper make the rules single-source and shrink the file.

**Files:**
- Modify: `backend/routes/admin/products.js`

**Interfaces:**
- Produces (module-local): `stripTax(grossPrice, taxRate) -> number` — the ONE definition of the net-from-gross rule. `afterCatalogMutation(req) -> void` — runs the 4 side-effects (`invalidateCatalogCache`, `invalidateDashboardCache`, `triggerStaticMenuGeneration`, emit `inventory_changed` to `staff`).

- [ ] **Step 1: Add the two helpers below `writeAudit`**

In `backend/routes/admin/products.js`, directly under the `writeAudit` function (and under `validateProductInput` if the audit plan added it), add:

```javascript
// The ONE place the tax contract lives: DB stores pre-tax (net) price; admin submits gross.
function stripTax(grossPrice, taxRate) {
    return taxRate > 0 ? grossPrice / (1 + taxRate / 100) : grossPrice;
}

// Every product/category create/update/delete ends with the same four side-effects.
function afterCatalogMutation(req) {
    invalidateCatalogCache();
    invalidateDashboardCache();
    triggerStaticMenuGeneration();
    if (req.io) req.io.to('staff').emit('inventory_changed');
}
```

- [ ] **Step 2: Use `stripTax` in POST and PUT**

In the POST branch, find:

```javascript
            // Admin enters tax-inclusive price; strip tax so POS can add it back correctly
            const priceToStore = taxRate > 0 ? grossPrice / (1 + taxRate / 100) : grossPrice;
```

Replace with:

```javascript
            // Admin enters tax-inclusive price; strip tax so POS can add it back correctly
            const priceToStore = stripTax(grossPrice, taxRate);
```

In the PUT branch (the audit plan's partial-update shape), find:

```javascript
            const newPrice      = priceProvided ? (taxRatePut > 0 ? grossPricePut / (1 + taxRatePut / 100) : grossPricePut) : oldPrice;
```

Replace with:

```javascript
            const newPrice      = priceProvided ? stripTax(grossPricePut, taxRatePut) : oldPrice;
```

- [ ] **Step 3: Replace all six side-effect epilogues with `afterCatalogMutation(req)`**

There are six occurrences of this 4-line block (products POST/PUT/DELETE and categories POST/PUT/DELETE):

```javascript
            invalidateCatalogCache();
            invalidateDashboardCache();
            triggerStaticMenuGeneration();
            if (req.io) req.io.to('staff').emit('inventory_changed');
```

Replace **each** occurrence with the single line:

```javascript
            afterCatalogMutation(req);
```

Caution: in the product PUT branch the block is NOT contiguous — `invalidateCatalogCache()` sits above the open-order heal logic and `invalidateDashboardCache()` + the rest sit below it. For that one branch, delete the lone `invalidateCatalogCache();` above the heal block and the three lines below it, and put a single `afterCatalogMutation(req);` immediately before `return sendSuccess(res, { message: "Product updated." });`. The heal call stays where it is (it must run regardless).

- [ ] **Step 4: Verify no behavior change**

Run: `npx vitest run backend/tests/` — expect ALL green (unchanged count).
Run: `npm run build:admin` — expect exit 0.
Grep to confirm the dedup actually happened: `grep -c "triggerStaticMenuGeneration()" backend/routes/admin/products.js` should now be **1** (the single call inside `afterCatalogMutation`). NOTE: grep WITHOUT the `()` returns **2**, because the bare identifier also appears on the `require('../../config/menuCache')` line — that second hit is the import and is expected, which is why the check uses the `()` invocation form. And `grep -c "1 + taxRate" backend/routes/admin/products.js` should be **1** (only inside `stripTax`).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/admin/products.js
git commit -m "refactor(inventory): centralize tax-strip + post-mutation side-effects into helpers"
```

---

## Phase 2 — Backend: share the pagination clamp

**Why:** The `page`/`limit`/`offset` clamp is duplicated verbatim in `products.js` (GET) and `audit.js`. One helper.

> **Rev-2 note — two originally-planned items are now DROPPED (do not do them):** a shared `coerceProductFields` and routing the `price_changed` INSERT through `writeAudit`. The audit-fixes plan rewrote the product PUT into a partial-update builder that coerces each field inline AND already calls `writeAudit` for `price_changed`. That leaves POST as the only site with the old inline coercion — so a shared coercion helper would be single-use (YAGNI), and the `price_changed` reuse is already done. Only the pagination helper below remains.

**Files:**
- Modify: `backend/routes/admin/products.js`
- Modify: `backend/routes/admin/audit.js`
- Modify: `backend/routes/admin/helpers.js`

**Interfaces:**
- Produces: `helpers.parsePagination(query) -> { page, limit, offset }` (limit clamped 1–200, default 50).

- [ ] **Step 1: Add `parsePagination` to `helpers.js` and export it**

In `backend/routes/admin/helpers.js`, add the function (place near the other exported helpers) and include it in `module.exports`:

```javascript
function parsePagination(query) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;
    return { page, limit, offset };
}
```

Find the `module.exports = { ... }` block and add `parsePagination,` to it.

- [ ] **Step 2: Use `parsePagination` in `products.js` GET and `audit.js`**

In `products.js`, add `parsePagination` to the destructured `require('./helpers')` at the top of the file, then in the GET paged branch find:

```javascript
                const page = Math.max(1, parseInt(req.query.page, 10) || 1);
                const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
                const offset = (page - 1) * limit;
```

Replace with:

```javascript
                const { page, limit, offset } = parsePagination(req.query);
```

In `audit.js`, add `parsePagination` to its `require('./helpers')` destructure, then find:

```javascript
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = (page - 1) * limit;
```

Replace with:

```javascript
        const { page, limit, offset } = parsePagination(req.query);
```

- [ ] **Step 3: Verify + commit**

Run: `npx vitest run backend/tests/` — expect ALL green.
Run: `npm run build:admin` — expect exit 0.
Grep to confirm the raw clamp is gone from both handlers (now via `parsePagination`): `grep -n "parseInt(req.query.page" backend/routes/admin/products.js backend/routes/admin/audit.js` should return nothing.

```bash
git add backend/routes/admin/products.js backend/routes/admin/audit.js backend/routes/admin/helpers.js
git commit -m "refactor(inventory): share parsePagination helper across products + audit"
```

---

## Phase 3 — Backend: opportunistic correctness cleanup (Y11 + cycle guard)

**Why:** Two latent-only items from the audit that are cheap to make correct while we're in these files.

**Files:**
- Modify: `backend/routes/admin/audit.js`
- Modify: `backend/routes/admin/products.js`
- Modify: `backend/tests/integration/products.test.js` (add the two regression tests in Step 3)

- [ ] **Step 1: Make the price-history JOINs LEFT JOINs (Y11)**

In `audit.js`, the `/audit/price-history` query uses INNER joins. `changed_by` is `INT UNSIGNED NOT NULL` in the schema, so it is **never literally NULL** — but an INNER JOIN still silently drops any history row whose `changed_by` points to a **since-deleted user** (or whose `product_id` points to a since-deleted product): deleting a user would make that admin's historical price changes vanish from the report. LEFT JOIN keeps the row (the joined `changed_by_name`/`product_name` just comes back NULL). Find:

```javascript
            FROM price_history ph
            JOIN products p ON ph.product_id = p.id
            JOIN users u    ON ph.changed_by  = u.id
```

Replace with:

```javascript
            FROM price_history ph
            LEFT JOIN products p ON ph.product_id = p.id
            LEFT JOIN users u    ON ph.changed_by  = u.id
```

- [ ] **Step 2: Harden the category parent cycle guard**

In `products.js` categories PUT, find:

```javascript
            let parent_id = (req.body.parent_id) ? req.body.parent_id : null;
            if (parent_id == req.body.id) parent_id = null;
```

Replace with a walk that **detects** any ancestor cycle (A→B→A), not just the direct self-parent case, and drops the offending parent link to `null` (top-level). This preserves today's behavior for the self-parent case (which already silently becomes top-level) and just extends the same silent fix to multi-level cycles — so it stays behavior-preserving except for the genuinely-buggy multi-level case it now prevents. (If the owner would prefer the API return a **400** for a cyclic parent instead of silently nulling it, that is a deliberate behavior change — decide before implementing; the snippet below keeps the silent-null to match the existing self-parent convention.)

```javascript
            let parent_id = (req.body.parent_id) ? req.body.parent_id : null;
            if (parent_id) {
                // Walk up from the proposed parent; if we reach this category, the link would
                // create a cycle — drop it to top-level instead.
                let cursor = parent_id;
                const seen = new Set();
                while (cursor && !seen.has(String(cursor))) {
                    if (String(cursor) === String(req.body.id)) { parent_id = null; break; }
                    seen.add(String(cursor));
                    const [[row]] = await pool.query("SELECT parent_id FROM categories WHERE id = ?", [cursor]);
                    cursor = row ? row.parent_id : null;
                }
            }
```

- [ ] **Step 3: Add regression tests for BOTH correctness changes**

These are behavioral changes, so lock them with tests in `backend/tests/integration/products.test.js` (reuse the existing suite/fixtures + the create→act→assert→cleanup pattern already in that file). A plain "tests stay green" gate does NOT prove these — there is no existing coverage for the price-history JOIN kind or the category cycle guard.

Test A — LEFT JOIN keeps an orphaned-FK price-history row (would FAIL on the old INNER JOIN):

```javascript
    test('price-history keeps a row whose changed_by user no longer exists (LEFT JOIN)', async () => {
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie).send({ name: '_ph_orphan', price: '10.00' });
        const productId = create.body.id;
        try {
            // changed_by is NOT NULL, so we can't test a null — instead point at a ghost user id
            // that does not exist in `users`. INNER JOIN drops this row; LEFT JOIN must keep it.
            const GHOST_USER = 90000001;
            await pool.query(
                'INSERT INTO price_history (product_id, old_price, new_price, changed_by) VALUES (?, ?, ?, ?)',
                [productId, 10, 12, GHOST_USER]
            );

            const res = await request(app).get(`/api/admin/audit/price-history?product_id=${productId}`)
                .set('Cookie', adminCookie);
            expect(res.body.success).toBe(true);
            expect(res.body.history.some(h => Number(h.product_id) === productId)).toBe(true);
        } finally {
            // finally: leave no ghost rows even if an assertion above throws.
            await pool.query('DELETE FROM price_history WHERE product_id = ?', [productId]);
            await pool.query('DELETE FROM products WHERE id = ?', [productId]);
        }
    });
```

Test B — category PUT that would create an A→B→A cycle drops the parent to top-level (would FAIL on the old self-parent-only guard):

```javascript
    test('category PUT that would create an A->B->A cycle drops the parent to top-level', async () => {
        const a = await request(app).post('/api/admin/categories')
            .set('Cookie', adminCookie).send({ name: '_cycle_A' });
        const idA = a.body.id;
        const b = await request(app).post('/api/admin/categories')
            .set('Cookie', adminCookie).send({ name: '_cycle_B', parent_id: idA }); // B child of A
        const idB = b.body.id;
        try {
            // Try to make A a child of B -> A->B->A. The walk must null A's parent.
            const put = await request(app).put('/api/admin/categories')
                .set('Cookie', adminCookie).send({ id: idA, name: '_cycle_A', parent_id: idB });
            expect(put.body.success).toBe(true);

            const [[row]] = await pool.query('SELECT parent_id FROM categories WHERE id = ?', [idA]);
            expect(row.parent_id).toBeNull();
        } finally {
            // finally: drop the temp categories even if the assertions above throw.
            await pool.query('DELETE FROM categories WHERE id IN (?, ?)', [idB, idA]);
        }
    });
```

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run backend/tests/integration/products.test.js` — the two new tests pass (temporarily reverting each source change should make its test go red — that is how you know the test actually exercises the fix). Then `npx vitest run backend/tests/` — all green. `npm run build:admin` — exit 0.

```bash
git add backend/routes/admin/audit.js backend/routes/admin/products.js backend/tests/integration/products.test.js
git commit -m "fix(inventory): LEFT JOIN price-history for orphaned FKs, break category parent cycles to top-level (+tests)"
```

---

## Phase 4 — Frontend: delete the dead local-pagination path + redundant aliases + dead computeds

**Why:** Inventory's `fetchInventory` always sends `page`+`limit` (plus filter/sort) query params, so the products GET always takes its *paged* branch and always returns a `pagination` object. (The endpoint does keep a non-paged legacy branch — `products.js` GET falls through to it only when NONE of page/limit/search/category_ids/status/stock_status/sort are sent — but Inventory never calls it that way.) That makes `applyProductResponse`'s local-pagination else-branch, `legacyProductRows`, and `matchesProductSearch` unreachable *from this component* and safe to delete. `filteredProducts` and `paginatedProducts` are both just `products.value`. Five computeds are returned but never used. Removing them is the single biggest readability win in the file.

**Files:**
- Modify: `src/admin/pages/Inventory.vue`

- [ ] **Step 1: Confirm the dead code with grep before deleting**

Run this. The expectation is **not uniform** — it differs by symbol (do not blanket-assert "never in template"):
- Fully dead → must appear ONLY in `<script>` (its definition, plus a `return` entry for some), **never** in `<template>`: `mainCategories`, `activeProductsCount`, `productRecordTotal`, `getSubcategories`, `productOffset`, `legacyProductRows`, `matchesProductSearch`.
- NOT dead in the template → expected in BOTH `<script>` and `<template>` today: `filteredProducts` and `paginatedProducts`. They are used in the empty-state/loading checks and the `v-for`s, and you will repoint those template uses to `products` in Step 4.

```bash
grep -n "mainCategories\|activeProductsCount\|productRecordTotal\|getSubcategories\|productOffset\|legacyProductRows\|matchesProductSearch\|filteredProducts\|paginatedProducts" src/admin/pages/Inventory.vue
```

Note which template lines use `filteredProducts` (empty-state checks) and `paginatedProducts` (the `v-for` loops) — you will repoint them to `products` in Step 4.

- [ ] **Step 2: Simplify `applyProductResponse` to the server-pagination path only**

Find the whole `applyProductResponse` function. Replace it with the server-only version (drops `legacyProductRows` writes and the local-filter else-branch):

```javascript
        const applyProductResponse = (prodRes) => {
            const rows = Array.isArray(prodRes.products) ? prodRes.products : [];
            const limit = Math.max(1, Number(pageSize.value) || 12);
            const total = prodRes.pagination?.total ?? rows.length;
            const totalPages = prodRes.pagination?.total_pages ?? Math.ceil(Number(total) / limit);

            const start = (productCurrentPage.value - 1) * limit;
            const pageRows = rows.length > limit ? rows.slice(start, start + limit) : rows;
            setProductPage(pageRows, total, totalPages);

            productStats.value = {
                active_products: Number(prodRes.stats?.active_products || 0),
                low_stock: Number(prodRes.stats?.low_stock || 0)
            };
        };
```

- [ ] **Step 3: Delete `legacyProductRows`, `matchesProductSearch`**

Find and delete this local declaration line:

```javascript
        let legacyProductRows = [];
```

Find and delete the entire `matchesProductSearch` function:

```javascript
        // Search matcher for local fallback
        const matchesProductSearch = (product, query) => {
            if (!query) return true;
            const needle = query.toLowerCase();
            return [
                product.name,
                product.barcode,
                product.sku,
                getCategoryName(product.category_id)
            ].some(value => String(value || '').toLowerCase().includes(needle));
        };
```

- [ ] **Step 4: Delete the two passthrough computeds and repoint the template to `products`**

Find and delete:

```javascript
        // Search filters and categorizations
        const filteredProducts = computed(() => products.value);
```

and

```javascript
        const paginatedProducts = computed(() => products.value);
```

Then in the `<template>`, replace every `filteredProducts` and `paginatedProducts` with `products`. The occurrences are: the products loading-skeleton `v-if="isLoading && paginatedProducts.length === 0"`, the products-empty-state `v-else-if="filteredProducts.length === 0"`, the replenishment-empty `v-if="filteredProducts.length === 0"`, and the `v-for="p in paginatedProducts"` loops (desktop products, mobile products, desktop replenishment, mobile replenishment). After the edit, `grep -n "filteredProducts\|paginatedProducts" src/admin/pages/Inventory.vue` must return **nothing**.

- [ ] **Step 5: Delete the five dead computeds and their `return` entries**

Delete each of these definitions:

```javascript
        const mainCategories = computed(() => categories.value.filter(c => !c.parent_id || c.parent_id == 0));
```
```javascript
        const activeProductsCount = computed(() => productStats.value.active_products);
```
```javascript
        const productRecordTotal = computed(() => productTotalRecords.value);
```
```javascript
        const productOffset = computed(() => (productCurrentPage.value - 1) * pageSize.value);
```

and the `getSubcategories` function:

```javascript
        const getSubcategories = (parentId) => {
            return categories.value.filter(c => c.parent_id == parentId);
        };
```

Then in the `return { ... }` block, remove the now-undefined names: `mainCategories`, `activeProductsCount`, `productRecordTotal`, `getSubcategories`, `filteredProducts`, `paginatedProducts`. (`productOffset` was never in the return.) Keep `lowStockCount`, `totalRecords`, `totalPages`, `paginatedCategories`, `filteredCategories`, `eligibleParentCategories`, `popoverCategoriesTree` — those ARE used.

- [ ] **Step 6: Build + verify nothing broke**

Run: `npm run build:admin` — expect exit 0 (a Vue template referencing a deleted name fails the build, so this catches mistakes).
Manual: open Inventory — products list, pagination, search, category/status/stock filters, and the Restock tab all behave exactly as before.

- [ ] **Step 7: Commit**

```bash
git add src/admin/pages/Inventory.vue
git commit -m "refactor(inventory): remove dead local-pagination path, alias computeds, and unused symbols"
```

---

## Phase 5 — Frontend: extract the repeated stats-refresh (small, safe dedup)

**Why:** `quickReplenishStock` and `applyCustomReplenish` contain the identical "fetch page:1&limit:1 then copy `stats` into `productStats`" block. One helper.

**Files:**
- Modify: `src/admin/pages/Inventory.vue`

- [ ] **Step 1: Add `refreshProductStats` near `fetchInventory`**

Add this function (right after `fetchInventory` is a good spot):

```javascript
        // Cheap stats-only refetch used after a single-row stock change (keeps the low-stock
        // badge accurate without reloading the whole page).
        const refreshProductStats = async () => {
            try {
                const res = await fetch('api/admin/products?page=1&limit=1');
                const prodRes = await res.json();
                if (prodRes.success && prodRes.stats) {
                    productStats.value = {
                        active_products: Number(prodRes.stats.active_products || 0),
                        low_stock: Number(prodRes.stats.low_stock || 0)
                    };
                }
            } catch (e) { /* stats are non-critical; ignore */ }
        };
```

- [ ] **Step 2: Use it in both replenish handlers**

In `quickReplenishStock`, find the inline stats block:

```javascript
                    const productParams = new URLSearchParams({ page: '1', limit: '1' });
                    fetch(`api/admin/products?${productParams.toString()}`)
                        .then(r => r.json())
                        .then(prodRes => {
                            if (prodRes.success && prodRes.stats) {
                                productStats.value = {
                                    active_products: Number(prodRes.stats.active_products || 0),
                                    low_stock: Number(prodRes.stats.low_stock || 0)
                                };
                            }
                        });
```

Replace with:

```javascript
                    refreshProductStats();
```

Do the identical replacement of the same block inside `applyCustomReplenish`.

- [ ] **Step 3: Build + verify + commit**

Run: `npm run build:admin` — exit 0.
Manual: in Restock, click +5 / set a stock value → toast fires, the low-stock badge count updates as before.

```bash
git add src/admin/pages/Inventory.vue
git commit -m "refactor(inventory): extract refreshProductStats helper"
```

---

## Phase 6 — Frontend: coalesce redundant inventory fetches (audit finding #3)

**Why:** Several UI actions fire `fetchInventory()` more than once for a single intent — the "Back to Products" button runs `activeTab='products'; clearAllFilters()` (two fetches), and a tab switch sets filters that also trip the filter watcher. The audit-fixes plan added a `fetchSeq` guard so the *stale* response is dropped (no wrong data) and a `suppressFilterFetch` flag to skip the watcher's duplicate — but wasted round-trips remain and the flag is bookkeeping. Replace both mechanisms with a single microtask coalescer: any number of triggers in the same tick collapse to ONE request. Behaviour is identical; the network is quieter and the code simpler.

**Files:**
- Modify: `src/admin/pages/Inventory.vue`

**Interfaces:**
- Produces: `reload({ silent })` — schedules at most one `fetchInventory()` per microtask; every synchronous fetch trigger calls it instead of `fetchInventory()` directly.

- [ ] **Step 1: Add the coalescer next to `fetchInventory`**

```javascript
        // Collapse multiple fetch triggers fired in the same tick into a single request.
        let reloadScheduled = false;
        const reload = ({ silent = false } = {}) => {
            if (reloadScheduled) return;
            reloadScheduled = true;
            nextTick(() => { reloadScheduled = false; fetchInventory({ silent }); });
        };
```

- [ ] **Step 2: Route the synchronous triggers through `reload()` and delete `suppressFilterFetch`**

Replace the direct `fetchInventory()` calls in the SYNCHRONOUS triggers with `reload()`:
- `clearAllFilters` — drop the `suppressFilterFetch = true;` and `nextTick(() => { suppressFilterFetch = false; });` lines; end with `reload()`.
- `watch(activeTab)` `products`/`replenishment` branches — drop the `suppressFilterFetch = true;` + `nextTick(...)` lines; end each branch with `reload()`.
- `watch([categoryFilter, statusFilter, stockFilter, sortBy])` — drop the `if (suppressFilterFetch) return;` line; call `reload()`.
- `watch(pageSize)` and `setPage` — call `reload()`.

Then delete the `let suppressFilterFetch = false;` declaration — the coalescer makes it unnecessary. Leave the `watch(searchQuery)` **debounced** timer, but have its 300ms callback call `reload()` (the debounce handles typing; the coalescer handles same-tick dedup). Leave `onMounted`/`onActivated` calling `fetchInventory()` directly (one-shot, not part of a burst). **Also leave the four post-mutation reloads direct — `onProductSaved`, `onCategorySaved`, `deleteItem`, and `deleteCategory` — they each fire once after an async mutation resolves, not as part of a same-tick burst, so they need no coalescing. IMPORTANT: `deleteItem` and `deleteCategory` call `fetchInventory({ silent: true })`; do NOT rewrite these to `reload()` — `reload()` defaults to non-silent, so it would surface a loading-spinner flash that the silent reload deliberately avoids = a behavior change (violates the no-behavior-change rule).** KEEP the `fetchSeq` guard inside `fetchInventory` — it still protects against out-of-order server responses (a slow first request landing after a fast second).

- [ ] **Step 3: Build + verify + commit**

Run: `npm run build:admin` — exit 0.
Manual (DevTools → Network): click "Back to Products", switch tabs, hit "Clear All", change a filter → each intent issues exactly **one** `api/admin/products` request (before: 2–3). List data is unchanged in every case.

**Scope of the "one request" guarantee (read before verifying):** it holds for *same-tick* bursts — the "Back to Products" / tab-switch / "Clear All" / filter-change intents above. It does **not** collapse the Restock (replenishment) **search**: the `searchQuery` watcher flips `stockFilter` (`low`↔`all`) on the first character typed / on clearing, and that flip trips the filter watcher for an immediate request, while the 300ms search debounce fires a second request ~300ms later — the two are in *different ticks*, so the microtask coalescer cannot merge them. This is **pre-existing** behavior (present before this refactor), not a regression, and is left as-is on purpose: the debounce is intentionally kept for per-keystroke typing, and forcing a single request here would either delay the stock-widening by 300ms or re-introduce a suppression flag — both behavior changes, both out of scope. So when you Network-check replenishment search, expect the transition keystroke to still issue two requests; that is correct. (A true single-request version is a separate, opt-in follow-up.)

```bash
git add src/admin/pages/Inventory.vue
git commit -m "refactor(inventory): coalesce redundant fetches into one request per tick, drop suppress flag"
```

---

## Phase 7 — (OPTIONAL) One shared modal shell + status pill

> **OWNER DECISION REQUIRED.** This phase adds ONE new component file (`ModalShell.vue`) and optionally one tiny presentational component. The owner has said they prefer FEW files. Do this ONLY if the owner approves — it is the single consolidation judged worth a new file, because it removes three copies of the modal chrome AND makes ImportModal visually consistent with the other two (it currently uses an older `bg-secondary`/slate scrim). If the owner declines, SKIP this phase entirely; the audit-fixes plan already made the three modals individually correct.

**Files (only if approved):**
- Create: `src/admin/components/ModalShell.vue`
- Modify: `src/admin/components/ProductModal.vue`, `CategoryModal.vue`, `ImportModal.vue`

- [ ] **Step 1: Create `ModalShell.vue`**

**Escape parity (important — do not skip):** the three modals this consolidates each attach a **document-level** `keydown` Escape listener (e.g. `CategoryModal.vue`: a `watch(() => props.show)` adds `document.addEventListener('keydown', onEscKey)` on open and removes it on close), so Escape closes them regardless of where focus sits. A bare `@keydown.esc` on the dialog root only fires when the dialog (or a descendant) has focus — if the shell does not autofocus on open, Escape silently stops working = a regression. So `ModalShell` owns the same document-level listener (see the `<script>` below) instead of a root `@keydown.esc`.

```vue
<template>
    <div v-if="show" role="dialog" aria-modal="true" tabindex="-1"
         class="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-150"
         @click.self="$emit('close')">
        <div :class="widthClass" class="bg-card w-full rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] border border-border animate-in zoom-in-95 duration-200">
            <div class="px-6 py-4 border-b border-zinc-200 flex justify-between items-center shrink-0">
                <slot name="header">
                    <h3 class="font-display font-semibold tracking-tight text-foreground text-sm">{{ title }}</h3>
                </slot>
                <button @click="$emit('close')" :aria-label="$t('Close')" class="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg transition-colors focus:outline-none">
                    <i class="fa-solid fa-xmark text-sm"></i>
                </button>
            </div>
            <slot />
        </div>
    </div>
</template>

<script>
import { watch, onBeforeUnmount } from 'vue';

export default {
    name: 'ModalShell',
    props: {
        show: { type: Boolean, default: false },
        title: { type: String, default: '' },
        widthClass: { type: String, default: 'max-w-2xl' }
    },
    emits: ['close'],
    setup(props, { emit }) {
        // Escape parity with the modals this replaces: a DOCUMENT-level listener (fires no
        // matter where focus sits), added while shown, removed on close/unmount. Do NOT rely
        // on a root @keydown.esc — that only fires when the dialog itself holds focus.
        const onEscKey = (e) => { if (e.key === 'Escape') emit('close'); };
        watch(() => props.show, (open) => {
            if (open) document.addEventListener('keydown', onEscKey);
            else document.removeEventListener('keydown', onEscKey);
        });
        onBeforeUnmount(() => document.removeEventListener('keydown', onEscKey));
    }
};
</script>
```

Add `'Close': 'إغلاق',` to `assets/js/admin/i18n.js` if not present.

Commit the shell on its own — it's imported nowhere yet, so `npm run build:admin` still passes (an unreferenced SFC just isn't bundled). Per-file commits let a later regression bisect to one modal:

```bash
git add src/admin/components/ModalShell.vue assets/js/admin/i18n.js
git commit -m "refactor(inventory): add shared ModalShell component (owns Escape + scrim)"
```

- [ ] **Step 2: Adopt it in `CategoryModal.vue` first (smallest, lowest risk)**

Replace the outer `<div v-if="show" ...>` + scrim + panel + header block down to just before `<form>` with `<ModalShell :show="show" :title="isEditing ? $t('Edit Category') : $t('New Category')" width-class="max-w-md" @close="$emit('close')">`, move the `<form>...</form>` inside it, and close with `</ModalShell>`. Import and register `ModalShell`.

**Then delete CategoryModal's own Escape wiring** — ModalShell owns Escape now, so leaving the local listener makes Escape emit `close` **twice**. Remove `onEscKey` (~L69), the `watch(() => props.show, …)` block that does `document.addEventListener('keydown', onEscKey)` / `removeEventListener` (~L70-73), and the `onBeforeUnmount(() => document.removeEventListener('keydown', onEscKey))` (~L74). KEEP the *other* `watch(() => props.show)` that initializes the form. Drop the now-unused `onBeforeUnmount` import if nothing else references it.

Build; confirm the category modal looks and behaves identically (open, edit, Escape closes **once**, backdrop-close, save), then commit:

```bash
git add src/admin/components/CategoryModal.vue
git commit -m "refactor(inventory): adopt ModalShell in CategoryModal"
```

- [ ] **Step 3: Adopt it in `ProductModal.vue` and `ImportModal.vue`**

Same transformation for each. **Delete each modal's own Escape wiring too** (ModalShell owns it now — otherwise Escape double-emits `close`):
- `ProductModal.vue` — remove `onEscKey` + its `watch(() => props.show)` Escape registration + the `onBeforeUnmount` removal (~L217-222); KEEP any other `watch(props.show)` used for form init; drop the `onBeforeUnmount` import if it goes unused.
- `ImportModal.vue` — remove `onEscKey` + `onMounted(() => document.addEventListener('keydown', onEscKey))` + the `onBeforeUnmount` removal (~L171-173); drop the now-unused `onMounted`/`onBeforeUnmount` imports if nothing else uses them. Adopting ModalShell here ALSO fixes its inconsistent scrim (it becomes the teal-system `bg-zinc-900/60` shell).

Keep each modal's tabs/body/footer as the default slot content. Build + manual-check each (open, save, Escape fires **once**, backdrop-close), and **commit per modal** so a regression bisects cleanly:

```bash
git add src/admin/components/ProductModal.vue
git commit -m "refactor(inventory): adopt ModalShell in ProductModal"

git add src/admin/components/ImportModal.vue
git commit -m "refactor(inventory): adopt ModalShell in ImportModal (unifies scrim)"
```

- [ ] **Step 4: (Optional within optional) Status pill**

The `Active`/`Inactive` pill markup is duplicated 4× in `Inventory.vue` (desktop+mobile × products+categories). If desired, create `src/admin/components/StatusPill.vue` taking an `:active="Boolean"` prop and render `<StatusPill :active="p.is_active == 1" />` at the four sites. Skip if the owner wants zero extra files — the duplication is cosmetic.

- [ ] **Step 5: Final build + verify (commits already made per-modal in Steps 1–4)**

Run: `npm run build:admin` — exit 0. Manual: all three modals open/close/save/Escape (**once** each) correctly and share one look. The per-modal commits happened in Steps 1–4; nothing left to stage here unless you did the optional StatusPill in Step 4 — if so, commit it on its own:

```bash
git add src/admin/components/StatusPill.vue src/admin/pages/Inventory.vue
git commit -m "refactor(inventory): extract StatusPill component"
```

---

## Phase 8 — (OPTIONAL / DISCUSS) Make the "Stock Activity → Sales (stock out)" feed honest

> **DISCUSS WITH OWNER FIRST — this is a product decision, not a bug.** The left column of the Stock Activity tab is labelled "Sales (stock out)" but it simply lists the 20 most recent orders (`api/admin/orders?limit=20`), regardless of whether any stock-tracked item was involved. Two honest options:
> - **(a) Relabel** the column to "Recent sales" so it stops implying per-item stock movement (1-line copy + i18n change). Lowest effort.
> - **(b) Re-scope** it to real stock-out events (would require a backend endpoint that returns order lines affecting stock-tracked products). Larger; only if the owner wants a true stock ledger.

**Files (option a):** `src/admin/pages/Inventory.vue`, `assets/js/admin/i18n.js`

- [ ] **Step 1 (option a): Relabel**

In `Inventory.vue`, change the ledger left-card title `{{ $t('Sales (stock out)') }}` to `{{ $t('Recent sales') }}` and the badge `{{ $t('Stock out') }}` to `{{ $t('Sales') }}`. Add `'Recent sales'` and `'Sales'` Arabic keys. Build; visually confirm.

```bash
git add src/admin/pages/Inventory.vue assets/js/admin/i18n.js
git commit -m "refactor(inventory): honest label for the recent-sales activity feed"
```

---

## Self-Review

**Coverage of the future-proofing findings (FP1–FP9 from the audit):**
- FP1 (products shallowRef→ref) → done in the AUDIT plan (it fixed the R2 bug); nothing to do here ✓
- FP2 (centralize tax contract) → Phase 1 `stripTax` ✓
- FP3 (dedup optimistic/stats) → Phase 5 `refreshProductStats` (toggle/delete were made correct in the audit plan; further toggle-merge intentionally NOT done — the two handlers are short and merging them risks re-introducing the endpoint/list/toast divergence) ✓ (documented limit)
- FP4 (dead local-pagination + aliases + dead computeds) → Phase 4 ✓
- FP5 (coerceProductInput) → DROPPED: the audit plan's partial-PUT rewrite absorbed the PUT coercion inline, leaving POST as the only inline-coercion site → a shared helper would be single-use (YAGNI). See the rev-2 note on Phase 2.
- FP6 (afterCatalogMutation) → Phase 1 ✓
- FP7 (writeAudit reuse → already done in the AUDIT plan's PUT rewrite; parsePagination) → Phase 2 (pagination only) ✓
- Audit finding #3 (redundant fetches) → Phase 6 (microtask fetch coalescer; replaces the audit-plan `suppressFilterFetch` flag) ✓
- FP8 (ModalShell + status pill) → Phase 7 (OPTIONAL) ✓
- FP9 (honest Stock Activity label) → Phase 8 (OPTIONAL/DISCUSS) ✓
- Plus opportunistic Y11 + cycle guard → Phase 3 ✓

**Placeholder scan:** none — every step is literal code + a grep/build/manual gate.

**Type/identifier consistency:** `stripTax(grossPrice, taxRate)` and `afterCatalogMutation(req)` defined Phase 1, consumed Phases 1–2; `parsePagination(query)` defined Phase 2 Step 1, consumed Step 2; `refreshProductStats()` defined Phase 5 Step 1, consumed Step 2. The audit plan's `products.test.js` guards all backend changes.

**Risk note:** Phases 1, 2, 4, 5, 6 are behaviour-preserving refactors under test coverage — safe (Phase 6 is verified by the Network-tab one-request check). Phase 3 is a small correctness change (NOT a pure refactor), locked by the two regression tests it adds. Phase 7 changes shared modal markup (medium risk) and is OPTIONAL + committed per-modal for easy bisect. Phase 8 is a product decision, not code risk. Do backend (1–3) and frontend (4–6) in either order; they touch disjoint files.
