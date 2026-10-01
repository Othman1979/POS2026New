> Historical evidence only. The purchasing subsystem described below has been retired by the [POS inventory cleanup](../2026-09-09-pos-inventory-core-closeout.md). These checks are not current release evidence.

# Procurement review and POS scope correction

Reviewed from `7db54a59` (Grok's three commits after `0be47f81`) on 2026-09-09. No application database changes, migration, deployment or hardware benchmarks. `.codex/config.toml` is unrelated and preserved.

## Reproduced and repaired

- A cost-blind `inventory.read` user received `original_unit_cost` through correction detail. Redaction now covers it. Hydration also no longer overwrites a correction line's ID with its source receipt-line ID.
- An older correction draft could post after a newer one while the receipt still displayed the higher document ID. The receipt lock now protects a stale-evidence check: overlapping older drafts reject with 409 and direct the operator to create a fresh correction. Existing posted replays remain successful. Effective-cost reads return at most the receipt's line count instead of transferring every historical correction row into Node. This does not claim constant database work over unlimited history.
- CSV replay depended on current pack metadata: editing a pack after staging made the same request return 409. Import create hashes now describe immutable CSV intent and are checked before resolving the catalog. The internal hash option is not taken from public request fields. Changed intent still rejects. Existing receipts/drafts remain readable by ID; pre-change CSV create keys do not gain a fabricated raw-CSV history and may require opening the saved draft rather than replaying staging.
- The browser rebuilt uncertain import requests from editable rows and dates. It now persists the exact request body, freezes editing during uncertainty and uses an independent staging key, so importing from an existing receipt does not reuse that receipt's create key.
- Switching a return/correction source retained the previous draft ID and request key. New sources now start new documents. Uncertain operations cannot be discarded by the New/Open controls. Reopened drafts retain their stored business date, and recovery restores ID/version. Posted lines are read-only. Confirmed conflicts have a reload action.
- Post-only operators attempted a forbidden PATCH before POST in both source-linked panels. They now post the loaded draft directly. This is component/API behavior; the admin router still deliberately limits the admin shell to admin/programmer. This review does not claim a new non-admin receiving browser surface.
- Read failures no longer escape as unhandled rejections in source selection, and post-success history refresh failures do not convert a confirmed post into an uncertain write. Supplier switching clears the previous pack editor; saving a pack clears its stale version. Supplier-only API permission can scan the identities it manages.
- Numeric supplier invoice references remain searchable alongside numeric document IDs.
- Separate supplier search generations prevent old responses replacing current results. Draft panels remain mounted across tab changes. Mobile history rows now wrap within their cards. Pack help explicitly states that cost is per base unit, not per pack.

## Scope cleanup performed

Removed the 282-line purchase-order authoring panel and its authoring test/navigation. Removed the new-PO selector and unused order lookup state from Receiving; existing linked receipts retain source IDs/read compatibility. Optional supplier/pack, receiving, source-linked returns and receipt-cost evidence remain. Receiving is hidden when both inventory flags are off, and ingredient reports are hidden from sidebar navigation when recipe tracking is off. Product catalog management remains available.

The old A–J implementation contract, C/J handoff and Grok's report are explicitly superseded for execution by [the POS core closeout](../2026-09-09-pos-inventory-core-closeout.md). Their historical evidence is preserved. No ledger tables or historical stock links were deleted merely because location workflows are out of scope.

## Verification

Counts overlap and must not be added together.

- Initial regressions: four component failures for source switching/post-only actions; a separate import-body retry failure; real DB failures for cost redaction and catalog-dependent import replay. These were corrected and rerun.
- `scratch/inventory-core-review.json`: **92 passed, 0 failed**, seven files covering procurement/migration, checkout query contracts, recipe table/reversal regressions, linked product writers, resolved compositions and published report package B. No timing or machine certification claim.
- `scratch/inventory-scope-final.json`: **26 passed, 0 failed**, final procurement and four optional-mode sale/refund cases. The latter use the real settings and checkout APIs, mixed stock/untracked products, all flag combinations, zero product stock when disabled and recipes without opening ingredient counts. They do not certify disable/resume of already-activated linked stock.
- Frontend receiving/sidebar/procurement checks: **22 passed**. Production admin build passed. Architecture generation and check passed; the pre-existing CORS note in that map is unrelated to this review.
- Built browser: English 1280 px and Arabic 390 px; 100-line draft rendered in pages of 20; actual 7,000-unit receipts; posted receipt response loss and reload/retry without duplicate stock; supplier pack management; direct receiving; vendor-return response loss/reload with exactly one returned unit; correction response loss/reload; editable CSV preview and lost-stage retry. No page errors. JSON/screenshots under `scratch/stock-receiving-*`. `false` language-specific flags indicate scenarios not run in that language, not a failure.
- A temporary fixture user-number collision in an added test was corrected; the final run above is green. No production users were created.

## What is not finished

Only the three tasks in the new closeout remain: safe optional-mode transitions/idle work; operational purchase-cost/report consistency; and dependency-aware retirement plus final core acceptance. Specifically, the old linked-stock disable guard still returns 409, receipt corrections remain evidence rather than weighted ingredient report cost, and PO backend/history schemas remain for compatibility. There is no remaining instruction to implement warehouse transfers, production orders, accounting close or replenishment planning.
