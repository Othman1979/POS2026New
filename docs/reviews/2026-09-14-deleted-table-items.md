# Future table cancellations and non-cash voids

Implemented on `codex/tables-workflow-hardening`. The user chose **future cancellations only**; no historical void backfill or cleanup is included. No customer database, production deployment or physical printer was used.

Follow-up: [xyz table-void recording policy](2026-09-14-table-void-xyz-policy.md) adds the requested exception for users with `xyz=1`; the original verification below records the archive implementation before that exception.

## Behavior

- Saved/printed table-item removal, partial quantity cancellation and Clear all use the existing permissioned, locked void transaction. Purely unsaved local drafts are still discarded locally.
- `deleted` stores the cancelled quantity and the complete original saved `order_items` snapshot, including modifiers, bundle links, stock snapshots, recipe keys, notes and saved prices/taxes. Source IDs are historical references, not foreign keys to live orders/items. A full cancellation also captures the saved automatic service-charge row.
- `item_snapshot.quantity` and its tax amounts describe the original source row; the separate `quantity` column describes what was removed. Bundle component quantities follow the rounded remaining stored quantities. A child may archive zero units when its parent's cancelled portion is below the child's six-decimal precision; its original snapshot remains available. Parent cancellations must be positive and use at most six decimal places.
- Partial cancellation retains and reprices the remaining bill. A full cancellation deletes live items and the order only when it has no public order/invoice number, issuance timestamp, tender, checkout idempotency key, parent/child split relationship, held split, JoFotara document, remittance, subscription purchase or actual refund record. Historical/financial anchors retain the existing voided-order behavior.
- `refunds(kind='void', amount_refunded=0, refund_method=NULL)` and `refund_items` remain the financial audit records. The transaction detaches only eligible void events from `refunds.invoice_id` before deleting the order; the existing foreign-key cascade cannot erase those events. Archive, stock reversal, audit, table release and deletion commit or roll back together.
- Both shared refund rollups and shift refund totals now require `kind='refund'`. A non-cash void does not reduce cash, net sales or net sales tax. Previously a malformed positive legacy void could reduce shared cash totals, and even normal zero-cash voids could pollute refund counts/tax. Closed shifts' previously saved expected-cash totals are not rewritten.
- Refunds & Voids still shows cancelled item value separately as **no money returned**. Archived events have item details but no broken link to a removed original order. Actual refunds retain their invoice links and cash behavior.
- Existing stock restoration and recipe reversal policy is preserved. A cancellation value is not a cash expense or a new waste/loss posting.

## Schema and deployment sources

Migration `2026-09-14-deleted-table-items-v1` follows `2026-09-13-table-seating-v1`. It only makes the refund invoice reference nullable and creates the archive; it does not move existing data. Normal SQL, automatic SQL, preflight, ordered manifest, identical cumulative manual fallback, fresh baseline/checksum, installer ledger, fixture setup and startup validation are updated.

The tested migration covers exact-predecessor upgrade, compatible partial installation, automatic/current no-op, raw replay with detached events, conflicting existing table, missing predecessor and checksum conflicts. Historical order/item/refund snapshots remain unchanged. Full-chain tests also now include the earlier table index/seating migrations in their explicit expected lists.

## Verification

- 17 focused cancellation cases: saved/printed Clear, fractional removal and last-item deletion, retained history/report details, real refund versus malformed void cash and shift close, protected legacy/paid split identities, bundle/modifier snapshots, precision boundaries, rollback at archive insert and final order deletion, concurrent full cancellation, stale retries against a newly occupied table and kitchen queue creation after source deletion.
- 73 existing refund, 74 shift, 9 refund-report, 6 recipe split/merge and 10 connection-lifetime cases passed. The existing numbered-bundle retention case is explicitly labelled legacy.
- 7 archive migration, fresh installer, 111 schema authority, 48 automatic-migration unit and 12 automatic-upgrade integration cases passed across the focused runs. Early failures were corrected installer count/ledger and stale expected migration lists; no final required case remains failing.
- 22 frontend transition/localization cases passed. Two pre-existing split fixtures now supply the server `table_id` required by the implemented split identity contract.
- `npm run build:admin`, `npm run architecture`, `npm run architecture:check` and whitespace checks passed.
- Real built UI/API/DB acceptance passed English and Arabic at 1440 and 390 px: create a table through the UI, add products, Save Table, Remove, cancel Clear, confirm Clear, inspect history and archived rows, verify original-order links for real refunds only, refund a real cash sale and close the shift. Expected cash remained 50 after cancellation plus the separate fully refunded sale, and product stock returned to its initial balance. Arabic runs use the real `mark_printed` API; no physical guest-check output is claimed. One English-mobile run loses Clear's response after the real commit and verifies stale retries cannot create another event. No page errors occurred.
- A real queue assertion verifies the captured cancellation ticket survives order deletion with original item name, note, quantity, table and stable void batch ID. Printer hardware and spooler delivery were not exercised.

Evidence is in ignored `scratch/deleted-voids-*.json`, `scratch/deleted-voids-*.log`, `scratch/deleted-table-items-browser/` and `scratch/deleted-table-items-performance.json`. Rerunnable browser and measurement scripts are under `scripts/reviews/`.

The final metadata check found none of the 14 recorded generated fixture database names still present. Browser and performance scripts also reported successful cleanup on every completed run.

## Local performance comparison

The previous writer at `6a5bc3bf2c2531a579508012e3cde477814661e5` and the final writer ran sequentially on identical generated schemas, alternating order over three samples. Only the writer source changes in this comparison; it is not a full historical checkout. The reference measurements were reconstructed from Git after the initial behavioral RED cases.

| Saved rows | Before / after SQL queries | Before / after rows returned | Before / after median time |
| --- | --- | --- | --- |
| 1 | 15 / 19 | 9 / 10 | 8.20 / 11.67 ms |
| 20 | 34 / 38 | 28 / 29 | 9.43 / 19.14 ms |
| 201 | 215 / 220 | 209 / 210 | 35.90 / 59.50 ms |

Archiving adds one batch insert per 200 rows, also flushing at approximately 256 KiB, plus the bounded eligibility read, void-history detachment and order deletion. The pre-existing per-item financial audit inserts remain. This is a measured latency increase for the added durable history/cleanup work, not a performance improvement. Rows returned are not engine rows scanned. Every run released its transaction connection before kitchen dispatch; no customer latency or whole-device performance claim is made.
