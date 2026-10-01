# Adversarial review of the inventory advancement plan

Date: 2026-09-07. The first plan was a roadmap, not yet an executable specification. The findings below require changes before implementation. Performance measurements are recorded separately and do not establish a production capacity guarantee.

| Severity | How the first plan breaks | Required resolution |
|---|---|---|
| Critical | Creating a second product journal and later switching to shared stock leaves open orders/refunds able to reverse through the wrong authority. | Freeze authority/version on every new tracked sale; reversals follow original authority. Legacy records retain a legacy adapter. No catalog toggle can reinterpret old stock ownership. |
| Critical | Adding lot selection and moving averages late changes the write model underneath receipts, transfers and preparation. | Define item/location/lot identity and valuation linkage before document migrations. Lot tracking can be optional in the UI, but stock keys and journal references are designed now. |
| Critical | Refunding a cooked meal can increase raw ingredients despite nothing physically returning. | Separate money refund, cancelled/unprepared consumption reversal, reusable stock return and discarded prepared food. Preserve legacy policy for old records; new records capture explicit physical disposition. |
| High | A persistent count can become impossible to finish in a busy kitchen if every subsequent sale demands a recount. | Item-level observe/finalize units, watermarks and bounded conflict review; finalization can preserve completed items while uncounted/conflicting items stay open. Physical observations are not silently backdated. |
| High | Client pagination and small invoice query batches were treated as bounded total work. They are not. | Paginate before stock aggregation; move large-period report rebuilding out of interactive requests and checkout. Bound response size and simultaneous rebuilds. |
| High | Snapshotting a raw recipe and separately stocking prepared food can double-charge consumption. | Explicit composition modes: direct expansion versus consume prepared stock. Resolve a bounded recipe graph and freeze the resulting physical stock lines. |
| High | A global movement ID is unsafe as an asynchronous processing checkpoint: transactions may commit out of ID order. | Transactional dirty generations, compare-and-swap publication and mutation-complete generation checks across bounded chunks; never assume MAX(id) means all smaller IDs committed. |
| High | A claim that cost stays low had no current measurements and no workload isolation or resource attribution. | Opt-in isolated benchmark, measured total work, fixed request/worker limits and full-server CPU/memory checks before performance certification. |
| High | Blanket 10% latency regression is noisy for tiny operations and says nothing about multiplied background work. | Separate absolute + relative hot-path budget, CPU per operation, bounded worker throughput, storage growth, and same-item/multi-reader contention. |
| High | 'True valuation later' leaves negative stock, free/unknown prices, returns and closed periods undefined. | Explicit provisional-value state; no finalized valuation while negative/unknown layers remain. Linked returns use original value; period close validates reconciliation. Corrections post adjustments, never rewrite paid snapshots. |
| High | Feature flags can disable the only valid stock writer after migration. | Once an item has migrated, disable editing/advanced UI if necessary but retain its writer and historical reversal adapter. Rollback is forward repair, not a return to direct stock PUTs. |
| Medium | Candidate tables and general acceptance prose leave implementers inventing state machines and APIs. | Add package contracts: tables/keys, endpoints, states, permissions, code owners, migration and RED/GREEN cases. |
| Medium | One-level preparation omits shared sauces, semi-finished components and multi-stage kitchens. | Include bounded nested recipes, cycle prevention, version activation, preparation yield and deliberate multi-output allocation in scope. |
| Medium | FEFO suggestions are presented too close to actual lot traceability. | Distinguish suggested, allocated and confirmed lots; unknown/legacy quantities cannot be advertised as traceable. |
| Medium | A unified page can hide duplicate physical items and imply complete profitability. | Map identical physical stock explicitly, show incomplete coverage, separate associated meal revenue from ingredient cost, and separate recipe contribution from net profit. |

## Evidence discipline

The stale replenishment race is reproduced deterministically in the isolated benchmark using the actual InventoryService sale deduction and an absolute SQL update matching the product PUT. It is not an HTTP/browser concurrency test. A prototype atomic SQL update produces the correct quantity, but idempotency and a shipped endpoint still require implementation.

The limited balance-query experiment only returns 50 IDs/names/balances; it does not implement daily summaries, arbitrary filters, global counts, corrections or paging cursors. It tests the cost of bounding rows, not a completed optimization. Its fixture has no corrections. Never compare its result size or timing as a feature-equivalent replacement.

The large fixture is intentionally synthetic. All invoices have one product line and a frozen recipe snapshot, with no refunds/modifiers/splits; stock history contains 20 movements after each count. It under-represents old uncounted histories, many-line meals and reversal complexity. Those are mandatory implementation benchmarks, not covered by this run.

## Scope closure

The revised plan must explicitly include purchasing, returns and price corrections, resumable counts, modifier/order-type and nested recipes, preparation, lot/expiry/traceability, location transfers, valuation closing, supplier performance, demand planning, menu contribution analysis, imports/barcodes, permissions, audit and resource control. A full general ledger, payroll, external branch replication and autonomous supplier communication are separate products/integrations, not implied by 'advanced inventory'.

No implementation should claim superiority from documentation alone. Differentiation is the combined Arabic operator workflow and explainability, with comparative usability evidence still required.
