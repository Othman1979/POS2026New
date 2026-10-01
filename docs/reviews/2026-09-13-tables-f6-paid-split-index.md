# Paid split history lookup — F6

The split board counted paid child invoices once per active parent without an
index beginning with `orders.parent_invoice_id`. The current F5 section guard
reduced the number of parents examined for restricted staff, but each remaining
count still scanned unrelated sales history.

## Change

Add the nonunique B-tree `idx_orders_parent_payment
(parent_invoice_id,payment_method)`. Both `GET /api/pos/table_splits` and the
paid-child cancellation protection in `splitChecks.discardSplitCheck` use this
predicate. Other parent consumers either read a known invoice by primary key,
write the child lineage at checkout, or use the existing held-order parent index.
No existing index covers this parent-leading lookup.

The query, payment-method policy, section filtering, cart data and receipt
presentations are unchanged. `cash`, `card` and `split` remain paid children;
unpaid, voided, platform and receivable orders are not counted by this predicate.
F7's floor/detail payload work remains separate.

This follows MariaDB's documented [composite and covering index
behavior](https://mariadb.com/docs/server/ha-and-performance/optimization-and-tuning/optimization-and-indexes/compound-composite-indexes).
The migration requests `ALGORITHM=INPLACE, LOCK=NONE`, following the repository's
previous date-index migration and MariaDB's [online index DDL
support](https://mariadb.com/docs/server/server-usage/storage-engines/innodb/innodb-online-ddl/innodb-online-ddl-operations-with-the-inplace-alter-algorithm).
This is still an index build with storage and write costs; it is not a promise of
zero production locking or zero resource use.

## Migration authority

The normal and automatic SQL are identical. The manual fallback contains the
exact automatic block in manifest order. The fresh baseline remains schema-only;
bootstrap owns seed and ledger inserts. Test fixtures, the normalized baseline
hash and startup authority are updated together.

- Target: `2026-09-13-paid-split-parent-index-v1`.
- Ledger checksum: `ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136`.
- Automatic SQL SHA-256: `8cda3572ad83fe048f6fe059f36196c29785712250749e7e494a1c1ac95d82c9`.
- Preflight SHA-256: `ee9405c6d3c43428d2878fc3fd301ebd353a1aaed12bee5bf39fc5545e7cc4a3`.
- Exact predecessor: `2026-09-13-table-action-recovery-v1`, checksum
  `00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92`.
- New normalized baseline SHA-256:
  `84745e351d28008757c29575ed3bff2fef4fd5d2df738116d4c06df80affc071`.

The read-only preflight accepts an absent canonical index or its exact full-column,
nonunique B-tree shape. It rejects reversed, partial, extra-column and unique
replacements before automatic DDL. Startup separately verifies the complete
index shape and new ledger checksum, including when a migration is already
recorded. Interrupted execution after successful index creation can resume without
duplicating the index. Normal startup does not rerun an already applied migration.

Before any separately authorized manual application, run the matching preflight
and require `ok=1`; inspect existing indexes and the migration ledger. Apply the
maintained migration chain, then verify startup authority and representative split
counts. No production application occurred here. Dropping this index while running
the new application would intentionally fail startup validation; recovery must
keep code and schema authority consistent, preferably by repairing forward.

## Verification

Work began at clean F5 commit `691fa686c29b03aa1624743efe07186ee7e41f81`
on `codex/tables-workflow-hardening` in the shared POSApp checkout.

- Before production edits, both new schema regressions failed: the index was
  absent, and startup accepted a database without it.
- The initial schema-authority unit baseline had three failures and 108 passes:
  its mock lacked F4's existing receipt-table counts. The fixture now includes
  those fields alongside F6's requirement; the original assertions are retained.
- Initial focused GREEN: 131 passed across the new index/API and migration files
  plus schema-authority units. Upgrade, interrupted DDL, repeated automatic/raw
  execution, missing/conflicting ledgers, invalid shapes, unchanged bill rows and
  canonical SQL/baseline parity were checked against generated loopback databases.
- API checks cover parent isolation, mixed paid/nonpaid methods, legacy checks
  without a parent, register-hold exclusion, saved cart/presentation data and
  assigned-section filtering. Cash/card/split child rows each retain cancellation
  protection with no order, held, table, stock or audit mutation.
- Broader compatibility selection: 132 passed and one stale fixture assertion
  failed. The F5 baseline already contains 76 tables including F4's receipt table;
  `stockFreshSchema` still expected 75. F6 adds no table. That expected count was
  corrected before rerunning the installer check; the entire selection was not
  repeated. The passing selection includes table/QR access, real Socket.IO scope,
  table workflow regressions, recipe split/merge conservation, F4 migration,
  held-date migration and the complete automatic-migration unit file.
- Corrected installer plus packaging contract rerun: 53 passed. The real fresh
  install imported the verified baseline, seeded and validated it, and skipped
  already-covered migrations twice. Machine-account/grant statements were
  intercepted; no installed account was changed.
- Final pool-capacity-one selection: 24 passed, 194 outside-scope cases skipped.
  This includes all nine F6 schema/API cases (with different paid counts on the
  two parent bills), the split create/rewrite/cancel lease test, and 14 existing
  split/settlement cases. These verify fractional conservation, cancellation
  audit, paid-child immutability, parent guards, final-payment release, stock
  preservation, simultaneous payment and payment/edit races. The whole table
  suite and the other nine connection tests were not rerun. Counts here overlap
  earlier runs and must not be added.
- Independent read-only cleanup confirmed all 11 recorded F6 database names
  absent. The unrelated `posapp_review_recipe_p1_3b0c1cf71f91` fixture remains.
  No F6 Node/test process remained; `.env` and `.env.test` modification times
  predate this task and neither file was edited.

## Isolated read measurements

MariaDB 10.4.32. Each variant used a fresh generated loopback database with
80 active parents on 80 real table rows, four checks and two paid children per
parent; the restricted waiter could access 40 tables. Each condition used one
warm-up and seven measured HTTP samples. Measurements ran without another DB suite.
The before baseline was collected before production edits. Earlier fixture drafts
omitted legacy cart lineage/product IDs and are retained under explicitly named
`before-*-incomplete` artifacts; they are excluded from these results.

| History / actor | Paid-count row visits before → after | HTTP median ms before → after |
|---|---:|---:|
| 0 / unrestricted | 19,200 → 160 | 10.40 → 7.22 |
| 0 / restricted | 9,600 → 80 | 8.75 → 4.43 |
| 20,000 / unrestricted | 1,619,200 → 160 | 351.81 → 7.77 |
| 20,000 / restricted | 809,600 → 80 | 179.03 → 6.48 |

`ANALYZE FORMAT=JSON` changed from `ALL` to `ref` using
`idx_orders_parent_payment`. The paid subquery visited two matching child rows
per parent, with 80 or 40 loops. These visits describe this predicate, not all
queries or all work in the request.

Every condition still made three pool queries. The unrestricted responses
contained 320 checks, 413,917 JSON bytes and 321 SQL result rows across those
queries; restricted responses contained 160 checks, 206,957 bytes and 161 result
rows. Every returned check reported exactly two paid children and a valid receipt
presentation. Returned row counts are distinct from storage-engine visits.

An additional owned-fixture experiment alternated index absent/present twice on
20,003 order rows, without changing application files. It ran the shipped SQL
when adding the index. Each condition used one warm-up and seven samples inserting
1,000 rows (half ordinary sales, half related child rows), then rolled back and
verified row counts, saved totals and the two original paid children. This batch
amplifies index maintenance; it is not a single-checkout benchmark.

| Alternating round | Insert median ms, absent → present | Transaction-held median ms, absent → present |
|---|---:|---:|
| 1 | 20.46 → 21.34 | 77.33 → 79.36 |
| 2 | 20.84 → 21.67 | 78.66 → 79.76 |

Every transaction lease was released. Held times include the fixture's count
assertion and rollback. Online index creation plus the SQL block's ledger no-op
took 32.23 and 41.05 ms locally. Approximate table index allocation reported by
`information_schema` increased by 180,224 and 262,144 bytes; allocation fluctuates
with these rolled-back writes and is not an exact per-row storage estimate. The
standalone cancellation count changed from 20,003 scanned rows to two indexed
matches. No concurrent DDL/DML or customer locking behavior was measured.

Local timing is diagnostic, not customer latency or throughput evidence. Adding
this index does not bound the number of active split carts returned by the board;
that later workflow remains F7. No frontend source changed, so this step does not
claim a new browser/physical-printer verification. No Hostinger or customer database,
deployment, push, PR or release action was performed.

Raw commands, tests, logs, query plans and measurements are retained in ignored
`scratch/tables-f6-20260913/`. Reproduce the read fixture alone with
`TABLE_F6_MEASUREMENT=before|after` and
`npm run test:isolated -- --config scratch/tables-f6-20260913/measure.config.mjs`;
the label only names output, so a before comparison requires the F5 production
code/schema. The fixture never removes the index just to manufacture that baseline.

Focused commands (all from the POSApp checkout; database runs were sequential):

```powershell
npm run test:isolated -- backend/tests/integration/tablePaidSplitIndex.test.js backend/tests/integration/paidSplitIndexMigration.test.js backend/tests/unit/schemaAuthority.test.js
npm run test:isolated -- backend/tests/unit/automaticMigrations.test.js backend/tests/integration/stockFreshSchema.test.js backend/tests/integration/tableActionMigration.test.js backend/tests/integration/heldReportDateIndex.test.js backend/tests/integration/tableAccess.test.js backend/tests/integration/tableAccessSocket.test.js backend/tests/integration/tableWorkflowAudit.test.js backend/tests/integration/recipeLedgerSplitsMerges.test.js
npm run test:isolated -- backend/tests/integration/stockFreshSchema.test.js backend/tests/unit/installerPackageContract.test.js
npm run test:isolated -- --config scratch/tables-f6-20260913/cost.config.mjs
$env:POSAPP_REVIEW_CONNECTION_LIMIT='1'
npm run test:isolated -- backend/tests/integration/tablePaidSplitIndex.test.js backend/tests/integration/tableConnectionLifetime.test.js backend/tests/integration/tables.test.js -t 'paid split|connection lifetime|progressive split lifecycle'
Remove-Item Env:POSAPP_REVIEW_CONNECTION_LIMIT
```

After this verified commit, continue with **F7 only** in a new local task in the
saved project labeled `posapp`, same shared branch, model `gpt-6-astra` / `xhigh`.
Do not select the separate Gatekeeper project even though its saved path currently
matches POSApp. Remaining sequence: F7, remaining F9, F8, F10, then the separately
described authorized table-workflow features. No implementations overlap.
