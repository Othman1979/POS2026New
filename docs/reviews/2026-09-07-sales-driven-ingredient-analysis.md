# Sales-driven ingredient analysis: research and proposed operating model

Research date: 2026-09-07. This records the proposal before implementation. The approved delivery and measured results are in [the implementation review](2026-09-07-ingredient-analysis-delivery.md). Examples below are invented arithmetic scenarios, not restaurant measurements.

## Recommendation

Let an owner start with recipes and ingredient prices, then learn ingredient demand, meal revenue and estimated recipe margin from POS sales without entering opening stock. Add receipts, waste and occasional counts when they want stock control. These are two levels of completeness over the existing ledger, not two independent inventory engines.

Sales alone establish theoretical ingredient usage. They do not establish actual remaining chicken, unexplained losses or the true profit of an individual shawarma spit. Missing opening stock should remain unknown, never silently become zero or block sales analytics.

## What other systems do

- Toast distinguishes recipe-and-sales-based theoretical cost from actual consumption based on beginning inventory, purchases and ending inventory. This supports separating estimated demand from physical verification. [Toast: actual versus theoretical cost](https://pos.toasttab.com/blog/on-the-line/actual-vs-theoretical-food-cost/)
- Restaurant365 exposes actual usage, theoretical usage, waste and unexplained variance, with drilldown into contributing transactions. Its troubleshooting guidance includes receiving/unit errors, incomplete recipe mappings and portioning problems; variance should prompt investigation rather than an automatic accusation of theft. [R365 analysis](https://docs.restaurant365.com/doc/docs/actual-vs-theoretical-analysis), [R365 troubleshooting](https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis-troubleshooting-variances)
- Lightspeed O-Series describes capturing ingredient/product cost with the sale. It supports recipes, fixed cost and purchase-weighted costs from the preceding 30 days. This is a useful precedent for an operational estimate that does not require perpetual stock valuation. [Lightspeed costing](https://o-series-support.lightspeedhq.com/hc/en-us/articles/31329425820443-Calculating-your-Cost-of-goods-with-Lightspeed)
- Restaurant365 offers manual, last-received and weighted cost update methods. Its documentation uses inconsistent wording around whether “Last 3” refers to transactions or days, so that specific window should not be copied without clarification. [R365 cost update methods](https://docs.restaurant365.com/doc/docs/purchased-item-record-cost-update-method)
- Odoo AVCO recomputes average stock cost from old stock value plus incoming value divided by resulting stock quantity. Ordinary consumption removes value at that average without changing the unit average. This requires trustworthy quantity and value state. [Odoo 19 AVCO](https://www.odoo.com/documentation/19.0/applications/finance/accounting/get_started/avg_price_valuation.html)
- Oracle Hospitality Inventory Management separates last, average and standard costing. Outgoing usage uses the cost at transaction booking; its recipe preview also depends on the chosen cost center. This supports distinguishing current recipe previews from historical booked costs. It does not make a rolling purchase average equivalent to perpetual stock valuation. [Oracle costing methods](https://docs.oracle.com/en/industries/food-beverage/inventory-management/invug/c_costing_methods.htm)
- Restaurant365 supports ingredient yield percentages; USDA distinguishes as-purchased quantities from edible portions. These support explicit raw-to-served conversions, not assuming a universal shawarma cooking-loss percentage. [R365 ingredient yield](https://docs.restaurant365.com/docs/ingredients), [USDA meat yields](https://foodbuyingguide.fns.usda.gov/FoodComponents/ResourceMeat)

## Four different questions

| Owner question | Inputs needed | Honest result |
|---|---|---|
| How much chicken did these meals call for? | Sold/prepared quantities, historical recipe quantities, optional yield | Theoretical usage |
| How much did those meals earn? | Actual paid line amounts, discounts, refunds and tax treatment | Net revenue of meals containing chicken |
| What did their ingredients cost? | Historical recipe quantities and recorded cost basis | Estimated recipe cost and margin; partial if inputs are missing |
| How much chicken is physically left or missing? | A stock baseline, subsequent movements and later verification counts | Expected stock; actual variance only over a measured interval |

Revenue belongs to sale lines. A meal containing chicken, potato and bread must not have its full revenue added three times to a grand total. An ingredient drilldown may show “مبيعات الوجبات التي تستخدم هذا المكوّن”, but totals across such overlapping drilldowns are not additive. Default to no artificial allocation of revenue to individual ingredients.

## Worked shawarma example

Assumptions: quantities are cooked chicken on the plate, prices are net of discounts/tax, no refunds, measured yield is 80%, raw chicken price is 4 JD/kg, and all other recipe ingredients together cost 0.50 JD per meal. The 80% yield is illustrative, not a recommended real-world default.

| Meal | Sold | Net price | Meal revenue | Cooked chicken | Raw equivalent | Full recipe cost |
|---|---:|---:|---:|---:|---:|---:|
| 100 g chicken meal | 60 | 3 JD | 180 JD | 6 kg | 7.5 kg | 60 JD |
| 200 g chicken meal | 40 | 5 JD | 200 JD | 8 kg | 10 kg | 60 JD |
| Total | 100 | — | 380 JD | 14 kg | 17.5 kg | 120 JD |

Calculations:

- Cooked demand = 60 × 0.1 + 40 × 0.2 = 14 kg.
- Raw-equivalent demand = 14 / 0.8 = 17.5 kg.
- Chicken cost = 17.5 × 4 = 70 JD; other ingredients = 100 × 0.5 = 50 JD.
- Estimated margin after recipe ingredients = 380 − 120 = 260 JD (68.42%). Food cost ratio = 120 / 380 = 31.58%.
- Meal revenue per cooked kg = 380 / 14 = 27.14 JD/kg. This is a sales-mix productivity measure, not an ingredient selling price or guaranteed future revenue.

None of these demand/revenue calculations needs the opening weight of today's spit. Exact remaining spit weight and actual total spit profitability still need measured input/output and an attribution rule for the sales belonging to that spit.

## Yield without a manufacturing workflow

Ask once in recipe setup whether the quantity means purchased/raw weight or served weight. Under an optional preparation section, allow an understandable example: “كل 10 كغ قبل التحضير تعطي 8 كغ جاهزة للتقديم”. Show both the entered serving amount and the computed stock deduction before saving.

For the example, 100 g served consumes 125 g raw; raw cost 4 JD/kg becomes 5 JD/kg usable. Apply yield once. Do not also log the same expected cooking loss as exceptional waste. Discarded or spoiled portions beyond the modeled preparation loss are separate waste.

Yield belongs to the preparation/recipe relationship when different dishes use different preparation methods. Default unchanged recipes to direct stock-unit quantities, not a guessed cooking yield. Water-absorbing ingredients can increase in weight, so a universal assumption that every food yield must be below 100% is inappropriate.

Prepared/raw quantities must be comparable during counts. Initially keep counts in the stored ingredient basis and explain conversion. Separate raw and prepared inventories or reusable sub-recipes are later needs only if staff actually need to count both states independently.

## Weighted costs: two valid methods, different meanings

**Purchase-weighted estimate:** total valid purchase value / total purchased quantity in a defined cost window. Example: 10 kg at 4 JD plus 20 kg at 5 JD gives 140 / 30 = 4.666667 JD/kg, not the unweighted price average of 4.50. It works without knowing remaining stock, but is not the value of the stock currently on the shelf.

Proposed simple automatic mode: use priced receipts in the last 30 days as of the operation, following the documented Lightspeed pattern. Keep this cost window independent of the report's date filter. Label it “متوسط سعر الشراء” and show the window/source on demand. Maintain an explicitly entered reference cost as a fallback; otherwise mark cost unavailable. A stale last-known value can be shown as an estimate with its date, never silently as a fresh average. Unpriced receipts must not become zero-price purchases. Actual supplier credits/returns need explicit treatment rather than being mixed blindly into the average denominator.

**Moving weighted stock cost:** (old quantity × old average + receipt quantity × receipt price) / resulting quantity. After receiving 10 kg at 4 JD and consuming 6 kg, 4 kg worth 16 JD remain. Receiving another 10 kg at 6 JD gives 14 kg worth 76 JD, or 5.428571 JD/kg. The two purchases' simple weighted estimate would be 5 JD/kg; these answer different questions.

Recommendation: implement the purchase estimate for the no-count workflow first. Offer stock valuation only after a quantity AND value baseline and complete movement handling exist. Negative or unknown stock must not enter AVCO division as if it were valid inventory. An initial count alone does not establish initial inventory value.

Snapshot the cost source, unit cost and resolved recipe quantity when consumption is recorded. Reports sum those historical facts. A later recipe, price or yield edit changes future operations; it must not silently rewrite old margins. Corrections to receipts affect future cost resolution through a traceable policy. Restating closed historical costs is a separate explicit operation, not an incidental consequence of changing the report filter.

## Business days, revenue and stock events

Use the existing business-day parser/time-zone boundary for Today, Yesterday, Last 7 business days, This month and custom From/To. Show the actual range. Do not group a restaurant's late-night sales by midnight calendar date.

There are two clocks: ingredients can be consumed while an order is still open, but revenue is recorded when the relevant sale is finalized. A prepared order spanning business-day close must not make its ingredient cost disappear or attach it to unrelated paid sales. Keep an operations view by movement business date, and a meal-margin view matching finalized sale lines to their historical recipe consumption. Unpaid preparations remain explicitly separate from paid meal revenue.

Subscription payment and meal redemption also happen at different times. Do not assign the whole subscription payment to one redeemed meal or treat redemption as both new cash and new earned revenue. Reuse the subscription allocation rules where they exist; until attribution is verified, present redeemed meal usage separately from ordinary paid-sale margin.

Revenue should reuse the POS's reconciled discounted/refunded amounts, with a consistent tax-exclusive basis for the operational food-cost percentage. Discounts change revenue, not grams. Complimentary prepared meals have cost even with zero revenue. Order-level discounts and refunds must be allocated to lines with deterministic rounding so drilldowns reconcile to the sale totals.

Refunding a cooked meal does not automatically return edible ingredients. The present reversal/restocking behavior must be audited before calling the result actual physical consumption. Preserve established behavior during rollout; separate financial refund, cancellation before preparation, and food discarded after preparation through an explicit policy.

## Proposed UI operation

Keep the ingredients area and existing recipe editor. Add one clear entry: **تحليل المبيعات والتكلفة**, alongside the current stock operations. The detailed stock table remains the default inventory view as already requested.

The analysis opens with one period control and three primary numbers: **صافي مبيعات الوجبات**, **تكلفة المكونات المقدّرة**, **الهامش بعد تكلفة المكونات**. Label the margin as before wages, rent, delivery commissions and other overhead. Show recipe/cost coverage beside the figures; incomplete costs should not produce an apparently complete green profit figure.

Within analysis, offer two views:

- **حسب الوجبة:** meal, quantity sold, net revenue, estimated ingredient cost, margin. Selecting a row shows its recipe contribution and the sale lines behind it.
- **حسب المكوّن:** ingredient, theoretical quantity, estimated cost. Selecting chicken shows the 100 g/200 g meals responsible, their quantities and associated meal sales. Do not total overlapping ingredient-associated revenues.

Setup is recipe quantity plus a price, with preparation yield optional. Recording a delivery adds quantity and optionally line total or unit price; the form derives the other and updates future purchase-cost estimates. Counts stay optional: “أريد متابعة المتبقي أيضًا” leads to a first count, then the existing carried-forward stock model. No daily opening ceremony and no requirement to fill every ingredient before seeing useful demand numbers.

For an arbitrary period without matching physical counts, show theoretical usage and estimated cost. Offer measured variance for the actual count-to-count interval, visibly dated. Do not imply that a weekly count proves the actual losses of each intervening day.

An optional later “what could this spit produce?” calculator can accept available weight and yield, then estimate portions or revenue using a chosen meal mix. Label it a forecast. Loading already-owned chicken onto a spit is not another purchase receipt and must not increase total ingredient inventory twice.

## Current implementation: verified findings

| Area | Current source evidence | Consequence |
|---|---|---|
| Usage without counts | `RecipeLedgerService.syncKeyedLines` does not require a count; balance queries return null without a count | The no-count demand foundation exists; UI/reporting can expose it |
| Recipe snapshots | Movements record `unit_qty`, `product_qty`, `line_key`, product metadata and `unit_cost`; existing lines use recorded composition | Preserve this historical behavior rather than multiplying old sales by today's recipe |
| Purchase prices | `recordManualMovement` and `recordStockBatch` store receipt-specific cost; neither updates `ingredients.unit_cost` | Automatic purchase-weighted costing is not implemented |
| Missing cost | Summary aggregation uses `COALESCE(unit_cost,0)` | Totals can understate cost; expose completeness before showing reliable margin |
| Revenue denominator | `getDaySummary` divides used cost by `sales_collected`; financial metrics also expose `net_revenue_pre_tax` | This is not a product/ingredient revenue allocation; revise basis for the new report |
| Periods | `/reports/ingredients` calls a single-day summary; history has dates but is not a margin report | Add a bounded date-range analysis using existing period parsing |
| Open orders | `saveTableOrder.js` records recipe usage; checkout also synchronizes it without simple double consumption | Movement quantities are not automatically equivalent to paid sales quantities |
| Redemptions | Subscription routes record recipe usage separately | Revenue/cost attribution needs explicit treatment |
| Yield/modifiers | Resolved recipes cover own recipe or bundle-member recipes; no yield input exists in the reviewed recipe path | Add explicit serving conversion; audit extra-chicken/no-sauce modifiers rather than assuming coverage |
| Corrections | Quantity amendments use linked deltas; daily receipt/waste subtotals remain separately aggregated from corrections | Define gross versus corrected/net report measures; avoid double subtraction |

Source files: `backend/services/RecipeLedgerService.js`, `backend/routes/admin/recipeLedger.js`, `backend/routes/admin/reports.js`, `backend/services/financialEventMetrics.js`, `backend/services/dailyReportPeriod.js`, `backend/modules/tables/saveTableOrder.js`, `backend/modules/checkout/executeCheckout.js`, `backend/routes/pos/subscriptions.js`.

## Smallest complete delivery sequence

1. Define report meanings and coverage, then expose count-free demand plus matched meal revenue by business-day period using stored recipe facts. Clearly label unavailable historical records instead of inventing them.
2. Add purchase-weighted cost resolution and historical cost-source snapshots, with missing/stale-cost indicators. Add optional raw/served yield input and immutable resolved quantities.
3. Add matched meal margins, discount/refund reconciliation and explicit handling of open orders/redemptions. Keep current-cost pricing previews separate from historical margin reports.
4. Improve actual-versus-theoretical count comparisons and preparation-waste explanations. Defer full AVCO, lots, purchasing approvals and production orders unless restaurant operations actually require them.

No rewrite or new inventory framework is justified. Aggregate indexed movements and sales in SQL and paginate drilldowns; do not load all sales into the browser or join every sale to its recipe on each refresh. Cost resolution should be bounded and effective-dated, with rolling-window expiry handled explicitly. Reuse transaction locks and retry keys. Measure query count, latency, pool occupancy and checkout overhead before accepting performance claims.

## Acceptance evidence required before implementation is called complete

- No-count fixture: 60 × 100 g plus 40 × 200 g yields 14 kg served, 17.5 kg raw at 80% yield, stock unknown, and no forced count.
- Revenue fixture: 380 JD net meal revenue; 70 JD chicken plus 50 JD other recipe costs yields 260 JD estimated margin. Chicken/potato drilldowns cannot inflate the grand total.
- Cost fixtures: purchase-weighted 4.666667 JD/kg and AVCO 5.428571 JD/kg examples remain distinct. Cover free stock versus unknown price, supplier credits, corrected receipts, stale windows, zero/negative balance and repeated submissions.
- Historical fixture: change recipe/cost/yield after an earlier sale; its historical usage and costs stay unchanged. Missing pre-enable history remains explicitly incomplete.
- Time fixtures: configured close boundary, multi-day open order, next-day refund, split/merged tables and subscription redemption. Match paid-sale costs without losing or duplicating operational usage.
- UI fixtures: Arabic desktop/mobile, unknown-cost badge, partial recipe coverage, date-filter semantics, missing recipe, archived ingredient, and complete drilldown to source transactions.
- Precision and concurrency: fractional grams, integer money allocation, zero net revenue, duplicate retries, concurrent receipt/sale, and quantity corrections. Reuse existing isolated database boundaries.

This proposal provides operational estimates and reconciliation. It does not claim complete financial accounting, actual kitchen measurements or verified profitability from unmeasured inputs.
