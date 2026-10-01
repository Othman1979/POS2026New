# Table closure audit — 14 September 2026

All four findings were subsequently fixed and verified locally; implementation, corrected tests and evidence are tracked in [table closure fixes](2026-09-14-table-closure-fixes.md). The findings and test counts below describe the original audit snapshot.

**Original audit verdict: tables were not fully closed. Four actionable issues remained, including two high-priority split failures.** This is the audit snapshot of `codex/tables-workflow-hardening` at `72d4ea03`, not a claim about customer deployment. No implementation code was changed during that audit.

Three read-only Luna reviewers inspected relationships/transfers, progressive splits/settlement, and frontend state/access. They did not edit files, run tests, start servers or touch databases. The primary agent cross-checked candidates against current code, exercised real APIs in generated loopback databases, and drove the built POS in Playwright. All database workloads ran serially.

## Confirmed findings

### A1 — P1: a stale Clear can void the parent of live or partly paid split checks

Location: `backend/modules/refunds/voidOpenTableOrder.js:304`, before the stock restoration at line 530 and parent/table release at line 555.

Reproduction:

1. With service charges disabled, save two drinks on a table; stock changes from 100 to 98.
2. Terminal A opens the saved parent and the Clear confirmation.
3. Terminal B splits the table into two one-drink checks and pays the first for 2 JD.
4. Terminal A confirms Clear.

The real Clear request returns HTTP 200. The parent becomes `voided`, the table becomes available, and the unpaid held check remains. The paid 2 JD child invoice remains too. Stock incorrectly returns to 100, and the recipe journal's net consumption returns to zero, including the paid drink. Trying to pay the remaining check then returns `409 TABLE_SESSION_CONFLICT` in the API probe.

The void path locks the parent but does not reject active held splits or paid children before using the parent's complete saved quantities. Progressive child checkout intentionally reuses the parent's stock/recipe consumption; consequently reversing the whole parent reverses the paid share as well. Full cancellation retains the parent because split anchors exist, but that retention does not protect the split lifecycle.

Confirmed through actual Clear/Confirm in English at 1440 px and Arabic at 390 px. Both ordinary and xyz cancellation actors are affected. API probes also reproduce this before any child payment.

With service charges enabled, both split scenarios instead return `409 SERVICE_CHARGE_SNAPSHOT_CONFLICT`: `TableSettlementContext.js:134` rejects a `split_parent` snapshot. That happens to prevent corruption, but tells the user to refresh rather than explaining the open split checks. Treat this as part of the same missing split-state guard, not as evidence that the no-fee path is safe.

Closure requirement: reject parent Remove/Clear under the existing table/order locks whenever live split checks or paid split children make the parent ineligible. Return actionable split recovery information before touching history, stock, recipes or table state. Verify both fee modes, both xyz values, partial and whole voids, and races with split creation/payment.

### A2 — P1: split checks created by an xyz actor cannot be paid

Locations: `backend/modules/checkout/executeCheckout.js:523` and `:544`; initial provenance creation at `backend/modules/tables/splitChecks.js:1018`/`:1050`; added-check creation at `:339`; suppression at `backend/services/auditEvents.js:168`.

Set the creating user's existing `xyz` flag to 1, save a table, split two drinks into two checks, then open a check from the Split Board and confirm its cash payment. The actual payment button returns HTTP 409, `Conflict: This split check cannot be authenticated.` Both held checks remain and no paid child is created.

Checkout requires a `split_check_created` row in `audit_events` to authenticate the held child. The generic audit writer suppresses that row for xyz users. Therefore required settlement provenance depends on optional audit history. The same source path affects a newly added check when an xyz actor edits an existing unpaid split group; retained checks with earlier provenance can still have a valid marker. The added-check variant was source-verified, not separately exercised at runtime.

Confirmed through the built Split Board → POS → cash payment dialog in English desktop and Arabic mobile. Audit provenance count was zero in each fixture. A pre-existing global xyz policy causes this; attribution to the most recent void change is not established.

Closure requirement: give server-created splits durable, transactionally validated provenance that remains available independently of audit suppression. Preserve parent/table identity, revision, bundle and money validation. Do not fix this by accepting arbitrary unauthenticated held payloads or broadly restoring suppressed audit history.

### A3 — P2: Clear does not check the bill revision the user confirmed

Locations: `src/pos/stores/orderSessionStore.js:1609` and `:1716`; `backend/routes/pos/refunds.js:105`; `backend/modules/refunds/voidOpenTableOrder.js:304`.

Terminal A opens Clear on a saved drink bill. Before A confirms, terminal B uses the normal version-checked Save API to add a burger. A's cart still shows only the drinks. Confirming the existing dialog returns HTTP 200 and clears the newly saved burger as well. The never-issued order is deleted. With an ordinary actor the archive includes that unseen burger; with xyz it leaves no cancellation history, as the configured policy specifies.

The UI submits only invoice identity and optional items; the void route does not carry an expected order revision into the lock helper. Identity locking prevents touching a replacement invoice, but cannot detect changes within the same invoice. This differs from the existing stale-Save guard.

Confirmed through actual Clear/Confirm in English desktop and Arabic mobile. As a related API-only retry gap, sending an identical 0.5-unit partial void twice succeeds twice: quantity 2 → 1.5 → 1, with two history events. The current UI's normal Remove uses its full saved-row quantity, so this fractional replay is not claimed as a separately reproduced UI flow.

Closure requirement: carry the confirmed bill revision through the server's locked validation and preserve the user's cart on conflict. Define safe recovery for a lost partial-void response so retry cannot cancel additional units. Exercise stale Clear, stale Remove, concurrent saved increases, and post-commit response loss.

### A4 — P2: paying the remainder after a void falsely labels the invoice as refunded

Locations: `backend/services/RefundService.js:35` and `:53`; table checkout update at `backend/modules/checkout/executeCheckout.js:1599`; displayed badge at `src/admin/pages/Orders.vue:232`.

Save two drinks, void one as an ordinary actor, then pay the remaining drink for 2 JD. The order is a paid cash invoice but retains `refund_status='partial'`. Order History's Tables view visibly shows **Partial refund**, and the `refund_status=partial` API filter includes it. The only event is `kind='void', amount_refunded=0`; there are zero actual refunds.

The status synchronizer counts both event kinds and assigns partial to the unpaid parent. Checkout does not reset that status. Merely calling the current synchronizer after checkout would still classify a paid order with only void evidence as partial, because its initial event count includes voids.

Confirmed through real save/void/checkout APIs and the built Order History page. Cash revenue remains 2 JD and the real-refund shift rollup is empty: this finding is about false refund status and filtering, not an observed cash deduction.

Closure requirement: keep unpaid cancellation history separate from paid-refund status, including the transition to checkout. Verify zero-refund, actual partial-refund and full-refund cases.

## Candidate review and boundaries

- Luna identified that GET transfer recovery still returns the actor's own committed item-transfer receipt after `waiter.edit_locked` is revoked while `waiter.transfer_table` remains. Root confirmed GET 200 and mutation/replay POST 403. The receipt contains the previous committed result, not a new edit or another actor's operation. This is an observable difference between read and write authorization, not a demonstrated write-authorization vulnerability or one of the four closure blockers.
- The legacy, non-progressive split-discard branch lacks the realtime broadcast used by current progressive cancellation. This remains a source-only legacy follow-up; current split creation uses progressive v2 rows, and no legacy browser reproduction was performed.
- Saved quantity reductions/removals cannot bypass void history through normal Save: frontend numpad guards and backend saved-unit validation reject them. Luna checked both sides.
- Existing F1–F10 completion evidence remains relevant to its tested scenarios. It does not close the new combinations above. Independent seating, transfers, saved money/stock snapshots, permissions, revision checks and recovery were reviewed against current code, rather than inferred solely from the completion document.

## Verification and artifacts

- Production build: passed.
- Frontend table/split checks: 85 passed across 10 files.
- Broader existing backend/table regression run completed: **914 passed, 2 failed, 916 total across 29 files**. The two failures are `orderSessionBoundaries.test.js:149` (tables facade key set differs) and `tableSession.logic.test.js:377` (the second deferred table response was not registered). These failures have not been diagnosed; do not assume they are stale tests or count this as a clean run. The user paused work for sleep immediately after the run completed.
- New API characterization: 7 observations against real routes, including fee on/off × unpaid/partly paid splits, partial retry, refund status/filter and recovery authorization. The runner expects the current bad outcomes to record reproducible evidence; its successful exit is not a correctness pass.
- New browser characterization: 7 completed scenarios: split/paid/Clear and concurrent-add/Clear in English desktop and Arabic mobile, false refund badge, and xyz-created split payment in both language/viewports. The destructive stale-Clear cases used an ordinary actor on desktop and switched to xyz only for the mobile cancellation; the xyz split-creator case is separate. No page errors were recorded.

Evidence under ignored `scratch/tables-closure-audit-20260914/`:

- `probes.cjs`, `probes.json`, `probes.log` — guarded API harness and final results.
- `browser.cjs`, `browser.json`, `browser.log` — guarded UI harness and final seven-scenario results.
- `false-partial-refund-en.png`, `xyz-split-payment-en-1440.png`, `xyz-split-payment-ar-390.png`, and `split-paid-*` / `concurrent-add-*` screenshots.
- `frontend.json`, `frontend.log`, `backend.json`, `backend.log`, `build.log`.

The early browser run uncovered the xyz provenance bug while preparing the stale-Clear scenario. It is preserved as `browser-xyz-split-discovery.json`. Later fixture corrections selected Order History's Tables filter and initialized Arabic language storage before directly opening the Split Board. These were harness corrections; production behavior was not patched. The final browser run completed all seven scenarios.

Reproduce serially from the repository root:

```powershell
npm run build:admin
node scratch/tables-closure-audit-20260914/probes.cjs
node scratch/tables-closure-audit-20260914/browser.cjs
npm run test:frontend -- table splitQuantity splitCheckModal
npm run test:isolated -- tables.test.js tableItemTransfer tableSeating.test.js tableActionRecovery tableSaveRevision tableAccess tableSettlementContext tableConnectionLifetime tableRefundAuditPolicy deletedTableVoids tableSplitScope recipeLedgerSplitsMerges recipeLedgerTables tableWorkflowAudit refunds.test.js reportsRefunds orderSessionStore orderSessionBoundaries orderSessionPersistence tableSessionBoundary tableSession.logic tableMerge tableOrderPostCommit openTableNumbers
```

Each harness creates a random guarded loopback database without `IF NOT EXISTS`, records successful ownership, and removes only that database in cleanup. Final API/browser results confirm removal. No customer database, external payment service, physical printer or deployed server was exercised. No new performance claim is made from these correctness probes. No implementation, `.env`, migration, push, merge or deployment change was made during this audit.

## Pause checkpoint — 04:35 local time

The user explicitly stopped work to sleep and requested preservation of progress. The backend runner has exited with code 1 due to the two test failures. No test process from this audit remains running. Next steps on resume: diagnose those two failures without assuming their cause; run the prepared read-only `scratch/tables-closure-audit-20260914/verify-cleanup.cjs` to confirm the recorded fixture databases are absent; finish the audit verdict and then address the confirmed issues according to the resumed task scope. No fixes have been implemented. Continue in this same task and keep database suites serial.
