# Realtime channel audit: verified report (master 37d61150)

I checked every finding against the source at 37d61150. I ran the installed socket.io-client backoff code in node to get the retry timings, and ran `npm view` to check the latest socket.io version. No files were changed and no tests were run. Imunify360's actual request threshold is still unknown.

## 1. Verdict

- **While connected, the channel is healthy.** A connected till sends no extra HTTP requests. Events are small, go only to rooms the server assigns from the login session, and are sent after the database commit. Recovery follows the socket heartbeat.
- **The hammering happens only while the connection is down.** Three client behaviours cause it:
  - socket.io keeps retrying forever, exactly every 5 s, with all tills in step. A 15-till venue sends about 180 connection attempts a minute from one IP, and each refused attempt renews a ban.
  - A bug in socket.io's backoff maths makes about half the retries instant after about 85 minutes of failures. It is still present in 4.8.4.
  - The register sends 4-5 full reads every time the window gets focus while disconnected.
- **Every reconnect reloads the whole register** (5-8 reads per till), because the server does not replay missed events after a short drop.
- **Fix first:** PR 1, a small client change. It cuts a venue's outage traffic from about 180 to about 30 attempts a minute and stops the retries from renewing a ban.
- **Second: a real correctness bug.** When a cashier pays a table, the till's own "table available" broadcast usually arrives before the payment response and wipes the session. The cashier lands on the floor plan with a wrong "Previous sale completed" toast and no change-due dialog.
- **Restart bursts cannot be removed**, because every till must resync after the server loses its memory. The server's database work per reconnect drops from 5 queries to 2.
- **Owner action outside code:** ask Hostinger for the Imunify360 block reason and to whitelist each venue's static IP.

## 2. Current behaviour numbers

Assumptions: cashier on /pos, shift open, tables enabled, empty cart, 15 tills. Numbers are worked out from the code paths, not measured in production.

| Scenario | Now, per till | Now, per venue | After fixes, per till | After fixes, per venue |
|---|---|---|---|---|
| Healthy and connected | 0 HTTP; ping/pong frames every 25 s. Server runs 1 heavy session query per socket per minute | 0 HTTP; about 17 session queries/min (15 tills + 2 admin tabs) | 0 HTTP; about 2 session queries/hour (PR 7) | about 35 queries/hour |
| Server down or WAF 403, first minute | about 13 connection attempts, plus 4-5 HTTP reads per focus event | about 195 attempts, plus focus reads | 5-6 attempts; 0-2 retries per focus, only for reads that failed | about 80 |
| Same, steady state | 12 attempts/min, exactly 5.000 s apart, all tills in step | 180/min (3/s) | 2/min | 30/min |
| Same, after about 85 min of failures (backoff overflow) | about 24/min in bursts (half the delays become 0 ms) | about 360/min | 2/min (overflow never reached) | 30/min |
| Link drop under 2 min, or proxy drops idle sockets, on return | 1 connection + 5 HTTP (5-8); server 3-4 queries | 15 connections + 75-120 HTTP within about 5 s; about 55 queries | If the missed events are replayed: 1 connection, 0 HTTP, 0-1 queries. If not: 1 connection + 4 HTTP (catalog skipped when unchanged) | 15 connections + 0-60 HTTP; up to 15 queries |
| Node restart (about 5-10 s) | 2-3 failed attempts + 0-2 refused handshakes + 1 connect + 5-8 HTTP, so 8-14 requests. Server runs 5 queries per handshake on a cold cache | 120-210 requests in 10-15 s; about 75 handshake queries | Same request count: nothing survives a restart and the catalog token changes. Server runs 2 queries per handshake | Same requests, spread by jitter; about 30 handshake queries |
| Each sale or table save that moves stock (stock tracking on) | 1 catalog read per active register till. Category, search and table-mode reads are not cached, so each one queries the database | N reads per sale; about 2,000/hour at 10 tills and 200 sales/hour | 0 unless an affected product is on screen or in the cart (PR 8, needs design) | — |

## 3. Confirmed findings, ranked

**F1. High, hammering: transport retry loop at a fixed 5 s, all tills in step, never stops; backoff overflow.**
- Evidence:
  - `src/pos/useSocket.js:25`, `src/admin/realtime.js:29` and `src/menu/MenuApp.vue:456-457` pass no retry options, so socket.io-client defaults apply: 1000 ms delay, 5000 ms maximum, 0.5 randomisation, infinite attempts (`node_modules/socket.io-client/build/cjs/manager.js:52-56`).
  - `contrib/backo2.js:29-36` adds jitter and then caps the delay. In simulation the delays were 668, 1779, 2203, then exactly 5000 ms every time.
  - After 1,015 failures the delay maths produces NaN, which becomes 0: about half the retries fire instantly. This happens whatever the maximum is. socket.io-client 4.8.4 (published 2026-09-25) has the same backoff file.
  - `socketRefusalRetry.js` only handles refusals from the server's own login check. A WAF 403 or a dead process stays in this loop.
- Scenario: during an outage or ban, 180 attempts a minute from the venue IP indefinitely, and about 360 after 85 minutes. Customer phones on the venue Wi-Fi add their own loops.
- Fix: one shared options object used by all three `io()` calls: `{transports:['websocket'], reconnectionDelay:1000, reconnectionDelayMax:30000, randomizationFactor:0.5, reconnectionAttempts:500}`, plus `s.io.on('reconnect_failed', () => s.connect())`. socket.io then resets its backoff before the overflow point. The early retries (about 1, 3, 7, 15 s) are unchanged, so short outages recover as fast as today.
- Confidence: high.

**F2. High, hammering: register window focus while disconnected.**
- Evidence: `PosTerminal.vue:1452-1457` waits on settings, a full catalog read, order types, the held summary and the shift check on every focus event while the socket is down. The listener at `:1591` has no throttle. The same reads already run on reconnect (the recovery flag at `useSocket.js:28,51,63`).
- Scenario: every alt-tab during an outage or ban sends 4-5 requests from that till, each renewing the ban.
- Fix: delete the disconnected branch. Keep the existing retries that only re-run reads that failed.
- Trade-off: if WebSocket were blocked while plain HTTP worked, the register would stop refreshing on focus. Your evidence is that WebSocket works.
- Confidence: high.

**F3. High, correctness: the paying till's own broadcast tears down its table session.**
- Evidence:
  - `executeCheckout.js:1929-1930` frees the table, and `:2181` awaits `broadcastTableUpdates` before the route sends the response.
  - `PosTerminal.vue:1128-1132` calls `closeTable()` for an "available, no order" row without checking `checkoutInFlight`.
  - `closeTable` (`tableOrderWorkflow.js:303-315`) clears the draft, which bumps the order session counter (`orderSessionStore.js:545`), and navigates to /tables.
  - When the response arrives, `ownsCheckoutSession` (`orderSessionStore.js:2483`) is false. The payment is not finalised on screen, the success dialog is skipped, and the "Previous sale completed" toast shows (`:2492`).
  - The snapshot path (`tableOrderWorkflow.js:762-776`) has the same teardown. It checks for a pending table action but not for a checkout in flight.
  - No e2e test covers a cashier paying a table.
- Scenario: a cashier pays a table and is bounced to the floor with a wrong toast and no change-due dialog. The receipt still prints.
- Fix: while a checkout is in flight, only merge the row in both paths. After a failed checkout, run the vacate check once against the current row.
- Confidence: high on the code path. How often it fires depends on whether the socket frame beats the response, which the emit-before-response order favours. Write the failing spec first.

**F4. Medium, server load: each handshake and connect costs 3-5 queries.**
- Evidence:
  - `server.js:174-175` looks up the session again after `verifyToken` has already done it (plus a permissions query) on a cold cache (`auth.js:188-210`). The cache already holds the session and credential ids (`auth.js:211-214`), which are the only fields the socket uses (`server.js:321-322`). On a warm cache, `verifyToken` costs 0-1 queries (`auth.js:170-178`) but the extra lookup always runs.
  - `server.js:347-354` runs the failed-print count and the stale-station query for every connecting socket. POS tills never use the stale-station data; only admin does.
  - `spoolerV2.js:284-289` recounts failed jobs and broadcasts the count after every queue change, even when the count did not change.
- Scenario: a restart makes 15 cold handshakes, about 75 queries against a pool of 10, at the same moment as the tills' recovery reads.
- Fix: add a getter for the cached session binding (`requireAuth` already reads the cache at `auth.js:282`) and fall back to a database lookup only when it is missing. Keep the last failed count and stale-station list in memory where they are already produced, and send those on connect, as `printer_status_changed` already does at `:345`. Broadcast the count only when it changes. Result: 0-1 queries on a warm handshake, 2 on a cold one, 0 on connect.
- Confidence: high.

**F5. Medium, hammering: short drops are not recovered, so every blip is a full resync.**
- Evidence: `server.js:113-116` does not enable connection state recovery. `useSocket.js:40-46` fires the reconnect event on every connect after a drop. `PosTerminal.vue:1429-1446`, `TableFloorPlan.vue:1005-1008`, `OrderNotes.vue:1104-1107` and the admin pages (`realtime.js:37-44`) then reload their data.
- Fix:
  - Server: `connectionStateRecovery:{maxDisconnectionDuration:120000, skipMiddlewares:false}`. The default in 4.8.3 is `skipMiddlewares:true` (`socket.io/dist/index.js:106-110`). That skips the login check, so the connection handler crashes at `server.js:320` and a revoked session could reconnect.
  - Server: on a recovered socket, leave the restored `table-access:*` rooms before re-joining, because restored rooms come from the old session, not the current user.
  - Clients: when `s.recovered` is true, skip the reload and don't bump the POS connection counter.
- Limits: nothing survives a restart. Recovery only works if the till received at least one broadcast before the drop (`namespace.js:244-248`). The replay adds a trailing argument to listeners; only `onInventoryChanged` takes a second parameter, and it tolerates a string.
- Confidence: medium. The benefit depends on how often drops are short, which F17 will show.

**F6. Medium, hammering: reconnects ignore the catalog version check.**
- Evidence: the first connect asks the server for its catalog version token and skips the catalog read when it matches (`PosTerminal.vue:1365-1377`, `server.js:370-372`, `cache.js:46`). Every catalog, stock or availability change updates the token (`executeCheckout.js:2175`, `catalog.js:554`). But reconnect recovery (`PosTerminal.vue:1440`) and reactivation (`keepAliveRefreshTracker.js:29-30`, `PosTerminal.vue:1549-1550`) always do a full read, which also marks every cached category stale (`useProducts.js:427-433`).
- Fix: run the same check on those two paths and read only when the token differs or times out. This helps blips, not restarts, because the token changes on restart.
- Confidence: high.

**F7. Medium, security: the customer QR menu socket.**
- Evidence:
  - `server.js:284-311`: the cart is not checked. A non-array is stored and broadcast with an undefined item count.
  - Frames can be up to 1 MB (engine.io default).
  - Each event does a database write, a section lookup and a broadcast to staff. Events run concurrently, so a delete and an insert can land out of order.
  - `:147` logs the token the caller supplied.
  - `regenerate_qr_token` (`tables.js:507-511`) and `delete_table` (`tables.js:456-501`) never disconnect the table's customer sockets (joined at `:280`, never targeted). The admin screen says the old QR stops working immediately (`TableMapEditor.vue:463`).
- Scenario: anyone with the printed QR, or a previous party's phone after the token is regenerated, can loop large writes. Every till in the section is flooded with draft updates and follow-up reads.
- Fix:
  - `maxHttpBufferSize:1e5`.
  - Accept only an array of at most 100 lines.
  - Per socket: one write in flight, latest cart wins, at least 500 ms between writes.
  - Remove the token from the log.
  - After regenerate or delete: ``req.io.in(`table_room_${id}`).disconnectSockets(true)``.
- Confidence: high.

**F8. Medium, server load: per-socket session check every 60 s.**
- Evidence: `server.js:323-334` runs the heavy session query (`staffSessions.js:75-122`) for every staff socket every minute. After a restart all these timers fire together. Every in-app revocation already disconnects sockets directly (auth.js:114,532,684; webauthn.js:142,150; deviceAccess.js:245,302; shifts.js:420; users.js:291,344). The timer's only remaining job is time-based expiry (30 min idle, 12 h absolute), which `webauthnSocketRevocation.test.js:144-157` covers.
- Scenario: about 1,000 heavy queries an hour while nothing changes.
- Fix: one timer per socket, set for the session's expiry time. When it fires, check once, then disconnect or re-arm. About 2 queries per socket per hour.
- Needs your decision: a revocation made outside the app, such as a manual database edit, would take up to the idle deadline (30 min) instead of up to 60 s.
- Confidence: high.

**F9. Medium, hammering: every stock-moving sale makes every till reload the catalog.**
- Evidence: the stock event carries no product ids (`executeCheckout.js:2190`, `saveTableOrder.js:993`, `voidOpenTableOrder.js:264`, `pos/refunds.js:79`, `admin/helpers.js:54`). Each active till then reloads its catalog (`PosTerminal.vue:975-978, 996-998`). Only the default register read is cached on the server (`catalog.js:79`).
- Scenario: the largest realtime-triggered load in a healthy system.
- Fix (needs design and a measurement first): send the affected product ids and reload only when one is on screen or in the cart, or send the new stock values so tills patch rows in place. Recipe ingredients complicate the id list.
- Confidence: medium.

**F10. Medium, correctness: a full table list can overwrite a newer single-table update.**
- Evidence: `tableOrderWorkflow.js:753` replaces the table list unconditionally. The single-table patch handlers (`PosTerminal.vue:1122-1127`, `TableFloorPlan.vue:975-984`) don't know a full read is in flight, and full reads follow every save and reconnect.
- Scenario: till A starts loading tables, till B pays table 7, A applies the "available" update, then A's older list puts table 7 back to occupied.
- Fix: when an update arrives during a load, request one more forced load. The existing single queued follow-up read (`:723-737`) then gives a correct final state.
- Confidence: high on the mechanism, medium on how often it happens.

**F11. Low-medium: forced full table reload after the till's own saves.**
- Evidence: `tableOrderWorkflow.js:936-938, 1413, 1528, 1551`. The code comments say the broadcast already updates the rows.
- Fix: drop these four reloads once each mutation is confirmed to broadcast every changed row. Keep `:1512` (lost response). Needs your OK.
- Confidence: medium.

**F12. Low-medium: held-summary reloads that cannot change the badge.**
- Evidence: `PosTerminal.vue:1068-1080` reloads the summary on every held-order event, but the badge only counts holds with no table and no parent bill (`orders.js:305-312`). The floor plan already filters these (`TableFloorPlan.vue:996-998`). `OrderNotes.vue:1052-1086` fetches the order once per event.
- Fix: return early when the event has a table or a parent bill. First confirm no "updated" event moves a hold between table and register.
- Confidence: high.

**F13. Medium, correctness: the admin dashboard never reconnects after the server disconnects it.**
- Evidence: `realtime.js:46-49` has no equivalent of the POS retry at `useSocket.js:55-58`. A device approval swaps the session and disconnects the old one (`webauthn.js:150`), after which the new cookie is valid.
- Scenario: the admin tab looks live but receives no events until reloaded.
- Fix: retry once, as the POS does.
- Confidence: high.

**F14. Medium, polling: `DeviceAccessSettings.vue:173` refreshes every 5 s** (720 requests an hour per open panel). Fix: send a socket event from the enrolment, approval and revoke routes and refresh on it and on reconnect. Confidence: high.

**F15. Low: refusal retries all land in the same second.** `socketRefusalRetry.js:21` adds only 0-1 s of jitter. Fix: wait between half and the full backoff delay. Confidence: high.

**F16. Low: admin pages reload on every event.** `TableMapEditor.vue:184-188` reloads all tables on every table update, but the editor shows no status or order data. `Ingredients.vue:326` reloads per ingredient change; it already avoids overlapping reads, but reads run back to back during service. Fix: the editor ignores single-table updates; Ingredients waits about 1 s and skips while hidden. Confidence: high.

**F17. Low, observability: the server logs disconnects without the reason** (`server.js:380`). Without it we can't tell proxy recycling, heartbeat timeouts and transport errors apart, which decides how much F5 is worth and whether heartbeat tuning is needed. Fix: add the reason to the existing log line. Confidence: high.

**F18. Low, polling: admin background refresh timers.** `useDashboardData.ts:43,75-82` (5 min), `useStockAlerts.js:11` (5 min), `printQueueRefreshController.js:13` (30 s while the print-queue view is open). Also, `App.vue:181-182` starts alerts before the socket subscribes, so a change in that gap is only caught by the timer. Fix (your decision): swap that order, then drop the timers.

**F19. Low, correctness: the floor plan ignores settings changes** (`TableFloorPlan.vue:1084-1089`). Waiters keep the old "tables enabled" and "table mode" values until a reconnect. Fix: listen for settings changes and refresh the floor when those keys change. Confidence: medium.

**F20. Low, cleanup: dead code.**
- The join-section/leave-section messages (`server.js:358-366, 374-377`; `useSocket.js:100-110`; `TableFloorPlan.vue:854-855, 1094, 1120`). Nothing sends to those rooms.
- The `update_position` branch (`tables.js:503-506`) has no caller.
- `disconnectUserSockets` scans every socket (`users.js:38-44`) instead of using the user's room.
- Tests to update: `socketRoleIsolation.test.js:64-66`, `tableAccessSocket.test.js:42`, `useSocketRoleBoundary.spec.js:44`.

**F21. Low: the socket is stored in a deep Vue ref** (`useSocket.js:10,26`), so socket internals go through Vue's reactivity wrappers. Fix: `shallowRef`. Confidence: medium; the cost is not measured.

## 4. Fix plan (merge in this order)

Each PR runs its focused tests, then one full backend run (`npm run test:isolated:shards`) and the frontend suite before merge.

**PR 1: `codex/socket-reconnect-policy` (quick, safe). F1, F2, F13, F15.**
- Files: `src/shared/socketRefusalRetry.js` (shared options and proportional jitter), `src/pos/useSocket.js`, `src/admin/realtime.js`, `src/menu/MenuApp.vue`, `src/components/PosTerminal.vue`.
- Risk: after an outage longer than about 15 s, realtime returns up to 30 s later. Your call: 15 s instead (60 attempts/min per venue instead of 30).
- Tests (each fails without the fix):
  - Drive the real socket.io-client with the shared options and a failing connection under fake timers: at most 25 attempts in any 10-minute window over 10 simulated hours. Defaults give about 120; without the restart hook it bursts after about 8.5 h.
  - Refusal delays at the 30 s cap with random 0 vs 1 differ by at least 10 s (today 1 s).
  - Disconnected register plus window focus sends 0 settings, catalog, order-type or held reads (today 4-5).
  - In `realtime.spec`, a server disconnect causes exactly one reconnect.

**PR 2: `codex/table-checkout-echo` (quick, safe). F3, F10, F19.**
- Files: `PosTerminal.vue`, `tableOrderWorkflow.js`, `TableFloorPlan.vue`.
- Tests:
  - The till's own "available" update during checkout keeps the cart and table, and the payment response then shows the success dialog, not the "Previous sale completed" toast (fails today).
  - An update that arrives during a full load wins over the older list (fails today).
  - A tables setting change on the floor triggers one reload.

**PR 3: `codex/socket-server-cost` (quick, safe). F4, F17.**
- Files: `server.js`, `backend/middleware/auth.js`, `backend/services/printQueueWatchdog*.js`, and in `backend/routes/spoolerV2.js` only the failed-count broadcast.
- Tests:
  - Session lookups per handshake: 0 warm, 1 cold (today 1 and 2).
  - A connect runs 0 print queries while the client still receives both print events (today 2).
  - Two queue changes that leave the count unchanged send one broadcast.

**PR 4: `codex/customer-socket-hardening` (quick, safe). F7.**
- Files: `server.js`, `backend/routes/pos/tables.js`, new `backend/tests/integration/customerSocket.test.js`.
- Tests:
  - A non-array cart writes nothing and broadcasts nothing.
  - A 150 KB frame disconnects the socket.
  - 10 updates in 50 ms cause at most 2 writes, and the stored draft is the last cart.
  - Regenerating the QR token and deleting the table disconnect a connected customer.
  - The rejection log contains no token.

**PR 5: `codex/reconnect-read-cuts` (safe). F6, F12.**
- Files: `PosTerminal.vue`, `OrderNotes.vue`.
- Tests:
  - A reconnect with a matching catalog token reads no catalog; a mismatch or timeout reads once (today it always reads).
  - A table or split hold event causes no summary read; a register "created" event causes one.

**PR 6: `codex/socket-state-recovery` (safe, not quick; best after PR 3 and a few days of F17 logs). F5.**
- Files: `server.js`, `useSocket.js`, `realtime.js`.
- Tests (integration with a real client):
  - Close the transport, send an event while it is down, reconnect: the client is recovered and receives the event.
  - A session revoked during the gap is refused as Unauthorized.
  - After a server-forced disconnect, the next connect is not recovered.
  - A recovered socket keeps only its current table rooms.
  - Frontend: a recovered connect sends 0 HTTP requests and leaves the connection counter unchanged.

**PR 7: `codex/socket-session-deadline` (needs your decision). F8.**
- Tests: the existing expiry test still disconnects within 3 s without `SOCKET_SESSION_RECHECK_MS`. A healthy socket makes at most 1 session query in 10 simulated minutes (today 10).

**PR 8: `codex/stock-event-scope` (needs your decision and a measurement). F9.** Measure catalog reads per sale before and after.

**PR 9: `codex/admin-realtime-hygiene` (safe; the timer part is your decision). F14, F16, F18.**
- Tests: the device-access panel sends 0 requests over 30 idle seconds (today 6) and refreshes on the new event. The map editor makes no reload on a single-table update and one on a table-list refresh.

**PR 10: `codex/socket-dead-code` (safe cleanup). F20, F21, and F11 if you approve it.**

**Your decisions:** reconnect cap (30 s or 15 s), PR 7, PR 8, F11, the F18 timers, and the Hostinger request (block reason and venue IP whitelist).

## 5. Strengths to preserve

- **Login check contract:** the handshake refuses database failures as a retryable "Service unavailable." and only real auth failures as "Unauthorized:". Clients log out only on the latter (`server.js:125-194`, `useSocket.js:63-72`, `realtime.js:50-58`).
- **Revocation by room:** sockets join `user:`, `session:` and `credential:` rooms, and every revocation disconnects them directly. Covered by `webauthnSocketRevocation.test.js`.
- **Server-assigned table rooms:** `staffTableRooms` (`TableRealtime.js:11-16`) derives rooms from the session, so clients cannot widen their scope. Call-center users never join the staff room.
- **Small payloads:** table updates carry one row and clients patch it in place. Multi-table changes use one batched query. Held-order and availability events carry ids or deltas.
- **Emits after commit:** every emit is after the commit and wrapped so a notification failure cannot fail a committed action.
- **No extra traffic while healthy:** retries run on the heartbeat or focus and do nothing unless a read failed. `socketRefusalRetry` fills a real socket.io gap. The first-connect catalog token check avoids a read. The 250 ms catalog coalescing, the 120/250 ms debounces, and parked pages that only mark themselves dirty all limit bursts.
- **Clean listeners:** listeners are paired on/off on deactivate and unmount, and there is one socket per app.
- **Server defaults are right for this setup:** WebSocket only, no compression, 25/20 s heartbeat, and a single process with the in-memory adapter.
- **Cookie-only auth:** the session cookie is HttpOnly and SameSite=Strict, and origin is checked through `allowSocketRequest`.

## 6. Rejected

**Auditor findings**

- *Recovery with `skipMiddlewares:true`:* crashes at `server.js:320` and lets revoked sessions reconnect (4.8.3 default, `index.js:106-110`).
- *Rate gate for unauthenticated handshakes:* every authenticated HTTP route has the same exposure (one indexed lookup per bogus token). A socket-only gate adds machinery without closing the HTTP path.
- *Retry hint in "Server is starting.":* startup takes seconds, and the refusal retry plus PR 1 jitter cover it.
- *Separate admin room for admin-only events:* the frames are tens of bytes and tills have no listener for them. The one real cost, the stale-station query per till connect, is removed in PR 3.
- *"expenses_changed has no listener":* wrong; `useDashboardData.ts:16` uses it.
- *"Phone-order hold payload is misclassified":* wrong; consumers compare with `== null`, which also matches a missing field.
- *"Split checks cause dozens of reads per split":* overstated. Events sent in the same tick collapse to one read per till through the 120/250 ms debounces; what remains is handled by F12.
- *Not awaiting the table broadcast to speed up responses:* it is one indexed single-row query after commit, not measured, and it does not reliably fix F3.
- *Printer status sent when unchanged:* real but bounded. The print agent sends only changes (`agent-runtime.js:129`), so at most one extra snapshot per agent restart.
- *"JoFotara page gets N events per batch":* the server sends one event per request, and the background runner only publishes when it actually attempted something (`JofotaraOperationsRunner.js:39-45`).
- *"Ingredients page has no coalescing":* partly wrong; it already avoids overlapping reads. Kept as F16.
- *Show another till's edits to an open table (order version in the broadcast):* the server's version check already protects the data. This is a UX feature for you to decide on, not a channel defect.
- *0-1.5 s random delay before recovery reads:* not needed after PR 1 (reconnect times are already spread) and PR 5/6 (most reads removed).
- *Probe the socket on focus after tablet sleep:* adds a frame per wake. The heartbeat detects a dead connection within 45 s, and PR 6 replays what was missed.
- *Reconnect immediately on the browser's `online` event:* a venue internet drop doesn't fire it (the tablet's Wi-Fi stays up), and `connect()` does nothing while socket.io is waiting between retries.

**Research ideas**

- *Polling fallback (`tryAllTransports`):* adds requests exactly when a ban is most likely, cannot get past an IP ban, and WebSocket is proven to work. Revisit only if upgrades are shown to be blocked.
- *Heartbeat tuning (`pingTimeout` 30 s or `pingInterval` 15 s):* no evidence of false timeouts. Decide after the F17 logs.
- *Compression, msgpack, `bufferutil`/`utf-8-validate`, uWebSockets.js, WebTransport:* no measurable gain with frames under 1 KB and about 20 sockets; native add-ons are risky on shared hosting.
- *`socket.conn.request = null`:* negligible saving.
- *Bundle socket.io-client in admin and menu, or `serveClient:false`:* one cached request per page load, not a realtime cost.
- *Engine-level error counter:* WAF rejections never reach Node; F17 is the cheaper evidence.
- *Constant-time QR token comparison:* the token is 128-bit random and compared after a database read behind a proxy, so there is no practical timing leak.
- *Upgrade to 4.8.4:* it exists, but the backoff code is unchanged, so it doesn't help here.
- *Old plan (finite retries, give-up banner, 5-minute self-heal):* the banner and self-heal timer are standing state. PR 1's restart hook keeps the loop bounded without them.
- *Hostinger block reason and IP whitelist:* accepted, but as an action for you, not code.