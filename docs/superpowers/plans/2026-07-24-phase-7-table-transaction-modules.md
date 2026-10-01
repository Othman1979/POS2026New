# Phase 7 — Table Relationship and Split-Check Transaction Modules

**Status:** completed on `codex/phase-7-table-transactions`; pending merge.

**Reason for separation:** the live route shows relationship operations at `backend/routes/pos/tables.js:258-986` and split persistence at `backend/routes/pos/tables.js:1349-1949`. Both own database locks, transactions, permissions, audit ordering, money invariants, and post-commit broadcasts. Moving them beside a frontend HTTP refactor would make review, rollback, and regression attribution materially worse.

## Phase 7A — `tableRelationships.js`

Move the complete transaction owners for transfer/swap/merge, join, and disjoin into `backend/modules/tables/tableRelationships.js`. Keep Express parsing and `sendSuccess`/`sendError` translation in the route.

Required exports:

```js
processTableAction({ user, sourceId, targetId, action, io, ipAddress })
joinTables({ user, parentId, childIds, requestedIds, managerPin, io, ipAddress, route })
disjoinTables({ user, normalizedTableIds, managerPin, io, ipAddress, route })
```

These three exports share one file because they operate on the same `restaurant_tables.parent_table_id/current_order_id/status` model and locking rules. Do not create one file per action. Move code mechanically before improving it; do not rewrite SQL, permission rules, error strings, audit payloads, transaction order, or broadcast timing.

Before implementation:

- Add boundary tests proving the route delegates and the module has no `req`, `res`, or Express import.
- Re-read all relationship integration cases in `backend/tests/integration/tables.test.js` and map each branch: transfer, swap, merge, joined children, disjoin, stale/finalized orders, manager override, audit rollback, and broadcasts.
- Establish current query counts only if the existing benchmark can exercise these routes without inventing a framework; otherwise compare SQL statements and run focused integration coverage.

Stop if extraction requires copying route helpers. First move or expose the smallest existing concrete helper only when at least two transaction modules truly consume it.

## Phase 7B — `splitChecks.js`

Move split-check persistence ownership into `backend/modules/tables/splitChecks.js`: list/read may remain route-owned if they are thin queries, while destructive discard and split creation move as complete transaction units. Split settlement remains owned by `backend/modules/checkout/executeCheckout.js`; do not duplicate settlement logic merely to match the filename in the target tree.

Candidate exports after caller tracing:

```js
discardSplitCheck({ user, id, ipAddress })
createSplitChecks({ user, tableId, currentOrderId, splits, voidReason, io, ipAddress })
```

The final names/signatures must reflect the live request fields, not guessed abstractions. Preserve child-to-parent resolution, `FOR UPDATE` order, held payload money snapshots, order-discount reconciliation, stock restoration, audit-before-commit, table release, cache invalidation, and commit-before-broadcast.

Before implementation:

- Add route/module boundary tests and run split creation/discard integration cases from `tables.test.js` plus split settlement cases from `checkout.test.js`.
- Trace `held_orders` consumers in checkout and print routes. The module may persist the payload but must not become a second checkout or printing owner.
- Confirm no duplicate split SQL remains in the route after delegation.

## Phase 7 final gate

Run relationship and split-focused integration files after each subphase, then the full suite, production build, schema-drift check, and settlement benchmark once after both subphases. Review query order and the diff manually; green tests alone are insufficient for transaction motion.

Completed evidence: `docs/superpowers/evidence/2026-07-24-phase-7-table-transactions.md`.

## Explicit non-goals

No repositories, controller layer, ORM, dependency container, route renames, schema changes, new endpoints, behavior cleanup, generic transaction wrapper, one-action-per-file split, or frontend work.
