> Historical evidence only. The purchasing subsystem described below has been retired by the [POS inventory cleanup](../2026-09-09-pos-inventory-core-closeout.md). These checks are not current release evidence.

> Superseded for execution on 2026-09-09 by [POS inventory core closeout](../2026-09-09-pos-inventory-core-closeout.md). The user cancelled the warehouse/ERP expansion. Do not execute D–J or treat earlier completion claims as independently verified. Historical evidence below is retained.

# C operator workflows and C-specific J

Follow-up to `2026-09-08-stock-procurement-independent-review.md`. Implements the five remaining C operator gaps on `codex/ingredients-ui-fix` from `0be47f81`. A+B is not reopened. D–I and J for those packages stay open. No application database, push, deployment or hardware benchmark was involved.

## What this slice adds

- Paginated `/stock/identities` name search. `/stock/lookup` remains unique-match and still 409s when several names match.
- Supplier/pack lists expose item name and base unit. GET receipt adds `remaining_qty` and evidence-only `effective_unit_cost` / `price_corrected` (hidden from cost-blind readers). Numeric document-id search on receipts, returns and price corrections.
- One Receiving sidebar entry hosts receive, suppliers, purchase orders, vendor returns and price corrections. Shared business-day control. Server-paged search and load-more on each collection.
- Purchase-order receive binds `purchase_order_line_id` and remaining quantity. Duplicate supplier document refs require an explicit acknowledgement.
- CSV preview shows every row error, is editable, and creates a draft only on an explicit action. Staging keeps a stable `request_key` across lost responses and reload.
- Arabic copy for the new workspaces. 390 px tab layout wraps; 100-line drafts still render 20 rows.

Price corrections remain receipt-cost evidence. They dirty the physical day and do not post quantity or invent H valuation.

## Verification

Results overlap; do not add the counts together.

| Artifact/check | Result |
| --- | --- |
| `npm run test:isolated -- stockProcurement` | **22/22** on generated `posapp_review_recipe_p1_e686ceb0ddff`. Includes remaining quantity after a posted return, receipt-id search, identity paging, pack base units, PO remaining quantity and reader cost redaction of `effective_unit_cost`. |
| `npm run test:frontend -- receivingPage.spec.js sidebarNavigation.spec.js procurementPanels.spec.js` | **17/17**. Existing receive retry/history cases plus ambiguous identity listing, explicit import staging, PO line bind/ack, and panel setup checks. |
| `npm run build:admin` then `node scripts/reviews/stock-receiving-browser.cjs` | Existing English 1280 / Arabic 390 receive path still posts 7000, recovers a lost post without duplicate stock, and pages a 100-line draft at 20 rows. Added English supplier/pack, PO approve, source-line receive, return, price correction evidence, editable CSV plus lost-stage retry, and Arabic 390 tab overflow check. Evidence: `scratch/stock-receiving-browser.json`. |
| Architecture | `npm run architecture` / `architecture:check`: 269 nodes, 74 flows, 538 steps. |

Identity EXPLAIN in the isolated suite stays on `stock_items` with a small inspected row count. One-line and 100-line receipt query counts remain equal. No hardware or timing gate was run.

## Remaining gaps

- D counts, E recipe versions, F preparation, G locations/lots, H valuation/close and I purchasing intelligence are unimplemented. Their J workspaces depend on them.
- Reports still do not consume receipt or evidence costs. Do not present `effective_unit_cost` as carrying value.
- Cashier and inventory.read browser journeys were not re-run; API permission and cost-redaction tests remain the evidence for those roles.
- Camera scanning, multi-file import chunks beyond the 100-row draft cap, and payable/expense posting are out of this slice.

Cutover, rollback and installer baseline claims from the independent review are unchanged. This slice is local implementation only.
