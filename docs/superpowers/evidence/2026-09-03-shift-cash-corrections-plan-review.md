# Shift Cash Corrections Plan Review — Corrections Applied

The plan was reviewed against the current shift route, admin Shifts page, POS close flow, database schema, existing integration tests, and architecture invariants. No implementation was executed.

## What was corrected

- Protected the admin starting-cash prefill from late responses and manual-input overwrite with the same request-sequence and dirty-input principles already used by the POS flow.
- Required a real nonempty, finite, nonnegative closing count before running the sales-only advisory fingerprint. Blank and negative inputs now fall through to existing server validation instead of showing a false warning.
- Made `update_cash` admin-first and removed its redundant unlocked `canAccessShift` read. The transaction's locked shift query is now the single existence/status authority.
- Expanded the test migration list so every existing cashier `update_cash` expectation follows the new `403` contract, while authorized malformed input remains `400`.
- Required correction audits to record `expected_cash` whenever a starting-cash delta changes it.
- Deleted `closed_without_count`. `actual_cash = 0.00` is a valid count and the schema has no separate "count performed" marker, so that state could not be inferred truthfully.
- Prevented a same-second closed shift from selecting itself as its previous shift by adding `p.id <> s.id`.
- Added focused admin UI gates for stale prefill, closed-shift editors, confirmations, hint rendering, and suggestion-prefill-without-mutation.
- Changed the documentation task to update the two existing shift invariants instead of adding a new invariant that contradicted them.

## Lesson for the next review

Check every proposed inference against what the schema can actually distinguish, and search all existing tests before changing authorization precedence. For asynchronous prefills, a correct endpoint is not enough: late responses and manual edits must be part of the plan. Prefer one locked authoritative read over an unlocked permission read followed by the same locked read.
