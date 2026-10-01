# POS Catalog and Cart Price Refresh Simplification Plan

> **Execution contract:** Execute this plan task by task on an ordinary feature branch such as `codex/pos-catalog-price-refresh-simplification`. Do not use a worktree. Use RED/GREEN focused tests and commit each task separately. Do not add a database migration, dependency, cache, version token, WebSocket/SSE channel, background worker, automatic checkout retry, or new server pricing authority.

**Goal:** Stop reloading and re-authorizing the same catalog prices merely because the POS mounted twice, regained focus, restored a server-canonical held order, or received a stock-only notification. Preserve the one validation that matters: checkout and durable held/table writes still reconstruct money from the database or server-authored frozen state.

**Selected design:** Keep the existing catalog endpoint, category-price resolver, staff Socket.IO channel, held-order claim, and checkout transaction. Make refresh ownership explicit in `PosTerminal.vue`, mark only successful server-held claims as already canonical, and add a small backward-compatible `scope` payload to inventory notifications so stock and availability events no longer force a cart-price query. Unknown or legacy notifications retain today's full refresh.

**Current fixed point:** Plan written from clean `master` at `28412186` on 2026-08-29. The executor must re-read the named files on the actual branch tip; the hash is evidence, not a reset target.

## What is actually redundant, and what is not

### Work that is justified and must remain

1. `src/pos/stores/orderSessionStore.js` adds a product from the already-loaded catalog object. A normal product tap does **not** call the server.
2. `backend/modules/checkout/executeCheckout.js` still calls `fetchCartProducts(..., { includeCheckoutContext: true })` and `applyDatabasePrices(...)` before accepting submitted totals. This is the final trust boundary and must remain.
3. `backend/routes/pos/orders.js` canonicalizes a held order on save and again on the first successful claim. It updates the durable snapshot and returns that canonical `cart_data` in the same transaction.
4. Table settlement and saved lines intentionally preserve server-authored historical prices. `collectFreshCatalogProductIds()` already excludes `order_item_id`, manual-price, custom, note-only, and service-charge lines. Do not broaden it.
5. The permanent checkout command contract currently passes at 15 commands for ordinary stock-off checkout and 17 for tracked stock. This plan must not change those counts.

### Work that is redundant today

1. `src/App.vue` wraps `PosTerminal` in `<KeepAlive>`. `PosTerminal.vue` calls `refreshCatalogAndCart()` in both `onMounted` and `onActivated`. Vue documents that `onActivated` also runs on initial mount, so the two hooks can launch duplicate network work on first entry. The existing static test incorrectly freezes that duplication as desired behavior. See [Vue KeepAlive lifecycle](https://vuejs.org/guide/built-ins/keep-alive#lifecycle-of-cached-instance).
2. Every active-window focus currently reloads the full catalog and then resolves every eligible cart product again, even while the staff socket has remained connected and already delivered mutations.
3. A successful held-order claim already returns current database prices, note-product prices, tax rates, availability, and totals. The following mount refresh resolves the same eligible cart IDs again before the cashier changes anything.
4. `inventory_changed` currently means several different things:
   - stock changed after checkout, table save, refund, void, or subscription redemption;
   - one product's availability changed, followed immediately by the targeted `product_availability_changed` payload;
   - catalog identity or price changed after an admin product, category-price-list, bundle, subscription-plan, or import mutation.
   The frontend has no discriminator, so all three cases run a full catalog GET and a cart-price POST.

## Measured baseline

Focused baseline run before writing this plan:

```text
npm exec vitest run -- \
  src/components/__tests__/categoryPricePosWiring.spec.js \
  backend/tests/integration/checkoutPerformanceContract.test.js

2 files, 9 tests passed

npm exec vitest run -- backend/tests/unit/categoryPriceSync.test.js

1 file, 5 tests passed
```

The forced rollback log emitted by `checkoutPerformanceContract.test.js` is intentional test evidence, not a suite failure.

Static call-site inventory in `PosTerminal.vue`:

- initial `onMounted`: full catalog + eligible cart prices;
- initial `onActivated`: full catalog + eligible cart prices again;
- later KeepAlive activation: full catalog + eligible cart prices;
- every window focus: full catalog + eligible cart prices;
- socket reconnect: full catalog + eligible cart prices;
- every `inventory_changed`: full catalog + eligible cart prices.

`useProducts.fetchData()` increments a request id and ignores stale responses, but it does not cancel or coalesce the already-sent HTTP requests. `cache: 'no-store'` also means the browser does not turn the repeated calls into local cache hits. The server's root register-catalog memory cache reduces repeated SQL in some cases, but it does not remove request parsing, authentication, response serialization, transfer, or the separate category-price resolver query.

## Expected result

For an eligible non-empty register cart, count only catalog/price-preview calls; checkout itself is unchanged:

| Scenario | Current | After plan |
|---|---:|---:|
| First POS entry under KeepAlive | up to 2 catalog GET + 2 price POST | 1 catalog GET + 1 price POST |
| First entry restoring a successful server-held claim | claim + up to 2 catalog GET + 1 price POST | claim + 1 catalog GET + 0 price POST when connected before snapshot start; one bounded delayed-connect reconciliation may add 1 catalog GET + 1 price POST |
| Focus while staff socket stayed connected | 1 catalog GET + 1 price POST | 0 catalog/price calls |
| Focus while socket is disconnected | 1 catalog GET + 1 price POST | 1 catalog GET + 1 price POST fallback |
| Real socket reconnect | 1 catalog GET + 1 price POST | unchanged |
| Stock-only event | 1 catalog GET + 1 price POST | 1 catalog GET + 0 price POST |
| Targeted availability event | 1 catalog GET + targeted event | targeted event only |
| Admin price/catalog mutation or legacy unscoped event | 1 catalog GET + 1 price POST | unchanged |
| Final checkout | server rebuild + subtotal/total validation | unchanged |

These are deterministic request-shape improvements, not invented production latency percentages. A Hostinger canary may measure wall-clock impact later; it is outside this branch.

## Load-bearing invariants

1. Browser catalog prices, note prices, modifier prices, taxes, discounts, subtotal, and total remain untrusted.
2. Checkout, held-save, table-save, split settlement, invoice editing, stock locking, idempotency, service-charge snapshots, and JoFotara behavior are untouched.
3. A successful held claim may suppress only the immediate preview resolver. The later checkout still revalidates the claimed snapshot.
4. LocalStorage-only restored carts, old held handoffs without a successful claim, edits, ordinary carts, and failed claims are not treated as server-canonical.
5. Unknown, malformed, or absent inventory event payloads use the conservative full catalog-and-cart refresh. This is the rollout compatibility rule.
6. Existing older frontends may ignore the new event argument and continue full-refreshing. Existing older servers emit no argument; the new frontend therefore full-refreshes. No mixed-version window loses correctness.
7. Stock-only events still refresh the catalog because the product grid uses current `stock` for add-to-cart limits. They skip only the unrelated cart-price resolver.
8. Availability scope may skip the full catalog only because the existing `product_availability_changed` payload carries the changed product and every affected bundle parent's `is_available`/`can_sell` state.
9. Admin product, price-list, bundle, subscription-plan, and import mutations retain full catalog-and-cart refresh behavior.
10. The existing stale-response request id, sales-context/table guards, 300-ID batching, and “cart gained another ID during refresh” retry remain intact.
11. No automatic checkout retry is added. A typed 409 price/subtotal conflict remains the safe response to a real race.
12. This uses the existing staff application socket only. It does not reintroduce the retired spooler socket protocol or alter spooler delivery.

---

## Task 1 — Give lifecycle refreshes one owner

**Files:**

- Modify: `src/components/PosTerminal.vue`
- Modify: `src/components/__tests__/categoryPricePosWiring.spec.js`

### RED

Replace the current assertion that requires both mount and initial activation to refresh. Add source-level wiring assertions for the intended ownership:

- `onMounted` performs the initial `await refreshCatalogAndCart(...)`;
- the first `onActivated` call records initial activation but does not refresh;
- later activations refresh;
- focus refreshes catalog/prices only when the POS is active **and** `socket.value?.connected !== true`;
- focus still refreshes the held-order summary;
- socket reconnect still performs a full catalog-and-cart refresh.

Run:

```powershell
npm exec vitest run -- src/components/__tests__/categoryPricePosWiring.spec.js
```

Expected RED: the old unconditional `onActivated` and focus calls violate the new assertions.

### GREEN

In `PosTerminal.vue`:

1. Add one local boolean whose only purpose is to consume the documented initial KeepAlive activation. Do not add a timer, TTL, composable, queue, or generic lifecycle abstraction.
2. Keep initial catalog bootstrap in `onMounted`.
3. In `onActivated`, always keep the existing listener/UI activation work, but run `refreshCatalogAndCart()` only after the first activation has already been seen.
4. In `handleWindowFocus`, keep `fetchHeldOrderSummary()`. Run the catalog/cart fallback only when the page is active and the staff socket is not currently connected. A later `socket_reconnected` event remains the normal recovery owner.
5. Do not alter active-table context switching, settings refresh, barcode setup, or product search behavior.

Run the same focused test and expect GREEN.

### Break it before commit

- Confirm the activation guard skips only the first refresh, not the rest of `onActivated`.
- Confirm a POS route that was deactivated and reinserted does refresh.
- Confirm a disconnected socket still gets an HTTP fallback on focus.
- Confirm a continuously connected POS does not refetch on ordinary focus changes.
- Confirm there is still exactly one initial catalog bootstrap even if no held order exists.

Commit:

```text
perf(pos): remove duplicate catalog lifecycle refreshes
```

---

## Task 2 — Reuse the successful held-claim canonicalization

**Files:**

- Modify: `src/components/PosTerminal.vue`
- Modify: `src/components/__tests__/categoryPricePosWiring.spec.js`
- Verify only: `backend/routes/pos/orders.js`
- Verify only: `backend/tests/integration/heldOrders.test.js`
- Verify only: `backend/tests/unit/categoryPriceSync.test.js`

### RED

Add wiring assertions that require `checkAndRestoreHeldOrder()` to return an explicit outcome and require mount to suppress the immediate cart-price resolver only for the successful server-claim outcome.

Required cases:

| Restore source | Mount catalog | Mount cart-price resolver |
|---|---:|---:|
| successful `/held_orders/:id/claim` | yes | no |
| LocalStorage-only legacy/local saved cart | yes | yes |
| ordinary new register cart | yes | harmless/no IDs |
| edit invoice | yes | existing frozen-line rules decide |
| failed claim | no false canonical marker | no changed recovery behavior |

Run:

```powershell
npm exec vitest run -- src/components/__tests__/categoryPricePosWiring.spec.js backend/tests/integration/heldOrders.test.js backend/tests/unit/categoryPriceSync.test.js
```

Expected RED: the restore function currently returns no source outcome and mount always requests both phases.

### GREEN

1. Let `refreshCatalogAndCart` accept one narrow option, for example `{ refreshCartPrices = true }`. It always refreshes catalog and availability; it conditionally calls `refreshCartCatalogPrices()`.
2. Let `checkAndRestoreHeldOrder()` return a small string outcome. Use a server-canonical outcome only after all of these succeeded:
   - a handoff contained held id/token/version;
   - the claim HTTP response succeeded;
   - `data.order` existed;
   - returned `cart_data` parsed;
   - `cart.restoreHeldOrder()` completed.
3. On initial mount, pass `refreshCartPrices: false` only for that server-canonical outcome.
4. Do not infer canonicality from `pricing_context_changed === false`; replay responses are canonical too, and local payloads are not. The authority is the successful server claim response itself.
5. Do not alter the claim route, held version, token, audit, service-charge snapshot, or checkout logic.

### Break it before commit

- A claim response that changes a priced note must display the returned canonical note and skip one duplicate resolver.
- A claim parse/HTTP failure must never return the server-canonical outcome.
- A local saved order with eligible lines must still run the resolver.
- A new item added after restore is covered by the existing final checkout validation and later refresh triggers; do not introduce cart-wide “canonical forever” state.
- Frozen table/order-item lines must remain excluded by `collectFreshCatalogProductIds()`.

Commit:

```text
perf(pos): reuse canonical held-order claim prices
```

---

## Task 3 — Distinguish stock, availability, and catalog mutations

**Files:**

- Modify: `src/components/PosTerminal.vue`
- Modify stock emitters:
  - `backend/modules/checkout/executeCheckout.js`
  - `backend/modules/tables/saveTableOrder.js`
  - `backend/modules/refunds/voidOpenTableOrder.js`
  - `backend/routes/pos/refunds.js`
  - `backend/routes/pos/subscriptions.js`
  - `backend/routes/admin/subscriptions.js` (redemption/refund stock emits only; leave `afterPlanMutation` unscoped)
- Modify availability emitter: `backend/routes/pos/catalog.js`
- Modify concerned tests:
  - `backend/tests/integration/checkout.test.js`
  - `backend/tests/integration/bundle.catalog.test.js`
  - `src/components/__tests__/categoryPricePosWiring.spec.js`
- Add: `backend/tests/unit/inventoryChangeScopeContract.test.js`

### RED

Add a focused contract test that reads every named stock producer and requires:

```js
emit('inventory_changed', { scope: 'stock' })
```

Require the availability route to emit:

```js
emit('inventory_changed', { scope: 'availability' })
emit('product_availability_changed', payload)
```

Require catalog mutation helpers to stay conservatively unscoped for this change. At minimum pin:

- `backend/routes/admin/products.js`;
- `backend/routes/admin/categoryPriceLists.js`;
- `backend/routes/admin/bundle-items.js`;
- `backend/routes/admin/import.js`;
- `afterPlanMutation()` in `backend/routes/admin/subscriptions.js`.

Update the checkout socket assertion to expect the staff-scoped stock payload and the availability test to expect both scoped invalidation and the existing targeted payload.

In the frontend wiring test, require:

- `stock` -> catalog refresh with cart-price phase disabled;
- `availability` -> no broad refresh;
- absent/unknown/catalog scope -> full catalog-and-cart refresh.

Run:

```powershell
npm exec vitest run -- backend/tests/unit/inventoryChangeScopeContract.test.js src/components/__tests__/categoryPricePosWiring.spec.js
npm exec vitest run -- backend/tests/integration/checkout.test.js -t "broadcast new_order and inventory_changed"
npm exec vitest run -- backend/tests/integration/bundle.catalog.test.js -t "availability"
```

Expected RED: producers currently emit only the event name and the frontend ignores payload scope.

### GREEN

1. Add `{ scope: 'stock' }` to every proven stock-only producer. Do not change event name, room, ordering, or post-commit placement.
2. Add `{ scope: 'availability' }` to the broad availability invalidation while preserving the existing targeted availability event and payload.
3. Leave catalog/price mutation events unscoped. Unscoped is intentionally the safe full-refresh default and preserves mixed-version deployment behavior.
4. Change `onInventoryChanged(payload)`:
   - `availability`: return; targeted handler owns the update;
   - `stock`: call `refreshCatalogAndCart({ refreshCartPrices: false })`;
   - everything else: call the full refresh.
5. Do not add product-stock deltas in this task. Absolute stock still comes from the existing catalog endpoint, avoiding a second stock protocol and missed-delta drift.
6. Do not remove catalog-cache invalidation after stock writes; future catalog loads must still receive current stock.

### Break it before commit

- New frontend + old server: bare event must full-refresh.
- Old frontend + new server: ignored payload argument must preserve old full-refresh behavior.
- Stock checkout: product grid stock updates, cart-price endpoint is not called, checkout response remains post-commit safe.
- Admin price-list/product/bundle/import mutation: still full-refreshes cart prices.
- Availability toggle: affected base/bundle products update through the targeted payload without a broad request.
- Disconnect between mutations: reconnect still full-refreshes.
- A misspelled or hostile scope value must fall into full refresh, not no-op.
- No producer may move its notification before transaction commit.

Commit:

```text
perf(pos): scope inventory refresh notifications
```

---

## Final focused verification

Run only the affected contracts plus the permanent money-path command guard:

```powershell
npm exec vitest run -- backend/tests/unit/categoryPriceSync.test.js backend/tests/unit/inventoryChangeScopeContract.test.js src/components/__tests__/categoryPricePosWiring.spec.js
npm exec vitest run -- backend/tests/integration/heldOrders.test.js backend/tests/integration/checkoutPerformanceContract.test.js
npm exec vitest run -- backend/tests/integration/checkout.test.js -t "broadcast new_order and inventory_changed"
npm exec vitest run -- backend/tests/integration/bundle.catalog.test.js -t "availability"
npm run build:admin
```

Then perform one local browser counting experiment with DevTools Network or Playwright interception. Use an eligible non-empty cart and record only these request URLs:

- `GET /api/pos/products`;
- `POST /api/pos/category-prices/resolve`;
- `POST /api/pos/held_orders/:id/claim`.

Acceptance matrix:

1. first entry: exactly one catalog request and at most one resolver request when the socket is connected before the initial catalog snapshot starts; if the first connection lands after that snapshot starts (while its resolver is still running or after completion), allow one bounded catch-up refresh to close the otherwise-unobservable mutation gap;
   A failed/dropped connection that recovers before snapshot start is coalesced into that imminent initial snapshot and adds no duplicate request.
2. focus with connected staff socket: neither request;
3. disconnect/reconnect: one of each when the cart has eligible lines;
4. successful held claim on first entry: claim + one catalog request + zero resolver requests when connected before snapshot start; a first connection delayed beyond snapshot start may add the same one bounded catalog + resolver reconciliation allowed by case 1;
5. stock-only event: one catalog request + zero resolver requests;
6. admin catalog-price mutation or manually emitted legacy bare event: one catalog request + one resolver request.

The checkout request must still succeed through the existing 15/17-command contract, and a deliberately stale submitted subtotal must still be rejected. Do not weaken or remove the mismatch assertion to make the experiment green.

## Explicitly deferred

- Targeted absolute-stock socket payloads. They could remove the remaining stock-event catalog GET, but would require every stock mutation path to publish a complete absolute snapshot or add another read. That is a separate measured optimization, not needed to remove redundant price authorization safely.
- Browser price/version signatures, global catalog revisions, Redis, cross-request price caches, service workers, ETags in `useProducts`, or offline sale authorization.
- Replacing Socket.IO, adding SSE/WebSockets for the spooler, or changing the current long-poll print transport.
- Splitting `executeCheckout`, changing server price authority, or trusting the cart because it was previously loaded.

## Definition of done

- Mount owns the initial snapshot under KeepAlive; only a first socket connection delayed beyond the start of that snapshot may add one bounded catch-up refresh.
- A socket recovery completed before snapshot start is absorbed by the initial snapshot rather than launching a competing pre-context refresh.
- Connected-window focus performs no catalog/price preview work.
- Successful server-held claim skips the mount-owned resolver; only the delayed-first-connect safety reconciliation may resolve it once.
- Stock events refresh stock-bearing catalog data without querying cart prices.
- Availability events use their existing targeted payload without a broad refresh.
- Catalog/price mutations and unknown legacy events still full-refresh.
- Checkout/held/table money authority, stock locks, idempotency, and command budgets are unchanged.
- Focused tests and admin build pass.
- The request-count experiment matches the acceptance matrix.
