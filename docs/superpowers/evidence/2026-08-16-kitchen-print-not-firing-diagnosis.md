# Kitchen tickets not printing — diagnosis for review

**Date:** 2026-08-16
**Repo state:** `master` @ `74cd4492` plus in-progress work from a separate plan (untouched by this investigation)
**Reported symptom:** multiple venues report that some orders fire to the kitchen and some do not, for nearly identical orders. The customer receipt always prints.
**Scope:** diagnosis only. **No code was changed.** No fix is proposed as executed.

## How this was produced, and what that is worth

Three read-only audits were dispatched in parallel (kitchen job producers; print job identity/dedupe/delivery; unrouted and empty-payload handling). **Agent output was not accepted on trust.** Every load-bearing claim below was re-opened and re-read in source by the author before being recorded here. The specific line ranges personally verified are listed under each finding.

**What could not be verified here, and matters:**

- **No venue data.** The local dev database contains a single category and no realistic catalog. Every claim about *which* products are affected at a real site is unproven and must be answered by the SQL in the last section, run against a venue database.
- **No live spooler run.** Finding A1 is proven from source ordering, not from a reproduced render timeout. The falsifiable check for it is in the discriminator query.
- **No frequency estimate.** Nothing here establishes how often each cause fires. Ranking below is by fit-to-symptom and reachability, not measured incidence.

---

## The discriminator — run this first

The causes split into two families, separable by one question: **does a `print_queue` row exist for the missing ticket?**

| finding | family | meaning |
| --- | --- | --- |
| **No row at all** | Routing (B) | The job was never created. No item resolved to a kitchen printer. |
| **A `dead_letter` row with `last_error`** | Delivery (A) | The job was created and handed to the spooler, which failed and permanently gave up. |

```sql
SELECT id, printer_id, status, attempts, last_error, device_status, created_at
FROM print_queue
WHERE print_type = 'kitchen' AND status IN ('dead_letter','failed')
ORDER BY id DESC LIMIT 50;
```

Rows with render-side errors (`Puppeteer render timed out`, `Rendered print document has no printable body`, browser/target errors) and `attempts` of 0 or 1 ⇒ **A1 confirmed**, and the low attempt count proves the retry ladder was skipped.
No rows covering the orders that went missing ⇒ **family B**.

Both families are silent to the cashier and both leave the receipt printing normally, which is why they present as one bug.

---

## Family A — the job existed and was permanently abandoned

### A1. Kitchen jobs are marked "may have already printed" *before rendering begins*, forcing instant dead-letter with zero retries

*Verified by reading: `pos-spooler-printer/server.js:340-381`, `:866-897`, `:419`, `:493`; `backend/services/printQueue.js:185-209`.*

[pos-spooler-printer/server.js:358-378](pos-spooler-printer/server.js:358):

```js
if (job?.print_type === 'kitchen' && job?.queue_id) {
    seenStore.begin(job);          // marks the attempt ambiguous
    kitchenAttemptStarted = true;
}
await addToPrintQueue(job);        // render AND transport, all of it
...
} catch (err) {
    responsePayload = { success: false, uncertain: kitchenAttemptStarted, ... };
}
```

`addToPrintQueue` → `processPrintJob` renders **first** and only then opens the printer — [:871-875](pos-spooler-printer/server.js:871):

```js
const { rasterBands, renderMs, rasterMs } = await renderWithDeadline(browser, htmlContent);
const transportStartedAt = performance.now();
// Send to printer
await new Promise((resolve, reject) => { ... client.connect(...) ... });
```

`RENDER_TIMEOUT_MS` defaults to **30 s** ([:419](pos-spooler-printer/server.js:419)). So a Puppeteer timeout, a Chrome crash during relaunch, or `'Rendered print document has no printable body.'` ([:493](pos-spooler-printer/server.js:493)) — none of which put a byte on paper — all return `uncertain: true`.

[printQueue.js:195](backend/services/printQueue.js:195):

```js
const nextStatus = integrityMismatch || uncertain || attempts >= maxAttempts ? 'dead_letter' : 'failed';
```

`uncertain` bypasses the retry ladder entirely — `max_attempts = 5` never applies. The durable seen-store then blocks every future delivery of that job until an admin manually reprints.

**Why this fits the symptom better than any routing cause:**
- **Non-deterministic** — render latency varies with load, concurrent tickets, and browser relaunches. Two *genuinely* identical orders can differ. Every family-B cause is deterministic per product.
- **Kitchen-only** — both guards test `job?.print_type === 'kitchen'`. Receipt jobs keep the normal 5-attempt retry ladder. This is precisely why the receipt always prints and only the kitchen ticket vanishes.
- Preflight is skipped for `write_only` printers, the schema default (`printers.status_capability … DEFAULT 'write_only'`), so most kitchen printers take this path on every job.

The fail-closed intent is deliberate and documented in `architecture.json` (kitchen jobs returning uncertain are never auto-retried). **The defect is where the boundary sits** — at `seenStore.begin()` before rendering, rather than immediately before the physical write. A render failure cannot have reached paper and carries none of the double-print risk the guard exists to prevent.

**How to refute:** show that `addToPrintQueue` cannot throw before line 871's render completes, or that render failures reach the catch with `kitchenAttemptStarted === false`.

### A2. Re-firing the same order silently does nothing

*Verified by reading: `backend/services/printDispatch.js:38-79`; `backend/services/printJobIdentity.js` key construction; `printQueue.js` claim predicate.*

[printDispatch.js:54-58](backend/services/printDispatch.js:54):

```js
`INSERT INTO print_queue (payload, idempotency_key, payload_hash, printer_id, print_type, status)
 VALUES (?, ?, ?, ?, ?, 'pending')
 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`
```

Status is **not** reset. A dead-lettered row keeps its terminal status, `claimPrintJobs` never picks up `dead_letter`, yet the insert "succeeds" and returns that row's id as though freshly queued.

Kitchen identity is `kitchen:${batchId}:${printerId}:${payloadHash}`. Re-firing the same invoice reproduces the same key exactly, so it resolves onto the dead row and prints nothing.

Only `HeldOrderKitchenDispatch` passes `returnStatus: true` and rejects a non-accepted state (409 `HELD_KITCHEN_QUEUE_NOT_ACCEPTED`) — [HeldOrderKitchenDispatch.js:334-335](backend/services/HeldOrderKitchenDispatch.js:334). The ordinary path never asks. **This is what makes staff report "we sent it again and still nothing."** The admin Reprint button does work; it mints a fresh key via `reprint_of_queue_id`.

Inverse note: the table path is immune to A2 but exposed the other way — [saveTableOrder.js:871](backend/modules/tables/saveTableOrder.js:871) builds `print_batch_id` with `crypto.randomUUID()` per call, so dedupe never engages and a genuine double-submit would print twice.

### A3. The staff-facing failure badge hides exactly these jobs

*Verified by reading: `server.js:458-471`; `src/pos/useSocket.js:54`.*

[server.js:460](server.js:460):

```js
const [rows] = await db.query("SELECT COUNT(*) as count FROM print_queue WHERE status = 'failed'");
```

`dead_letter` is excluded. This count drives the red "N Failed Prints" badge on the register. The moment a job becomes `dead_letter` — under A1, possibly on its first attempt — it drops out of the badge. **Staff get an all-clear at the exact moment a ticket is permanently lost.** The only recovery surface is an admin-only reprint list in Settings.

---

## Family B — the job was never created

### B1. `products.category_id` is NULL

*Verified by reading: `backend/routes/admin/products.js:784-797`, `:444`; `backend/routes/print.js:1014-1037`, `:1055-1062`, `:1303-1315`; `backend/routes/pos/catalog.js:160-187`; `deployment/database/baseline.sql` products/categories/printer_categories definitions; `src/pos/stores/orderSessionStore.js:2288-2340`.*

[products.js:786-791](backend/routes/admin/products.js:786), inside category deletion:

```js
await conn.query(`UPDATE categories SET parent_id = ?, price_list_root_id = ? WHERE id IN (...)`,
    [current.parent_id, destinationRootId, ...directChildren]);
await conn.query('UPDATE products SET category_id = NULL WHERE category_id = ?', [categoryId]);
```

Deleting a category **re-parents its subcategories** to the grandparent but **orphans its products**. The FK does the same (`ON DELETE SET NULL`), and product create/edit never requires a category ([products.js:444](backend/routes/admin/products.js:444); `ProductModal.vue:35` carries no `required`, unlike name and price).

The kitchen ticket reads the category **live at print time**, not from the order — [print.js:1018-1023](backend/routes/print.js:1018):

```sql
SELECT oi.*, COALESCE(oi.item_name, p.name) as name, p.category_id
FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id
WHERE oi.invoice_id = ?
```

So one ordinary menu cleanup detaches every product in that category from kitchen routing, retroactively, including for orders already placed.

When no item routes, [print.js:1305-1308](backend/routes/print.js:1305) writes nothing:

```js
async function printKitchenOrder(io, data) {
    const { payloads } = await buildKitchenPrintPayloads(pool, data);
    if (payloads.length > 0) await enqueueAndProcessJobs(io, payloads);
    return payloads.length;
}
```

No `else`; `unroutedItems` is not even destructured. [print.js:1061](backend/routes/print.js:1061) then returns `success: true` with *"0 kitchen ticket(s) queued and sent to spooler."*, and [orderSessionStore.js:2293](src/pos/stores/orderSessionStore.js:2293) fires it with no `await` and no `.catch()`. The receipt is a separate call with its own `try/catch`, which is why the receipt is unaffected.

This is already recorded as defect **`d-unrouted-kitchen-items-silent`** in `docs/architecture.json`, at severity **minor**. It sits on the ordinary checkout path; that rating is too low.

### B2. `saveTableOrder` erases category-less items before routing

*Verified by reading: `backend/modules/tables/saveTableOrder.js:840-897`.*

[saveTableOrder.js:862-867](backend/modules/tables/saveTableOrder.js:862):

```js
.filter(item => {
    if (Array.isArray(item.bundleItems)) return true;
    return item.product_id !== null
        && productMap.has(Number(item.product_id))
        && item.category_id !== null;
});
```

Filtered items appear neither as primary items **nor** under "Also on order", because `otherItems` derives from this already-filtered list. If every new item fails, `itemsWithDetails.length > 0` is false at [:869](backend/modules/tables/saveTableOrder.js:869) and `printKitchenOrder` is never called at all. The surrounding `try/catch` at [:886](backend/modules/tables/saveTableOrder.js:886) only fires on a thrown error, which this never is.

Note the filter tests `category_id !== null`, **not** whether the category routes anywhere — so an item in a real but unmapped category still passes and does appear under "Also on order". Only category-less and unknown-product items are erased.

### B3. Category depth ≥ 3 can never route

*Verified by reading: `backend/services/kitchenPrintRouting.js:37-119`; `src/admin/pages/Settings.vue:1261-1265`, `:751-766`; `src/admin/pages/Inventory.vue:997-1015`, `:1116-1142`; `backend/routes/pos/catalog.js:143-145`.*

Routing consults the item's own category and **exactly one** parent — [kitchenPrintRouting.js:68-70](backend/services/kitchenPrintRouting.js:68). The printer-assignment picker is also two-level: [Settings.vue:1261](src/admin/pages/Settings.vue:1261) `mainCategories` (parent_id null) and [:1263](src/admin/pages/Settings.vue:1263) `getSubcategories` (direct children), no recursion. Meanwhile category creation ([Inventory.vue:1116](src/admin/pages/Inventory.vue:1116)) and product→category assignment ([Inventory.vue:997](src/admin/pages/Inventory.vue:997), recursive `traverse`) both allow **unbounded** depth.

**Down-ranked on further evidence:** the register grid is two-level too — [catalog.js:143-145](backend/routes/pos/catalog.js:143), `subcategoryIdsFor` is not recursive. A depth-3 product therefore vanishes from the POS grid and would be reported as "product missing" before "kitchen ticket missing".

### The carrier that keeps B1 and B3 invisible: bundle children

A bundle parent in a healthy, mapped category browses and sells normally. Its **children** are never browsed directly, so a NULL or depth-3 category on a child is invisible in the UI — yet `expandBundlesForKitchen` puts those children on the kitchen ticket, where they fail to route. The same argument covers barcode- and search-sold products: [catalog.js:167-177](backend/routes/pos/catalog.js:167) applies **no** category filter on the search branch, so an orphaned product stays sellable while disappearing from the grid.

This is the most plausible way B1 or B3 survives unnoticed in a live venue, and it is **unproven without venue data**.

---

## Family C — loud failures, recorded for completeness

*Verified by reading: `backend/services/HeldOrderKitchenDispatch.js:306-394`; `backend/routes/pos/orders.js` catch/rollback blocks; `backend/routes/pos/subscriptions.js:727-738`.*

[HeldOrderKitchenDispatch.js:329-332](backend/services/HeldOrderKitchenDispatch.js:329) and [:372-374](backend/services/HeldOrderKitchenDispatch.js:372) throw `422 HELD_KITCHEN_UNROUTED_ITEMS` if **any** item is unrouted — the entire round is rejected and rolled back, including the items that did route. A second gate at [:339](backend/services/HeldOrderKitchenDispatch.js:339)/[:378](backend/services/HeldOrderKitchenDispatch.js:378) throws `409 HELD_KITCHEN_ROUTE_EVIDENCE_MISSING` when an expanded bundle child has no route. [subscriptions.js:738](backend/routes/pos/subscriptions.js:738) is the same shape.

These are **not** silent — the transaction rolls back and `sendError` returns the real message to the terminal. They prove the fail-closed pattern already exists in this codebase and was simply never applied to `printKitchenOrder`.

**This gives a second discriminating question for the venues:** when a ticket goes missing, does the cashier see an error, or does the sale complete normally with nothing printing? An error points at family C; silence points at A or B.

---

## Diagnostic SQL for a venue database

All read-only. Run the discriminator at the top of this document first.

```sql
-- B1: products that can never route
SELECT id, name, barcode FROM products WHERE category_id IS NULL AND is_active = 1;

-- B1/B3: products whose category maps to no active kitchen printer, parent included
SELECT p.id, p.name, p.category_id, c.name AS category_name
FROM products p JOIN categories c ON c.id = p.category_id
WHERE p.is_active = 1
  AND NOT EXISTS (SELECT 1 FROM printer_categories pc JOIN printers pr ON pr.id = pc.printer_id
                  WHERE pc.category_id = c.id AND pr.role='kitchen' AND pr.is_active=1)
  AND NOT EXISTS (SELECT 1 FROM printer_categories pc JOIN printers pr ON pr.id = pc.printer_id
                  WHERE pc.category_id = c.parent_id AND pr.role='kitchen' AND pr.is_active=1);

-- B3: categories deeper than 2 levels
WITH RECURSIVE t AS (
  SELECT id, parent_id, name, 1 AS depth FROM categories WHERE parent_id IS NULL
  UNION ALL SELECT c.id, c.parent_id, c.name, t.depth+1 FROM categories c JOIN t ON c.parent_id = t.id
) SELECT * FROM t WHERE depth >= 3;

-- Kitchen printers with no category mapping at all
SELECT p.id, p.name, p.is_active FROM printers p
WHERE p.role = 'kitchen'
  AND NOT EXISTS (SELECT 1 FROM printer_categories pc WHERE pc.printer_id = p.id);
```

---

## Candidate fixes, by payoff — none implemented

1. **Move `seenStore.begin()` to immediately before the transport write** ([server.js:871-875](pos-spooler-printer/server.js:871)), so render-stage failures stay retriable. Small change, highest value, and it does not weaken the double-print guard because a render failure cannot have reached paper.
2. **Make re-enqueue of a terminal row actually retry** — reset to `pending`, or have the ordinary path pass `returnStatus: true` and surface the rejection the way held orders already do.
3. **Include `dead_letter` in the staff failure badge** ([server.js:460](server.js:460)), or add a second counter. Today the one signal floor staff have goes dark precisely when it matters most.
4. **Make the routing path loud** — log `unroutedItems` and a zero-payload result, and stop returning `success: true` for `count === 0`.
5. **Stop orphaning products on category delete** — re-parent them exactly as subcategories already are, or block deletion while active products remain.
6. **Walk the full category ancestry** in the router and make the printer picker recursive to match.
7. **Stop the table path erasing items**, so unrouted items at least reach "Also on order" — the owner's stated expected behaviour.

Fixes 1–3 address family A and are independent of any menu data. Fixes 4–7 address family B. Fix 4 is worth doing regardless of which family the venue data implicates, because it converts every future occurrence from invisible to diagnosable.
