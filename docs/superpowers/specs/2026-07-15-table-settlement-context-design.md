# Table Settlement Context Design

**Status:** Approved in conversation on 2026-07-15
**Branch:** `codex/table-settlement-context`
**Baseline:** `18c561ff` (`feat(tables): capture current workflow baseline`)

## Purpose

Make table checkout, void, guest-check printing, joins, transfers, splits, and realtime refresh use one authoritative live table session. Eliminate cases where browser state names one table while invoice, discount, service charge, or async work belongs to another session.

This design stays narrow. It adds one deep backend module, tightens existing route logic, and fixes existing Vue session ownership. It does not add a new table state machine, event bus, queue system, or database migration.

## Current failures being fixed

1. Checkout accepts mismatched `table_id` and `edit_invoice_id`, then can settle one order while freeing or voiding another table order.
2. A stored automatic service-charge line can disappear when a stale checkout payload omits it.
3. Stored line or order discounts are treated as new cashier actions; preserving them can require manager authorization while omitting them charges more.
4. Checkout can return a missing-order response while its pooled MySQL connection remains inside a transaction.
5. Table save locks table before order, while checkout and void lock order before table, producing an avoidable deadlock seam.
6. Guest-check marking validates and updates separately, so concurrent checkout can leave an empty table blue.
7. Vue captures table identity after awaiting automatic service-charge creation. Leaving or switching tables can throw or write old-session state.
8. Service-charge promise ownership is global, allowing a late response from one table session to populate another.
9. Guest-check printing does not await print dispatch, ignores mark-status HTTP failure, and can mark a restored split's reused table blue.
10. Join accepts self, duplicate, missing, or structurally invalid children. Transfer accepts a joined child and can duplicate one order pointer across tables.
11. Partial table void broadcasts only the parent, leaving joined child totals stale.
12. Split discard reads outside its transaction and does not verify its delete claimed a row.
13. Cashiers allowed to settle tables cannot load another waiter's saved table unless they also receive edit override permission.
14. Realtime group updates use repeated single-table queries despite an existing batch helper.
15. One seeded permission test uses plain `INSERT` for a grant already present in the fixture.

## Goals

- Exact table-to-live-invoice binding before any checkout mutation.
- Database-owned saved items, discounts, prices, tax, modifiers, and bound service charge at table settlement.
- One MySQL lock order for live table operations: table group, order, items, service snapshot.
- Atomic guest-check status transition tied to expected live invoice.
- Vue async work owned by the session that started it.
- Blue table means guest-check print request was accepted, never merely attempted.
- Joined table group remains one root, zero or more children, one live invoice.
- Group-wide realtime refresh with one batch query.
- Fewer browser requests and no material checkout-query regression.
- Tests reproduce every repaired failure before implementation.

## Non-goals

- No physical printer acknowledgment protocol. Current queue and spooler cannot prove paper exited a printer.
- No new table status values.
- No database schema change.
- No rewrite of direct register checkout or held split settlement.
- No removal of transfer `swap` or `merge` behavior in this change.
- No broad Pinia or Composition API conversion.
- No change to paid-order refund accounting, stock rules, kitchen ticket content, or receipt design.
- No dependency upgrades or `npm audit fix`.

## Domain invariants

### Live table session

- Requested table resolves to one canonical root.
- Root plus every child is locked in ascending table ID order.
- Every member points to the same `current_order_id` and compatible status.
- Live order exists and has `payment_method = 'unpaid_table'`.
- Expected invoice equals root `current_order_id`.
- Order `table_id` equals canonical root.
- Any mismatch produces HTTP `409` with `TABLE_SESSION_CONFLICT`; transaction rolls back.

### Stored money

- Saved product lines and quantities must match checkout product lines.
- Saved rows own price, tax, modifier snapshot, modifier surcharge, line discount, and item identity.
- Saved order owns order discount.
- Bound service snapshot plus saved service line are restored even when browser payload omits the line.
- Preserving stored discount or bound service charge requires no new cashier permission.
- Adding a new manual discount or unbound service charge remains permission-gated.
- Table checkout cannot remove or alter stored money; edits happen through table-save or void workflow first.

### Printing

- Backend/spooler mode turns table blue only after `/api/print/print` accepts the queued job.
- Browser mode turns table blue after `window.print()` is invoked because no physical completion signal exists.
- Failed print request keeps table red and does not call mark-printed.
- Mark-printed includes expected live invoice and runs through locked table context.
- Restored split checks never mutate live table status.

### Vue session ownership

- Session token and table identity are captured before first table-scoped `await`.
- Every continuation checks token and table identity before reading or writing table-scoped refs.
- Automatic service-charge in-flight promise is keyed by session token plus table ID.
- Late old-session responses may complete network work but cannot mutate active refs, local storage, cart, or UI messages.

## Backend module

Create `backend/services/TableSettlementContext.js`.

### Interface

```js
const context = await lockTableSession(conn, {
    tableId,
    invoiceId,
    withMoney: true
});

const settlement = reconcileSavedTableSettlement({
    context,
    submittedItems
});
```

`lockTableSession` returns:

```js
{
    requestedTableId,
    rootTable,
    groupTables,
    groupTableIds,
    order,
    savedItems,
    serviceChargeSnapshot
}
```

`reconcileSavedTableSettlement` returns:

```js
{
    items,
    orderDiscount: {
        type,
        value
    },
    hasBoundServiceCharge
}
```

### Implementation

1. Probe requested table to find candidate root without a locking dependency on client invoice.
2. Lock root and children in ascending table ID order with one group query.
3. Revalidate requested membership, parent shape, shared invoice, and allowed status.
4. Compare expected invoice with root invoice before locking or mutating unrelated orders.
5. Lock exact order and validate `unpaid_table` plus `orders.table_id = root.id`.
6. When `withMoney` is true, lock saved items ordered by ID, validate bundle structure, then lock bound service snapshot.
7. Return plain context data. Module performs no commit, rollback, response write, permission check, print, or socket emission.

This is a deep module: small interface hides root resolution, group validation, lock order, exact binding, bundle validation, and stored-money reconstruction. Routes keep transaction ownership and action-specific permissions.

## Backend route changes

### Checkout

- Direct register and held split paths remain unchanged.
- Normal saved-table settle calls `lockTableSession` before current order-lock logic.
- Remove independent table resolution and mismatch branch.
- Use reconciled database-owned table items and stored order discount for totals and persistence.
- Run discount permission only for a newly introduced discount, never stored table discount.
- Run service-charge permission only for newly introduced unbound fee, never bound table fee.
- Mismatched table/invoice returns `409` before table release, ghost void, stock, payment, audit, or invoice numbering.
- Missing edit invoice throws inside transaction so shared catch always rolls back before release.

### Table save and void/refund

- Existing table save already starts with table lock; align later order/items/snapshot access with context ordering.
- Unpaid table void performs non-locking invoice-to-table probe, then locks context by exact invoice before mutation.
- Paid refund remains on paid-order path and does not acquire table locks.
- Refund item query stops locking joined `products` rows; product display data can be loaded without widening write locks.
- Partial void broadcasts root and all children from context.

### Mark printed

- Frontend sends `table_id` plus `expected_invoice_id`.
- Route begins transaction, locks identity-only table context, updates root and children to `printed`, commits, then batch-broadcasts group.
- Checkout and mark-printed serialize on same table lock. Whichever commits second revalidates current state.
- Response includes `table_ids`, `status`, and `invoice_id` for direct frontend patching.

### Join and transfer

- Join normalizes numeric unique child IDs and locks all affected tables in ascending ID order.
- Reject parent in child list, duplicate IDs, missing child, existing parent-as-child, child with another parent, and cycle-producing shape.
- Transfer rejects source or target when requested ID is a joined child.
- Existing parent transfer behavior remains: moving root releases its former joined children as currently designed.
- `swap` and `merge` remain supported and covered by existing tests.

### Split discard and realtime

- Split discard locks held row inside transaction, validates split type, deletes with affected-row check, writes audit, commits.
- Concurrent pay/discard loser receives `404` or `409`; it cannot write second success audit.
- Replace loops of `broadcastTableUpdate` with awaited `broadcastTableUpdates` where group IDs are known.
- Batch helper includes `waiter_id` to keep realtime table ownership equal to floor-plan payload.

### Cashier load

- `GET /table_order` allows `pos.checkout` or `waiter.checkout` actor to load another waiter's active table for settlement.
- This read allowance does not grant edit, void, split, transfer, or join rights.
- Frontend `canUpdateTable` remains false for settle-only cashier.

## Frontend changes

### Session capture

Add internal helpers inside `orderSessionStore.js`:

```js
const captureTableSession = () => ({
    seq: tableSessionSeq.value,
    tableId: activeTable.value?.id ?? null
});

const isCurrentTableSession = ({ seq, tableId }) =>
    seq === tableSessionSeq.value &&
    String(activeTable.value?.id ?? '') === String(tableId ?? '');
```

`updateActiveTableOrder` captures session before `ensureAutoTableServiceCharge`. It exits `false` after await when ownership changed. Payload uses captured table snapshot, not a later global ref.

### Service-charge request ownership

- Replace global bare promise with `{ seq, tableId, promise }`.
- Deduplicate only requests for same active session.
- Response writes `serviceChargeSnapshot` only when session still current.
- Leaving or switching clears ownership record; it does not need to abort network request.
- Manual non-table service-charge flow keeps its existing behavior with a non-table owner key.

### Print truth and performance

- `dispatchToNodeSpooler` returns `{ success, message }` for accepted and failed queue requests.
- `printReceipt` returns boolean success and always clears `isPrintingBackend` in `finally`.
- `printGuestCheck` awaits print result. Failure restores previous receipt state, keeps table red, and exits.
- Live table only: call mark-printed with captured table ID and invoice ID.
- Split session skips mark-printed.
- `markActiveTablePrinted` validates HTTP status/body before local mutation.
- Response patches `activeTable` and matching `restaurantTables` rows directly.
- Remove forced `loadTableWorkspace` after successful mark; socket broadcast remains cross-terminal source.

## Error behavior

- `TABLE_SESSION_CONFLICT` / HTTP `409`: table, invoice, group, or live-order state changed. Frontend refreshes table workspace and active order.
- `SERVICE_CHARGE_SNAPSHOT_CONFLICT` remains unchanged.
- Print queue failure shows existing printer toast and leaves table red.
- Deadlock error `1213`, if still encountered, is returned as retryable conflict; no generic automatic retry is added in this change.
- Post-commit socket broadcast failure is logged and does not turn committed business action into false client failure.

## Performance requirements

- Context group lock uses one query for root plus children after root probe.
- Checkout reuses context order/items/snapshot instead of loading same state again.
- Group realtime updates use one batch query instead of one query per table.
- Backend guest-check flow keeps print request plus mark request; removes subsequent floor-plan GET. Browser network count changes from three requests to two.
- No new deep watcher, interval, or whole-cart reactive clone.
- Focused benchmark records median and p95 for saved-table checkout and mark-printed before/after on local test DB.
- Refactor is accepted only when saved-table checkout query count does not increase and mark-printed browser request count decreases.
- Timing values are evidence, not flaky CI thresholds; correctness tests remain deterministic gates.

## Test strategy

Every production change follows red-green-refactor.

### Backend integration

- Reject mismatched table/invoice with no order, table, stock, payment, invoice-sequence, refund, or audit mutation.
- Restore omitted bound service-charge line and charge saved total.
- Preserve stored line/order discount for cashier without discount permission.
- Missing edit invoice leaves reused pool connection with `@@in_transaction = 0`.
- Concurrent mark-printed and checkout never end with `printed` plus null order.
- Concurrent save and checkout complete or return one explicit conflict without deadlock residue.
- Settle-only cashier loads another waiter's table but cannot save it.
- Self/duplicate/missing/cyclic join rejected without mutation.
- Joined-child transfer rejected without mutation.
- Partial void emits updated parent and children through one batch broadcast path.
- Concurrent split pay/discard produces one winner and one audit.
- Existing split, bundle, stock, service-charge, discount, and paid-refund tests remain green.

### Frontend unit

- Existing leave-during-save and switch-during-save tests turn green.
- Late service snapshot from table A cannot populate table B.
- Same-session duplicate service request is deduplicated.
- Print request rejection does not call mark-printed and keeps red state.
- Mark endpoint rejection does not mutate local status.
- Successful mark patches local floor state without workspace GET.
- Restored split guest check never calls mark-printed.
- Checkout receipt printing remains post-payment best effort and does not report successful charge as failed.

### Verification

- Focused backend integration suites run serially because they share `posapp_test` schema.
- Vue unit suites may run together.
- Run schema drift validator, syntax checks, spooler HTML test, admin build, and `git diff --check`.
- Inspect test DB connection state after transaction-error tests.
- Confirm root `master` remains unchanged and feature work is not merged.

## Rollout and compatibility

- No migration or setting required.
- Existing API request fields remain accepted. Mark-printed adds required `expected_invoice_id` only for current frontend; stale clients receive explicit `400` and must refresh/update.
- Existing table statuses, receipts, kitchen tickets, permissions, and report records remain compatible.
- Branch remains unmerged until explicit user request.

## Acceptance checklist

- All fifteen current failures or quality gaps above have direct code change or regression evidence.
- Existing baseline tests pass except failures intentionally converted to green by this work.
- No stored fee or discount can disappear at settlement.
- No table operation can mutate an order belonging to a different live table session.
- No old Vue table session can write into current session after await.
- Failed guest-check dispatch cannot turn table blue.
- Joined group state and realtime totals remain consistent.
- Focused performance measurements show no checkout query regression and one fewer guest-check browser request.
- Feature branch contains commits; `master` remains unchanged; no merge performed.
