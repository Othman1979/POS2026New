# Shared daily order numbering: mapping and removal

Date: 2026-09-09. Scope: remove per-shift display-order numbering from the current checkout. No deployment or application-database mutation performed.

## Product behavior

Every new display order number comes from the existing business-date counter. Cashiers share it regardless of their shifts. Immediate holds reserve once; normal checkout, unnumbered table settlement, and split checkout use the same allocator. A numbered hold keeps its number when restored, re-held, reprinted or paid. Scheduled holds remain deferred until their existing first-print/fire transition. Invoice numbering remains separate.

The settings toggle, API read/write field, pricing setting, bootstrap/fixture setting, and obsolete translation strings are removed. Old `shared_order_sequence=0` rows are inert; stale clients cannot restore the policy through settings saves.

## End-to-end map

| Boundary | Treatment |
| --- | --- |
| `backend/utils/orderSequence.js` | One atomic `daily_sequences` upsert returning its insert ID; business date required. No shift branch, extra counter read, or MAX+1. |
| `backend/modules/checkout/executeCheckout.js` | Always date-scoped allocation for new sales and unnumbered table settlement. Held identity reuse, paid-edit numbering, shift ownership/locking, invoice allocation and idempotency remain. |
| `backend/services/HeldOrderNumber.js` | Return existing identity immediately. Otherwise reserve from business date and persist under caller's transaction/row lock. Removed setting/shift lookup and obsolete actor/shift arguments at route callsites. |
| Held creation, restore/PATCH, follow-up, fire and receipt routes | All numbering converges on the same helper; print dispatch and snapshot-delta behavior remain. |
| Platform held settlement and table/split checkout | Consume the shared checkout implementation; existing held identities remain authoritative. |
| Archive/restore and print/browser/spooler readers | Continue transporting stored identity. They do not allocate numbers or read the removed setting. |
| Settings UI, Arabic dictionary, system API, pricing, installer bootstrap | Removed obsolete configuration surface. |
| `orders.order_seq_scope`, `held_orders.order_seq_scope` | Retained. Needed for date rollover and existing date/shift/legacy identities. Historical numbered holds are not renumbered. |
| `shifts.last_order_seq` and historical SQL migrations | Retained as inert compatibility schema. No runtime writer remains; no destructive schema migration needed. Cashier shifts/accounting remain active. |

## Tests-first findings and correction

Initial changed expectations failed in four places, with 35 passing: explicit disabled settings still produced shift scopes and split the shiftless/cashier sequence; the allocator still accepted per-shift operation. This is the RED evidence in `scratch/daily-only-red.log`.

After removal, the first six-file pass completed 70/70. A stronger concurrent experiment then reproduced a real deadlock between held creation and checkout: the hold owned its creator user row and waited for the daily counter, while checkout owned the counter and waited for the user FK lock during order insertion. The captured InnoDB deadlock is in `scratch/daily-only-deadlock.txt`.

Checkout now takes its user FK shared lock before other checkout locks/counter allocation. Held creation retains creator serialization, but does a nonlocking request lookup rather than locking a missing request-index gap. Existing replay rows are then read under their primary-key lock. This avoids cross-user missing-key insert contention while retaining idempotent creation and current replay state.

Resource tradeoff: allocation remains one DML statement. New holds remove one setting/shift read. Checkout's measured main-transaction query contract moves from 13 to 14 for the early FK lock. Existing hold-request replay gains a primary-key locking read. No background process, cache, new dependency, or new schema is introduced; this is a correctness tradeoff, not a claim of faster checkout latency.

## Verification

Final verification is complete. There are 121 distinct passing targeted tests across the runs below. Fixtures use fresh guarded loopback databases and are removed by the runners. They do not certify physical printer output or production deployment.

| Check | Result / evidence |
| --- | --- |
| `test:isolated -- sharedDailySequence heldOrderNumber orderSequence openTableNumbers checkoutPerformanceContract heldOrderAuthority platformHeldSettlement` | The six non-budget files passed all 95 tests. The performance file initially had 5 passes and 7 old-budget failures, all explained by the added shared-lock query. `scratch/daily-only-final.log` preserves this intermediate result, not an all-green claim. |
| `test:isolated -- checkoutPerformanceContract orderPricing checkoutModuleWiring` | 19/19 passed after updating every affected exact budget by one and asserting the early user-lock query. Includes all 12 performance contracts; line-count-independent budgets remain. `scratch/daily-only-contracts.log`. |
| `test:isolated -- backend/tests/integration/checkout.test.js -t 'business date / retried / order_id / invoice number' (regex alternatives)` | 7/7 selected tests passed (126 intentionally unselected), including the 06:00 business-day settlement boundary. `scratch/daily-only-rollover.log`. |
| `npm run build:admin` | Passed after final translation cleanup. `scratch/daily-only-build.log`. |
| `node scripts/reviews/held-order-number-browser.cjs` | Passed real built POS hold -> automatic kitchen/customer queue -> manual reprints -> restore/re-hold -> checkout. Number remained 1, an invoice was created only at payment, and no browser errors occurred. `scratch/daily-only-browser.log`, `scratch/held-number-browser.json`. |
| `npm run architecture`, `npm run architecture:check`, `git diff --check` | Passed. Architecture map includes unconditional date allocation and the user/counter lock ordering. |

The repeated mixed-cashier test starts at daily counter 70 and verifies exactly 71-74 across two sales and two holds, unchanged legacy shift counters, and two distinct invoices. Shift close/reopen verifies numbers 1 then 2 while preserving shift attribution and invoice continuity. Historical `date:` and `shift:` held scopes both survive checkout. Missing/zero/one obsolete settings all use shared numbering.

No remaining failure from these targeted runs is unresolved. No physical-printer or deployment completion is claimed.

## Rollout boundary

This implements the confirmed policy that customer installations already use shared numbering. Existing shared daily counters continue without reseeding. It does not renumber historical independent-shift records or reconcile their past visible duplicates. Do not run an old per-shift-capable server concurrently with the new binary against one database. Release/deployment is separate from this local implementation task.
