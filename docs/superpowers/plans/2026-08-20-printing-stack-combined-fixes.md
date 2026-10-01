# Printing Stack Combined-Audit Fixes Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Rev 2 (2026-08-20):** folds in every confirmed finding of `docs/superpowers/evidence/2026-08-20-printing-stack-combined-fixes-plan-adversarial-review.md`. Independently re-verified before folding: the `router.expandBundlesForKitchen` export + its test importers, the `recordRetry` `JOB_TRANSPORT_STARTED` wall (`job-store.js:257-261`, pinned by `v2-job-store.test.js:56-57`), TCP's mark-after-connect ordering (which is why TCP retries work today), `HELD_KITCHEN_SENT_LINE_CONFLICT` on missing baseline lines, the single-category seed trap, the C# thread-pool `print_raw` (the helper is NOT serial for prints — rev 1's stall worry was wrong), and the staff-connect emit at `server.js:326-328`.

**Goal:** Close the P0/P1 findings of the combined printing audits (`docs/superpowers/evidence/2026-08-19-spooler-combined-audit-reconciliation.md`): unrouted-item deadlock, print_method decoupling, agent crash-loop, retry caps, Winspool honesty, backoff jitter, updater ordering, drain UX, and stale-station visibility.

**Architecture:** Server-side fixes live in the existing kitchen-routing/held-order/watchdog services; agent-side fixes live in `pos-spooler-printer/v2/` and the C# Winspool helper. No schema changes, no migrations (Luna not needed), no new dependencies.

**Tech Stack:** Node/Express backend (vitest), Vue 3 admin/POS (`backend/tests/unit/orderSessionStore.test.js` exists for store logic; SFC templates have no harness — build only), plain-node spooler test suite (`pos-spooler-printer/tests/run-tests.js` spawnSyncs each file), PowerShell installer contracts (`npm run test:installer`, exactly 6 files), C# via Windows inbox `csc.exe` (PowerShell tool, NOT Git Bash — MSYS mangles `/flags`).

## Global Constraints

- **No push, no deploy, no production migration, no Hostinger change.** Local commits only.
- **ONE vitest process at a time** (shared `posapp_test`). Focused files during tasks; full `npm run test:unit` exactly once at the end.
- No schema or data migrations anywhere → the Luna workflow is not triggered. In particular: do NOT add values to the `device_status` enum (Task 5 relies on `spoolerSync.js:150` coercing unknown strings to `'unknown'`).
- i18n: English keys are the identity fallback; only `src/shared/i18n/ar.json` gets new rows.
- `docs/architecture.html` is generated — edit `docs/architecture.json` then `npm run architecture` && `npm run architecture:check`.
- All anchors verified on master `a91d3012` (2026-08-20). Line numbers drift — confirm by the named symbol.
- Owner rulings (settled): unrouted category = receipt-only by design on every path; no auto-retry after bytes may have reached a device; no auto-reassignment of assigned jobs; backend is the new default print method.
- **Task order is load-bearing:** Task 1 before Task 2 (architecture reword). Task 3 before Task 4 (crash guard first). Task 4 before Task 5 (Task 5 consumes the store revert). Tasks 6-9 are independent.

---

### Task 1: Unrouted kitchen items are receipt-only on held/subscription paths (fixes checkout deadlock)

**Verified defect:** `queueHeldKitchenRound` and `buildHeldKitchenBaseline` throw 422 `HELD_KITCHEN_UNROUTED_ITEMS` when ANY cart line has no kitchen printer (`backend/services/HeldOrderKitchenDispatch.js:329-332`, `:372-374`). Delta computations include unrouted lines (`backend/routes/pos/orders.js:884-885`, `:1016-1017`; `backend/modules/checkout/executeCheckout.js:328-338` — connection is `conn`, symbols `assignedItems`/`currentPreparationLines`/`outstandingDelta`). Proven deadlock: add an unrouted drink to a fired held order → follow-up 422s AND checkout 409s `HELD_KITCHEN_FOLLOW_UP_REQUIRED` forever. Table orders (`saveTableOrder.js:870`), void (`voidOpenTableOrder.js:174`), and register `POST /api/print` (`print.js:1305-1308`) already silently skip. Cancellation is `queueHeldKitchenCancellation` built from snapshot `printer_ids` (`orders.js:1204-1208`, `HeldOrderKitchenDispatch.js:419-457`) — snapshots never contain unrouted lines, so cancel is unaffected.

**Files:**
- Modify: `backend/services/kitchenPrintRouting.js` (extract + export routability helpers)
- Modify: `backend/services/HeldOrderKitchenDispatch.js` (`queueHeldKitchenRound`, `buildHeldKitchenBaseline`)
- Modify: `backend/routes/pos/orders.js` (both delta sites, symbols near `:884` and `:1016`)
- Modify: `backend/modules/checkout/executeCheckout.js` (`outstandingDelta` site, `:328`)
- Modify: `backend/routes/pos/subscriptions.js:738` (one conjunct)
- Test: `backend/tests/unit/kitchenPrintRouting.test.js`; held fire/follow-up cases in `backend/tests/integration/bundle.heldOrders.fire.test.js` (it owns `fireHeld` at `:44` and `withoutCategoryRoute` at `:52` — `heldOrders.test.js` is claim-focused and lacks kitchen tooling); the deadlock-checkout regression in `backend/tests/integration/checkout.test.js` (held-context checkout pattern at `:3674+`, `held_order_context: claim.context`); `backend/tests/integration/subscriptionRedemptions.test.js`

**Interfaces:**
- Produces:
  - `async filterRoutableKitchenLines(executor, expandedLines) -> { routable: [], unrouted: [] }` — input MUST already be bundle-expanded; bundle children route by their own `category_id`.
  - Internally: `async resolveKitchenPrinterMap(executor, items) -> { categoryMapping, categoryPrinters }` — extracted verbatim from the two queries inlined in `buildKitchenPrintPayloads` (`kitchenPrintRouting.js:46-63`). `buildKitchenPrintPayloads` is refactored onto it so there is ONE routability implementation. Routability rule (copy of `:68-72`): direct category OR its `parent_id` maps to ≥1 active kitchen printer.

**Semantics decisions (locked):**
1. Unrouted lines are filtered OUT of: round batch ids, payloads, snapshot `lines`, and — **symmetrically — BOTH `baseline` and `current` of every `computePositiveKitchenDelta` call**. Symmetric filtering is what makes a mid-order printer unmap converge instead of throwing `HELD_KITCHEN_SENT_LINE_CONFLICT` (the missing-baseline-line throw at `HeldOrderKitchenDispatch.js:183-186` fires when a line routed at fire time later loses its printer and current-side-only filtering hides it). `cart_data` keeps ALL items.
2. **Accepted trade-off (document in the commit):** symmetric filtering means a line whose category is unmapped AFTER its ticket printed loses the sent-line protections (reduce/remove → cancellation workflow) for as long as it is unroutable. That is an admin-caused rarity; the alternative is the deadlock this task removes.
3. Inside `queueHeldKitchenRound` and `buildHeldKitchenBaseline`: filter FIRST, then use `routable` EVERYWHERE — batch id, `rawData.items`, **and the `expanded` list that feeds `primaryLinesByPrinter` route evidence** (`const expanded = expandBundlesForKitchen(routable)` replacing the current `expandBundlesForKitchen(items)` at `HeldOrderKitchenDispatch.js:337-339` and `:376-378`) — otherwise `HELD_KITCHEN_ROUTE_EVIDENCE_MISSING` 409 re-ships the deadlock under a new code. Both unrouted 422s are deleted. `routable.length === 0` throws the EXISTING `HELD_KITCHEN_ITEMS_EMPTY` 422 (`'There are no preparation items to send.'`) — fire is a user-triggered button (`orders.js:1579`), never automatic.
4. Follow-up whose delta empties after filtering → existing 409 `HELD_KITCHEN_NO_DELTA` for free.
5. `dispatchHeldOrderKitchen` compat seam (`:472-491`): leave untouched (`count < 1` → 422 already matches).
6. Subscriptions (ponytail — no helper needed there): `subscriptions.js:738` becomes `if (!payloads.length) throw ...` — delete only the `|| unroutedItems.length` conjunct. `buildKitchenPrintPayloads` already skips unrouted lines from payloads; a redemption still requires ≥1 ticket. The all-unrouted test at `subscriptionRedemptions.test.js:51-58` stays green.

**Fixture rule (trap confirmed):** ALL seed products share `category_id = 1` (`seed.js:1375-1378`) and `heldOrders.test.js:18-23` maps category 1 to a kitchen printer in `beforeAll` — a "chicken + cola" cart from seed products is two ROUTED lines and would pass on today's deadlock. Mixed-cart tests MUST insert a second category with no printer mapping (`INSERT INTO categories (id, name, is_active) VALUES (2, 'Unrouted Drinks', 1)` + a product in it), or wrap with the existing `withoutCategoryRoute` helper pattern (`bundle.heldOrders.fire.test.js:447`) where all-unrouted is wanted.

- [ ] **Step 1: failing unit tests** in `kitchenPrintRouting.test.js` (seeded style of that file):

```js
it('filterRoutableKitchenLines splits by direct and parent category routes', async () => {
    // seed: category 1 → printer (existing); insert category 2 (no printer); category 3 child of 1
    const { routable, unrouted } = await filterRoutableKitchenLines(db, [
        { id: 1, category_id: 1 }, { id: 2, category_id: 3 }, { id: 3, category_id: 2 }, { id: 4, category_id: null }
    ]);
    expect(routable.map(l => l.id)).toEqual([1, 2]);
    expect(unrouted.map(l => l.id)).toEqual([3, 4]);
});
```

- [ ] **Step 2:** `npx vitest run backend/tests/unit/kitchenPrintRouting.test.js` — FAIL (export missing).
- [ ] **Step 3:** implement `resolveKitchenPrinterMap` + `filterRoutableKitchenLines`; refactor `buildKitchenPrintPayloads` onto the map helper (behavior identical — its existing tests stay green untouched).
- [ ] **Step 4:** re-run Step 2 — PASS, whole file PASS.
- [ ] **Step 5: failing integration tests** — held cases in `bundle.heldOrders.fire.test.js` (insert the second category + product in its setup; reuse `fireHeld`/`withoutCategoryRoute`), the deadlock-checkout regression in `checkout.test.js` (model on the held-context checkouts at `:3674+`):

```js
it('fires a mixed held order: routed items ticket, unrouted items are receipt-only', async () => {
    // cart = [seed product (routed cat 1), new product (unrouted cat 2)] → POST fire_kitchen
    expect(fire.statusCode).toBe(200);
    // exactly 1 print_queue kitchen job; payload items contain the routed product only
    // kitchen_snapshot.lines has the routed line only; cart_data still has both lines
});

it('checkout succeeds after adding an unrouted item to a fired order (deadlock regression)', async () => {
    expect(checkout.statusCode).toBe(200); // was 409 HELD_KITCHEN_FOLLOW_UP_REQUIRED
});

it('follow-up with only unrouted additions reports no delta', async () => {
    expect(followUp.statusCode).toBe(409);
    expect(followUp.body.code).toBe('HELD_KITCHEN_NO_DELTA');
});

it('firing an all-unrouted held order is an empty-preparation error', async () => {
    expect(fire.statusCode).toBe(422);
    expect(fire.body.code).toBe('HELD_KITCHEN_ITEMS_EMPTY');
});

it('unmapping a routed category mid-order does not block follow-up or checkout', async () => {
    // fire [routed product]; withoutCategoryRoute(1, ...): add another routed-cat product via edit,
    // follow-up → 409 HELD_KITCHEN_NO_DELTA (everything filtered), checkout → 200. No SENT_LINE_CONFLICT.
});
```

  In `subscriptionRedemptions.test.js`: mixed meal (routed + unrouted line) → 200 with one ticket; existing `:51-58` untouched.
- [ ] **Step 6:** run the two integration files — new tests FAIL with today's 422/409s.
- [ ] **Step 7:** implement per Semantics decisions 1-6. Delta call sites become (same shape at all three):

```js
const routableBaseline = (await filterRoutableKitchenLines(conn, kitchenSnapshot.lines)).routable;
const currentPreparationLines = (await filterRoutableKitchenLines(conn, expandBundlesForKitchen(assignedItems))).routable;
const delta = computePositiveKitchenDelta({ baseline: routableBaseline, current: currentPreparationLines });
```

  (executeCheckout uses `heldKitchenSnapshot.lines` and its own `conn`.) Snapshot lines are stored expanded and carry `category_id`, so the same filter applies to both sides.
- [ ] **Step 8:** `npx vitest run backend/tests/unit/kitchenPrintRouting.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/bundle.heldOrders.fire.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/bundle.print.test.js` — ALL PASS. (`bundle.heldOrders.fire.test.js:436-448,:499-511` pin 422 + rollback on all-unrouted fire — they must stay green via decision 3.)
- [ ] **Step 9: commit** `fix(kitchen): unrouted categories are receipt-only on held and subscription paths`

---

### Task 2: Kitchen fires regardless of receipt method; backend becomes the default

**Verified:** the ONLY register kitchen call site is `orderSessionStore.js:2293-2295`. `print_method`'s single server source is `GET /api/system/settings` (`system.js:59`, `?? 'browser'`); no backend logic branches on the value; call-center and `public_preferences` projections omit it. The kitchen branch no-ops cleanly with zero routed printers (`print.js:1305-1308` + success message with count 0).

**BLOCKER avoided (confirmed):** `print.js:1311-1312` exports `router.printKitchenOrder` AND `router.expandBundlesForKitchen`; the local `expandBundlesForKitchen` copy is imported by `backend/tests/integration/bundle.print.test.js:2` and used at `bundle.tables.test.js:467`. Deleting the whole `:1106-1303` block breaks `print.js` at load. **Delete only `legacyPrintKitchenOrder`; keep the export by re-exporting the routing service's implementation:** `router.expandBundlesForKitchen = require('../services/kitchenPrintRouting').expandBundlesForKitchen;` (the two copies are semantically identical — `bundle.print.test.js` passing against the re-export is the proof; if it fails, STOP and report, do not patch the test).

**Harness correction:** `backend/tests/unit/orderSessionStore.test.js` exists and drives `processCheckout`/`dispatchToNodeSpooler`. The gate change gets a real test there, not just a build.

**Deploy note (record in commit):** installs with no `print_method` settings row (seed never writes one) flip receipts AND admin thermal reports (`useThermalReportPrint.js:21`) to the spooler. Owner-approved (S1). Explicit `'browser'` rows untouched.

**Files:** `backend/routes/system.js:59`, `src/pos/stores/orderSessionStore.js:2293`, `backend/routes/print.js` (targeted delete + re-export), `docs/architecture.json`, tests `backend/tests/integration/settingsValidation.test.js` (or sibling), `backend/tests/unit/orderSessionStore.test.js`, `backend/tests/integration/bundle.print.test.js` (must stay green unmodified).

- [ ] **Step 1: failing tests** — (a) `GET /api/system/settings` returns `print_method: 'backend'` after deleting the settings row; (b) in `orderSessionStore.test.js`, model on the JoFotara case near `:2195` that already sets `printMethod: 'browser'`: a non-table, non-held checkout with `printMethod === 'browser'` must call `dispatchToNodeSpooler` with `'kitchen'` (assert on the calls array filtering `c[0] === 'kitchen'`), and a table order (`wasTableOrder`) must NOT. **Third case, required:** a restored held order with `kitchenFired: true` must NOT dispatch. Ungating makes `kitchenAlreadyFired` (`:2292`) load-bearing on every install, and it is the ONLY dedupe — a fired round carries a server-owned `print_batch_id` while the checkout dispatch derives `order-<invoice>` (`kitchenPrintRouting.js:82`), so the two get different kitchen idempotency keys (`printJobIdentity.js:63`) and the station prints the order twice. Set up with `store.restoreHeldOrder({ items, held_order_context: { id, version, claimToken, kitchenFired: true, baselineUnknown: false } })`.
- [ ] **Step 2:** run both files — (a) FAILS on `'browser'`, (b) FAILS on missing kitchen call.
- [ ] **Step 3:** flip `system.js:59` to `?? 'backend'`; change `orderSessionStore.js:2293` to `if (!wasTableOrder && !kitchenAlreadyFired) {`. Do NOT touch `:2301` (fiscalFastPath) or `:2333` (duplicate receipt).
- [ ] **Step 4:** run both files — PASS.
- [ ] **Step 5:** delete `legacyPrintKitchenOrder` only; add the re-export; run `npx vitest run backend/tests/integration/bundle.print.test.js backend/tests/integration/bundle.tables.test.js` — PASS unmodified. `grep -rn legacyPrintKitchenOrder backend/ src/` → nothing.
- [ ] **Step 6:** `docs/architecture.json`: remove defect `d-legacy-kitchen-dead-code`; **remove** defect `d-unrouted-kitchen-items-silent` too (owner ruling + Task 1 make it intended behavior — a "resolved by design" entry left in `defects[]` would badge `prn-kitchen-routing` as defective forever, and `severity` has no non-defect value: `build-architecture.js:71` allows only critical/major/minor). Carry the rule into the `prn-kitchen-routing` node `sub` instead. ALSO reword the `flow-kitchen-station-routing` summary (`architecture.json:3123` still describes silent drop as a defect-shaped behavior); re-anchor `printKitchenOrder` steps that drift from the deletion. `npm run architecture && npm run architecture:check` — PASS.
- [ ] **Step 7:** `npm run build` — PASS.
- [ ] **Step 8: commit** `feat(print): kitchen tickets fire regardless of receipt method; backend is the default`

---

### Task 3: Agent must survive store write failures in the print path (CRIT-1)

**Verified leak points (anchors re-checked 2026-08-20 against the current file):** `finishFailure` (`printer-workers.js:84-112`) rethrows non-`JOB_TERMINAL` store errors at `:109`, and `scheduleRetry`'s `store.recordRetry` (`:68`) sits inside that same try via the `else` at `:104-106`. From there it escapes three ways:
1. `runLane` (`:127`) — `finishFailure` is called from the IIFE's catch (`:160`); the IIFE has `.finally()` at `:162` and **no** `.catch()`.
2. `pumpRender` (`:199`) — `finishFailure(record, error, 'render')` at `:237` is itself **the catch handler** for the inner try (`:215-238`), so a throw there is caught by nothing; it unwinds past the `finally` (`:241`) and rejects the promise that `wake()` dropped via `queueMicrotask(pumpRender)` (`:272`).
3. `pumpRender`'s own `finally` re-enters `pumpRender()` unawaited at `:243` — a third dropped promise.

No other unawaited async rejects: `status-monitor.js:39-67` poll has internal try/catch; `retryTimers` callback is sync; `agent-runtime.js` awaits `tick()` whose outer catch swallows.

**Design:** targeted guards, NO global process handler:
1. Wrap the `finishFailure(...)` calls at `:160` and `:237` in try/catch. **`owned.delete` alone is NOT enough and must not be shipped on its own** — proven by experiment: `pumpRender` calls `collect()` on every loop iteration (`:239`), so a released record that is still runnable is re-collected immediately and the same doomed job renders forever in microtasks — 1.27M iterations in 25s, with a 5ms `setTimeout` never firing. That starves timers, sync and I/O while leaving a live process NSSM will never restart, i.e. strictly worse than the crash-loop being fixed. The guard must therefore release **and defer**: a `deferredUntilWake` set that `collect()` skips, cleared only in `wake()` (never in `pumpRender`, whose own re-entry at `:243` would bring the spin straight back) and in `stop()`. Net effect: one attempt per sync tick. (Verified safe: the lane loop is serial, so re-pick means a sequential second attempt, never two in-flight transports; `transport_started` records are not in `RUNNABLE_STATES` so they are never re-collected at all. This is NOT a retry mechanism for `transport_started` jobs — that is Task 4.)
2. Backstop the three dropped promises: `.catch(err => log)` after the IIFE's `.finally(...)` (`:162`), `queueMicrotask(() => pumpRender().catch(err => log))` (`:272`), and the same on the re-entry at `:243`.

**Files:** `pos-spooler-printer/v2/printer-workers.js`; test `pos-spooler-printer/tests/v2-printer-workers.test.js`.

- [ ] **Step 1: failing test** — write helpers INLINE in this file's own style (inline renderer/transport objects and the default timers, see its existing cases around `:51-57`; `realishTimers`/`okRenderer` do NOT exist — invent nothing):

```js
(async () => {
    let failures = 0;
    const rejections = [];
    const onRejection = (err) => rejections.push(err);
    process.on('unhandledRejection', onRejection);   // registered handler => child won't die; assertion carries the verdict
    const rows = [record(300, 1, 'receipt')];
    const store = fakeStore(rows);
    const originalRecordRetry = store.recordRetry;
    store.recordRetry = (...args) => {
        if (failures++ === 0) { const e = new Error('ENOSPC: no space'); e.code = 'ENOSPC'; throw e; }
        return originalRecordRetry(...args);
    };
    const workers = createPrinterWorkers({
        store,
        timers: { setTimeout: (fn) => { fn(); return Symbol('t'); }, clearTimeout: () => {} },
        renderer: { async render() { return { path: 'x.bin', hash: 'h', bytes: 1 }; }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({ async send() { const e = new Error('conn refused'); e.code = 'PRINTER_UNAVAILABLE'; throw e; } })
    });
    workers.start();
    await workers.idle();
    workers.wake();
    await workers.idle();
    await new Promise(r => setImmediate(r));
    process.removeListener('unhandledRejection', onRejection);
    assert.strictEqual(rejections.length, 0, 'a store write failure must never escape as an unhandled rejection');
    assert.ok(failures >= 2, 'the record was re-picked after the store recovered');
    await workers.stop();
})();
```

  (Adjust `record`/`fakeStore` usage to the file's actual local helpers; the immediate-fire `setTimeout` keeps the retry loop moving without real time.)
- [ ] **Step 2:** `npm --prefix pos-spooler-printer test` — the new test FAILS (`rejections.length === 1`). If instead the child process dies non-zero, that is the same failing signal — record which.
- [ ] **Step 3:** implement the guards. Keep `JOB_TERMINAL` semantics untouched.
- [ ] **Step 4:** package suite — PASS.
- [ ] **Step 5: teeth:** revert the `runLane` guard only → test fails; restore.
- [ ] **Step 6: commit** `fix(spooler): survive store write failures in the print path instead of crash-looping`

---

### Task 4: Retry cap + pre-byte Winspool failures become retryable (store revert included)

**BLOCKER this task must solve first (verified):** the Windows transport calls `markTransportStarted` via `beforeWrite` BEFORE the RPC reaches the helper (`printer-transports.js:261-269`, `platform-helper.js:103-105`) — correct, because C# may write bytes after a JS crash. But `job-store.js:257-261` throws `JOB_TRANSPORT_STARTED` on `recordRetry` from `transport_started` (pinned by `v2-job-store.test.js:56-57`). So classifying `WINspool_OPEN_FAILED` as `transient_safe` WITHOUT a store change either crash-loops (pre-Task 3) or strands the job in `transport_started` until restart → `uncertain`. TCP never hits this because it marks AFTER connect (`printer-transports.js` TCP `send`: connect → verify → mark → stream; connect failures are `transient_safe` with `marked === false`).

**Design (three layers):**
1. **Store:** new `revertTransportStarted(queueId)` — explicit transition `transport_started → rendered` (artifact retained). Fail-closed everywhere else: `recordRetry` keeps throwing from `transport_started`. Update `v2-job-store.test.js` to pin BOTH: `recordRetry` still throws from `transport_started`; `revertTransportStarted` then `recordRetry` succeeds; `revertTransportStarted` from any other state throws. Crash windows stay safe: die before revert → `recoverTransportStarted` → `uncertain` (conservative); die between revert and `recordRetry` → state `rendered` → re-picked and re-sent (the error proved zero bytes).
2. **Transport:** in the Windows `send()` catch, map provably-pre-byte codes to `transient_safe` AND set `error.preByte = true`: `WINspool_OPEN_FAILED`, `WINspool_START_DOC_FAILED`, `WINspool_START_PAGE_FAILED` (C# order verified `PosSpoolerPlatform.cs:238-282`: all three precede any `WritePrinter`; `finally` aborts the doc). `ARTIFACT_HASH_MISMATCH → permanent_safe` (no preByte needed — `recordResult` is legal from `transport_started`; JS-side `verifyArtifactHash` already classifies it `permanent_safe` at `printer-transports.js:50`). Unknown codes keep the `uncertain` default — pin that default in the test.
3. **Worker:** in the retry path, when `currentRecord(record).state === 'transport_started'`: if `error.preByte === true` → `store.revertTransportStarted(record.queue_id)` then `scheduleRetry` as normal; else → treat as `uncertain` via `recordResult` (defensive — today no code path produces transient_safe+transport_started, keep it that way explicitly).
4. **Cap:** in `scheduleRetry`, when `attempts >= maxAttemptsFor(record)` (`60` for priority ≤1 = 59 delays = `1+2+57×5 ≈ 4.8 min`; `20` for reports = `2+5+10+16×30 ≈ 8.3 min`) → `store.recordResult(record.queue_id, { outcome: 'permanent_failure', error_code: 'RETRY_LIMIT_EXHAUSTED', error_message: errorMessage(error), failure_stage: stage })` + `owned.delete`. Verified chain with NO server change: `outcomeState` accepts `permanent_failure` (`job-store.js:48-50`), load allows it (`:7,:77`); `settleUpdate` maps it → `dead_letter` (`spoolerSync.js:27-31`); badge emits on `queueStateChanged` (`spoolerV2.js:127-128`).

**Anchors re-verified 2026-08-20 after Task 3 (`fbb8565d`) shifted `printer-workers.js`:** `scheduleRetry` `:70`, `finishFailure` `:90`, `releaseAfterStoreFailure` `:123` (new), `runLane` `:142`, `collect` `:208`, `pumpRender` `:219`, `wake` `:294`. In `job-store.js`: `recordResult` `:249` has **no** `transport_started` guard (so layer 3's `uncertain` write is legal), `recordRetry` `:257` holds the wall at `:258-261`, `markTransportStarted` `:245`, `recoverTransportStarted` `:113`; the pin is `v2-job-store.test.js:57`.

**Task 3 interaction Task 4 must respect:** a store write that throws inside `finishFailure` is now caught by `releaseAfterStoreFailure`, which releases the record AND adds it to `deferredUntilWake` so `collect()` skips it until the next `wake()`. The retry cap's `recordResult` runs inside that same try, so a failed cap write degrades to "deferred one tick", not a spin and not a crash. Do not remove or bypass the deferral — reverting it spins the render loop 1.27M times in 25s.

**Files:** `pos-spooler-printer/v2/job-store.js`, `v2/printer-transports.js`, `v2/printer-workers.js`; tests `tests/v2-job-store.test.js`, `tests/v2-printer-transports.test.js`, `tests/v2-printer-workers.test.js`.

- [ ] **Step 1: failing store tests** (the pinned throw at `v2-job-store.test.js:56-57` is UPDATED, not deleted — it now proves the wall holds unless explicitly reverted).
- [ ] **Step 2: failing transport tests** — `WINspool_OPEN_FAILED` → `transient_safe` + `preByte === true`; `ARTIFACT_HASH_MISMATCH` → `permanent_safe`; unknown code → `uncertain` without `preByte`.
- [ ] **Step 3: failing worker tests** — (a) a Windows-shaped failure (`preByte`, state `transport_started`) lands in `retry_wait` with the artifact retained, and a subsequent send succeeds; (b) a transient failure with `attempts` pre-seeded at 59 becomes `permanent_failure` `RETRY_LIMIT_EXHAUSTED` instead of retry 60; (c) transient WITHOUT `preByte` from `transport_started` records `uncertain`.
- [ ] **Step 4:** run package suite — new tests FAIL. **Step 5:** implement all three layers. **Step 6:** package suite PASS.
- [ ] **Step 7: commit** `fix(spooler): retry pre-byte winspool failures and cap transient retries`

---

### Task 5: Winspool "completed" means the local queue drained (consumes Task 4's revert)

**Verified:** `PrintRaw` returns after `EndDocPrinter` with hardcoded `device_status:"unknown"`, `job_id` never consulted (`PosSpoolerPlatform.cs:217-293`); JS → `confidence:'os_accepted'` → terminal `completed`. `print_raw` runs on the C# thread pool (`:429-430`) and Windows `send()` does NOT use `serializeHelper` (only probe/watch do, `printer-transports.js:284-303`) — drain latency is per-printer, not station-wide.

**Task 4 outcome + facts re-verified for this task (2026-08-20, commits `8ebd9f7e` / `42cac736`):** helper error codes are **mixed case** — `WINspool_*`, not `WINSPOOL_*` (rev-2 had this wrong and it would have matched nothing). Chain confirmed end to end: C# `throw new InvalidOperationException("WINspool_…")` → `PosSpoolerPlatform.cs:385 code = error.Message` → `{error:{code}}` → `platform-helper.js:214` sets `error.code` with **no** `failureClass` → `printer-transports.js:279` passes the guard → mapping applies. **Any new code this task introduces must join the `WINspool_` family.** Also confirmed: C# emits `ARTIFACT_HASH_MISMATCH` itself at `:236`, before `OpenPrinter` at `:238`, so the transport's `permanent_safe` mapping is live, not dead. The retry cap was verified against the real job-store, not just a pre-seeded fixture: attempts climb 1→59 across real retries, then `permanent_failure` / `RETRY_LIMIT_EXHAUSTED`.

**Design (C#):** after `EndDocPrinter`, dispose the write-deadline timer FIRST (it `SetJob DELETE`s and would fake a drain mid-poll — verified it lives until `finally` `:297`). Then poll `GetJob(hPrinter, jobId, level 1)` every 400ms within `drain_ms` (payload param, default 10000, clamp 2000-30000):
- `GetJob` fails with `ERROR_INVALID_PARAMETER` (87) → `drained`.
- **Job status has `JOB_STATUS_PRINTED` (0x80), `JOB_STATUS_COMPLETE` (0x1000), or `JOB_STATUS_DELETED` (0x100) → `drained`** (KEEPPRINTEDJOBS / lingering-job drivers must not be misread as stuck — review finding, folded).
- `JOB_STATUS_PRINTING` (0x10) seen at any poll → set `printing_seen`.
- Any OTHER `GetJob` failure (access denied, buffer) → stop polling → `drain_unknown` (never `drained` on an unproven read).
- Budget exhausted → `SetJob(..., JOB_CONTROL_DELETE)`: delete OK AND never `printing_seen` → `stuck_deleted`; else → `drain_unknown`.
- New P/Invoke: `GetJob` + minimal `JOB_INFO_1` Status read (marshal like the existing `GetPrinter` pattern `:163-164`).
- Hung-`GetJob` backstop (accepted, documented): nothing in C# cancels it; the JS per-request timeout fires → `uncertain` + helper recycle (`platform-helper.js:120-137`) — conservative and safe.

**Design (JS, Windows `send()`):** pass `drain_ms`; `timeoutMs: deadlineMs + drainMs + 2000` (helper honors per-request timeout — verified `platform-helper.js:120-137`). Map: `'drained'` → `success:true, confidence:'spooler_drained'` (STRING ONLY — `spoolerSync.js:150` coerces unknown device_status values to `'unknown'`, no enum change); `'stuck_deleted'` → throw `classified('WINspool_JOB_STUCK','transient_safe')` **with `preByte = true`** (job deleted, never printing — Task 4's revert makes the retry real; without Task 4 this task is BLOCKED); `'drain_unknown'` → `classified('WINspool_DRAIN_UNKNOWN','uncertain')`. Network-share caveat: drained = forwarded to the remote spooler; confidence stays `spooler_drained`, never `device_confirmed`.

**Files:** `pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs`, `v2/printer-transports.js`; tests `tests/v2-printer-transports.test.js`.

- [ ] **Step 1: failing JS tests** — fake helper returning each `device_status`; assert the mapping incl. `preByte` on `WINspool_JOB_STUCK`, the `drain_ms` payload field, and the widened `timeoutMs`.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement JS. Run — PASS.
- [ ] **Step 4:** implement C#; compile via PowerShell: `& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize+ /out:... PosSpoolerPlatform.cs`.
- [ ] **Step 5: physical verification on this machine (XP-80C):** (a) normal receipt → `completed`, `spooler_drained`, paper out; (b) printer POWERED OFF → job must NOT complete: expect `stuck_deleted` → retry_wait cycles → (cap) dead_letter + badge; Windows queue left empty; power back on → NO ghost print. (c) Record whether KEEPPRINTEDJOBS is enabled on this queue (`Get-Printer | Get-PrintConfiguration` or printer properties) — the PRINTED/COMPLETE branch is otherwise UNVERIFIABLE from source; note the result in the commit.
- [ ] **Step 6:** package suite PASS.
- [ ] **Step 7: commit** `fix(spooler): winspool jobs complete only when the local queue drains`

---

### Task 6: Jitter on sync failure backoff — SAFE, one ordering note

**Verified:** delay is computed BEFORE `consecutiveFailures++` (`agent-runtime.js:199-201`) — keep that order, the expected array below encodes it (increment-first would give `[0,6250,12500,12500,12500]` and is WRONG). Consumers of `createAgentRuntime`: `server.js:136` (default), `v2-sync-runtime.test.js`, `v2-hostile-runtime.test.js` — a destructured dep with a default breaks none.

- [ ] **Step 1:** update the pinned test (`v2-sync-runtime.test.js:207`) to pass `random: () => 0` (delays unchanged `[0,2000,5000,10000,10000]`) and add `random: () => 1` asserting `[0, 2500, 6250, 12500, 12500]`.
- [ ] **Step 2:** implement `random = Math.random` dep; failure delay `base + Math.floor(base * 0.25 * random())`. Package suite PASS.
- [ ] **Step 3: commit** `fix(spooler): jitter the sync failure backoff`

---

### Task 7: Updater writes the journal only after recovery scripts are current — SAFE

**Verified by review + me:** no-journal repair is a health check (`Repair-SpoolerStartup.ps1:189-264`); `Install-SpoolerRecoveryScripts` needs no journal (`SpoolerLayerState.ps1:238-252`); failure between scripts and journal leaves `$rollbackPrepared` false and the catch only deletes the rollback dir — benign. Anchor strings are unique: the call `Install-SpoolerRecoveryScripts -SourceRoot $PSScriptRoot` (`Update-Spooler.ps1:403`) and the call `Save-SpoolerJournal 'prepared'` (`:401`, function def is `:262`); the token list at `installerUpdateContract.test.js:550` uses `toContain`, not `indexOf` — no collision.

- [ ] **Step 1:** add to `installerUpdateContract.test.js`: `expect(updater.indexOf("Install-SpoolerRecoveryScripts -SourceRoot $PSScriptRoot")).toBeLessThan(updater.indexOf("Save-SpoolerJournal 'prepared'"));` → `npm run test:installer` FAILS.
- [ ] **Step 2:** move the call above the journal write; `$rollbackPrepared = $true` stays immediately after `Save-SpoolerJournal`.
- [ ] **Step 3:** `npm run test:installer` — 6 files PASS. **Commit** `fix(installer): refresh recovery scripts before writing the update journal`

---

### Task 8: Drain warning tells the truth; recovery is documented — SAFE

**Verified:** `'Drain this station before replacement?'` has exactly one referrer (`Settings.vue:1395`) and one ar.json row (`:2507`) — delete that row in this commit. State path: `%ProgramData%\POS-Spooler\state\agent.json` (`agent-identity.js:8`, root `server.js:18-19`; mention the `SPOOLER_STATE_DIR` override in one clause). Drain requires the queue to empty before decommission (`spoolerSync.js:168-177`) — the "in-flight jobs stay unknown" caveat belongs to FORCE-REPLACE only; do not imply drain strands jobs.

- [ ] **Step 1:** new confirm text: `t('Drain permanently retires this station identity once its queue empties. It cannot be reactivated - recovery requires resetting the agent identity on the station PC. Continue?')` + AR translation; delete the old key's ar.json row.
- [ ] **Step 2:** runbook section "Recovering a drained or decommissioned station": stop service → rename `agent.json` → `agent.json.retired-<date>` → start service → fresh identity registers (generated column frees the station key, `baseline.sql:693-695`) → verify Online in Settings → Print Queue. Separate paragraph for force-replace: ITS unresolved jobs stay dead_letter/unknown → audited reprint.
- [ ] **Step 3:** `npm run build` PASS. **Commit** `fix(admin): honest drain warning + documented station recovery`

---

### Task 9: Stale-station visibility (lease decision: surface, never mutate)

**Decision (closes audit CRIT-3/P1-6):** no server-side mutation of `sent`/`local_accepted` rows — a partitioned-but-alive agent may hold or have printed them; mutation reopens duplicate paper. `locked_until` stays dormant. Visibility instead.

**Query (house style is UTC — `spoolerAgents.js:171`; the pool pins `time_zone='+00:00'` but do not rely on it):**

```sql
SELECT s.spooler_id, a.last_sync_at, COUNT(q.id) AS queued
  FROM spooler_stations s
  LEFT JOIN spooler_agents a
    ON a.spooler_id = s.spooler_id AND a.status IN ('active','draining')
  INNER JOIN printers p ON p.spooler_id = s.spooler_id
  INNER JOIN print_queue q
    ON q.printer_id = p.id
   AND q.status IN ('pending','sent','local_accepted','cancel_requested')
 WHERE a.agent_id IS NULL
    OR a.last_sync_at IS NULL
    OR a.last_sync_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)
 GROUP BY s.spooler_id, a.last_sync_at
```

**Emit design (two review findings folded):**
1. The 30s interval (`server.js:363-370`) emits `stale_print_stations` `{ stations: [...] }` to `staff` when the SET of spooler_ids changes (signature = sorted ids — `last_sync_at` is static while stale, so no flap; a station crossing 120s emits once). **Transition to empty MUST emit `{ stations: [] }`** so the chip clears.
2. **Staff connect emit** — copy the failed-prints connect pattern (`server.js:326-328`): on join, `socket.emit('stale_print_stations', ...)` with the current result; without this a newly opened admin session shows 0 until the next transition, possibly never.
3. Frontend: `realtime.js` `socket.on('stale_print_stations')` → `emitAdminRealtime` (chain verified: `realtime.js:56-57` → `useSystemStatus.js:31,37` → `AdminHeader` via `App.vue:97-98`). **Fold `staleCount > 0` into `systemHealth` as a warn state** (`useSystemStatus.js:12-26`) so the header dot changes — a chip inside the dropdown alone is invisible to operators who never open it. POS `useSocket.js` is out of scope (admin-only signal).

**Files:** `backend/services/printQueueWatchdog.js`, `server.js` (interval + connect emit), `src/admin/realtime.js`, `src/admin/composables/useSystemStatus.js`, `src/admin/components/AdminHeader.vue`, `src/shared/i18n/ar.json`; test: the file that already seeds `print_queue`/`spooler_agents` for `getFailedPrintJobsCount` (find with `grep -rln getFailedPrintJobsCount backend/tests`).

- [ ] **Step 1: failing test** — station A (pending job, agent `last_sync_at` 3 min old) → returned with `queued ≥ 1`; station B (pending job, fresh agent) → absent; station C (stale agent, no jobs) → absent; station D (pending job, NO agent row) → returned.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement `getStalePrintStations(db, { staleMs = 120000 })` + both emits + frontend chain + AR keys.
- [ ] **Step 4:** focused vitest PASS + `npm run build` PASS.
- [ ] **Step 5:** append the decision paragraph to the reconciliation doc.
- [ ] **Step 6: commit** `feat(spooler): surface stale print stations to the admin header`

---

## Verification (end of plan)

1. Focused suites per task ran already. Then exactly once: `npm run test:unit` (pre-06:00 `taxExemptWorkflow` caveat noted — owned by a separate task).
2. `npm --prefix pos-spooler-printer test`, `npm run test:installer`, `npm run build`, `npm run architecture:check` — all green.
3. Live smoke on this machine: checkout a register order with a routed + an unrouted item under `print_method=backend` → kitchen ticket has the routed item only, receipt has both; drain warning shows the new text (do NOT confirm it).
4. No push, no deploy, no migration. Merge decision belongs to the owner.

## Out of scope (deliberately)

- Winspool `device_confirmed` (needs printer status-back — physical matrix work).
- Receipt-printer binding to registered browsers (YAGNI until device login is enforced everywhere).
- Report-render starvation scheduling (needs a rush-hour measurement).
- HTTPS enforcement / printer-IP hiding (posture round).
- Dropping `locked_until` (migration churn; dormant by recorded decision).
- Tray/control app (`task_2689b772`); pre-06:00 test fix (`task_4cde165e`).
