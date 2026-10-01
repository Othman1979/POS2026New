# Selling frontend performance and stability audit — 2026-09-10

**Implementation follow-up:** the user subsequently authorized corrections. See [implementation results](2026-09-10-pos-frontend-implementation-results.md) for the fixes and verification. The findings and baseline measurements below describe the original audited revision.

Audit only, against `1b1d9c5a20ea9006e6d6355a5c26d7655aa2d72b`, in the shared Local checkout on `codex/pos-frontend-audit`. Application source, dependencies, appearance, database, deployment configuration and selling behavior were not changed. The deliverables are this report, measurements and a local reproduction harness.

The best first improvements are in **held-order board refresh correctness and unnecessary reads**, followed by the Orders detail error. The normal catalog/add-item path did not show a large main-thread stall in these samples. Larger held/history boards did. No percentage improvement, four-core-PC speedup, or whole-machine RAM saving has been established.

## Method and scope

- Production Vite build, Chromium 148, Windows, Node 24.16.0, Intel i7-14700KF. One sample for each English/Arabic × desktop 1440×900/mobile viewport 390×844 × native/4× CPU throttle combination. These are diagnostic samples, not statistically stable medians or physical low-end-device benchmarks.
- Harness: [`scripts/reviews/pos-frontend-audit.cjs`](../../scripts/reviews/pos-frontend-audit.cjs). Compact evidence: [`2026-09-10-pos-frontend-measurements.json`](2026-09-10-pos-frontend-measurements.json). Raw request timestamps, errors and screenshots are under ignored `scratch/pos-frontend-baseline/` and `scratch/pos-frontend-diagnostics/`.
- The harness serves the actual built apps and public assets on an ephemeral loopback server. It imports no application server or DB module. It supplies synthetic authenticated sessions and a local Socket.IO connection; external requests and business writes are blocked. One explicitly supported POST, category-price resolution, is a synthetic read.
- Fixtures: 1,440 simple products in 12 categories, 120 visible products, 80 tables, 30/200 register holds with five lines each, 200 history rows, and 50 admin Orders rows. Held fixtures use the supported fallback presentation without a canonical receipt payload. Real payload size, modifier/bundle complexity and production API timings can differ.
- Real controls exercise category selection, add-to-cart, selecting an item, saving an English/Arabic item note, history selection, search, admin detail opening, date filtering and paging. Cross-page measurements use the application's real router. Cart identifiers, quantities, prices, tax, discounts and the saved note are compared across POS → board → tables → POS. Synthetic 30/150-line cart stress setup directly seeds the browser's actual Pinia store; it is not a simulation of taking 150 customer orders.
- No sale, hold/claim/cancel, table save/transfer/join/split settlement, refund, printer or payment submission was performed. Those mutation implementations were inspected only where necessary to protect proposed frontend boundaries. This is not new backend acceptance evidence.
- `taskMs` is the CDP main-thread `TaskDuration` difference through the action/readiness and a 250 ms settle. It includes browser/automation/render work, not time merely waiting for HTTP. It is not INP or Lighthouse TBT. Readiness waits, route transitions and an idle wait are included in `wallMs`; do not treat that as first paint. The 150 ms latency experiment is separate from the CPU samples.

Accumulated main-thread work in the **4× CPU samples**, rounded milliseconds:

| Flow | EN desktop | AR desktop | EN mobile viewport | AR mobile viewport |
| --- | ---: | ---: | ---: | ---: |
| Cold POS | 580 | 624 | 568 | 634 |
| Category switch | 97 | 97 | 91 | 102 |
| Add item | 70 | 82 | 70 | 73 |
| Select item, edit and save note | 153 | 130 | 230 | 219 |
| Held board, 30 tickets | 211 | 443 | 316 | 286 |
| Switch to 200 history rows | 226 | 688 | 410 | 257 |
| Floor plan, 80 tables | 273 | 268 | 219 | 185 |
| Return to POS | 147 | 185 | 244 | 176 |
| Held board, 200 tickets | 504 | 598 | 195 | 472 |

Native timings and individual long tasks are in the measurements file. Different actions include different controls and readiness work; these are not direct click-latency comparisons. A 4× throttle does not emulate four CPU cores or a 4 GB machine.

## Confirmed findings, ranked

### 1. High — held-order board can replace newer data with older data and miss recovery

**Source:** `src/components/OrderNotes.vue:433–460,924–960`; `src/pos/useSocket.js:19–40`. The shared split list has a similar unguarded assignment in `src/pos/stores/orderSession/tableOrderWorkflow.js:1309–1321`.

`fetchOrders()` has no request generation, cancellation, shared in-flight read, or component-lifetime guard. Its 250 ms event debounce merges a tight burst, but does not protect against events that arrive while a slower read is still running.

**Browser reproduction:** start one delayed held response containing 30 tickets, then let a later request return 31 tickets quickly. The screen shows **31, then regresses to 30** when the old response arrives. These are frontend read results; the test does not delete a server-side ticket. Existing server claim/version checks still matter and must remain authoritative.

**Reconnect reproduction:** change the fixture to 32 tickets while dropping the actual local socket transport, then allow automatic reconnection without another mutation event. The board remains at **30**, because it does not subscribe to the shared `socket_reconnected` recovery signal. Some navigation samples also showed the cached POS performing recovery reads in the background; these did not refresh the visible board. The dedicated settled diagnostic captured no board refresh at all.

**Failed-load reproduction:** return an HTTP 500 JSON error from the held endpoint on a fresh board. After the request finishes, the board shows **“No suspended orders”** in every lane, with **zero cards and no error/Retry alert**. `fetchJson` parses the error response without checking status; `success:false` then does nothing, and `finally` clears loading. This must be distinguishable from a successful empty list. The analogous history response is also silently ignored.

The board subscribes only **after** awaiting settings → order types → both lists. A change during initial load can therefore fall between snapshot and subscription. Additionally, `onUnmounted()` can remove listeners before the asynchronous mount resumes and adds them afterward. The delayed-navigation diagnostic leaves the board during startup and then emits a held-order notification while `/pos` is visible; the disposed board performs history/held reads. This is unnecessary work and retained component state, not merely a theoretical missing cleanup hook.

**Recommendation:** give each board read explicit ownership and cancellation, allow one in-flight read with one trailing refresh when dirtied, subscribe before the initial snapshot, and refresh on reconnect. Invalidate the owner on unmount and prevent the asynchronous startup continuation from registering after disposal. Apply latest-response protection to the shared split-list reader as well. Preserve current data during background refresh, and validate both HTTP status and `success` so failures cannot masquerade as empty lists.

**Required acceptance before implementation is accepted:** old-success/new-success, old-error/new-success, event during read, event during initial snapshot, reconnect with a missed mutation, leave during startup, repeated visits with no extra callbacks, and permission-specific held/history access. Claim tokens, versions, kitchen dispatch, retries and transaction ownership stay untouched.

### 2. High confidence — a reproducible admin Orders detail error

**Source:** `src/admin/pages/Orders.vue:708,718–722,435–437,1134–1161`; `src/utils/receiptLineTotals.js:76–77`.

The current build logs:

```text
[Admin Vue Error] render function TypeError:
Cannot read properties of null (reading 'total')
```

Opening the first order sets `showModal` before its response returns. `selectedOrder` is still explicitly `null`; the visible detail summary evaluates `orderDetailSummary(selectedOrder, ...)`, which reads `order.total`. A default parameter of `{}` does not cover an explicit `null`. The summary renders outside the item-list loading guard. The error was reproduced in all eight normal browser configurations, even with a successful details response, so it does not require an unreliable customer network. Vue's global error handler catches it; a successful later response can render the details afterward.

**Recommendation:** gate the detail summary and order actions on a valid current detail result, make the helper null-safe, and display loading until that result belongs to the requested invoice. Do not present fabricated zero totals as if an invoice had loaded. The detail reader also lacks the request token/abort protection already present on the main Orders list; include close/reopen-A/B stale-response checks when correcting this path.

#### Supplied `startTime` stack — strong match to an upstream Chrome DevTools error

The user subsequently supplied the exact intermittent error from admin Orders:

```text
Uncaught TypeError: Cannot read properties of undefined (reading 'startTime')
    at et.reportAllChanges (<anonymous>:2:19429)
    at <anonymous>:2:13070
    at <anonymous>:2:331
    at d (<anonymous>:2:6141)
    at u (<anonymous>:2:6153)
    at <anonymous>:2:6321
    at <anonymous>:2:2895
    at n.timeout (<anonymous>:2:5652)
```

The console identifies the script as `VM35:2` and also shows `requestIdleCallback`. **All eight supplied frame offsets match** [GoogleChrome/web-vitals issue #792](https://github.com/GoogleChrome/web-vitals/issues/792), filed August 29, 2026 and open when checked on September 10. That report attributes the error to DevTools' injected performance instrumentation during in-app navigation, including in applications that do not import the library. The corresponding Angular report was [closed as an upstream issue](https://github.com/angular/angular/issues/70464#issuecomment-5494771505).

Chrome's [live-metrics injected source](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/live-metrics/web-vitals-injected/web-vitals-injected.ts) independently confirms that DevTools loads its own Web Vitals attribution code with `reportAllChanges: true`. Repository searches found no `reportAllChanges`, `web-vitals`, `requestIdleCallback` or `startTime` in the checked application source, entry HTML, dependency manifests or build configuration, and no `reportAllChanges`/`startTime` in emitted JavaScript. The local audit harness's own long-task observer reads `entry.startTime`; it is not shipped and does not define `reportAllChanges`.

**Assessment:** very high confidence that this exact stack originates in browser performance instrumentation. It provides no evidence of a failed order request, customer network failure, or POS transaction failure. The suspected upstream mechanism is deferred metric processing accessing a missing performance entry; the specific timing/reset path in the affected browser was not independently reproduced. A `VM` label alone would not establish ownership; the exact stack match and independent source checks are the stronger evidence.

The separate `null.total` application defect above remains confirmed. Do not conflate it with `startTime`, suppress global errors, or change selling logic to mask this browser-tooling exception. Direct confirmation on the affected machine would require inspecting the failing `VM35` source and comparing a fresh page session with DevTools closed. No customer browser, extensions, deployed assets or production logs were inspected. Application code remains unchanged.

### 3. Medium — held notifications fan out split-list requests

**Source:** `src/components/TableFloorPlan.vue:790–798,875–890,900–951`; `src/pos/stores/orderSession/tableOrderWorkflow.js:595–632,1309–1321`; `src/components/TableSplits.vue:551–578`.

Ten same-burst held notifications cause **10 GETs to `/api/pos/table_splits`** on the floor plan, despite no ten separate cashier actions. Initial floor-plan entry also makes **two split reads** through the mounted and activated loaders. The main table workspace already shares an in-flight request and queues a trailing forced refresh; the split reader does not.

**Recommendation:** reuse that small in-flight/trailing-refresh pattern inside the existing shared split reader, with response ownership. Avoid fetching full split contents merely to answer a badge if a future measured API reduction is justified, but start with coalescing; no new endpoint or state library is necessary for the first correction. Keep all valid unpaid checks visible, preserve aggregate badge counts, and ensure an event arriving during a read still produces one final fresh result.

### 4. Medium — notes/held entry has an avoidable four-request waterfall

**Source:** `src/components/OrderNotes.vue:433–482,931–938`.

For an account with both permissions, every board mount awaits settings, order types, 200 history rows, then held orders. This happens while the Suspended tab is selected. Every coalesced live update rereads both history and holds. In the fixture, unused history alone is **66,863 uncompressed JSON bytes** per such refresh; customer payloads differ.

With **150 ms per fixture GET**, the four requests start only after their predecessors finish: roughly **600 ms of accumulated server delay** precedes the final held response, before browser work. The snapshot is not inherently four sequential dependencies: independent reads can start together while the renderer waits for the metadata it needs.

**Recommendation:** prioritize the visible list; load history on history intent and refresh it when needed. Start independent settings/type/list reads together, keep permissions separate, and reuse metadata within a well-defined session while refreshing it on relevant settings/order-type events. Do not cache active held orders indefinitely or remove reconnect/activation freshness. Keep History immediately usable with an explicit loading state on its first request.

### 5. Medium, volume-dependent — large notes boards still mount all cards

**Source:** `src/components/OrderNotes.vue:138,149,486–594`; `src/components/OrderNoteCard.vue:423–427`; `backend/routes/pos/orders.js:318–354`.

The held endpoint returns the entire eligible register hold list, and the board maps/parses each cart and mounts all matching cards. At 200 held tickets there are **5,471–5,479 live elements**, compared with **881–889 at 30**. `content-visibility: auto` is already present and helps skip offscreen layout/paint; it does not remove Vue instances, listeners, parsing or all mounted DOM.

At 4× CPU, the 200-held board action used **195–598 ms** of accumulated main-thread work across the four viewport/language samples, with up to a **284 ms single long task**. The 200-row history switch reached **688 ms accumulated work / 259 ms longest task**. These are stress/scale results, not measured typical ticket volumes for a customer.

**Recommendation:** after fixing freshness, measure per-card derivation reuse and an immutable read snapshot. If large boards are common, trial windowing within the existing lanes/mobile list while preserving the exact appearance, scrolling position, keyboard focus, full-board search and complete lane counts. Bulk platform settlement must use the complete authoritative group, never the visible window. Variable card heights and live reordering need explicit tests. Do not hide pending tickets behind a truncation limit as a shortcut.

### 6. Lower priority — catalog rendering repeats cart scans and color calculations

**Source:** `src/components/pos/PosCatalogWorkspace.vue:145–178,279–317`; `src/pos/stores/orderSessionStore.js:2023–2026`; `src/components/pos/PosCartWorkspace.vue:101,109`.

Each product card calls `getQtyInCart` several times; every call filters and reduces the cart. It also rebuilds its style object repeatedly, including luminance calculations for colored cards. The cart template filters by course more than once during rendering.

**Recommendation:** try a computed quantity-by-product map and reuse derived card styling/grouped cart rows. Preserve string/numeric ID equivalence, custom-item exclusion, all quantities across modifier rows, and stock/sold-out/note-product behavior. Do not use `v-once`, an incomplete `v-memo` dependency list, or shallow mutable cart state: stale quantity/availability feedback is unacceptable.

**Priority limit:** normal category switching measured 91–102 ms accumulated work at 4× CPU, and add-item 70–82 ms, with **no observed >50 ms task** in either action. The simple 30/150-line synthetic cart samples also did not establish a large stall. These traces do not justify a cart-state rewrite, asynchronous money calculation, delayed draft persistence, or a worker for ordinary checkout math.

### 7. Lower priority — optional operational UI is part of the initial POS graph

**Source:** `src/router.js:3–5`; `src/components/PosTerminal.vue:512–524`; `src/App.vue:7–9`; `vite.config.mjs`.

Cold POS requests **991,454 decoded JS bytes / 303,394 gzip body bytes**. The POS entry itself is 464.1 kB decoded / 125.8 kB gzip; shared i18n contributes about 73.0 kB gzip. Initial CSS bodies total 63.5 kB gzip. These are local resource bodies, not actual production compression/header/cache policy or RAM consumption.

POS and tables are eager routes, and several optional modals are statically imported. There is room to evaluate lazy loading of occasional settings/subscription/report UI. However, the screen needs a known-good checkout path and the existing chunk-error fallback intentionally avoids auto-reloading an active sale. Moving every modal behind dynamic imports would create a new first-use failure point.

**Recommendation:** use Vue's existing async component support selectively, with a visible first-open loading/error path and tests for a deployment replacing old chunks. Keep the selling surface and recovery controls immediately available. Account for setup/open watchers: swapping a static import alone may still load on mount, while mounting only after `open=true` can miss a non-immediate opening watcher. Preserve focus setup and retry state.

**Dependency conclusion:** no SheetJS, Chart.js, html2pdf, Moveable or Selecto bundle was requested in the measured POS/board/table navigation. The first three already stay outside this operational load path. Replacing one will not improve these measured visits. A new dependency is not needed for the highest-priority findings. If board virtualization becomes justified, evaluate a maintained Vue solution against a small trial and its actual added bundle size before choosing one. [Vue performance guidance](https://vuejs.org/guide/best-practices/performance) supports measuring the emitted graph, selective code splitting and large-list virtualization.

## What already works and should remain intact

- POS and floor plan use KeepAlive. Warm navigation preserves the selling component and cart; it need not reload the entire app. Keep this behavior. [Vue KeepAlive documentation](https://vuejs.org/guide/built-ins/keep-alive.html) distinguishes activation/deactivation from destruction.
- Current category reads have a deadline, abort controller, generation/scope checks, and a visible retry state. Metadata is omitted on normal lightweight category changes. The previously fixed category-stall protections should not be weakened for caching.
- The table workspace already coalesces requests and queues a trailing forced refresh. Single-table socket payloads update one table locally without refetching everything.
- The main admin Orders list already has 50-row pagination, debounce and abort/generation handling. Its detail reader has different protection and is the location of the confirmed console error.
- Item notes are edited in temporary modal state and saved locally. The browser tests preserve the note, cart identity, quantities and money fields across navigation. No special worker/library is justified for this path by the measured samples.
- The cart's deep persistence watcher is part of draft recovery (`orderSessionStore.js:208–223`; `orderSessionPersistence.js:227`). Do not debounce away the last draft edit, skip persistence before a handoff, or move financial state to a speculative cache.
- Source review found a 30-second elapsed-time timer on the kept-alive floor plan that stops only on unmount (`TableFloorPlan.vue:916–918,975–994`). Pausing this presentation-only timer on deactivation and updating immediately on activation is a small candidate; its actual hidden CPU cost was not isolated. Do not pause socket recovery, leases or required correctness timers with it.

## Memory and session longevity

The normal cycle run warms additional component/DOM state: native used JS heap rises from about 11.3–11.4 MiB to roughly 15.0–15.2 MiB after three cycles. This alone is not a leak diagnosis.

A dedicated 12-cycle POS ↔ notes run with forced GC after every cycle showed a first-cycle step up, then a plateau: about **14.6–14.9 MiB** used JS heap, with DOM-node and listener counts stable after the first cycle. This does not show monotonically accumulating normal-navigation instances. These counters include detached/cached DOM and are not the number of visible elements or the Chromium process's RAM. The separate delayed-unmount listener defect still needs fixing; ordinary settled visits do not exercise it.

## Recommended implementation order — three batches

1. **Read correctness:** held board lifetime/latest-response/reconnect/error behavior, split-list coalescing, and the admin detail null/loading/ownership correction. Reproduce failures first, then preserve them as focused regressions. Verify that late completions cannot target a different ticket or invoice.
2. **Remove unnecessary operational reads:** visible-tab loading, parallel independent metadata/list reads, and appropriate metadata reuse with final-state freshness. Verify slow connections, settings changes, event bursts and permission boundaries.
3. **Measured rendering/loading cuts:** profile derived card work, trial large-board windowing only if justified, and selectively defer optional modal code. Compare the same fixture/device cases before and after; keep only changes with a measured benefit and complete selling-flow acceptance.

Any implementation must retain canonical held claims/versions, kitchen delta/uncertain-print behavior, table revision/conflict protection, checkout idempotency, authoritative totals/tax/discounts, and draft/session recovery. Test normal and delayed/error paths for English/Arabic and desktop/mobile. A future production-code change should also run the relevant existing isolated money/table/held tests and the Release gate when integration is authorized. This audit is not authorization to deploy.

## Verification and reproduction

- `npm run build:admin` — passed against the audited source.
- Nine focused frontend files — **72 tests passed**: category recovery/requests, table workspace requests, workflow transitions, split board/modal, split payment, and Orders request/overlay handling. These tests passing does not cover the newly reproduced mount/render/race defects.
- Eight complete normal browser cases plus a separate delayed-response/reconnect/lifetime and 12-cycle diagnostic. Expected audit errors are recorded, not suppressed: the injected HTTP 500 responses and the confirmed admin detail render error. Unknown fixture requests and unapproved business writes fail the harness.
- No production-source modification or deployment was made.

Run the two CPU rates sequentially, with other benchmarks/tests stopped:

```powershell
npm run build:admin
$env:AUDIT_LABEL='baseline'
$env:AUDIT_STRESS='1'
$env:AUDIT_CPU='1'
node scripts/reviews/pos-frontend-audit.cjs
$env:AUDIT_CPU='4'
node scripts/reviews/pos-frontend-audit.cjs
```

For the longer diagnostic, use `AUDIT_LABEL=diagnostics`, `AUDIT_CPU=1`, `AUDIT_SMOKE=1`, `AUDIT_DIAGNOSTICS=1`, and `AUDIT_CYCLES=12`; clear optional variables when switching modes. Outputs are local audit artifacts and contain synthetic data only.
