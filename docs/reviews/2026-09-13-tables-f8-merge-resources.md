# Merge item reads and tax restamps — F8

The merge locked and loaded both item sets, then queried the target once per
ordinary source line. Its broad SQL predicate could also match a bundle child,
and case-insensitive collation could combine differently named saved lines.
Recomputation issued a separate tax UPDATE for every resulting parent line.

The merge now builds an exact-key map from the already-locked ordinary target
rows. Bundle parents and children are excluded from quantity matching; persisted
source children are grouped once for reminting. The key includes product/name,
saved price and pre-exemption price, note, line discount, rate/category, frozen
modifier data and money, recipe key/cost snapshot, and stock authority/snapshot.
New ordinary inserts join the same map so identical source lines still combine
with SQL decimal addition. Recipe cost snapshots are copied with their parent
rows. Exact text equality intentionally preserves distinctions that SQL collation
previously erased; this can leave additional separate lines.

The saved-tax merge path stamps unchanged calculated taxes in batches of at most
200 parent rows, scoped by invoice and item IDs. Calculations, bundle child values,
order version increments, service-charge reconciliation, sorted locks, durable
action receipts and commit/release ownership remain intact. Catalog healing and
partial voids retain their existing write path and live-tax policy. No schema,
dependency, cache, endpoint or frontend change is included.

## Verification

- All three new regressions failed before production edits: read budget, ordinary
  zero-price line merged into a bundle child, and distinct saved names combined.
- Initial GREEN: 33 cases across resource/identity, F1 discount and F2 saved-tax
  integration files. Includes modifiers, bundles, exempt/registration contexts,
  saved rates and successful merge → reload/save → payment.
- Capacity-one compatibility: 116 passed across resource/identity, recipe ledger,
  connection lifetime, durable action recovery and pricing helpers. A fault in
  the second tax batch rolls back source deletion, copied items, totals, table
  state, operation receipt, audit and stock state. Retrying the same intent then
  commits exactly once. Existing recipe/stock usage and action replay cases pass.
- Final capacity-one service-charge merge selection: nine passed, 33 outside-scope
  cases skipped. Source-only, target-only, both-bound, differing rates, malformed
  fee recovery, stale snapshot and ownership rollback remain supported.
- Real built English desktop and Arabic mobile UI with a generated loopback DB:
  merge two joined bills after catalog tax changes, replay the action, reject a
  stale save, open through a child, save/reload, split, reload/pay both checks,
  release tables, replay after settlement and close the shift. Each flow pays
  13.60 JD with 1.60 JD tax, consumes exactly two burgers and one drink, and leaves
  all tables free. No page errors or physical printer activity.

The hostile browser run also found a separate frontend recovery gap: reloading
immediately after the Save HTTP response can abort Save's automatic table-order
read. That loader clears the local active-table hint/cart. Both languages reproduced
an empty register with the 13.60 JD saved bill still intact; explicit floor reopen
recovered its complete cart, and the remaining payment flow passed. This is not
declared fixed by F8. It is the next serial correction before remaining polish.
The failed/interrupted run and successful explicit-reopen evidence are retained.
The subsequent [confirmed-Save refresh correction](2026-09-13-table-save-refresh-recovery.md)
fixes this gap and verifies native timeout plus edits during a delayed response.

## Fresh isolated measurements

One warm-up plus seven samples per size, before production edits and after, on
generated loopback fixtures with current migrations. Each ordinary source line
has a distinct note; the target has one line. All resulting totals and per-line
tax are checked. Fixture setup/cleanup is outside the measured request.

| Source lines | Transaction queries before → after | SELECTs before → after | Tax UPDATEs before → after | Connection-held p50 ms before → after | HTTP p50 ms before → after |
|---|---:|---:|---:|---:|---:|
| 1 | 26 → 24 | 15 → 14 | 2 → 1 | 5.80 → 5.47 | 8.15 → 7.94 |
| 25 | 98 → 48 | 39 → 14 | 26 → 1 | 24.01 → 9.87 | 26.99 → 12.31 |
| 100 | 323 → 123 | 114 → 14 | 101 → 1 | 82.24 → 25.86 | 85.00 → 28.80 |
| 250 | 773 → 274 | 264 → 14 | 251 → 2 | 229.28 → 61.92 | 232.55 → 65.07 |

Every sample acquired/released one transaction connection. HTTP time includes
post-commit work; statement counts exclude transaction lifecycle calls. These
local diagnostics do not establish customer throughput, lock-contention latency
or exhaustive concurrency correctness. The matching map uses memory proportional
to the loaded bill; batch SQL is bounded to 200 rows. No Hostinger/deployment,
push, PR, release or protection action occurred.

Raw scripts, logs, snapshots and browser artifacts are retained in ignored
`scratch/tables-f8-20260913/`. Test counts overlap and must not be added.
Architecture generation/check passed. Independent cleanup found all recorded F8
databases absent and preserved the unrelated older audit database; machine `.env`
and `.env.test` were not edited.
