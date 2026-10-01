# Ingredient analysis delivery and verification

Implemented on 2026-09-07 on `codex/ingredients-ui-fix`. This is operational recipe analysis, with optional stock verification. See [the research](2026-09-07-sales-driven-ingredient-analysis.md) for the comparison with Lightspeed, Oracle Hospitality, Odoo, Restaurant365 and USDA yield terminology.

## Owner workflow

1. Define each meal's ingredients and quantity per portion. Keep yield at 100% for quantities taken directly from stock. When entering served weight, optionally enter the measured preparation yield: 100 g served at 80% yield consumes 125 g of raw stock.
2. An ingredient's reference purchase price is optional. Record actual prices on deliveries when available. The preceding 30 business dates of explicitly priced receipts determine the quantity-weighted purchase estimate; otherwise the entered reference price is used. Unpriced and legacy receipts are not silently promoted to actual supplier prices. A recorded zero price is distinct from an unknown price.
3. Open **تحليل المبيعات والتكلفة**. Choose the business day or a date range, then view meals or ingredients. Revenue is paid meal revenue after discounts and refunds, before tax. Ingredient drilldowns identify the associated meals without adding the same meal's revenue repeatedly.
4. Optional counts enable actual-versus-theoretical comparisons between the first and last physical count inside the selected period. Dates of those counts remain visible. Deliveries, corrected delivery quantities and recorded waste explain that interval. Without counts, sales analysis still works and stock remains unknown.

The UI provides period presets, custom dates, search, 20-row table pages, ingredient-to-meal drilldown and 50-event invoice pages. Preparation activity, open-order consumption and subscription usage are separately explained. Arabic desktop and 390-pixel mobile layouts were checked in the in-app browser; the document did not overflow horizontally and the tested controls were 44 pixels high. Negative money is isolated left-to-right inside Arabic text.

## Calculation and history rules

- Existing POS tax calculations and integer-cent allocation distribute paid invoice net revenue across parent meal lines. Service/non-product amounts and missing item records are separately identified.
- Checkout freezes ingredient quantities and costs on each paid `order_items.recipe_cost_snapshot`, including split invoices, inside the existing transaction. Replays do not replace it. Refund analysis uses the original paid cost snapshot when available. POS order history does not expose this admin cost field.
- Older invoices with no paid cost snapshot derive estimates from their recorded preparation movements. They are labelled as older history; this does not retroactively reconstruct an exact historical invoice snapshot. Missing recipes/prices remain incomplete, even if today's recipe is later configured.
- Modified meals are conservatively marked incomplete because modifier-to-ingredient consumption is not mapped. A partial known cost is never presented as a complete margin.
- Yield converts entered served quantities to raw base quantities once. Stock deduction, previews and copied categories retain the correct yield and raw quantities. Existing recipes migrate with 100% yield and unchanged raw quantities.
- Weighted prices are estimates from the writer transaction's consistent read snapshot. A receipt committed after that snapshot is used by subsequent transactions. Avoiding a locking receipt-range read is necessary: an adversarial test demonstrated that absent receipt ranges could gap-lock unrelated ingredient inserts. Ingredient quantity writes still use existing ordered locks and current reads.
- This is not AVCO stock valuation, supplier accounting, batch production or measured kitchen profitability. Refund stock reversals retain the existing POS policy. Subscription purchase revenue is not arbitrarily allocated to redemptions. Supplier credits and price corrections are not new transaction types in this delivery; existing quantity corrections affect subsequent purchase estimates without rewriting paid snapshots.

## Evidence

The new calculations are exercised by `backend/tests/integration/ingredientAnalysis.test.js`. Its worked example produces 380 JD net revenue, 17.5 kg raw chicken demand, 120 JD total recipe cost and 260 JD margin without any stock count. It also covers next-day refunds, frozen split-line costs after later preparation, missing/modifier coverage, free versus unknown prices, correction effects, expired purchase windows, business-day boundaries, receipt retries and concurrent purchase visibility.

Focused verification:

- `npm run test:isolated -- recipeLedger ingredientAnalysis categoryPriceLists`: **122 tests passed across 19 files**, including the previously failing independent-ingredient concurrency case.
- `npm run test:isolated -- backend/tests/integration/ingredientAnalysisPerformance.test.js backend/tests/integration/categoryCopy.test.js`: **4 tests passed**, including retained yield on category copy.
- Full frontend suite: **558 tests passed across 92 files**. Subsequent focused analysis/recipe/page checks: **17 passed**. Production admin build passed after the final RTL money correction.
- Automatic migration unit suite: **43 passed**. Full historical migration integration chain: **12 passed** with a 90-second case limit. The older 30-second limit caused long DDL cases to time out and interfere with the next shared fixture; this file now explicitly uses the verified 90-second limit.
- `node scripts/reviews/ingredient-analysis-migration.cjs`: exact `edded956` predecessor upgrade, unchanged legacy values, current-schema no-op, normalized manifest hash/fallback parity, missing predecessor and checksum conflict rejection passed.
- `npm run architecture` and `npm run architecture:check` passed.

Browser acceptance used a disposable database at loopback port 3013. A sample containing 60 small and 40 large chicken meals showed 380 JD revenue, 17.5 kg chicken and 70 JD chicken cost. Changing the small recipe to 50% yield and recording a new 10 kg delivery at 6 JD/kg did not alter those paid invoices. This browser fixture had only chicken in the recipes, whereas the automated 120 JD example also includes other ingredients. The local application migration then preserved existing ingredient/movement counts, quantities and invoice totals. Existing local balances remained 150 kg chicken and 1050 g potato.

## Local performance measurements

Reproduce with `npm run test:isolated -- backend/tests/integration/ingredientAnalysisPerformance.test.js`; raw output is written to ignored `scratch/ingredient-analysis-performance.json`. Dataset: 1,000 paid one-line invoices, 900 priced receipts, 20 report rounds, 100 price lookups, and 20 new recipe/snapshot transactions.

| Operation | Mean | p95 | Work bound |
|---|---:|---:|---|
| Report over 1,000 invoices | 13.69 ms | 16.99 ms | 14 queries; invoice batches of 200 |
| Weighted purchase lookup | 1.50 ms | 3.07 ms | One batched query |
| Recipe synchronization | 2.27 ms | 4.46 ms | One new one-ingredient recipe line |
| Additional paid invoice snapshot phase | 0.66 ms | 1.05 ms | 5 queries |

Measured Node CPU averaged 10.95 ms per report. A meal drilldown returned 50 events in an 8,313-byte response. These are local MySQL/Node measurements, not low-end-device guarantees. Node CPU excludes the database process; recipe synchronization and snapshot timings are phases rather than full checkout timings. No physical printer, paper-speed or whole-device memory claim is made by this feature work.
