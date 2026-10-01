# Spooler V2 Rev 5.2 residual-races handover

Date: 2026-08-18
Branch reviewed: `codex/spooler-v2-local-print-agent-continued`
Reviewed commit: `21f37599109627696bb3e1ca28e06225946495ff`
Fixed point: `9eee0d2ec08fd647d9d06bc67d047e2a9e6d4288`

Purpose: give the next executor a narrow, reproducible correction target. This is not a redesign of Spooler V2 and does not approve a customer canary.

## Verdict

Commit `21f37599` correctly closes the originally reported late-V1 database overwrite and protects Windows prints that are already registered in the helper's pending-request map. Three adjacent races remain: two affect runtime behavior and one affects stale station ownership. The documentation/evidence also needs three small corrections.

## R1 — HIGH: status timeout can still make a pre-command print uncertain

### Evidence

`pos-spooler-printer/v2/platform-helper.js` awaits `beforeWrite` before adding the `print_raw` request to `pending`:

1. `requestOnChild()` accepts the print.
2. `beforeWrite` begins persisting the durable transport marker.
3. The print is not yet visible to `hasPendingPrintRaw()`.
4. A concurrent `printer_status` or `watch_printers` request times out.
5. Retirement sees no pending print and kills the helper.
6. The marker finishes, the print re-check fails, and the print becomes `PLATFORM_HELPER_RESTARTING / uncertain` even though its command was never written.

Observed hostile result:

```json
{
  "childKilled": true,
  "status": {
    "code": "PLATFORM_HELPER_TIMEOUT",
    "failureClass": "transient_safe"
  },
  "print": {
    "code": "PLATFORM_HELPER_RESTARTING",
    "failureClass": "uncertain"
  }
}
```

The test added by `21f37599` starts the status timeout only after `print_raw` has entered the helper request queue, so it does not cover this interval.

### Required correction

Track an accepted `print_raw` as active from immediately before `beforeWrite` starts until that request fully settles or fails. Helper retirement must wait for both marker-phase and pending-map print requests. Preserve these rules:

- no new request may enter once retirement begins;
- a status/watch timeout is `transient_safe`;
- an already accepted print must not be killed by status/watch retirement;
- a genuine print timeout remains `uncertain`;
- the helper is recycled after all accepted prints settle.

Do not serialize every Windows printer again and do not move the durable marker after command submission.

### Mandatory RED/GREEN test

Create a controllable `beforeWrite` promise. Start `print_raw`, wait until `beforeWrite` is blocked, then time out `printer_status`. Assert:

1. the status request fails `PLATFORM_HELPER_TIMEOUT / transient_safe`;
2. the helper child is still alive;
3. releasing `beforeWrite` allows the exact print command to be written and completed;
4. the print succeeds exactly once;
5. the helper recycles only after the print settles.

## R2 — HIGH: V2 cutover leaves stale V1 health in the socket cache

### Evidence

The SQL guard in `backend/services/printerStatus.js` correctly refuses a V1 write when `delivery_protocol='v2'`. The staff-facing `printerStatuses` cache in `server.js` is different state:

- V1 response/offline paths populate it.
- V2 synchronization updates the database but never replaces or removes its V1 entry.
- a newly connected staff socket receives `Object.values(printerStatuses)`.

Therefore a printer cached as V1 `offline` immediately before cutover can remain `offline` in the UI after V2 reports `ok`.

The new test does not prove otherwise. Its optional-chaining negative assertion passes when the cache entry is absent, and it checks `status_source` even though cache entries do not store that property.

### Required correction

Choose the smallest single authority for staff-facing V2 health:

- either publish accepted V2 health into the existing cache and emit the updated value; or
- remove the station's V1 cache entries at cutover/V2 health acceptance and make the staff surface read V2 health from its authoritative path.

Do not maintain two independent V2 health caches. Do not let a rejected late V1 write mutate or reintroduce the cache entry.

### Mandatory RED/GREEN test

The test must first create a real V1 cached `offline` entry, prove it exists, transition the station to V2, submit V2 `ok`, and then assert the staff-facing value is V2-correct or deliberately absent. Finally deliver the delayed V1 `offline` response and prove both the database and staff-facing value remain V2-authoritative.

Do not use optional chaining with `not.toBe(...)` as the main assertion.

## R3 — MEDIUM: stale V1 response is not atomically bound to its station

### Evidence

`handleSpoolerPrinterStatusResponse()` first selects printer IDs owned by `socket.spoolerId`. `updatePrinterDeviceStatus()` later updates by printer ID and protocol only. If the printer is reassigned to a different V1 station between those statements, the stale old-station response still passes the protocol guard and overwrites the new station's health.

### Required correction

Pass the expected `spoolerId` into the guarded V1 update and include it in the same SQL `WHERE` clause as the protocol check. The update must succeed only while both are true at write time:

- `printers.spooler_id` still equals the responding V1 station; and
- the joined station protocol is not V2.

Only mutate `printerStatuses` when this guarded update succeeds.

### Mandatory RED/GREEN test

Read ownership for station A, reassign the printer to station B before applying A's delayed response, then prove A changes neither the database nor the in-memory status.

## D1 — Documentation and evidence corrections

1. `docs/architecture.json` labels a node `printerStatus and checkPrintersStatus` but pins only `backend/services/printerStatus.js:31`; either split/rename the node to the guarded writer or point the polling part to `server.js` where `checkPrintersStatus` actually lives.
2. Update the verification totals: the focused health suite is now 8 tests and architecture currently references 157 distinct files.
3. Record the fixed-point whitespace command exactly: `git diff --check 9eee0d2e...HEAD`.

Avoid exporting a live mutable cache solely for a weak test. Prefer an observable socket event or return a read-only snapshot if a test seam is still necessary.

## Required verification

Run at minimum:

```powershell
node pos-spooler-printer/tests/v2-platform-helper.test.js
node pos-spooler-printer/tests/v2-printer-transports.test.js
npx vitest run backend/tests/integration/spoolerV2Health.test.js --reporter=verbose
npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Health.test.js backend/tests/integration/spoolerV2Compatibility.test.js --reporter=dot
npm run architecture
npm run architecture:check
git diff --check 9eee0d2e...HEAD
```

Report exact totals and the commit hash. Do not merge, push, deploy, build installers, or claim canary readiness.

## Still outside automated proof

Even after these corrections, customer-canary approval remains gated on the tracked physical matrix: USB/shared Windows/direct TCP/write-only devices, paper-out/offline/long-report recovery, DPAPI, disk-full, interrupted Windows install/update, helper mutex after hard kill, and hard-link behavior on non-NTFS state roots.
