# POS inventory cleanup — acceptance record

Date: 2026-09-09. Branch: `codex/ingredients-ui-fix`.

Code commits: `f0dc8506` removes the purchasing subsystem and warehouse controls; `a881609d` closes optional tracking and original-source return behavior; `d72b2215` invalidates stale count forms for shared and already-unknown stock. No deployment or push was performed. The current product boundary is [POS inventory core](../2026-09-09-pos-inventory-core-closeout.md).

## Current passing evidence

These are focused runs, not additive counts: some tests intentionally overlap. The last source run and pause-boundary run supersede earlier checks for the tightened saved-authority return filter. The final shared-pause run covers the last settings/version correction. The boundary filter selected five tests; its nine unselected tests had already passed in the full linked-writer run.

| Check | Result | Local raw evidence |
| --- | --- | --- |
| Broad acceptance | 113 passed | `scratch/inventory-cleanup-acceptance.json` |
| Final source regressions | 65 passed | `scratch/inventory-cleanup-final-source.json` |
| Final pause boundaries | 5 passed | `scratch/inventory-cleanup-pause-boundaries.json` |
| Final shared/unknown stock pause regression | 45 passed | `scratch/inventory-cleanup-shared-pause.json` |
| Frontend workspaces | 39 passed | `scratch/inventory-cleanup-ui-final.json` |
| Final table/navigation checks | 10 passed | `scratch/inventory-cleanup-ui-polish.json` |
| Final translation catalog | 3 passed | `scratch/inventory-cleanup-catalog.json` |

A prior 66-test lifecycle run also passed, including `stockLedgerCore` and `recipeLedgerService`. Its initial predecessor had one failing test assertion that counted other fixture items' movements; the assertion now scopes the count to its own stock identity. No old failed report is represented as current green evidence.

Commands used for the main acceptance:

```text
npm run test:isolated -- inventoryPosCosts inventoryScopeRetirement stockLinkedWriters inventoryOptionalModes stockActivation stockReportPackageB stockResolvedCompositions checkoutPerformanceContract businessDate
npm run test:isolated -- stockRead stockLinkedWriters inventoryOptionalModes inventoryPosCosts recipeLedgerPhase2Regression stockIngredientOrders stockIngredientActivation stockReportWorkerRunner
npm run test:isolated -- stockLinkedWriters -t paus
npm run test:isolated -- stockLinkedWriters inventoryOptionalModes inventoryPosCosts stockActivation
npm run test:frontend -- stockWorkingList sidebarNavigation inventoryStock ingredientsPage ingredientStockBatch productRecipe ingredientAnalysis reportFreshness i18nCatalog
npm run build:admin
node scripts/reviews/stock-working-list-browser.cjs
node scripts/reviews/stock-report-pagination-browser.cjs
npm run architecture
npm run architecture:check
```

Backend and browser runs used generated, allowlisted loopback databases, serially. They cleaned up their own fixtures. No application database was reset. Architecture generation/check and the production frontend build passed. `git diff --check` passed.

## Real flow assertions

- Sales and refunds succeed under all four independent product-stock/recipe flag combinations, including untracked products and ingredients without opening counts.
- Pausing linked stock succeeds, new sales record no inventory authority, original paid refunds/table voids restore the saved source once, and a repeated return cannot add stock again.
- A table edited or settled while paused releases its original reservation and replaces it with untracked sale lines; refunding that replacement does not invent another stock return.
- Shared ingredient/product balances clear the product cache and invalidate its old count form when recipe tracking pauses. Already-unknown product balances also advance their count version. Old counts reject; a fresh count succeeds.
- Counts recorded during a pause are withdrawn on resume. A later observed count restores reliable remaining quantities. Recipe analysis continues without a count. Existing recipe/mapping changes still preserve original usage and reversal snapshots.
- Actual ingredient receipt APIs produce the quantity-weighted base-unit estimate: 1 kg at 4 plus 3 kg at 8 gives 7/kg. A 200 g meal freezes 1.40 cost; 100 g waste freezes 0.70. Correcting the second delivery changes future estimates to 4/kg, while the original refund retains its 1.40 cost. Unpriced receipts use the reference fallback; an explicitly free receipt is known zero.
- Removed supplier/order/receipt-draft/return/correction/import mutation endpoints cannot create stock or purchasing rows. Retired permissions are excluded from staff reads and cannot be reassigned. Archived original receipts page 105 lines as 100 + 5 without duplicate or missing IDs.
- Transfer/preparation operations reject without changing the stock balance. The working list rejects warehouse/prepared-stock filters; its normal nonempty page uses two statements and no live movement-history scan.
- The report runner performs no coverage, balance-backfill or publication work while both features are disabled, then resumes automatically. Existing source-pressure yielding remains tested.
- Existing checkout query-bound tests, stock composition tests, report invalidation/publication tests and automatic business-day/parity tests pass. No manual inventory day close was introduced.

## Built browser evidence

Both scripts passed at English 1280 px and Arabic 390 px. Each checked the correct document direction, no page errors and no horizontal document overflow.

- The retained ingredient delivery dialog can receive an ingredient outside the current filtered list. The real balance moves 100 → 102 → 104 across the two language runs.
- The simplified quantity table shows three columns and two select filters, with no extra barcode column, location controls or Receiving sidebar entry. Final Arabic and desktop screenshots were captured; the Arabic screen was visually inspected.
- Reports traverse 105 distinct meal rows over three pages, find the last meal through search and open its actual source calculation. No supplier/purchasing setup is required.

Local screenshots and machine-readable browser results:

- `scratch/stock-simplified-en-1280.png`, `scratch/stock-simplified-ar-390.png`
- `scratch/stock-working-list-en-1280.png`, `scratch/stock-working-list-ar-390.png`
- `scratch/stock-working-list-browser.json`
- `scratch/stock-report-pagination-en-1280.png`, `scratch/stock-report-pagination-ar-390.png`
- `scratch/stock-report-pagination-browser.json`

## Completion boundary

The POS cleanup and its focused acceptance are complete. There is no remaining A–J expansion obligation: the excluded purchasing, warehouse, production, valuation and period-close packages are cancelled, not pending implementation. Historical migration schemas and original records remain for compatibility, not as active product workflows. The old C reports/handoffs are explicitly marked historical.

This evidence does not claim a full application release gate, production deployment, physical printer certification or hardware performance certification. None was part of this cleanup. No new dependency, service or accounting engine was introduced.
