# Stock schema consolidation: approved phases 1–3

The user authorized implementation and isolated verification of all three phases on 2026-09-12. Work remains on `codex/schema-consolidation-audit`. Production deployment requires separate authorization.

Phases 1 and 2 are implemented and verified in POSApp. See [the verification report](../reviews/2026-09-12-stock-schema-consolidation-verification.md) for tests, measurements and the separate local invoice-support tool compatibility limit. The user subsequently authorized phase 3 implementation and verification on this same branch; deployment remains separately authorized.

1. **Stock identity:** remove `stock_locations` and `stock_lots`; use one balance per stock item. Keep original warehouse IDs only as nullable legacy provenance on existing balance/movement rows, preserve saved version 1/2 sale snapshots and operation results, and issue version 3 composition snapshots without warehouse IDs. Reject ambiguous multi-balance or restricted-lot upgrades before destructive statements. Update all runtime callers, schema validation, fresh installs and upgrade fixtures.
2. **Ingredient side tables:** move activation/link metadata and the maintained working balance into `ingredients`, retaining unique keys, exact decimal precision, initialization, known/unknown state and original cutover observations. Remove the two old side tables only after their data is copied and checked. Preserve both movement ledgers and their current accounting semantics.
3. **Movement ledger:** unify ingredient and physical movement history as described below. Other table families and retired purchasing-table cleanup remain outside this change.

## Phase 3 working contract (now approved)

Implemented and locally verified. See [phase 3 results](../reviews/2026-09-12-unified-stock-movements-verification.md) for the 524-check inventory, browser workflows, performance comparison, backup/restore experiment and compatibility limits.

Use one `stock_movements` table with a stock/ingredient discriminator and original IDs scoped by that discriminator. Keep ingredient `qty` (including absolute counts) separate from optional physical `quantity` deltas. Existing stock rows and ingredient rows retain their historical IDs, timestamps, cost/source data and corrections. New activated ingredient entries carry their physical effect on the same row; no additional mirrored movement row. Unactivated ingredient entries remain valid without a physical identity. Operation headers and source provenance remain.

1. Establish baseline workflow expectations and prove identity/quantity semantics in an isolated fixture.
2. Consolidate the movement writer and readers; migrate historical rows with exact copy checks and restart safety. Preserve independent flags, known/unknown quantities, count boundaries and retries.
3. Verify existing operational/report workflows, populated upgrades, rollback/recovery and performance. Retain the independent invoice-support utility compatibility boundary; discuss other tables afterward.

Use separate phase migrations and task-sized commits. Before production changes, establish failing focused tests. Verify legacy snapshot returns, idempotent retries, missing/partial/current upgrades, constraints, original historical quantities, shared components, optional modes, counts/corrections, checkout/table/subscription/refund workflows, report publication and bounded queries. Run realistic isolated concurrency and browser checks after the focused tests pass. Record results and limits; do not equate passing tests with a 100% guarantee.

Database probes and tests must use generated allowlisted loopback fixtures. Do not migrate the local application database or a Hostinger database. Update the migration manifest, manual fallback, bootstrap and baseline consistently; retain historical migrations. Back up/restore tests must precede any future production rollout because old application code cannot run against removed tables.
