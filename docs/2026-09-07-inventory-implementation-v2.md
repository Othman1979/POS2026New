> **Execution cancelled: POS scope only.** Supplier/purchasing, warehouse/location, production, valuation and period-close work are retired. Do not execute remaining A–J packages. Follow [the current POS closeout](2026-09-09-pos-inventory-core-closeout.md).

> Superseded for execution on 2026-09-09 by [POS inventory core closeout](2026-09-09-pos-inventory-core-closeout.md). The user cancelled the warehouse/ERP expansion. Do not execute D–J or treat earlier completion claims as independently verified. Historical evidence below is retained.

# Advanced restaurant inventory — implementation contract v2

Date: 2026-09-07; reviewed 2026-09-08. Supersedes `2026-09-07-inventory-advancement-plan.md`. Local implementation authorized on 2026-09-08; production deployment requires separate authorization. Existing product behavior is the migration baseline, not the desired final design.

Read alongside [adversarial findings](reviews/2026-09-07-inventory-plan-adversarial-review.md) and [measured baseline](reviews/2026-09-07-inventory-resource-baseline.md). The implementation order below is binding because later features depend on earlier stock identity and resource controls. All advanced packages below are in the plan, including nested preparation, lots, locations and valuation; they are not unspecified future ideas.

## Execution status — 2026-09-08

A+B code closure is documented in [the independent review](reviews/2026-09-08-package-b-independent-review.md), with the complete [source writer registry](reviews/2026-09-08-stock-source-writer-registry.md). This status supersedes earlier partial-package summaries and outstanding lists. The final focused correction run passed; A+B is accepted for proceeding to C under the revised gates.

A now supports flat resolved product compositions, shared physical stock, frozen original-stock returns after remapping, ingredient cutover and authoritative shared availability. Existing source transactions collect report invalidation until the final commit. Mixed product/recipe sources lock their complete physical union before posting. Unsupported historical replacement/reset and ambiguous composite product receiving explicitly reject instead of bypassing the ledger. Nested recipe/preparation versions remain E/F. C supplier/PO/return/correction/import operator workflows are implemented locally; they are not H valuation and are not deployed. See [the operator-workflow evidence](reviews/2026-09-09-stock-procurement-operator-workflows.md).

B now has published count and daily projections, bounded source discovery, a resumable ingredient balance initialization walk, scheduled worker backoff, server-filtered working lists and independent bounded operation pickers. Quantity is live; delayed daily facts have explicit freshness. Existing finalized invoices reject price edits for every role; new receipt price corrections belong to C. These are deliberate API boundaries, not missing existing writers.

The user removed hardware certification and comparative resource benchmarks from the execution gates on 2026-09-08. Continue using query bounds, indexed access, real transaction/concurrency regressions, reference reconciliation, migration checks and browser behavior. Do not restart the 2-CPU/4-GiB or million-movement benchmark effort. Historical measurements below remain context, not release requirements or promises of universal speed.

Independent review repaired C API/direct-receiving defects. The remaining C operator workflows and C-specific J polish were implemented locally on 2026-09-09; D–I and J for those packages remain open. See [the independent review](reviews/2026-09-08-stock-procurement-independent-review.md) and [the follow-up evidence](reviews/2026-09-09-stock-procurement-operator-workflows.md). No application data has been migrated or deployed.

## 1. Product outcome and limits

Deliver one Arabic-first stock operation system spanning products, ingredients, prepared items, suppliers, locations, expiry, purchasing and cost control. Its distinguishing workflow is **see an exception → see its source records → take the right action**, with sales-only analysis usable before full counting discipline. Retain ink styling and progressive disclosure; do not equate advanced capability with more dashboards.

Include: barcode/pack entry, supplier catalogs, PO/receipt matching, returns, invoice-price adjustments, count sessions, recipe versions/modifiers/order types, nested subrecipes, production batches, measured yields, multi-output batches, lot traceability/expiry/FEFO, same-database storage locations/transfers, weighted-average valuation, period close, purchase suggestions, supplier performance, menu contribution and audit/permission controls.

Do not promise complete accounting, payroll, independent-branch synchronization, automatic supplier messages, autonomous ordering or magical invoice OCR. CSV import/export and internal purchase drafts are included. External communication and integrations require their own scope and authority. FIFO financial valuation is not a second costing method in this version; physical FEFO and moving-average financial costing solve different problems and can coexist.

## 2. Evidence that changes the design

- Current quick product replenishment can overwrite concurrent sales. Isolated deterministic interleaving produced 15 rather than 14; atomic delta SQL produced 14. This is service/SQL evidence, not an HTTP concurrency test.
- At 10,000 ingredients/210,000 movements, the current full ingredient summary p95 was 783 ms with 4.70 MB JSON. Current client-side pagination does not bound server response work.
- At 100,000 one-line invoices, current analysis p95 was 8,218 ms, 1,004 queries and 1,259 ms Node CPU/call. Invoice batching bounds each query, not total request work.
- A 50-item balance-only prototype was 3.21 ms p95, but lacks daily-summary/filter completeness. It is evidence for bounding work, not a claimed 244× production improvement.
- Node RSS reached about 369 MiB in the large analysis phase. Fixture allocation/retained heap contributes; this is not incremental production memory. MySQL CPU/working set could not be attributed in this run. No full-server low-cost guarantee is established.

The baseline uses Node v24.16.0, MariaDB 10.4.32, i7-14700KF, 31.84 GiB RAM, 12 warmed sequential samples. Advanced code must remain compatible with the supported application runtimes/database deployment; this workstation is not a minimum-device certification.

## 3. Authoritative data contracts

### Stock identity and quantity

Create `stock_items` as an explicit physical-stock catalog, not a polymorphic object registry. Fields: ID, name, measure/base unit, optional unique legacy ingredient ID, optional unique legacy product ID, tracking state, lot-required flag, active flag. Enforce at most one legacy source link per row and valid measure/unit constraints; map identical physical stock deliberately through separate product links, not fuzzy names.

`product_stock_links` has primary key `(product_id, stock_item_id)` and six-place `qty_per_sale`; up to 200 physical components per product are resolved before posting. It handles packaged goods and shared flat compositions. Recipe sales reference recipe versions instead. A sold line records `stock_authority` and immutable resolved stock lines. No item is simultaneously deducted as linked stock and recipe stock for the same units. Product availability limits remain a separate optional control.

`stock_locations` starts with one seeded default, plus an explicit in-transit location. Storage-area count labels can remain ordering metadata until real location tracking is activated. `stock_balances` key is `(stock_item_id, location_id, lot_id)`; use a real untracked/default lot row instead of nullable unique-key behavior. Store quantity, known/unknown state, monotonically incremented version and last-posted reference. Unknown balance is not zero. Explicit bootstrap count establishes known quantity.

`stock_operations` stores operation kind, state, actor, request key UNIQUE, canonical payload hash, posted time, effective business date and original-operation link. `stock_movements` stores operation ID/line ordinal UNIQUE, stock key, signed quantity, unit snapshot and source line reference. Monotonic integer PKs; indexed stock-key/history and business-date filters. An operation can post only once. Posted records are corrected by linked operations, never silently edited or deleted.

Stock quantity uses six-place base units; cost rates use at least eight decimal places and carrying value uses fixed-point precision with documented residual allocation. Do not use binary floating-point accumulation for valuation. Reuse current POS revenue allocation; an ingredient's associated meal revenue is not independently additive revenue.

### Transitional authority

Do not immediately redirect all legacy product/ingredient writers. Add authority/version metadata and new journaling adapters first. Keep legacy ingredient movements as historical authority for legacy lines. On per-item activation, under locks record an opening baseline/watermark and reconciled known state in new stock. Block activation while unresolved legacy open/held/split orders involve the item, unless the adapter explicitly routes their later delta/reversal into new stock with a linked legacy-origin reference. Default implementation is the simpler block-and-resolve path.

Closed legacy invoices may still be refunded after activation: resolve the original stock authority and append any current physical return through a one-time mapped operation, preserving original quantity/cost evidence. No double restoration. Changing a product link later cannot reinterpret those records. Old unknown quantities and costs stay unknown. Direct product-stock PUT/import becomes an explicit adapter count/opening command, or rejects after migration; it must never bypass movement recording.

Catalog fields and `products.stock` may remain compatibility projections for POS readers, updated in the same transaction as new movements. They are no longer independent writers for migrated items. Disabling an advanced UI does not revert a migrated item's authority.

### Transaction and concurrency rules

Canonical lock ordering must match existing order/subscription locks: source order or document → product identities → stock item/location/lot keys sorted lexicographically → balance updates → operation/audit → dirty reporting keys. Trace and test existing lock order before changing it. Never introduce a reverse order in returns or batch posting. Use bounded whole-transaction retry for deadlock victims only when the same idempotency key/payload is reused.

Post document state, movements, projections, valuation references and dirty markers atomically; emit after commit and connection release. No network request, print wait, graph rebuild or report recomputation inside checkout. Drafts have optimistic `version` checks; stale updates return 409 with current version. Idempotency conflicts are 409, validation errors 400/422, forbidden operations 403. Response-loss retry returns the original posted document.

## 4. Resource architecture required before feature expansion

**Interactive stock reads:** `GET /api/admin/stock/items?cursor=&limit=50&q=&status=&location_id=&attention=`. Hard maximum 100 rows; cursor contains stable sort key/ID, with search/filter identity validated. Search by barcode/prefix first; avoid adding a leading-wildcard scan to every keystroke. Stock filters operate on indexed balance projections, then hydrate only the chosen item IDs. Daily summary fields come from a bounded daily projection, not an all-history correlated scan per visible row. Global counts use separately cached/generation-keyed aggregates and can have an explicit freshness label.

**Analysis:** retain `IngredientAnalysisService` as reconciliation/reference logic. Add daily sale/ingredient facts derived from frozen invoice and refund snapshots, with explicit paid-sale, preparation, redemption, waste and physical-return dimensions. Refund revenue belongs to its existing financial reporting date; original costing stays linked to the original invoice. Recipe contribution and physical inventory COGS remain separate outputs. Preserve existing discount/tax allocation, including incomplete/legacy coverage flags.

Use `stock_report_dirty(day, scope_id, generation, lease_owner, lease_until)` written in the source transaction. One bounded worker claims oldest dirty scopes using compare-and-swap/lease semantics supported on both deployed database versions. Capture the starting generation and rebuild into unpublished staging rows with stable keyset traversal. Each chunk has its own read transaction; releasing connections means there is no single snapshot across chunks. Every source mutation must increment the affected scope generation in its own transaction, including edits, deletions, refunds and old-date corrections. Publish the generation pointer in a short transaction that locks the dirty row and verifies its generation still matches the starting value; otherwise discard the staged build and retry. Readers only use published generations. A writer committing after publication increments the generation and schedules another rebuild. No MAX(movement_id) checkpoint: lower IDs may commit later. A crash after computation cannot publish partial facts. Lease expiry allows recovery; refresh polling never causes duplicate rebuild work.

Partition dirty scopes by business day and a fixed source-invoice hash partition (initially 32); reversals use their source invoice partition. Non-invoice facts use a stable operation partition. Report totals combine published partitions and expose the oldest completion time plus pending partitions; they are not advertised as one globally atomic snapshot. Exact reconciliations and period close require a generation-vector check. Multi-scope writers acquire dirty keys in sorted order. Measure hot-partition contention before accepting this starting partition count; never funnel every checkout through one global day row.

Initially one worker and one rebuild at a time, at most 200 invoices/500 fact rows per chunk. At most one DB connection retained during a chunk; release/yield between chunks. Do not reserve a pool connection while sleeping. Report readers use last completed generation and display `as_of`/`rebuilding`. Freshness target 10 seconds under ordinary load, explicitly stale under overload. Cap pending expensive export/rebuild requests and return a retrievable job status instead of piling up HTTP requests.

Hot path stays synchronous only for stock correctness and immutable cost facts. Procurement, lot warnings, demand recommendations, exports and period reconstruction are off the checkout path. Use SQL and the existing Node process lifecycle first; no mandatory Redis, broker, new server or microservices. If separate worker process is later justified, it uses the same bounded job/lease contract.

Report API returns totals plus at most 50 display rows; ingredient-meal and invoice-event drilldowns are separately paged. Large CSV exports stream in chunks, permit one active export per installation initially, and expire artifacts. A 365-day request must never build a giant event array merely to return page 1. Known global totals must not be replaced by current-page totals.

## 5. Implementable packages in dependency order

Each package starts with failing behavioral tests, ships its migration/API/UI together, and has one coherent PR. Named modules below describe ownership boundaries; final placement may reuse an existing cohesive service. No arbitrary file splitting.

### A. Repair product writes and establish authority adapters

**Files:** `InventoryService.js`, `backend/routes/admin/products.js`, `Inventory.vue`, `RefundService.js`, `backend/modules/refunds/voidOpenTableOrder.js`, `backend/modules/checkout/executeCheckout.js`, `backend/routes/pos/subscriptions.js`, `backend/routes/admin/import.js`, `categoryPriceLists.js`, table/order writer call sites.

**API:** `POST /stock/adjustments` with kind receipt/count, product reference, delta or counted quantity, expected version and request key. Do not accept absolute stock through quick replenishment. Install the minimum section 3 stock catalog, default location/lot, operation/movement/balance schema and authority columns here so A never creates a disposable second ledger. Initially activate only the covered product adapters; legacy opening entries establish a forward-only ledger baseline. B extends and activates the same schema for ingredients and reporting.

**RED/GREEN:** sale -1 plus receipt +5 from 10 yields 14 in both schedules; simultaneous receipts +5/+7 yield 22; retry does not double-post; raw product PUT cannot overwrite a sale; refund and subscription reversal post once; null/untracked stays null; category copy/import creates one explicit opening state. Test actual HTTP routes plus real MySQL transactions, not just mocked service results.

**Exit:** writer registry contains every write and its operation adapter; reconciliation proves projection equals opening plus journal for new records. No migration until all routes are covered or explicitly reject writes.

### B. Stock identity, bounded reads and daily reporting

**Schema:** extend the core catalog/links and operations/movements/balances installed in A; activate ingredient adapters and add daily fact generations and dirty scopes. Add composite indexes for cursor order, attention state/location, source identity and date scopes; inspect EXPLAIN plans before adding covering indexes indiscriminately.

**API/UI:** replace the all-row Ingredients fetch with section 4 contract; retain old URLs and daily-report semantics. Product catalog becomes المنتجات, stock parent المخزون; the working list can filter purchased ingredients, packaged items and prepared items without duplicate physical balances.

**Tests:** paging/filter totals reconcile; missing/zero/negative and inactive states; interrupted generation rebuild; two writers committing IDs out of order; worker crash/retry; same request during rebuild; price-only corrections dirty appropriate scopes; 100,000-invoice totals equal the current reference implementation. A stale report must be labelled rather than silently presented as current.

**Exit:** verify A+B query/read bounds, transaction correctness and actual UI/API operation before adding C–J; hardware benchmarks are not a gate under the current user scope. Full history reconciliation is an offline administrative operation, not a read-request side effect.

### C. Procurement: suppliers, prices, orders and receiving

**Tables:** `stock_suppliers`, `stock_supplier_items` (supplier SKU/pack conversion and currency), `stock_purchase_orders`/lines, `stock_receipts`/lines, `stock_vendor_returns`/lines, `stock_price_adjustments`/lines. Document lines snapshot pack size/cost basis so later supplier edits do not rewrite history. Start with installation currency; reject unsupported currencies instead of silently mixing them.

**States:** PO draft → approved → partially received → closed, or cancelled for outstanding quantities. Receipt draft → posted; vendor return/price correction are new posted operations. Approved order lines cannot change behind an existing receipt; amendments create a revision with remaining-quantity checks. Returns do not automatically reopen a PO: explicit replacement/amendment creates new demand.

**Endpoints:** `/stock/suppliers`, `/stock/purchase-orders`, `/stock/receipts`, `/stock/vendor-returns`, `/stock/price-adjustments`; collection GET cursor paging, POST draft, PATCH with version, `POST /:id/post` or approve/cancel as applicable. Receipt lines match PO lines optionally; direct receipt has no mandatory PO. Duplicate supplier document reference is a warning requiring explicit acknowledgement, while request-key uniqueness prevents network duplicates.

**UI:** receive by scan/search, packs + loose units, optional supplier and cost; discrepancy review for over/short delivery; receiving history and linked supplier invoice reference. Cost includes allocated purchase discounts and nonrecoverable charges; recoverable tax is separate. Allocation residuals conserve document total. Tax classification follows approved business configuration, not an inferred rule from the sales tax code.

**Tests:** partial/over receipt under two concurrent posters, changed pack definitions, 6.5 kg pack example, zero vs unknown price, supplier return limited to unreturned source units, price-only adjustment leaves quantity unchanged, document totals reconcile and no invented payable/expense entry is posted.

**Status (2026-09-09):** implemented locally, including supplier/pack, purchase-order, source-linked return/correction and editable CSV staging workspaces. Isolated HTTP/transaction tests and built-UI browser checks are recorded in [the operator-workflow evidence](reviews/2026-09-09-stock-procurement-operator-workflows.md). Effective receipt cost is evidence only; reports do not consume it and H remains open. Not deployed.

### D. Counts, mobile drafts and approval

**Tables:** `stock_count_templates`/lines; `stock_count_sessions`/lines with observed balance version/time, entered quantity, line version and posting status. Template revision is frozen on session creation. Draft autosave batches changes after 750 ms inactivity, maximum once per second per session, and flushes on explicit Next/Save. Offline device storage retains drafts only; reconnect checks versions before upload and never silently posts stock.

**States/API:** draft → in progress → review → completed (or cancelled); each line can finalize once. `/stock/counts`, `PATCH /:id/lines` with versions, `POST /:id/finalize` for chosen lines. Review returns conflicts by item. Optional blind entry hides expected quantity until review. Approval permission is distinct from entering counts; owner role can perform both.

**Busy-kitchen policy:** finalize observed items in bounded groups promptly. If movement version changed after observation, expose the delta/time and request reconfirmation; retain all unaffected observations. Do not force the entire sheet to restart. Partial completion is visible and cannot be reported as a full location count.

**Tests:** offline/reload recovery, two devices editing same line, sales during observation/post, blank versus explicit zero, duplicate finalize, permission bypass, observed timestamps and business-day crossing. Count projection supersedes previous known balance, while history remains append-only.

### E. Complete recipe composition and versions

**Tables:** `stock_recipe_versions` (draft/active/retired), `stock_recipe_components`, stable modifier/order-type stock rules, product-version links. Distinguish direct ingredient, expanded formula and consumed prepared item. Support graph depth up to 8 and at most 200 resolved stock components per sale line; reject cycles and explosive expansion at save/publish, not during checkout. Limits are initial measured safety bounds, visible in validation.

**API/UI:** draft/edit/publish recipe; compare versions; modifier adds/removes/replaces identified components; order-type packaging rules; explicit no-stock-effect mappings. Resolve and cache immutable composition by recipe/modifier/order-type version; request-time quantities multiply a bounded composition. Cache is bounded by entries/bytes and invalidates on publication; never an unbounded per-combination map.

**Tests:** nested sauces, large/small portions, no-onion rule never creates negative component usage, extra chicken, takeaway cup, bundle removal, open-order edits, split checks, recipe publication during sale, unsupported modifier remains incomplete, paid snapshot unaffected. Free text is not interpreted as inventory instructions.

### F. Preparation, yields and multi-output batches

**Tables/API:** `stock_prep_batches`/input/output lines, versioned preparation formulas; `/stock/preparations` draft → posted, correction via linked adjustment. Inputs and output lots reference section 3 identity; measurements override planned quantities only through review. Raw input decreases once; output increases once; sale consumes the prepared item without expanding raw inputs again.

Before H, batch costs are operational estimates from immutable input-cost evidence, explicitly labelled incomplete where necessary; they must not be presented as finalized carrying valuation. H starts financial valuation from a reconciled activation baseline and integrates batch value entries without pretending past estimates were an audited ledger.

Support measured actual yield and preparation loss, and optional multiple outputs. Multi-output cost uses explicitly configured allocation percentages that total 100%; residual goes to a designated output. No inferred market-value allocation. Changing allocation affects new batches only. By-product quantities and waste cannot both claim the same output units.

**Tests:** 10 kg × 4 cost becomes 8 kg × 5; 0.2 kg sale costs 1; batch replay, partial consumption before correction, nested prepared input, unknown input cost → incomplete output value, expired input lot policy, outputs and allocated costs reconcile. Reject destructive reversal where downstream operations would be invalid; use linked adjustments or reverse dependants in an explicit reviewed sequence.

### G. Locations, transfers, lots and expiry

**Tables:** `stock_lots` (supplier lot, received/production dates, expiry, quarantine state), `stock_transfers`/lines with dispatched/received quantities and source lots; lot allocations link each actual movement to its lot. Genealogy joins preparation input/output operations, not an unbounded recursive tree on every page.

**API/states:** transfer draft → dispatched → partially received → received; discrepancy/return operations explain missing units. Dispatch moves source → in-transit; receipt moves in-transit → destination. Immediate same-site transfer can combine both in one transaction. This is same-database stock control; disconnected branch replication is outside scope.

FEFO candidate query uses `(item, location, eligible_state, expiry, id)` ordering with limit; lock/revalidate candidates before allocation. Lot-required items cannot post an unallocated physical movement. Legacy/default lot remains labelled untraceable. Quarantine and expiry policies block allocation or require an authorized recorded override; disposal is an explicit waste operation. Expiry alerts are a daily/changed-lot batch, not a timer per item.

**Tests:** concurrent pick of last lot, split lots, expiry boundary/timezone, transfer loss, return to origin, quarantine override, partial destination receipt, downstream batch trace both directions with pagination and visited-node/depth limits. Total units/value across source/transit/destination reconcile.

### H. Physical disposition, valuation and period close

Separate money reversal from physical handling: unprepared cancellation reverses reserved/recorded usage; reusable returned item adds actual stock; cooked discard records disposition without inventing raw stock. New sales capture disposition policy version. Legacy refunds retain an explicit legacy interpretation. Do not change customer refund amounts because a physical item was discarded.

**Tables:** `stock_value_entries` linked to movement/operation, `stock_value_balances` keyed item/location, `stock_periods` with close generation and reconciliation state. Moving average uses current known positive carrying quantity/value; transfers preserve source value and destination average updates; lot selection does not switch costing method. Financial FIFO is not silently inferred from FEFO.

Unknown opening value or negative quantity sets provisional state and blocks final valuation close for that item. Later priced receipts do not retroactively invent missing opening costs; require explicit valued opening/correction. When quantity reaches zero, consume the remaining value residual; do not leave orphan value. Vendor/customer returns use linked original issue/receipt value under the documented policy, with explicit valuation variance where current carrying value differs. A price correction allocates effect between remaining stock and already-issued adjustment entries, preserving sale snapshots. No opaque rewrite of historic margin.

**Endpoints:** `/stock/valuation`, `/stock/periods/:id/validate`, `/close`, `/adjustments`; close under generation/version check so racing posts cause validation retry. Closed business dates reject new physical backdating; adjustments are posted in the open period with an original reference. Export operational reconciliation first; general-ledger posting requires a separately reviewed account mapping.

**Tests:** exact worked average 70/15, issue 3 leaves value 56; zero/negative/unknown, price correction after partial sale, vendor return after consumption, transferred stock, multi-output cost residual, concurrent close and receipt, closed-period correction, free goods, currency precision. Accountant acceptance is a release criterion for calling the result financial valuation, not a prerequisite to building the operational features.

### I. Demand planning, supplier performance and menu decisions

**Facts/config:** daily actual usage, sales demand and waste separated; supplier delivery lead-time/quantity/price facts; reorder policy per item/location with target coverage and safety buffer. Use the section 4 generations. No new calculation on each POS sale beyond marking affected scopes.

Demand uses comparable open business days; require at least four eligible same-weekday observations for that signal, otherwise label low confidence and use manual par/overall observed average. Exclude stock-count corrections and transfers from demand; flag stockout-censored periods. Owner can enter an event uplift with start/end/reason. Do not claim missing sales are measured demand.

Suggested purchase subtracts usable stock and incoming approved quantities due within horizon; then rounds to supplier MOQ/pack multiples and shows each input. Prepared-stock planning nets existing prepared units before exploding raw needs, preventing double counting. Supplier score shows measured delivery lateness, fill rate and price changes with sample counts; no invented star rating from one receipt.

Menu view separates popularity, known recipe contribution and incomplete coverage; exclude allocated overhead claims and label the result as contribution, not profit. Scenario pricing uses a preview copy only; no automatic selling-price change. Variance actions deep-link to exact receipts/counts/recipes without declaring theft or negligence.

**Tests:** closed days, zero sales, insufficient samples, waste exclusion, partial/cancelled PO, supplier pack change, prepared inventory netting, frozen past costs, promotions/event overrides, ingredient revenue non-additivity and reconciliation to source drilldowns. Benchmark a 365-day dataset and stale projection behavior.

### J. Imports, access control, operational polish and rollout

CSV preview validates units, duplicates, pack mappings and tracked/untracked activation; chunks stage drafts only and final posting is idempotent. Barcode lookup handles item vs supplier pack distinctly. Keyboard scanner support is baseline; camera scanning must have a measured fallback and cannot add a large mandatory bundle to every page.

Permissions: inventory.read, receipt.enter/post, purchase.approve, count.enter/post, recipe.publish, prep.post, transfer.dispatch/receive, waste.post, value.adjust, period.close, supplier.manage. Reuse the existing permission mechanism and server enforcement; hide unavailable actions but never rely on UI-only checks. Admin/programmer inheritance remains explicit. Sensitive cost/valuation fields do not leak into cashier/POS payloads.

Keep focused Arabic pages and a single business-date source. Empty/error/uncertain-save states are required. Accessibility and 390 px layouts tested for all workspaces, including 100-line drafts. Bulk actions summarize affected records and preserve row-specific failures. Every attention card has an actionable destination and measurable source; avoid decorative metrics.

**Status (2026-09-09):** C-specific J is implemented locally (permissions, editable CSV preview/stage, Arabic/390 px procurement workspaces, shared business day, server-paged search, reload/uncertain recovery). D–I permission contracts exist as `implemented=0` catalog rows only. J for D–I workspaces stays dependent on those packages; do not treat this as all of J. Evidence: [the operator-workflow follow-up](reviews/2026-09-09-stock-procurement-operator-workflows.md).

## 6. Verification scope update — 2026-09-08

The user explicitly removed the hardware certification and comparative benchmark requirements. Do not block A+B or C–J on 2-CPU/4-GiB certification, million-movement benchmark runs, repeated timing samples or host-to-host comparisons. Focus on code/query reductions, bounded reads and writes, correct indexes, transaction/lock behavior and focused real database/HTTP/UI regression tests. Preserve throughput-sensitive behavior; do not replace the removed gate with another benchmark exercise. Earlier performance results remain historical observations, not universal speed guarantees.

The original experiment specification below is retained as historical context and is no longer a required execution gate.

### Superseded experiment specification

Baseline script: `node scripts/reviews/inventory-advancement-benchmark.cjs`. It creates/drops only a random guarded loopback fixture. Do not add this large workload to the normal unit suite. Existing reproducible results are in the companion evidence files. CPU values are Node-only and timer-granularity limited; zero means below resolution, not free work.

Before claiming low server cost, run three isolated repetitions on a documented low-end reference environment (2 logical CPUs, 4 GiB RAM, SSD) and the deployment-class database version. Capture both Node and database CPU/working set, event-loop lag, lock waits/deadlocks, connection occupancy, query rows examined and disk growth. A container CPU/RAM limit is useful but not a substitute for a real low-end latency profile. Current results do not provide those measurements.

**Initial release budgets (proposals, not measurements):**

- Stock list: 50 rows, ≤100 KiB uncompressed JSON, p95 ≤300 ms on reference device; daily list work independent of total historical movements.
- Count draft patch: ≤100 changed lines, ≤1 request/sec/session, p95 ≤300 ms. Posting groups ≤100 stock lines and p95 ≤1 s, with explicit conflict handling.
- Stock transaction overhead: compare exact checkout before/after with same data. Reject repeated p95 increase above max(2 ms, 10% of baseline); additionally require bounded query count and measure CPU separately. No report/forecast scans in that path.
- Report page: ≤250 KiB JSON, ≤50 rows plus totals, p95 ≤500 ms from completed facts; one bounded rebuild worker. Large rebuild/export is asynchronous with progress and cancellation between chunks.
- Worker: initial duty cap 100 ms work per 500 ms window, one connection at a time, explicit backoff when checkout p95/pool occupancy crosses budget. Calibrate from DB+Node CPU measurements; this wall-time limiter is not a CPU guarantee. If freshness misses target, show staleness rather than increase parallelism automatically.
- Fixed process caches: ≤16 MiB total inventory cache budget initially, not per user or page. Cache immutable recipe versions/small query results; no unbounded all-report cache. Foreground attention refresh coalesces socket events and does not refetch every item after every sale.
- Store no full product/recipe JSON on every receipt movement; immutable version references plus necessary transaction snapshots only. Measure new bytes per posted line, rows/day and index size; report 1-year growth from actual recorded workload counts. Do not extrapolate the fixture's approximate storage statistics as production billing.

**Mandatory additional datasets:** 10,000 items, 1,000,000 movements with highly skewed hot items and old counts; 100,000 multi-line invoices with refunds/modifiers/splits; 365-day reports; deep recipes at limit; lots per hot item; 10 simultaneous readers plus receipts/counts and checkout writers. The existing 210,000-movement synthetic run does not cover these. High percentiles require at least 1,000 timed hot-path samples, repeated runs and raw outputs; do not quote p99 from 12 samples.

For B, compare completed daily facts with reference reports, then measure a 50-row query and a fresh-generation rebuild separately. For E/F/G, benchmark actual same-item concurrency and ingredient graph/lot limits. For H, benchmark valued and unvalued checkout separately. Count/report projection optimizations require correctness parity before speed claims. Explain plans must confirm intended indexes on both MariaDB and supported MySQL versions.

## 7. Cutover and completion checklist

1. A: enumerate writers and ship atomic replenishment with RED/GREEN HTTP/concurrency evidence.
2. B: stock identity adapters, migration preflight/open-order policy, bounded reads, dirty-generation reporting and measured resource gates.
3. C–D: procurement and durable counting using the new operation contracts.
4. E–F: versioned full recipe coverage and nested/multi-output preparation.
5. G–H: operational lots/locations and reconciled valuation/close.
6. I–J: planning, contribution analysis, permissions/imports and full operator validation.

Every schema package follows `docs/agents/database-migrations.md`: additive evidence migration, exact predecessor/checksum, fixtures, upgrade/no-op/partial-state validation, mirrored automatic/fallback execution only when implementation is authorized. Update architecture entries for actual service/table changes. Feature activation verifies baseline parity first. Never remove raw stock/audit history merely to improve report speed; historical archiving requires retention and reversal-access design.

Each release requires focused isolated backend and frontend checks, real Arabic browser journeys, migration checks, build and GitHub Release gate. Do not change .env, deploy or bypass gates. Existing local stock is not a benchmark fixture. Unrelated work stays intact.

Completion means the contracts and behavioral/resource gates pass, not that every screen exists. Comparative ease-of-use remains a separate formative operator study with observed task times/errors; no self-assigned 'better than enterprise' score substitutes for that evidence.
