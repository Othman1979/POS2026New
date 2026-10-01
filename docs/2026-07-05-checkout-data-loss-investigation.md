# Checkout "Printed But No Invoice" Investigation — 2026-07-05

Customer claim: weak internet, checkout button lagged, receipt printed, cart/table cleared, later no invoice/order found in history.

## Verdict

**No confirmed code path** where checkout (register or table) prints a paid receipt + clears cart + fails to persist the order. Core flow verified airtight:

| # | Question | Answer | Evidence |
|---|----------|--------|----------|
| 1 | Cart clear without `success: true`? | No | `finalizeCheckout()` + `clearActiveTableSession()` + `printReceipt()` all inside `if (data.success)` — `orderSessionStore.js:2093-2142`. Network error -> catch -> cart stays (`:2150-2151`) |
| 2 | Print before checkout success? | No (paid receipt) | Print call at `:2142`, after success only |
| 3 | Backend print from client payload? | No | Numeric invoice -> full DB reload `print.js:288-329`, 404 if row missing. Client-built prints only: GUEST CHECK (forced `invoice_number: null`, `provisional`, `print.js:258-286`) and split `held` checks |
| 4 | Table checkout atomic? | Yes | Single txn `checkout.js:135` (begin) -> in-place UPDATE of unpaid_table order, items wipe+reinsert, stock, table release, ghost-void, `ensurePaidInvoiceNumber` `:737`, audit -> `commit` `:751` -> `sendSuccess` `:766` |
| 5 | Network-drop states | Before req: nothing. Mid-txn: full rollback, no print. After commit, response lost: DB HAS order, client shows error, cart NOT cleared, no print (orphan invoice = reverse of story) |
| 6 | Idempotency | Same-modal retry safe: pre-flight SELECT `checkout.js:112-119` + ER_DUP_ENTRY backstop `:791-800`. BUT key is memory-only (`orderUiStore.js:18`, generated at modal open `orderSessionStore.js:2016`) -> reload/close loses key -> re-ring = DUPLICATE invoice (extra row, never missing row) |
| 7 | Delete paths | Only hard delete of `orders`: table merge `tables.js:455-456`. Save-table wipes items `:1486`. Both lack `payment_method='unpaid_table'` re-check (rely on invariant + FOR UPDATE locks). No crons touch orders. Voids/refunds soft — rows stay |

## Plausible paths matching the story (ranked)

### P1 — Printed receipt was a GUEST CHECK, not a paid receipt (HIGH)
`src/print/PrintReceiptApp.vue:11-19`: no invoice -> header falls back to `Table: #N` / `Ticket: #N`. **No "UNPAID" marker and no payment-method line anywhere in the receipt block (`:4-58`)** — guest check visually ~= paid receipt (items, totals, "Thank you for your visit!").
Scenario: waiter prints check, customer pays cash, staff never settles, table later voided/vacated -> money taken, no invoice, table "cleared".
Disprove: receipt photo. `Invoice: #N` = paid. `Table:/Ticket: #` = guest check -> staff-process failure, not code.

### P2 — Order exists in DB, hidden by history filters (HIGH)
- Admin Orders default tab = Register -> `AND o.table_id IS NULL` (`Orders.vue:653/:857`, `admin/orders.js:76-81`). Paid TABLE order invisible on default tab. Filter applies **even during invoice search**.
- Search keeps stale payment/cashier/shift/filter_type filters (`admin/orders.js:54-81`) -> real invoice returns nothing.
- Cashier history: rolling 24h on `created_at` + hardcoded `LIMIT 200`, backend ignores `limit` param (`pos/orders.js:218-231`). Busy day -> oldest drop; table opened >24h ago, settled now -> excluded.
- 06:00 business-day boundary: paid orders bucket by `invoice_issued_at` (`admin/helpers.js:197-204`) — created 05:55 / paid 06:05 -> next day's bucket.
- Invoice # vs queue/ticket # are distinct exact-match searches; wrong box = no result.

### P3 — Duplicate + ghost-void confusion (MEDIUM)
Lost response -> reload -> new key -> two rows. Or table settle soft-voids stale ghost order (`checkout.js:714-723`) -> staff finds voided/zeroed row, thinks order gone; real paid invoice under different invoice_id.

### P4 — Environment/deploy mismatch (MEDIUM, code cannot disprove)
No migration tracking (`run_migration.js` seeds only `daily_sequences`); prod synced by hand; master ahead of origin unpushed; spooler deployed manually. Wrong DB (local XAMPP vs cloud) or stale build fully explains story. `invoice_sequences` mis-seed (current_value < MAX(invoice_number)) -> every paid checkout 500s (fails closed — alone doesn't match story).

### P5 — Merge/save destroys paid order (LOW — needs invariant break)
`tables.js:455-456` hard delete + `:1486` item wipe have no paid-status check. Requires `restaurant_tables.current_order_id` pointing at finalized order — no known path leaves that state; checkout FOR UPDATE locks prevent the race. Defense-in-depth gap only.

## Forensics for this incident

1. Receipt photo -> does it say `Invoice: #N`? (P1 kill shot.)
2. Direct SQL on prod DB:
```sql
SELECT invoice_id, order_id, invoice_number, payment_method, total, created_at,
       invoice_issued_at, table_id, shift_id, user_id
FROM orders
WHERE created_at BETWEEN '<t-1h>' AND '<t+1h>' AND total = <amount>;

SELECT * FROM orders WHERE idempotency_key LIKE 'TXN-%'
  AND created_at BETWEEN '<t-1h>' AND '<t+1h>';

SELECT * FROM audit_events
WHERE event_type IN ('void_checkout','table_merge','order_void')
  AND created_at BETWEEN '<t-1h>' AND '<t+1h>';
```
3. `print_queue` (durable spooler queue) — job payloads around timestamp prove exactly what printed, incl. invoice number.
4. Environment: which DB host the app pointed at that day, build hash, `SHOW COLUMNS FROM orders LIKE 'idempotency_key'`, `SELECT current_value FROM invoice_sequences` vs `MAX(invoice_number)`.
5. From customer: exact timestamp, total, cashier, terminal, payment method.

## Hardening candidates (NOT confirmed bugs — pending owner review, no plan written yet)

1. **Watermark guest checks**: big "UNPAID — NOT A RECEIPT" when `invoice_display_no` is null (`PrintReceiptApp.vue` + spooler template via docs/SPOOLER-CHANGES.md manual-deploy flow). Cheapest kill for P1.
2. **Persist idempotency key** in localStorage tied to cart hash until confirmed success -> kills reload-duplicate (P3).
3. **Paid-guard before destructive table ops**: assert `payment_method='unpaid_table'` before merge delete (`tables.js:455`) and save-table wipe (`tables.js:1486`), mirroring `checkout.js:190` (P5).
4. **History UX**: invoice/queue search should bypass `filter_type` + stale filters; `pos/orders.js order_notes` honor `limit` param and use business-day window instead of rolling 24h (P2).
5. **Migration version table** + boot-time schema guard (P4).
