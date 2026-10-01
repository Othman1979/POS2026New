# POSApp recipe ledger: research and recommended first release

Historical research and proposal revisions follow. The implemented setting, line-key registry, costs, and verification are documented in the [completed Phase 4 review](reviews/2026-09-06-recipe-ledger-phase-4.md); earlier proposals below are not the current implementation contract.

Research date: 5 September 2026, revised the same day after an independent source audit and an owner clarification. Source checkout: `1c84ce17c4f90d6fae5982a99a28365cc533173d` on `codex/inventory-recipe-research`. Research only; this document does not authorize implementation or deployment. The implementation plan is in [docs/superpowers/plans/2026-09-05-recipe-ledger.md](superpowers/plans/2026-09-05-recipe-ledger.md).

## Owner intent (confirmed)

- This is a **recipe ledger of ingredient movements**, not an extension of the existing `products.stock` feature. The two must not be tied together. `products.stock` stays exactly as it is: a per-product sellable count with hard rejection, gated by `stock_enabled`.
- Ingredients are measured in whatever fits: grams/kilograms for chicken and potato, millilitres/litres for liquids, plain counts for Pepsi cans. One ingredient has one measure. "600 g of Pepsi" is a different ingredient row from "Pepsi (cans)".
- Tracking the remaining quantity is **optional**. The restaurant often cannot say how much chicken it has today. The ledger must be useful with usage totals alone ("30 kg used today"), and become a running balance only when someone enters a counted figure ("100 kg at 09:00"), after which it counts down and receipts count up.
- The ledger never blocks a sale for shortage. Persistence errors still roll back the transaction. Negative "remaining" is information, not an error.
- Refunds and voids are item/quantity based. A refunded meal reverses that meal's original ingredient quantities. Price overrides and discounts never change quantities. No money-based partial refund feature.
- Advanced underneath, simple on the surface: three screens (Ingredients, a Recipe tab in the product editor, Movements), three manual actions (Receive, Waste, Count).

## What exists today (verified in source)

| Area | Verified implementation | Consequence |
| --- | --- | --- |
| Product stock | `products.stock` `DECIMAL(16,6)`, `NULL` = unlimited; `stock_enabled` gates every mutation. `InventoryService.deductStockForCart` locks top-level products `FOR UPDATE`, sums cart quantities per product, rejects insufficient stock. | Untouched by this feature. The ledger integrates with the same sale lifecycles but requires its own saved-line provenance and writes outside stock guards. |
| Table save | Initial save deducts; every re-save calls `restockOrderItems(order_id)` then `deductStockForCart(cart)`; reductions are rejected with 409 and must go through the Remove/void path. | Ledger usage is written at the same points. Re-saves are frequent and must be idempotent for unchanged carts. |
| Checkout | Settling a table uses `edit_invoice_id` = the table order: restock at `executeCheckout.js:1580`, delete/reinsert rows, deduct at `:1679`. Progressive split children skip deduction; the parent is voided *without* restock when the last child settles (`:1861-1875`). Admin-only legacy path voids a different `old_table_order_id` with restock at `:1921` (after the deduct). | Table settle must not consume again. Progressive children inherit allocated parent usage; legacy children consume on settle. Refunds use saved line provenance, not parent_invoice_id alone. |
| Refunds / voids | `RefundService` and `voidOpenTableOrder` restore `quantity` per refunded top-level line, bounded by `remainingOf` (prior refunds). `refunds.restocked` records whether stock was touched. | Reversal rows follow the same lines and bounds. |
| Subscriptions | Redemption deducts the submitted items and stores `stock_deducted`; reversal restores via `restoreStockForCart`. | Same two hook points. |
| Held orders | No stock deduction anywhere in `routes/pos/orders.js`; kitchen fire, follow-ups, cancellation, claims, and Y archive/restore (`master_held`, 24 h expiry, same held id on restore) exist. | Release 1 does not consume for holds; a held order consumes when it is checked out. |
| Bundles | `product_bundle_items`, one level; persisted child `order_items` with `parent_item_id`; removed members are omitted and audited. `deductStockForCart` consumes the bundle parent only. | Recipe resolution expands members server-side and honours `removed`. |
| Modifiers / notes | Stable 8-hex option ids (`modifierDefs.js`); `selectedModifiers` may carry `noteProductId`. Tests assert note products are excluded from stock. | Modifier ingredient effects are deferred to release 2; option ids make it possible later. |
| Catalog admin | Product DELETE = `is_active=0`, blocked for bundle members and subscription sale products. Category copy inserts new product ids and zeroes copied stock (`categoryPriceLists.js:159`). Catalog replacement nulls `order_items.product_id` and physically deletes products (`import.js:97-127`). Operational reset deletes orders/holds/refunds/redemptions and leaves products. | Recipe lines copy with a category; replacement is blocked while recipe lines exist; reset leaves the ledger alone and history shows "source removed". |
| Deployment engine | MariaDB 10.4 (installer packages it; `2026-09-01-fractional-stock-precision-v1.auto.sql` comments on 10.4 behaviour). | Schema and locking guidance must be MariaDB's, not MySQL 8.4's. |
| Permissions | `/api/admin/*` is admin/programmer-only except printers, reprint, `order_details`, and failed print list. No inventory permission exists. | All ledger administration stays under admin authority. |

### Existing defects found during the audit

1. **`restockOrderItems` under-restores duplicated product lines (live bug).** It builds one `WHEN id = ? THEN stock + ?` per row; SQL `CASE` returns the first matching branch, so a product on two lines restores only the first line's quantity. Catalog taps always create a new cart line (`orderSessionStore.js:1934`; only barcode scans merge), so this is routine. Every table re-save or settle of such an order leaks the other lines' quantities from `products.stock`. Fix: make `restockOrderItems` delegate to `restoreStockForCart`, which already groups by product. This is independent of the ledger and is Task 1 of the plan.
2. **Replenishment overwrites concurrent sales.** `Inventory.vue:1232` computes `original + increment` in the browser and PUTs an absolute `stock`. Not in scope for the ledger; noted for the stock feature's owner.
3. **Refund stock restoration depends on the *current* `stock_enabled`**, not on whether the sale deducted (orders have no per-order flag, unlike refunds and redemptions). The ledger avoids this class of bug by having no global switch: usage rows exist or they do not.

## What other systems document (verified 5 Sept 2026)

- [Loyverse composite items](https://help.loyverse.com/help/how-create-composite-item): per-component quantity, components can be hidden from sale, tracking is optional per component, nesting up to 3. We adopt flat composition with optional counting and no nesting.
- [Loyverse stock adjustments](https://help.loyverse.com/help/how-work-stock-adjustments) and [inventory count](https://help.loyverse.com/help/how-work-inventory-count): distinct Receive / Recount / Loss inputs with reasons and history; counts confirmed before balances update. We adopt Receive, Waste, Count.
- [Loyverse negative stock alerts](https://help.loyverse.com/help/negative-stock-alerts): cashiers may continue a sale after a warning. We go further: the ledger never gates a sale.
- [Lightspeed K-Series stock levels](https://k-series-support.lightspeedhq.com/hc/en-us/articles/4407517612699-Stock-levels): recipe units vs. stock units with a capacity conversion. Its 4 − 0.06 example is printed as both 3.94 and 3.96; the arithmetic here is stated independently. We keep one base unit per ingredient and only kg↔g, L↔ml display conversion.
- [Toast xtraCHEF inventory analytics](https://support.toasttab.com/en/article/xtraCHEF-Inventory-Analytics): theoretical (recipe × sales) vs. actual (opening + purchases − closing) consumption, waste logged separately. It defines variance as actual − theoretical but prints "10" for 90 − 100. We label the running figure *Expected remaining* and store counts as anchors.
- [Toast recipe yield](https://support.toasttab.com/en/article/xtraCHEF-Recipe-Yield-and-Usable-Yield): 10 oz raw → 8 oz served at 80 %. We store the quantity the kitchen actually portions; an optional yield calculator is release 2.
- [Toast product mix mapping](https://support.toasttab.com/en/article/xtraCHEF-Recipe-Product-Mix-Mapping): modifiers map to ingredients and can subtract. Deferred to release 2, keyed by option id.
- [MariaDB DECIMAL](https://mariadb.com/docs/server/reference/data-types/numeric-data-types/decimal): exact fixed point; signed by default. Quantities use `DECIMAL(16,6)`, matching the existing stock precision.

## The model

Three new tables, no balance column, no global switch. Exact refunds additionally require server-authored recipe_ledger_snapshot fields on existing order_items and subscription_redemption_items and preservation through split held-order JSON. This is explicit additional schema scope, detailed in the [corrected plan](superpowers/plans/2026-09-05-recipe-ledger.md).

- **ingredients**: name, immutable measure (weight, volume, count), compatible display_unit (g/kg, ml/l, unit), active status. Measure is fixed from creation.
- **product_recipe_lines**: product/ingredient, positive base qty_per_unit, sort order; unique per product/ingredient.
- **ingredient_movements**: append-only signed base quantity and kind, usage_key, frozen unit_qty, immutable source/product/actor identities and labels, business date/time, optional refund reference, manual replay key/fingerprint and unique correction target. Durable history must not depend on disposable sales rows.

**Expected remaining** = latest Count + effective later movements. No Count means no remaining figure. Count accepts zero; negative expected remaining never rejects a sale. A wrong Count is replaced by a new Count. A receipt/waste correction negates its target, but affects remaining only when the target is AFTER the applicable Count: correcting an older entry must not alter a later physical count. **Used today** = negative sum of usage/reversal quantities dated today; refunds of older sales can make this net total negative.

**Resolution and freezing:** resolve each new accepted line's own recipe, otherwise its validated bundle members excluding removed members. Own bundle recipes override member recipes; notes contribute nothing. Freeze the entire composition with a stable usage key, including an explicit empty composition for no recipe. Never average matching product ids. A saved line's quantity increase uses its original composition; a newly added line uses the current recipe. Recipe edits, ingredient removal, or clearing the recipe do not change existing lines.

**Idempotent sync:** authenticate saved line ids and pin their snapshots server-side; preserve them through row replacement. Compare prior/desired allocations by usage key. Unchanged save/settle writes nothing. A pre-feature NULL snapshot is baselined empty on first edit, so historical meals are not charged retroactively. Only newly added lines use current recipes at cutover.

**Refunds and splits:** restore the exact allocation of the refunded sold line, bounded by that line's remaining refundable quantity. Split children carry disjoint allocations of the parent's frozen components; final-child rounding residuals preserve exact totals. Legacy children that consume on settle get their own usage origin. Merges preserve distinct tokens and immutable movement sources; do not pool variants or re-point historical rows.

## Lifecycle behaviour (release 1)

| Flow | Ledger behaviour |
| --- | --- |
| Cart edits, QR drafts, held-order save/fire/follow-up/cancel/Y archive | Nothing. |
| Table initial save | Usage rows for the accepted cart. |
| Table re-save (additions only; reductions are already rejected) | Difference rows only. |
| Table settle via checkout (`edit_invoice_id` = table order) | Difference rows only, normally none. |
| Direct checkout, held-order checkout, platform-held settle | Usage rows for the cart (same sync). |
| Admin legacy path that voids `old_table_order_id` and creates a new invoice | Reverse the old order's usage in full; usage for the new invoice. |
| Progressive split creation / rebalance / settle | No new usage; preserve and partition frozen parent allocations through held JSON and settled item rows. |
| Legacy (non-progressive) split children | Usage on settle, like any checkout; their parent's usage was reversed when the legacy split voided it, mirroring the stock code. |
| Item refund, full refund, open-table void | Restore the exact saved line allocation, using its immutable usage origin and remaining refundable quantity; full refund restores all remaining ingredients. |
| Subscription redemption / reversal | Usage rows at redemption; full reversal on reversal. |
| Table merge | Preserve distinct saved-line tokens/allocations; movement sources stay immutable after source order deletion. |
| Operational reset | Ledger untouched; history shows "source removed". |
| Catalog replacement | Blocked with 409 while any recipe line exists. |
| Category copy | Copies recipe lines to the new product ids, same ingredients. |
| Product archive | Recipe lines and history stay; nothing sells, nothing moves. |
| Ingredient archive | Blocked while an active product's recipe uses it. |

## Units and arithmetic

- Forms submit quantity AND the explicit input unit. The server validates the dimension and converts using that submitted unit, even if another admin changed display_unit. Use exact six-place arithmetic, validate range, and reject positive recipe quantities that round to zero. Split/refund residuals must conserve the original totals.
- No cross-dimension conversion. Grams never become millilitres or units.
- Worked example: recipe chicken 200 g, potato 100 g, Pepsi 1 unit. 150 meals → 30 kg, 15 kg, 150 units. With a count of 100 kg chicken before service, expected remaining is 70 kg. Without a count, the Ingredients screen shows "Used today 30 kg" and no remaining figure. A refund of one meal writes +200 g, +100 g, +1 unit reversals. A 30 % discount changes nothing.

## Operator workflow

Ingredients screen: name, unit, Used today, Expected remaining (or "—" with hint "Enter a count to start"), Last counted, with Receive / Waste / Count buttons per row. Movements drawer per ingredient: date range, keyset pagination, each row showing kind, quantity, running balance when anchored, who, and the source (order/table number, redemption reference, or "manual: spoiled"). Manual receipt/waste rows have a Correct action with a replay key and reason. Only one correction per target is allowed. History computes balances using all intervening rows, including hidden rows before a page/date filter; a correction superseded by a Count displays zero balance effect. Summary reads use today's indexed range plus the latest Count and bounded tail. All successful movement callers publish a post-commit refresh event, not just admin forms.

Product editor gains a Recipe tab (products and bundles): pick an ingredient by name, enter the quantity per one sold unit in its display unit, see "per 1 / per 10 meals" totals. Saving the recipe writes no movements.

Counts take effect at transaction commit. Ingredient-row locking serializes Count and sale movement insertion; a sale between opening the form and saving it is not a stale-screen conflict.

## Explicitly deferred (release 2 or later)

Modifier ingredient effects (extra chicken / no pickles), yield calculator, held-order kitchen-fire consumption, indivisible-unit admission rules, purchase orders and suppliers, costing/COGS, multiple stores, prep/nested recipes, forecasting, and any interaction with `products.stock`.

## Decisions carried into the corrected plan

Preserve the ledger during operational reset. A product may have both a recipe and products.stock because the features are independent. No per-product average approximation: removed bundle members and different recipe versions require exact saved-line allocations.

See the [correction evidence](2026-09-05-recipe-ledger-correction-evidence.md) for numbered defects, source anchors, executable arithmetic probes, and the boundary between verified design examples and future implementation tests.
