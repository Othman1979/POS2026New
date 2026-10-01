# Customer Meal Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add register-only customer meal subscriptions where buying a package is a normal paid invoice, while using package credits is a separate, audited, stock-moving, kitchen-printing redemption that never creates revenue, tender, invoice, or order records.

**Architecture:** Keep the existing financial system authoritative for the subscription purchase by representing each plan with one hidden normal product and activating the subscription inside the checkout transaction. Put credit usage in dedicated subscription/redemption tables. A single subscription domain service owns balance, eligibility, expiration, extra-meal reasons, reversal, and purchase-refund rules. Reuse the existing product, tax, checkout, customer, stock, refund, JoFotara, print-queue, permission, business-day, Socket.IO, and i18n boundaries rather than creating parallel versions.

**Tech Stack:** Vue 3 Composition API, Pinia, Express 5, MySQL/MariaDB with `mysql2`, Socket.IO, Vitest, Supertest, Vite, the existing durable multi-spooler print queue, and the existing 80 mm spooler renderer.

## Global Constraints

- Do not create a payment method named `subscription` and do not insert redemptions into `orders`, `order_items`, `refunds`, or `held_orders`.
- Subscription purchase is the only financial event: it uses the normal register checkout, cash/card/split payment, invoice numbering, receipt, tax, discount math, shift reconciliation, and JoFotara flow.
- Redemption never adds revenue or cash/card totals again. It creates an internal redemption reference only, never a public invoice number or POS order number.
- Redemption is register-only. Reject table sessions and table identifiers on both frontend and backend.
- One eligible top-level meal quantity consumes one credit. Quantity `2` consumes two credits. Credits and redemption quantities are positive integers.
- Any eligible meal may be redeemed; there is no one-meal-per-day limit. If the customer has already consumed at least one credit in the current canonical business day, every later redemption in that business day requires a non-empty reason—even when performed by admin/programmer and even across separate requests.
- A paid modifier, drink, or other extra is sold in a separate normal checkout. Redemption accepts zero-price modifiers and notes, but rejects any line whose canonical modifier surcharge is greater than zero.
- The subscription purchase flow uses a dedicated cart: one hidden plan product, quantity `1`, no mixed ordinary items, no hold, no table, and no service charge. Existing line/order discounts may apply; analytics use the actual paid order total.
- Plan changes affect future purchases only. Each customer subscription snapshots its eligible products and credit count at purchase.
- Multiple subscriptions for one customer are allowed. The POS lists usable subscriptions by earliest expiry first and preselects the earliest one; the cashier can choose another usable subscription.
- `starts_on` is inclusive and `ends_on = starts_on + duration_days - 1` is inclusive. Before `starts_on` the subscription is pending; after `ends_on` it is expired.
- Stored terminal states are only `active`, `cancelled`, and `refunded`. `pending`, `completed`, and `expired` are derived from dates and the live redemption balance so they cannot become stale.
- Remaining credits are derived as `total_credits - SUM(active redemption item quantities)`; do not maintain a mutable balance counter.
- A successful redemption must atomically commit the ledger rows, stock deduction, audit row, and durable kitchen print-queue rows. If any real kitchen item has no matching active printer, nothing is consumed.
- Request retries are idempotent: the same client idempotency key returns the original redemption and does not consume stock/credits or print twice.
- Reversing a redemption restores stock, returns credits, requires a reason, and queues one void ticket per originally targeted kitchen printer.
- A subscription purchase invoice can be fully refunded only from Subscription Management, only after all its active redemptions are reversed. Partial package refunds are not supported.
- Generic Orders refund UI and `POST /api/pos/refunds` must refuse subscription purchase invoices and direct the operator to Subscription Management.
- `users.xyz = 1` continues to suppress `audit_events`, but core subscription tables still record operator IDs, reasons, timestamps, and immutable snapshots.
- All operator-facing copy must exist in natural Arabic and English. Render digits as Latin digits and preserve the existing currency formatting.
- Keep the UI touch-friendly (minimum practical target about 44 px), responsive on phones/tablets/1024 px POS terminals, and visually consistent with the existing teal admin/POS design without adding decorative cards or unnecessary icons.
- Do not add recurring jobs, accounting journal tables, an automatic daily allowance, external notification services, or speculative inventory logic in this feature.

---

## Domain Contract

### Financial purchase versus operational redemption

| Event | Normal order/invoice | Cash/card/shift totals | Revenue | Stock | Kitchen ticket | Audit/history |
|---|---:|---:|---:|---:|---:|---:|
| Buy/renew package | Yes | Yes | Yes, once | No package stock | No | Order + subscription purchase |
| Redeem meal credit | No | No | No | Deduct meal stock | Yes, price-free | Redemption ledger |
| Reverse redemption | No | No | No | Restore meal stock | Yes, void ticket | Reversal fields + audit |
| Cancel without refund | No new order | No | No reversal | No automatic change | No | Subscription cancellation |
| Refund purchase | Existing refund machinery | Refund totals | Refund | No package stock | No | Refund + subscription state |

The administration view may show two separate analytics values:

- **Subscription collections / تحصيل الاشتراكات:** actual paid invoice totals for packages in the selected period. This is a subset of normal sales, never added on top of total sales.
- **Allocated redeemed value:** `purchase_order.total × active_redeemed_credits ÷ total_credits`. This is operational/deferred-revenue analysis only and must not alter daily sales or payment reconciliation.

### Derived state and balance

Create one pure helper in `backend/services/SubscriptionService.js` and mirror only display logic on the frontend:

```js
function deriveSubscriptionState({ storedStatus, startsOn, endsOn, remainingCredits, businessDate }) {
  if (storedStatus === 'refunded' || storedStatus === 'cancelled') return storedStatus;
  if (businessDate < startsOn) return 'pending';
  if (remainingCredits <= 0) return 'completed';
  if (businessDate > endsOn) return 'expired';
  return 'active';
}
```

The backend is authoritative. The frontend never decides whether a credit can be spent.

### Public API shapes

Use these stable response shapes so the POS and admin do not consume raw joined SQL rows:

```js
// Plan summary
{
  id, name, net_price, gross_price, tax_rate, included_credits, duration_days,
  is_active, eligible_product_count,
  sale_product: { id, name, price, tax_rate, category_id: null }
}

// Customer subscription summary
{
  id, customer: { id, name, phone }, plan: { id, name },
  purchase_invoice_id, invoice_number, starts_on, ends_on,
  total_credits, used_credits, remaining_credits,
  state, created_at
}

// Successful redemption
{
  success: true,
  redemption: {
    id,
    reference: `S${subscription_id}-${String(id).padStart(2, '0')}`,
    subscription_id,
    credits_used,
    remaining_credits,
    business_date,
    created_at
  },
  print_queued: true
}
```

Return consistent error codes in addition to translated/display messages:

- `SUBSCRIPTION_PERMISSION_REQUIRED`
- `SUBSCRIPTION_REGISTER_ONLY`
- `SUBSCRIPTION_NOT_USABLE`
- `SUBSCRIPTION_INSUFFICIENT_CREDITS`
- `SUBSCRIPTION_EXTRA_MEAL_REASON_REQUIRED`
- `SUBSCRIPTION_PRODUCT_NOT_ELIGIBLE`
- `SUBSCRIPTION_PAID_EXTRA_REQUIRES_CHECKOUT`
- `SUBSCRIPTION_DISCOUNT_NOT_ALLOWED`
- `SUBSCRIPTION_KITCHEN_ROUTE_REQUIRED`
- `SUBSCRIPTION_MANAGED_REFUND`
- `SUBSCRIPTION_ACTIVE_REDEMPTIONS_EXIST`

---

## Task 1: Add the guarded database schema and permission

**Files:**

- Create: `backend/migrations/2026-07-22-customer-meal-subscriptions.sql`
- Create: `backend/migrations/2026-07-22-customer-meal-subscriptions-verify.sql`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`
- Modify: `backend/services/PermissionService.js`
- Modify: `assets/js/composables/usePermissions.js`
- Modify: `backend/tests/integration/permissions.test.js`
- Modify: `backend/tests/unit/permissionService.unit.test.js`

- [ ] **Step 1: Add failing schema-authority and permission tests**

  Extend `backend/tests/unit/schemaAuthority.test.js` so startup rejects each missing subscription table, primary/unique key, required foreign-key count, status check, and `pos.subscriptions` permission. Update the expected authoritative migration name to `2026-07-22-customer-meal-subscriptions-v1`; its checksum must be the SHA-256 of the final shipped migration file using the repository's existing checksum convention.

  Extend permission tests to expect `PERMISSIONS.POS_SUBSCRIPTIONS === 'pos.subscriptions'`, admin/programmer bypass, a denied ungranted cashier, and an allowed granted cashier.

- [ ] **Step 2: Run the new tests and confirm they fail**

  Run:

  ```powershell
  npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/unit/permissionService.unit.test.js backend/tests/integration/permissions.test.js
  ```

  Expected: failures because the migration, schema checks, and permission do not exist.

- [ ] **Step 3: Create the seven-table migration**

  The migration must be phpMyAdmin-safe, guarded with `information_schema` checks in the same style as the current latest migration, and finish by inserting its name/checksum into `schema_migrations` only after all DDL and seed statements succeed.

  Create these structures exactly:

  ```sql
  CREATE TABLE subscription_plans (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sale_product_id INT NOT NULL,
    included_credits SMALLINT UNSIGNED NOT NULL,
    duration_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_subscription_plans_sale_product (sale_product_id),
    KEY idx_subscription_plans_active (is_active, id),
    CONSTRAINT fk_subscription_plans_sale_product FOREIGN KEY (sale_product_id) REFERENCES products(id) ON DELETE RESTRICT,
    CONSTRAINT fk_subscription_plans_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_subscription_plans_credits CHECK (included_credits > 0),
    CONSTRAINT chk_subscription_plans_duration CHECK (duration_days > 0),
    CONSTRAINT chk_subscription_plans_active CHECK (is_active IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

  CREATE TABLE subscription_plan_products (
    plan_id BIGINT UNSIGNED NOT NULL,
    product_id INT NOT NULL,
    PRIMARY KEY (plan_id, product_id),
    KEY idx_subscription_plan_products_product (product_id, plan_id),
    CONSTRAINT fk_subscription_plan_products_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
    CONSTRAINT fk_subscription_plan_products_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

  CREATE TABLE customer_subscriptions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    customer_id INT NOT NULL,
    plan_id BIGINT UNSIGNED NOT NULL,
    purchase_invoice_id INT NOT NULL,
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    total_credits SMALLINT UNSIGNED NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    cancelled_at DATETIME NULL,
    cancelled_by INT NULL,
    cancellation_reason VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_customer_subscriptions_invoice (purchase_invoice_id),
    KEY idx_customer_subscriptions_customer_state (customer_id, status, ends_on, id),
    KEY idx_customer_subscriptions_state_end (status, ends_on, id),
    CONSTRAINT fk_customer_subscriptions_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
    CONSTRAINT fk_customer_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE RESTRICT,
    CONSTRAINT fk_customer_subscriptions_invoice FOREIGN KEY (purchase_invoice_id) REFERENCES orders(invoice_id) ON DELETE RESTRICT,
    CONSTRAINT fk_customer_subscriptions_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_customer_subscriptions_dates CHECK (ends_on >= starts_on),
    CONSTRAINT chk_customer_subscriptions_credits CHECK (total_credits > 0),
    CONSTRAINT chk_customer_subscriptions_status CHECK (status IN ('active','cancelled','refunded'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

  CREATE TABLE customer_subscription_products (
    subscription_id BIGINT UNSIGNED NOT NULL,
    product_id INT NOT NULL,
    PRIMARY KEY (subscription_id, product_id),
    KEY idx_customer_subscription_products_product (product_id, subscription_id),
    CONSTRAINT fk_customer_subscription_products_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id) ON DELETE CASCADE,
    CONSTRAINT fk_customer_subscription_products_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

  CREATE TABLE subscription_extensions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    subscription_id BIGINT UNSIGNED NOT NULL,
    old_ends_on DATE NOT NULL,
    new_ends_on DATE NOT NULL,
    reason VARCHAR(255) NOT NULL,
    extended_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_subscription_extensions_subscription (subscription_id, id),
    CONSTRAINT fk_subscription_extensions_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_subscription_extensions_extended_by FOREIGN KEY (extended_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_subscription_extensions_dates CHECK (new_ends_on > old_ends_on),
    CONSTRAINT chk_subscription_extensions_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

  CREATE TABLE subscription_redemptions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    subscription_id BIGINT UNSIGNED NOT NULL,
    redeemed_by INT NULL,
    shift_id INT NULL,
    business_date DATE NOT NULL,
    additional_meal_reason VARCHAR(255) NULL,
    stock_deducted TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    reversed_at DATETIME NULL,
    reversed_by INT NULL,
    reversal_reason VARCHAR(255) NULL,
    idempotency_key VARCHAR(80) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_subscription_redemptions_idempotency (idempotency_key),
    KEY idx_subscription_redemptions_balance (subscription_id, status, id),
    KEY idx_subscription_redemptions_business_date (business_date, status, id),
    KEY idx_subscription_redemptions_shift (shift_id, business_date, id),
    CONSTRAINT fk_subscription_redemptions_subscription FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_subscription_redemptions_redeemed_by FOREIGN KEY (redeemed_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_subscription_redemptions_shift FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL,
    CONSTRAINT fk_subscription_redemptions_reversed_by FOREIGN KEY (reversed_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_subscription_redemptions_status CHECK (status IN ('active','reversed')),
    CONSTRAINT chk_subscription_redemptions_stock CHECK (stock_deducted IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

  CREATE TABLE subscription_redemption_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    redemption_id BIGINT UNSIGNED NOT NULL,
    product_id INT NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    quantity SMALLINT UNSIGNED NOT NULL,
    note TEXT NULL,
    selected_modifiers LONGTEXT NULL,
    bundle_items LONGTEXT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_subscription_redemption_items_redemption (redemption_id, sort_order, id),
    KEY idx_subscription_redemption_items_product (product_id, redemption_id),
    CONSTRAINT fk_subscription_redemption_items_redemption FOREIGN KEY (redemption_id) REFERENCES subscription_redemptions(id) ON DELETE CASCADE,
    CONSTRAINT fk_subscription_redemption_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    CONSTRAINT chk_subscription_redemption_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_subscription_redemption_items_modifiers_json CHECK (selected_modifiers IS NULL OR JSON_VALID(selected_modifiers)),
    CONSTRAINT chk_subscription_redemption_items_bundle_json CHECK (bundle_items IS NULL OR JSON_VALID(bundle_items))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
  ```

  Seed one permission with natural copy and grant it to existing active cashiers because subscription lookup/sale/redemption is a normal register operation:

  ```sql
  INSERT INTO permissions
    (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
  VALUES
    ('pos.subscriptions', 'Manage Subscriptions', 'إدارة الاشتراكات',
     'Sell subscriptions and redeem customer meals.',
     'بيع الاشتراكات وصرف وجبات العملاء.', 'pos', 98, 1, 1, 0)
  ON DUPLICATE KEY UPDATE
    label=VALUES(label), label_ar=VALUES(label_ar),
    description=VALUES(description), description_ar=VALUES(description_ar),
    category=VALUES(category), sort_order=VALUES(sort_order),
    implemented=1, default_cashier=1, overridable=0;

  INSERT IGNORE INTO user_permissions (user_id, perm_key)
  SELECT id, 'pos.subscriptions'
  FROM users
  WHERE is_active=1 AND role='cashier';
  ```

- [ ] **Step 4: Add a read-only verifier**

  `backend/migrations/2026-07-22-customer-meal-subscriptions-verify.sql` must return named `missing_count` rows for all seven tables, required columns, primary/unique keys, foreign keys, check constraints, the permission catalog row, and the matching migration ledger entry. It must read `information_schema` correctly using `TABLE_SCHEMA = DATABASE()` / `CONSTRAINT_SCHEMA = DATABASE()` and never mutate data.

- [ ] **Step 5: Make the migration the new startup authority**

  Update `backend/services/schemaValidation.js` to require the new tables, indexes, foreign keys, JSON/check constraints, permission, and exact ledger checksum. Remove no existing checks. Keep validation read-only.

  Update `backend/tests/fixtures/seed.js` in dependency order:

  - Drop redemption items, redemptions, extensions, subscription product snapshots, subscriptions, plan products, and plans before `orders`, `products`, `customers`, `shifts`, and `users`.
  - Create plans after `products`; create subscriptions after `orders`; create extensions and redemptions afterward.
  - Seed `pos.subscriptions` and its default cashier grant.
  - Seed the new authoritative `schema_migrations` name/checksum so integration server startup validates the test schema.

- [ ] **Step 6: Add the canonical permission constant**

  Add `POS_SUBSCRIPTIONS: 'pos.subscriptions'` to `backend/services/PermissionService.js`. Ensure `assets/js/composables/usePermissions.js` can consume the catalog-provided key without adding a second hard-coded permission map.

- [ ] **Step 7: Run the focused schema and permission tests**

  ```powershell
  node scripts/validate-schema-drift.js
  npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/unit/permissionService.unit.test.js backend/tests/integration/permissions.test.js
  ```

  Expected: all pass; schema drift confirms dev/test parity after applying the migration to the development database during implementation.

- [ ] **Step 8: Commit the schema boundary**

  ```powershell
  git add backend/migrations/2026-07-22-customer-meal-subscriptions.sql backend/migrations/2026-07-22-customer-meal-subscriptions-verify.sql backend/services/schemaValidation.js backend/tests/fixtures/seed.js backend/tests/unit/schemaAuthority.test.js backend/services/PermissionService.js assets/js/composables/usePermissions.js backend/tests/integration/permissions.test.js backend/tests/unit/permissionService.unit.test.js
  git commit -m "feat: add meal subscription schema"
  ```

---

## Task 2: Build the single subscription domain service

**Files:**

- Create: `backend/services/SubscriptionService.js`
- Create: `backend/tests/unit/subscriptionService.test.js`

- [ ] **Step 1: Write failing pure-domain tests**

  Cover:

  - inclusive `starts_on` and `ends_on` boundaries;
  - pending, active, completed, expired, cancelled, and refunded derived states;
  - remaining credits derived from active redemptions only;
  - earliest-expiry ordering;
  - `ends_on = starts_on + duration_days - 1` across month/year boundaries;
  - extra-meal reason required when `usedToday + requestedCredits > 1`;
  - the first request can itself contain quantity `2`, so it requires a reason;
  - whitespace-only reasons are rejected and trimmed reasons are capped at 255 characters;
  - integer-only credit quantities.

- [ ] **Step 2: Run the unit test and confirm it fails**

  ```powershell
  npx vitest run backend/tests/unit/subscriptionService.test.js
  ```

- [ ] **Step 3: Implement `SubscriptionService.js` as the only subscription rule owner**

  Export these focused functions; keep HTTP response handling out of this service:

  ```js
  module.exports = {
    addCalendarDays,
    deriveSubscriptionState,
    normalizeReason,
    loadPlanForUpdate,
    loadSubscriptionSummary,
    listUsableSubscriptionsForCustomer,
    assertSubscriptionUsable,
    assertAdditionalMealReason,
    createSubscriptionFromPaidOrder,
    calculateSubscriptionMetrics,
  };
  ```

  `loadSubscriptionSummary(executor, subscriptionId, { lock = false, businessDate })` must run one bounded aggregate query joining plan/product/customer/order and summing active redemption item quantities. When `lock=true`, lock the `customer_subscriptions` row first with `SELECT ... FOR UPDATE`, then run the aggregate query; do not rely on `FOR UPDATE` over a grouped join.

  `createSubscriptionFromPaidOrder` must:

  1. lock and validate the active plan and its hidden sale product;
  2. require a real `customer_id` and paid `invoice_id`;
  3. insert exactly once using the unique `purchase_invoice_id`;
  4. snapshot `included_credits` and `starts_on`/`ends_on`;
  5. copy the current `subscription_plan_products` rows into `customer_subscription_products`;
  6. fail if the plan has no eligible products;
  7. append `subscription_purchased` using the caller's transaction and existing `appendAuditEvent`.

  Keep all money out of this service except metrics read from the authoritative purchase order.

- [ ] **Step 4: Run the unit tests**

  ```powershell
  npx vitest run backend/tests/unit/subscriptionService.test.js
  ```

- [ ] **Step 5: Commit the domain rules**

  ```powershell
  git add backend/services/SubscriptionService.js backend/tests/unit/subscriptionService.test.js
  git commit -m "feat: centralize subscription rules"
  ```

---

## Task 3: Add admin plan management with hidden checkout products

**Files:**

- Create: `backend/routes/admin/subscriptions.js`
- Modify: `backend/routes/admin.js`
- Modify: `backend/routes/admin/products.js`
- Modify: `backend/routes/pos/catalog.js`
- Create: `backend/tests/integration/subscriptionPlans.test.js`
- Modify: `backend/tests/integration/products.test.js`

- [ ] **Step 1: Write failing plan-management and catalog tests**

  Test the following API contract:

  - `GET /api/admin/subscription-plans?include_inactive=1`
  - `POST /api/admin/subscription-plans`
  - `PUT /api/admin/subscription-plans/:id`

  Request body:

  ```json
  {
    "name": "30 Meal Plan",
    "gross_price": 90,
    "tax_rate": 8,
    "included_credits": 30,
    "duration_days": 30,
    "is_active": true,
    "product_ids": [1, 4]
  }
  ```

  Assert that create/update rejects blank or over-100-character names, non-positive gross price/credits/duration, tax outside `0..100`, values beyond their database ranges, missing/inactive products, another plan's hidden sale product, duplicate product IDs, and empty eligibility. Assert that ordinary products and the POS catalog never return plan-owned sale products.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run backend/tests/integration/subscriptionPlans.test.js backend/tests/integration/products.test.js
  ```

- [ ] **Step 3: Implement one transaction per plan mutation**

  Mount `backend/routes/admin/subscriptions.js` from `backend/routes/admin.js`. Admin middleware already protects it.

  On create:

  - convert the supplied gross price to the product's stored net price using `grossToNet` from `backend/services/categoryPriceLists.js`;
  - insert a hidden normal product with `category_id=NULL`, `barcode=NULL`, `sku=NULL`, `stock=NULL`, `is_bundle=0`, `is_active` matching the plan, and no modifiers;
  - insert the plan and eligible product rows;
  - append `subscription_plan_created` in the same transaction.

  On update:

  - lock the plan and owned product;
  - update the product name/net price/tax and the plan credit/duration/active fields;
  - when the net price changes, insert the same `price_history` row used by ordinary product edits;
  - replace eligibility rows in the same transaction;
  - append `subscription_plan_updated` with old/new summary.

  Do not support hard delete. Inactivation preserves existing subscription history.

- [ ] **Step 4: Hide plan-owned products everywhere ordinary inventory/catalog products are listed**

  Add this exclusion to the POS catalog/search/barcode queries in `backend/routes/pos/catalog.js` and ordinary Inventory list/stat queries in `backend/routes/admin/products.js`:

  ```sql
  AND NOT EXISTS (
    SELECT 1 FROM subscription_plans sp WHERE sp.sale_product_id = p.id
  )
  ```

  In ordinary product update/delete endpoints, return `409` if the product is owned by a plan, with instructions to edit it from Subscription Plans. Do not add a generic `product_type` column.

- [ ] **Step 5: Run the plan and product tests**

  ```powershell
  npx vitest run backend/tests/integration/subscriptionPlans.test.js backend/tests/integration/products.test.js backend/tests/integration/bundle.catalog.test.js
  ```

- [ ] **Step 6: Commit plan management**

  ```powershell
  git add backend/routes/admin/subscriptions.js backend/routes/admin.js backend/routes/admin/products.js backend/routes/pos/catalog.js backend/tests/integration/subscriptionPlans.test.js backend/tests/integration/products.test.js
  git commit -m "feat: manage subscription plans"
  ```

---

## Task 4: Activate a subscription through the existing paid checkout

**Files:**

- Modify: `backend/routes/pos/checkout.js`
- Modify: `assets/js/composables/stores/orderUiStore.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `assets/js/composables/useCart.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Create: `backend/tests/integration/subscriptionPurchase.test.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `backend/tests/unit/orderUiStore.test.js`

- [ ] **Step 1: Write failing purchase tests**

  Add integration cases proving:

  - a normal cash/card/split checkout containing exactly the selected active plan product creates one order, one customer subscription, and the eligibility snapshot;
  - receipt/invoice numbers, tax, discounts, shift totals, and JoFotara eligibility remain normal;
  - the activation reuses the customer upsert result from checkout;
  - duplicate checkout idempotency creates one order and one subscription;
  - mixed plan + ordinary products, quantity other than `1`, table context, unpaid/voided payment, service charge, and an inactive/mismatched plan are rejected;
  - a checkout rollback leaves neither order nor subscription;
  - a plain checkout with no subscription payload behaves exactly as before.

  Add store tests proving pending subscription-sale state resets on successful checkout/logout/session reset and survives validation failures without leaking into a later normal checkout.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/checkout.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderUiStore.test.js
  ```

- [ ] **Step 3: Add minimal checkout metadata**

  Add one nullable client-side state object:

  ```js
  pendingSubscriptionSale = {
    plan_id,
    starts_on,
  };
  ```

  Include it in the checkout body as `subscription_purchase` only for a register sale. Reuse existing `customer_name`, `customer_phone`, and `customer_address`; require at least valid phone and name before opening checkout for a subscription purchase.

  Disable Hold and table navigation while this state is present. Reset it only on successful checkout or an explicit Cancel Subscription Sale action; do not clear it on a failed payment request.

- [ ] **Step 4: Validate and activate inside the existing checkout transaction**

  In `backend/routes/pos/checkout.js`, after canonical cart pricing and customer upsert but before commit:

  - if `subscription_purchase` is absent, execute the unchanged normal path;
  - if present, require register context, paid payment method, exactly one top-level plan sale product with quantity `1`, no service-charge line, and matching active plan;
  - use the already resolved server-side product price/tax and normal checkout math—never trust plan price from the browser;
  - insert the order/order items as today;
  - call `createSubscriptionFromPaidOrder(conn, ...)` with the inserted invoice and resolved `customer_id`;
  - return `subscription_id` in the checkout response;
  - emit `subscription_changed` after commit.

  Do not put plan activation after commit; an invoice without its promised credits is not an acceptable partial success.

- [ ] **Step 5: Run purchase and normal-checkout regressions**

  ```powershell
  npx vitest run backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/checkout.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/shift.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderUiStore.test.js
  ```

- [ ] **Step 6: Commit checkout activation**

  ```powershell
  git add backend/routes/pos/checkout.js assets/js/composables/stores/orderUiStore.js assets/js/composables/stores/orderSessionStore.js assets/js/composables/useCart.js backend/tests/integration/checkout.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderUiStore.test.js
  git commit -m "feat: sell subscriptions through checkout"
  ```

---

## Task 5: Make kitchen routing transaction-aware and reusable

**Files:**

- Create: `backend/services/kitchenPrintRouting.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/services/printDispatch.js`
- Modify: `backend/services/HeldOrderKitchenDispatch.js`
- Create: `backend/tests/unit/kitchenPrintRouting.test.js`
- Modify: `backend/tests/unit/print.unit.test.js`
- Modify: `backend/tests/unit/printDispatchOwnership.test.js`
- Modify: `backend/tests/unit/heldOrderKitchenDispatch.test.js`

- [ ] **Step 1: Write failing extraction and transaction tests**

  Pin the existing behavior before moving code:

  - the same normal item/category/bundle input produces the same kitchen payloads and printer routing;
  - one item routed to two category printers creates exactly two payloads;
  - unmatched items produce an empty payload list;
  - `enqueuePrintJobs(conn, payloads)` uses the supplied executor rather than the global pool;
  - the unique print idempotency key makes a retry return the existing row;
  - `enqueueAndProcessJobs` still enqueues then dispatches ordinary prints;
  - held-order and existing print endpoints keep their prior payload contract.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run backend/tests/unit/kitchenPrintRouting.test.js backend/tests/unit/print.unit.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/heldOrderKitchenDispatch.test.js
  ```

- [ ] **Step 3: Extract only kitchen payload construction**

  Move printer/category selection and payload assembly from `printKitchenOrder` in `backend/routes/print.js` into:

  ```js
  async function buildKitchenPrintPayloads(executor, data) {
    // query active kitchen printers/category mappings through executor
    // normalize routeable items with the existing kitchenTicketItems service
    // return { payloads, unroutedItems }; do not insert queue rows or dispatch sockets
  }
  ```

  `unroutedItems` contains the real kitchen lines (bundle parents already expanded) that matched no active kitchen printer. Keep sanitization, category matching, bundle-component behavior, language, printer ownership fields, and `print_batch_id` semantics identical. `printKitchenOrder(io, data)` becomes a compatibility wrapper: build using the global pool, enqueue/dispatch the returned payloads, and return payload count. Existing callers preserve their current behavior; subscription redemption alone requires `unroutedItems.length === 0`.

- [ ] **Step 4: Split durable enqueue from best-effort dispatch**

  Refactor `backend/services/printDispatch.js` to export:

  ```js
  async function enqueuePrintJobs(executor, payloads) {
    // buildPrintJobRecord + INSERT ... ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)
    // return queue identifiers / count; never emit sockets
  }

  async function enqueueAndProcessJobs(io, payloads) {
    await enqueuePrintJobs(pool, payloads);
    await dispatchClaimedPrintJobs(io, Math.max(10, payloads.length));
  }
  ```

  The new function is intentionally small. Do not build a new print abstraction or change spooler ownership.

- [ ] **Step 5: Use the extracted boundary from existing callers**

  Make `backend/routes/print.js` and `backend/services/HeldOrderKitchenDispatch.js` call the extracted functions without changing their public behavior. This proves the extraction before subscriptions depend on it.

- [ ] **Step 6: Run all focused print regressions**

  ```powershell
  npx vitest run backend/tests/unit/kitchenPrintRouting.test.js backend/tests/unit/print.unit.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/heldOrderKitchenDispatch.test.js backend/tests/integration/bundle.print.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/printQueue.test.js
  ```

- [ ] **Step 7: Commit the reusable print boundary**

  ```powershell
  git add backend/services/kitchenPrintRouting.js backend/routes/print.js backend/services/printDispatch.js backend/services/HeldOrderKitchenDispatch.js backend/tests/unit/kitchenPrintRouting.test.js backend/tests/unit/print.unit.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/heldOrderKitchenDispatch.test.js
  git commit -m "refactor: share transactional kitchen routing"
  ```

---

## Task 6: Implement the register-only redemption API

**Files:**

- Create: `backend/routes/pos/subscriptions.js`
- Modify: `backend/routes/pos.js`
- Modify: `backend/routes/pos/helpers.js`
- Modify: `backend/services/SubscriptionService.js`
- Create: `backend/tests/integration/subscriptionRedemptions.test.js`
- Modify: `backend/tests/unit/subscriptionService.test.js`

- [ ] **Step 1: Write failing redemption integration tests**

  Create fixture helpers that buy a package through the real checkout endpoint and then cover all of these cases:

  1. cashier without `pos.subscriptions` receives `403`; granted cashier/admin/programmer succeeds;
  2. an open shift is required for a cashier redemption;
  3. lookup by exact customer phone returns only that customer's pending/usable/recent subscriptions, sorted by usable first then earliest expiry;
  4. a valid eligible item consumes one credit, deducts stock once, writes snapshots, writes audit, and queues one job for each matching kitchen printer;
  5. successful response contains an internal `S<subscription>-<redemption>` reference but creates no `orders`, `order_items`, `refunds`, `invoice_sequences`, or `daily_sequences` rows;
  6. request with `table_id`, active table context marker, custom line, line/order discount, service charge, decimal/zero quantity, inactive product, ineligible product, expired/pending/cancelled/refunded/completed subscription, or insufficient credits is rejected without state change;
  7. zero-price modifiers and notes survive in the redemption snapshot and kitchen payload;
  8. a canonical positive modifier surcharge—even if the browser sends zero—returns `SUBSCRIPTION_PAID_EXTRA_REQUIRES_CHECKOUT` without consuming a credit;
  9. a bundle is validated/canonicalized using the existing bundle service, uses the top-level product for eligibility, preserves bundle components for the ticket, and follows existing stock behavior;
  10. first credit in a business day requires no reason; a two-credit first request and every later request that day require a reason; crossing the configured business-day boundary resets the reason rule;
  11. two simultaneous last-credit requests produce one success and one `409`, never a negative balance;
  12. the same idempotency key repeated sequentially or concurrently returns one redemption, one stock deduction, and one print job per printer;
  13. no matching kitchen printer returns `422 SUBSCRIPTION_KITCHEN_ROUTE_REQUIRED` and rolls back ledger, stock, and audit;
  14. injected queue insert failure rolls back ledger, stock, and audit;
  15. an `xyz=1` operator suppresses `audit_events` but the redemption row still records `redeemed_by`, business date, reason, and time;
  16. a normal checkout immediately after redemption remains unchanged.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run backend/tests/integration/subscriptionRedemptions.test.js backend/tests/unit/subscriptionService.test.js
  ```

- [ ] **Step 3: Add a symmetric stock-restoration helper without changing current callers**

  Keep `deductStockForCart` as the canonical deduction. Add a small `restoreStockForCart(conn, cartItems)` beside it in `backend/routes/pos/helpers.js` that aggregates top-level product quantities and adds them back only where `products.stock IS NOT NULL`. Reuse it later for redemption reversal. Do not alter bundle inventory semantics in this feature.

- [ ] **Step 4: Add POS subscription endpoints**

  Mount `backend/routes/pos/subscriptions.js` from `backend/routes/pos.js` with:

  ```text
  GET  /api/pos/subscription-plans
  GET  /api/pos/customer-subscriptions?phone=<exact phone>
  POST /api/pos/subscription-redemptions
  ```

  All endpoints require authentication and `PERMISSIONS.POS_SUBSCRIPTIONS`; admin/programmer bypass through `userHas`. Plan lookup returns active plan summaries for sale. Customer lookup requires a normalized exact phone and returns no broad customer directory to cashiers.

  Redemption request:

  ```json
  {
    "subscription_id": 245,
    "idempotency_key": "client-generated-uuid-or-stable-key",
    "additional_meal_reason": "Family collected two meals",
    "items": [
      {
        "product_id": 1,
        "qty": 2,
        "note": "No onion",
        "selected_modifiers": [],
        "bundle_items": []
      }
    ]
  }
  ```

- [ ] **Step 5: Implement one atomic redemption transaction**

  Use this exact order:

  1. start transaction;
  2. if the idempotency key exists, load and return its completed result after rollback/release without repeating work;
  3. require the user's own open shift for attribution, but do not add any tender row;
  4. read the subscription's `customer_id`, then lock that `customers` row first with `FOR UPDATE`; this serializes the same-business-day reason rule even when two concurrent requests target two different subscriptions for the same customer;
  5. lock the `customer_subscriptions` row with `FOR UPDATE` (all subscription mutations use customer-then-subscription lock order where both are needed);
  6. load `getBusinessDate(now)` and live active-redemption totals;
  7. derive/validate state and available credits;
  8. load frozen eligible product IDs;
  9. canonicalize all products, bundles, and modifiers from database records using the existing checkout/bundle helpers—never trust names, prices, tax, surcharge, or category IDs from the request;
  10. reject discounts, service charge, custom items, non-integers, ineligible items, and paid modifiers;
  11. sum requested credits and enforce the cross-request current-business-day reason rule across all subscriptions belonging to the locked customer;
  12. insert `subscription_redemptions`, including `shift_id` and whether stock was deducted, plus snapshot rows;
  13. when `stock_enabled=1`, call `deductStockForCart(conn, canonicalItems)` and persist `stock_deducted=1`; otherwise persist `0`;
  14. build the kitchen print plan using `buildKitchenPrintPayloads(conn, ...)` with `print_batch_id = subscription-redemption-<id>`, `invoice_id=''`, `order_id=''`, `order_type_name='Subscription Meal'`, customer display data, and price-free items;
  15. require at least one payload **and zero unrouted kitchen items**, then call `enqueuePrintJobs(conn, payloads)`;
  16. append `subscription_redeemed` or `subscription_extra_meal_redeemed` through the same `conn`;
  17. commit;
  18. emit `subscription_changed` and `inventory_changed` with IDs only;
  19. call `dispatchClaimedPrintJobs(req.io)` inside a post-commit `try/catch`; log dispatch failure and still return success because the durable jobs remain pending.

  Treat duplicate-key races on `idempotency_key` as a successful retry: roll back the losing transaction, load the existing redemption, and return it.

- [ ] **Step 6: Run redemption and surrounding regressions**

  ```powershell
  npx vitest run backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/checkout.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/printQueue.test.js backend/tests/integration/shift.test.js backend/tests/unit/subscriptionService.test.js
  ```

- [ ] **Step 7: Commit redemption backend**

  ```powershell
  git add backend/routes/pos/subscriptions.js backend/routes/pos.js backend/routes/pos/helpers.js backend/services/SubscriptionService.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/unit/subscriptionService.test.js
  git commit -m "feat: redeem subscription meals"
  ```

---

## Task 7: Render price-free subscription and reversal kitchen tickets

**Files:**

- Modify: `pos-spooler-printer/server.js`
- Modify: `pos-spooler-printer/tests/report-html.test.js`
- Modify: `backend/services/kitchenPrintRouting.js`
- Modify: `backend/tests/unit/kitchenPrintRouting.test.js`

- [ ] **Step 1: Write failing spooler HTML tests**

  Use a representative `print_type: 'kitchen'` payload carrying `data.subscription_redemption` and assert:

  - Arabic ticket title `وجبة اشتراك` and English fallback `SUBSCRIPTION MEAL`;
  - customer name/phone, internal redemption reference, date/time, items, notes, zero-price modifiers, and bundle components render;
  - no invoice number, order number, subtotal, tax, total, tender, remaining credit balance, or item price renders;
  - a reversal payload renders `تم إلغاء وجبة الاشتراك` / `SUBSCRIPTION MEAL VOID` visibly above the exact reversed items;
  - HTML remains valid for 80 mm rendering and no unescaped user content appears.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run pos-spooler-printer/tests/report-html.test.js
  ```

- [ ] **Step 3: Add an optional subscription presentation branch to the existing kitchen renderer**

  Do not create a new spooler protocol or print type. Keep `print_type='kitchen'` so existing printer routing and ownership work. Add only an optional data shape:

  ```js
  data.subscription_redemption = {
    reference,
    customer_name,
    customer_phone,
    is_void: false,
  };
  ```

  The renderer selects the subscription title/identity when this object exists; ordinary table/register/held kitchen tickets remain byte-for-byte equivalent where practical.

- [ ] **Step 4: Run spooler and routing tests**

  ```powershell
  npx vitest run pos-spooler-printer/tests/report-html.test.js backend/tests/unit/kitchenPrintRouting.test.js backend/tests/integration/bundle.print.test.js
  node --check pos-spooler-printer/server.js
  ```

- [ ] **Step 5: Commit ticket rendering**

  ```powershell
  git add pos-spooler-printer/server.js pos-spooler-printer/tests/report-html.test.js backend/services/kitchenPrintRouting.js backend/tests/unit/kitchenPrintRouting.test.js
  git commit -m "feat: print subscription meal tickets"
  ```

---

## Task 8: Add redemption reversal, extension, cancellation, and managed full refund

**Files:**

- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `backend/services/SubscriptionService.js`
- Create: `backend/services/RefundService.js`
- Modify: `backend/routes/pos/refunds.js`
- Create: `backend/tests/integration/subscriptionManagement.test.js`
- Modify: `backend/tests/integration/refunds.test.js`
- Modify: `backend/tests/integration/jofotara.test.js`

- [ ] **Step 1: Write failing management tests**

  Cover:

  - extension changes only `ends_on`, requires a future-or-current valid date and mandatory reason, and records admin/operator/time;
  - cancellation requires a reason, stores `cancelled` state, does not refund money, and makes credits unusable;
  - reversal requires a reason, is one-time/idempotent, restores exact tracked stock, returns credits, and queues one kitchen void ticket per original printer;
  - reversal of an already reversed redemption returns the existing state without double stock restoration or print;
  - full refund is denied while any active redemption exists;
  - after reversing all redemptions, full refund reuses the normal refund calculation, creates the expected `refunds`/`refund_items`, updates `orders.refund_status`, marks the subscription `refunded`, and exposes the normal JoFotara return action when relevant;
  - partial package refund/item selection is rejected;
  - generic `/api/pos/refunds` rejects a subscription purchase invoice even for admin with `409 SUBSCRIPTION_MANAGED_REFUND`;
  - ordinary refunds still behave exactly as before;
  - all reason/operator fields remain in core tables for an `xyz=1` actor while `audit_events` stays suppressed.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/refunds.test.js backend/tests/integration/jofotara.test.js
  ```

- [ ] **Step 3: Extract the paid-refund transaction core once**

  Move the existing paid-order refund calculation and writes from `backend/routes/pos/refunds.js` into `backend/services/RefundService.js` without altering its math. The service accepts an existing transaction executor and explicit actor/request context. The route continues to validate HTTP intent/permission and calls the service. Do not duplicate refund math in subscriptions.

  Add an early protected check in the generic refund route:

  ```sql
  SELECT id FROM customer_subscriptions WHERE purchase_invoice_id = ? LIMIT 1
  ```

  If found, return `409`/`SUBSCRIPTION_MANAGED_REFUND`. Only `SubscriptionService.refundPurchase` calls the extracted service with the internal subscription-management flag.

- [ ] **Step 4: Add admin management endpoints**

  ```text
  GET  /api/admin/subscriptions
  GET  /api/admin/subscriptions/:id
  POST /api/admin/subscriptions/:id/extend
  POST /api/admin/subscriptions/:id/cancel
  POST /api/admin/subscriptions/:id/redemptions/:redemptionId/reverse
  POST /api/admin/subscriptions/:id/refund
  ```

  List supports `search`, `state`, `plan_id`, `start_date`, `end_date`, `page`, and bounded `limit`. Detail returns purchase invoice, customer, plan, eligibility snapshot, live balance/state, redemption history, refund row, and JoFotara document state.

  Every mutation locks the subscription row. Reversal also locks its redemption and uses `restoreStockForCart` when stock tracking was enabled for the operation. Queue the reversal kitchen ticket in the same transaction with `print_batch_id=subscription-redemption-void-<redemptionId>` and `subscription_redemption.is_void=true`.

  Lifecycle rules are explicit: extension is allowed for stored `active` subscriptions with remaining credits (including derived pending/active/expired states) and must move `ends_on` later; cancellation is allowed only from stored `active`; reversal remains allowed after cancellation so administrators can prepare a refund; full refund is allowed from stored `active` or `cancelled` after all redemptions are reversed; `refunded` is terminal.

  Extension updates `customer_subscriptions.ends_on` and inserts an immutable `subscription_extensions` row in the same transaction. Detail history reads this table even when the acting user has `xyz=1`; `audit_events` is an additional system audit, not the only record of the extension.

  For reversal routing, do not recalculate category/printer mappings that may have changed since the original meal. Load the original kitchen `print_queue` payloads whose JSON `data.print_batch_id` equals `subscription-redemption-<redemptionId>`, copy their exact printer identity and item scope, set the new void title/flag and `print_batch_id=subscription-redemption-void-<redemptionId>`, then enqueue them idempotently. If the original durable jobs cannot be found, reject with a clear conflict and do not restore credit/stock; an admin must resolve the print history first.

  Full refund is one transaction: verify zero active redemption quantities, call the shared refund service for the entire plan purchase line, then mark the subscription `refunded`. Accept the existing valid `refund_method` values and require a reason.

- [ ] **Step 5: Keep JoFotara return behavior shared**

  Do not create a second JoFotara return endpoint. Return `refund_id` from the subscription refund, and let the admin UI call the existing `POST /api/admin/jofotara/refunds/:refundId/submit` action only when the original JoFotara invoice is accepted and no return document exists.

- [ ] **Step 6: Run management/refund regressions**

  ```powershell
  npx vitest run backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/refunds.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/reportsRefunds.test.js backend/tests/integration/businessDayReconciliation.test.js
  ```

- [ ] **Step 7: Commit management backend**

  ```powershell
  git add backend/routes/admin/subscriptions.js backend/services/SubscriptionService.js backend/services/RefundService.js backend/routes/pos/refunds.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/refunds.test.js backend/tests/integration/jofotara.test.js
  git commit -m "feat: manage subscription lifecycle"
  ```

---

## Task 9: Add the POS subscription workflow without changing the normal cashier flow

**Files:**

- Create: `src/components/pos/SubscriptionModal.vue`
- Create: `src/components/pos/__tests__/subscriptionModal.spec.js`
- Modify: `src/components/PosTerminal.vue`
- Modify: `assets/js/composables/stores/orderUiStore.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `assets/js/composables/useCart.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Create: `src/components/__tests__/posSubscriptionWiring.spec.js`

- [ ] **Step 1: Write failing component/store/wiring tests**

  Follow the repository's existing static SFC contract tests plus Pinia store unit tests; do not add Vue Test Utils or another frontend test dependency.

  Test these states without requiring a browser screenshot:

  - More modal shows `Subscriptions / الاشتراكات` only for register sessions with `pos.subscriptions`; admin/programmer bypass; it never appears inside a table;
  - one modal has three compact modes: customer lookup, subscription detail/redeem, and sell/renew;
  - exact-phone search handles loading, no customer, no subscription, expired, completed, pending, and multiple usable subscriptions;
  - earliest-expiring usable subscription is selected by default but another can be selected;
  - Sell requires an empty cart and customer name/phone, then adds the hidden plan product through a dedicated store action and opens the normal checkout modal;
  - current-cart Redeem requires a non-empty cart, never opens Checkout, asks for a reason only after the backend returns `SUBSCRIPTION_EXTRA_MEAL_REASON_REQUIRED`, and retries with the same idempotency key;
  - successful redemption clears the cart once and shows reference/remaining credits; failed redemption keeps the cart unchanged;
  - pending sale/redemption request state resets on logout and cannot leak to table mode or the next normal checkout;
  - rapid customer searches ignore stale responses and modal close invalidates pending requests.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run src/components/pos/__tests__/subscriptionModal.spec.js src/components/__tests__/posSubscriptionWiring.spec.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderUiStore.test.js
  ```

- [ ] **Step 3: Add one compact More-modal entry**

  In `src/components/PosTerminal.vue`, add a text-first `Subscriptions` action beside existing operational More actions. Use `can('pos.subscriptions') && !activeTable`. Do not add a persistent navbar button or alter product-grid/category space.

- [ ] **Step 4: Implement the modal as an operational workspace**

  `SubscriptionModal.vue` must use one contained responsive dialog:

  1. **Find customer:** exact phone input, search action, and existing customer details when found.
  2. **Redeem current cart:** show selected subscription, remaining meals, expiry, and a compact list of current cart meal quantities. The backend remains authoritative for eligibility. If paid extras are rejected, copy says naturally: `ادفع الإضافات بسلة منفصلة ثم اصرف الوجبة` / `Pay extras in a separate sale, then redeem the meal.`
  3. **Sell/Renew:** select plan and start date. Default a new purchase to the current business date. If the customer has a current/future subscription, show a simple choice between `Start today` and `Start after current subscription`; the latter uses the day after the latest `ends_on`.

  The plan API supplies both the hidden sale-product shape and display gross price. `beginSubscriptionSale` adds that server-returned product shape to the cart; it must not recreate net price or tax math in the component.

  For 1024 px POS screens, keep the dialog below `90dvh` with one internal content scroller and a fixed action footer. On phones, use full-width stacked fields. Avoid nested modals except the existing global prompt for the additional-meal reason if that is already the system convention.

- [ ] **Step 5: Use existing cart construction for meal selection**

  Do not create a second product browser. The cashier selects meals and zero-price modifiers in the normal product grid/cart, then opens More → Subscriptions → Redeem. Add store actions only for:

  ```js
  beginSubscriptionSale({ plan, customer, startsOn })
  redeemCurrentCart({ subscriptionId, reason, idempotencyKey })
  cancelSubscriptionSale()
  ```

  `redeemCurrentCart` sends a fresh plain-object snapshot of cart items, never reactive proxies. Keep the same idempotency key when retrying because the backend requested a reason or the network response was uncertain. Generate a new key only after an explicit new redemption attempt.

- [ ] **Step 6: Add real-time refresh without global reloads**

  In `PosTerminal.vue`, register one named `subscription_changed` socket handler on mount and remove that exact handler on unmount. Only refresh the modal's selected customer if the modal is open and the event customer ID matches. Reuse the existing `inventory_changed` refresh for stock; do not reload the full POS on every subscription event.

- [ ] **Step 7: Run focused POS tests and build**

  ```powershell
  npx vitest run src/components/pos/__tests__/subscriptionModal.spec.js src/components/__tests__/posSubscriptionWiring.spec.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderUiStore.test.js src/components/__tests__/categoryPricePosWiring.spec.js
  npm run build:admin
  ```

- [ ] **Step 8: Commit the POS workflow**

  ```powershell
  git add src/components/pos/SubscriptionModal.vue src/components/pos/__tests__/subscriptionModal.spec.js src/components/PosTerminal.vue assets/js/composables/stores/orderUiStore.js assets/js/composables/stores/orderSessionStore.js assets/js/composables/useCart.js backend/tests/unit/orderSessionStore.test.js src/components/__tests__/posSubscriptionWiring.spec.js
  git commit -m "feat: add POS subscription workflow"
  ```

---

## Task 10: Add the admin Subscription Management page

**Files:**

- Create: `src/admin/pages/Subscriptions.vue`
- Create: `src/admin/components/SubscriptionPlanModal.vue`
- Create: `src/admin/components/SubscriptionDetailDrawer.vue`
- Create: `src/admin/pages/__tests__/subscriptionsPage.spec.js`
- Modify: `src/admin/pageRegistry.js`
- Modify: `src/admin/App.vue`
- Modify: `src/admin/components/Sidebar.vue`
- Modify: `src/admin/pages/Customers.vue`

- [ ] **Step 1: Write failing admin-page structure and behavior tests**

  Follow the existing admin-page source-contract test style and exercise request/state behavior through extracted plain functions only where necessary; do not add a component-testing dependency.

  Assert:

  - `/admin/subscriptions` resolves and appears once under Management near Customers;
  - direct refresh keeps the page/title/navigation active;
  - the page has exactly three useful sections: Overview, Subscriptions, Plans;
  - URL query `customer_id` prefilters from a Customers row action;
  - list filters are one clean row on desktop and a controlled filter drawer/stack on small screens;
  - stale list/detail requests cannot overwrite newer filters or a newly selected record;
  - plan modal validates all required values and selected eligible products;
  - subscription detail exposes Extend, Cancel, Reverse redemption, Full refund, and JoFotara return only when each action is valid;
  - completed/expired state is derived from API response, not mutated locally;
  - all destructive actions require an explicit reason and confirmation.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run src/admin/pages/__tests__/subscriptionsPage.spec.js
  ```

- [ ] **Step 3: Wire the route and navigation**

  Add `subscriptions` to `src/admin/pageRegistry.js`; the existing flat-page router generates `/subscriptions` automatically. Add title mapping in `src/admin/App.vue` and one Management navigation entry in `src/admin/components/Sidebar.vue`. Use the existing admin shell and data-grid styling; do not create a separate layout.

  Add a `Manage subscriptions` row action in `src/admin/pages/Customers.vue` that navigates to `/admin/subscriptions?customer_id=<id>`.

- [ ] **Step 4: Build the page with operational density**

  - **Overview:** four compact metrics only—active subscriptions, today's redeemed credits, expiring in 7 days, and collections in the selected period.
  - **Subscriptions:** Windows/SaaS-style data grid with customer, plan, start/end, used/total, derived state, purchase invoice, and one More menu. Search covers name/phone/invoice. Filters: state, plan, date range.
  - **Plans:** compact grid with plan name, gross price, credits, duration, eligible product count, active state, and Add/Edit action.
  - **Detail drawer:** customer/plan header, balance and dates, purchase invoice link, chronological redemption history, refund/JoFotara state, and guarded management actions.

  Do not add charts in v1. Use existing teal accents, modest radii, tabular Latin digits, existing `formatCurrency`, and 44 px practical touch targets. At phone widths, rows become readable cards or horizontally scroll within a clearly bounded grid; actions remain reachable without hover.

- [ ] **Step 5: Prevent stale Vue state**

  Use Composition API refs/computed declared before template use. Give list fetch and detail fetch separate request sequence counters/AbortControllers. Reset detail/action errors when selection changes. Keep only one `onMounted` and one `onUnmounted` subscription registration per event. Never mutate props or store derived state in duplicate refs.

- [ ] **Step 6: Run admin page tests and build**

  ```powershell
  npx vitest run src/admin/pages/__tests__/subscriptionsPage.spec.js src/admin/pages/__tests__/ordersOverlayState.spec.js src/admin/pages/__tests__/ordersSetupBindings.spec.js
  npm run build:admin
  ```

- [ ] **Step 7: Commit the admin workspace**

  ```powershell
  git add src/admin/pages/Subscriptions.vue src/admin/components/SubscriptionPlanModal.vue src/admin/components/SubscriptionDetailDrawer.vue src/admin/pages/__tests__/subscriptionsPage.spec.js src/admin/pageRegistry.js src/admin/App.vue src/admin/components/Sidebar.vue src/admin/pages/Customers.vue
  git commit -m "feat: add subscription management workspace"
  ```

---

## Task 11: Route subscription purchase refunds away from Orders

**Files:**

- Modify: `backend/routes/admin/orders.js`
- Modify: `src/admin/pages/Orders.vue`
- Modify: `backend/tests/integration/adminOrdersStats.test.js`
- Modify: `src/admin/pages/__tests__/ordersSetupBindings.spec.js`
- Modify: `src/admin/pages/__tests__/ordersOverlayState.spec.js`

- [ ] **Step 1: Write failing Orders integration/UI tests**

  Assert that order list/detail responses return nullable `subscription_id` for package purchase invoices. For a subscription invoice:

  - the row menu and detail panel show `Manage subscription` instead of Refund;
  - clicking navigates to `/admin/subscriptions?subscription_id=<id>`;
  - the generic refund modal never opens;
  - non-subscription paid orders retain the existing Refund action and modal behavior;
  - list statistics remain financially unchanged because subscription purchase is already a normal order.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run backend/tests/integration/adminOrdersStats.test.js src/admin/pages/__tests__/ordersSetupBindings.spec.js src/admin/pages/__tests__/ordersOverlayState.spec.js
  ```

- [ ] **Step 3: Add a bounded left join and contextual action**

  In both order list and detail queries, add:

  ```sql
  LEFT JOIN customer_subscriptions cs ON cs.purchase_invoice_id = o.invoice_id
  ```

  Select `cs.id AS subscription_id`. The unique purchase-invoice key guarantees no row multiplication. In `Orders.vue`, branch the existing Refund action; do not add another column or duplicate menu.

- [ ] **Step 4: Run Orders and refund regressions**

  ```powershell
  npx vitest run backend/tests/integration/adminOrdersStats.test.js backend/tests/integration/refunds.test.js src/admin/pages/__tests__/ordersSetupBindings.spec.js src/admin/pages/__tests__/ordersOverlayState.spec.js
  ```

- [ ] **Step 5: Commit Orders routing**

  ```powershell
  git add backend/routes/admin/orders.js src/admin/pages/Orders.vue backend/tests/integration/adminOrdersStats.test.js src/admin/pages/__tests__/ordersSetupBindings.spec.js src/admin/pages/__tests__/ordersOverlayState.spec.js
  git commit -m "fix: manage subscription refunds in subscriptions"
  ```

---

## Task 12: Add useful subscription analysis without double-counting revenue

**Files:**

- Create: `backend/services/subscriptionMetrics.js`
- Create: `backend/tests/unit/subscriptionMetrics.test.js`
- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `backend/services/dailyReportBuilder.js`
- Modify: `backend/services/productSalesMetrics.js`
- Modify: `backend/tests/integration/dailyReportsSummary.test.js`
- Modify: `backend/tests/integration/productSalesMetrics.test.js`
- Modify: `backend/tests/unit/dailyReportMath.test.js`
- Modify: `src/admin/pages/ReportsSummary.vue`
- Modify: `src/admin/pages/__tests__/dailyReportPayloads.spec.js`

- [ ] **Step 1: Write failing metrics tests with an explicit anti-double-counting assertion**

  Seed cash/card/split subscription purchases, ordinary sales, redemptions, reversed redemptions, expired subscriptions, and refunds. Assert:

  - normal `total_sales`, `cash_sales`, `card_sales`, and split reconciliation already include package invoices exactly once;
  - `subscription_collections` equals paid package order totals less package refunds in the selected purchase period and is labelled as a subset;
  - redeemed credits use redemption business date and exclude reversed rows;
  - allocated redeemed value uses each purchase order's actual net-of-refund total and active credits, with money rounded only at the presented aggregate boundary;
  - remaining/deferred value equals purchase value minus allocated value and never becomes negative;
  - the daily report does not add subscription collections to revenue a second time;
  - hidden package products do not appear as ordinary food in top-product/category-item rankings; their money remains in total sales and their count/value lives in subscription analysis.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run backend/tests/unit/subscriptionMetrics.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/productSalesMetrics.test.js backend/tests/unit/dailyReportMath.test.js src/admin/pages/__tests__/dailyReportPayloads.spec.js
  ```

- [ ] **Step 3: Implement one metrics service**

  `backend/services/subscriptionMetrics.js` accepts an executor and canonical date range and returns:

  ```js
  {
    active_subscriptions,
    subscriptions_expiring_7_days,
    subscription_collections,
    redeemed_credits,
    allocated_redeemed_value,
    remaining_deferred_value,
  }
  ```

  Use `orders.created_at`/invoice facts for purchase-period collections and `subscription_redemptions.business_date` for credit-use counts. Respect normal full refunds. Do not copy the paid-order filter SQL; join purchase invoices directly through `customer_subscriptions.purchase_invoice_id` and use existing refund aggregates/helpers.

  Exclude `subscription_plans.sale_product_id` from `backend/services/productSalesMetrics.js` using `NOT EXISTS`, with no change to the underlying financial totals.

- [ ] **Step 4: Surface one compact report section**

  Add metrics to the existing summary payload from `backend/services/dailyReportBuilder.js`. In `ReportsSummary.vue`, add one compact `Subscriptions` section showing collections (clearly marked as included in sales), redeemed meals, and active/expiring counts. Do not create another daily report page and do not add these fields to the 80 mm daily print unless explicitly requested later.

- [ ] **Step 5: Run financial regressions**

  ```powershell
  npx vitest run backend/tests/unit/subscriptionMetrics.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/productSalesMetrics.test.js backend/tests/integration/businessDayReconciliation.test.js backend/tests/integration/dashboardFinancialTimeline.test.js backend/tests/unit/dailyReportMath.test.js src/admin/pages/__tests__/dailyReportPayloads.spec.js
  ```

- [ ] **Step 6: Commit analysis**

  ```powershell
  git add backend/services/subscriptionMetrics.js backend/tests/unit/subscriptionMetrics.test.js backend/routes/admin/subscriptions.js backend/services/dailyReportBuilder.js backend/services/productSalesMetrics.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/productSalesMetrics.test.js backend/tests/unit/dailyReportMath.test.js src/admin/pages/ReportsSummary.vue src/admin/pages/__tests__/dailyReportPayloads.spec.js
  git commit -m "feat: report subscription activity"
  ```

---

## Task 13: Complete Arabic/English copy, audit coverage, and accessibility contracts

**Files:**

- Modify: `assets/js/admin/i18n.js`
- Create: `src/admin/pages/__tests__/subscriptionsLocalization.spec.js`
- Create: `src/components/pos/__tests__/subscriptionLocalization.spec.js`
- Modify: `backend/tests/integration/subscriptionManagement.test.js`
- Modify: `backend/tests/integration/subscriptionRedemptions.test.js`

- [ ] **Step 1: Add failing localization and audit-contract tests**

  Scan every static `$t('...')` key used by the new admin/POS components and assert it exists in `assets/js/admin/i18n.js`. Assert there are no hard-coded English action labels in the templates, no Arabic-Indic digit formatting, and no literal `JD` concatenation outside the existing currency formatter.

  Assert audit event types and minimum payloads:

  - `subscription_plan_created` / `subscription_plan_updated` — plan ID and meaningful old/new fields;
  - `subscription_purchased` — subscription, customer, plan, purchase invoice, credits, dates;
  - `subscription_redeemed` / `subscription_extra_meal_redeemed` — subscription, customer, redemption, credits, item IDs, business date, reason when required;
  - `subscription_redemption_reversed` — redemption, credits, reason;
  - `subscription_extended` — old/new end date and reason;
  - `subscription_cancelled` — reason;
  - subscription full refund continues to use the existing `refund` audit event and includes subscription ID in its metadata.

- [ ] **Step 2: Run and confirm failure**

  ```powershell
  npx vitest run src/admin/pages/__tests__/subscriptionsLocalization.spec.js src/components/pos/__tests__/subscriptionLocalization.spec.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionRedemptions.test.js
  ```

- [ ] **Step 3: Add natural translations**

  Include at least these exact concepts, adapting capitalization only for English display:

  | English key | Arabic |
  |---|---|
  | Subscriptions | الاشتراكات |
  | Subscription Plans | باقات الاشتراك |
  | Sell Subscription | بيع اشتراك |
  | Renew Subscription | تجديد الاشتراك |
  | Redeem Meal | صرف وجبة |
  | Subscription Meal | وجبة اشتراك |
  | Remaining Meals | الوجبات المتبقية |
  | Used Meals | الوجبات المصروفة |
  | Additional Meal Reason | سبب صرف أكثر من وجبة |
  | Start Today | يبدأ اليوم |
  | Start After Current Subscription | يبدأ بعد الاشتراك الحالي |
  | Extend Subscription | تمديد الاشتراك |
  | Cancel Subscription | إلغاء الاشتراك |
  | Reverse Redemption | إلغاء صرف الوجبة |
  | Subscription Collections | تحصيل الاشتراكات |
  | Included in total sales | مشمولة ضمن إجمالي المبيعات |
  | Expiring Soon | تنتهي قريباً |
  | Manage Subscription | إدارة الاشتراك |

  Keep identifiers, references, quantities, dates, invoice numbers, and currency values wrapped with the existing Latin-digit/tabular-number conventions (`data-no-i18n` where used by this app).

- [ ] **Step 4: Check accessible modal behavior**

  Ensure both new modals/drawers have labelled dialog roles, keyboard close, focus-visible styles, no hover-only controls, disabled/loading states, and background focus containment consistent with the checkout modal. Respect reduced motion; use opacity/transform transitions only and never animate layout height/width for the main panel.

- [ ] **Step 5: Run localization, audit, and build checks**

  ```powershell
  npx vitest run src/admin/pages/__tests__/subscriptionsLocalization.spec.js src/components/pos/__tests__/subscriptionLocalization.spec.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionRedemptions.test.js
  npm run build:admin
  ```

- [ ] **Step 6: Commit language and audit polish**

  ```powershell
  git add assets/js/admin/i18n.js src/admin/pages/__tests__/subscriptionsLocalization.spec.js src/components/pos/__tests__/subscriptionLocalization.spec.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionRedemptions.test.js
  git commit -m "chore: complete subscription language and audit"
  ```

---

## Task 14: Run the complete migration and workflow verification

**Files:**

- Modify if generated by the established release process: `backend/migrations/production-sync-*.sql`
- Verify: all files changed in Tasks 1–13

- [ ] **Step 1: Apply the migration to the local development database**

  Import `backend/migrations/2026-07-22-customer-meal-subscriptions.sql` once through the same MySQL/phpMyAdmin-compatible process used for prior migrations. Then run `backend/migrations/2026-07-22-customer-meal-subscriptions-verify.sql` and require every `missing_count`/invalid count to be `0` plus the exact ledger checksum.

- [ ] **Step 2: Verify schema parity and syntax**

  ```powershell
  node scripts/validate-schema-drift.js
  node --check backend/services/SubscriptionService.js
  node --check backend/services/RefundService.js
  node --check backend/services/kitchenPrintRouting.js
  node --check backend/routes/pos/subscriptions.js
  node --check backend/routes/admin/subscriptions.js
  node --check pos-spooler-printer/server.js
  ```

- [ ] **Step 3: Run the focused subscription suite**

  ```powershell
  npx vitest run backend/tests/unit/subscriptionService.test.js backend/tests/unit/subscriptionMetrics.test.js backend/tests/unit/kitchenPrintRouting.test.js backend/tests/integration/subscriptionPlans.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/subscriptionManagement.test.js src/components/pos/__tests__/subscriptionModal.spec.js src/components/__tests__/posSubscriptionWiring.spec.js src/admin/pages/__tests__/subscriptionsPage.spec.js src/admin/pages/__tests__/subscriptionsLocalization.spec.js pos-spooler-printer/tests/report-html.test.js
  ```

- [ ] **Step 4: Run the high-risk surrounding regressions**

  ```powershell
  npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/refunds.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/shift.test.js backend/tests/integration/businessDayReconciliation.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/bundle.print.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/printQueue.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderUiStore.test.js src/admin/pages/__tests__/ordersOverlayState.spec.js src/admin/pages/__tests__/ordersSetupBindings.spec.js
  ```

- [ ] **Step 5: Run the full automated gates**

  ```powershell
  npm run test:unit
  npm run build:admin
  ```

  If the repository's e2e environment is configured, also run:

  ```powershell
  npm run test:e2e
  ```

- [ ] **Step 6: Perform one manual cashier/admin proof on a 1024 px viewport and phone viewport**

  Use this exact scenario:

  1. admin creates a 30-credit/30-day plan with two eligible meals and 8% tax;
  2. cashier sells it by card through the normal checkout and sees one normal receipt/invoice;
  3. verify daily sales/card totals include the purchase once and subscription collections show the same purchase as a subset;
  4. cashier adds one eligible meal with a free modifier and redeems it; verify no checkout opens, one credit is consumed, stock decreases, and only a price-free kitchen ticket prints;
  5. cashier redeems a second meal during the same business day; verify the reason is required and saved;
  6. add a paid modifier and verify redemption is blocked with guidance to sell the extra separately; pay that extra through a normal checkout;
  7. reverse the second redemption from admin; verify credit/stock return once and the kitchen receives one void ticket;
  8. verify full package refund is blocked while the first redemption is active;
  9. reverse the first redemption, process the full package refund from Subscription Management, and—if the invoice was accepted by JoFotara—send the return through the existing action;
  10. confirm Orders routes the package invoice to Subscription Management and ordinary orders/refunds/tables still work normally.

- [ ] **Step 7: Inspect final data invariants directly**

  For the manual scenario, query:

  ```sql
  SELECT cs.id, cs.total_credits,
         COALESCE(SUM(CASE WHEN sr.status='active' THEN sri.quantity ELSE 0 END),0) AS used_credits
  FROM customer_subscriptions cs
  LEFT JOIN subscription_redemptions sr ON sr.subscription_id=cs.id
  LEFT JOIN subscription_redemption_items sri ON sri.redemption_id=sr.id
  WHERE cs.id=?
  GROUP BY cs.id, cs.total_credits;

  SELECT idempotency_key, COUNT(*)
  FROM subscription_redemptions
  GROUP BY idempotency_key
  HAVING COUNT(*) > 1;

  SELECT idempotency_key, COUNT(*)
  FROM print_queue
  WHERE idempotency_key LIKE '%subscription-redemption%'
  GROUP BY idempotency_key
  HAVING COUNT(*) > 1;
  ```

  Expected: balance never below zero; no duplicate redemption key; no duplicate printer-specific print key.

- [ ] **Step 8: Final clean commit**

  Confirm `git status --short` contains no accidental archives, generated build output, credentials, `.env` files, or unrelated work. If a production-sync migration is part of the established deployment flow, build it from the already verified migration rather than hand-copying fragments.

  ```powershell
  git add backend/migrations/production-sync-*.sql
  git commit -m "chore: finalize subscription deployment"
  ```

  Skip this final commit when no tracked production-sync artifact is required; do not create an empty commit.

---

## Acceptance Checklist

- [ ] A subscription purchase creates exactly one normal paid invoice and exactly one customer subscription.
- [ ] Cash/card/split, shift, tax, receipt, refund, and JoFotara behavior for the purchase are unchanged.
- [ ] Redemption creates no order/invoice/refund/payment rows and adds no revenue.
- [ ] Eligible product snapshots protect existing subscriptions from later plan edits.
- [ ] Remaining credits are derived, race-safe, and never negative.
- [ ] A second same-business-day credit always requires and stores a reason.
- [ ] Paid extras cannot leak into a free redemption; they remain normal sales.
- [ ] Stock, audit, credit ledger, and durable kitchen jobs commit or roll back together.
- [ ] Network retries and multi-spooler dispatch cannot duplicate a redemption or kitchen ticket.
- [ ] Reversal restores credits/stock exactly once and sends a kitchen void ticket.
- [ ] Subscription package refunds are full-only and controlled only from Subscription Management.
- [ ] Orders remains the financial invoice view but directs subscription actions to the subscription workspace.
- [ ] Reports show subscription collections as a subset and never double-count revenue.
- [ ] Register-only, permission, active-shift, audit-bypass, Arabic, Latin-digit, responsive, and touch rules are covered by tests.
- [ ] Normal register checkout, table checkout, held orders, refunds, printing, and price-list behavior still pass their existing tests.

## Explicitly Deferred

- Daily meal schedules or a hard one-meal-per-day entitlement.
- Mixed paid extras and credit redemption in one atomic UI transaction.
- Partial package refunds or prorated cancellations.
- Automatic accounting journal postings; the plan preserves the data needed for a future accounting integration.
- Customer mobile apps, notifications, recurring renewals, online payments, QR membership cards, and biometric/customer PIN verification.
- A separate thermal subscription-management report.
