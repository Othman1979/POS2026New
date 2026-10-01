# Progressive Split-Check Evidence

## External workflow evidence

- Oracle Simphony Touch Split keeps the resulting checks open, assigns each a check number, permits independent modification, supports move/share, and can return an unsaved split to the original check.
  - https://docs.oracle.com/en/industries/food-beverage/simphony-essentials/simsl/t_check_func_split_check.htm
- Oracle seat filtering tenders one or more seats while the primary check remains open; paid seat items leave the primary check, and the final tender closes the primary check.
  - https://docs.oracle.com/en/industries/food-beverage/simphony/19.8/sipou/c_check_filter_and_memo_check.htm
- Oracle Add/Transfer combines open checks into a destination check.
  - https://docs.oracle.com/en/industries/food-beverage/simphony-essentials/simsl/t_check_func_add_transfer_check.htm
- Oracle explicitly gates incompatible split operations and prorates automatic service charges, proving that progressive settlement still needs strict financial/state validation.
  - https://docs.oracle.com/en/industries/food-beverage/simphony/19.8/sipou/c_error_messages.htm
  - https://docs.oracle.com/en/industries/food-beverage/simphony/19.4/simcg/t_checks_config_service_charge_for_memo.htm

## Current POS evidence

- `backend/modules/tables/splitChecks.js` currently voids and zeroes the parent, restores parent stock, releases the table group, and creates one `held_orders` row per seat.
- `backend/modules/checkout/executeCheckout.js` authenticates a held split from server provenance, deletes it under transaction, freezes split-time price/tax/discount/service-charge cents, and creates a paid child invoice with `parent_invoice_id`.
- Split checkout currently deducts inventory again because split creation restored the parent inventory.
- `src/pos/stores/orderSessionStore.js` clears the table session after split creation and restores a selected held split into the existing checkout flow.
- `src/components/TableSplits.vue` already supplies the operational unpaid-check board, print action, and one-check-at-a-time payment entry.
- JoFotara submission is keyed to finalized `orders.invoice_id`; paid split children already become independent legal invoice candidates. The unpaid parent is not submitted.

## Chosen minimal architecture

1. Keep `held_orders` as the unpaid split buckets; do not add a parallel check engine.
2. Add nullable relational `parent_invoice_id` and `table_id` columns to split holds so ownership, locking, remaining-count queries, and final release do not depend on JSON parsing or names.
3. Keep the original order `unpaid_table`, keep its order items and original inventory deduction, and keep the table group occupied while any split bucket remains.
4. Split-child checkout does not deduct inventory again.
5. The final split-child checkout atomically voids/zeroes the non-fiscal parent lifecycle row and releases the complete table group.
6. Before any child is paid, cancelling a split deletes the whole sibling group and restores the parent to normal editable-table service. After any child is paid, cancellation is rejected.
7. Normal parent checkout, save/edit, transfer, swap, merge, join, and disjoin are rejected while split buckets are open.
8. Existing cent allocation, price/tax freezing, bundle provenance, receipt presentation, split tender, audit, and JoFotara child-invoice behavior remain the sources of truth.

## Explicit non-goals

- No persistent seat assignment during ordering.
- No KDS work.
- No new split-check domain table or status framework.
- No combined tender of multiple split buckets in one checkout in this release.
- No arbitrary post-confirm item movement. Cancel-and-resplit is the safe minimal correction before the first payment.
