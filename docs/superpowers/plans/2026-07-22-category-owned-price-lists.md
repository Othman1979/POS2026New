# Category-Owned Price Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add natural, category-owned product price lists for the normal register without a global toggle or order-type binding, while preserving the existing manual order-type checkout workflow and guaranteeing that table orders always use normal product prices.

**Architecture:** A top-level category becomes a price-list root by pointing `categories.price_list_root_id` to its own ID; every descendant stores that same inherited root ID. Sparse `product_price_overrides` rows hold pre-tax overrides for products currently placed in that tree, and missing rows fall back to `products.price`. The register resolves each product independently from its own category tree, so one cart may safely contain products from multiple price lists. Tables and the public/QR menu exclude price-list trees and use base prices. Existing `order_items.price_at_sale` remains the historical source of truth, so no order, order-item, held-order, report, receipt, or JoFotara schema snapshot is added.

**Tech Stack:** Node.js, Express 5, MySQL/MariaDB InnoDB, Vue 3 Composition API plus existing Options API components, Pinia, Socket.IO, Vitest, Supertest, Vite, and Tailwind CSS.

## Global Constraints

- Do not use the brainstorming or caveman skills.
- Implement later on `codex/category-owned-price-lists`; do not implement directly on `master`.
- This document is a plan only. Do not edit runtime code, run a database migration, or change production data while writing or reviewing it.
- Use the existing category rail and checkout modal. Do not add a price-list selector, launcher mode, session mode, Settings toggle, or automatic order-type selection.
- The cashier still selects Talabat, Careem, delivery, dine-in, or any other order type manually in the existing checkout modal.
- A normal category tree has `price_list_root_id = NULL` and behaves exactly as it does today.
- A price-list root is a normal top-level category whose `price_list_root_id = id`. Its descendants inherit that ID.
- A root may be disabled with the existing category Active control; disabling hides it but does not erase its tree or overrides.
- Unmarking a root converts the tree back to ordinary categories and immediately restores base prices. Existing sparse overrides remain dormant so re-marking the same tree can restore them.
- No price-list roots means the whole application behaves exactly as it did before this feature. This is the feature-off contract; there is no global setting.
- Price-list overrides apply only to the normal register. Table catalog, table save, guest-check print, table reopen/add/save, table checkout, table split, table void, QR table ordering, and the public menu use normal base prices.
- `products.price` and `product_price_overrides.price` are pre-tax `DECIMAL(10,6)` values. Admin users enter customer-facing tax-inclusive prices; the backend derives and stores the pre-tax value using the product's current tax rate.
- Zero is a valid override. Blank/null means delete the override and fall back to `products.price`.
- Product tax rates, priced modifiers, zero-price modifiers, bundles, discounts, service charge, stock, sold-out state, kitchen routing, receipts, reporting, and JoFotara calculations keep their current rules. Only the product's base price source changes.
- Notes-category products, custom rows, and `Auto-Gratuity` rows never receive a price-list override.
- A bundle parent may receive an override. Bundle children remain zero-value operational lines under the existing bundle rules.
- The backend remains authoritative. Catalog prices are presentation; hold and checkout re-resolve current database prices.
- Existing paid/edit lines and persisted table lines remain frozen through the current `price_at_sale` and saved-line logic. New unsaved lines in a normal-register edit use their current category price.
- Held register orders do not freeze price-list money. Claim and final checkout use the latest applicable price.
- Existing admin/programmer manual line-price overrides remain allowed. Live refresh must not overwrite a line explicitly changed through the price numpad, and the current backend permission/audit behavior remains authoritative.
- Product/category/order-type names are client data and must not be translated. Add natural English and Arabic only for static UI copy.
- Arabic UI continues to use Latin digits and the application's current JD formatting.
- Keep changes local to the listed paths. Do not redesign the inventory page, category rail, checkout modal, Settings page, reports, receipts, or order-type administration.
- Reuse existing cache invalidation and `inventory_changed` events. Do not introduce a new event bus, keyed cache framework, background job, or global price-list store.

---

## Confirmed User Workflow

### Configure a delivery price list

1. In Inventory -> Categories, create or edit a top-level category such as `Talabat`.
2. Enable `Use this category as a price list` on that category.
3. Copy an existing subcategory tree into `Talabat`, or create its subcategories/products normally.
4. Open the root's `Prices` action and enter only prices that differ from each copied product's normal price.
5. Leave a price blank to use that product's normal price.

### Cashier flow

1. The category rail still behaves normally.
2. The cashier opens `Talabat`, `Careem`, or an ordinary category and adds products normally.
3. Each product card and cart line uses the price belonging to that product's own category tree.
4. A cart may contain products from ordinary categories and multiple price-list trees. Navigating elsewhere never reprices the whole cart into the last category's list.
5. At checkout, the cashier selects the order type manually using the existing controls.
6. The system does not require the order type to match the category name and does not infer or silently change it.

Copied products are independent catalog identities, not aliases. Their later base-price, tax, modifier, stock, availability, and reporting changes do not synchronize with the source product. Their fallback price is the copied row's own `products.price`, reports count the copied product ID separately, and tracked stock starts at zero by design.

### Natural disable behavior

- Set a price-list root inactive to hide it while keeping its configuration.
- Uncheck `Use this category as a price list` to expose that tree as ordinary categories using base prices.
- If a client never creates a price-list root, there is no UI, API, or checkout difference from the current application.

---

## Data Model and Invariants

### `categories.price_list_root_id`

```sql
ALTER TABLE categories
  ADD COLUMN price_list_root_id INT(11) NULL AFTER is_notes,
  ADD KEY idx_categories_price_list_tree (price_list_root_id, is_active, id),
  ADD CONSTRAINT fk_categories_price_list_root
    FOREIGN KEY (price_list_root_id) REFERENCES categories(id)
    ON DELETE SET NULL;
```

Runtime invariants:

1. Ordinary category: `price_list_root_id IS NULL`.
2. Price-list root: top-level, non-notes, and `price_list_root_id = id`.
3. Descendant of a price-list root: `price_list_root_id = root.id`.
4. Moving a subtree recomputes the value for the moved node and every descendant in one transaction.
5. A child cannot independently become a price-list root while it has a parent.
6. A notes category cannot be a price-list root.
7. Runtime price resolution accepts a root only when the referenced category still self-points. A malformed manual database edit therefore falls back to base pricing instead of applying an unrelated override.

Admin copy/price editing accepts an inactive but structurally valid self-pointing root so a list can be prepared before activation. Register runtime pricing additionally requires that root to be active; an inactive root is hidden and its open-cart lines fall back to base prices on the next live/backend resolution.

The inherited column is deliberately denormalized. Category catalogs are small, reads are frequent, and this avoids a recursive query on every product-card, search, barcode, hold, and checkout price resolution.

### `product_price_overrides`

```sql
CREATE TABLE product_price_overrides (
  price_list_root_id INT(11) NOT NULL,
  product_id INT(11) NOT NULL,
  price DECIMAL(10,6) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (price_list_root_id, product_id),
  CONSTRAINT fk_product_price_overrides_root
    FOREIGN KEY (price_list_root_id) REFERENCES categories(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_product_price_overrides_product
    FOREIGN KEY (product_id) REFERENCES products(id)
    ON DELETE CASCADE,
  CONSTRAINT chk_product_price_overrides_nonnegative CHECK (price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```

Rules:

- Store sparse differences only.
- An override row is considered active only when the product's current direct category inherits the same valid self-pointing root.
- Moving a product or category out of a root makes old rows dormant; it does not apply them elsewhere.
- Moving it back to the same root may make the old row active again.
- Unmarking or deactivating a root does not delete override rows.
- No `price_list_id` is added to `orders`, `order_items`, or `held_orders`; product identity plus current category resolves open-order pricing, and `order_items.price_at_sale` freezes completed history.

### Effective price formula

```text
valid register price-list root
  = direct category.price_list_root_id
    whose referenced category is active, top-level, non-notes, and self-pointing

effective net product price
  = override price when a matching sparse row exists
  = products.price otherwise

entered gross override
  -> round(gross / (1 + product.tax_rate / 100), 6)

gross displayed price
  -> existing POS calculation from effective net price and current product tax
```

Income-tax mode continues to use the current zero-effective-tax behavior. The stored net price is not rewritten when the registration profile changes.

---

## Exact API Contracts

### Existing category endpoint extensions

`GET /api/admin/categories` adds:

```json
{
  "id": 20,
  "name": "Talabat",
  "parent_id": null,
  "price_list_root_id": 20,
  "price_list_root_name": "Talabat",
  "is_price_list_root": 1
}
```

`POST /api/admin/categories` and `PUT /api/admin/categories` accept:

```json
{
  "is_price_list_root": true
}
```

Do not accept a client-authored raw `price_list_root_id`. The backend derives it from the parent and root checkbox.

### Copy a category subtree

`POST /api/admin/categories/:id/copy`

```json
{
  "target_parent_id": 20,
  "name": "Chicken"
}
```

Success:

```json
{
  "success": true,
  "root_category_id": 41,
  "categories_copied": 3,
  "products_copied": 18
}
```

The name is optional and defaults to the source root name. Target parent may be null. Reject a target inside the source subtree and invalid/missing source or target IDs.

### Read a category-owned price list

`GET /api/admin/category-price-lists/:rootId/products`

Return all current products inside the root tree, ordered by category path then product name:

```json
{
  "success": true,
  "root": { "id": 20, "name": "Talabat", "is_active": 1 },
  "products": [
    {
      "product_id": 81,
      "name": "Chicken",
      "category_id": 22,
      "category_path": "Talabat > Meals",
      "tax_rate": 8,
      "base_net_price": 0.925926,
      "base_gross_price": 1,
      "override_net_price": null,
      "override_gross_price": null,
      "effective_gross_price": 1
    }
  ]
}
```

Reject a category that is not a valid self-pointing price-list root.

### Save price overrides

`PUT /api/admin/category-price-lists/:rootId/prices`

```json
{
  "prices": [
    { "product_id": 81, "gross_price": 1.250 },
    { "product_id": 82, "gross_price": null }
  ]
}
```

Rules:

- Maximum 1,000 unique product IDs per request.
- Reject duplicate IDs, NaN/infinite/negative values, a net value outside `DECIMAL(10,6)`, and products not currently inside this root.
- `null` deletes the sparse row; `0` upserts a zero price.
- Re-read and lock the root/products inside the transaction before changing rows.
- Write one `category_price_overrides_changed` audit event containing root ID, changed product IDs, and compact old/new net and gross values. `appendAuditEvent` preserves the existing `users.xyz` bypass.
- Commit before invalidating the POS catalog cache or emitting `inventory_changed`. Do not rebuild the dashboard or static public menu for an override-only change because neither consumes price-list overrides.

### POS catalog context

Existing endpoints add `sales_context=register|table`:

```text
GET /api/pos/products?sales_context=register&category_id=20
GET /api/pos/product_lookup?barcode=123&sales_context=register
```

- Missing context defaults to `register` for backward compatibility.
- Any other value returns HTTP 400.
- Register returns active ordinary and price-list category trees. Product `price` is effective; `base_price` is always `products.price`.
- Table returns only categories whose `price_list_root_id IS NULL`; every product uses base price.
- Search results include `category_name`, `price_list_root_id`, `price_list_root_name`, and `has_price_override` so duplicate copied products are distinguishable.
- A barcode assigned to a copied product follows that product's category price in register context. In table context, a product in a price-list tree is not returned.

### Resolve prices for the current open cart

`POST /api/pos/category-prices/resolve`

```json
{
  "sales_context": "register",
  "product_ids": [81, 95]
}
```

Success:

```json
{
  "success": true,
  "products": [
    {
      "product_id": 81,
      "price": 1.157407,
      "base_price": 0.925926,
      "tax_rate": 8,
      "price_list_root_id": 20,
      "has_price_override": 1
    }
  ]
}
```

- Maximum 300 unique positive product IDs.
- Register resolves every product independently.
- Table returns base prices only.
- Missing/deleted IDs are reported in `missing_product_ids`; the frontend leaves those open lines unchanged and final checkout remains authoritative.

---

## Complete File Map

### Create

- `backend/migrations/2026-07-22-category-owned-price-lists.sql`
- `backend/migrations/2026-07-22-category-owned-price-lists-verify.sql`
- `backend/services/categoryPriceLists.js`
- `backend/routes/admin/categoryPriceLists.js`
- `backend/tests/unit/categoryPriceLists.test.js`
- `backend/tests/unit/categoryPriceSync.test.js`
- `backend/tests/integration/categoryPriceLists.test.js`
- `backend/tests/integration/categoryCopy.test.js`
- `assets/js/composables/categoryPriceSync.js`
- `src/admin/components/CategoryPriceListModal.vue`
- `src/admin/components/CategoryCopyModal.vue`
- `src/admin/pages/__tests__/inventoryPriceLists.spec.js`

### Modify

- `backend/tests/fixtures/seed.js`
- `backend/services/schemaValidation.js`
- `backend/tests/unit/schemaAuthority.test.js`
- `backend/routes/admin.js`
- `backend/routes/admin/products.js`
- `backend/routes/admin/import.js`
- `backend/routes/pos/catalog.js`
- `backend/routes/pos/helpers.js`
- `backend/routes/pos/checkout.js`
- `backend/routes/pos/orders.js`
- `backend/routes/pos/tables.js` only for regression tests/comments if production behavior already needs no code change
- `backend/config/menuCache.js`
- `backend/tests/integration/products.test.js`
- `backend/tests/integration/bundle.catalog.test.js`
- `backend/tests/integration/checkout.test.js`
- `backend/tests/integration/heldOrders.test.js`
- `backend/tests/integration/tables.test.js`
- `backend/tests/integration/tableSettlementContext.test.js`
- `assets/js/composables/useProducts.js`
- `assets/js/composables/useTerminal.js`
- `assets/js/composables/stores/orderSessionStore.js`
- `backend/tests/unit/orderSessionStore.test.js`
- `src/components/PosTerminal.vue`
- `src/components/OrderNotes.vue`
- `src/admin/pages/Inventory.vue`
- `src/admin/components/CategoryModal.vue`
- `assets/js/admin/i18n.js`

### Intentionally do not modify

- `src/components/pos/CheckoutModal.vue`
- `src/admin/pages/Settings.vue`
- `backend/routes/admin/printers.js`
- order-type schema/routes/components
- receipt builders, report builders, JoFotara XML builders, and paid-order schemas
- table settlement context/service-charge logic except focused regression coverage

---

## Task 1: Establish the Isolated Implementation Branch and Baseline

**Files:** none

- [ ] **Step 1: Confirm the starting repository state**

```powershell
git status --short --branch
git branch --show-current
git log -1 --oneline
```

Expected: record the exact `master` commit and all pre-existing untracked/modified files. Do not stage or delete unrelated files.

- [ ] **Step 2: Create the feature branch**

```powershell
git switch -c codex/category-owned-price-lists
```

- [ ] **Step 3: Run the relevant baseline**

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/unit/helpers.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/integration/products.test.js backend/tests/integration/bundle.catalog.test.js backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/tableSettlementContext.test.js
npm run build:admin
```

Expected: pass before feature edits. Record any pre-existing failure rather than silently changing unrelated code.

---

## Task 2: Add the Guarded Database Schema and Schema Authority

**Files:**

- Create: `backend/migrations/2026-07-22-category-owned-price-lists.sql`
- Create: `backend/migrations/2026-07-22-category-owned-price-lists-verify.sql`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`

- [ ] **Step 1: Write failing schema-authority tests**

Add assertions for:

- nullable `categories.price_list_root_id` with the expected integer type;
- `idx_categories_price_list_tree` in the exact column order;
- self-FK `fk_categories_price_list_root` with `ON DELETE SET NULL`;
- `product_price_overrides` with the exact composite primary key;
- both override foreign keys and nonnegative price constraint;
- the new migration ledger name/checksum;
- the verifier file exists and checks invalid roots/descendants as well as missing structures.

Run:

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js
```

Expected: fail because the migration/schema is absent.

- [ ] **Step 2: Write the guarded migration**

Follow the procedure/`information_schema` style already used by `backend/migrations/2026-07-19-multi-spooler-printer-ownership.sql`:

1. Create `schema_migrations` if absent.
2. Add the category column only when absent.
3. Add the index only when absent or structurally incorrect.
4. Add the self-FK only when absent.
5. Create the override table only when absent.
6. Do not infer any price-list roots or overrides from category names.
7. Insert the exact migration name/checksum without overwriting another migration.
8. Make a second run a no-op.

- [ ] **Step 3: Write the read-only verifier**

Return named rows with `missing_count`/`blocking_findings` for:

- column, table, primary key, index, foreign key, and ledger presence;
- roots that do not self-point;
- self-pointing roots that have a parent or are notes categories;
- descendants whose stored root is missing or is not self-pointing;
- negative override prices;
- override rows whose product is not currently in the referenced root tree, reported as non-blocking dormant rows rather than migration failure.

- [ ] **Step 4: Update fresh test schema**

In `seed.js`, add the category column/index/self-FK and create `product_price_overrides` after `products` exists. Do not seed a global price-list root; individual tests create their own fixtures.

- [ ] **Step 5: Advance startup validation**

Update `MIGRATION_NAME`, checksum, query counts, and `REQUIRED_COUNTS` in `schemaValidation.js`. Startup must fail with `SCHEMA_MIGRATION_REQUIRED` when any required object or the ledger fingerprint is missing.

- [ ] **Step 6: Verify the slice**

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js
node --check backend/services/schemaValidation.js
```

Expected: pass.

- [ ] **Step 7: Commit**

```powershell
git add backend/migrations/2026-07-22-category-owned-price-lists.sql backend/migrations/2026-07-22-category-owned-price-lists-verify.sql backend/tests/fixtures/seed.js backend/services/schemaValidation.js backend/tests/unit/schemaAuthority.test.js
git commit -m "feat: add category price list schema"
```

---

## Task 3: Build the Single Backend Pricing Authority

**Files:**

- Create: `backend/services/categoryPriceLists.js`
- Create: `backend/tests/unit/categoryPriceLists.test.js`
- Modify: `backend/routes/admin/products.js`
- Modify: `backend/routes/pos/helpers.js`
- Modify: `backend/tests/unit/helpers.test.js`

- [ ] **Step 1: Write failing unit tests**

Cover:

- gross `1.000` at 8% -> net `0.925926`;
- gross `0` remains a valid zero;
- tax 0% preserves gross/net equality;
- negative, infinite, NaN, and out-of-range values reject;
- no category/root -> base price;
- valid matching root + override -> override;
- valid root + missing override -> base;
- notes category -> base despite an override row;
- inactive/malformed root -> base;
- mixed product IDs resolve independently;
- duplicates are deduplicated before SQL.

- [ ] **Step 2: Implement focused exports**

`categoryPriceLists.js` owns:

```js
grossToNet(grossPrice, taxRate)
netToGross(netPrice, taxRate)
loadRegisterPriceContext(executor, productIds)
attachRegisterPrices(executor, productMap)
collectCategorySubtree(categories, rootId)
resolveInheritedRootId(categoriesById, parentId)
```

`loadRegisterPriceContext` performs one batched query joining products, direct categories, the referenced self-pointing root, and sparse overrides. It returns base/effective price, tax, notes flag, root metadata, and override flag.

Remove the local `stripTax` implementation from `backend/routes/admin/products.js` and use `grossToNet` for ordinary single/batch product creation and price updates too. This keeps one gross-to-net rounding authority without changing the existing admin product contract.

- [ ] **Step 3: Extend existing product-map pricing without changing defaults**

Keep `fetchCartProducts` base-only by default. `attachRegisterPrices` enriches a map only when an explicit register workflow calls it. Change `applyDatabasePrices` from:

```js
const basePrice = Number(product.price);
```

to:

```js
const basePrice = Number(product.effective_price ?? product.price);
```

All existing table/refund/stock callers therefore remain base-price callers unless explicitly enriched.

- [ ] **Step 4: Run unit tests**

```powershell
npx vitest run backend/tests/unit/categoryPriceLists.test.js backend/tests/unit/helpers.test.js backend/tests/integration/products.test.js
node --check backend/services/categoryPriceLists.js
node --check backend/routes/pos/helpers.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/services/categoryPriceLists.js backend/tests/unit/categoryPriceLists.test.js backend/routes/admin/products.js backend/routes/pos/helpers.js backend/tests/unit/helpers.test.js
git commit -m "feat: resolve category owned prices"
```

---

## Task 4: Make Category Root Inheritance Transactional

**Files:**

- Modify: `backend/routes/admin/products.js`
- Modify: `backend/tests/integration/products.test.js`

- [ ] **Step 1: Write failing category tests**

Cover:

- create ordinary top-level -> null root;
- create marked top-level -> self root after insert;
- create child under marked root -> inherited root;
- create grandchild -> same inherited root;
- reject notes root;
- reject child marked as independent root;
- mark an existing top-level root -> propagate to all descendants;
- unmark -> propagate null to all descendants and keep override rows;
- move a subtree from normal to price-list tree -> propagate destination root;
- move a subtree between price-list roots -> propagate the new root;
- move a subtree to top level -> null unless explicitly marked as a root;
- reject cycles and invalid parent IDs with 400/409 instead of silently moving to root;
- concurrent/transaction failure leaves the entire tree unchanged;
- GET returns root name and computed root flag.

- [ ] **Step 2: Make category POST transactional**

Validate name, parent, notes, and boolean root intent. Lock/read the parent when present. Insert, then self-update the new ID when it is a root. Append the existing category audit inside the transaction and call `afterCatalogMutation` only after commit.

- [ ] **Step 3: Make category PUT transactional**

Load all category IDs/parents/root IDs in one transaction because the catalog is small. Validate the complete proposed tree in memory, update the edited row, and update the moved/marked/unmarked subtree in one batched statement.

Field semantics:

- absent `is_price_list_root`: preserve whether the edited category is currently a self-root;
- explicit true: require proposed `parent_id = NULL` and `is_notes = 0`;
- explicit false: inherit the proposed parent's valid root or null;
- never trust a submitted `price_list_root_id`.

Add a `ponytail:` comment at the one all-category load explaining that a recursive CTE is deferred until real category scale requires it.

- [ ] **Step 4: Keep DELETE deterministic**

Retain the current soft-delete semantics. For a non-root child, direct children move to the deleted category's parent and retain the correct inherited root. Products directly inside the deleted category become uncategorized. For a price-list root, clear inherited root IDs from descendants before unparenting them, keep the inactive root row and its dormant override rows, and make the confirmation/audit explicit that the tree was detached.

- [ ] **Step 5: Verify**

```powershell
npx vitest run backend/tests/integration/products.test.js
node --check backend/routes/admin/products.js
```

Expected: pass.

- [ ] **Step 6: Commit**

```powershell
git add backend/routes/admin/products.js backend/tests/integration/products.test.js
git commit -m "feat: inherit price lists through categories"
```

---

## Task 5: Add Safe Transactional Category-Tree Copying

**Files:**

- Create: `backend/routes/admin/categoryPriceLists.js`
- Create: `backend/tests/integration/categoryCopy.test.js`
- Modify: `backend/routes/admin.js`

- [ ] **Step 1: Write failing copy tests**

Prove one transaction copies:

- the selected category and all descendants with new IDs;
- optional root rename, while preserving descendant names;
- products with new IDs;
- `barcode = NULL` and `sku = NULL` to avoid unique collisions;
- product name, base price, cost, tax, modifiers, image, colors, grid visibility, bundle flag, stock thresholds, active state, and sold-out state;
- `stock = NULL` when source stock is untracked and `stock = 0` when source stock is tracked;
- printer-category mappings to corresponding new category IDs;
- bundle links using new child product IDs when the child was copied and original product IDs when the child is outside the copied tree;
- destination price-list root inheritance for every copied category;
- no copied price-override rows and no copied price-history rows;
- one `category_tree_copied` audit event with source, target, and counts;
- `users.xyz = 1` suppresses that event through existing audit behavior;
- invalid target/source or a target inside the source subtree creates no rows;
- an induced SQL failure rolls back categories, products, bundles, mappings, and audit together.

- [ ] **Step 2: Implement `POST /categories/:id/copy`**

In one connection/transaction:

1. Lock and load source/target categories.
2. Load the source subtree and reject target-inside-source.
3. Insert categories parent-first and build `oldCategoryId -> newCategoryId`.
4. Derive destination root from the target parent; never copy the source root marker.
5. Insert products and build `oldProductId -> newProductId`.
6. Insert printer mappings with `INSERT IGNORE`.
7. Insert bundle mappings in a second pass after every product ID exists.
8. Append one audit event.
9. Commit, then call catalog/dashboard/static-menu invalidation and emit one `inventory_changed`.

- [ ] **Step 3: Mount the route**

Mount `backend/routes/admin/categoryPriceLists.js` in `backend/routes/admin.js` after authentication/admin middleware. Keep `/api/admin/categories` CRUD in `products.js`; the new parameterized route does not conflict with the exact `/categories` path.

- [ ] **Step 4: Verify**

```powershell
npx vitest run backend/tests/integration/categoryCopy.test.js backend/tests/integration/bundle.admin.test.js
node --check backend/routes/admin/categoryPriceLists.js
node --check backend/routes/admin.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/routes/admin/categoryPriceLists.js backend/routes/admin.js backend/tests/integration/categoryCopy.test.js
git commit -m "feat: copy catalog category trees"
```

---

## Task 6: Add the Admin Price-Override API

**Files:**

- Modify: `backend/routes/admin/categoryPriceLists.js`
- Create: `backend/tests/integration/categoryPriceLists.test.js`

- [ ] **Step 1: Write failing API tests**

Cover the exact GET/PUT contracts, including:

- root validation;
- an authenticated non-admin receives 403 from copy/read/save endpoints through the existing admin router guard;
- recursive descendants;
- category paths with duplicate names;
- gross/net conversion at 0%, 8%, and 16%;
- missing fallback;
- zero override;
- null deletion;
- notes-product rejection/omission;
- duplicate product IDs;
- product moved out of root between read/save;
- inactive products remain editable but clearly marked;
- transaction rollback;
- one compact audit event;
- post-commit cache invalidation and socket event.

- [ ] **Step 2: Implement GET**

Load the valid root and its current subtree, then query products plus sparse rows. Calculate response gross values through the shared service; do not duplicate tax math in the route.

- [ ] **Step 3: Implement PUT**

Normalize all changes before opening the transaction. Inside it, lock the root and referenced products, revalidate current membership, compute net values with current tax, upsert non-null values, delete null values, and audit only actual changes.

- [ ] **Step 4: Verify**

```powershell
npx vitest run backend/tests/integration/categoryPriceLists.test.js
node --check backend/routes/admin/categoryPriceLists.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/routes/admin/categoryPriceLists.js backend/tests/integration/categoryPriceLists.test.js
git commit -m "feat: manage category price overrides"
```

---

## Task 7: Add the Minimal Inventory Administration UI

**Files:**

- Modify: `src/admin/pages/Inventory.vue`
- Modify: `src/admin/components/CategoryModal.vue`
- Create: `src/admin/components/CategoryPriceListModal.vue`
- Create: `src/admin/components/CategoryCopyModal.vue`
- Modify: `assets/js/admin/i18n.js`
- Create: `src/admin/pages/__tests__/inventoryPriceLists.spec.js`

- [ ] **Step 1: Write failing source/design contract tests**

Assert:

- both new modals are mounted and all setup bindings returned;
- CategoryModal sends `is_price_list_root`, never raw root ID;
- inherited child context is read-only;
- the category table exposes Copy for all applicable categories and Prices only for self-roots;
- all static strings have natural Arabic entries;
- product/category names remain `data-no-i18n`;
- no Settings/order-type control is introduced;
- modal CSS includes responsive height/overflow and touch targets of at least 44px on phone/tablet controls.

- [ ] **Step 2: Extend CategoryModal**

Use its existing Options API style. Add one top-level checkbox:

- English: `Use this category as a price list`
- Arabic: `استخدام هذا التصنيف كقائمة أسعار`

When a parent is selected, disable root selection and show the inherited root name when applicable. Checking root clears parent and notes. Checking notes clears root. Preserve current category CRUD layout and styling.

- [ ] **Step 3: Extend Inventory category rows**

Add a quiet `Price list` / `قائمة أسعار` badge on self-roots and an inherited root label on descendants. Add:

- `Prices` / `الأسعار` on self-roots;
- `Copy` / `نسخ` on category rows.

Use the current desktop row/mobile card action language. Do not add another page or permanent panel.

Change the existing `getCategoryName` helper to build the complete ancestor path with a visited-ID guard. Product rows, stock rows, CSV export, copy targets, and modal category selectors must show enough path context to distinguish duplicated category names.

- [ ] **Step 4: Build CategoryCopyModal**

Fields: source summary, optional copied-root name, and target parent. Use the existing flattened category tree with full path labels so duplicate names remain distinguishable. Disable submit during the request, surface backend errors, close on success, and refresh Inventory once.

- [ ] **Step 5: Build CategoryPriceListModal**

Use a full but bounded responsive modal:

- sticky title/actions;
- search;
- category filter using path labels;
- changed-only toggle;
- rows for Product, Normal price, List price, and Effective price;
- blank input means fallback;
- `step="0.001"`, Latin digits, and existing JD formatting;
- one bulk percentage tool applied only to currently filtered rows after confirmation;
- one clear-filtered-overrides action after confirmation;
- save only locally changed rows in one request;
- preserve unsaved changes when filters change;
- warn before closing with unsaved edits.

Do not place price-list fields in ProductModal or BatchProductWorkspace; base product creation remains unchanged.

- [ ] **Step 6: Add natural translations**

Use concise Arabic such as:

- `Price list` -> `قائمة أسعار`
- `Normal price` -> `السعر العادي`
- `List price` -> `سعر القائمة`
- `Using normal price` -> `يستخدم السعر العادي`
- `Copy category` -> `نسخ التصنيف`
- `Copy into` -> `النسخ إلى`

- [ ] **Step 7: Verify**

```powershell
npx vitest run src/admin/pages/__tests__/inventoryPriceLists.spec.js
npm run build:admin
```

Expected: pass with no Vue render warning.

- [ ] **Step 8: Commit**

```powershell
git add src/admin/pages/Inventory.vue src/admin/components/CategoryModal.vue src/admin/components/CategoryPriceListModal.vue src/admin/components/CategoryCopyModal.vue assets/js/admin/i18n.js src/admin/pages/__tests__/inventoryPriceLists.spec.js
git commit -m "feat: configure category price lists"
```

---

## Task 8: Make Catalog, Search, Barcode, Cache, and Public Menu Context-Aware

**Files:**

- Modify: `backend/routes/pos/catalog.js`
- Modify: `backend/config/menuCache.js`
- Modify: `backend/tests/integration/bundle.catalog.test.js`
- Modify: `backend/tests/integration/categoryPriceLists.test.js`

- [ ] **Step 1: Write failing catalog tests**

Cover:

- legacy request without context -> register;
- invalid context -> 400;
- ordinary root -> base price;
- price-list root override and fallback;
- independent mixed-root search results;
- notes product remains base;
- inactive/malformed root is hidden/falls back safely;
- table context hides all price-list roots/products and uses base prices;
- table full-load cannot receive a cached register payload;
- register search/barcode metadata distinguishes duplicate copied products;
- bundles preserve current `can_sell` and child metadata;
- category counts/default selection respect context;
- `/resolve` returns one current row per unique product and table context returns base;
- static public menu excludes all price-list categories/products.

- [ ] **Step 2: Parse context once**

At the start of `/products`, `/product_lookup`, and `/category-prices/resolve`, normalize `sales_context`. Do not infer it from order type, route, category, or user role.

- [ ] **Step 3: Filter catalog roots correctly**

For table context:

- category queries require `price_list_root_id IS NULL`;
- product queries exclude products whose direct category has a non-null inherited root;
- uncategorized/ordinary products retain current search behavior;
- context conditions apply to full, lightweight, search, counts, pagination, and barcode paths.

For register context, use shared price resolution and expose `base_price`, root metadata, and override flag. The current single catalog cache remains register/full-root only; table and filtered requests bypass it.

- [ ] **Step 4: Make category replacement explicit**

Return `categories_included: true|false`. Full requests replace the category list even when it is empty; lightweight search/category pagination keeps the current rail. This prevents a table context with zero ordinary categories from retaining stale register price-list categories.

- [ ] **Step 5: Add `/category-prices/resolve`**

Use the same service as catalog and authoritative checkout. Do not duplicate price SQL.

- [ ] **Step 6: Protect the public/QR menu**

In `menuCache.js`, select only active categories with `price_list_root_id IS NULL` and only products whose category is null or ordinary. Keep `products.price`; do not join override rows.

- [ ] **Step 7: Verify**

```powershell
npx vitest run backend/tests/integration/categoryPriceLists.test.js backend/tests/integration/bundle.catalog.test.js
node --check backend/routes/pos/catalog.js
node --check backend/config/menuCache.js
```

Expected: pass.

- [ ] **Step 8: Commit**

```powershell
git add backend/routes/pos/catalog.js backend/config/menuCache.js backend/tests/integration/categoryPriceLists.test.js backend/tests/integration/bundle.catalog.test.js
git commit -m "feat: serve context aware catalog prices"
```

---

## Task 9: Keep the POS UI Current Without Global Price-List State

**Files:**

- Modify: `assets/js/composables/useProducts.js`
- Modify: `assets/js/composables/useTerminal.js`
- Create: `assets/js/composables/categoryPriceSync.js`
- Create: `backend/tests/unit/categoryPriceSync.test.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `src/components/PosTerminal.vue`

- [ ] **Step 1: Write failing frontend unit tests**

For the pure cart-sync helper, cover:

- mixed price-list roots update independently;
- base fallback after root unmark;
- existing modifier surcharge remains added to the new base;
- modifier included tax is recalculated from current product tax;
- quantity, notes, selected modifiers, line discounts, order discounts, customer data, and order type are untouched;
- custom, notes, service-charge, saved `order_item_id`, saved table, and manual-price lines are skipped;
- missing products are left unchanged.

In `orderSessionStore.test.js`, prove the price numpad marks the selected line `manual_price_override = true` and normal add/restore flows do not accidentally mark it.

- [ ] **Step 2: Add explicit sales context to useProducts**

Add module-scoped `salesContext = ref('register')` and `setSalesContext(context)`:

- only accepts register/table;
- increments the existing request ID to invalidate older responses;
- clears category/subcategory/folder selection on a real context change;
- triggers a full catalog fetch;
- appends `sales_context` to every catalog URL;
- replaces categories only when `categories_included` is true.

Do not add a selected price-list root, price-list session, or local/session storage field.

- [ ] **Step 3: Add barcode context**

Append `sales_context=register` to the fallback lookup. Barcode UI remains hidden during table sessions as today.

- [ ] **Step 4: Implement pure eligible-line repricing**

`categoryPriceSync.js` takes current cart lines and resolver rows and mutates only eligible unsaved register lines. Set:

```text
line.price = resolved effective net base + existing modifier_surcharge
line.tax_rate = resolved current tax rate
line.modifier_tax_amount = existing helper-derived included tax
```

Keep current four/six-decimal rounding conventions from `applyDatabasePrices` and modifier helpers.

- [ ] **Step 5: Wire PosTerminal context changes**

Before initial `products.fetchData()`, set context from the already-restored `activeTable`. In the existing `watch(activeTable, ...)`, change context before barcode setup. A late register response must not paint after table activation, and a late table response must not hide register categories after leaving the table.

- [ ] **Step 6: Wire live cart refresh**

After `inventory_changed`, reconnect, and window focus:

1. refresh the visible catalog using its current context;
2. if still in register context and eligible cart product IDs exist, capture a monotonically increasing price-refresh request ID;
3. call `/category-prices/resolve`;
4. apply only when request ID and register/table state still match;
5. synchronize sold-out state as today.

Do not clear the cart or show a modal. The next checkout remains the final source of truth if the refresh fails.

- [ ] **Step 7: Distinguish duplicate search cards quietly**

Only while `searchQuery` is nonblank, render a small category/root path under duplicate product names. Do not add permanent card chrome or change the existing category rail.

- [ ] **Step 8: Verify**

```powershell
npx vitest run backend/tests/unit/categoryPriceSync.test.js backend/tests/unit/orderSessionStore.test.js
npm run build:admin
```

Expected: pass with no Vue undefined-property warning.

- [ ] **Step 9: Commit**

```powershell
git add assets/js/composables/useProducts.js assets/js/composables/useTerminal.js assets/js/composables/categoryPriceSync.js assets/js/composables/stores/orderSessionStore.js backend/tests/unit/categoryPriceSync.test.js backend/tests/unit/orderSessionStore.test.js src/components/PosTerminal.vue
git commit -m "feat: keep register category prices current"
```

---

## Task 10: Enforce Effective Prices in Normal Register Checkout

**Files:**

- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/tests/integration/checkout.test.js`

- [ ] **Step 1: Write failing checkout tests**

Add a compact matrix proving:

1. override gross 1.000 at 8% stores/charges the expected net/tax/gross;
2. missing override falls back to base;
3. one cart may mix ordinary, Talabat, and Careem product IDs;
4. a cashier-forged price is replaced;
5. a permitted manager manual line price remains accepted/audited under current rules;
6. priced modifier surcharge stays gross-inclusive and inherits product tax;
7. line fixed/percent and order fixed/percent discounts recalculate from effective price;
8. service charge derives from the effective discounted register subtotal under existing rules;
9. sold-out product already in cart remains processable under current sold-out contract;
10. normal-register paid edit keeps frozen old lines while new lines use current category prices;
11. moving/unmarking a category before checkout naturally makes the new base price authoritative;
12. selected/default order type behavior is unchanged.

- [ ] **Step 2: Enrich only register product maps**

After `fetchCartProducts` and before `applyDatabasePrices`, call `attachRegisterPrices` only when the checkout is not a table settlement and not a table split. This includes fresh register checkout, claimed register hold, and normal-register invoice edit.

Saved-price maps continue to win for historical lines; enrichment only changes current unsaved catalog lines.

- [ ] **Step 3: Keep existing tax/order-type/service-charge flows**

Do not add a price-list request field to checkout. Ignore any forged root ID. Do not change the default-order-type branch, hash requirement, payment validation, service-charge snapshots, or discount permission logic.

- [ ] **Step 4: Verify**

```powershell
npx vitest run backend/tests/integration/checkout.test.js backend/tests/unit/PosCalculator.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/serviceChargeParity.test.js
node --check backend/routes/pos/checkout.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/routes/pos/checkout.js backend/tests/integration/checkout.test.js
git commit -m "feat: enforce category prices at checkout"
```

---

## Task 11: Reprice Held Register Orders at Save, Claim, and Checkout

**Files:**

- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/tests/integration/heldOrders.test.js`
- Modify: `src/components/OrderNotes.vue`

- [ ] **Step 1: Write failing held-order tests**

Cover:

- hold save canonicalizes category effective prices and ignores forged cashier price;
- hold keeps manual order-type/customer/hash/discount metadata unchanged;
- override/base/tax changes after hold are applied at Claim;
- category move/unmark after hold uses the newly applicable current price;
- mixed roots reprice independently;
- modifier surcharge/tax refresh remains correct;
- service-charge snapshot ownership remains unchanged;
- Claim price changes set `pricing_context_changed.prices` and `total`;
- failed Claim leaves held row and snapshot intact;
- final checkout re-resolves again if price changes after Claim;
- table split held rows stay on their frozen table path and never receive category overrides.

- [ ] **Step 2: Enrich register hold save**

After `fetchCartProducts`, attach register prices before the existing forced-cashier `applyDatabasePrices`. Preserve the forced-cashier security rule so a held payload never freezes a manager override.

- [ ] **Step 3: Enrich Claim and actually apply current prices**

After loading current products, keep a hold-time item copy for comparison, attach register prices, and call `applyDatabasePrices` before calculating new totals and returning the cart. Add a `prices` boolean to `pricing_context_changed` when any eligible unit price changed.

- [ ] **Step 4: Update the held-order notice**

In `OrderNotes.vue`, include `.prices` in the existing changed-context toast condition. Reuse `Pricing context changed. Totals updated.` and its current Arabic translation; do not add another modal.

- [ ] **Step 5: Verify**

```powershell
npx vitest run backend/tests/integration/heldOrders.test.js backend/tests/integration/bundle.heldOrders.fire.test.js backend/tests/integration/heldOrders.fireKitchen.test.js
node --check backend/routes/pos/orders.js
npm run build:admin
```

Expected: pass.

- [ ] **Step 6: Commit**

```powershell
git add backend/routes/pos/orders.js backend/tests/integration/heldOrders.test.js src/components/OrderNotes.vue
git commit -m "feat: refresh held order category prices"
```

---

## Task 12: Prove Complete Table Isolation

**Files:**

- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/tests/integration/tableSettlementContext.test.js`
- Modify: `backend/routes/pos/tables.js` only if a test proves an explicit base-only call/comment is required

- [ ] **Step 1: Add overrides to table regression fixtures**

Place a table product under a marked root and create a dramatically different override. Exercise:

- new table add/save;
- leave/reopen/add another item/save;
- guest-check print;
- service-charge recalculation after add/remove;
- saved red table checkout;
- printed blue table checkout;
- split creation and split settlement;
- void/removal and clear-table;
- forged order type, root ID, client price, or register context.

Every table path must use current base/frozen table prices and produce the same service-charge/tax totals as before this feature.

- [ ] **Step 2: Keep tables base-only**

Do not call `attachRegisterPrices` in `tables.js`. If clarity is needed, add one short comment at its `fetchCartProducts`/`applyDatabasePrices` boundary: table orders intentionally use base prices.

- [ ] **Step 3: Verify**

```powershell
npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/integration/bundle.tables.test.js backend/tests/unit/serviceChargeCalculator.test.js
```

Expected: pass, including the saved-table add-again workflow that previously produced service-charge conflicts.

- [ ] **Step 4: Commit**

```powershell
git add backend/tests/integration/tables.test.js backend/tests/integration/tableSettlementContext.test.js backend/routes/pos/tables.js
git commit -m "test: protect tables from category prices"
```

If `tables.js` did not change, omit it from `git add`.

---

## Task 13: Prevent Duplicate-Name Import Misrouting

**Files:**

- Modify: `backend/routes/admin/import.js`
- Modify: `backend/tests/integration/products.test.js`

- [ ] **Step 1: Write failing import ambiguity tests**

Create two categories with the same name under different parents and prove the importer never silently chooses one. Cover:

- optional `category_id`/`categoryid` product column selects an exact existing category;
- invalid category ID returns a row-level error;
- a name resolving to one category still works;
- a name resolving to multiple categories returns an explicit ambiguity error;
- category parent names resolving to multiple categories return an error;
- the transaction rolls back every category/product row on ambiguity.

- [ ] **Step 2: Replace the one-name/one-ID object**

Use `Map<normalizedName, Set<id>>`. Prefer a valid explicit product category ID. Fall back to a name only when its set contains exactly one ID. Do not add full-path import syntax or make the importer another tree-copy system; users copy trees through the dedicated UI.

- [ ] **Step 3: Verify**

```powershell
npx vitest run backend/tests/integration/products.test.js
node --check backend/routes/admin/import.js
```

Expected: pass.

- [ ] **Step 4: Commit**

```powershell
git add backend/routes/admin/import.js backend/tests/integration/products.test.js
git commit -m "fix: reject ambiguous catalog imports"
```

---

## Task 14: Verify Frozen Downstream Documents Without Rewriting Them

**Files:** tests only unless a proven defect appears

- [ ] **Step 1: Run existing downstream suites**

```powershell
npx vitest run backend/tests/integration/productSalesMetrics.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/categoryItemsReport.test.js backend/tests/integration/jofotara.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/unit/receiptPresentationParity.test.js backend/tests/integration/bundle.print.test.js
```

Expected: pass because every downstream consumer reads frozen `order_items` values.

- [ ] **Step 2: Add only one regression fixture if coverage is missing**

Create a completed register order containing:

- one category-price override;
- an 8% tax product;
- a priced modifier;
- a line discount;
- an order discount;
- service charge.

Assert the stored order items, receipt presentation, sales report, and JoFotara XML agree on frozen line values. Do not add price-list joins to any downstream document builder.

- [ ] **Step 3: Commit only if tests changed**

```powershell
git add backend/tests/integration/jofotara.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/unit/receiptPresentationParity.test.js
git commit -m "test: verify category price documents"
```

Omit unchanged files and skip this commit when existing tests already prove the contract.

---

## Task 15: Final Adversarial and Regression Verification

**Files:** all changed files

- [ ] **Step 1: Run focused feature suites**

```powershell
npx vitest run backend/tests/unit/categoryPriceLists.test.js backend/tests/unit/categoryPriceSync.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/unit/helpers.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/integration/categoryPriceLists.test.js backend/tests/integration/categoryCopy.test.js backend/tests/integration/products.test.js backend/tests/integration/bundle.catalog.test.js backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/tableSettlementContext.test.js src/admin/pages/__tests__/inventoryPriceLists.spec.js
```

- [ ] **Step 2: Run the full unit/integration suite and build**

```powershell
npm run test:unit
npm run build:admin
```

Expected: all pass.

- [ ] **Step 3: Run syntax and schema drift checks**

```powershell
node --check backend/services/categoryPriceLists.js
node --check backend/routes/admin/categoryPriceLists.js
node --check backend/routes/admin/products.js
node --check backend/routes/admin/import.js
node --check backend/routes/pos/catalog.js
node --check backend/routes/pos/helpers.js
node --check backend/routes/pos/checkout.js
node --check backend/routes/pos/orders.js
node scripts/validate-schema-drift.js
```

Expected: no syntax or drift errors.

- [ ] **Step 4: Run targeted concurrency/race experiments**

1. Change an override from another admin while an unsaved register cart is open: eligible lines update, manual lines do not.
2. Start a register catalog/resolve request and immediately open a table: late response cannot expose or apply price-list data.
3. Start a table request and immediately close the table: late response cannot hide register categories.
4. Change a root/category assignment between hold and Claim: Claim uses the latest valid price without deleting the held row on failure.
5. Change an override between Claim and checkout: checkout uses the latest price.
6. Save the same 200-row price batch twice: the second is an idempotent no-op with no duplicate audit changes.
7. Copy the same source tree concurrently into one target: each copy gets independent IDs and null SKU/barcode values without collisions.

- [ ] **Step 5: Perform responsive manual review**

Review Inventory categories, Copy modal, Price modal, register category rail, search cards, cart, and table context at:

- 390x844 phone;
- 768x1024 tablet;
- 1024x768 POS touchscreen;
- 1280x800 POS terminal;
- 1440x900 desktop;
- English LTR and Arabic RTL.

Confirm touch controls, scroll containment, modal close warnings, Latin digits, natural translations, and no flicker/stale category rail during context switches.

- [ ] **Step 6: Prove intentionally untouched workflows**

```powershell
git diff master...HEAD -- src/components/pos/CheckoutModal.vue src/admin/pages/Settings.vue backend/routes/admin/printers.js
```

Expected: empty diff.

Also confirm:

- checkout still shows the existing manual order-type selector;
- no `order_type_id`/price-list toggle was added to category pricing;
- no price-list state appears in localStorage/sessionStorage;
- no price-list column appears in orders/order_items/held_orders;
- no table or public-menu request can see a price-list product;
- no report/receipt/JoFotara builder queries current override rows.

- [ ] **Step 7: Review diff and commit final hardening only if needed**

```powershell
git diff --check
git status --short
git diff --stat master...HEAD
git log --oneline master..HEAD
```

If adversarial review required fixes:

```powershell
git add <only-the-files-changed-by-the-fix>
git commit -m "fix: harden category price list workflow"
```

- [ ] **Step 8: Prepare migration handoff, but do not deploy it automatically**

Provide the guarded migration and verifier paths. Import the migration into a client database only after backup and only when explicitly requested; then run the verifier and require zero blocking findings.

---

## Acceptance Checklist

- [ ] No global setting/toggle exists.
- [ ] No order-type binding or automatic order-type selection exists.
- [ ] Checkout modal and its manual order-type controls are unchanged.
- [ ] Ordinary category trees use base prices with no behavioral regression.
- [ ] A top-level category can own a price list; descendants inherit it transactionally.
- [ ] Missing/blank override falls back to normal product price; zero override remains zero.
- [ ] Mixed carts resolve every product from its own tree, with no last-selected-category leakage.
- [ ] Register catalog, search, barcode, hold, Claim, edit, and checkout use authoritative current prices.
- [ ] Manager manual line prices survive live refresh under existing permissions.
- [ ] Paid historical lines remain frozen.
- [ ] Table catalog and every table lifecycle path use base/frozen prices only.
- [ ] Public/QR menu excludes price-list trees.
- [ ] Category copy creates new category/product IDs, null SKU/barcode values, safe stock, printer mappings, and correct bundle links atomically.
- [ ] Copied products remain independent inventory/report identities and never silently synchronize with their source rows.
- [ ] Duplicate category names cannot make spreadsheet import guess the wrong category.
- [ ] Deactivating preserves configuration; unmarking restores ordinary base-price behavior.
- [ ] Override/category/copy mutations invalidate caches and notify terminals only after commit.
- [ ] Price changes are audit logged once per batch and respect `users.xyz`.
- [ ] Taxes, modifiers, discounts, service charge, receipts, reports, and JoFotara remain mathematically consistent.
- [ ] Arabic copy is natural, client data is untranslated, digits remain Latin, and every new UI is responsive/touch-friendly.
- [ ] Full tests, build, syntax checks, schema drift, race experiments, and untouched-file proof pass before merge.
