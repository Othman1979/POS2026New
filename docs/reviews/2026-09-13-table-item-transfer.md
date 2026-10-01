# Selected item and quantity transfers

## Behavior

The floor action sheet now offers **Move Items** for an occupied, unprinted owning table with transfer and saved-order edit permission. Staff choose quantities (up to six decimals), an empty or busy destination, and preview both bills before confirming. **Select all items** makes combining compatible bills a short path. The source's physical seating group is independent of the destination bill. Forty rows render initially, with explicit incremental expansion; quantity changes do not fetch data.

The API uses saved parent item IDs and quantities, complete expected financial groups, both order revisions and the existing durable operation receipt. Preview rolls its transaction back. Confirmation locks the receipt before sorted financial table/order/item groups and rejects reused seats, stale revisions, printed bills, active or paid splits, foreign ownership without override permission, and section/permission failures. Replay returns the original committed response even after a later bill edit. Connections release before realtime publication.

Normal rows move or split in batches of 200. Bundles preserve their saved children, quantities, notes and modifiers and recreate parents only where the composite foreign key requires it. Full relocation into an empty table retains the invoice identity, header discount and saved service-charge ownership. Combining or moving partial quantities refuses order-wide discounts and incompatible saved tax/service-charge contexts. Matching service-charge policies are allocated using their saved percentage and tax context, including a child snapshot for a new destination.

Partial prepared lines receive a new recipe key. Paired allocation entries transfer the recorded ingredient amounts and original cost to that key with net-zero physical usage. This prevents later edits on one bill from reversing the other bill's ingredients. Product stock snapshots are copied without using today's mapping or consuming stock again. This does not change the existing explicit Save policy when inventory settings or mappings change later.

Combined customer-payable cents must remain exact. The still-open bills round their net and tax components individually, so these components can shift a cent between them while their combined payable amount stays fixed. A transfer that changes the combined payable amount even one cent is rejected; no hidden rounding adjustment is introduced.

The dialog reads saved items without replacing the POS draft. Affected unsaved local changes refuse preview/confirmation. The exact request is stored before sending and reuses existing lost-response/reload recovery. A clean affected local session closes after confirmation; new edits made while awaiting the response remain at their original revision. Explicit table reopening remains the normal way to load the revised bill. Reads and preview cover response headers and JSON bodies with a 15-second deadline and abort on dialog disposal.

## Verification

- Initial backend cases failed because no item-preview route existed. Recipe allocation and service-charge cases were added before enabling those paths; a reproduced recipe journal constraint failure was corrected by leaving the waste-only `reason` field unset.
- 33 item-transfer integration cases pass across the final broad run and the corrected, narrowly rerun header-discount fixture. That fixture initially submitted the discounted amount as `subtotal`; the server correctly rejected it. It now submits pre-discount subtotal 6 and payable total 5. No production change was needed for that fixture correction.
- The broad single-connection run passed 319 of 320 cases across item transfer, existing durable table-action recovery and the order-session store. The one fixture failure above then passed on its own. Earlier all 30 transfer cases passed at normal pool capacity, including a barrier that held two transactions at their table-lock query: one committed and one returned 409.
- Cases cover empty/busy destinations, full-source release, later receipt replay, changed payload reuse, malformed/excess quantities, stale source/target, printed/reused seats, permissions, paid splits, incompatible fees, payable-cent refusal, and rollback/lost commit with partial recipes and service-charge ownership. Whole and partial recipe moves survive independent saves/voids; priced modifiers, saved mixed tax rates, line discounts and fractional bundles survive catalog changes. Recorded linked stock restores once on void despite a changed mapping and disabled current stock setting.
- 40 focused frontend checks pass, including affected cart/note/discount refusal, edits during a lost response, duplicate submission suppression, six-decimal arithmetic and stalled response headers/bodies. Existing floor localization and read-lifecycle checks remain green.
- Production build and architecture generation/check pass. The visual detector reported three advisory typography differences from older DESIGN.md guidance; the dialog follows the established POS surface, controls and touch sizes. Visual review was performed in this conversation, without agents.
- Real built UI, HTTP and MySQL passed English/Arabic desktop/mobile: unsaved draft refusal with draft retained, invalid quantity, joined busy destination, reviewed totals, lost committed response, stale preview refusal, reload/save, and separate card settlement of 4 JD and 6 JD. Stock ended at 95 from 100 after five sold units; moving them added no stock or print-queue writes. No browser page errors occurred. The second visual/hostile pass additionally passed an empty destination, decimal `.5`, Select all items, source release, compatible bill combination and focus restoration.

## Resource evidence and limits

This is a new operation; the prior behavior was a missing endpoint, so there is no equivalent successful before-operation timing. The baseline saved bills, physical movements, print queue and failed-preview state were captured before mutation and compared after each relevant case.

Five isolated samples per size, one connection maximum, two bills, ordinary partial drink rows; fixture setup/authentication are outside the measured operation:

| Selected lines | Preview queries / returned rows | Apply queries / returned rows | Preview held p50 | Apply held p50 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 5 / 6 | 21 / 13 | 2.10 ms | 8.21 ms |
| 25 | 5 / 30 | 21 / 85 | 2.06 ms | 11.65 ms |
| 100 | 5 / 105 | 21 / 310 | 2.80 ms | 20.27 ms |
| 250 | 5 / 255 | 25 / 760 | 3.95 ms | 31.19 ms |

Each sample acquired and released exactly one connection. Query growth at 250 reflects bounded write batches. Existing total recomputation reads each resulting bill once; no new per-normal-line SELECT was introduced. Bundle parent inserts necessarily obtain a parent ID before their child insert. The table does not characterize large recipe histories, every bundle mix, engine rows examined, physical devices or customer latency.

Raw logs, guarded browser harnesses, screenshots, measurement samples and fixture-cleanup evidence are in ignored `scratch/table-item-transfer-20260913/`. All 14 recorded databases were generated collision-protected loopback fixtures and are verified removed. No machine environment file, customer database, physical printer, remote branch or deployment was changed.
