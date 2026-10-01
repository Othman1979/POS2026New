# Admin Read Reconciliation Efficiency Implementation Plan

> **For agentic workers:** Execute task by task on an ordinary feature branch such as `codex/admin-read-reconciliation`; never create an isolated worktree. Use RED/GREEN and one commit per task. Do not deploy, merge, push, bump a release, alter a migration, or enter the transactional/table refactor.

**Goal:** Reduce avoidable admin-side database reads while preserving prompt, self-healing stock, dashboard, and print-diagnostics state after missed realtime events, disconnections, hidden tabs, and slow requests.

**Architecture:** Keep one authenticated admin Socket.IO bridge owned by the admin shell, and make the three read models event-first with explicit reconnect/visibility recovery plus bounded HTTP reconciliation. After healthy reads, stock alerts and dashboard reconcile every five minutes while visible; Print Queue diagnostics reconcile every thirty seconds only while its tab is visible. Realtime is an acceleration signal, never the source of truth.

**Tech Stack:** Vue 3 Composition API, Vite, Socket.IO 4, Express 5, mysql2 3, MariaDB/InnoDB, Vitest 4.

## Global Constraints

- Keep exactly one admin Socket.IO client per admin page. `src/admin/App.vue` owns its lifetime after authenticated bootstrap; no feature composable may create or disconnect it.
- Keep cookie-only Socket.IO authentication, `transports: ['websocket']`, `withCredentials: true`, unauthorized disconnect behavior, and the current `socket_connect`, `socket_disconnect`, and `socket_auth_error` browser events.
- A clean first connection is not a reconnection. Emit `socket_reconnected` only when a successful connection follows either a disconnect or a non-authentication `connect_error`; that includes recovery from an initial connection failure, because mutations may have happened while the browser was offline.
- Socket events are hints. Every surface retains a bounded HTTP fallback because missed server-to-client events are not replayed by the current configuration.
- Never run a scheduled/event-driven fetch while the relevant page/tab is hidden. Preserve the existing one-time page bootstrap reads, then reconcile once when a surface becomes visible/focused again; visibility and focus signals must debounce together rather than cause duplicate reads.
- Never overlap HTTP refreshes for the same read model. An event received during an in-flight request must produce exactly one follow-up refresh; it must not be dropped and an older response must not overwrite a newer state.
- Under sustained mutation traffic, automatic event/focus/reconnect reads must never start more often than the polling cadence they replace: stock 30 seconds, dashboard 60 seconds, Print Queue 5 seconds. After a quiet period, the first signal remains prompt after its small debounce. Explicit user actions are not delayed by this rate bound.
- Stock and dashboard healthy one-shot fallback cadence: exactly `5 * 60 * 1000` ms after the latest successful authoritative read. A failed stock read retries once after the old 30-second cadence; a failed dashboard read retries once after the old 60-second cadence. Repeated failures remain one-shot at those old cadences, so an outage cannot create a tight loop and a transient Hostinger/MySQL reset cannot leave an empty surface stale for five minutes. Print Queue visible-tab fallback is exactly `30 * 1000` ms; without a newer reconciliation signal, a failed Print Queue read rearms that same 30-second fallback. A newer queue/reconnect/focus signal may accelerate recovery through the existing five-second automatic-read bound.
- Do not refresh the full Print Queue endpoint from `printer_status_changed`; agent health can emit that event every few seconds.
- Emit `print_queue_updated` only after the corresponding durable queue mutation commits. Browser notification remains best-effort and must never roll back or fail a committed queue operation.
- Do not change checkout, prices, stock deduction, orders, table persistence, print claiming/delivery, JoFotara, staff-session validation, WebAuthn, service-charge snapshots, Y archives, schema, migrations, release versions, or deployment files.
- Do not introduce a generic polling framework, event store, broker, Redis, Pinia/Vuex store, new dependency, new environment variable, new database table, or a second Socket.IO connection.
- Run only the focused tests named in each task, `npm run build:admin`, and `npm run architecture:check`; do not use an already-failing unrelated suite as a release gate for this plan.

## Verified Current-State Evidence

1. `src/admin/composables/useStockAlerts.js` currently owns the only admin socket and polls `/api/admin/alerts` every 30 seconds. That is a lifecycle inversion: removing or remounting a stock feature disconnects dashboard, system-status, JoFotara, and print events.
2. `src/admin/realtime.js` does not forward `expenses_changed`, although `useDashboardData.ts` names it as a refresh trigger. The one-minute dashboard poll currently hides this stale-data defect.
3. `backend/routes/system.js` already emits `settings_changed` after the settings write and cache invalidations complete, but the admin bridge does not forward it. `stock_enabled`, `low_stock_threshold`, and `tables_enabled` affect the planned read models.
4. `/api/admin/alerts` performs two settings reads plus a product read when stock is enabled. `settings.setting_key` is already the primary key, so one parameterized `WHERE setting_key IN (?, ?)` read is sufficient; no index or schema work is justified.
5. The dashboard rebuild performs eight database commands when its 30-second cache does not satisfy the request. Its current one-minute browser interval changes the minute cache key and normally rebuilds the payload.
6. `Settings.vue` loads Print Queue health once during every Settings-page bootstrap and then performs four top-level reads every five seconds while the Print Queue tab is visible. The bootstrap read is currently load-bearing for the Hardware tab's station picker and will remain; the repeating five-second diagnostic read is the waste being removed.
7. Cancellation emits `print_queue_updated` after commit, but the bridge drops it. Agent settlement emits only `failed_print_jobs_count`; reprint accepts an `io` argument but never uses it.
8. The Print Queue view cannot become event-only: `online` is calculated from a 30-second `last_sync_at` freshness boundary, and an idle station can stop without any queue mutation. The 30-second visible-tab fallback is therefore load-bearing and bounds an idle-station outage display to roughly 30–60 seconds.
9. A dashboard build can begin before a committed mutation invalidates the cache and finish afterward. Without a generation check, that old build can repopulate the 30-second cache after invalidation; lengthening the browser fallback makes that existing race more visible, so Task 2 closes it in the read-model cache only.
10. `TableMapEditor.vue` listens to both `admin:realtime` and the raw `table_update` event even though the bridge emits both. One server update therefore causes two identical reloads. Task 1 removes only the duplicate raw listener.
11. Not every current `table_update` publisher invalidates the dashboard cache. Relationship changes and healed open-order totals can therefore trigger a dashboard HTTP refresh that returns the still-valid old 30-second cache. Task 2 makes cache invalidation part of the shared post-commit table-publication boundary rather than relying on every caller to remember it.
12. Checkout and table settlement can publish stock/dashboard signals repeatedly, and V2 agents may settle work every 500 ms. Refreshing on every signal would make the optimization more expensive than the polling it removes. Each task therefore preserves the replaced cadence as its maximum sustained automatic-read rate, with one trailing dirty reconciliation.
13. Ordinary queue insertion and claim transitions do not currently have a canonical browser publication boundary. They remain fallback-reconciled in this plan; cancellation, reprint, and terminal agent settlement are the explicit event-first mutations. This avoids pulling every checkout/print producer into an admin diagnostics optimization.
14. The shared table publisher also carries a status-only `markTablePrinted` update. Dashboard SQL does not read table `status`, so that one caller must explicitly opt out of dashboard-cache invalidation while still broadcasting to Table Map; otherwise every check-drop would force an unnecessary dashboard rebuild.

## Scope and Commit Boundaries

These three surfaces belong in one plan because they are read-only admin reconciliation consumers of the same existing authenticated socket. They do not share business transactions, and each stays in its own commit and focused test gate, so a defect in one surface can be reverted without reverting the others. The only server-side mutations introduced are process-local dashboard-cache metadata and best-effort post-commit browser notifications; neither changes money, queue delivery, or stored domain state.

| Task | Independently reviewable outcome | Commit |
|---|---|---|
| 1 | One shell-owned realtime bridge; stock alerts become event-first and five-minute reconciled | `refactor(admin): centralize realtime stock reconciliation` |
| 2 | Dashboard receives every relevant event, rejects stale cache writes, and reconciles only while active/visible | `perf(admin): reduce dashboard reconciliation reads` |
| 3 | Print Queue diagnostics use rate-bounded post-commit signals plus a 30-second fallback | `perf(printing): reduce admin queue diagnostics reads` |

## Expected Idle-Load Delta

These are deterministic cadence bounds, not claims about event traffic during active work:

| Surface left visible for 24h | Current idle cadence | Planned idle cadence | Bounded reduction |
|---|---:|---:|---:|
| Stock alerts | 2,880 requests; up to 8,640 DB commands when enabled | 288 requests; 576 DB commands when enabled | 90% fewer HTTP reads and about 93.3% fewer DB commands |
| Dashboard | 1,440 requests | 288 requests | 80% fewer HTTP reads; realtime mutations still reconcile promptly |
| Print Queue tab | 17,280 requests; 69,120 top-level DB reads | 2,880 requests; 11,520 top-level DB reads, plus one Settings bootstrap | about 83.3% fewer repeating reads |

The implementation must not claim these as production totals: inventory, dashboard, and print mutations intentionally add bounded event-triggered reconciliations. The focused fake-timer tests are the acceptance evidence for idle cadence, and the real-MariaDB alert test is the acceptance evidence for the query-count reduction.

Under continuous signals, the acceptance ceiling is also deterministic: stock remains at or below the old two requests/minute while using one fewer settings command per read; dashboard remains at or below the old one request/minute; Print Queue remains at or below the old twelve requests/minute. Event-first means “prompt after quiet, bounded while busy,” not “one HTTP request per event.”

---

### Task 1: Centralize admin realtime ownership and stock-alert reconciliation

**Files:**
- Modify: `src/admin/realtime.js`
- Modify: `src/admin/App.vue`
- Modify: `src/admin/composables/useStockAlerts.js`
- Modify: `src/admin/pages/TableMapEditor.vue`
- Modify: `backend/routes/admin/dashboard.js`
- Create: `src/admin/__tests__/realtime.spec.js`
- Create: `src/admin/composables/__tests__/useStockAlerts.spec.js`
- Create: `backend/tests/integration/adminAlerts.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces:**
- Produces: `createAdminRealtimeBridge({ ioFactory?, eventTarget? }) -> stop()` in `src/admin/realtime.js`.
- Produces: `createStockAlertsController({ fetchAlerts?, eventTarget?, documentRef?, fallbackMs?, signalMinMs?, debounceMs? })` returning `{ lowStockItems, start, stop, refreshNow }`.
- Produces browser events: existing events plus `expenses_changed`, `settings_changed`, `print_queue_updated`, and recovery-only `socket_reconnected`.
- Task 2 consumes `admin:realtime` events `expenses_changed`, `settings_changed`, and `socket_reconnected`.
- Task 3 consumes `print_queue_updated`, `stale_print_stations`, and `socket_reconnected` through the same `admin:realtime` envelope; no new raw-event listener is added.

- [ ] **Step 1: Add RED bridge tests for one socket, event coverage, and honest reconnects**

Create `src/admin/__tests__/realtime.spec.js`. Use a small fake socket whose `on(event, handler)` records handlers and whose `disconnect` is a spy. Pass `ioFactory` and an `EventTarget` into the bridge; do not install a real global socket.

The tests must assert all of the following:

```js
const stop = createAdminRealtimeBridge({ ioFactory, eventTarget });
expect(ioFactory).toHaveBeenCalledTimes(1);
expect(ioFactory).toHaveBeenCalledWith({ transports: ['websocket'], withCredentials: true });

emitSocket('connect');
expect(browserEvents('socket_connect')).toHaveLength(1);
expect(browserEvents('socket_reconnected')).toHaveLength(0);

emitSocket('disconnect');
emitSocket('connect');
expect(browserEvents('socket_reconnected')).toHaveLength(1);

emitSocket('connect');
expect(browserEvents('socket_reconnected')).toHaveLength(1); // no duplicate success

for (const type of [
  'inventory_changed', 'new_order', 'shifts_changed', 'table_update',
  'expenses_changed', 'settings_changed', 'printer_status_changed',
  'failed_print_jobs_count', 'stale_print_stations',
  'print_queue_updated', 'jofotara_operations_changed'
]) {
  emitSocket(type, { marker: type });
  expect(lastAdminRealtime()).toEqual({ type, payload: { marker: type } });
  expect(lastBrowserEvent(type).detail).toEqual({ marker: type });
}

stop();
stop();
expect(socket.disconnect).toHaveBeenCalledTimes(1);
```

Add a separate bridge instance proving a non-authentication `connect_error` before the first successful connection arms recovery: the later `connect` emits one `socket_reconnected`. Retain a separate test proving an `Unauthorized:` error disconnects and emits `socket_auth_error`; it must not itself dispatch a recovery event. The per-type raw-event assertion is load-bearing compatibility coverage for current Inventory, JoFotara, Sidebar, and system-status consumers; the bridge must publish both the aggregate envelope and raw event exactly once.

Add a source-ownership assertion in the same file:

```js
expect(appSource).toContain('createAdminRealtimeBridge');
expect(stockAlertsSource).not.toContain('createAdminRealtimeBridge');
expect(tableMapSource).not.toContain("addEventListener('table_update'");
const bootstrapIndex = appSource.indexOf('const ok = await session.bootstrap()');
const roleIndex = appSource.indexOf("if (userRole.value !== 'admin'");
const aliveIndex = appSource.indexOf('if (!shellAlive || !ok) return');
const alertsIndex = appSource.indexOf('alerts.start()');
const bridgeIndex = appSource.lastIndexOf('createAdminRealtimeBridge()');
for (const index of [bootstrapIndex, roleIndex, aliveIndex, alertsIndex, bridgeIndex]) {
    expect(index).toBeGreaterThanOrEqual(0);
}
expect(bootstrapIndex).toBeLessThan(aliveIndex);
expect(aliveIndex).toBeLessThan(roleIndex);
expect(roleIndex).toBeLessThan(alertsIndex);
expect(alertsIndex).toBeLessThan(bridgeIndex);
```

Recursively read production `.js`, `.ts`, and `.vue` files below `src/admin`, excluding `src/admin/realtime.js`, every `__tests__` directory, and `*.spec.*`/`*.test.*` files. Count `/createAdminRealtimeBridge\s*\(/g` matches and assert the only match is in `src/admin/App.vue`. Excluding tests is mandatory because this test file itself contains the invocation text. This prevents a second production owner from passing merely because two known composables were checked. The remaining structural assertions pin bootstrap ordering and prevent the existing raw-plus-aggregate Table Map double delivery; behavioral socket semantics remain interface-tested.

Do not attempt to import or mount `App.vue` in this test: the repository's Vitest configuration runs in Node without the Vue SFC plugin. Instead, slice the `setup()`/mounted lifecycle from `appSource` and pin the executable source contract precisely: `let shellAlive = true` exists; the unmount callback assigns `shellAlive = false` before `stopRealtime?.()`; the mounted callback contains the exact `const ok = await session.bootstrap()` followed by `if (!shellAlive || !ok) return`; and that guard precedes the role branch, `alerts.start()`, and `createAdminRealtimeBridge()`. Combined with the already-required index ordering, this is the regression guard for async bootstrap completing after shell unmount without inventing an un-runnable SFC harness or a production abstraction for five lifecycle lines.

- [ ] **Step 2: Add RED stock reconciliation tests**

Create `src/admin/composables/__tests__/useStockAlerts.spec.js` with fake timers, an `EventTarget`, and a document-like `EventTarget` whose `visibilityState` can be changed.

The tests must prove:

```js
controller.start();
await vi.runAllTicks();
expect(fetchAlerts).toHaveBeenCalledTimes(1);     // initial read

await vi.advanceTimersByTimeAsync(299_999);
expect(fetchAlerts).toHaveBeenCalledTimes(1);
await vi.advanceTimersByTimeAsync(1);
expect(fetchAlerts).toHaveBeenCalledTimes(2);     // five-minute fallback
```

Also assert:

- two `inventory_changed` events inside 250 ms result in one refresh;
- `new_order` does not refresh alerts;
- `settings_changed` refreshes when `keys` contains `stock_enabled` or `low_stock_threshold`;
- malformed or missing `settings_changed.payload.keys` refreshes fail-safe—including `[]`, `[null]`, and `[{}]`—while a non-empty string array containing only known unrelated settings does not refresh;
- `socket_reconnected`, visible return, and focus reconcile while visible, and a visibility-plus-focus pair coalesces into one request;
- hidden fallback ticks perform zero HTTP calls;
- `stop()` removes listeners and timers;
- a signal arriving while a request is unresolved runs exactly one follow-up after it settles;
- a stopped controller ignores the result of an unresolved request.
- after the initial read, `inventory_changed` every second for two minutes starts no more than four additional reads (one per `signalMinMs=30000` window), never overlaps, and preserves one trailing dirty reconciliation.
- a rejected initial/refresh read retries exactly once after `signalMinMs=30000`; another rejection rearms one 30-second retry, while a successful retry switches back to the five-minute healthy fallback.

- [ ] **Step 3: Add stock endpoint characterization and query-count coverage**

Create `backend/tests/integration/adminAlerts.test.js` using `seedDatabase()`, Supertest, the seeded admin login, and the real MariaDB pool. Cover these exact cases:

1. Set `stock_enabled=1` and `low_stock_threshold=0`; set one active product to stock `0` and another to stock `1`; assert only the zero-stock product is returned. This pins the valid zero threshold and forbids `parseInt(value, 10) || 3`.
2. Spy on `pool.query` only after seed/setup/login. For one enabled request, filter calls whose SQL contains `FROM settings` and whose bound-values array contains `stock_enabled` or `low_stock_threshold` (the keys are placeholders, not SQL literals). Assert there is exactly one such call and its SQL uses `IN` with two bound parameters.
3. Set `stock_enabled=0`, clear the spy, request the endpoint, and assert an empty list, one settings query, and zero product-stock queries.
4. Delete the threshold row, then reinsert/upsert blank, whitespace-only, and non-numeric `low_stock_threshold` values one case at a time as corruption characterizations; each request must fall back to `3` rather than become zero, pass `NaN` to mysql2, or return 500. (`setting_value` is NOT NULL, so do not write an impossible null fixture.) Then store a valid fractional threshold and inspect the product-query spy to prove that exact number is the bound threshold. The current settings validator accepts blank/whitespace as numeric zero, so this read-side guard is load-bearing even though ordinary non-numeric values are rejected.

Restore the query spy in `finally`/`afterEach`. Do not mock the settings helper or product query: this is the measured MySQL boundary for the only SQL change in the plan.

- [ ] **Step 4: Prove RED**

```powershell
npx vitest run src/admin/__tests__/realtime.spec.js src/admin/composables/__tests__/useStockAlerts.spec.js backend/tests/integration/adminAlerts.test.js --no-file-parallelism
```

Expected: the bridge tests fail because the injectable interface, missing events, ownership move, reconnect distinction, and Table Map cleanup do not exist; the stock tests fail because `createStockAlertsController` does not exist. The endpoint behavior assertions may pass, but its one-query assertion fails against the current two settings reads.

- [ ] **Step 5: Replace the bridge callback interface with one event-forwarding interface**

Replace `src/admin/realtime.js` with an implementation shaped exactly as follows:

```js
export const ADMIN_REALTIME_EVENT = 'admin:realtime';

export function emitAdminRealtime(type, payload = {}, eventTarget = window) {
    eventTarget.dispatchEvent(new CustomEvent(ADMIN_REALTIME_EVENT, {
        detail: { type, payload }
    }));
    eventTarget.dispatchEvent(new CustomEvent(type, { detail: payload }));
}

const FORWARDED_EVENTS = [
    'inventory_changed', 'new_order', 'shifts_changed', 'table_update',
    'expenses_changed', 'settings_changed', 'printer_status_changed',
    'failed_print_jobs_count', 'stale_print_stations',
    'print_queue_updated', 'jofotara_operations_changed'
];

export function createAdminRealtimeBridge({
    ioFactory = window.io,
    eventTarget = window
} = {}) {
    if (!ioFactory) return () => {};
    const socket = ioFactory({ transports: ['websocket'], withCredentials: true });
    let needsRecoveryRefresh = false;
    let stopped = false;

    socket.on('connect', () => {
        eventTarget.dispatchEvent(new CustomEvent('socket_connect'));
        if (needsRecoveryRefresh) {
            needsRecoveryRefresh = false;
            emitAdminRealtime('socket_reconnected', {}, eventTarget);
        }
    });
    socket.on('disconnect', () => {
        needsRecoveryRefresh = true;
        eventTarget.dispatchEvent(new CustomEvent('socket_disconnect'));
    });
    socket.on('connect_error', (error) => {
        if (error?.message?.startsWith('Unauthorized:')) {
            socket.disconnect();
            eventTarget.dispatchEvent(new CustomEvent('socket_auth_error', {
                detail: error.message
            }));
            return;
        }
        needsRecoveryRefresh = true;
    });
    for (const type of FORWARDED_EVENTS) {
        socket.on(type, payload => emitAdminRealtime(type, payload, eventTarget));
    }
    return () => {
        if (stopped) return;
        stopped = true;
        socket.disconnect();
    };
}
```

Do not add singleton globals or automatic startup inside this module. `App.vue` remains the one explicit owner.

- [ ] **Step 6: Move bridge lifetime into the authenticated admin shell**

In `src/admin/App.vue`:

- add `onUnmounted` to the Vue import;
- import `createAdminRealtimeBridge` from `./realtime.js`;
- declare `let stopRealtime = null` in `setup()`;
- declare `let shellAlive = true`, and make unmount first set it false and then call `stopRealtime?.()`;
- immediately after `await session.bootstrap()`, return when `!shellAlive || !ok` before role checks or any controller/socket startup;
- after admin/programmer bootstrap succeeds, call `alerts.start()` first so its event listeners exist, then set `stopRealtime = createAdminRealtimeBridge()`.

Never start the alerts controller or bridge before `session.bootstrap()` and role validation complete, and never start either after unmount. Do not tie bridge shutdown to dashboard deactivation or Settings tab changes.

- [ ] **Step 7: Implement the stock-alert controller without socket ownership**

Replace the implementation in `src/admin/composables/useStockAlerts.js` with the following state machine. It listens only to the aggregate event, so the bridge's compatibility raw events cannot double-trigger it:

```js
import { fetchJson } from '@/shared/http.js';
import { onUnmounted, ref } from 'vue';
import { ADMIN_REALTIME_EVENT } from '../realtime.js';

const STOCK_SETTING_KEYS = new Set(['stock_enabled', 'low_stock_threshold']);

export function createStockAlertsController({
    fetchAlerts = () => fetchJson('api/admin/alerts'),
    eventTarget = window,
    documentRef = document,
    fallbackMs = 5 * 60 * 1000,
    signalMinMs = 30 * 1000,
    debounceMs = 250
} = {}) {
    const lowStockItems = ref([]);
    let started = false;
    let generation = 0;
    let inFlight = null;
    let signalDirty = false;
    let lastReadStartedAt = Number.NEGATIVE_INFINITY;
    let fallbackTimer = null;
    let signalTimer = null;

    const visible = () => documentRef.visibilityState !== 'hidden';
    const clearFallback = () => {
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        fallbackTimer = null;
    };
    const clearSignalTimer = () => {
        if (signalTimer !== null) clearTimeout(signalTimer);
        signalTimer = null;
    };
    const scheduleFallback = (delay = fallbackMs) => {
        clearFallback();
        if (!started || !visible()) return;
        fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            void refreshNow();
        }, delay);
    };

    const scheduleSignalRead = () => {
        if (!started || !visible() || !signalDirty || inFlight || signalTimer !== null) return;
        clearFallback();
        const sinceLastStart = performance.now() - lastReadStartedAt;
        const delay = Math.max(debounceMs, signalMinMs - sinceLastStart, 0);
        signalTimer = setTimeout(() => {
            signalTimer = null;
            if (!started || !visible() || !signalDirty) return;
            signalDirty = false;
            void refreshNow();
        }, delay);
    };

    async function refreshNow() {
        if (!started || !visible()) return false;
        clearFallback();
        if (inFlight) {
            signalDirty = true;
            try { await inFlight; } catch (_) {}
            return false;
        }

        clearSignalTimer();
        signalDirty = false;
        lastReadStartedAt = performance.now();
        const requestGeneration = generation;
        const request = Promise.resolve().then(fetchAlerts);
        inFlight = request;
        let success = false;
        try {
            const data = await request;
            if (started && requestGeneration === generation && data?.success) {
                lowStockItems.value = data.lowStockItems || [];
                success = true;
            }
        } catch (_) {
            // Keep the last good list; the bounded fallback remains armed.
        } finally {
            if (inFlight === request) inFlight = null;
            if (!started) {
                signalDirty = false;
            } else if (signalDirty && visible()) {
                scheduleSignalRead();
            } else {
                scheduleFallback(success ? fallbackMs : signalMinMs);
            }
        }
        return success;
    }

    function requestRefresh() {
        if (!started || !visible()) return;
        clearFallback();
        signalDirty = true;
        if (!inFlight) scheduleSignalRead();
    }

    function handleRealtime(event) {
        const detail = event.detail;
        if (detail?.type === 'inventory_changed' || detail?.type === 'socket_reconnected') {
            requestRefresh();
            return;
        }
        if (detail?.type !== 'settings_changed') return;
        const keys = detail.payload?.keys;
        const validKeys = Array.isArray(keys)
            && keys.length > 0
            && keys.every(key => typeof key === 'string');
        if (!validKeys || keys.some(key => STOCK_SETTING_KEYS.has(key))) {
            requestRefresh();
        }
    }

    const handleFocus = () => requestRefresh();
    const handleVisibility = () => {
        if (!visible()) {
            clearFallback();
            clearSignalTimer();
            return;
        }
        requestRefresh();
    };

    function start() {
        if (started) return Promise.resolve(false);
        started = true;
        generation += 1;
        eventTarget.addEventListener(ADMIN_REALTIME_EVENT, handleRealtime);
        eventTarget.addEventListener('focus', handleFocus);
        documentRef.addEventListener('visibilitychange', handleVisibility);
        return refreshNow();
    }

    function stop() {
        if (!started) return;
        started = false;
        generation += 1;
        signalDirty = false;
        clearFallback();
        clearSignalTimer();
        eventTarget.removeEventListener(ADMIN_REALTIME_EVENT, handleRealtime);
        eventTarget.removeEventListener('focus', handleFocus);
        documentRef.removeEventListener('visibilitychange', handleVisibility);
    }

    return { lowStockItems, start, stop, refreshNow };
}

export function useStockAlerts() {
    const controller = createStockAlertsController();
    onUnmounted(controller.stop);
    return {
        lowStockItems: controller.lowStockItems,
        start: controller.start
    };
}
```

The lifecycle generation is required: a request started before `stop()` may resolve later, but cannot overwrite the state of a stopped or restarted controller. The only request that can follow another request is the one coalesced pending refresh. A successful authoritative read arms the five-minute healthy fallback; a failed read arms one retry at the old 30-second cadence. The returned `{ lowStockItems, start }` composable interface used by `App.vue` stays unchanged.

- [ ] **Step 8: Collapse the alert settings reads**

Import the existing multi-key helper in `backend/routes/admin/dashboard.js`:

```js
const { getSettings } = require('../../config/settingsHelper');
```

Replace the two settings queries with one parameterized helper call:

```js
const settings = await getSettings(pool, [
    'stock_enabled',
    'low_stock_threshold'
]);
const stockEnabled = settings.stock_enabled === '1';
const rawThreshold = settings.low_stock_threshold;
const parsedThreshold = rawThreshold != null
    && String(rawThreshold).trim() !== ''
    ? Number(rawThreshold)
    : Number.NaN;
const threshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 0
    ? parsedThreshold
    : 3;
```

Keep the product query and response contract unchanged. Do not use `|| 3`: zero is a valid configured threshold. Do not cache either setting across requests.
Use `Number`, not `parseInt`, so a valid fractional threshold accepted by the existing settings validator remains consistent with the dashboard read model.

- [ ] **Step 9: Remove Table Map's duplicate raw event listener**

In `src/admin/pages/TableMapEditor.vue`, keep only the aggregate listener:

```js
const handleRealtimeEvent = event => {
    if (event.detail?.type === 'table_update') loadData(true);
};

window.addEventListener('admin:realtime', handleRealtimeEvent);
// matching aggregate removal on unmount
```

Delete the raw `table_update` add/remove calls and the `event.type === 'table_update'` fallback. Do not change the server broadcast, table data loader, room membership, or table editor behavior.

- [ ] **Step 10: Run Task 1 GREEN tests**

```powershell
npx vitest run src/admin/__tests__/realtime.spec.js src/admin/composables/__tests__/useStockAlerts.spec.js backend/tests/integration/adminAlerts.test.js --no-file-parallelism
```

Expected: all selected files pass. Inspect fake-timer teardown; Vitest must not report an open timer or socket handle.

- [ ] **Step 11: Update architecture and commit**

In `docs/architecture.json`:

- add a stable client node `admin-realtime-bridge` pointing to `src/admin/realtime.js`, describing one shell-owned authenticated socket that emits browser reconciliation events;
- add a stable client node `admin-stock-alerts` pointing to `src/admin/composables/useStockAlerts.js`, describing event-first stock alerts with visible five-minute reconciliation;
- change any admin dashboard wording that says the stock feature owns or creates the socket;
- update the Table Map flow to name aggregate delivery once, not raw-plus-aggregate delivery;
- do not edit array entries by numeric index.

```powershell
npm run architecture
npm run architecture:check
git add src/admin/realtime.js src/admin/__tests__/realtime.spec.js src/admin/App.vue src/admin/composables/useStockAlerts.js src/admin/composables/__tests__/useStockAlerts.spec.js src/admin/pages/TableMapEditor.vue backend/routes/admin/dashboard.js backend/tests/integration/adminAlerts.test.js docs/architecture.json docs/architecture.html
git commit -m "refactor(admin): centralize realtime stock reconciliation"
```

---

### Task 2: Make dashboard reconciliation event-first and visibility-aware

**Files:**
- Modify: `src/admin/composables/useDashboardData.ts`
- Modify: `src/admin/composables/__tests__/useDashboardData.spec.js`
- Modify: `backend/config/cache.js`
- Modify: `backend/routes/admin/helpers.js`
- Modify: `backend/routes/admin/dashboard.js`
- Modify: `backend/services/dashboardDataBuilder.js`
- Modify: `backend/services/TableRealtime.js`
- Modify: `backend/modules/tables/markTablePrinted.js`
- Modify: `backend/tests/unit/tableRealtime.test.js`
- Modify: `backend/tests/integration/dashboard.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces:**
- Consumes Task 1 browser events through the existing `admin:realtime` envelope `{ type, payload }`.
- Extends `createDashboardDataController` dependencies with `documentRef?: DashboardVisibilityTarget` and `signalMinMs?: number` while retaining `fetchImpl`, `eventTarget`, `refreshMs`, and `realtimeDelayMs`.
- Extends `activate()` compatibly to `activate({ reconcile?: boolean } = {})`; every other public controller and `useDashboardData()` field remains unchanged.
- Extends the existing process-local dashboard cache with a monotonic invalidation generation; it does not change SQL, response JSON, cache keys, or the 30-second TTL.

- [ ] **Step 1: Add RED dashboard lifecycle, coalescing, and event-filter tests**

In `src/admin/composables/__tests__/useDashboardData.spec.js`, add a document-like `EventTarget` with mutable `visibilityState` and fake timers. Change the default periodic assertion to:

```js
controller.activate();
await vi.advanceTimersByTimeAsync(299_999);
expect(fetchImpl).toHaveBeenCalledTimes(0);
await vi.advanceTimersByTimeAsync(1);
expect(fetchImpl).toHaveBeenCalledTimes(1);
```

Also prove:

- a fallback tick while hidden makes no request;
- returning to visible plus its accompanying focus event schedules one debounced reconciliation, not two;
- `socket_reconnected` schedules one reconciliation;
- `settings_changed` refreshes only for `tables_enabled`, `stock_enabled`, or `low_stock_threshold`;
- malformed/missing settings keys refresh fail-safe, while known unrelated keys do not;
- `expenses_changed` reaches the existing realtime handler and refreshes;
- a mixed storm of relevant events inside 400 ms produces one request;
- events received during an unresolved request produce exactly one follow-up after it settles, without aborting/restarting that request;
- `activate({ reconcile: true })` after KeepAlive deactivation schedules one refresh;
- the real composable activates the controller before starting its initial load, so even an immediately rejected first request retains the one-minute recovery timer;
- deactivation removes admin, focus, and visibility listeners and prevents future timer calls;
- the existing stale-on-error and older-response sequencing tests continue to pass.
- a relevant event at `refreshMs - 100` starts one debounced read, cancels the old fallback deadline, and does not trigger a second read 100 ms later; the next fallback is armed only after that read settles;
- an event after a fallback read has started produces exactly one rate-bounded follow-up after the current read settles.
- after the initial read, relevant events every second for ten minutes start no more than ten additional reads (one per `signalMinMs=60000` window), never overlap, and preserve one trailing dirty reconciliation.
- a rejected initial/refresh read retries exactly once after `signalMinMs=60000`; another rejection rearms one 60-second retry, while a successful retry switches back to the five-minute healthy fallback.

For the settings case, define valid keys as a non-empty array containing only strings. Explicitly test `undefined`, `[]`, `[null]`, and `[{}]` as malformed/fail-safe refreshes; test one non-empty array of unrelated strings as the only no-refresh shape.

- [ ] **Step 2: Prove RED**

```powershell
npx vitest run src/admin/composables/__tests__/useDashboardData.spec.js
```

Expected: the five-minute assertion fails at the current 60-second default; visibility, focus, reconnection, and settings tests fail because their listeners/filtering do not exist.

- [ ] **Step 3: Extend the controller while preserving its proven manual-load sequencing**

In `src/admin/composables/useDashboardData.ts`, keep the current `requestSequence` and `AbortController` rules for explicit/manual `load()` calls. Add:

```ts
const DASHBOARD_REALTIME_TYPES = new Set([
  'new_order',
  'inventory_changed',
  'shifts_changed',
  'table_update',
  'expenses_changed',
  'socket_reconnected',
])

const DASHBOARD_SETTING_KEYS = new Set([
  'tables_enabled',
  'stock_enabled',
  'low_stock_threshold',
])

interface DashboardVisibilityTarget extends EventTarget {
  readonly visibilityState?: DocumentVisibilityState
}

export function createDashboardDataController({
  fetchImpl = window.fetch.bind(window),
  eventTarget = window,
  documentRef = document,
  refreshMs = 5 * 60 * 1000,
  signalMinMs = 60 * 1000,
  realtimeDelayMs = 400,
}: DashboardControllerDependencies = {}) {
```

Add `documentRef?: DashboardVisibilityTarget` and `signalMinMs?: number` to `DashboardControllerDependencies`. Change `refreshTimer` to `ReturnType<typeof setTimeout> | null`. Treat only `visibilityState === 'hidden'` as hidden; an undefined test-double value is visible. Add `requestInFlight`, `refreshAfterLoad`, and `lastReadStartedAt = Number.NEGATIVE_INFINITY` next to the existing timers.

At the start of `load()`, clear both the scheduled reconciliation and the one-shot fallback, then set `refreshAfterLoad = false` before starting the new request: the new request satisfies every signal that arrived before it. Set `lastReadStartedAt = performance.now()` and `requestInFlight = true` for the current `requestSequence`, and track a local `requestSucceeded = false` that becomes true only after an OK/success response survives the current sequence check. In the existing `finally`, and only when `sequence === requestSequence`, clear `requestInFlight`; if `refreshAfterLoad` is set and the controller is active/visible, consume it and call the rate-bounded `requestReconciliation()` once. Otherwise arm a five-minute fallback after success or a one-minute recovery retry after failure. Preserve all existing stale-error, abort, and sequence checks.

Add one scheduler for automatic reads:

```ts
function isVisible() {
  return documentRef.visibilityState !== 'hidden'
}

function clearReconciliationTimer() {
  if (realtimeTimer !== null) clearTimeout(realtimeTimer)
  realtimeTimer = null
}

function clearFallbackTimer() {
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = null
}

function scheduleFallback(delay = refreshMs) {
  clearFallbackTimer()
  if (!active || !isVisible()) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    requestReconciliation({ immediate: true })
  }, delay)
}

function requestReconciliation({ immediate = false } = {}) {
  if (!active || !isVisible()) return
  clearFallbackTimer()
  if (requestInFlight) {
    refreshAfterLoad = true
    return
  }
  if (realtimeTimer !== null) return
  if (immediate) {
    void load({ silent: true })
    return
  }
  const sinceLastStart = performance.now() - lastReadStartedAt
  const delay = Math.max(realtimeDelayMs, signalMinMs - sinceLastStart, 0)
  realtimeTimer = setTimeout(() => {
    realtimeTimer = null
    if (requestInFlight) refreshAfterLoad = true
    else void load({ silent: true })
  }, delay)
}
```

Use this exact event filter:

```ts
function handleRealtime(event: Event) {
  if (!active) return
  const detail = (event as CustomEvent).detail
  if (detail?.type === 'settings_changed') {
    const keys = detail?.payload?.keys
    const validKeys = Array.isArray(keys)
      && keys.length > 0
      && keys.every((key: unknown) => typeof key === 'string')
    if (!validKeys
      || keys.some((key: string) => DASHBOARD_SETTING_KEYS.has(key))) {
      requestReconciliation()
    }
    return
  }
  if (DASHBOARD_REALTIME_TYPES.has(detail?.type)) requestReconciliation()
}

const handleFocus = () => requestReconciliation()
function handleVisibilityChange() {
  if (!active) return
  if (!isVisible()) {
    clearReconciliationTimer()
    clearFallbackTimer()
    refreshAfterLoad = false
    return
  }
  requestReconciliation()
}
```

Implement lifecycle exactly as follows:

```ts
function activate({ reconcile = false } = {}) {
  if (active) {
    if (reconcile) requestReconciliation()
    return
  }
  active = true
  eventTarget.addEventListener('admin:realtime', handleRealtime)
  eventTarget.addEventListener('focus', handleFocus)
  documentRef.addEventListener('visibilitychange', handleVisibilityChange)
  if (reconcile) requestReconciliation()
  else if (!requestInFlight) scheduleFallback()
}
```

In the current-sequence `finally`, call `scheduleFallback(requestSucceeded ? refreshMs : signalMinMs)` when no dirty follow-up is due. In `deactivate()`, set `active=false`, remove all three listeners, clear the signal timer and one-shot fallback, set `refreshAfterLoad=false`, and abort the active request exactly as it does now. Subsequent signals do not reset an already-scheduled signal timer; otherwise a steady event stream could postpone reconciliation forever. The fallback is never a fixed `setInterval`: a successful authoritative load rearms the five-minute healthy fallback, while a failure rearms one recovery attempt at the old one-minute cadence. Therefore an event at 299.9 seconds cannot cause another request at the old five-minute boundary.

In `useDashboardData()`, activate before starting the initial load and replace the later KeepAlive direct load with reconciliation:

```ts
onMounted(() => {
  controller.activate()
  void controller.load()
})

onActivated(() => {
  if (!firstActivation) controller.activate({ reconcile: true })
  firstActivation = false
})
```

Remove the old standalone `onMounted(() => controller.load())`. `onActivated` is also called during the initial KeepAlive mount, but `firstActivation` makes that call record-only; `onMounted` remains the explicit owner of initial activation and load in the correct order. Add a lifecycle assertion that invokes the captured mount hook and proves `activate()` happens before `load()`. This ordering guarantees that even an immediately rejected initial request can arm its one-minute recovery retry.

Do not add another socket, store, endpoint, cache, or timer outside this controller.

- [ ] **Step 4: Add RED tests for zero-threshold consistency and stale cache repopulation**

In `backend/tests/integration/dashboard.test.js`, first add a real-MariaDB assertion that sets `stock_enabled=1`, `low_stock_threshold=0`, runs `UPDATE products SET stock=10 WHERE is_active=1 AND stock IS NOT NULL`, then sets one known active product to stock zero, invalidates the cache, and requests the dashboard. Find `data.attention.find(item => item.type === 'stock')` and assert its `params.count === 1`. This keeps Dashboard consistent with the alert endpoint characterized in Task 1.

In the same test, characterize threshold parsing against the real builder: a missing row, blank, whitespace-only, and non-numeric stored values fall back to `3`; a valid fractional value remains the exact bound argument on the `stock <= ?` query. Do not attempt an impossible null write against the NOT NULL column. Set all controlled active product stocks high and call `invalidateDashboardCache()` immediately before every case request; otherwise the route's real 30-second cache can hide later SQL and make the fractional bind assertion meaningless. Restore any `pool.query` spy in `finally`. This mirrors Task 1 and prevents the two admin surfaces from silently disagreeing on corrupted or manually imported settings.

Then add:

```js
it('rejects a dashboard cache write from a build invalidated in flight', () => {
    const cache = require('../../config/cache');
    const buildGeneration = cache.getDashboardCacheGeneration();

    cache.invalidateDashboardCache();

    expect(cache.setDashboardAnalyticsCache(
        'stale-build',
        { marker: 'stale' },
        Date.now() + 30_000,
        buildGeneration
    )).toBe(false);
    expect(cache.getDashboardAnalyticsCache('stale-build')).toBeNull();
});
```

Update the existing three-argument dashboard-cache setter assertion in this test file to capture `getDashboardCacheGeneration()` and pass it explicitly. Add a separate assertion that omitting the generation, passing a string, or passing a non-finite number returns `false` and writes nothing. A caller that forgets the generation must fail closed rather than silently accepting a stale build.

Finally prove the route wires the generation into a real build rather than merely testing the primitive:

1. After seed/login, save `const originalQuery = pool.query.bind(pool)` and spy on `pool.query`.
2. On the first dashboard-settings SQL (`WHERE setting_key IN ('tables_enabled','stock_enabled','low_stock_threshold')`), return a controllable promise; all other SQL delegates to `originalQuery`.
3. Start `GET /api/admin/dashboard` by attaching `.then(...)` to the Supertest request and wait until the settings gate is reached.
4. Record the current business date and minute key, call `invalidateDashboardCache()`, release the SQL gate, and await the 200 response.
5. Assert `getDashboardAnalyticsCache()` is null for every minute key from request start through completion (normally one key). Restore the query spy in `finally`.

Against the current route, the old build writes after invalidation and this integration assertion is RED. After Step 5, the request may return the snapshot it began building, but the cache remains empty for the next reconciliation to rebuild. Add a narrow source-wiring assertion that reads `backend/routes/admin/dashboard.js`, requires a local `const buildGeneration = getDashboardCacheGeneration()` before `buildDashboardData`, extracts the `setDashboardAnalyticsCache(...)` call, and asserts `buildGeneration` is its fourth argument. This complements the real delayed-build test: a primitive-only test would pass even if the route forgot to supply the now-mandatory generation.

In `backend/tests/unit/tableRealtime.test.js`, mock/spy `invalidateDashboardCache` and prove both `broadcastTableUpdate` and a deduplicated multi-table `broadcastTableUpdates` call invalidate exactly once before their first `table_update` emission. A query failure must still have attempted invalidation, and empty input/no `io` must do neither. Add the explicit status-only option case: it still queries/emits the Table Map payload but does not invalidate. Read `backend/modules/tables/markTablePrinted.js` and assert it is the only production caller that passes that opt-out. This is RED because the shared publisher currently does not own cache invalidation or an explicit status-only contract.

Run:

```powershell
npx vitest run backend/tests/unit/tableRealtime.test.js backend/tests/integration/dashboard.test.js --no-file-parallelism
```

Expected RED: the current builder treats the valid string `'0'` as the fallback `3`; `getDashboardCacheGeneration` does not exist, the current setter always writes, and table publication does not invalidate the dashboard cache.

- [ ] **Step 5: Preserve the valid zero threshold and guard only dashboard cache writes**

In `backend/services/dashboardDataBuilder.js`, replace the truthy fallback with an explicit finite-number fallback before `Promise.all`:

```js
const rawThreshold = settings.low_stock_threshold;
const configuredThreshold = rawThreshold != null
    && String(rawThreshold).trim() !== ''
    ? Number(rawThreshold)
    : Number.NaN;
const lowStockThreshold = Number.isFinite(configuredThreshold)
    && configuredThreshold >= 0
    ? configuredThreshold
    : 3;
```

Pass `lowStockThreshold` to `readLowStock`. Do not change the low-stock SQL or any other dashboard field.

In `backend/config/cache.js`, add process-local state outside `cacheStore`:

```js
let dashboardCacheGeneration = 0;
```

Change only the dashboard exports:

```js
getDashboardCacheGeneration: () => dashboardCacheGeneration,
setDashboardAnalyticsCache: (
    key,
    payload,
    expiresAt,
    generation
) => {
    if (!Number.isSafeInteger(generation)
        || generation !== dashboardCacheGeneration) return false;
    cacheStore.dashboardAnalyticsCache = { key, payload, expiresAt };
    return true;
},
invalidateDashboardCache: () => {
    dashboardCacheGeneration += 1;
    cacheStore.dashboardAnalyticsCache = null;
},
```

Import and re-export `getDashboardCacheGeneration` through `backend/routes/admin/helpers.js`. In `backend/routes/admin/dashboard.js`, destructure it from helpers, capture the generation after the cache miss and immediately before `buildDashboardData`, then pass it to the setter:

```js
const buildGeneration = getDashboardCacheGeneration();
const payload = await buildDashboardData(pool, { now });
setDashboardAnalyticsCache(
    cacheKey,
    payload,
    now.getTime() + DASHBOARD_ANALYTICS_CACHE_TTL_MS,
    buildGeneration
);
```

The already-running request may return the snapshot it legitimately built. It may not poison the shared cache after a mutation invalidated that generation. Do not add a promise registry, query cache, SQL change, route parameter, or cross-process cache.

In `backend/services/TableRealtime.js`, keep the cache module as an object (`const cache = require('../config/cache')`) and extend both publishers with an optional final argument `{ invalidateDashboard = true } = {}`. Call `cache.invalidateDashboardCache()` inside each existing publication `try`, before the table snapshot query and before any `table_update` emission, unless that option is exactly false. This form leaves a clean Vitest spy seam. `broadcastTableUpdates` must invalidate once for a multi-ID batch; its single-ID delegation must forward the option and must not invalidate twice. Leave empty input and missing `io` as no-ops.

In `backend/modules/tables/markTablePrinted.js`, change only the post-commit call to pass `{ invalidateDashboard: false }`. That mutation changes table display status but none of the dashboard's table inputs (`current_order_id`, open unpaid rows/totals, oldest-open time), so Table Map still receives its update while the dashboard keeps its valid cache. Every other existing caller keeps the default, including relationships, saved/cleared/settled/voided tables, splits, and healed order totals. Do not edit a transaction or infer opt-outs from event payloads.

- [ ] **Step 6: Run Task 2 GREEN tests**

```powershell
npx vitest run src/admin/__tests__/realtime.spec.js src/admin/composables/__tests__/useDashboardData.spec.js backend/tests/unit/tableRealtime.test.js backend/tests/integration/dashboard.test.js --no-file-parallelism
```

Expected: all selected tests pass, including event forwarding, resettable fallback timing, one pending automatic follow-up, old-response protection, mandatory-generation stale-write rejection, and invalidate-before-table-publication ordering.

- [ ] **Step 7: Update architecture and commit**

Update stable nodes `rep-dashboard-page`, `core-cache`, and flow `flow-dashboard-today` in `docs/architecture.json`:

- replace “polls”/“fetch loop” wording with event-first refresh plus visible five-minute reconciliation;
- record reconnect, focus, visibility, and settings reconciliation;
- record that invalidation generations reject cache writes from builds invalidated in flight;
- record that the shared table realtime publisher invalidates the dashboard read model before broadcasting its post-commit hint;
- preserve the 06:00 business-day and 30-second server-cache facts.

```powershell
npm run architecture
npm run architecture:check
git add src/admin/composables/useDashboardData.ts src/admin/composables/__tests__/useDashboardData.spec.js backend/config/cache.js backend/routes/admin/helpers.js backend/routes/admin/dashboard.js backend/services/dashboardDataBuilder.js backend/services/TableRealtime.js backend/modules/tables/markTablePrinted.js backend/tests/unit/tableRealtime.test.js backend/tests/integration/dashboard.test.js docs/architecture.json docs/architecture.html
git commit -m "perf(admin): reduce dashboard reconciliation reads"
```

---

### Task 3: Reconcile Print Queue diagnostics without five-second polling

**Files:**
- Create: `src/admin/composables/printQueueRefreshController.js`
- Create: `src/admin/composables/__tests__/printQueueRefreshController.spec.js`
- Modify: `src/admin/pages/Settings.vue`
- Modify: `src/admin/pages/__tests__/spoolerV2Settings.spec.js`
- Modify: `backend/routes/spoolerV2.js`
- Modify: `backend/services/printReprint.js`
- Modify: `backend/tests/integration/spoolerV2Sync.test.js`
- Modify: `backend/tests/integration/printReprint.test.js`
- Modify: `backend/tests/integration/printQueueCancellation.test.js`
- Modify: `backend/tests/unit/spoolerLongPollOrchestration.test.js`
- Create: `backend/tests/unit/printQueueEventOrdering.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces:**
- Consumes Task 1 browser events through the aggregate `admin:realtime` envelope and filters `print_queue_updated`, `stale_print_stations`, and `socket_reconnected`.
- Produces `createPrintQueueRefreshController({ load, eventTarget?, documentRef?, fallbackMs?, signalMinMs?, debounceMs? })` returning `{ start, stop, setActive, refreshNow }`; `refreshNow({ force: true })` is used for the existing one-time Settings bootstrap, later explicit full-page reloads, and post-action reads that must include the just-committed change.
- Produces server event `print_queue_updated` with a small non-authoritative payload after durable cancellation, reprint, or agent settlement.
- The authoritative read remains `GET /api/admin/print-queue/health`.
- Queue enqueue/claim and unchanged station-liveness transitions remain bounded-fallback reconciliation in this plan; they are not falsely described as event-first.

- [ ] **Step 1: Add RED behavioral controller tests**

Create `src/admin/composables/__tests__/printQueueRefreshController.spec.js` using fake timers and controllable promises. Prove:

```js
controller.start();
await controller.setActive(true);
expect(load).toHaveBeenCalledTimes(1);          // immediate tab entry

await vi.advanceTimersByTimeAsync(29_999);
expect(load).toHaveBeenCalledTimes(1);
await vi.advanceTimersByTimeAsync(1);
expect(load).toHaveBeenCalledTimes(2);          // 30-second fallback
```

Also prove:

- inactive and hidden states perform no fallback reads;
- visible return, focus, and `socket_reconnected` refresh through the same coalesced signal path;
- `print_queue_updated` and `stale_print_stations` refresh through one aggregate listener;
- `printer_status_changed` and `failed_print_jobs_count` do not refresh the full endpoint;
- two signals inside 250 ms coalesce;
- a signal during an unresolved load produces exactly one follow-up load;
- an event received before the fallback deadline cancels that timer and produces one load; an event received after the fallback request has begun produces the required single follow-up because that request may have read before the mutation;
- `refreshNow({ force: true })` works while inactive for Settings bootstrap and does not arm fallback polling while inactive;
- if `refreshNow({ force: true })` overlaps an older inactive read, it waits for that captured read, starts a new forced read, and does not resolve its returned promise until the fresh read settles;
- when Print Queue is the initial tab, its synchronous `{ reconcile: false }` activation consumes the already-started bootstrap read; a later user tab entry while any older read is in flight always requests one trailing read because fallback-only enqueue/claim may have changed without an event;
- a queue signal received during inactive bootstrap is remembered and also produces one rate-bounded trailing read;
- a later manual `loadData()` always performs a new forced health read and cannot silently reuse the initial bootstrap snapshot;
- a rejected `load` is absorbed, preserves the view's last data, and rearms the fallback while active;
- deactivation clears signal/fallback state;
- stop removes every listener and prevents rescheduling after an unresolved load settles.

Add a 60-second busy-agent case: after the initial tab read, dispatch `print_queue_updated` every 500 ms. Assert no more than 12 additional automatic reads start in that minute (one per `signalMinMs=5000` window), there is never overlap, and one dirty trailing read is not lost. This pins the optimization against the V2 agent's real 500 ms minimum sync cadence; a 250 ms debounce alone is not acceptable.

- [ ] **Step 2: Strengthen route-event tests before implementation**

Use the existing `global.__mockEmit__` Socket.IO double.

In `backend/tests/integration/spoolerV2Sync.test.js`, extend the existing `AGENT_BADGE` settlement case:

```js
expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated')).toHaveLength(1);
```

Replaying the same terminal result must emit neither `failed_print_jobs_count` nor `print_queue_updated` because no durable state changed.

In `backend/tests/unit/spoolerLongPollOrchestration.test.js`, add an abort-after-first-sync case whose result has `queueStateChanged: true`. Assert `orchestrateAgentSync` returns both `aborted: true` and that result rather than discarding it. This is the input contract the route uses to publish a committed settlement even when only the HTTP response has disappeared.

In `backend/tests/integration/printReprint.test.js`, assert a successful reprint emits exactly one `print_queue_updated` after the row and audit exist; rejected reprints emit none.

In `backend/tests/integration/printQueueCancellation.test.js`, assert successful cancellation emits exactly one `print_queue_updated` carrying the committed outcome, while rejected/nonexistent cases emit none.

In all three files add one best-effort notification case: make `global.__mockEmit__` throw only for `print_queue_updated`, assert the HTTP response still succeeds and the database row/audit remains committed, then restore the mock implementation in `finally`/`afterEach`. A browser broadcast failure must never turn durable print work into an agent or administrator retry.

Create `backend/tests/unit/printQueueEventOrdering.test.js` as a narrow source-order contract. Slice each function/route before searching so imports cannot satisfy it: the `/print-queue/:queueId/cancel` handler in `backend/routes/admin/printQueue.js`, the body of `reprintQueueJob` in `backend/services/printReprint.js`, and the `/sync` handler in `backend/routes/spoolerV2.js`. First assert every exact awaited anchor exists. Then prove both cancellation branches—`await commitAndPublishSpoolerSyncWake(conn)` and `else await conn.commit()`—precede its emit; reprint's awaited `commitAndPublishSpoolerSyncWake(conn)` precedes its emit; and in the scoped sync handler, awaited orchestration precedes `const result = outcome.result`, canonical `print_queue_updated` publication precedes the `outcome.aborted || res.writableEnded` response guard, and the optional failed-count query follows canonical publication. This complements integration assertions with deterministic commit/emit sequencing evidence; eventual row visibility after an HTTP response is not enough.

- [ ] **Step 3: Prove RED**

```powershell
npx vitest run src/admin/composables/__tests__/printQueueRefreshController.spec.js src/admin/pages/__tests__/spoolerV2Settings.spec.js backend/tests/unit/spoolerLongPollOrchestration.test.js backend/tests/unit/printQueueEventOrdering.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printReprint.test.js backend/tests/integration/printQueueCancellation.test.js --no-file-parallelism
```

Expected: the new controller import, busy-signal bound, agent canonical-event/order, and reprint-event assertions fail. The new orchestration result-preservation characterization and existing cancellation post-commit behavior are already GREEN; do not change them merely to manufacture RED.

- [ ] **Step 4: Implement the small Print Queue refresh controller**

Create `src/admin/composables/printQueueRefreshController.js` with this exact interface and state machine:

```js
import { ADMIN_REALTIME_EVENT } from '../realtime.js';

const SIGNAL_EVENTS = new Set([
    'print_queue_updated',
    'stale_print_stations',
    'socket_reconnected'
]);

export function createPrintQueueRefreshController({
    load,
    eventTarget = window,
    documentRef = document,
    fallbackMs = 30 * 1000,
    signalMinMs = 5 * 1000,
    debounceMs = 250
} = {}) {
    if (typeof load !== 'function') throw new TypeError('Print queue refresh requires load().');
    let started = false;
    let active = false;
    let inFlight = null;
    let immediatePending = false;
    let signalDirty = false;
    let lastReadStartedAt = Number.NEGATIVE_INFINITY;
    let fallbackTimer = null;
    let signalTimer = null;

    const visible = () => documentRef.visibilityState !== 'hidden';
    const clearFallback = () => {
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        fallbackTimer = null;
    };
    const clearSignalTimer = () => {
        if (signalTimer !== null) clearTimeout(signalTimer);
        signalTimer = null;
    };
    const scheduleFallback = () => {
        clearFallback();
        if (!started || !active || !visible()) return;
        fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            void refreshNow();
        }, fallbackMs);
    };
    const waitForCurrent = async () => {
        try { await inFlight; } catch (_) {}
        return false;
    };
    const scheduleSignalRead = () => {
        if (!started || !active || !visible() || !signalDirty || inFlight) return;
        clearFallback();
        if (signalTimer !== null) return;
        const sinceLastStart = performance.now() - lastReadStartedAt;
        const delay = Math.max(debounceMs, signalMinMs - sinceLastStart, 0);
        signalTimer = setTimeout(() => {
            signalTimer = null;
            if (!started || !active || !visible() || !signalDirty) return;
            signalDirty = false;
            void refreshNow();
        }, delay);
    };
    async function refreshNow({ force = false } = {}) {
        if (!started || (!force && (!active || !visible()))) return false;
        clearFallback();
        if (inFlight) {
            const current = inFlight;
            if (force) {
                try { await current; } catch (_) {}
                return refreshNow({ force: true });
            }
            immediatePending = true;
            return waitForCurrent();
        }
        clearSignalTimer();
        signalDirty = false;
        immediatePending = false;
        lastReadStartedAt = performance.now();
        const request = Promise.resolve().then(load);
        inFlight = request;
        let success = false;
        try {
            await request;
            success = true;
        } catch (_) {
            // Keep the last good diagnostic snapshot; recovery stays bounded.
        } finally {
            if (inFlight === request) inFlight = null;
            if (started) {
                if (active && visible() && immediatePending) {
                    immediatePending = false;
                    signalDirty = false;
                    void refreshNow();
                } else if (active && visible() && signalDirty) {
                    scheduleSignalRead();
                } else {
                    immediatePending = false;
                    scheduleFallback();
                }
            }
        }
        return success;
    }
    const signal = () => {
        if (!started || !visible()) return;
        signalDirty = true;
        if (!active) return;
        clearFallback();
        if (inFlight) {
            return;
        }
        scheduleSignalRead();
    };
    const handleRealtime = event => {
        if (SIGNAL_EVENTS.has(event.detail?.type)) signal();
    };
    const handleVisibility = () => {
        if (!visible()) {
            clearFallback();
            clearSignalTimer();
            return;
        }
        signal();
    };
    const handleFocus = () => signal();
    const start = () => {
        if (started) return;
        started = true;
        eventTarget.addEventListener(ADMIN_REALTIME_EVENT, handleRealtime);
        eventTarget.addEventListener('focus', handleFocus);
        documentRef.addEventListener('visibilitychange', handleVisibility);
    };
    const setActive = (value, { reconcile = true } = {}) => {
        const next = Boolean(value);
        if (active === next) return Promise.resolve(false);
        active = next;
        clearFallback();
        clearSignalTimer();
        immediatePending = false;
        if (!active) {
            signalDirty = false;
            return Promise.resolve(false);
        }
        if (!reconcile) return Promise.resolve(false);
        if (inFlight) {
            immediatePending = true; // user activation must reconcile after a possibly stale older read
            return waitForCurrent();
        }
        return refreshNow();
    };
    const stop = () => {
        started = false;
        active = false;
        immediatePending = false;
        signalDirty = false;
        clearFallback();
        clearSignalTimer();
        eventTarget.removeEventListener(ADMIN_REALTIME_EVENT, handleRealtime);
        eventTarget.removeEventListener('focus', handleFocus);
        documentRef.removeEventListener('visibilitychange', handleVisibility);
    };
    return { start, stop, setActive, refreshNow };
}
```

The forced-overlap branch is deliberately separate from `immediatePending`: the latter is an active-tab reconciliation hint and is discarded on deactivation, while an explicit forced `loadData()` must remain truthful even when the Print Queue tab is inactive. Capture the current request before awaiting it. The recursive call remains serialized because it rechecks `inFlight`; `stop()` makes it return `false`, and multiple explicit forced calls may serialize multiple reads rather than overlap them. Do not add a generic request queue for this rare explicit-action path.

Do not add `printer_status_changed` or `failed_print_jobs_count` to `SIGNAL_EVENTS`. Printer probes can be emitted every two seconds. Failed-count publication after agent state changes is paired with the new canonical `print_queue_updated`, and reconnect already has `socket_reconnected`; using the count as another full-health trigger would only duplicate reads.

- [ ] **Step 5: Replace Settings.vue polling with the controller**

In `src/admin/pages/Settings.vue`:

- import `createPrintQueueRefreshController` from `../composables/printQueueRefreshController.js`;
- remove `printQueuePollTimer`, `printQueueHealthLoading`, `stopPrintQueuePolling`, `schedulePrintQueuePolling`, and the old visibility handler;
- make `loadPrintQueueHealth()` perform one fetch/update only, with no scheduling;
- create the controller with `load: loadPrintQueueHealth`;
- change `loadData` compatibly to `loadData({ printQueueHealthBootstrap = null } = {})`; at its existing health step, await the supplied promise or run `printQueueRefresh.refreshNow({ force: true })` when no promise was supplied;
- on mount, call `printQueueRefresh.start()`, immediately start `const printQueueHealthBootstrap = printQueueRefresh.refreshNow({ force: true })`, and pass that exact promise to `loadData({ printQueueHealthBootstrap })`; starting health first removes the bootstrap/activation race by construction;
- after `loadData()` is started, call `void printQueueRefresh.setActive(activeTab.value === 'printQueue', { reconcile: false })`; this marks the initially selected tab without racing a duplicate read against bootstrap;
- watch `activeTab` and call only `setActive(tab === 'printQueue')`;
- on unmount, call `printQueueRefresh.stop()`;
- replace action-level `await loadPrintQueueHealth()` calls after reprint, cancel, and station actions with `await printQueueRefresh.refreshNow({ force: true })`, so an overlapping older read cannot satisfy a post-action refresh.

Create `const printQueueRefresh = createPrintQueueRefreshController({ load: loadPrintQueueHealth })` immediately after `loadPrintQueueHealth` and before `loadData`/lifecycle registration. Use this exact lifecycle shape:

```js
watch(activeTab, tab => {
    void printQueueRefresh.setActive(tab === 'printQueue');
});

onMounted(() => {
    printQueueRefresh.start();
    const printQueueHealthBootstrap = printQueueRefresh.refreshNow({ force: true });
    void loadData({ printQueueHealthBootstrap });
    void printQueueRefresh.setActive(
        activeTab.value === 'printQueue',
        { reconcile: false }
    );
});

onUnmounted(() => {
    printQueueRefresh.stop();
    if (toastTimeout) clearTimeout(toastTimeout);
});
```

The initially selected Print Queue tab is satisfied by the same already-started bootstrap health read through the one explicit `{ reconcile: false }` call. A later user-initiated tab entry loads immediately through the watcher. If that entry overlaps an older request, activation marks one trailing read: enqueue/claim are fallback-only and could have changed after the old snapshot with no event. Queue signals received while inactive are remembered for the same reason. A later retry/manual `loadData()` receives no bootstrap promise and therefore forces a fresh health read; when it overlaps an older inactive read, its returned promise spans the required second read rather than resolving on the old snapshot. This lets the Hardware tab discover a newly registered station. Every Settings-page lifetime retains one bootstrap-equivalent health snapshot for Hardware station selection; only an active, visible Print Queue tab receives event/fallback refreshes. Do not introduce a second station endpoint just to eliminate this one load.

Because the controller absorbs health-read failures, a failed diagnostics read leaves the last good/empty health snapshot and does not make unrelated General, Orders, or JoFotara settings unusable. Opening the Print Queue tab or the next fallback retries it.

Replace the source-only polling assertion in `spoolerV2Settings.spec.js` with assertions that Settings imports the controller; removes the old timer/loading/scheduler symbols; starts the forced health promise before calling initial `loadData`; consumes that promise at the former health step; and calls the forced controller refresh after reprint, cancel, and station actions. Add a source/behavior case proving a subsequent argument-free `loadData()` takes the fresh forced-read branch. Do not assert that the whole file lacks the number `5000`; behavioral timing belongs only in the controller tests.

- [ ] **Step 6: Emit canonical post-commit queue-change signals**

In `backend/routes/spoolerV2.js`, immediately after `orchestrateAgentSync` returns, read `const result = outcome.result`. When `result.queueStateChanged` is true, publish the canonical signal before both the response-abort guard and the optional badge-count query:

```js
try {
    req.io?.to('staff').emit('print_queue_updated', {
        source: 'agent_settlement'
    });
} catch (error) {
    logger.warn({ err: error }, 'Failed to publish print queue update.');
}
```

After canonical publication, preserve `if (outcome.aborted || res.writableEnded) return;`: it skips only response writing and the optional badge query. It must not suppress notification of a settlement that already committed before the client disconnected. Keep the existing failed-count query/publication in its own following `try`; it cannot suppress or delay the canonical queue signal. Do not emit for claims that produce no durable change, heartbeats, health-only syncs, duplicate terminal replay, or rollback.

In `backend/services/printReprint.js`, use the existing `io` argument immediately after `commitAndPublishSpoolerSyncWake(conn)`:

```js
try {
    io?.to('staff').emit('print_queue_updated', {
        source: 'reprint',
        queueId: insert.insertId
    });
} catch (_) {
    // Browser notification is best-effort after the durable reprint commit.
}
```

Do not move the existing cancellation emission; it is already after commit. Do not add an event before any commit. The event payloads must contain identifiers/status only—never print payload JSON, errors, printer secrets, or receipt data.

- [ ] **Step 7: Run Task 3 GREEN tests**

```powershell
npx vitest run src/admin/__tests__/realtime.spec.js src/admin/composables/__tests__/printQueueRefreshController.spec.js src/admin/pages/__tests__/spoolerV2Settings.spec.js backend/tests/unit/spoolerLongPollOrchestration.test.js backend/tests/unit/printQueueEventOrdering.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printReprint.test.js backend/tests/integration/printQueueCancellation.test.js --no-file-parallelism
```

Expected: all selected tests pass; no open timer or socket handle remains.

- [ ] **Step 8: Update architecture and commit**

In `docs/architecture.json`:

- update stable node `prn-print-queue-admin-route` to record post-commit `print_queue_updated` signals;
- add a client node `admin-print-queue-reconciliation` pointing to the new controller;
- update stable flow `flow-spooler-v2-admin-health` to describe one bootstrap-equivalent read, immediate later tab/action refresh, rate-bounded settlement signals, fallback-only enqueue/claim repair, and visible 30-second reconciliation;
- explicitly state that `printer_status_changed` does not trigger the four-read endpoint and that the endpoint remains authoritative;
- do not alter spooler protocol version, claiming, settlement, or delivery flows.

```powershell
npm run architecture
npm run architecture:check
git add src/admin/composables/printQueueRefreshController.js src/admin/composables/__tests__/printQueueRefreshController.spec.js src/admin/pages/Settings.vue src/admin/pages/__tests__/spoolerV2Settings.spec.js backend/routes/spoolerV2.js backend/services/printReprint.js backend/tests/unit/spoolerLongPollOrchestration.test.js backend/tests/unit/printQueueEventOrdering.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printReprint.test.js backend/tests/integration/printQueueCancellation.test.js docs/architecture.json docs/architecture.html
git commit -m "perf(printing): reduce admin queue diagnostics reads"
```

---

## Final Focused Verification

- [ ] Run the complete touched test set once, serially:

```powershell
npx vitest run src/admin/__tests__/realtime.spec.js src/admin/composables/__tests__/useStockAlerts.spec.js src/admin/composables/__tests__/useDashboardData.spec.js src/admin/composables/__tests__/printQueueRefreshController.spec.js src/admin/pages/__tests__/spoolerV2Settings.spec.js backend/tests/unit/tableRealtime.test.js backend/tests/unit/spoolerLongPollOrchestration.test.js backend/tests/unit/printQueueEventOrdering.test.js backend/tests/integration/adminAlerts.test.js backend/tests/integration/dashboard.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printReprint.test.js backend/tests/integration/printQueueCancellation.test.js --no-file-parallelism
npm run build:admin
npm run architecture:check
```

- [ ] Confirm the static runtime-operation contract from the tests:

| Surface | Prompt/recovery triggers | Fallback while visible | Must not trigger a full read |
|---|---|---|---|
| Stock alerts | inventory/settings/reconnect/focus/visible; first after quiet is prompt, sustained starts capped at 30s | 5 minutes after success; 30 seconds after failure | `new_order`, unrelated settings |
| Dashboard | domain events/settings/reconnect/focus/visible/reactivation; first after quiet is prompt, sustained starts capped at 60s | 5 minutes after success; 60 seconds after failure | hidden fallback ticks, irrelevant settings |
| Print Queue | one bootstrap-equivalent read; later tab entry/actions immediately; settlement/stale/reconnect/focus/visible rate-bounded to 5 seconds | 30 seconds after latest completed read, only while Print Queue is active | `printer_status_changed`, `failed_print_jobs_count`, hidden/inactive ticks; enqueue/claim use fallback |

- [ ] Confirm Git scope:

```powershell
git status --short
git diff --check HEAD~3..HEAD
git log -3 --oneline
git diff --name-only HEAD~3..HEAD
```

Expected: exactly the three planned implementation commits; no migration, schema, checkout, order/table transaction change, JoFotara, auth, WebAuthn, service-charge, Y-report, installer, deployment, or release file. The only table-related production files allowed are the shared read-model publisher `backend/services/TableRealtime.js` and the one post-commit status-only call in `backend/modules/tables/markTablePrinted.js`, both named in Task 2.

## Adversarial Completion Gate

Before claiming completion, attack the implementation with these cases and record the exact focused test proving each one:

1. Admin bootstrap fails or redirects a non-admin: zero admin sockets and zero authenticated alert requests.
2. Clean first socket connection: no `socket_reconnected` duplicate fetch; initial non-auth connection failure followed by success: exactly one recovery signal.
3. Disconnect/reconnect after success: one recovery signal, not one per composable.
4. Dashboard expense mutation: refresh arrives without waiting five minutes.
5. Stock-setting mutation: stock alerts and dashboard refresh only for relevant keys.
6. Hidden browser for ten minutes after bootstrap: zero fallback HTTP calls; visible return causes one reconciliation.
7. Slow request plus event storm: one in-flight request and exactly one follow-up; no stale overwrite.
8. Print agent heartbeat storm: no repeated full Print Queue reads from `printer_status_changed`.
9. Print result commits: one `print_queue_updated`; duplicate result replay: zero.
10. Print cancellation/reprint rollback or rejection: zero queue-update event.
11. Settings opened outside Print Queue: exactly the existing one bootstrap health read for the Hardware station picker and no repeating health reads.
12. A dashboard build invalidated while in flight cannot restore stale cache state after the invalidation.
13. One server `table_update` causes one Table Map reload through the aggregate event, not raw-plus-aggregate duplicates.
14. Socket event missed entirely: bounded fallback repairs state within five minutes for stock/dashboard and thirty seconds for an open Print Queue tab.
15. Component deactivation/unmount: every timer/listener is removed; the shell socket survives page deactivation and stops only when the shell unmounts.
16. A post-commit print notification throws: the HTTP response and durable queue/audit outcome still succeed, and no retry/duplicate work is created.
17. Admin shell unmounts before async bootstrap resolves: zero late stock controller or socket startup.
18. Dashboard realtime refresh cannot read an old table snapshot from the 30-second cache: shared table publication invalidates first.
19. Dashboard event at 299.9 seconds resets the fallback; no duplicate request occurs at the old five-minute boundary.
20. Print settlement signals every 500 ms for a minute: at most one automatic health-read start per five seconds, one trailing dirty refresh, and zero overlap.
21. Agent settlement commits and then its HTTP request aborts: one canonical queue event is still published, while no response/badge work is attempted.
22. Settings starts health bootstrap before marking an initially selected Print Queue tab, so that mount path uses one read. A later user activation overlapping any older request forces one trailing read to cover fallback-only enqueue/claim; manual `loadData()` also performs a fresh health read.
23. Check-drop/mark-printed status broadcast still updates Table Map but does not invalidate or rebuild the dashboard payload, because none of its SQL inputs changed.
24. Stock events every second for two minutes never exceed the old 30-second request cadence; dashboard events every second for ten minutes never exceed the old 60-second request cadence.
25. A transient stock/dashboard HTTP or database failure retries at the surface's old cadence (30s/60s), never spins, and switches to the five-minute healthy fallback immediately after a successful recovery.

If any test requires weakening a fallback, adding a second socket, emitting before commit, or modifying a business transaction, stop: that contradicts this plan rather than justifying a wider implementation.

## Explicitly Deferred Follow-up Plans

- Adaptive server print watchdog lifecycle and idle/active cadence.
- JoFotara owned recovery runner and disabled-mode stale-submission cadence.
- HTTP/Socket.IO durable-session context coalescing.
- WebAuthn ceremony drain capacity and `auth_sessions` retention/index migration.
- Service-charge snapshot and Y-archive cleanup/concurrency.
- Shared order-item writer and table transactional refactor.

None of these may be pulled into this implementation.
