> **Execution cancelled: POS scope only.** Supplier/purchasing, warehouse/location, production, valuation and period-close work are retired. Do not execute remaining A–J packages. Follow [the current POS closeout](2026-09-09-pos-inventory-core-closeout.md).

# Inventory and ingredients advancement: evidence and implementation plan

> Superseded after adversarial review by [implementation contract v2](2026-09-07-inventory-implementation-v2.md). This document is retained as the original proposal, not the current implementation instructions. See the v2 contract for resolved scope, package dependencies, data/API contracts and measured resource gates.

Date: 2026-09-07. Source baseline: `e6ffd89b`, shared branch `codex/ingredients-ui-fix`.

Status: research and implementation proposal. No product code, database, permissions, or deployments changed for this plan. The previous restriction to keep inventory minimal is superseded by the user's request to advance it. Ease of daily operation remains a product objective.

## Recommendation

Build a restaurant stock workspace with reliable movements, purchasing, count sessions, accurate recipe coverage, preparation batches, and actionable replenishment. Do this in independently releasable stages, beginning with correctness. Do not begin by replacing the existing services, introducing a generic ERP framework, or rewriting working history.

The intended advantage is fewer steps from an operational problem to an explained, correct action. It is not a claim that our inventory mathematics are novel or that competitors are less capable. Competitor documentation establishes available patterns; only comparative user testing can establish that our implementation is easier. This is a bounded review of the directly relevant implementation and official documentation, not an exhaustive certification of every stock writer or every competing product.

## Evidence: current implementation

| Finding | Source inspected | Implication |
|---|---|---|
| Product stock is a nullable quantity on `products`; checkout deducts it under locks and can reject insufficient stock. | `backend/services/InventoryService.js`, `deductStockForCart`, `restoreStockForCart` | Preserve existing sale availability policy until an explicit per-item migration. |
| Quick replenishment reads a browser quantity, adds an increment, and PUTs the resulting absolute stock. The product route writes that supplied value. | `src/admin/pages/Inventory.vue`, `quickReplenishStock`; `backend/routes/admin/products.js`, product PUT | Code-supported lost-update risk: browser sees 10, sale makes 9, receipt +5 sends 15 instead of producing 14. A transaction around the absolute UPDATE does not solve this. Not reproduced with a concurrent test during this research. |
| Ingredient movements and product stock have separate authorities. | `RecipeLedgerService.js`; `InventoryService.js`; `RefundService.js` | A common UI must not imply shared balances. Mapping a packaged product to an ingredient could otherwise cause two deductions. |
| Ingredients have receipt, waste, count, correction, usage and reversal movements, operation keys, and ordered ingredient locking. | `RecipeLedgerService.js`, `recordStockBatch`, `correctManualMovement`, `lockLineIngredients` | Reuse these guarantees; do not replace them with direct balance edits. |
| Balances remain unknown until a count. A later count supersedes earlier quantity history for current balance. | `countExpectations`, `currentBalanceSql`, `effectiveBalance` | Keep sales-only adoption possible. Unknown is not zero. Corrections before a newer count must not move the current balance. |
| Ingredient prices use the preceding 30 business dates of explicitly priced receipts, weighted by corrected quantities; otherwise reference price or unknown. | `resolveIngredientCosts` | This is a purchase estimate, not perpetual AVCO inventory valuation. Do not label it inventory asset value or accounting COGS. |
| Paid invoice recipe costs are frozen; older history has a labelled fallback. Modified meals are conservatively incomplete. | `IngredientAnalysisService.js`, `captureInvoiceCosts`, `getAnalysis`; `docs/reviews/2026-09-07-ingredient-analysis-delivery.md` | Modifier coverage is a high-value accuracy improvement. Never rewrite paid snapshots using a new recipe. |
| Shopping suggestions currently compare known balance with par and round to packs. | `RecipeLedgerService.js`, `getShoppingList` | No current supplier lead-time, open-order, or demand forecast is used in this calculation. |
| Current recipe composition resolves a product recipe or bundle members; ingredients are direct components. | `RecipeLedgerService.js`, `resolveComposition`; `backend/routes/admin/recipeLedger.js` | Preparation stock and order-type/modifier composition need explicit design, not extra UI fields alone. |
| Forms handle operation entry but no supplier receipt document, persistent count session, or preparation document appears in the inspected stock flow. | `IngredientStockBatchModal.vue`, `IngredientHistoryDrawer.vue`, recipe route/service | These are proposed additions. Full schema and writer inventory is a required implementation preflight, not an assumption that no adjacent module exists anywhere. |

Historical verification is recorded in `docs/reviews/2026-09-07-ingredient-analysis-delivery.md`: 1,000-invoice report p95 16.99 ms and recipe synchronization p95 4.46 ms on that local workload. Those are previous measurements, not newly reproduced results or low-end-device guarantees. The current UI's 567-test pass and build do not prove concurrent product replenishment, new features, or production scale.

## External evidence and what to adopt

1. [Oracle receiving](https://docs.oracle.com/en/industries/food-beverage/back-office/20.1/invug/c_receiving.htm) supports receiving against purchase orders or directly from a list. Adopt optional ordering: a delivery must remain recordable without creating a purchase order first.
2. [Restaurant365 inventory counts](https://docs.restaurant365.com/docs/new-inventory-counts-overview) describes storage-order templates, spot counts, review and approval, and mobile entry. The cited new counts feature is explicitly in beta for selected customers. Adopt shelf-order counting and resumable sessions; do not reproduce its entire permission tree or assume its beta UI is universally deployed.
3. [Oracle menu-item linking](https://docs.oracle.com/en/industries/food-beverage/back-office/20.1/invug/c_mi_linking.htm) supports portion ratios and order-type recipes, including takeaway packaging. Adopt explicit recipe changes for modifiers and order type.
4. [Restaurant365 recipes](https://docs.restaurant365.com/docs/recipe-items-page) supports recipes used as ingredients in other recipes. Adopt a bounded preparation model first, because raw chicken becoming cooked chicken is operationally distinct from a formula that only expands at sale time.
5. [Restaurant365 actual versus theoretical analysis](https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis) provides count-based comparisons, waste, unexplained variance, drilldowns and costing choices. Adopt actionable variance investigation. This is established functionality, not a unique differentiator.
6. [Odoo reordering rules](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment/reordering_rules.html) documents forecast/min-max replenishment and vendor lead times. Adopt transparent suggestions with a manual review step; do not automatically send supplier orders.
7. [Odoo expiry tracking](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/product_management/product_tracking/expiration_dates.html) and [removal strategies](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/shipping_receiving/removal_strategies.html) support expiry-aware lot selection. Adopt optional lot recording only when users can record reliable batch information.
8. [Odoo stock valuation](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/inventory_valuation/operations_valuation.html) distinguishes stock movement valuation and costing policies. Treat valuation as a separate financial subsystem with its own reconciliation and migration criteria.

These sources were searched during this review. Odoo reordering and valuation findings were available in indexed official documentation; direct retrieval of some Odoo pages timed out. No competitor sandbox, paid module, resource benchmark, or operator study was performed.

## Product experience

Retain clear Arabic destinations. Rename catalog management to **المنتجات** when navigation is reorganized; use **المخزون** as the operational parent. Its children should be **نظرة عامة**, **المواد والأرصدة**, **التوريدات**, **الجرد**, and, when enabled, **التحضير**. Keep financial/consumption analysis under Reports with direct contextual links. Recipes remain reachable from both a product and an ingredient. Preserve old URLs through redirects; do not create two separate pages called المكونات.

The overview answers three questions: what needs action, what changed, and which records explain it. Show only actionable cards, each opening a filtered working list. No duplicate period selector, no stack of unrelated tables, and no unexplained revenue attributed to an ingredient as though the ingredient itself was sold.

Use the shared ink palette, right-aligned Arabic table starts, isolated numbers/dates, readable labels and keyboard/touch controls. Receiving and counting become full workspaces when many lines are present; small quick actions can stay dialogs. Advanced capability is enabled per workflow, not exposed as twenty settings before the first receipt.

### Worked operator journeys

- Delivery: choose supplier if known → scan/select items → enter packs and loose quantities → review quantities/prices → post once. A short delivery remains partially received; expected and actual quantities are distinct.
- Count: select kitchen/fridge/template → resume saved entries → count in shelf order → resolve only changed/conflicting items → finalize. Blank means uncounted, never zero. Approval is optional for an owner-operated location.
- Shawarma preparation: record 10 kg raw input and 8 kg cooked output → raw decreases once, prepared stock increases once → a 200 g cooked portion uses 200 g prepared stock. It does not consume another 250 g raw stock at sale time.
- Variance: open a high unexplained difference → see exact count interval, receipts, waste and recipe consumption → correct an entry, record a fresh count or inspect the recipe. The system must not invent a cause such as theft.
- Purchasing: see projected need and confidence → review pack rounding, incoming orders and supplier lead time → save a draft order. Exporting is separate from sending externally.

## Architecture decisions

1. Keep product identity/menu pricing separate from stock identity. Initially preserve both existing authorities. Add product stock movements around the current product writer path; a stock workspace can query both through explicit typed references. Do not create an unconstrained generic entity table.
2. For items later migrated to shared stock, use an explicit product-to-stock-item mapping and an authoritative tracking mode: untracked, legacy product quantity, or recipe/linked stock. Only one stock deduction path may own the same physical units. Allow menu availability limits to remain a separately named concept. Migration requires per-item reconciliation and a watermark for open orders.
3. Each posted document has a stable idempotency key and payload digest; retries return the original result, conflicting payloads reject. Store actor, effective business date, actual event timestamp and correction references. Server-side drafts do not affect stock.
4. Write document state, movement rows, balance updates where applicable, and audit entries in one transaction. Lock affected items in ascending order, then emit after commit and connection release. Do not call suppliers, printers or long-running report work inside it.
5. Reuse current decimal quantity precision and established POS money allocation. New valuation arithmetic must use fixed-point/decimal operations, with explicit rounding residuals. Do not introduce floating-point stock-value accumulation.
6. Preserve immutable sale composition and original reversal costs. Financial refunds and physical stock returns become explicit separate decisions for new flows; never assume refunded cooked food goes back into raw stock. Existing behavior remains until a tested, forward-only policy migration.
7. New tables below are candidate boundaries, not final DDL. Inspect existing migrations and adjacent modules before selecting names or adding duplicates. Keep large existing modules when cohesive; extract only a new domain with its own lifecycle.

## Delivery sequence and acceptance criteria

### Release 1 — trustworthy stock operations and coverage

**P0: product replenishment correctness.** Add an atomic delta endpoint to replace browser-calculated absolute stock for receipts. Add an idempotent product movement journal recording opening baseline, receipt, sale, return and explicit count/adjustment. InventoryService, product editing/import, RefundService and all other stock writers must be enumerated and migrated or rejected for tracked stock. Never dual-apply a movement and an existing subtraction.

Candidate `product_stock_movements` links to product and source operation. Retain `products.stock` as a transactionally updated projection initially. Establish an opening baseline at activation; do not fabricate historic movements. Existing null/untracked values remain null. Absolute counts use a reviewed operation with current-state conflict detection, not an unguarded product PUT.

Acceptance: start at 10; concurrent sale -1 and receipt +5 produce 14 in either lock order. A retried +5 receipt remains 14, not 19. Concurrent +5/+7 produces 22 before any sale. Lost responses, imports, refunds, disabled stock, decimal quantities and stale count submissions are covered. New journal replay reconciles to the projection after its activation watermark.

**P1: modifier/order-type recipe coverage.** Map stable modifier IDs to ingredient deltas; order-type packaging is explicit. Require an explicit no-stock-effect designation for modifiers without ingredients. Freeze resolved composition at the existing preparation boundary and preserve paid snapshot behavior. Unsupported modifiers remain visibly incomplete.

Acceptance: added chicken, removed sauce, takeaway packaging, bundles, table edits, partial refunds and split checks neither double-deplete nor silently lose cost coverage. A recipe edit does not change an earlier paid invoice. Custom text does not pretend to identify a known ingredient.

Primary touchpoints: `Inventory.vue`, `backend/routes/admin/products.js`, `InventoryService.js`, `RefundService.js`, `backend/routes/admin/import.js`, `recipeLedger.js`, `RecipeLedgerService.js`, `IngredientAnalysisService.js`, product recipe editor and related order/split paths. Complete writer tracing is the first implementation task.

### Release 2 — receiving and count workspaces

**P2: supplier-linked receipts.** Add minimal suppliers, supplier pack mappings and receipt header/lines. Record supplier document reference, prices, received quantities, discounts and tax treatment separately from selling price. Direct receipts stay available. Add draft purchase orders only after receipt posting is stable; partial receiving derives outstanding quantities from posted receipts, not an editable status flag. Vendor returns and price-only corrections have explicit documents.

Candidate boundaries: `suppliers`, `supplier_items`, `stock_receipts`/lines, later `purchase_orders`/lines. Each line references exactly one supported stock authority. Receipt posting calls the relevant product/ingredient writer inside one transaction. Historical ingredient deliveries can be shown as legacy operations without invented suppliers or invoice totals.

Acceptance: 3 packs × 2 kg + 0.5 kg = 6.5 kg; pack-price conversion is unambiguous; duplicate invoice references warn within supplier scope; identical retry posts once; partial deliveries conserve ordered/received/returned quantities. Unknown purchase cost remains unknown. This is procurement tracking, not accounts payable or a claim that purchase totals equal recognized expenses.

**P3: durable count sessions.** Add count templates, draft sessions/lines and storage-area labels for ordering. Areas initially organize counting; they do not imply independent warehouse balances. Persist drafts, expose save state, allow optional blind counts and review significant differences.

Concurrency policy: capture a per-item movement watermark when its quantity is observed. If that item moves before finalization, require explicit reconfirmation/recount; do not silently treat an old observation as the current count. Unaffected lines can remain saved. A later implementation may support timestamped reconciliation, but not by guessing the timing of physical movements.

Acceptance: reload resumes a draft; two devices cannot overwrite each other's edits; blank/zero are distinct; sales during a count surface a conflict; an approved count posts once; changing a template cannot rewrite an active session. Verify phone entry and realistic 100-line counts. Optional approval requires separate enter/post permissions enforced on the server.

### Release 3 — preparation and decisions

**P4: prepared stock.** Add a preparation recipe/version and posted preparation batch. Consume measured raw inputs and produce measured output atomically. Support one preparation layer initially and reject cycles; plan deeper nesting only with a demonstrated need. Costs transfer from inputs to outputs; preparation loss is reflected by output yield rather than charged twice. For the first release, no arbitrary by-product cost allocation.

Acceptance: 10 kg input at 4/unit with 8 kg output gives total batch cost 40 and output unit cost 5 when all inputs are costed. Selling 0.2 kg consumes 0.2 kg prepared stock and cost 1, not raw stock again. Unknown input cost makes output cost incomplete. Batch correction with downstream consumption is an explicit adjustment, not deletion of referenced history.

**P5: actionable replenishment and variance.** Upgrade `getShoppingList` from fixed par to transparent optional demand coverage. Start with comparable business-day averages, not machine learning. Suggested quantity = max(0, demand over lead time plus review interval + safety stock − usable known stock − eligible incoming quantities), rounded to supplier packs. Track sales and stock usage separately; count corrections and supplier receipts are not demand. Avoid counting prepared stock and its raw equivalent as two supplies.

Show inputs, last count age, missing data and confidence. With insufficient history or unknown balance, use manual par and request a count rather than show false precision. Expiry risk is not used until lots are reliably tracked. Variance reports show a precise count interval and prioritize quantity/value differences with known cost coverage.

Acceptance: explain every suggestion from visible inputs; no negative order; receipt/cancel/return updates outstanding supply once; short history falls back; a closed/no-sale day is not blindly treated as normal demand. Report totals reconcile to drilldowns and distinguish paid sales, preparation and subscription activity.

### Release 4 — advanced optional control

**P6: lots, expiry and real storage transfers.** Enable per item. Receiving assigns lots; batch output can have expiry. FEFO is a picking suggestion unless actual lot consumption is captured; do not claim traceability from a suggestion. Expired stock requires recorded disposal and cannot silently vanish. Moving between locations conserves total units and carrying value, with explicit in-transit state for separate dispatch/receipt. Single-site users get a default location without setup burden. Branch infrastructure is a separate scope assessment.

**P7: true valuation, only after movement coverage is complete.** Keep the current purchase estimate as an honestly labelled option. Perpetual weighted-average valuation requires known opening quantity/value, priced receipts, vendor returns, count adjustments, zero/negative stock rules, correction policy and period closing. Recommend a separate valuation journal linked to physical movements, with posted value adjustments instead of rewriting paid snapshots.

For known positive stock: 10 kg worth 40 plus 5 kg worth 30 gives 15 kg worth 70, average 4.666666…; a 3 kg issue costs 14, leaving 12 kg worth 56 subject to documented precision. Unknown or negative stock must carry an explicit provisional/incomplete valuation state and later adjustment policy; never divide through zero or fabricate value. Price corrections after consumption split their effect between remaining value and issued cost under the adopted policy. Existing operational margins and accounting inventory value must not be conflated.

Release gate: opening + receipts + transferred/prepared value − issues − waste ± adjustments = closing value, including rounding residuals. Closed-period corrections are current-period adjustments. Accountant review is required before marketing the result as financial inventory valuation or exporting general-ledger entries. No general ledger, supplier payment processing, automatic ordering, OCR dependency, or broad ERP integration is part of Releases 1–3.

## Verification and performance plan

Before implementation, record current baseline on a fixed fixture and hardware profile. Run the existing focused frontend and isolated backend checks, not tests against the application database. Add behavioral tests for each acceptance example above; avoid tests that pin labels, class names or component arrangement.

Use three workloads: current small restaurant, 10,000 stock items with 100-line receipt/count sessions, and a large-history fixture with 100,000 sales and 1,000,000 movements. These are proposed test datasets, not supported-capacity claims. Include long Arabic names, mixed units, missing prices, negative/unknown balances, inactive items, retries and interruptions.

Measure p50/p95/p99 latency, query counts, lock wait/deadlocks, Node and MySQL CPU, combined peak memory, response bytes and browser interaction/scroll behavior. Run mixed checkout plus receipt/count posting, including same-item contention and independent items. Compare identical before/after workloads with warmup and at least three repeats; no simultaneous unrelated benchmark workloads.

Provisional gates: no more than 10% checkout p95 regression across repeated comparable runs; short stock list/filter requests target p95 below 300 ms and 100-line posting below 1 s on the documented reference device. These are acceptance targets to calibrate after baseline, not promises already achieved. Correctness is mandatory even when a speed target passes. Report why a target was adjusted rather than quietly redefining success.

Keep list queries paginated and indexed; use bounded recipe expansion and one batched ingredient lookup instead of per-line calls. Existing in-memory filtering must be re-evaluated at the larger dataset. Introduce balance/report projections only when query evidence justifies them, with a reconciliation check. Do not add Redis, a broker, microservices or a new runtime for this plan by default.

Usability evidence: record current-task baseline, then test the same receipt/count/variance/recipe tasks with representative Arabic-speaking operators unfamiliar with inventory terminology. A small initial study of 5–8 operators is formative, not statistically representative. Measure completion time, wrong quantities/units, abandoned tasks and help requests. Target zero unrecovered stock-entry errors and meaningful time reduction; report actual results instead of assigning ourselves a 9/10. Test desktop and 390 px phone layouts, focus, keyboard entry, long lists, incomplete data and save/retry feedback.

## Migration and release procedure

Follow `docs/agents/database-migrations.md` for each separately reviewed schema increment: preflight, evidence SQL, exact predecessor, normalized checksum, automatic execution source and mirrored Hostinger fallback only after implementation authorization. Validate upgrade, current-schema no-op, partial state and rejection of wrong predecessors. Never activate a migration merely to accompany this planning document.

Use additive changes, forward-compatible readers and explicit per-feature activation. Reconcile baselines before switching stock writers. Preserve legacy unknown balances and original invoice snapshots. Test open orders, held orders, splits, refunds and stock-off transitions at the cutover. Reverting application code after writes must not re-enable a second authority; prefer a read-only disable switch and forward repair over destructive rollback.

Each release has one coherent PR, relevant focused tests, architecture updates for changed boundaries, `npm run architecture:check`, admin build, isolated migration checks and the required GitHub Release gate. No automatic deployment. Draft input and operational audit evidence survive disabling a feature.

## First implementation package

Begin with P0, not another cosmetic redesign: enumerate every product-stock writer, add the lost-update RED test, implement atomic/idempotent replenishment and movement evidence, and verify concurrent checkout. Then P1 completes ingredient consumption coverage. P2 and P3 make the operational system materially more useful. P4 and P5 deliver the stronger restaurant differentiation. P6 and P7 remain explicit later releases, with the accounting and multi-location decisions resolved before their implementation.

No calendar estimate is asserted from this review. Estimate each release after its writer/schema spike and test baseline; a single estimate for all seven stages would conceal substantially different risks.
