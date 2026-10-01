# Catalog-Backed Priced Note Products Implementation Plan

**Revision 3 — 2026-08-25.** This revision incorporates the end-to-end audit of checkout, search, refresh races, saved rows, bundle children, and every current pricing/snapshot caller. It supersedes the earlier drafts in this same file; do not combine it with an older copy.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make products selected from note categories retain their configured surcharge through refresh, checkout, held orders, tables, and splits without trusting client money or breaking ordinary free-text notes.

**Architecture:** Keep note-category products as the existing catalog records and store their stable product ID as `noteProductId` inside the existing `selectedModifiers` JSON. The browser owns only immediate display and draft synchronization; every fresh server write reloads the referenced note product and calculates its current gross surcharge from the database, while saved `order_items` and split rows keep their frozen money and snapshot. This adds no table, migration, dependency, or parallel modifier system.

**Tech Stack:** Vue 3, Pinia, Express, MySQL/MariaDB, existing `selected_modifiers` JSON and modifier money columns, Vitest, Supertest, Playwright.

## Global Constraints

- Do not add a schema migration, table, column, dependency, environment variable, setting, installer change, updater change, spooler change, or production-data rewrite.
- Never parse free-text note text as a money source. Text such as `(+0.20)` is display only.
- Never trust `item.price`, `modifier_surcharge`, `modifier_tax_amount`, or `selectedModifiers[].price` from a fresh client line. The database product rows remain authoritative.
- Preserve formal product modifiers. Their `gid`/`oid` contract and legacy name fallback remain unchanged.
- A note-product selection uses exactly one stable identity: a positive safe-integer `noteProductId`. Mixed note-product and formal IDs are normalized as a note-product selection.
- A product whose direct category has `is_notes=1` is not a standalone sale item. Fresh server writes reject it as a top-level `product_id` with `409 NOTE_PRODUCT_REQUIRES_ITEM`; cashier-selected notes are valid only when referenced by `noteProductId` on an ordinary parent line. The existing DB-declared bundle-child exception is defined separately below, and saved/frozen rows remain untouched.
- A DB-declared bundle child is not a top-level cart line: existing bundle validation/canonicalization keeps it nested and persists it at zero price beneath the ordinary bundle parent. A bundle child may therefore belong to a note category without triggering `NOTE_PRODUCT_REQUIRES_ITEM`.
- The configured note-product amount is gross money because the admin product form accepts gross price and stores net via `grossToNet()`. Reconstruct it with the existing `netToGross()` rule.
- A note-product surcharge inherits the parent cart line's tax treatment exactly like the existing fixed modifier surcharge. The note product's own tax rate reconstructs its configured gross amount; it does not replace the parent line's rate.
- Tax exemption keeps fixed modifier money unchanged. Income-tax mode continues to persist zero modifier tax. Do not alter those existing invariants.
- Only fresh, unsaved lines follow catalog note-product name, activity, and price changes. Rows identified by `order_item_id`, settled splits, saved table rows, and paid invoices keep their frozen snapshots.
- Do not deduct note-product stock. Note-category products remain instruction/extra records, matching their existing behavior and formal modifiers.
- Preserve ordinary item-note text, including text identical to a note-product name. Structured note lines are rebuilt from `noteProductId`; manual text remains user-authored.
- Keep the existing maximum of 50 sanitized modifier selections per line. Do not introduce another limit.
- Add one stable public error code, `NOTE_PRODUCT_UNAVAILABLE`, for a missing, inactive, detached, or no-longer-note catalog record on a fresh server write.
- Add one stable public error code, `NOTE_PRODUCT_REQUIRES_ITEM`, for a note-category product submitted as a fresh top-level sale line.
- Add a natural Arabic catalog translation for the new cashier-facing recovery/error message, but keep source keys and server messages in English.
- Use focused RED/GREEN tests and the one priced-note browser flow. Do not run the entire repository suite unless a focused failure proves shared fallout.
- Do not deploy, migrate, merge, push, build installers, or alter customer data as part of this plan.
- Preserve every unrelated working-tree change and untracked evidence file.

---

## Evidence and Decision Record

### Verified root cause

1. `src/components/pos/PosCatalogWorkspace.vue:383-416` currently raises `item.price` and writes `{ group, option, price }` when a note-category product is clicked, but it writes no stable product ID and does not set `modifier_surcharge` or `modifier_tax_amount`.
2. `src/pos/categoryPriceSync.js:14-22` rebuilds a fresh line as database base price plus `modifier_surcharge`. Because the note click left that field null, refresh changes `2.90` back to `2.70` while the note text remains.
3. `backend/services/PosCalculator.js:338-347` prices only options found inside the base product's formal `product.modifiers`. A separate product from a note category cannot match, so the server calculates a zero surcharge.
4. `backend/services/OrderPricing.js:18-44` correctly overwrites cashier money with database pricing. Three client lines at `2.90` therefore become three server lines at `2.70`, producing the observed `0.60` subtotal difference and the `assertNearMoney` failure in `backend/modules/checkout/executeCheckout.js:1436`.
5. Commit `f810fc48` deliberately removed free-text note pricing and made modifier money database-authoritative, but its note-category UI adaptation recorded only names and client price. Reintroducing text parsing would reopen the security defect that commit closed.
6. `products.price` is stored net after `grossToNet()` in `backend/routes/admin/products.js`; a taxable note product therefore needs `netToGross()` before it can be used as a fixed gross surcharge.
7. `order_items` already stores `selected_modifiers`, `modifier_surcharge`, and `modifier_tax_amount`; the durable representation exists and no schema work is justified.
8. `backend/modules/tables/splitChecks.js` currently canonicalizes submitted split modifiers from the current catalog before later pinning the same lines from locked parent `order_items`; the first pass is redundant and would reject an otherwise valid frozen split after a note product is disabled.
9. `backend/modules/tables/tableRelationships.js` compares line money and text during a move but not `selected_modifiers`; same-name/same-price note products can therefore lose stable identity unless the snapshot joins the equality key.
10. `src/pos/useProducts.js:131-140` deliberately makes catalog search global: while a query is active it sends no category filter. `src/components/pos/PosCatalogWorkspace.vue:383-390` nevertheless decides whether a result is a note from the currently selected category. Searching from a normal category can therefore sell a note product as a standalone item, while searching from a notes category can apply an ordinary product as a note.
11. `backend/routes/pos/catalog.js` returns `category_name` for catalog products but not `category_is_notes`, so the browser lacks the product-owned discriminator required to fix that search path.
12. A direct experiment with base `0.50` plus an id-less category-note snapshot priced `0.10` reproduced both server outcomes: cashier pricing reset the line to `0.50`, while admin pricing retained `0.60` as a manual override. That proves the permission difference is downstream fallout, not a legitimate price-override workflow.
13. A direct `categoryPriceSync` experiment reproduced the reported refresh symptom exactly: the fresh line changed from `0.60` to `0.50` while its note text and name-only snapshot remained.
14. `sanitizeSelectedModifiers()` currently drops a supplied `noteProductId`, confirming that stable identity must be added to the existing sanitizer before any caller can persist it.
15. The focused existing regression set (`PosCalculator.test.js` plus `categoryPriceSync.test.js`) passes 91 tests without exercising a category-note product. The current green state is therefore a coverage gap, not evidence that the flow works.
16. `src/pos/stores/orderSessionStore.js:2088-2108` exposes the whole composed note to manual editing. A cashier can delete a generated note line while the structured selection and surcharge survive, creating a misleading cart.
17. A price refresh captures request/context identity but not the set of fresh note IDs. If a cashier adds a note while an older multi-batch request is in flight, applying the partial response can wrongly remove the newly added note as unavailable.
18. Barcode lookup (`backend/routes/pos/catalog.js` plus `src/pos/useTerminal.js`) and QR draft import (`src/pos/stores/orderSessionStore.js`) bypass `PosCatalogWorkspace.handleProductClick()`. Fixing only the visible catalog/search cards would still allow those paths to create a bad top-level note-product line in the browser before the server rejects checkout.
19. The earlier draft collected `noteProductId` values from raw client arrays before sanitization. That would let a hostile request expand the lookup beyond the existing 50-selection-per-line bound even though the later pricing fold was safe. Lookup and pricing must consume the same sanitized selection prefix.
20. `sanitizeSelectedModifiers()` currently requires non-empty `group` and `option` before retaining any selection. A stable `{ noteProductId: 91 }` would therefore disappear before the database resolver sees it, silently producing a zero surcharge. Note-product identity must survive without client display fields because the resolver replaces those fields from the catalog.
21. `netToGross()` correctly throws for missing/negative prices and invalid tax rates, but those are bare `TypeError`/`RangeError` instances. The resolver must translate them to `409 NOTE_PRODUCT_UNAVAILABLE`; otherwise malformed catalog data escapes as a generic 500.
22. If `deductStockForCart()` uses the expanded base-plus-note lookup with `FOR UPDATE`, every checkout sharing a popular note product serializes on that irrelevant note row. Stock deduction needs a base-product-only lookup while pricing keeps the full map.
23. Fresh bundle children are nested under `bundleItems`, validated against `product_bundle_items`, and inserted separately at zero price; `applyDatabasePrices()` sees only top-level cart lines. A note-category bundle child is therefore not rejected by the proposed top-level guard. The plan pins that fact with an integration test instead of adding a second bundle-membership query.

### External pattern check

- Square identifies catalog modifiers with `catalog_object_id`; its API states that client-supplied `base_price_money` can override the catalog price, which is precisely why this POS must send identity but resolve money on the server: <https://developer.squareup.com/reference/square/objects/OrderLineItemModifier>.
- Oracle Simphony models condiments as menu items grouped for ingredients/instructions, allows charged condiment counts, and documents parent-tax behavior unless an override applies: <https://docs.oracle.com/en/industries/food-beverage/simphony/19.8/simfl/G19574_01.pdf>.
- Odoo POS stores explicit extra prices on configured combo choices rather than deriving charges from display text: <https://www.odoo.com/documentation/17.0/applications/sales/point_of_sale/combos.html>.

These products differ in detail, but all three support the same minimal boundary: stable catalog identity plus configured extra price, not display-string pricing.

### Locked payload contract

Fresh note-product selections use this existing JSON envelope:

```json
{
  "noteProductId": 123,
  "group": "Two slices",
  "option": "Two slices",
  "price": 0.20
}
```

- `noteProductId` is identity.
- `group`, `option`, and `price` are bounded display snapshots.
- The server ignores the submitted `price`, reloads product `123`, proves that its active direct category is an active note category, reconstructs its gross amount, and canonicalizes the snapshot.
- Formal selections keep their existing `{ gid, oid, group, option, price }` shape.

### Hostile review result

| Attack or lifecycle | Required result |
|---|---|
| Three `2.70` items each with a `0.20` note | Browser and server both calculate `8.70`; checkout succeeds. |
| One quantity-3 line with one note | The per-unit surcharge is multiplied by quantity once; no duplicate selection is created. |
| Submitted note price is `0`, `99`, negative, string, or `NaN` | Database price wins; malformed display price cannot undercharge or overcharge. |
| Same `noteProductId` appears twice | Canonical resolver charges it once and persists one snapshot. |
| Two note products have the same name | IDs remain independent; toggling one cannot remove the other. |
| Product is renamed or repriced before a fresh checkout | Refresh canonicalizes the draft; a race is still priced from the database and never trusts the stale snapshot. |
| Product is missing, inactive, detached, or moved out of a note category | Fresh server write fails with `409 NOTE_PRODUCT_UNAVAILABLE`; refresh removes only that structured note and prompts the cashier to re-add it. |
| Note selection submits only `{ noteProductId }` | The stable ID survives sanitization; the server fills name and price from the catalog and charges it once. |
| Note catalog money/tax data cannot be converted by `netToGross()` | Fresh write fails with `409 NOTE_PRODUCT_UNAVAILABLE`, never a generic 500. |
| Existing broken local draft has an id-less positive note snapshot | Refresh removes only the exact legacy generated note line, restores database base price, and shows one recovery toast. It never guesses an ID by name. |
| Ordinary free text contains `(+0.20)` | It remains text and contributes zero money. |
| Manual note text equals a structured note's name | Editing shows only manual text; recomposition preserves the manual occurrence and one structured occurrence. |
| Formal modifier plus note-product surcharge | Both database-backed amounts sum once and retain the parent tax snapshot. |
| Taxable note product configured as gross `0.20` | Stored net is reconstructed to gross `0.20`; the parent line rate determines modifier tax. |
| Tax exemption or income-tax mode | Existing fixed-modifier rules remain unchanged. |
| Manager price override | Override semantics remain; server still records the current note-product surcharge metadata. |
| Held order create/claim | Fresh hold pricing is canonical; register holds reprice under their existing current-catalog rule. |
| Saved table, table reload, split, or split settle | Frozen `order_items` money and `selected_modifiers` survive unchanged even if the catalog note later changes. |
| Subscription redemption with a paid note | Existing `SUBSCRIPTION_PAID_EXTRA_REQUIRES_CHECKOUT` rejection still fires after server pricing. |
| Stock enabled | Only base cart `product_id` quantities are deducted; referenced note-product IDs are lookup-only. |
| Two checkouts share the same popular note product | Stock deduction locks only their base products; it does not serialize on the note row. |
| More than 50 selections | Existing sanitizer cap remains the sole bound. |
| Raw request puts a valid note ID in selection 51 or later | The ID is not queried or priced; lookup and canonicalization both use the same first 50 sanitized selections. |
| More than 300 unique base/note IDs in one restored cart | Refresh resolves the IDs in existing 300-ID endpoint-sized batches, combines the results, then performs one guarded synchronization. |
| Rapid table/context switch during refresh | A stale response is discarded by request ID plus captured sales-context and table identity. |
| Cashier adds/removes a note while refresh batches are in flight | The response is applied only if the current fresh base/note ID set is a subset of the requested set; otherwise it is discarded and one fresh retry is scheduled. |
| Global search returns a note product while a normal category remains selected | The result's own `category_is_notes` metadata controls behavior; it can only attach to the selected parent line. |
| Global search returns an ordinary product while a notes category remains selected | The result's own metadata controls behavior; it is added as an ordinary cart product. |
| Forged request submits a note-category product as `product_id` | Every fresh checkout/hold/table/subscription pricing path fails with `409 NOTE_PRODUCT_REQUIRES_ITEM`; manager permission cannot convert it into an override. |
| Cashier tries to change a priced note on a saved `order_item_id` row | The browser refuses the edit using the existing saved-item workflow message; the frozen server row is unchanged. |
| Barcode or QR draft references a note-category product | The browser refuses the standalone add with the note-product instruction; the server rejection remains the final trust boundary. |
| DB-declared bundle member belongs to a note category | The ordinary bundle parent is priced normally and the canonical nested child persists at zero price; it is not treated as a standalone note product. |
| Fresh custom/open line carries a forged note selection | Existing fresh custom-item gates reject it before persistence; saved custom rows remain frozen. |

No unclosed design blocker remains. The remaining uncertainty is execution evidence: the tests below must fail first, then pass after the exact implementation.

---

## Locked File Structure

- Create `src/pos/noteProductSelections.js`: one browser-only module for stable note-product identity, gross display price, generated-note composition, toggle, and catalog synchronization.
- Modify `src/components/pos/PosCatalogWorkspace.vue`: replace name/text-based active detection and price mutation with the helper.
- Modify `src/pos/stores/orderSessionStore.js`: edit manual note text without exposing/removing generated structured note lines.
- Modify `src/pos/categoryPriceSync.js`: synchronize note-product snapshots before rebuilding fresh line price.
- Modify `src/components/PosTerminal.vue`: resolve both base and note-product IDs for fresh register/table drafts and show one recovery toast.
- Modify `src/shared/i18n/ar.json`: translate the single recovery/error source key.
- Modify `backend/services/PosCalculator.js`: sanitize `noteProductId` and resolve formal plus note-product selections through one database-authoritative fold.
- Modify `backend/services/InventoryService.js`: load base and referenced note products in one query while preserving base-product missing checks and stock semantics.
- Modify `backend/services/OrderPricing.js`: pass the complete product map to the resolver.
- Modify `backend/routes/pos/catalog.js`: return name/activity/note-category metadata from the existing price-resolution endpoint.
- Modify `backend/routes/pos/catalog.js`: also return `category_is_notes` with every catalog product so global search is classified by the result's own category rather than stale navigation state.
- Modify `backend/modules/checkout/executeCheckout.js`, `backend/modules/tables/saveTableOrder.js`, `backend/routes/pos/orders.js`, and `backend/routes/pos/subscriptions.js`: pass the complete product map when fresh canonical snapshots are built.
- Modify `backend/modules/tables/splitChecks.js`: remove its redundant current-catalog modifier canonicalization; the locked parent `order_items` snapshot is the sole authority for every split seat.
- Modify `backend/modules/tables/tableRelationships.js`: include `selected_modifiers` when deciding whether two moved table lines are identical.
- Add/modify only the focused unit, integration, and browser tests named in the tasks.
- Modify `docs/architecture.json`, then generate `docs/architecture.html` with the existing script.

---

## Per-Task Execution and Break Protocol

Implement Tasks 1 through 5 strictly in order. For each task: add the named RED tests, run only that task's focused command, implement only that task, run the same command GREEN, execute that task's hostile checks, inspect the staged diff, and commit that task before starting the next. A later task may not conceal or retroactively repair a failed earlier gate. If a hostile check exposes a missing path, add the smallest failing test to the owning task and fix it there; do not add a generalized modifier framework.

---

### Task 1: Make Note-Product Money Database-Authoritative

**Files:**
- Modify: `backend/services/PosCalculator.js`
- Modify: `backend/services/InventoryService.js`
- Modify: `backend/services/OrderPricing.js`
- Modify: `backend/tests/unit/PosCalculator.test.js`
- Modify: `backend/tests/unit/helpers.test.js`
- Modify: `backend/tests/unit/inventoryService.test.js`

**Interfaces:**
- Consumes: `selectedModifiers[]` with either formal IDs/names or `noteProductId`, plus the complete `productMap` returned by `fetchCartProducts()`.
- Produces: `resolveModifierSelections(product, line, productMap) -> { selectedModifiers, surcharge }`, with `computeModifierSurcharge()` and `buildSelectedModifiersSnapshot()` delegating to that single fold.
- Rejects: fresh top-level note-category products with `{ statusCode: 409, publicCode: 'NOTE_PRODUCT_REQUIRES_ITEM' }` after any saved-price bypass but before role-based override handling.

- [ ] **Step 1: Add failing sanitizer and resolver tests**

First extend the existing top-level `require('../../services/PosCalculator')` destructuring in `backend/tests/unit/PosCalculator.test.js` with `sanitizeSelectedModifiers` and `resolveModifierSelections`; the RED must exercise exported behavior, not fail with an undefined local. Then add these cases:

```js
describe('catalog-backed note-product selections', () => {
    const base = { id: 1, price: 2.7, tax_rate: 8, modifiers: null };
    const note = {
        id: 91, name: 'Two slices', price: 0.172414, tax_rate: 16,
        product_is_active: 1, category_is_active: 1, category_is_notes: 1
    };
    const products = new Map([[1, base], [91, note]]);

    it('keeps one safe noteProductId and replaces client money from the catalog', () => {
        const line = { selectedModifiers: [
            { noteProductId: 91, group: 'stale', option: 'stale', price: 99 },
            { noteProductId: 91, group: 'duplicate', option: 'duplicate', price: 0 }
        ] };
        expect(resolveModifierSelections(base, line, products)).toEqual({
            selectedModifiers: [{ noteProductId: 91, group: 'Two slices', option: 'Two slices', price: 0.2 }],
            surcharge: 0.2
        });
    });

    it('keeps note identity when client display fields are missing', () => {
        expect(sanitizeSelectedModifiers([{ noteProductId: 91 }])).toEqual([{ noteProductId: 91 }]);
        expect(resolveModifierSelections(base, { selectedModifiers: [{ noteProductId: 91 }] }, products))
            .toEqual({
                selectedModifiers: [{ noteProductId: 91, group: 'Two slices', option: 'Two slices', price: 0.2 }],
                surcharge: 0.2
            });
    });

    it.each([91.5, 0, -1, Number.MAX_SAFE_INTEGER + 1])('drops unsafe noteProductId %s', (noteProductId) => {
        expect(sanitizeSelectedModifiers([{ noteProductId, group: 'x', option: 'x', price: 1 }]))
            .toEqual([{ group: 'x', option: 'x', price: 1 }]);
    });

    it.each([
        ['missing', new Map([[1, base]])],
        ['inactive product', new Map([[1, base], [91, { ...note, product_is_active: 0 }]])],
        ['inactive category', new Map([[1, base], [91, { ...note, category_is_active: 0 }]])],
        ['ordinary category', new Map([[1, base], [91, { ...note, category_is_notes: 0 }]])]
    ])('rejects an unavailable %s note product', (_label, map) => {
        try {
            resolveModifierSelections(base, {
                selectedModifiers: [{ noteProductId: 91, group: 'Two slices', option: 'Two slices', price: 0.2 }]
            }, map);
            throw new Error('expected note-product rejection');
        } catch (error) {
            expect(error).toMatchObject({ statusCode: 409, publicCode: 'NOTE_PRODUCT_UNAVAILABLE' });
        }
    });

    it.each([
        ['missing price', { ...note, price: undefined }],
        ['negative price', { ...note, price: -1 }],
        ['invalid tax rate', { ...note, tax_rate: 101 }]
    ])('maps %s catalog money to NOTE_PRODUCT_UNAVAILABLE', (_label, invalidNote) => {
        let error;
        try {
            resolveModifierSelections(base, { selectedModifiers: [{ noteProductId: 91 }] },
                new Map([[1, base], [91, invalidNote]]));
        } catch (caught) {
            error = caught;
        }
        expect(error).toMatchObject({ statusCode: 409, publicCode: 'NOTE_PRODUCT_UNAVAILABLE' });
    });
});
```

- [ ] **Step 2: Add failing pricing tests**

In `backend/tests/unit/helpers.test.js`, assert that `applyDatabasePrices()` changes a forged fresh cashier line to database base plus the gross note amount, preserves formal modifiers, uses the parent tax for `modifier_tax_amount`, and leaves manager override semantics unchanged:

```js
const noteSelection = { noteProductId: 91, group: 'stale', option: 'stale', price: 99 };
const products = new Map([
    [1, { id: 1, price: 2.7, tax_rate: 8, modifiers: [{ id: 'g1', name: 'Size', options: [{ id: 'o1', name: 'Large', price: 0.5 }] }] }],
    [91, { id: 91, name: 'Two slices', price: 0.172414, tax_rate: 16, product_is_active: 1, category_is_active: 1, category_is_notes: 1 }]
]);
const cart = [{ product_id: 1, qty: 3, price: 999, selectedModifiers: [
    { gid: 'g1', oid: 'o1', group: 'Size', option: 'Large', price: 999 }, noteSelection
] }];
applyDatabasePrices(cart, products, { role: 'cashier', permissions: [] });
expect(cart[0].price).toBe(3.4);
expect(cart[0].modifier_surcharge).toBe(0.7);
expect(cart[0].modifier_tax_amount).toBeCloseTo(0.051852, 6);
```

Add a second test that puts `{ category_is_notes: 1 }` on the top-level product and submits it as a cart line. Run the assertion once as cashier and once as admin pricing input; both must throw `409 NOTE_PRODUCT_REQUIRES_ITEM`. Add a saved-price-map case proving the existing frozen-row bypass still returns before this new fresh-line rejection.

In `backend/tests/unit/inventoryService.test.js`, use a mocked executor to inspect the product-query parameters. Submit one base line with 50 sanitized selections followed by a 51st distinct `noteProductId`; assert the base ID and IDs from the bounded prefix are queried, the 51st ID is absent, and missing-note handling remains the resolver's responsibility. Add a stock-deduction case with base ID `1` plus note ID `91`; assert the locked lookup parameters contain only `[1]`, the SQL still uses `FOR UPDATE`, and only base ID `1` reaches the stock update.

- [ ] **Step 3: Run the focused tests and observe RED**

Run:

```powershell
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/helpers.test.js backend/tests/unit/inventoryService.test.js
```

Expected: failures state that `resolveModifierSelections` is absent, `noteProductId` is stripped, and the note surcharge remains zero.

- [ ] **Step 4: Implement one canonical modifier fold**

In `backend/services/PosCalculator.js`, import `netToGross` from `categoryPriceLists`, retain a safe `noteProductId` in `sanitizeSelectedModifiers`, and make both existing public functions delegate to this fold:

```js
const noteProductUnavailable = () => Object.assign(
    new Error('A priced note changed or is unavailable. Refresh and re-add it.'),
    { statusCode: 409, publicCode: 'NOTE_PRODUCT_UNAVAILABLE' }
);

const safeNoteProductId = value => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const isEligibleNoteProduct = product => product &&
    Number(product.product_is_active) === 1 &&
    Number(product.category_is_active) === 1 &&
    Number(product.category_is_notes) === 1;

const resolveModifierSelections = (product, line, productMap = new Map()) => {
    const selected = sanitizeSelectedModifiers(line?.selectedModifiers) || [];
    const snapshot = [];
    const seenNoteProducts = new Set();
    let surcharge = 0;

    for (const selection of selected) {
        if (selection.noteProductId) {
            if (seenNoteProducts.has(selection.noteProductId)) continue;
            seenNoteProducts.add(selection.noteProductId);
            const noteProduct = productMap.get(selection.noteProductId);
            if (!isEligibleNoteProduct(noteProduct)) throw noteProductUnavailable();
            const price = netToGross(
                Number(noteProduct.effective_price ?? noteProduct.price),
                Number(noteProduct.tax_rate || 0)
            );
            snapshot.push({
                noteProductId: selection.noteProductId,
                group: noteProduct.name,
                option: noteProduct.name,
                price
            });
            surcharge += price;
            continue;
        }

        const match = findModifierOption(product, selection);
        if (!match) {
            snapshot.push(selection);
            continue;
        }
        const price = toFiniteNumber(match.option.price, 0);
        const canonical = { group: match.group.name, option: match.option.name, price };
        if (match.group.id) canonical.gid = match.group.id;
        if (match.option.id) canonical.oid = match.option.id;
        snapshot.push(canonical);
        surcharge += price;
    }

    return { selectedModifiers: snapshot.length ? snapshot : null, surcharge };
};

const buildSelectedModifiersSnapshot = (product, line, productMap) =>
    resolveModifierSelections(product, line, productMap).selectedModifiers;

const computeModifierSurcharge = (product, line, productMap) =>
    resolveModifierSelections(product, line, productMap).surcharge;
```

Move/define `safeNoteProductId()` before `sanitizeSelectedModifiers()`, then calculate `noteProductId` before the existing `!group || !option` guard. Use this branch before the formal/name fallback:

```js
const noteProductId = safeNoteProductId(raw.noteProductId);
if (noteProductId) {
    const entry = { noteProductId };
    if (group) entry.group = group;
    if (option) entry.option = option;
    const price = Number(raw.price);
    if (raw.price !== undefined && Number.isFinite(price) && price >= 0 && price <= 10000) {
        entry.price = price;
    }
    out.push(entry);
    continue;
}
if (!group || !option) continue;
```

Use the function's existing bounded string normalization for `group` and `option`; do not introduce a second sanitizer. The valid note identity must not require `group`, `option`, or `price`, and `gid`/`oid` are never retained on the note-product branch. Only formal/name-fallback selections retain the existing requirement for non-empty `group` and `option`. Export `resolveModifierSelections` and add it plus `sanitizeSelectedModifiers` to the test import described in Step 1.

Wrap only the note catalog conversion so catalog validation errors share the public unavailable contract:

```js
let price;
try {
    price = netToGross(
        Number(noteProduct.effective_price ?? noteProduct.price),
        Number(noteProduct.tax_rate ?? 0)
    );
} catch (_) {
    throw noteProductUnavailable();
}
```

Do not weaken `netToGross()` globally; its bare validation errors remain appropriate for trusted admin/service callers. The resolver owns the HTTP-facing translation.

- [ ] **Step 5: Load referenced note products in the existing product query**

In `backend/services/InventoryService.js`, import `sanitizeSelectedModifiers` from `PosCalculator` beside `toFiniteNumber`. Extend the internal options to `{ lock = false, includeNoteProducts = true }` and derive lookup IDs from the bounded sanitized selections only when `includeNoteProducts` is true:

```js
const baseProductIds = [...new Set(cartItems.map(item => item.product_id).filter(Boolean))];
const noteProductIds = includeNoteProducts ? [...new Set(cartItems.flatMap(item =>
    (sanitizeSelectedModifiers(item.selectedModifiers) || []).map(selection => Number(selection?.noteProductId))
        .filter(id => Number.isSafeInteger(id) && id > 0)
))] : [];
const productIds = [...new Set([...baseProductIds, ...noteProductIds])].sort((a, b) => a - b);
```

Extend the existing query with:

```sql
p.is_active AS product_is_active,
c.is_active AS category_is_active,
c.is_notes AS category_is_notes
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
```

Build the map first, then preserve the old missing-base behavior with:

```js
if (baseProductIds.some(id => !productMap.has(Number(id)))) {
    throw new Error('One or more products in the cart no longer exist.');
}
```

Do not require every note ID to exist here; the canonical fold must produce `NOTE_PRODUCT_UNAVAILABLE`. In `deductStockForCart()`, call `fetchCartProducts(conn, cartItems, { lock: true, includeNoteProducts: false })`. Leave its quantity aggregation unchanged. Pricing/snapshot callers keep the default full lookup, while stock deduction locks only the base products it can update.

- [ ] **Step 6: Pass the full product map into pricing**

Change the one call in `backend/services/OrderPricing.js` to:

```js
const extraPrice = computeModifierSurcharge(product, item, productMap);
```

Immediately after the existing saved-price-map bypass and before `canPriceOverride()` can preserve client money, reject a fresh top-level product when `Number(product.category_is_notes) === 1`:

```js
throw Object.assign(
    new Error('Note products must be added to an item.'),
    { statusCode: 409, publicCode: 'NOTE_PRODUCT_REQUIRES_ITEM' }
);
```

Do not reject frozen rows skipped through the existing saved-price map. Do not infer this from product names, `item.is_notes`, active navigation state, or submitted metadata.

- [ ] **Step 7: Run GREEN and existing formal-modifier regressions**

Run:

```powershell
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/helpers.test.js backend/tests/unit/inventoryService.test.js
```

Expected: all tests pass, including the existing forged formal-modifier and free-text-note cases.

- [ ] **Step 7a: Break Task 1 before committing**

Re-run the two role variants with a forged `item.is_notes=0`, forged ordinary category fields on the line, and a forged manager price. Confirm the database product's `category_is_notes` still rejects the standalone line. Then submit `{ noteProductId: 91 }` without display fields and confirm the catalog price is charged; repeat with invalid catalog money and confirm `NOTE_PRODUCT_UNAVAILABLE`, never 500. Put another valid note ID at raw selection 51 and prove it is neither included in the SQL parameters nor priced. Finally call `deductStockForCart()` with two different base products sharing note ID `91`; assert the locked lookups never contain `91`. Any failure stays in Task 1.

- [ ] **Step 8: Commit Task 1 only**

```powershell
git add backend/services/PosCalculator.js backend/services/InventoryService.js backend/services/OrderPricing.js backend/tests/unit/PosCalculator.test.js backend/tests/unit/helpers.test.js backend/tests/unit/inventoryService.test.js
git commit -m "fix(pos): make priced note products server authoritative"
```

---

### Task 2: Carry Canonical Note Snapshots Through Every Server Lifecycle

**Files:**
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/modules/tables/saveTableOrder.js`
- Modify: `backend/modules/tables/splitChecks.js`
- Modify: `backend/modules/tables/tableRelationships.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/routes/pos/subscriptions.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/tests/integration/heldOrders.test.js`
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/tests/integration/subscriptionRedemptions.test.js`
- Modify: `backend/tests/integration/bundle.checkout.test.js`

**Interfaces:**
- Consumes: `buildSelectedModifiersSnapshot(product, item, productMap)` from Task 1.
- Produces: canonical `noteProductId` snapshots in fresh `order_items`, held `cart_data`, table rows, and subscription checks while preserving saved/frozen rows.

- [ ] **Step 1: Add the exact checkout regression first**

In `backend/tests/integration/checkout.test.js`, add a test named `[priced note] checks out three 2.70 units with a 0.20 note at 8.70` that:

```js
const [category] = await pool.query(
    "INSERT INTO categories (name, is_notes, is_active) VALUES ('Paid notes', 1, 1)"
);
const [note] = await pool.query(
    "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
    [category.insertId]
);
await pool.query('UPDATE products SET price=2.70, tax_rate=0, jofotara_tax_category=\'O\' WHERE id=?', [SEED.product1.id]);

const selection = { noteProductId: note.insertId, group: 'Two slices', option: 'Two slices', price: 999 };
const response = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
    cart: [1, 2, 3].map(index => ({
        id: SEED.product1.id,
        cartId: `priced-note-line-${index}`,
        qty: 1,
        price: 2.90,
        selectedModifiers: [selection],
        note: 'Two slices (+0.20)'
    })),
    shift_id: cashierShiftId,
    subtotal: 8.70, tax: 0, total: 8.70,
    payment_method: 'cash', amount_tendered: 10, change_due: 1.30,
    idempotency_key: 'priced-note-three-units'
});
expect(response.statusCode).toBe(200);
const [lines] = await pool.query(
    'SELECT price_at_sale, modifier_surcharge, selected_modifiers FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
    [response.body.invoice_id]
);
expect(lines).toHaveLength(3);
for (const line of lines) {
    expect(Number(line.price_at_sale)).toBe(2.9);
    expect(Number(line.modifier_surcharge)).toBe(0.2);
    expect(JSON.parse(line.selected_modifiers)).toEqual([
        { noteProductId: note.insertId, group: 'Two slices', option: 'Two slices', price: 0.2 }
    ]);
}
```

- [ ] **Step 2: Add lifecycle failures before wiring call sites**

Add focused tests with `[priced note]` in their names:

- `heldOrders.test.js`: save a fresh hold with a forged display price, assert canonical `0.20`, change the note catalog price to `0.25`, claim it, and assert the existing register-hold repricing rule produces `0.25` and the stable ID remains.
- `tables.test.js`: save and reload a table line, assert `selected_modifiers` includes `noteProductId`, then change/deactivate the note product and prove settlement still uses the frozen saved `0.20` without consulting current eligibility.
- `tables.test.js`: split the saved line and prove each seat retains the parent's snapshot/surcharge rather than current catalog price.
- `tables.test.js`: move two financially identical table lines with different note-product IDs and prove they do not merge into one row.
- `subscriptionRedemptions.test.js`: submit a paid note with client `price: 0` and assert `409 SUBSCRIPTION_PAID_EXTRA_REQUIRES_CHECKOUT` after database pricing.
- `checkout.test.js`, `heldOrders.test.js`, `tables.test.js`, and `subscriptionRedemptions.test.js`: submit the note-category product itself as a fresh top-level item and assert each HTTP boundary returns `409` with `code: 'NOTE_PRODUCT_REQUIRES_ITEM'`. Use an admin-capable actor for at least the checkout case to prove permission does not turn the misuse into a price override.
- `bundle.checkout.test.js`: move one existing DB-declared bundle member into a new active `is_notes=1` category, submit the ordinary bundle parent with its nested `bundleItems`, and assert checkout succeeds. Verify the member is persisted beneath the bundle parent with `price_at_sale=0`. Do not submit the child as a top-level cart item; that would correctly test the standalone rejection instead of bundle behavior.
- `checkout.test.js`: add `[priced note] rejects a forged note on a fresh custom line`; submit `product_id: null` with `{ noteProductId }`, assert `400 Open item is no longer available`, and prove no order row is written. This pins the existing custom-item gate; do not add note-product handling to custom lines.

- [ ] **Step 3: Run the new lifecycle tests and observe RED**

Run:

```powershell
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/bundle.checkout.test.js -t "priced note"
```

Expected: checkout pricing may pass after Task 1, while fresh snapshot assertions fail because current `buildSelectedModifiersSnapshot()` callers do not pass `productMap`; the frozen split test fails because split creation unnecessarily consults the current catalog, and the table-move identity test fails.

- [ ] **Step 4: Pass `productMap` at every verified snapshot call**

Use this exact call shape at all fresh snapshot sites in checkout, table save, held orders, and subscriptions:

```js
buildSelectedModifiersSnapshot(product, item, productMap)
```

The held-order claim path also has one legacy fallback derivation in `backend/routes/pos/orders.js` that currently calls `computeModifierSurcharge(product, item)` without the map. Change it to `computeModifierSurcharge(product, item, productMap)` so no note-product path can silently fall back to zero.

Do not replace a `savedContext.selectedModifiers` branch; saved context remains the authority. In `backend/routes/pos/subscriptions.js`, pass the same locked map already used for price validation.

In `backend/modules/tables/splitChecks.js`, delete the `fetchCartProducts()` call and the loop that calls `buildSelectedModifiersSnapshot()` before parent-line pinning. Every split item is matched to locked parent `order_items` later in the same function, where `selectedModifiers`, surcharge, modifier tax, price, and tax rate are copied together. Remove now-unused imports. This is required so an inactive/deleted current note product cannot invalidate a frozen table row.

In the redemption route catch in `backend/routes/pos/subscriptions.js`, preserve the same public contract as checkout, held orders, and tables:

```js
return sendError(
    res,
    error.statusCode || 500,
    error.statusCode ? error.message : 'Failed to redeem subscription meal.',
    error.publicCode || (error.statusCode ? error.code : null) || null
);
```

Add a focused unavailable-note subscription assertion so `NOTE_PRODUCT_UNAVAILABLE` cannot be silently discarded by that route boundary, plus one generic SQL-error assertion proving an internal `ER_*` code is not returned to the client.

- [ ] **Step 5: Preserve stable identity during table moves**

In the existing `SELECT ... FROM order_items` match inside `backend/modules/tables/tableRelationships.js`, add:

```sql
AND selected_modifiers <=> ?
```

and bind `item.selected_modifiers` next to the existing modifier-money fields. This prevents two equal-price/equal-text selections with different catalog identities from merging.

- [ ] **Step 6: Run the lifecycle tests GREEN**

Run:

```powershell
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/bundle.checkout.test.js -t "priced note"
```

Expected: every `[priced note]` test passes; frozen table/split tests pass after catalog mutation; the subscription route rejects the paid extra.

- [ ] **Step 7: Run adjacent frozen-line and formal-modifier regressions**

Run:

```powershell
npx vitest run backend/tests/integration/checkout.test.js -t "structured modifier|selected_modifiers|saved table|priced note"
npx vitest run backend/tests/integration/heldOrders.test.js -t "modifier|priced note"
npx vitest run backend/tests/integration/tables.test.js -t "modifier|split|priced note"
```

Expected: all selected tests pass and no saved row is repriced.

- [ ] **Step 7a: Break Task 2 before committing**

Trace every current `applyDatabasePrices(`, `buildSelectedModifiersSnapshot(`, `computeModifierSurcharge(`, and `fetchCartProducts(` hit with `rg`; classify each as fresh-authoritative or saved-frozen and account for it in the tests above. Confirm nested DB-canonical bundle children never enter `applyDatabasePrices()` as top-level lines and the fresh custom-item gates still precede persistence. Then deactivate/reprice the note after table save but before split and settlement, and confirm no current-catalog lookup touches the frozen row. Finally send the same forged note snapshot through checkout, hold, table save, and subscription; all fresh paths must canonicalize to the same database amount and public errors must retain their stable codes. A generic subtotal mismatch or generic 500 is a Task 2 failure.

- [ ] **Step 8: Commit Task 2 only**

```powershell
git add backend/modules/checkout/executeCheckout.js backend/modules/tables/saveTableOrder.js backend/modules/tables/splitChecks.js backend/modules/tables/tableRelationships.js backend/routes/pos/orders.js backend/routes/pos/subscriptions.js backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/bundle.checkout.test.js
git commit -m "fix(pos): preserve priced notes across order lifecycles"
```

---

### Task 3: Replace Text-Based Note Toggling With Stable Browser Identity

**Files:**
- Create: `src/pos/noteProductSelections.js`
- Create: `backend/tests/unit/noteProductSelections.test.js`
- Modify: `src/components/pos/PosCatalogWorkspace.vue`
- Modify: `src/pos/stores/orderSessionStore.js`
- Modify: `src/pos/useTerminal.js`
- Modify: `backend/routes/pos/catalog.js`
- Modify: `backend/tests/integration/bundle.catalog.test.js`
- Modify: `backend/tests/unit/useTerminal.test.js`
- Modify: `src/shared/i18n/ar.json`

**Interfaces:**
- Produces: `isNoteProduct(product)`, `noteProductIds(line)`, `hasNoteProduct(line, productId)`, `noteProductGrossPrice(product)`, `toggleNoteProduct(line, product)`, `editableItemNote(line)`, `saveEditableItemNote(line, manualText)`, and `syncNoteProducts(line, resolvedById)`.
- Consumes: existing `selectedModifiers`, `modifier_surcharge`, `modifier_tax_amount`, `price`, `tax_rate`, and `note` fields.
- Consumes: catalog-owned `category_is_notes` and `category_is_active` fields for each returned product; active navigation state is presentation only.

- [ ] **Step 1: Write the pure browser-contract tests**

Create `backend/tests/unit/noteProductSelections.test.js` covering:

```js
it('toggles by product id and updates price, surcharge, tax, and display together', () => {
    const line = { price: 2.7, tax_rate: 8, note: 'No onions', selectedModifiers: null, modifier_surcharge: null };
    const product = { id: 91, name: 'Two slices', price: 0.172414, tax_rate: 16 };
    expect(toggleNoteProduct(line, product)).toBe(true);
    expect(line).toMatchObject({ price: 2.9, modifier_surcharge: 0.2, note: 'No onions\nTwo slices (+0.20)' });
    expect(line.modifier_tax_amount).toBeCloseTo(0.014815, 6);
    expect(hasNoteProduct(line, 91)).toBe(true);
    expect(toggleNoteProduct(line, product)).toBe(false);
    expect(line).toMatchObject({ price: 2.7, modifier_surcharge: null, modifier_tax_amount: null, note: 'No onions' });
});

it('keeps same-name products independent and never duplicates one id', () => {
    const line = { price: 2.7, tax_rate: 0, note: '', selectedModifiers: [] };
    toggleNoteProduct(line, { id: 91, name: 'Extra', price: 0.2, tax_rate: 0 });
    toggleNoteProduct(line, { id: 92, name: 'Extra', price: 0.3, tax_rate: 0 });
    expect(noteProductIds(line)).toEqual([91, 92]);
    toggleNoteProduct(line, { id: 91, name: 'Extra', price: 0.2, tax_rate: 0 });
    expect(noteProductIds(line)).toEqual([92]);
});

it('edits manual text without exposing generated structured lines', () => {
    const line = {
        note: 'Extra\nExtra (+0.20)',
        selectedModifiers: [{ noteProductId: 91, group: 'Extra', option: 'Extra', price: 0.2 }]
    };
    expect(editableItemNote(line)).toBe('Extra');
    saveEditableItemNote(line, 'Extra\nPack separately');
    expect(line.note).toBe('Extra\nPack separately\nExtra (+0.20)');
});
```

Also cover zero-price notes, formal modifiers remaining untouched, quantity not changing per-unit money, an ordinary free-text `(+99.00)` line contributing zero, and the existing 50-selection bound refusing a 51st selection.

Add pure classification assertions proving `{ category_is_notes: 1 }` is a note regardless of active navigation and `{ category_is_notes: 0 }` is ordinary. In `backend/tests/integration/bundle.catalog.test.js`, search globally for one ordinary product and one note-category product and assert each result carries its own numeric `category_is_notes` and `category_is_active` metadata. Repeat the metadata assertion through `/api/pos/product_lookup` for the note product's barcode.

In `backend/tests/unit/useTerminal.test.js`, assert scanning that result does not call `addToCart` and reports `Note products must be added to an item.`. In `orderSessionStore.test.js`, assert direct `addToCart(noteProduct)` and a QR draft containing a note product both refuse the standalone line without changing the cart.

- [ ] **Step 2: Run the helper test and observe RED**

Run:

```powershell
npx vitest run backend/tests/unit/noteProductSelections.test.js
```

Expected: import failure because `src/pos/noteProductSelections.js` does not exist.

- [ ] **Step 3: Implement the single-purpose browser helper**

Create `src/pos/noteProductSelections.js` with these rules:

```js
import { modifierTaxAmount, roundSix } from '@/utils/posTotals.js';

const safeId = value => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const boundedSelections = line => (Array.isArray(line?.selectedModifiers) ? line.selectedModifiers : [])
    .slice(0, 50);
const noteSelections = line => boundedSelections(line)
    .filter(selection => safeId(selection?.noteProductId));
const displayLine = selection => Number(selection.price) > 0
    ? `${selection.option} (+${Number(selection.price).toFixed(2)})`
    : String(selection.option || '');
const linesOf = note => String(note || '').split('\n').map(line => line.trim()).filter(Boolean);

export const noteProductGrossPrice = product => roundSix(
    Number(product?.price || 0) * (1 + Number(product?.tax_rate || 0) / 100)
);
export const isNoteProduct = product => Number(product?.category_is_notes) === 1;
export const noteProductIds = line => noteSelections(line).map(selection => safeId(selection.noteProductId));
export const hasNoteProduct = (line, productId) => noteProductIds(line).includes(safeId(productId));

const removeGeneratedLines = (note, selections) => {
    const lines = linesOf(note);
    for (const selection of [...selections].reverse()) {
        const index = lines.lastIndexOf(displayLine(selection));
        if (index >= 0) lines.splice(index, 1);
    }
    return lines;
};
const composeNote = (manualLines, selections) => [
    ...manualLines,
    ...selections.map(displayLine).filter(Boolean)
].join('\n');
const writeModifierMoney = (line, nonNoteSurcharge, nextNoteSurcharge) => {
    const surcharge = roundSix(Math.max(0, nonNoteSurcharge + nextNoteSurcharge));
    line.modifier_surcharge = surcharge > 0 ? surcharge : null;
    const includedTax = modifierTaxAmount(surcharge, Number(line.tax_rate || 0));
    line.modifier_tax_amount = includedTax == null ? null : roundSix(includedTax);
};

export const editableItemNote = line => removeGeneratedLines(line?.note, noteSelections(line)).join('\n');
export const saveEditableItemNote = (line, manualText) => {
    line.note = composeNote(linesOf(manualText), noteSelections(line));
};
```

Implement `toggleNoteProduct()` in the same file by stripping current generated lines first, calculating the old structured-note total, preserving `Math.max(0, current modifier_surcharge - old note total)` as non-note surcharge, adding/removing exactly one ID, writing the new canonical snapshot, rebuilding `note`, and applying only the note delta to `line.price`. Never search note text to decide active state.

Use this complete implementation:

```js
const priceOf = selection => Math.max(0, Number(selection?.price) || 0);
const sumPrices = selections => roundSix(selections.reduce((sum, selection) => sum + priceOf(selection), 0));
const nonNoteSurchargeOf = (line, currentNoteSelections) => {
    const current = Number(line?.modifier_surcharge);
    if (Number.isFinite(current) && current >= 0) {
        return roundSix(Math.max(0, current - sumPrices(currentNoteSelections)));
    }
    const excluded = new Set(currentNoteSelections);
    const formalSnapshot = (Array.isArray(line?.selectedModifiers) ? line.selectedModifiers : [])
        .filter(selection => !safeId(selection?.noteProductId) && !excluded.has(selection));
    return sumPrices(formalSnapshot);
};

export const toggleNoteProduct = (line, product) => {
    const id = safeId(product?.id);
    if (!line || !id) return false;
    const all = [...boundedSelections(line)];
    const currentNotes = noteSelections(line);
    const manualLines = removeGeneratedLines(line.note, currentNotes);
    const oldNoteTotal = sumPrices(currentNotes);
    const nonNoteSurcharge = nonNoteSurchargeOf(line, currentNotes);
    const existingIndex = all.findIndex(selection => safeId(selection?.noteProductId) === id);

    if (existingIndex >= 0) {
        all.splice(existingIndex, 1);
    } else {
        if (all.length >= 50) return false;
        const name = String(product?.name || '').trim();
        all.push({ noteProductId: id, group: name, option: name, price: noteProductGrossPrice(product) });
    }

    const nextNotes = all.filter(selection => safeId(selection?.noteProductId));
    const nextNoteTotal = sumPrices(nextNotes);
    line.selectedModifiers = all.length ? all : null;
    line.note = composeNote(manualLines, nextNotes);
    line.price = Number((Number(line.price || 0) + nextNoteTotal - oldNoteTotal).toFixed(4));
    writeModifierMoney(line, nonNoteSurcharge, nextNoteTotal);
    return existingIndex < 0;
};
```

- [ ] **Step 4: Return and consume product-owned category metadata**

In both the main catalog product `SELECT` and barcode `product_lookup` `SELECT` in `backend/routes/pos/catalog.js`, add:

```sql
c.is_notes AS category_is_notes,
c.is_active AS category_is_active
```

Keep search global. Do not derive these fields from the active category in Vue and do not add a new endpoint.

In `src/components/pos/PosCatalogWorkspace.vue`, replace every product-specific use of `isNotesCategoryActive` in card styling, sold-out behavior, price/note affordance, availability long-press/context-menu guards, active-note state, and `handleProductClick()` with `isNoteProduct(product)`. The navigation category may remain selected during search but must not decide what a returned product means.

When a note product's direct category is inactive, show the existing/new priced-note unavailable message and do not mutate the cart. When an ordinary search result appears while a notes category is selected, call the ordinary `addToCart(product)` path.

Defend the non-card entry points without inventing a new workflow:

- In `orderSessionStore.addToCart()`, reject `isNoteProduct(product)` before stock/modifier handling and show `Note products must be added to an item.`. In `importQrDraftItems()`, reject the draft before importing any line if any resolved product is a note product; return `{ success: false, imported: 0, reason: 'note_product' }`.
- In `useTerminal.processBarcode()`, reject a note product before calling `addToCart` and set the same English scan message. This prevents the existing `added === false` branch from misreporting the result as sold out.
- Add the same source key to Arabic translations. Do not make a barcode silently attach to whichever cart row happens to be selected.

- [ ] **Step 5: Replace the component's manual mutation**

In `src/components/pos/PosCatalogWorkspace.vue`:

```js
import { hasNoteProduct, toggleNoteProduct } from '@/pos/noteProductSelections.js';

const isNoteActive = product => selectedCartIndex.value !== null &&
    isNoteProduct(product) &&
    hasNoteProduct(cartItems.value[selectedCartIndex.value], product.id);
```

Replace the note branch of `handleProductClick()` with:

```js
const item = cartItems.value[selectedCartIndex.value];
if (item.order_item_id != null) {
    window.showPosToast?.(t('Saved items cannot be changed. Add a new line instead.'), 'warning');
    return;
}
toggleNoteProduct(item, product);
```

- [ ] **Step 6: Protect generated lines in the manual-note modal**

In `src/pos/stores/orderSessionStore.js`, import `editableItemNote` and `saveEditableItemNote`. Change the item branch of `openNoteModal()` to load only `editableItemNote(cart.value[selectedCartIndex.value])`, and change the item branch of `saveNote()` to call `saveEditableItemNote(...)`. Leave order-level notes unchanged.

Add `Saved items cannot be changed. Add a new line instead.` and the priced-note unavailable source key to `src/shared/i18n/ar.json` with natural cashier-facing Arabic translations. Source keys and server messages stay English.

- [ ] **Step 7: Run GREEN and store regressions**

Run:

```powershell
npx vitest run backend/tests/unit/noteProductSelections.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/useTerminal.test.js backend/tests/integration/bundle.catalog.test.js
```

Expected: all tests pass; existing formal-modifier confirmation and manual-note tests remain green.

- [ ] **Step 7a: Break Task 3 before committing**

Exercise four component decisions without changing navigation: ordinary result from an ordinary category, note result from a note category, note result returned by global search while an ordinary category remains active, and ordinary result returned by global search while a notes category remains active. The first/fourth must add cart lines; the second/third must require a selected parent and toggle by stable ID. Repeat the note click on a saved `order_item_id` and prove price, note, surcharge, and selection JSON are byte-for-byte unchanged. Edit manual text containing the exact same words as a generated note and prove one manual occurrence plus one generated occurrence remain. Finally feed the same note product through card click, barcode lookup, and QR import: only card click with a selected fresh parent may mutate the cart.

- [ ] **Step 8: Commit Task 3 only**

```powershell
git add src/pos/noteProductSelections.js src/components/pos/PosCatalogWorkspace.vue src/pos/stores/orderSessionStore.js src/pos/useTerminal.js backend/routes/pos/catalog.js src/shared/i18n/ar.json backend/tests/unit/noteProductSelections.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/useTerminal.test.js backend/tests/integration/bundle.catalog.test.js
git commit -m "fix(pos): bind priced note selections to catalog ids"
```

---

### Task 4: Reconcile Fresh Drafts on Refresh and Recover Id-less Priced-Note Drafts

**Files:**
- Modify: `backend/routes/pos/catalog.js`
- Modify: `src/pos/noteProductSelections.js`
- Modify: `src/pos/categoryPriceSync.js`
- Modify: `src/components/PosTerminal.vue`
- Modify: `src/shared/i18n/ar.json`
- Modify: `backend/tests/unit/categoryPriceSync.test.js`
- Modify: `src/pos/useProductsRequests.spec.js`
- Modify: `backend/tests/integration/bundle.catalog.test.js`
- Modify: `tests/e2e/specs/cashier.checkout.spec.js`

**Interfaces:**
- Consumes: the existing `POST /api/pos/category-prices/resolve` request with the union of base and `noteProductId` values.
- Produces: resolved rows with `name`, `product_is_active`, `category_is_active`, and `category_is_notes`; `collectFreshCatalogProductIds()` captures the base/note identity set; `chunkProductIds()` emits endpoint-safe batches; `syncCategoryPrices()` returns `{ lines, repairedNoteSelections }`.

- [ ] **Step 1: Add failing refresh and recovery tests**

Expand `backend/tests/unit/categoryPriceSync.test.js` with:

```js
it('keeps a 0.20 priced note through refresh and canonicalizes rename/price', () => {
    const lines = [{
        id: 1, price: 2.9, tax_rate: 0, modifier_surcharge: 0.2, modifier_tax_amount: 0,
        note: 'Two slices (+0.20)',
        selectedModifiers: [{ noteProductId: 91, group: 'Two slices', option: 'Two slices', price: 0.2 }]
    }];
    const result = syncCategoryPrices(lines, [
        { product_id: 1, price: 2.7, tax_rate: 0 },
        { product_id: 91, name: 'Three slices', price: 0.25, tax_rate: 0,
          product_is_active: 1, category_is_active: 1, category_is_notes: 1 }
    ]);
    expect(lines[0]).toMatchObject({ price: 2.95, modifier_surcharge: 0.25, note: 'Three slices (+0.25)' });
    expect(result.repairedNoteSelections).toBe(0);
});

it('repairs only the broken id-less priced-note fragment', () => {
    const lines = [{
        id: 1, price: 2.9, tax_rate: 0, modifier_surcharge: null,
        note: 'No onions\nTwo slices (+0.20)',
        selectedModifiers: [
            { group: 'Two slices', option: 'Two slices', price: 0.2 },
            { gid: 'g1', oid: 'o1', group: 'Size', option: 'Large', price: 0 }
        ]
    }];
    const result = syncCategoryPrices(lines, [{ product_id: 1, price: 2.7, tax_rate: 0 }]);
    expect(lines[0]).toMatchObject({ price: 2.7, note: 'No onions' });
    expect(lines[0].selectedModifiers).toEqual([{ gid: 'g1', oid: 'o1', group: 'Size', option: 'Large', price: 0 }]);
    expect(result.repairedNoteSelections).toBe(1);
});
```

Also test: an unavailable structured note is removed; an `order_item_id` line is untouched; an ordinary free-text `Two slices (+0.20)` with no matching id-less selection is untouched; manual overrides remain untouched.

Add a pure refresh-race test: capture IDs `[1, 91]`, mutate the fresh draft to include note `92` before applying results, and assert the coverage guard rejects the response. Removing note `91` during the request must remain safe because the current set is then a subset of the requested set.

Pin the existing endpoint bound without adding another cart limit:

```js
expect(chunkProductIds(Array.from({ length: 301 }, (_, index) => index + 1)))
    .toEqual([Array.from({ length: 300 }, (_, index) => index + 1), [301]]);
```

- [ ] **Step 2: Add failing API metadata tests**

In `backend/tests/integration/bundle.catalog.test.js`, create one active note category/product and assert `/api/pos/category-prices/resolve` returns its name and all three eligibility flags. Extend `src/pos/useProductsRequests.spec.js` only to pin that the request still sends the supplied `product_ids` and exact `sales_context` without a second endpoint.

- [ ] **Step 3: Run the refresh tests and observe RED**

Run:

```powershell
npx vitest run backend/tests/unit/categoryPriceSync.test.js src/pos/useProductsRequests.spec.js backend/tests/integration/bundle.catalog.test.js -t "note|category price"
```

Expected: helper/API metadata assertions fail and `syncCategoryPrices()` still resets the line to base plus null surcharge.

- [ ] **Step 4: Extend the existing resolution response, not the API surface**

In `backend/routes/pos/catalog.js`, extend the existing query to join categories and select:

```sql
p.name,
p.is_active AS product_is_active,
c.is_active AS category_is_active,
c.is_notes AS category_is_notes
```

Return the numeric activity/note fields with each current response product. Keep the endpoint's 300-ID cap, missing-ID list, sales-context handling, and price-list attachment unchanged.

- [ ] **Step 5: Implement structured synchronization and exact legacy cleanup**

In `src/pos/noteProductSelections.js`, implement `syncNoteProducts(line, resolvedById)` so it:

1. Calculates the existing structured-note total from valid `noteProductId` snapshots.
2. Recognizes a legacy broken priced note only when all are true: no `noteProductId`, no `gid`/`oid`, `group === option`, finite positive `price`, and `line.note` contains the exact generated `${option} (+${price.toFixed(2)})` line.
3. Removes one exact generated legacy line and its selection without guessing a catalog ID or parsing its price as authority.
4. Resolves current structured IDs from `resolvedById`, dropping unavailable/inactive/non-note records.
5. Canonicalizes active selections to current name and gross price.
6. Preserves formal modifier selections and manual note lines.
7. Rebuilds total surcharge as preserved non-note surcharge plus current note total, then recomputes parent modifier tax.
8. Returns `{ repaired: number }` for removed legacy/unavailable selections.

Use this implementation so the task does not invent a second reconciliation rule:

```js
const resolvedNoteProduct = (resolvedById, id) => {
    const product = resolvedById.get(id) || resolvedById.get(String(id));
    return product && Number(product.product_is_active) === 1 &&
        Number(product.category_is_active) === 1 &&
        Number(product.category_is_notes) === 1
        ? product
        : null;
};
const isLegacyPricedNote = (selection, noteLines) => {
    if (!selection || safeId(selection.noteProductId) || selection.gid || selection.oid) return false;
    if (String(selection.group || '').trim() !== String(selection.option || '').trim()) return false;
    if (!(Number(selection.price) > 0)) return false;
    return noteLines.includes(displayLine(selection));
};

export const syncNoteProducts = (line, resolvedById) => {
    const all = boundedSelections(line);
    const currentNotes = noteSelections(line);
    let manualLines = removeGeneratedLines(line?.note, currentNotes);
    const legacy = new Set(all.filter(selection => isLegacyPricedNote(selection, manualLines)));
    for (const selection of legacy) {
        const index = manualLines.lastIndexOf(displayLine(selection));
        if (index >= 0) manualLines.splice(index, 1);
    }

    const oldNoteLike = [...currentNotes, ...legacy];
    const nonNoteSurcharge = nonNoteSurchargeOf(line, oldNoteLike);
    const next = [];
    const nextNotes = [];
    const seen = new Set();
    let repaired = 0;

    for (const selection of all) {
        if (legacy.has(selection)) {
            repaired += 1;
            continue;
        }
        const id = safeId(selection?.noteProductId);
        if (!id) {
            next.push(selection);
            continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        const product = resolvedNoteProduct(resolvedById, id);
        if (!product) {
            repaired += 1;
            continue;
        }
        const name = String(product.name || '').trim();
        const canonical = {
            noteProductId: id,
            group: name,
            option: name,
            price: noteProductGrossPrice(product)
        };
        next.push(canonical);
        nextNotes.push(canonical);
    }

    line.selectedModifiers = next.length ? next : null;
    line.note = composeNote(manualLines, nextNotes);
    writeModifierMoney(line, nonNoteSurcharge, sumPrices(nextNotes));
    return { repaired };
};
```

In `src/pos/categoryPriceSync.js`, export this small batching helper. For every fresh eligible line: resolve the base row, assign its current `tax_rate` to the line, call `syncNoteProducts()` so modifier tax uses that current parent rate, then set `line.price = resolvedBase.price + line.modifier_surcharge`. Return:

```js
export const chunkProductIds = (ids, size = 300) => {
    const chunks = [];
    for (let index = 0; index < ids.length; index += size) chunks.push(ids.slice(index, index + size));
    return chunks;
};

export const collectFreshCatalogProductIds = lines => [...new Set(
    lines.filter(item => !item.order_item_id && !item.manual_price_override &&
        !item.is_custom && !item.is_notes && !item.is_service_charge)
        .flatMap(item => [Number(item.product_id ?? item.id), ...noteProductIds(item)])
        .filter(id => Number.isSafeInteger(id) && id > 0)
)];

export const requestedIdsCoverCurrentDraft = (requestedIds, currentIds) => {
    const requested = new Set(requestedIds);
    return currentIds.every(id => requested.has(id));
};

return { lines, repairedNoteSelections };
```

- [ ] **Step 6: Resolve base and note-product IDs for both fresh contexts**

Rename `refreshRegisterCategoryPrices()` in `src/components/PosTerminal.vue` to `refreshCartCatalogPrices()`. Collect IDs through the pure helper:

```js
const productIds = collectFreshCatalogProductIds(cartItems.value);
```

Import `collectFreshCatalogProductIds`, `requestedIdsCoverCurrentDraft`, and `chunkProductIds`. Resolve and apply with this shape:

```js
const requestId = ++priceRefreshRequestId;
const capturedSalesContext = salesContext.value;
const capturedTableId = activeTable.value?.id ?? null;
const results = [];
for (const chunk of chunkProductIds(productIds)) {
    results.push(await products.resolveCategoryPrices(chunk, capturedSalesContext));
}
if (results.some(({ response, data }) => !response.ok || !data.success)) return;
if (requestId !== priceRefreshRequestId || salesContext.value !== capturedSalesContext) return;
if ((activeTable.value?.id ?? null) !== capturedTableId || activeTable.value?.is_split) return;

const currentProductIds = collectFreshCatalogProductIds(cartItems.value);
if (!requestedIdsCoverCurrentDraft(productIds, currentProductIds)) {
    schedulePriceRefreshRetry();
    return;
}

const resolvedProducts = results.flatMap(({ data }) => data.products || []);
const { repairedNoteSelections } = syncCategoryPrices(cartItems.value, resolvedProducts);
```

This preserves the existing endpoint cap without adding a route or a cart-wide selection limit. If any chunk fails, apply none of them and let checkout remain authoritative.

Define this adjacent coalescer so concurrent stale responses cannot create a retry storm:

```js
let priceRefreshRetryQueued = false;
const schedulePriceRefreshRetry = () => {
    if (priceRefreshRetryQueued || !isActive.value) return;
    priceRefreshRetryQueued = true;
    queueMicrotask(() => {
        priceRefreshRetryQueued = false;
        if (isActive.value) void refreshCartCatalogPrices();
    });
};
```

The subset check is mandatory: removing a note while the request is in flight is safe to apply, but adding a base product or note that was not requested discards the entire stale response and schedules one fresh invocation. Do not mark an unrequested note unavailable and do not partially apply successful batches.

After synchronization, show one toast when `repairedNoteSelections > 0`:

```js
window.showPosToast?.(
    t('A priced note changed or is unavailable. Refresh and re-add it.'),
    'warning'
);
```

Add that exact key to `src/shared/i18n/ar.json` with a natural cashier-facing Arabic translation. The deep cart watcher already persists the repaired draft; do not add another storage writer.

- [ ] **Step 7: Run unit/API tests GREEN**

Run:

```powershell
npx vitest run backend/tests/unit/noteProductSelections.test.js backend/tests/unit/categoryPriceSync.test.js src/pos/useProductsRequests.spec.js backend/tests/integration/bundle.catalog.test.js -t "note|category price"
```

Expected: all selected tests pass.

- [ ] **Step 8: Add and run the exact browser reproduction**

Add `[priced note] survives refresh and checkout` to `tests/e2e/specs/cashier.checkout.spec.js`. Seed a parent category, an `is_notes=1` subcategory, a `0.20` note product, and a tax-zero `2.70` base product; open a shift, add quantity three, select the note subcategory, apply the note, reload, assert the cart still shows `2.90` per unit and `8.70`, then pay `8.70` and assert the checkout response is 200 rather than `Subtotal mismatch`.

Add one compact `[priced note] global search uses product category` browser case in the same file. Keep an ordinary category selected, search for the note product, select a parent cart row, and prove the result attaches as a note rather than becoming a standalone line. Then keep the notes category selected, search for an ordinary product, and prove it creates an ordinary cart line rather than attaching as a note.

Use this browser flow:

```js
test('[priced note] survives refresh and checkout', async ({ page }) => {
    const [parent] = await pool.query(
        "INSERT INTO categories (name, is_notes, is_active) VALUES ('Extras', 0, 1)"
    );
    const [notes] = await pool.query(
        "INSERT INTO categories (name, parent_id, is_notes, is_active) VALUES ('Paid notes', ?, 1, 1)",
        [parent.insertId]
    );
    await pool.query(
        "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
        [notes.insertId]
    );
    await pool.query(
        "UPDATE products SET price=2.70, tax_rate=0, jofotara_tax_category='O' WHERE id=?",
        [SEED.product1.id]
    );

    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const startingCash = page.locator('input[placeholder="0.00"]');
    await startingCash.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCash).toBeHidden();

    const burger = page.locator('.product-card', { hasText: 'Test Burger' }).first();
    await burger.click();
    await burger.click();
    await burger.click();
    const cartRow = page.locator('tbody tr', { hasText: 'Test Burger' }).first();
    await cartRow.click();
    await page.locator('.category-button', { hasText: 'Extras' }).click();
    await page.locator('.category-button--subcategory', { hasText: 'Paid notes' }).click();
    await page.locator('.product-card', { hasText: 'Two slices' }).click();
    await expect(cartRow).toContainText('Two slices (+0.20)');
    await expect(cartRow).toContainText('2.90');
    await expect(page.locator('.cart-summary')).toContainText('8.70');

    await page.reload();
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const restoredRow = page.locator('tbody tr', { hasText: 'Test Burger' }).first();
    await expect(restoredRow).toContainText('Two slices (+0.20)');
    await expect(restoredRow).toContainText('2.90');
    await expect(page.locator('.cart-summary')).toContainText('8.70');

    await page.getByRole('button', { name: /Pay/i }).click();
    const payment = page.getByRole('dialog', { name: 'Complete Payment' });
    await payment.getByRole('button', { name: /CASH/i }).click();
    await payment.getByRole('textbox', { name: 'Amount Tendered' }).fill('8.70');
    const responsePromise = page.waitForResponse(response =>
        response.url().includes('/api/pos/checkout') && response.request().method() === 'POST'
    );
    await payment.getByRole('button', { name: /CONFIRM PAYMENT/i }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect((await response.json()).total).toBe(8.70);
});
```

Run:

```powershell
npx playwright test tests/e2e/specs/cashier.checkout.spec.js --grep "priced note" --project=cashier-tests
```

Expected: both priced-note browser tests pass: the price/snapshot survives reload and checkout, and global search follows each result's own category metadata.

- [ ] **Step 8a: Break Task 4 before committing**

Delay the price-resolution response in the browser test, add a second note before releasing it, and prove the second note is not removed by the first response. Repeat with one failed batch out of two and prove no line is partially repriced. Reload after legacy id-less recovery and prove the toast appears once, the manual note survives, and the repaired draft no longer triggers recovery. Finally run the exact `0.50 + 0.10 = 0.60` cashier flow that failed in production and assert the request payload, browser total, server-persisted line price, and response total all agree.

- [ ] **Step 9: Commit Task 4 only**

```powershell
git add backend/routes/pos/catalog.js src/pos/noteProductSelections.js src/pos/categoryPriceSync.js src/components/PosTerminal.vue src/shared/i18n/ar.json backend/tests/unit/noteProductSelections.test.js backend/tests/unit/categoryPriceSync.test.js src/pos/useProductsRequests.spec.js backend/tests/integration/bundle.catalog.test.js tests/e2e/specs/cashier.checkout.spec.js
git commit -m "fix(pos): reconcile priced notes after catalog refresh"
```

---

### Task 5: Record the Pricing Contract and Run the Final Hostile Gate

**Files:**
- Modify: `docs/architecture.json`
- Generate: `docs/architecture.html`
- Verify: every file committed in Tasks 1-4

**Interfaces:**
- Produces: architecture authority matching the implemented note-product identity/pricing/frozen-row flow.

- [ ] **Step 1: Update the architecture authority**

Add these facts to `docs/architecture.json`:

- Convention: note-category product selections carry `noteProductId`; display price/text are never money authority.
- Invariant: fresh note-product surcharges are reconstructed from the current database catalog and inherit the parent line's modifier-tax treatment.
- Invariant: saved table/split/paid rows retain frozen `selected_modifiers`, surcharge, and modifier tax even if the note catalog changes.
- Invariant: note-category products cannot be sold as fresh top-level lines. Cashier-selected notes are referenced by `noteProductId` on an ordinary parent item; a DB-declared nested bundle member remains governed by the existing bundle canonicalizer and persists as a zero-priced child.
- Convention: catalog search classifies each product from returned `category_is_notes` metadata, never the active navigation category.
- Update the register checkout, held-order, table-save, and split flows with the new resolver call sites and current line numbers.

Generate and validate rather than editing HTML:

```powershell
npm run architecture
npm run architecture:check
```

Expected: `architecture.json OK` and regenerated `docs/architecture.html`.

- [ ] **Step 2: Run the complete focused verification set**

```powershell
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/helpers.test.js backend/tests/unit/inventoryService.test.js backend/tests/unit/noteProductSelections.test.js backend/tests/unit/categoryPriceSync.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/useTerminal.test.js backend/tests/unit/splitChecks.test.js src/pos/useProductsRequests.spec.js
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/bundle.catalog.test.js -t "priced note|structured modifier|selected_modifiers"
npx playwright test tests/e2e/specs/cashier.checkout.spec.js --grep "priced note" --project=cashier-tests
npm run build:admin
node scripts/validate-schema-drift.js
npm run architecture:check
git diff --check
```

Expected: zero failures, successful admin build, no schema drift introduced, valid architecture, and no whitespace errors.

- [ ] **Step 3: Execute the hostile review prompt against the diff**

Use this exact review prompt without changing code until each claim is tied to a file/test:

> Assume the browser controls every cart field, note text, selected modifier object, quantity, tax field, active category, search results, and submitted subtotal. Assume a manager renames, reprices, deactivates, detaches, or duplicates a note product between click, refresh, hold, table save, split, and checkout. Trace every `fetchCartProducts`, `applyDatabasePrices`, `buildSelectedModifiersSnapshot`, `computeModifierSurcharge`, and price-refresh caller. Try to sell the note product standalone, undercharge with missing display fields or forged/duplicate/unsafe IDs, force malformed catalog money into a generic 500, make stock lock or deduct the note product, reject a valid DB-declared nested bundle member, smuggle a priced note through a fresh custom line, change a frozen saved row, merge two different note IDs, delete manual text, misclassify a global search result, add a note during an in-flight refresh, partially apply a failed batch, or restore an id-less local draft. Reject any path that parses text for money, trusts display price, or produces only a generic subtotal mismatch when the note catalog is unavailable. Confirm both graphite and light POS presentations use the same component/store/helper logic.

If a failure is proven, add the smallest focused RED test to the owning task's test file, fix only that path, rerun the owning command, and amend that task's commit. Do not introduce a generalized modifier framework.

- [ ] **Step 4: Inspect scope and commit the architecture evidence**

```powershell
git status --short
git diff --stat HEAD~4..HEAD
git diff -- docs/architecture.json
git add docs/architecture.json docs/architecture.html
git commit -m "docs: record catalog-backed priced note pricing"
```

Expected: only the plan's named source, tests, translations, and architecture files are present; unrelated branch/evidence files remain untouched.

---

## Completion Criteria

- The exact `3 × (2.70 + 0.20)` reproduction survives reload and checks out at `8.70`.
- The field reproduction `0.50 + 0.10` shows and persists `0.60` and checks out without a subtotal mismatch for cashier and admin sessions.
- Fresh priced notes are identified by `noteProductId`, not names or display strings.
- A safe `noteProductId` remains authoritative when optional client display fields are absent; malformed catalog money fails with `409 NOTE_PRODUCT_UNAVAILABLE`, not a generic 500.
- Global search uses each product's own category metadata, and a note-category product cannot be submitted as a fresh standalone sale line.
- Stock deduction locks and updates base sale products only; shared note products do not serialize unrelated checkouts.
- A note-category product that is already a DB-declared nested bundle member remains valid as the bundle canonicalizer's zero-priced child, while a fresh custom/open line carrying a note ID remains rejected by the existing custom-item gate.
- Adding a new note during an in-flight multi-batch refresh cannot remove it or partially reprice the draft.
- Server pricing and snapshots use current database note-product rows and ignore submitted money.
- Formal modifiers, free-text notes, manual price overrides, tax exemption, income-tax mode, subscriptions, held orders, tables, splits, stock, and frozen historical rows retain their documented behavior.
- Restored id-less priced-note drafts recover by removing only the unverifiable priced-note fragment and prompting once; the existing unsafe legacy-modifier cart guard remains unchanged.
- No migration, dependency, new endpoint, installer, environment, spooler, or production change exists.
- Focused unit, integration, browser, build, schema, architecture, and diff checks are green.
