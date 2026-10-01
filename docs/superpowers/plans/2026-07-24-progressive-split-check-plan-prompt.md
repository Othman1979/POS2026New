# Progressive Split-Check Plan-Writer Prompt

Write an executable, TDD-first plan for the evidence in `docs/superpowers/evidence/2026-07-24-progressive-split-check.md`. Map every affected persistence and runtime boundary before listing tasks. Every task must name exact files, consumed/produced interfaces, the failing behavior test, expected RED result, minimal implementation, GREEN command, and regression command.

Attack the plan before accepting it:

1. Trace split create -> list/print -> restore -> checkout -> receipt/JoFotara -> refund/report.
2. Trace inventory at table save, split creation, each partial payment, final payment, cancellation, and rollback.
3. Prove canonical lock ordering for create, pay, cancel, normal table save/checkout, transfer/swap/merge, join, and disjoin.
4. Prove a table cannot be freed, transferred, edited, or normally settled with active split buckets.
5. Prove cancellation cannot reopen already-paid quantities.
6. Prove the last concurrent payment is the only transaction that closes the parent and table.
7. Prove tax-inclusive, income-tax, fixed/percent discount, service charge, bundle, custom item, fractional quantity, and exact-cent snapshots continue through the existing sources of truth.
8. Verify migration, test seed, schema drift, frontend routing, sockets, and legacy rows are included.
9. Remove duplicated helpers and speculative files from the plan.

Reject any design that requires parsing `reference_name` for ownership, recalculates persisted split money in the browser, adds a general workflow framework, or introduces seat assignment during ordering.
