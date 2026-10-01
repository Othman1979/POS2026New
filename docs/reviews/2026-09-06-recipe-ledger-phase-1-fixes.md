# Recipe ledger Phase 1 corrections — Tasks 1–4

All nine findings from the [Phase 1 review](2026-09-06-recipe-ledger-phase-1.md), based on commit `d6cc1ab2`, are corrected and verified. Tasks 1 and 2 passed their original checks and needed no application changes. The fixes below concern the arithmetic and ledger service in Tasks 3 and 4, plus transaction retry handling in the existing admin caller.

## Changes and direct verification

| Finding | Correction | Evidence after correction |
| --- | --- | --- |
| F1: inconsistent summary | Fetch ingredient fields, latest Count, remaining balance, and daily totals in one SQL statement. | Injected real commits after each possible query boundary; every returned balance corresponds to an actual committed state. |
| F2: stale Count expectation | Acquire the ingredient lock, then use current locking reads for the latest Count and its tail. | An earlier repeatable-read snapshot plus a concurrent receipt now records expected 110 for Count 110. |
| F3: fractional reversal residue | Allocate six-place quantities cumulatively with scaled integers. Record each component's product quantity even when its ingredient movement rounds to zero. Additions use the cumulative target too. | Actual checkout followed by three fractional refunds leaves both ingredient quantity and product quantity at zero for the tiny and ordinary components. A fractional-addition unit case also passes. |
| F4: changed opening replay | Normalize and compare the complete batch; validate unique ingredient IDs before writing. | Same batch in reverse order replays; changed quantities, missing entries, and added entries return 409. Invalid batches write no movements. |
| F5: fabricated initial balance | Return null until an applicable Count exists, including the first Count's expected quantity and variance. | Receipt before first Count has null running balance; first Count has null expectation and variance. |
| F6: concurrent replay error | On a duplicate insert, reload the committed winner using a current read and compare its payload. Keep correction locks in ingredient-first order. | Two simultaneous HTTP receipts succeed with one replay and one persisted movement. A transaction with an older snapshot also replays correctly. |
| F7: whole portions | Divide scaled integers before flooring. | 0.3 / 0.1 yields 3 portions; 0.299999 / 0.1 yields 2. |
| F8: opening key overflow | Derive bounded child keys from a hash of the batch key and ingredient ID; retain lookup support for earlier child keys. | A two-ingredient opening with a 64-character key succeeds and replays without extra movements. |
| F9: history query scaling | Aggregate the prefix before the page, fold its relevant span once, and use the ingredient/kind/id index for latest Count. Aggregate daily summary values in SQL. | The two-row query transfers 5 database rows, compared with 20,002 before. Latest-Count execution reads one matching entry per lookup on the measured fixture. |

Concurrent first Counts for unrelated ingredients exposed an InnoDB gap-lock deadlock during verification. The admin transaction wrapper now retries the entire transaction up to three attempts only for `ER_LOCK_DEADLOCK`. Audit writes remain inside the transaction; change events emit after commit. Three simultaneous first Counts succeed.

## Verification record

- The initial adversarial regression file failed all 10 cases against the original implementation. Those 10 cases pass with the fixes. The additional cumulative-addition unit case was also observed failing before its correction.
- Broad regression: **14 files, 457 tests**. The first run passed 456 and exposed one old day-report assertion requiring a non-null expectation for the first Count. The fixture has no earlier Count, so that assertion pinned F5's defect. After explicitly asserting null expectation and variance, all **3 report tests passed**. The other 13 files had already passed against identical application code; they were not unnecessarily rerun. All 457 distinct tests are now verified passing.
- The original migration upgrade, repeat, predecessor, checksum, and fixture-parity checks passed on MariaDB 10.4.32. No schema or migration changed during these corrections.
- `git diff --check` passed.

The broad run covered `inventoryService`, `recipeLedgerPure`, and `recipeLedgerMigration` unit tests; and `recipeLedgerPhase1Regression`, `recipeLedgerSchema`, `recipeLedgerService`, `recipeLedgerAdmin`, `recipeLedgerTables`, `recipeLedgerSplitsMerges`, `recipeLedgerReversals`, `recipeLedgerReport`, `tables`, `checkout`, and `refunds` integration tests. The [compact verification results](../../scripts/reviews/recipe-ledger-phase1-verification.json) record both runs and the tested source hashes.

The [regression tests](../../backend/tests/integration/recipeLedgerPhase1Regression.test.js) exercise the real HTTP handlers, service, and local database. The [query runner](../../scripts/reviews/recipe-ledger-phase1-query-check.cjs) and its [results](../../scripts/reviews/recipe-ledger-phase1-query-results.json) preserve row-transfer counts, EXPLAIN, and actual query execution details for a 20,000-row historical fixture plus a recent Count and receipt.

The reduced row transfer is not a production latency claim. Prefix and post-Count aggregates still read the applicable movement interval; a filtered page includes intervening movements so its historical balances stay correct. The local history timings are subject to host load and were not used as a performance pass threshold.

All database work used newly named scratch databases through the [isolation preload](../../scripts/reviews/recipe-ledger-phase1-preload.cjs). Neither the business database nor the existing test database was seeded. No deployment or historical data repair was performed. Existing ledger rows are not rewritten by these fixes.

Phase 2 (Tasks 5–8) remains pending. Broader tests exercise those call sites for regressions from this service change; they do not replace the next phase's adversarial review. Frontend/browser verification remains in the later review phases.
