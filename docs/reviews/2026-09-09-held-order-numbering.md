# Held orders use the checkout order number

The change follows three read-only Luna audits (numbering/lifecycle, printing, cashier UI), with the production paths checked again by the implementing agent. It changes the existing register-hold workflow, not progressive table split checks.

## Behavior

- An immediate hold reserves the same configured counter used by checkout. Shared mode uses the business-day counter; per-shift mode uses the originating active cashier shift. A hold with no shift uses the daily counter, as checkout does.
- The number is stored in `held_orders.order_id` and `order_seq_scope`. It survives reprints, edits, archive/restore, and payment. Checkout creates its invoice number only when the sale is finalized and carries forward the held order number.
- Example: hold **1**, normal sale **2**, payment of hold still **1**, next sale **3**. Removing a hold can leave a gap without affecting invoices.
- Immediate holds automatically queue the existing kitchen output and one customer copy in the hold transaction. A missing or ambiguous receipt printer preserves the hold and produces a visible printer-settings warning. A terminal's selected receipt printer is honored.
- Saving a scheduled hold does not reserve a number or print. Explicit kitchen fire or customer printing reserves once; changing the schedule to immediate automatically prints the appropriate copies.
- The held-card and details dialog have a customer receipt print action. A retry uses the same print request key. An intentional later print gets a new key but keeps the order number.
- The customer copy is explicitly unpaid and uses the canonical held receipt presentation, including tax/discount/modifier/bundle calculations. It prints an order number, never an invoice number, ticket/held identity, internal reference, payment, or fiscal QR. Normal sales, guest checks and progressive split checks retain their behavior.
- Older custom receipt templates without a safe held-number branch fall back to the built-in held layout. Browser printing receives a compiled server artifact and keeps it alive until the print dialog closes. The spooler's raw fallback also supports numbered held receipts.

## Upgrade and safety

The additive migration `2026-09-09-held-order-numbers-v1` adds nullable number/scope columns and a unique pair index. Automatic manifest hashes, the manual Hostinger block, baseline bootstrap, fixture chain and required schema checks are updated. Existing rows acquire their number on their next print/fire/immediate-save action; previously printed paper is not changed. A failed first-print transaction rolls back its number reservation.

Row locks and the existing write-based counter provide concurrency safety. No `MAX()+1`, invoice preallocation, per-item numbering query, or automatic retry of an uncertain printer job was introduced. Printing and checkout serialize on the held row, preventing a receipt from being generated from a hold already consumed by checkout.

## Verification

See the executable contract in `backend/tests/integration/heldOrderNumber.test.js` and the guarded real-browser workflow in `scripts/reviews/held-order-number-browser.cjs`.

Initial RED evidence: all three original contract cases failed before implementation. The first existing-flow regression run passed 71/71 held-order cases. Further tests cover mixed checkout numbering, duplicate/concurrent requests, scheduled transitions, per-shift numbering, prior-day identity, printer selection failure, canonical unpaid rendering, the legacy print API, and archive restoration.

Historical migration cases passed across the full-chain run and the corrected first-case rerun. The first-case rerun exercised the full July 29 upgrade and no-op reapplication; its result is in `scratch/held-migration-final.log`.

Browser acceptance checks Hold -> automatic kitchen/customer queue jobs -> held-card customer print -> Restore -> Checkout, verifies no repeated kitchen preparation at payment, and exercises the actual browser-print callback with a compiled iframe. Browser printing is intercepted in the test: this proves the UI/API/rendering path, not physical paper completion.

Final results (separate runs; overlapping cases are not counted as distinct tests):

| Check | Result |
| --- | --- |
| Checkout, held lifecycle, canonical printing, template parity/manager, Y archive and manifest regression | 505 passed / 20 files (`scratch/held-acceptance.log`) |
| Final held contract, kitchen dispatch, order-session state and platform settlement | 297 passed / 6 files (`scratch/held-last-paths.log`) |
| Historical automatic migrations | All 12 cases passed across the full run plus the corrected July 29 case rerun (`scratch/held-final-backend.log`, `scratch/held-migration-final.log`) |
| Focused frontend helpers | 37 passed / 3 files (`scratch/held-frontend2.log`) |
| Spooler fallback rendering and receipt presentation | `render-document.test.js` and `receipt-display.test.js` passed |
| Production frontend build | Passed (`scratch/held-build-latest.log`) |
| Real browser, spooler queue mode and browser-print mode | Passed (`scratch/held-browser-final.log`) |
| Architecture generation/check and whitespace diff | Passed |

The final browser script also checks that the held-card total and action row do not overlap, that the card shows the daily number, and that payment does not enqueue another preparation ticket. Rendered evidence is in `scratch/held-number-receipt.png` and `scratch/held-number-board.png`.

No deployment, production database migration, physical-printer certification, commit, or push was performed. The running application needs the updated backend and additive migration loaded on its normal restart/deployment.
