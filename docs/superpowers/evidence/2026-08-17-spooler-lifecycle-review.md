# Spooler Lifecycle Review — permanent offline, duplicate prints, and latency classes

Date: 2026-08-17, rev 2 (deep-dive experiments added). Scope: full print-spooler lifecycle, evidence-first.
No production code changed. Three experiment harnesses were written, run, and removed; full code fragments and
raw results are recorded below.

---

## 1. Reconstructed lifecycle and failure timeline

### Normal lifecycle

1. NSSM (installed by `deployment/windows/Install-Spooler.ps1:76-96`) runs `pos-spooler-printer/server.js`
   as the "POS Print Spooler" service. SCM recovery is `restart/5000/restart/15000/0` with a 24 h reset
   (`Install-Spooler.ps1:186`), so a crashed process is back within ~5 s. Legacy machines may instead have a
   node-windows daemon (`pos-spooler-printer/install-service.js`); the installer migrates ownership only
   when re-run (`Install-Spooler.ps1:146,219`).
2. The client connects with `auth.type='spooler'` + pre-shared key + `SPOOLER_ID`
   ([server.js:69-88](../../pos-spooler-printer/server.js)), transports `['websocket','polling']`,
   `tryAllTransports`, reconnect backoff 3–30 s, infinite attempts.
3. Server `io.use()` validates the key and id ([server.js:131-153](../../../server.js)), then the connection
   handler calls `spoolerRegistry.register()` ([server.js:314](../../../server.js)). The registry is a plain
   in-memory `Map` keyed by `spooler_id` ([spoolerRegistry.js:5-23](../../backend/services/spoolerRegistry.js)).
   The entry is removed **only** when the owning socket's `disconnect` event fires
   ([server.js:370-371](../../../server.js)). No other eviction exists — no staleness sweep, no probe.
4. Delivery: on connect `processPendingQueue` claims up to **50** jobs ([server.js:285-300](../../../server.js));
   a 30 s periodic dispatcher retries ([server.js:593-603](../../../server.js)); enqueue-time dispatch goes
   through `dispatchClaimedPrintJobs` ([printDispatch.js:16-36](../../backend/services/printDispatch.js)).
   Claims are DB leases: `claimed_by` + `locked_until` (120 s), settle requires the same claimant
   ([printQueue.js:69-237](../../backend/services/printQueue.js)). HTTP polling uses claimant
   `poll:<spooler_id>` on the same lease table ([routes/spooler.js:67-105](../../backend/routes/spooler.js)),
   so Socket.IO and polling cannot race the *same leased* job — the lease arbitrates.
5. On the client every delivered job runs `processIncomingPrintJob` → dedupe check → serial `localPrintQueue`
   → Puppeteer render → canvas raster → ESC/POS transport ([pos-spooler-printer/server.js:326-938](../../pos-spooler-printer/server.js)).
6. When the socket drops, HTTP poll fallback starts after a 1 s grace and self-stops on reconnect
   ([server.js:141-145](../../pos-spooler-printer/server.js)).

### Failure timeline of the reported incident (permanent offline)

| T | Event |
|---|---|
| T0 | Spooler printing normally over WebSocket; registry holds `{spoolerId, socketId: A}`. |
| T1 | Connection A dies **without a close frame reaching the server** — sleep/wake, NAT rebind, Wi-Fi blip, proxy idle-close, or a restart whose FIN is lost behind the LiteSpeed proxy. Server still owns socket A for up to `pingInterval+pingTimeout = 25+20 = 45 s` (defaults, verified on the running server). |
| T2 | Same installation reconnects (client backoff is 3 s, or NSSM restart at +5 s). Handshake succeeds → client logs **"Connected to cloud server"**. |
| T3 | `register()` sees entry A with a different socketId → `spooler_rejected: spooler_id_already_connected` + `socket.disconnect(true)` ([server.js:314-324](../../../server.js)). |
| T4 | Client kill switch runs: `pollFallbackScheduler.disable(); socket.io.opts.reconnection = false; socket.disconnect()` ([pos-spooler-printer/server.js:159-164](../../pos-spooler-printer/server.js)) → logs **"io client disconnect"**; the disconnect handler's `startPollFallback()` is a no-op on a disabled scheduler ([poll-fallback.js:51-54,92-99](../../pos-spooler-printer/poll-fallback.js)). |
| T5 | ≤45 s later the server frees the id — nothing on the client ever tries again. Offline until manual service restart. |

The submitted diagnosis is **confirmed and extended**: the collision window is real and bounded (~45 s worst
case), the client treats it as fatal — and **this is not an "older spooler" defect**. The kill switch shipped
2026-07-14 (`b2d3da1b`) and is byte-identical in the current tracked 1.2.8 source; every fielded 1.2.x has it.
The 1.2.6 "connection recovery hardening" (`875c7ad4`) touched only poll-fallback logging/timeouts.

---

## 2. Confirmed findings (each with exact evidence)

**C1 — Client-side permanent kill switch (root cause of the permanence).**
[pos-spooler-printer/server.js:159-164](../../pos-spooler-printer/server.js). One `spooler_rejected` event
disables reconnection *and* HTTP polling for the process lifetime. In all fielded versions and current source.

**C2 — Server-side stale-registry window (root cause of the false rejection).**
Registry entries are removed only by the socket's `disconnect` event; `register()` has no liveness check
([spoolerRegistry.js:13-22](../../backend/services/spoolerRegistry.js)). Engine.IO defaults (25 s ping,
20 s timeout — asserted on the live `io` instance in experiment 1) mean a silently-dead socket blocks its id
for up to ~45 s. `lastSeenMs` is maintained (`touch` at [server.js:338,365](../../../server.js)) but never
consulted for eviction.

**C3 — Even without C1 the rejected client would not auto-recover.**
The server ends the rejected socket with `disconnect(true)` → client reason `io server disconnect`, which
Socket.IO clients never auto-reconnect from. Recovery requires an explicit `connect()` retry; the fielded
client has none (proven in experiment 1c: a retrying client recovers in one backoff step).

**C4 — Poll fallback permanently disables on any HTTP 401/403.**
[poll-fallback.js:80](../../pos-spooler-printer/poll-fallback.js), pinned by its own unit test
(`disables permanently for authentication failures but retries 429`). Designed for key misconfig — but this
venue has documented Imunify360 IP-ban history producing transient 403s. One WAF 403 while the socket is down
kills HTTP delivery until service restart.

**C5 — `Unauthorized:` connect errors are a fleet-wide permanent kill.**
[pos-spooler-printer/server.js:148-157](../../pos-spooler-printer/server.js). If the POS server ever boots
with `SPOOLER_KEY` unset/changed (env regression on redeploy), every station permanently disables both
transports and needs a manual service restart even after the server is fixed. (`Server is starting.` and boot
503s are safe — they retry.)

**C6 — Duplicate physical prints: no in-flight dedupe on the client, lease-expiry redelivery on the server.** *(new, proven end-to-end)*
The client dedupes only **completed** jobs (`hasCompletedJob`, [pos-spooler-printer/server.js:239-241,343-347](../../pos-spooler-printer/server.js));
nothing tracks jobs currently queued in `localPrintQueue` or mid-render. Concurrent `print_job` events
interleave — each handler's `for … await` loop runs independently ([server.js:552-558](../../pos-spooler-printer/server.js)).
The server redelivers any `sent` row whose 120 s lease expired without an ack
([printQueue.js:89](../../backend/services/printQueue.js), dispatcher [server.js:593-603](../../../server.js)).
So: reconnect after an outage claims **50 jobs in one batch** ([server.js:290](../../../server.js)); on slow
hardware the serial pipeline needs >120 s to drain (see §3 performance); every job still queued locally when
its lease expires is redelivered and **printed twice** — both copies ack success. Proven by experiments 2a+3.
Kitchen nuance: a duplicate arriving after `seenStore.begin()` (transport started) instead hits the
`isUncertain` guard and **falsely dead-letters a job that printed fine** ([server.js:348-353](../../pos-spooler-printer/server.js));
a duplicate arriving during the render window (~0.5–2.5 s/job) double-prints like any other type.
This violates "never duplicate a physical print" with no network failure at all — just a backlog.

**C7 — Unbounded PowerShell accumulation when the Windows print system wedges.** *(new)*
`updateLocalPrintersStatus` spawns `powershell Get-Printer …` on a bare 60 s `setInterval` with **no timeout
and no reentrancy guard** ([pos-spooler-printer/server.js:946-981](../../pos-spooler-printer/server.js)).
A wedged Windows Print Spooler service or WMI (a common field failure — and precisely when this machine is
already in trouble) makes `Get-Printer` hang indefinitely: one new PowerShell process per minute, forever.
Measured baseline cost ~400 ms per spawn on fast hardware (§3d) — roughly 1–2 s of CPU every minute on a
Celeron even when healthy.

**Verified sound (checked for defects, found none):**
- Lease/claimant queue design: transactional `FOR UPDATE` claim, claimant-bound settle and `markPrintJobsSent`;
  well-indexed for the claim shape (`idx_print_queue_claim`, `idx_print_queue_owner_claim`,
  [baseline.sql:721-727](../../deployment/database/baseline.sql)) — claim cost is not a scaling hazard.
- Post-completion dedupe: `DurableSeenStore` (atomic rename, 14-day TTL) plus `completedJobsCache` — proven
  in experiment 2b (zero printer connections on redelivery after completion) **and across a process restart**
  (a rerun with the previous run's state dir deduped every job).
- Poll-path ack failure leaves the row `sent`; lease expiry redelivers; the seen store acks success without
  reprinting — no silent abandonment.
- Server restart: in-memory registry empties; `Server is starting.` and 503s are retried by all clients.
- Clean process crash: OS sends FIN/RST → registry freed immediately → NSSM restart connects into a free slot.
- Transport byte integrity: hypothesis that `client.write(buf, cb)` + `destroy()`
  ([server.js:913](../../pos-spooler-printer/server.js)) truncates data at a slow printer was **refuted** on
  loopback (experiment 2c: full 512 KB delivered even to a paused consumer, destroy and end identical).
  Untested over real networks; no field evidence demands it.

---

## 3. Experiments performed and results

### Experiment 1 — duplicate-id lifecycle (vitest, real server + seeded `posapp_test`; 3/3 passed, 3.7 s)
a. Asserted `io.engine.opts.pingInterval === 25000`, `pingTimeout === 20000` on the live server (bounds C2).
b. Occupant connected → second socket same id got `spooler_rejected {spooler_id_already_connected}` +
   `io server disconnect` while the occupant stayed live; after the occupant left, a fresh connection with the
   same id was accepted with no rejection → the collision is transient.
c. A client running the fielded handler verbatim never reconnected after the slot freed (asserted 1.2 s later);
   a client that retries connected on its next attempt.

### Experiment 2 — real client pipeline against a fake ESC/POS printer (standalone Node, spooler cwd)
The actual `processIncomingPrintJob` export, real Puppeteer Headless Shell render, real canvas raster, TCP
transport to a local fake printer; env redirected to an unroutable server and a scratch state dir.

a. **In-flight duplicate**: the same `queue_id` delivered twice concurrently produced **2 printer connections
   with identical 62,177-byte payloads — two physical prints — and both acked success.**
b. **Post-completion redelivery**: 0 printer connections, success ack (dedupe works once completed). A second
   process run against the surviving state dir deduped everything → restart-safe.
c. **destroy() truncation probe**: separate harness, 64–512 KB writes to a paused-then-resumed consumer;
   `destroy` vs `end` both delivered 100 % of bytes on loopback → hypothesis refuted.
d. **Performance** (fast dev machine, warm pipeline; Celeron ≈3–6× slower single-thread):

| metric | measured |
|---|---|
| warmup (browser launch + first render) | ~660 ms |
| small report, total | ~90 ms (render 86, raster 9) |
| 200-row Arabic report, total | ~470 ms (render ~360, raster ~180), raster payload 1.3 MB |
| max event-loop block during large report (sync canvas/raster) | **~110 ms** |
| `DurableSeenStore.mark()` at 10 k records (1 MB JSON, sync write ×2 per kitchen job) | 5.3 ms/op |
| `powershell Get-Printer` spawn (every 60 s) | ~400 ms |

Extrapolated to a Celeron: ~1.5–3 s per large document, 0.3–0.7 s event-loop stalls (not heartbeat-fatal —
20 s is needed — but additive), and a 50-job post-outage batch drains in **2.5–5 minutes** — comfortably past
the 120 s lease, which is what arms C6. The serial `localPrintQueue` also means one giant Z/Y report delays
every kitchen ticket behind it by seconds on weak hardware.

### Experiment 3 — server-side lease-expiry redelivery (vitest, real server; 1/1 passed, 2.3 s)
A connected spooler received a kitchen job (status `sent`, attempts 1) and never acked. After forcing
`locked_until` into the past and invoking exactly what the 30 s dispatcher runs (`dispatchClaimedPrintJobs`),
**the same socket received the same `queue_id` a second time** (attempts 2, still no failure anywhere).
Together with experiment 2a this proves the full duplicate-print chain.

---

## 4. Remaining unknowns and evidence needed

| # | Unknown | Evidence that would settle it |
|---|---|---|
| U1 | What kills the connection at the venue (sleep/wake vs Wi-Fi/NAT vs Imunify360 vs LiteSpeed idle-close vs crash) | `C:\ProgramData\POS-Spooler\logs\spooler-service.err.log` timestamps around "Disconnected from cloud server" vs Windows System event log vs Hostinger/Imunify logs. The Imunify360 block-reason request is still outstanding. |
| U2 | Whether the affected machine runs exactly one spooler process | `sc query` for NSSM "POS Print Spooler" plus any legacy node-windows daemon; `tasklist` for two node.exe; interleaved duplicate log lines. Two processes share one `SPOOLER_ID`: the loser self-kills (C1) and separate in-memory seen-store copies open a narrow duplicate window after crash-before-ack. |
| U3 | Whether Hostinger runs a single lsnode worker | Panel/`ps`. Multiple workers would mean per-worker registries and `io` instances (self-status lies; jobs wait for the right worker's dispatcher). No current evidence; the design assumes one process. |
| U4 | Real stale-window length behind the LiteSpeed proxy | One field test: hard-cut network on a station; timestamp the server's `Print spooler disconnected.` log line. |
| U5 | Whether `destroy()`-after-write can truncate over a real congested network path (refuted on loopback) | Only worth chasing if partial-print reports surface; switching to `end()` in Task 6 costs one line regardless. |
| U6 | Field frequency of duplicate prints (C6) | Grep `print_queue` for rows with `attempts > 1` that ended `acknowledged` and whose `duration_ms` spans overlap; ask staff about double tickets after outages. |

---

## 5. Implementation plan (ordered by risk × payoff)

Tasks 1–2 are server-only and protect the **already-fielded** fleet; Tasks 3–6 fix the client for the next
spooler release. Smallest coherent set; no queue/lease rewrite.

**Task 1 — Server: stop arming the duplicate chain for the fleet.**
Drop the reconnect claim batch from 50 to 10 ([server.js:290](../../../server.js)) so one batch's local drain
(≤ ~30 s even on a Celeron) always finishes inside the 120 s lease; the 30 s dispatcher drains the remainder
in waves. This alone makes fleet double-prints from backlogs practically unreachable before any spooler update
ships.

**Task 2 — Server: probe-before-reject registration (fixes the permanent-offline fleet-wide).**
Make the spooler connection branch async. On collision: send `query_printers_status []` to the occupant —
every fielded client answers it ([pos-spooler-printer/server.js:1003-1049](../../pos-spooler-printer/server.js))
and the answer already `touch()`es the registry ([server.js:364-365](../../../server.js)). Wait ~2.5 s;
occupant answered (or its socket is healthy per `io.sockets.sockets`) → reject as today; silent → force-
disconnect occupant, unregister, **accept** the newcomer, which therefore never sees a rejection in the stale
case. Single-flight the probe per spoolerId. Invariants: genuine duplicates still rejected; a restarted
station recovers in ≤ ~3 s; zero steady-state overhead.

**Task 3 — Client: in-flight dedupe (closes C6 completely).**
Keep a `Set` of in-flight `queue_id:idempotency_key` from `processIncomingPrintJob` entry until the response
is sent; a duplicate delivery while in flight responds nothing (or success-after-wait) and never enqueues.
This covers socket redelivery, poll/socket interleave, and the kitchen false-dead-letter nuance in one place.

**Task 4 — Client: rejection and auth errors become bounded retries, not suicide.**
`spooler_rejected`: don't disable polling, don't clear `reconnection`; schedule `socket.connect()` retries
5 s → 60 s cap forever, one log line each. `Unauthorized:` connect errors: slow retry (5 min) instead of
permanent disable so a fixed server heals the fleet without visits. Poll fallback: 403 backs off to the 30 s
cap instead of disabling ([poll-fallback.js:80](../../pos-spooler-printer/poll-fallback.js)); 401 retries at
5 min. Also drain an in-flight poll response before `stop()` aborts it on socket-reconnect, so jobs already
claimed under `poll:<id>` aren't stranded for a lease cycle.

**Task 5 — Server: shorten the stale window and surface config mismatch.**
`pingInterval: 10000, pingTimeout: 8000` on the `io` constructor ([server.js:120-122](../../../server.js)) —
silent-death detection drops from ~45 s to ~18 s for every client class. On spooler connect, if
`SELECT COUNT(*) FROM printers WHERE spooler_id = ?` is zero, log a loud warning and include a
`printers_bound` count in `/api/spooler/self-status` — today an `.env`/DB `spooler_id` mismatch connects
"successfully" and silently never prints while the UI shows the printers as spooler-disconnected.

**Task 6 — Client: hygiene for wedged-Windows and transport close.**
`updateLocalPrintersStatus`: reentrancy guard + `exec` timeout (~20 s) + `taskkill` on timeout; skip the tick
if the previous one is still running. Replace transport `client.destroy()` after the final write with
`client.end()` (graceful FIN; refuted-on-loopback risk closed for free).

**Task 7 — Ops (no code).** Field checklist for U1/U2 on the affected machine; re-run the standalone
installer where a legacy node-windows service exists; record the Imunify360 block reason; run the U6 forensic
query for historical duplicates.

Explicitly rejected: registry TTL sweepers (the probe is deterministic), takeover/instance tokens (need a
fleet update to help, Task 2 doesn't), immediate lease-break on disconnect (reintroduces double prints the
lease intentionally prevents), parallel local print pipeline (ordering and printer contention risks dwarf the
gain — smaller claim batches solve the real problem), and any queue-layer rewrite.

---

## 6. Tests that prove the guarantees

Integration tests reuse the `spoolerSocketTransport.test.js` harness; one vitest process at a time.

1. **No duplicate print under redelivery (Tasks 1+3)**: deliver a job, force lease expiry, dispatch again
   (experiment 3's exact recipe), then assert the client-side handler (unit, with a slow stubbed print stage)
   enqueues the physical print exactly once and acks both deliveries; assert kitchen jobs redelivered
   mid-transport no longer dead-letter a successful print.
2. **Batch bound (Task 1)**: seed 30 pending jobs, connect a spooler, assert the first claim delivers ≤10 and
   the periodic dispatcher (invoked directly) drains the rest in waves with `attempts = 1` throughout.
3. **Restart recovery (Task 2)**: occupant made unresponsive to `query_printers_status` → second socket with
   the same id accepted within 3 s, occupant disconnected, registry swapped. Mirror: responsive occupant →
   newcomer rejected, occupant keeps printing (deliver + ack a job to `acknowledged`).
4. **Client retry loop (Task 4)**: after `spooler_rejected` the poll scheduler snapshot stays
   `disabled: false` and a reconnect attempt is scheduled; once the slot frees, the client connects
   (experiment 1c inverted). Poll-fallback unit: 403 → backoff and recover; 401 → slow retry, never
   `disabled: true`; socket-reconnect during an in-flight poll still processes that poll's jobs.
5. **Heartbeat regression (Task 5)**: assert `io.engine.opts` equals the tuned values so the 45 s window
   can't silently return; connect a spooler with no bound printers and assert the warning log and
   `printers_bound: 0` in self-status.
6. **Wedge containment (Task 6)**: stub `exec` to hang; advance fake timers 5 minutes; assert exactly one
   in-flight probe and a timeout kill, not five stacked processes.
7. **Performance guards**: keep asserting `SPOOLER_PRINT_TIMING` fields exist (render/raster/transport ms) so
   field logs stay diagnosable; assert the probe path adds zero traffic when registrations don't collide.
