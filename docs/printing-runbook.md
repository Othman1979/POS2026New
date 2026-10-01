# Professional Printing Runbook

## Deploy Order

1. Deploy backend code.
2. Run migrations:
   - `backend/migrations/2026-07-05-print-queue-durable-lifecycle.sql`
   - `backend/migrations/2026-07-05-printer-status-capability.sql`
   - `backend/migrations/2026-07-19-multi-spooler-printer-ownership.sql`
3. Restart the POS server.
4. Drain the server queue and each station before replacement. Preserve each print machine's configuration and durable state. Existing custom HTML-only jobs without a native layout must finish before the Typst transition.
5. Use the complete Typst runtime updater for a packaged station; a core update cannot replace a former Chromium runtime. For the copy-folder service, prepare the complete tracked directory using its service README, never only `server.js`.
6. For source preparation, run `npm ci` inside `pos-spooler-printer`, then `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-spooler-typst.ps1` from the repository root and `npm --prefix pos-spooler-printer test`. Preserve the destination machine's `.env` when copying. Packaged updaters preserve ProgramData configuration automatically.
   Before restarting: the spooler now fails fast in production when `CLOUD_SERVER_URL` or `SPOOLER_KEY` is missing (the old hardcoded server URL default was removed). Confirm every machine's restored `.env` sets both keys explicitly, or the service will crash-loop after this deploy.
7. Restart every local spooler service.
8. Open Admin -> Settings -> Printers and assign every printer to its print station.
9. Open Admin -> Settings -> Print queue and confirm all stations, versions and printers are online.

## Spooler Configuration

One POS installation uses one shared `SPOOLER_KEY`, with one stable `SPOOLER_ID` per print computer. Existing single-computer installations use `primary`. A second machine must use a different ID such as `terminal-b`; never run two live spoolers with the same ID.

The migration assigns every existing printer to `primary`. On an existing one-machine installation, remove any old custom `SPOOLER_ID` or change it to `primary` before restarting the updated spooler. If you intentionally keep a custom ID, first reassign those printers to that exact station in Admin -> Settings -> Printers.

```env
CLOUD_SERVER_URL=https://your-pos-host.example
SPOOLER_KEY=the_same_single_setup_key
SPOOLER_ID=primary
SPOOLER_NAME=Front counter
POLL_FALLBACK_GRACE_MS=5000
SPOOLER_STATE_DIR=C:\ProgramData\POS-Spooler
```

Example for a second print computer:

```env
SPOOLER_ID=terminal-b
SPOOLER_NAME=Patio counter
```

Receipt terminals select their logical receipt printer locally. Kitchen jobs follow the printer's configured station and are not broadcast to every spooler. Multiple kitchen tickets are produced only when the category is intentionally assigned to multiple distinct printers.

`acknowledged` means the spooler send function completed and bytes were handed to the printer or OS. It does not prove paper physically came out.

## Test Print Checklist

- V1 exclusive receipt with line discounts matches the POS/admin totals
- V1 inclusive receipt labels tax as included without adding it twice
- Bundle plus service charge prints children without child prices
- Old built-in payload without v1 prints through the native structured-data adapter
- Malformed present v1 is rejected and not printed with recomputed money
- HTML-like text in names, notes and footer prints literally
- Arabic kitchen ticket
- Arabic customer receipt
- Tall audit report
- Network disconnect while jobs are queued
- Failed/offline printer case
- Audited reprint from Admin -> Settings -> Print queue
- Spooler restart duplicate check with the same `queue_id`
- Two connected stations cannot claim each other's printer jobs
- A second live spooler using the same `SPOOLER_ID` is rejected

## Failed update recovery

Use the updater's diagnostic result to repair the Typst installation and rerun
the same reviewed update. Never delete `print_queue` history, local journals, or
outcome-unknown markers to force a retry. Chromium packages and rollback targets
are no longer supported. Preserve the machine configuration; never restore
secrets from Git.

## Operator Recovery

Use Admin -> Settings -> Print queue to inspect state counts, recent jobs, printer status, and eligible reprints. A kitchen attempt interrupted after printing begins is dead-lettered instead of retried automatically; verify the kitchen output, then use the audited reprint action only when needed. Reprint creates a new queue row and does not mutate the original print history.

### V2 station health and cutover recovery

The Print queue tab reports durable V2 station health from the agent's last sync. `Online` means the server received a fresh authenticated sync; a Socket.IO connection is not used as proof of V2 health. The card also shows the local journal depth, renderer/helper state, protocol, and the last accepted/acknowledged activity. `Stored on terminal`, `Bytes sent`, and `Unknown` describe the strongest server-known boundary; none means that paper was physically printed.

Use `Drain station` for a normal replacement and wait for the card to show the agent has drained before installing the replacement. Use `Force replace` only after the old terminal is stopped; unresolved work is deliberately marked outcome-unknown and must be checked before any audited manual reprint. V1 rollback is shown only when the server reports that no V2 work has been accepted. During a `transitioning` cutover, `Mark outcome unknown` is available only for stranded V1 `processing`/`sent` rows and requires a reason plus confirmation that the old service is stopped. The installer never invokes this recovery action automatically.

The `Download diagnostics` action produces redacted JSON containing versions, station/agent health, printer capabilities, queue counts/ages, timing summaries, stable error codes, and artifact hashes/sizes. It intentionally excludes payloads, compiled documents, customer data, credentials, environment files, agent tokens, and raw logs.

### Recovering a drained or decommissioned station

Drain permanently retires the station identity. After the local queue empties, the agent auto-transitions from `draining` to `decommissioned`. There is no reactivate endpoint. The decommissioned agent then treats itself as paused and polls without re-registering.

To recover the same print computer, first drain the old station or force-replace it
after confirming the old service is stopped. Then run the installed
`C:\Program Files\POS-Spooler\maintenance\rebind.cmd`. The command refuses a
non-empty local print journal or an occupied target station, retires rather than
deletes `agent.json`, starts the service, and succeeds only after the new identity
completes a fresh authenticated sync. Open Admin -> Settings -> Print queue and
confirm the station is Online.

For an ordinary edit to
`C:\ProgramData\POS-Spooler\config\spooler.env` that does not change server or
station ownership, run
`C:\Program Files\POS-Spooler\maintenance\refresh.cmd`. It preserves the current
identity and proves its heartbeat advanced after restart. Do not manually delete
or rename `agent.json`.

Decommission waits until `local_queue_depth` is 0 and a count of `processing` / `sent` / `local_accepted` / `cancel_requested` rows for that agent returns zero.

If that count never reaches zero — stranded `sent` or `local_accepted` rows from a station that died mid-job — the row stays `draining` forever, and `draining` still holds `active_station_key`. Rebind then fails with `station_occupied` ("This station already has an active agent"). Use `Force replace` on that station first: it accepts a `draining` agent, revokes it so the station key is freed, and terminalizes the stranded jobs to `dead_letter`. Then run `rebind.cmd` again.

Force replace is a different action. Use it only after the old terminal is stopped. Its unresolved jobs stay `dead_letter` / outcome unknown and need an audited reprint from Print queue.

### V2 release gate

Before a V2 canary, run the automated gate from the release commit:

```powershell
node pos-spooler-printer/tests/v2-hostile-runtime.test.js
node backend/tests/manual/spoolerV2MixedJobsHarness.js
node backend/tests/manual/spoolerV2MixedJobsHarness.js --live
```

The live harness is disposable-DB-only and refuses a database name that does
not end in `_test`. It must account for exactly 20 kitchen, 20 receipt, and 10
report jobs across three printers, with zero duplicate transport markers or
submissions. Keep the physical matrix separate: test the affected long-report
printer, a Windows USB/shared printer, direct TCP, a write-only clone, and a
feedback-capable paper-out/cover-open case. A write-only acknowledgement is not
paper confirmation, and a physical failure cannot be waived by automated tests.

The complete command/output record and canary decision belong in
`docs/superpowers/evidence/2026-08-17-spooler-v2-release-gate.md`. Retain V1
for two stable V2 releases after an approved canary.

## Fresh installer physical acceptance

Run this checklist only after the clean Windows smoke test passes, using the
exact installer commit and SHA-256 values recorded in the deployment release
acceptance record:

- Install the server package on Terminal A and confirm POS, MariaDB,
  phpMyAdmin, and the optional local spooler recover after reboot.
- Install only `POSAPP-Spooler-Setup.exe` on Terminal B. Confirm no POS,
  MariaDB, Apache, or phpMyAdmin service exists there.
- Open POS from Terminal B through Terminal A's LAN URL and confirm the
  station/version appears in Admin -> Settings -> Printers.
- Complete login `009384`, settings/logo, product/category/modifier/bundle,
  shift, cash, card, split-tender, hold/recall, table, refund, void, and
  subscription workflows.
- Print a customer receipt, kitchen ticket, kitchen void ticket, Arabic text,
  multiline notes, and an activated custom receipt/kitchen template from both
  server-local and Terminal B-attached printers.
- Disconnect/reconnect USB and network printers; verify the durable queue,
  audited reprint, duplicate protection, and station ownership behavior.
- Disconnect the internet while keeping the LAN connected; confirm local POS
  selling and spooler delivery continue as designed.
- Create a backup, restore it into a separate clean database instance, run
  schema validation, compare core row counts and financial totals, and never
  substitute the restored database into production during the test.
