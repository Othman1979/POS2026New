# Adversarial review — printing-stack combined-fixes plan

**Date:** 2026-08-20
**Reviewer:** Grok (read-source only). No code changed. No test suite run (shared `posapp_test` is not this reviewer's).
**Subject:** `docs/superpowers/plans/2026-08-20-printing-stack-combined-fixes.md`
**Context read first:**
- `docs/superpowers/evidence/2026-08-19-spooler-combined-audit-reconciliation.md`
- `docs/superpowers/evidence/2026-08-19-spooler-stack-failure-audit.md`

**Stance.** Try to break the plan before execution. Owner rulings in the plan's Global Constraints and Task 1 "Semantics decisions" are settled — a finding is "the plan fails to implement a ruling", not "I disagree with the ruling". Locked: no schema/data migration, no push/deploy, English i18n keys are identity (only `ar.json` gets new rows), `docs/architecture.html` is generated.

**Headline.** Do not execute the plan as written. Tasks 4 and 5 are blocked by a store invariant the plan never names. Task 2 as specified does not compile. Task 1's mixed-cart tests will pass on today's deadlock if they use the seed products. Tasks 6–8 are safe.

---

## What Fable must change before execution (checklist)

Do these in the plan text. Do not start coding until the blocked items have an actual design.

1. **T4/T5 (BLOCKER).** Name and close `job-store.js` `recordRetry` throwing `JOB_TRANSPORT_STARTED` after Windows `markTransportStarted`. Pre-byte Winspool errors and `stuck_deleted → transient_safe` cannot retry today. Transport-layer tests will pass while the worker still never retries.
2. **T2 (BLOCKER).** Delete only `legacyPrintKitchenOrder`. Keep `router.expandBundlesForKitchen` by re-exporting `kitchenPrintRouting.expandBundlesForKitchen`. The local helper is not private.
3. **T1.** Filter snapshot-line construction (not only `rawData.items` / delta `current`), or mixed fire still 409s `HELD_KITCHEN_ROUTE_EVIDENCE_MISSING`. Implement decision 6 (config regression) on **baseline ∩ current**, or stop claiming silent drop. Mixed heldOrders tests must insert a second category — `SEED.product1` and `SEED.product2` share `category_id = 1`, already mapped in that file's `beforeAll`.
4. **T2.** Add one `orderSessionStore` test: kitchen `dispatchToNodeSpooler` fires when `printMethod === 'browser'`. The harness exists; "no SFC/store test harness" is false.
5. **T3.** Rewrite the failing-test snippet against helpers that exist in `v2-printer-workers.test.js`. `realishTimers()` / `okRenderer()` do not exist.
6. **T9.** Emit `stale_print_stations` on staff socket connect (copy `server.js:326-328`). Decide whether `systemHealth` changes. Use `UTC_TIMESTAMP()` in the SQL. Signature the set of `spooler_id`s; emit `stations: []` so the chip clears.
7. **Order.** T3 before T4. T4's store exception before T5 `stuck_deleted` retry. T1 before T2's architecture reword of `d-unrouted-kitchen-items-silent`.

---

## Per-task verdicts

| Task | Verdict |
| --- | --- |
| T1 unrouted = receipt-only | NEEDS CHANGES |
| T2 print_method + kitchen ungated | NEEDS CHANGES (would not compile) |
| T3 crash guard | NEEDS CHANGES |
| T4 retry cap + Winspool class | **BLOCKED** |
| T5 Winspool drain | **BLOCKED** |
| T6 jitter | SAFE TO EXECUTE |
| T7 updater journal order | SAFE TO EXECUTE |
| T8 drain UX | SAFE TO EXECUTE |
| T9 stale-station visibility | NEEDS CHANGES |

---

## Task 1: Unrouted kitchen items are receipt-only on held/subscription paths

**VERDICT: NEEDS CHANGES**

### Callers enumerated (repo-wide)

| Symbol | Live sites | Plan coverage |
| --- | --- | --- |
| `buildKitchenPrintPayloads` | def `kitchenPrintRouting.js:37`; `HeldOrderKitchenDispatch.js:328,357`; `subscriptions.js:727`; `print.js:1306` | Held + subscription yes. `printKitchenOrder` already ignores `unroutedItems` (`print.js:1305-1308`). |
| `expandBundlesForKitchen` | routing service `:12`; `HeldOrderKitchenDispatch`; `orders.js:884,1016`; `executeCheckout.js:328`; **second copy** `print.js:1111` | Delta sites listed. |
| `computePositiveKitchenDelta` | def `:150`; `orders.js:885,1017`; `executeCheckout.js:329`; unit test | All three live sites listed. |
| `assignStableHeldLineIds` | def `:75`; `orders.js:877,890,1006,1117,1572`; `executeCheckout.js:322` | Plan correctly does not rewrite it — `cart_data` keeps every line. |

Table / void / call-center: `saveTableOrder.js:870` and `voidOpenTableOrder.js:174` go through silent-skip `printKitchenOrder`. Call-center fire is the same `queueHeldKitchenRound` at `orders.js:1579`. No missed preparation feeder. The reconciliation doc's "held/table path 422s" is wrong for tables; the plan is right.

### Findings

1. **MAJOR — Decision 6 is not what the one-liner does.**
   - Ruling: a category that was routed at fire and then loses its printer "silently drops out of the preparation view".
   - Planned change: filter **current** only (`orders.js:884-885`, `:1016-1017`, `executeCheckout.js:328-332`).
   - `computePositiveKitchenDelta` (`HeldOrderKitchenDispatch.js:182-186`) throws `HELD_KITCHEN_SENT_LINE_CONFLICT` when a baseline line is missing from current. That line is still in `kitchen_snapshot.lines` (it was routed at fire). Follow-up and checkout then 409.
   - That **is** the fail-closed deadlock the ruling rejected — triggered by config change instead of a drink. Silent drop requires filtering **baseline ∩ current** (or dropping snapshot lines that are no longer routable) **before** the delta. There is no test for this path.

2. **MAJOR — `HELD_KITCHEN_ROUTE_EVIDENCE_MISSING` still 409s mixed carts if Step 7 is followed loosely.**
   - After payloads, `queueHeldKitchenRound` does `expandBundlesForKitchen(items)` on the **original** cart, then `lines.some(line => !line.printer_ids.length)` (`HeldOrderKitchenDispatch.js:337-339`; same at `:376-378`). An unrouted cola has empty `printer_ids`.
   - If `items` is not replaced by `routable` **before** that map, mixed fire still dies with 409 after the 422s are deleted.
   - Step 7 says "snapshot lines" and "evidence checks now run over routed lines only" — it does not show the `expanded = …` rewrite. Easy to ship the deadlock under a new code.

3. **MAJOR — New heldOrders tests cannot use `SEED.product1` + `SEED.product2`.**
   - Both products are `category_id = 1` (`backend/tests/fixtures/seed.js:1375-1378`).
   - `heldOrders.test.js:18-22` already maps that category to a kitchen printer in `beforeAll`.
   - A "chicken + cola" cart in this file is **two routed lines**. Tests would pass on today's deadlock.
   - Must insert a second category, or reuse `withoutCategoryRoute` from `bundle.heldOrders.fire.test.js:447`.

4. **NOTE — Existing 422 tests exist; they do not pin `HELD_KITCHEN_UNROUTED_ITEMS`.**
   - Plan claim "there is none" is false for 422-on-unrouted fire, true for the exact publicCode.
   - `bundle.heldOrders.fire.test.js:436-448` and `:499-511` assert `statusCode === 422` on **all-unrouted** fire, not the code. After the change they still pass if empty fire stays 422 `HELD_KITCHEN_ITEMS_EMPTY`.
   - Step 8 already runs this file — keep that.

5. **NOTE — Cancel is not `kind: 'cancel'` on `queueHeldKitchenRound`.**
   - Production cancel is `queueHeldKitchenCancellation` (`orders.js:1204-1208`), built from snapshot `printer_ids` (`HeldOrderKitchenDispatch.js:419-457`).
   - Snapshots never contain unrouted lines today (422 prevents it) and will not after the fix. Cancellation is safe.
   - `buildRoundBatchId` (`:277-278`) is not used on cancel (`buildCancellationBatchId`).
   - Replay: a 422 fire rolls back, so `last_operation_id` is not stored; mixed-cart batch ids do not collide across the deploy.

6. **NOTE — `protectedLineIds` / checkout one-liner compile.**
   - `protectedLineIds` is `kitchenSnapshot.lines` (`orders.js:872`, `:1009`). Unrouted lines never land there, so they are not protected; `assignStableHeldLineIds` will not reshuffle a fired chicken because cola was filtered. Cart still gets IDs for drinks (`:898`, `:1572-1577`).
   - `executeCheckout.js:202,275,322-332`: connection is `conn`, symbols are `assignedItems` / `currentPreparationLines` / `outstandingDelta`. The one-liner compiles.

7. **NOTE — Subscriptions.**
   - `subscriptions.js:738` is `if (!payloads.length || unroutedItems.length)`. Mixed carts already have payloads; the `unroutedItems.length` conjunct is the bug. `if (!payloads.length)` is enough.
   - All-unrouted test at `subscriptionRedemptions.test.js:51-58` stays valid.

**Concrete failure the plan would ship:** mixed held fire still 409s (finding 2), or tests go green on two routed seed products (finding 3), or a mid-order printer unmap deadlocks checkout (finding 1).

---

## Task 2: Kitchen fires regardless of receipt method; backend becomes the default

**VERDICT: NEEDS CHANGES**

1. **BLOCKER — `expandBundlesForKitchen` on `print.js` is not private.**
   - Plan deletes `legacyPrintKitchenOrder` **and** its local helper (`print.js:1106-1303`).
   - `legacyPrintKitchenOrder` has zero callers. The helper is exported:

```
print.js:1311-1312
router.printKitchenOrder = printKitchenOrder;
router.expandBundlesForKitchen = expandBundlesForKitchen;
```

   - Importers: `backend/tests/integration/bundle.print.test.js:2`, `bundle.tables.test.js:467` (`printModule.expandBundlesForKitchen`).
   - Delete the function and `print.js` fails to load (`expandBundlesForKitchen is not defined`). Architecture already says this (`docs/architecture.json` defect `d-legacy-kitchen-dead-code`).
   - Fix: delete only `legacyPrintKitchenOrder`; re-export `kitchenPrintRouting.expandBundlesForKitchen`.

2. **MAJOR — "There is no SFC/store test harness" is false.**
   - `backend/tests/unit/orderSessionStore.test.js` exists and drives `processCheckout` / `dispatchToNodeSpooler`.
   - Nothing currently asserts kitchen is **blocked** on `'browser'`, so existing tests likely stay green (receipt assertions filter `c[0] === 'receipt'`, e.g. `:2092`, `:2218`).
   - The actual T2 behavior (kitchen fires when `printMethod === 'browser'`) is untested. Natural place: the JoFotara case at `:2195` that already sets `'browser'`.
   - `npm run build` + grep will not catch a missed conjunct.

3. **NOTE — Server source of `print_method` is only `GET /api/system/settings`.**
   - `backend/routes/system.js:59` (`?? 'browser'`). POST validates it (`:190`) but no backend branch uses the value.
   - Call-center projection omits it (`:47-52`). `public_preferences` omits it (`:267-276`).
   - Frontend `|| 'browser'` fallbacks (`useTerminal.js:58`, `Settings.vue:1101`, `useThermalReportPrint.js:21`, `PosTerminal.vue:554`) only apply before a successful fetch or on a missing field — leave them, as the plan says.

4. **NOTE — Flip effects the owner already approved (S1).**
   - Seed never inserts a `print_method` row. Installs with **no** settings row flip receipts **and** admin thermal reports (`useThermalReportPrint.js:21`) from `window.print` / browser popup to the spooler. Explicit `'browser'` rows are untouched.
   - `Settings.vue:903` initial `ref('browser')` is pre-fetch only.

5. **NOTE — Architecture.**
   - No flow step names a `printMethod` gate (`flow-cash-sale` ends at socket emit). Search-and-update-if-exists is fine.
   - Do reword `d-unrouted-kitchen-items-silent` **and** `flow-kitchen-station-routing` summary (`architecture.json:3123` still says silent drop is just how routing works).
   - Line `:1305` for `printKitchenOrder` will drift when the legacy block is removed — confirm the symbol.

**Concrete failure the plan would ship:** `print.js` does not load; bundle print/table tests cannot import `expandBundlesForKitchen`; kitchen-on-browser is unverified.

---

## Task 3: Agent must survive store write failures in the print path

**VERDICT: NEEDS CHANGES**

Leak points confirmed:

- `runLane` IIFE `.finally` without `.catch` (`pos-spooler-printer/v2/printer-workers.js:131-166`)
- `queueMicrotask(pumpRender)` (`:269-273`)
- `finishFailure` rethrows non-`JOB_TERMINAL` store errors (`:108-109`); `scheduleRetry` → `recordRetry` sits in that try (`:64-75`, `:105`)

Other async nearby (not the same class unless noted):

- `status-monitor.js:67` `setTimeout(poll)` — `poll` is async with internal try/catch (`:39-65`).
- `runExclusive` (`printer-workers.js:176-186`) is awaited by the monitor.
- `retryTimers` callback is sync (`:76-80`).
- `agent-runtime.js:35-38` awaits `tick()`; `tick`'s outer catch swallows (`:183-201`). `store.accept` / `cleanup` already guarded (`:111-119`, `:145-153`).

### Findings

1. **MAJOR — The failing test as pasted cannot run.**
   - `realishTimers()` and `okRenderer()` do not exist in `v2-printer-workers.test.js` (or anywhere under `pos-spooler-printer`).
   - Copy-paste → `ReferenceError`, not `rejections.length === 1`.
   - The file's style is inline renderer/timer objects (`:51-57`, default `timers`). Rewrite the snippet against those.

2. **NOTE — Harness vs `unhandledRejection`.**
   - `pos-spooler-printer/tests/run-tests.js:5-7` `spawnSync`s each test file.
   - A `process.on('unhandledRejection', …)` registered **before** `workers.start()` counts as a handler in Node ≥15, so the child should **not** die; the assertion can fail.
   - If someone omits the listener, the child exits non-zero and that is also a fail. Plan's note is accurate.

3. **NOTE — `owned.delete` on store failure vs double-enqueue.**
   - `collect()` skips `owned` (`printer-workers.js:189-191`). Releasing owned after a **failed** `recordRetry` lets the next `collect()`/`wake()` pick the same `queue_id` while it is still `rendered`/`queued`.
   - Lane loop is serial (`:132`), so this is an immediate second `send`, not two in-flight transports. Safe for the ENOSPC-on-retry case.
   - **Not** a general retry mechanism for jobs that already called `markTransportStarted` (see T4/T5).

**Concrete failure the plan would ship:** Step 1 fails for the wrong reason (`ReferenceError`); teeth-revert step is then meaningless.

---

## Task 4: Cap transient retries; classify pre-write Winspool failures as retryable

**VERDICT: BLOCKED**

1. **BLOCKER — Pre-byte Winspool errors cannot be retried after `markTransportStarted`.**
   - Windows `send()` passes `beforeWrite: markTransportStarted` **before** the helper RPC (`printer-transports.js:261-269`).
   - `platform-helper.js:103-105` awaits that hook before writing stdin.
   - Every `WINSPOOL_OPEN_FAILED` / `START_DOC_FAILED` / `START_PAGE_FAILED` therefore arrives with state `transport_started`.
   - `job-store.js:257-261` **throws `JOB_TRANSPORT_STARTED`** on `recordRetry` from that state. Covered by `v2-job-store.test.js:56-57`.
   - `finishFailure` only swallows `JOB_TERMINAL` (`printer-workers.js:108-109`).

   So T4's `transient_safe` map does this:

   | | today | after T4 as written |
   | --- | --- | --- |
   | OPEN_FAILED etc. | no `failureClass` → `uncertain` → `recordResult` (allowed) → dead_letter | `transient_safe` → `scheduleRetry` → `recordRetry` throws → T3 crash-loop **or**, with T3, `owned.delete` and the job **stuck** in `transport_started` until restart → `recoverTransportStarted` (`job-store.js:113-121`) terminal `uncertain` |

   Transport-layer tests (`WINSPOOL_OPEN_FAILED` → `failureClass === 'transient_safe'`) **pass while the worker still never retries.**

   Need one of: revert `transport_started` → `rendered` for those codes; allow `recordRetry` from `transport_started` for a whitelist; or move `markTransportStarted` to after `StartDocPrinter` (protocol change). The owner ruling "no auto-retry after transport started" is about **bytes**; the store does not distinguish codes. `v2-job-store.test.js:56-57` must be updated, not ignored.

   Cap path **does** work for failures that never marked transport started (render, TCP connect, `PLATFORM_HELPER_UNAVAILABLE`).

2. **NOTE — Cap arithmetic.**
   - `retryDelays`: priority ≤1 → `[1000,2000,5000]` last repeats (`printer-workers.js:47-49`). `attempts = (result.attempts\|\|0)+1` then delay index `attempts-1` (`:65-67`).
   - Cap `attempts >= 60` ⇒ **59** delays: `1+2+57×5 = 288s ≈ 4.8 min`. Fair.
   - Reports `[2000,5000,10000,30000]`, cap 20 ⇒ **19** delays: `2+5+10+16×30 = 497s ≈ 8.3 min`. Plan does not claim 5 min here.

3. **NOTE — `permanent_failure` round-trip and badge — verified, no server change.**
   - `outcomeState` accepts `permanent_failure` (`job-store.js:48-50`). Load allows that terminal state (`:7`, `:77`). Extra fields ride on `result` with no extra schema.
   - `settleUpdate` (`spoolerSync.js:27-31`): `permanent_failure` → `dead_letter` (`failure_class` missing ⇒ `permanent_safe`).
   - `spoolerV2.js:127-128` emits `failed_print_jobs_count` on `queueStateChanged`. Same shape as existing `permanent_safe` branch (`printer-workers.js:97-103`).

4. **NOTE — `WINSPOOL_START_PAGE_FAILED` vs bytes.**
   - C# order (`PosSpoolerPlatform.cs:238-282`): `OpenPrinter` → `StartDocPrinter` → deadline timer → `StartPagePrinter` → **then** `WritePrinter`.
   - `START_PAGE_FAILED` is before any write. `finally` (`:297-298`) `AbortPrinter` if `documentStarted`. Zero device bytes. Retry is *policy*-safe; the store still forbids it (finding 1).
   - `ARTIFACT_HASH_MISMATCH` → `permanent_safe` uses `recordResult`, which **is** allowed from `transport_started`. That half of the map works. JS `verifyArtifactHash` already classifies it `permanent_safe` at `printer-transports.js:50` before the helper call; the catch map covers the C# re-check if the file changes in between.

**Concrete failure the plan would ship:** OPEN_FAILED jobs stop dying cleanly as `uncertain` and instead crash-loop (no T3) or strand until restart as `uncertain` (with T3). The classification tests stay green.

---

## Task 5: Winspool "completed" must mean the local queue drained

**VERDICT: BLOCKED**

1. **BLOCKER — `stuck_deleted` → `transient_safe` hits the same `recordRetry` wall.**
   - `markTransportStarted` already ran. `WINSPOOL_JOB_STUCK` cannot enter `retry_wait`.
   - It either crash-loops (no T3) or parks `transport_started` until restart → `uncertain`.
   - The "retry for ~5 min then dead-letter" outcome does not happen.
   - `'drain_unknown'` → `uncertain` **does** work (`recordResult` is allowed). `'drained'` → `completed` works.

2. **MAJOR — Drain detection is "job left the queue", not "job printed".**
   - Plan: `GetJob` fail `ERROR_INVALID_PARAMETER` (87) ⇒ `drained`; `JOB_STATUS_PRINTING` ⇒ `printing_seen`; budget exhaust ⇒ DELETE.
   - There is **no** branch for `JOB_STATUS_PRINTED` (0x80) / `JOB_STATUS_COMPLETE` (0x1000).
   - With KEEPPRINTEDJOBS (or a driver that leaves printed jobs), `GetJob` keeps succeeding, budget expires, job is deleted. If no poll sampled `PRINTING` (fast job, 400 ms interval), result is `stuck_deleted` → planned retry → **duplicate paper** if finding 1 were fixed.
   - **UNVERIFIABLE from this repo** whether 87 can fire while the job still exists, or whether this machine's XP-80C keeps printed jobs. Step 5(a) on **this** printer is the only evidence; it does not cover KEEPPRINTEDJOBS.
   - Treat `PRINTED|COMPLETE|DELETED` as drained, or record that the physical test was run with KEEPPRINTEDJOBS on.
   - Other `GetJob` errors (access denied, insufficient buffer) are unspecified. Plan them: not-87 during poll should not be treated as drained.

3. **NOTE — Deadline timer vs drain — plan is right to dispose first.**
   - Timer is armed at `PosSpoolerPlatform.cs:245-261` and lives until `finally` `:297`. It `SetJob DELETE`s. If drain runs before dispose, a late tick can delete the job mid-poll and fake 87.
   - After dispose, **nothing in C#** cancels a hung `GetJob`; the backstop is JS `PLATFORM_HELPER_TIMEOUT` (`platform-helper.js:131-136`), which is `uncertain` for `print_raw` and then `beginRetirement`. Hung `GetJob` ⇒ uncertain + helper recycle, not a clean `drain_unknown`. UNVERIFIABLE without a hanging driver.

4. **NOTE — `timeoutMs` math is correct against the helper.**
   - Current: `timeoutMs: deadlineMs + 2000` (`printer-transports.js:269`). Planned: `deadlineMs + drainMs + 2000`.
   - Helper uses the per-request `timeoutMs` (`platform-helper.js:120-137`), not the 10s default.
   - C# drain runs only after successful `EndDoc`; worst wall clock ≈ `deadline_ms + drain_ms`. 2s slack is tight if `GetJob` is slow, but the formula does not under-budget the helper vs C#.

5. **NOTE — "Helper is strictly serial" is overstated for `print_raw`.**
   - `Main` queues `print_raw` on the thread pool (`PosSpoolerPlatform.cs:429-430`).
   - Windows `send()` does **not** use `serializeHelper` (only `probe`/`watch` do, `printer-transports.js:284-303`).
   - Two Windows printers already overlap `print_raw`. Added drain latency is per printer, not a station-wide `drain_ms` queue.
   - The ponytail comment overstates the stall; the ceiling is still worth naming.

6. **NOTE — `device_status: 'drained'` needs no schema change.**
   - `print_queue.device_status` enum (`baseline.sql` printers/queue) is `unknown|ok|offline|paper_low|paper_out|cover_open|jammed|error`.
   - `spoolerSync.js:150` already coerces unknown values to `'unknown'`. Do not add an enum value (that would be a migration).

**Concrete failure the plan would ship:** offline Windows printer still does not retry-then-dead-letter; KEEPPRINTEDJOBS (if present) can classify a successful print as stuck and, once the store wall is fixed, reprint it.

---

## Task 6: Jitter on sync failure backoff

**VERDICT: SAFE TO EXECUTE**

1. **NOTE — Delay is computed BEFORE `consecutiveFailures++` today.**
   - `agent-runtime.js:199-201`. Start at 0 ⇒ bases `[2000,5000,10000,10000,…]`.
   - Test pin `clock.delays.slice(0,5) === [0,2000,5000,10000,10000]` (`v2-sync-runtime.test.js:207`) — the leading `0` is `startupJitterMs` default (`:11`, `:208`).
   - `base + floor(base * 0.25 * random())` with `random → 1` ⇒ `[0,2500,6250,12500,12500]`. Matches **only** if increment-after is kept. Increment-first would be `[0,6250,12500,12500,12500]`.
   - Plan's expected array encodes the right order; say so in Step 2.

2. **NOTE — `createAgentRuntime` consumers.**
   - Production: `server.js:136` (no `random` — default). Tests: `v2-sync-runtime.test.js`, `v2-hostile-runtime.test.js`. Object destructure + default does not break them.
   - Pinned-delay test **must** pass `random: () => 0` as specified.

---

## Task 7: Updater writes the journal only after recovery scripts are current

**VERDICT: SAFE TO EXECUTE**

1. **NOTE — No-journal repair is a health check, not a rollback.**
   - `Repair-SpoolerStartup.ps1:189-250`: if `$journal` is null, the reconcile block is skipped; service is started if needed (`:251-264`).
   - Scripts-then-power-loss-before-journal ⇒ new `Repair-SpoolerStartup.ps1` beside old app, no journal, no disable. Matches the plan.

2. **NOTE — `Install-SpoolerRecoveryScripts` does not need a journal.**
   - `SpoolerLayerState.ps1:238-252`: copy + hash.
   - `$rollbackPrepared = $true` stays **after** `Save-SpoolerJournal` (`Update-Spooler.ps1:401-402`, catch `:510` / `:520`). Meaning remains "journal exists".
   - Failure between scripts and journal: `$rollbackPrepared` false, catch only deletes the rollback dir (`:520-521`); new scripts remain. Benign.

3. **NOTE — Anchors are unique.**
   - Token list at `installerUpdateContract.test.js:550` is `toContain('Install-SpoolerRecoveryScripts')`, not `indexOf`.
   - Proposed strings: one call site `Install-SpoolerRecoveryScripts -SourceRoot $PSScriptRoot` (`Update-Spooler.ps1:403`); `Save-SpoolerJournal 'prepared'` is the call at `:401`, not the function def (`:262`).
   - `npm run test:installer` is exactly 6 files (`package.json:16`).

---

## Task 8: Drain warning tells the truth; recovery is documented

**VERDICT: SAFE TO EXECUTE**

1. **NOTE — One referrer.**
   - `Settings.vue:1395` only. `src/shared/i18n/ar.json:2507` is the only translation. Deleting that row is safe (English key is the identity fallback).

2. **NOTE — Path matches code.**
   - `agent-identity.js:8` `path.join(stateRoot, 'agent.json')`; default root `pos-spooler-printer/server.js:18-19` `%ProgramData%\POS-Spooler\state`. Installer/repair/smoke use the same path.
   - `SPOOLER_STATE_DIR` override exists; runbook can mention it in one clause.
   - Generated column `active_station_key` (`baseline.sql:693-695`) is NULL for `decommissioned`/`revoked` — a new identity can register.
   - Drain already requires empty unresolved (`spoolerSync.js:168-177`) before decommission. The "in-flight stay dead_letter" sentence is the **force-replace** caveat, not drain. Keep it, but don't imply drain leaves jobs.

---

## Task 9: Stale-station visibility

**VERDICT: NEEDS CHANGES**

Schema vs plan (verified):

- `print_queue.printer_id` exists (`baseline.sql:729`)
- `printers.spooler_id` exists (`:712`)
- `spooler_agents.status` ∈ `active|draining|revoked|decommissioned`, `last_sync_at` exists (`:686-689`)

Query this review believes is correct (diff vs the prose: use `UTC_TIMESTAMP()` like `spoolerAgents.js:171`, not `NOW()`; the pool does `SET time_zone = '+00:00'` in `backend/config/db.js:24` so `NOW()` happens to match, but house style is UTC):

```sql
SELECT s.spooler_id, a.last_sync_at, COUNT(q.id) AS queued
  FROM spooler_stations s
  LEFT JOIN spooler_agents a
    ON a.spooler_id = s.spooler_id
   AND a.status IN ('active', 'draining')
  INNER JOIN printers p ON p.spooler_id = s.spooler_id
  INNER JOIN print_queue q
    ON q.printer_id = p.id
   AND q.status IN ('pending','sent','local_accepted','cancel_requested')
 WHERE a.agent_id IS NULL
    OR a.last_sync_at IS NULL
    OR a.last_sync_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)
 GROUP BY s.spooler_id, a.last_sync_at
```

Station D (no agent, pending job) matches `a.agent_id IS NULL`. Station C (stale, no jobs) is excluded by the inner joins. Vestigial `processing` omitted — fine. `print_queue.printer_id` NULL jobs would not appear; enqueue always sets it from the payload.

### Findings

1. **MAJOR — Chip never appears for a connecting admin unless the set *changes*.**
   - Failed-prints pattern is **connect emit + later broadcasts**: `server.js:326-328` `socket.emit('failed_print_jobs_count', count)` on join, plus `spoolerV2.js:128`.
   - Watchdog interval (`server.js:363-370`) currently **only logs**. Signature-diff emit on a 30s timer does not copy the connect path.
   - After a stable stale set, a newly opened Admin UI stays at 0 until the next transition (possibly never).
   - Must `socket.emit('stale_print_stations', …)` on staff connect, same as failed prints.

2. **MAJOR — Console dot will stay "All systems live".**
   - `useSystemStatus.js:12-26` turns the header dot down only for socket/printers/`failedPrintJobsCount`.
   - Plan adds a chip next to the failed-prints **dropdown row** (`AdminHeader.vue:79-86`) and does not touch `systemHealth`.
   - Operators who never open the menu see nothing. Either fold `staleCount > 0` into `systemHealth` (warn), or put a visible chip on the trigger.

3. **NOTE — Flap.**
   - 2 min threshold vs 30s tick: `last_sync_at` is written only on sync (`spoolerSync.js:273`). A dead station crosses 120s once and stays.
   - Signature the **set of spooler_ids** (not a payload with a moving clock) will not flap. Include `last_sync_at` in the signature only if you want extra emits; it is static while stale.
   - Empty set must emit so the chip clears — say `stations: []` explicitly.

4. **NOTE — Frontend chain is real, and incomplete if you only copy three files.**
   - `spoolerV2.js:128` / `server.js:355` → `realtime.js:56-57` `socket.on('failed_print_jobs_count')` → `emitAdminRealtime` (also `CustomEvent(type)`) → `useSystemStatus.js:31,37` `handleFailedPrintJobsCount` → `AdminHeader` via `App.vue:97-98`.
   - Add `stale_print_stations` on that path.
   - POS `useSocket.js:54-57` also listens for failed prints; out of scope unless cashiers should see it.

**Concrete failure the plan would ship:** stale stations exist, Settings tab already knows, header chip stays empty for the life of the admin session.

---

## Missing from the plan (cross-task)

1. **Store exception for "transport started but no bytes".** Tasks 4 and 5 are one design hole. Do not implement Winspool retry/drain-retry until `recordRetry` can run for `WINSPOOL_OPEN_FAILED|START_DOC_FAILED|START_PAGE_FAILED|WINSPOOL_JOB_STUCK` (or those errors never set `transport_started`). Put that in T4 (T5 consumes it).

2. **Task order.** T3 before T4 (crash guard). T4 store path before T5 `stuck_deleted` retry. T1 before T2 architecture reword of `d-unrouted-kitchen-items-silent`.

3. **T2 must keep `router.expandBundlesForKitchen`.** Deleting the local copy without re-export is a hard fail.

4. **T1 tests must create a second category.** Shared `SEED.category` makes mixed-cart tests tautological in `heldOrders.test.js`.

5. **T1 must filter the snapshot-line map, not only `rawData.items` / delta current.** Otherwise `HELD_KITCHEN_ROUTE_EVIDENCE_MISSING` preserves the deadlock. Decision 6 needs a baseline-side filter or a documented 409 (today the plan claims silent drop).

6. **T2 should add one `orderSessionStore` test:** kitchen `dispatchToNodeSpooler` runs when `printMethod === 'browser'` and does not run for table / already-fired holds.

7. **T9 must emit on socket connect** (copy `server.js:326-328`) and decide whether `systemHealth` changes.

8. **T3 test helpers** must be written in-file; do not invent `realishTimers` / `okRenderer`.

9. **No schema/migration/push** — plan respects this. Do not add `drained` to the `device_status` enum.

10. **Ponytail.** Subscription site does not need `filterRoutableKitchenLines` if `payloads.length === 0` is the only 422. The helper is justified for held delta/checkout, which never call `buildKitchenPrintPayloads`.

---

## What this review is not

- Not a disagreement with "unrouted = receipt-only", "no auto-retry after bytes moved", "surface stale stations, never mutate", or "backend is the new default print method".
- Not a request to run vitest. Claims that needed a running process are marked UNVERIFIABLE (KEEPPRINTEDJOBS, hung `GetJob`, 87-while-job-exists).
- Line numbers were confirmed against the working tree on 2026-08-20; named symbols are the load-bearing identity if they drift.
