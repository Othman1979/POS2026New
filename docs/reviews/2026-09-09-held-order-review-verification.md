> Follow-up: the per-shift sequence issue documented below was subsequently resolved by permanent shared daily numbering. See [the final mapping and verification](2026-09-09-shared-daily-numbering.md). Earlier findings remain as the audit history.

# Held-order review: Grok findings and restore experiments

## Scope and verdict

Reviewed `docs/reviews/held-orders-and-branch-grok-audit.md` against the shared checkout on `codex/business-timezone-fix`, HEAD `f4ad123f9d16701920daf31385916981344586ae`. The implementation is in the dirty working tree; no commit, push, deployment, application-database migration, or physical print was performed.

The restore/reprint/re-hold behavior is implemented and verified. A held order keeps its reserved number. An unchanged re-hold queues no kitchen or automatic customer copy. Real preparation changes queue only the necessary additions and item cancellations, under the same order number. Checkout after those corrections keeps that number and does not send the kitchen work again.

**This is not a declaration that every branch-level finding is closed.** The per-shift/no-shift visible-number overlap is independently reproduced below. Pre-upgrade paper identity also requires operational treatment. Grok's scope and every finding were reviewed, but this pass did not independently re-audit every unrelated inventory, fiscal, or timezone file.

## Experiments and resulting fixes

| Experiment | Before | Verified result |
| --- | --- | --- |
| Restore, manually print, re-hold; repeat three times | Number reuse already worked | Number 1 throughout; one kitchen job, four customer jobs (initial plus three deliberate reprints); next new hold is 2 |
| Restore and increase quantity 1 → 3 | Save succeeded without a kitchen update | One FOLLOW UP for quantity 2 |
| Reduce quantity 3 → 2 | Rejected as sent-line conflict | One item-cancellation ticket for quantity 1 on the original station |
| Change preparation note on quantity 2 | Rejected as sent-line conflict | Cancel the old preparation quantity 2, then send replacement quantity 2 with the new note |
| Re-hold unchanged after those corrections | Not covered previously | No more jobs; five kitchen jobs total across the initial order and all corrections |
| Pay that corrected hold | Not covered previously | Paid order remains 1; kitchen job count stays five; next hold is 2 |
| Remove one of two previously sent products | Rejected | Only the removed item is cancelled; remaining item is not reprinted |
| Fractional quantity 0.1 → 0.3, then repeated saves | Not covered | One addition of 0.2, no floating-point cancellation/reprint on later saves |
| Original category mapping removed | Old tests required rejecting removals | Cancellation uses the durable original printer IDs, not the new category mapping |
| Original station disabled | Could be silently omitted | Real changes fail with no committed cart/queue change; an unchanged re-hold still succeeds |
| Printer route changes during a quantity increase | Snapshot could conflate quantities sent to different stations | Transaction rejects an increase that would mix station ownership for one retained preparation line |
| Browser UI: restore/re-hold twice, then checkout | Previously only one restore-to-checkout pass | All actual buttons succeed; order 1 retained; one kitchen job |

Implementation: `queueHeldKitchenChanges` in `backend/services/HeldOrderKitchenDispatch.js`, called by the claimed register-hold PATCH transaction in `backend/routes/pos/orders.js`. It compares with the sent snapshot, records cancellations on original stations, queues additions, updates the baseline, and releases the claim in the same transaction. Item cancellations use `void_ticket`, not the full-order cancellation heading. Existing call-center permissions and its explicit FOLLOW UP workflow remain in place.

The initial RED run proved the quantity-increase and removal defects: two failures, one passing unchanged-restore scenario. The later GREEN runs prove actual queue payloads and compiled output rather than only internal flags.

## Grok findings disposition

| Finding | Review and action |
| --- | --- |
| HO-TPL-BROWSER | Confirmed and fixed. Browser holds resolve the restaurant's active receipt revision without requiring a physical printer record. Real database tests preserve the custom header and revision ID. |
| HO-TPL-FALLBACK / HO-TPL-HEURISTIC / HO-TPL-VALIDATE | Confirmed and fixed. Removed the JSON-substring gate and the held-specific custom-template discard. The existing validated guest-identity slot becomes the order-number slot at render time; invoice/ticket/table identity and payment/QR bindings cannot appear on numbered held customer copies. No saved-template rewrite is required. |
| HO-TPL-COMPILE-ERR | Confirmed and fixed. Invalid or failed active held templates fail the transaction, instead of printing a factory replacement. Tests cover invalid persisted JSON structure and an actual compiler-error path. Ordinary paid-template fallback behavior is unchanged. |
| HO-KITCHEN-TICKET | Confirmed and fixed. Server-owned held kitchen metadata suppresses the Ticket coalescing in the model and spooler. Initial, follow-up, cancellation, and item-void paths keep the order number. |
| HO-KITCHEN-LEGACY | Confirmed and fixed for held dispatch. Held kitchen compilation fails explicitly rather than silently using legacy HTML. Older custom variants that omit an order field receive the mandatory order line without replacing the template. |
| HO-DUP-UNSCHEDULE | Confirmed and fixed. `_customer_receipt_requested` is persisted inside authoritative held cart JSON after an accepted queue/browser receipt request. It survives edits/archive data and cannot be replaced by submitted cart metadata. Printing a scheduled hold then clearing its schedule does not request another automatic customer copy. |
| HO-RETRY-KEY | Confirmed and fixed. The manual receipt UI retains its operation key on 409 review/conflict responses. Successful later deliberate reprints can still have new keys. |
| HO-REPLAY-BROWSER | Confirmed and fixed for create replay. A lost creation response can recover a compiled browser receipt for the already reserved number; backend replay adds no receipt job. Browser-dialog delivery cannot prove physical paper delivery. |
| HO-PRINT-LEGACY-ID | Confirmed and fixed. Legacy held receipt printing now requires a supplied request ID instead of generating a new random key for each retry. |
| HO-KITCHEN-SWALLOW / HO-KITCHEN-PARTIAL | The report conflated unassigned non-preparation items with disabled assigned stations. A POS may legitimately have no kitchen routing. Retained that behavior, but held initial/changed dispatch now rejects unavailable assigned preparation stations and rolls back instead of committing a partial held ticket. The general paid/table routing behavior was not redesigned in this pass. |
| HO-AUTO-RECEIPT-COMMIT | Confirmed configuration boundary, not silently treated as success: the frontend already shows “Order saved. Customer receipt was not printed…” for an unavailable printer. Kept the saved hold and visible warning when no receipt printer can be selected. Invalid custom compilation does roll back. Missing hardware configuration cannot establish an automatic-paper guarantee. |
| HO-TEST-MISLEAD | Confirmed. Replaced the test requiring custom-template fallback, added real active-template integration and compiled kitchen identity assertions, and expanded the lifecycle/browser tests. Updated old save tests that prohibited the newly authorized item-cancellation behavior. |
| TZ-BOOT-01 | Confirmed and fixed. Business-config fetch failure no longer prevents POS mounting; it logs the failure and retains the module's default clock configuration, matching the existing admin availability policy. This is not proof that a non-default venue clock is correct during a config outage. |
| HO-KITCHEN-XL | Boundary accepted: default and fallback item text is 36px. Saved custom font choices are retained. |
| HO-SEQ-CC-SHIFT | Independently reproduced; see the remaining issue below. Not silently changed to a global counter or worked around by disabling phone holds. |
| HO-SHIFT-ACTOR | Source confirmed for the first reservation of a still-unnumbered hold. It does not reallocate an already numbered hold: the allocator returns immediately. Choosing originating versus acting shift is a numbering policy decision, not a restore/reprint fix. |
| HO-MIGRATE-FIRED | Historical-paper limitation confirmed. An upgrade cannot rewrite tickets already printed with held-row IDs. Did not adopt the proposed automatic baseline reprint or block checkout, both of which introduce separate operational risks. New holds reserve before first dispatch and all tested later copies retain that number. |

## Remaining sequence issue, independently reproduced

`scratch/held-scope-experiment.cjs` created and removed its own guarded loopback database. With `shared_order_sequence=0`:

- A shiftless user's immediate hold reserved **1**, scope **date:2026-09-09**.
- A cashier's normal sale on open shift 1 reserved **1**, scope **shift:1**.
- The cashier then reprinted the hold successfully with its original **1**. No new hold number was allocated.

Evidence: `scratch/held-scope-experiment.json` and `.log`.

Thus Grok is right about the possible duplicate visible numbers across different scopes. The stored numbers are distinct by scope and restore does not change either. A single restaurant-wide queue requires shared daily numbering. The existing per-shift option intentionally permits separate counters, and shiftless phone holds add another scope. A separate change must settle that policy consistently for **both checkout and hold writers**, rather than silently assigning a phone order to an arbitrary cashier or changing restaurant settings during this repair.

## Verification evidence

All database work below used guarded isolated loopback fixtures, not the application database.

| Check | Result / evidence |
| --- | --- |
| Initial restore experiments | 1 pass, 2 expected RED failures; `scratch/held-restore-red.log` |
| Initial fixes | Restore cases GREEN; `scratch/held-restore-green.log` |
| Broad held/authority/compiler/routing run | 209 passed, 4 failures; three obsolete save expectations plus one fixture-cleanup error, all subsequently corrected; `scratch/held-review-acceptance.log` |
| Corrected held/authority/auto-fire run | **58 passed / 3 files**; `scratch/held-review-final-tests.log` |
| Final numbered-hold/compiler/parity run | **87 passed / 3 files**; `scratch/held-review-last.log` |
| Final targeted smoke after the last guards | **6 passed / 2 files**; `scratch/held-review-final-smoke.log` |
| Station-change ownership rollback | **1 passed**; `scratch/held-review-route-change.log` |
| Built admin/POS | Passed; `scratch/held-review-build.log` |
| Real browser hold/reprint/two restore-rehold cycles/checkout/browser receipt | Passed; `scratch/held-review-browser.log`, `scratch/held-number-browser.json`, receipt and board screenshots |
| Grok's A4 harness timeout recheck | **18 passed**, no timeout reproduced; `scratch/held-review-a4.log` |
| Spooler rendering and receipt-display scripts | Passed; includes all four held kitchen variants with order identity |
| Architecture generate/check and whitespace check | Passed; `scratch/held-review-architecture.log` |

Counts above are overlapping focused runs, not a claimed unique full-suite total. Physical paper delivery, installed-station versions, production migration, and an independent whole-branch release certification are not claimed.
