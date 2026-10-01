# Spooler Changes

**Current as of 2026-08-21 — spooler package 1.2.x, V2 pull agent.**

This document describes how the print spooler works today and how to deploy it.
Everything in it has been verified against the source in this repository, not
recalled from older revisions.

Operational procedures for day-to-day printing live in
[`docs/printing-runbook.md`](printing-runbook.md). This file covers architecture
and deployment.

---

## Architecture: the V2 pull agent

The spooler is a plain Node process (`pos-spooler-printer/server.js`) that runs
as a Windows service on each print computer. It is **pull-only**:

- It dials out to the POS server. It never listens on a port.
- It has no tray icon, no local web page and no local UI. Its only outputs are
  the service log under `C:\ProgramData\POS-Spooler\logs` and its local job journal
  under `C:\ProgramData\POS-Spooler\state`.
- The server therefore has no channel to a spooler that is not running. Anything
  resembling "restart the spooler from Admin" is impossible by construction, and
  that is deliberate: an inbound control surface on every till is an attack
  surface on every till.

It talks to three routes under `/api/spooler/v2` (mounted at `server.js:428`):

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /register` | `x-spooler-key` | Claim a station, receive an agent identity |
| `POST /status` | `x-spooler-key` | Report station protocol and last sync |
| `POST /sync` | agent credentials | Lease work, settle outcomes |

### Stations and agents

Each print computer has a stable `SPOOLER_ID` (the *station*). Printers are bound
to a station by `printers.spooler_id`, so the station id is the machine's
identity — changing it silently orphans that machine's printers.

Each running process registers as an *agent* in `spooler_agents`:

```
status  enum('active','draining','revoked','decommissioned')
```

Exactly one live agent per station is enforced by the database, not by
application logic — `active_station_key` is a stored generated column that
equals `spooler_id` while the status is `active` or `draining` and `NULL`
otherwise, under a unique index. A second agent claiming a busy station is
rejected by the engine.

### Exactly-once job handling

Work is leased, not pushed. A job carries `print_queue.agent_id` for ownership,
and moves through:

```
pending → sent → local_accepted → acknowledged
                              ↘ dead_letter / canceled
```

The agent accepts a job, prints it, then settles the outcome on a later sync.
Settlement maps as follows (`backend/services/spoolerSync.js:27`):

| Agent outcome | Queue status |
| --- | --- |
| `completed` | `acknowledged` |
| `canceled` | `canceled` |
| `permanent_failure` | `dead_letter` |
| `uncertain` | `dead_letter` |

`dead_letter` is a deliberate terminal state requiring a human decision. The
system will not silently reprint a receipt it cannot prove failed.

### Proving a job actually printed

Windows reports a raw print job as accepted the moment the spooler takes the
bytes, which says nothing about paper. The C# platform helper
(`pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs`) therefore watches
Winspool job set/delete notifications and checks the Windows job after each event.
Notification setup begins only after `EndDocPrinter` submits every byte, so a slow
provider alias cannot strand an unsubmitted ticket as outcome-unknown.
A 400 ms poll is the missed-event watchdog. The drain window is 10 seconds by
default (clamped 2–30 s):

- **`drained`** — the job reported `PRINTED`/`COMPLETE`/`DELETED`, or vanished.
  Reported as success.
- **`stuck_deleted`** — the window expired, the job was deleted, and it was
  *never* observed printing. Because bytes were already submitted between status
  observations, this is raised as uncertain `WINspool_JOB_STUCK` and is not
  automatically reprinted.
- **`drain_unknown`** — the window expired but the job *was* observed printing,
  or could not be deleted. Bytes may have reached paper. Raised as
  `WINspool_DRAIN_UNKNOWN` and classified `uncertain`, which dead-letters rather
  than reprinting.

Set `SPOOLER_WINDOWS_DRAIN_STRATEGY=poll` and restart the service to bypass job
notifications and use the 400 ms watchdog alone. Notification setup/wait failures
also fall back to that path automatically. UNC printer shares use polling directly
because remote notification setup can block on network or provider state.

The helper is compiled from source during the installer build with the
Windows-inbox .NET Framework compiler (`scripts/build-installers.ps1:233`). The
`bin/` output is intentionally untracked.

### Stage timing and terminal isolation

Completed V2 jobs store bounded render duration, local duration, renderer and
transport mode in the existing settlement update. The admin diagnostics download
groups the latest acknowledged timings by station, agent, printer and print type.
This is observational only: it adds no sync request, query, journal write or printer
lock. Station claim queries start from that station's active printers and the existing
owner-claim index, preventing simultaneous terminals from locking one another's
pending queue candidates.

### Typst failure containment

Failed live-watcher compiles remove their per-job image directory while retaining
the last successful job's assets until the next successful compile. Runtime
failures open a timer-free 30-second cooldown: queued jobs use Chromium immediately
instead of each paying another Typst timeout, then one later job probes Typst again.
Saved fields using the supported `apart` label layout remain on the native Typst
path.

### Browser-free trial profile

The installer builder can produce a separate Typst-only Setup, core Update, and
Runtime Update. The profile omits Chromium and Puppeteer, stamps
`runtimeProfile: typst-only`, and makes the profile authoritative at spooler
startup. Unsupported reports and legacy jobs fail before transport with
`TYPST_DOCUMENT_UNSUPPORTED`; they never construct or fall back to Chromium. The
Full artifacts remain available for the client-test rollback.

### Retry and backoff

Per-job retries (`pos-spooler-printer/v2/printer-workers.js`):

| Job kind | Delays | Max attempts |
| --- | --- | --- |
| Kitchen and receipt | 1 s, 2 s, 5 s | 60 |
| Reports and everything else | 2 s, 5 s, 10 s, 30 s | 20 |

Exhausting the attempts settles `permanent_failure` with
`RETRY_LIMIT_EXHAUSTED`.

Sync failures back off `2 s → 5 s → 10 s` with up to 25 % added jitter
(`v2/agent-runtime.js:1`), so a fleet restarting together does not stampede the
server. An agent holds at most 50 local jobs.

A `revoked` or `decommissioned` status pauses the agent; `active` and `draining`
keep it working.

---

## What V2 replaced

V1 pushed jobs to spoolers over Socket.IO with a poll/ack side channel and an
in-memory registry. All of it is gone from the server — Socket.IO printer
delivery, the poll/ack routes, the registry files and the periodic dispatcher —
and its absence is locked down by a source-scan contract test
(`backend/tests/unit/spoolerV2OnlyContract.test.js`). **An old V1 agent has
nothing to talk to on a current server.**

Also removed:

- The `escpos` dependency. Arabic text is rendered to a raster image rather than
  emitted as native ESC/POS.
- The `node-windows` manual install path (`install.bat`, `install-service.js`),
  dropped in `58052234`.

---

## Installation and updating

The service is named **`POS Print Spooler`** and is run by NSSM, which invokes
the bundled Node runtime against `server.js`. Six artefacts come out of
`npm run build:installers`:

| Artefact | Use |
| --- | --- |
| `POSAPP-Spooler-Setup.exe` | Fresh install |
| `POSAPP-Spooler-Update.exe` | Application-only update |
| `POSAPP-Spooler-Runtime-Update.exe` | Application **and** dependency/browser runtime |
| `POSAPP-Server-*` | The three server equivalents |

The build auto-bumps both versions, commits the bump, compiles the C# helper and
uses its own pinned Node 22.23.0 from `deployment/vendor`. It requires a clean
tracked tree.

### Choosing between Update and Runtime-Update

`Update-Spooler.ps1` runs in `Core` or `RuntimeTransition` mode. In `Core` mode
only, it compares the installed release's `runtimeSha256` against the target
release and refuses with `runtime_transition_required` when they differ or the
older installation has no runtime marker.

**Any release that changes spooler dependencies therefore requires the
Runtime-Update.** The ordinary update refuses cleanly rather than installing a
half-matched runtime. `RuntimeTransition` replaces the runtime and stamps the new
marker, so it is also the adoption path for installer-era releases without one.

### Preconditions the updater enforces

- **Roughly 1.8 GB free** on the Program Files volume; the payload is around
  766 MB, most of it the bundled headless Chrome.
- **The POS server should be updated, running and healthy first.** This is no
  longer enforced. The updater verifies the payload hash before it stops the
  service, then stops, replaces and starts — it does not check the server, and it
  does not wait for the station to re-register. Updating a spooler against a
  server that lacks the `spooler_agents` schema now succeeds and leaves a till
  that cannot print.
- The service must be exactly the expected NSSM service, and only one of them.

The update is **stop → replace → start**. There is no journal, no staging and no
rollback: if it fails partway, re-run the previous `POSAPP-Spooler-Setup.exe`,
which lays the whole payload down unconditionally. The identity files
(`release.json`, `package.json`, `package-lock.json`) are copied last, so a copy
that dies partway leaves the old version on disk and re-running the updater
retries rather than reporting the station already current.

Because nothing waits for re-registration, **check Settings > Print queue after
every update**. The wizard says so when the station has not reconnected, but the
service reports Running either way — NSSM marks it Running as soon as it spawns
node and restarts it on exit, so a crash-looping agent still looks healthy to the
service manager.

`Update-Spooler.ps1` accepts `-WhatIf`, which reports installed versus target
version, runtime id and file count without mutating anything. Worth using on the
first site of a rollout.

### Legacy installs

A machine whose service points at `daemon\posprintspooler.exe` was installed by
the retired `install-service.js` path. Both the updater and the fresh installer
refuse it outright: `Legacy daemon-based spooler service cannot be installed
over; remove it before installing the current package.` Remove the old service
and daemon folder first, then run `POSAPP-Spooler-Setup.exe`.

If the service key is absent entirely (someone ran `node server.js` by hand),
the fresh installer treats it as a clean install and needs no preparation.

### Rollout order

```
1. Build installers from a clean tree
2. Update the POS server (applies pending migrations automatically)
3. Update each till with the correct spooler artefact
4. Confirm every station is Online in Admin → Settings → Print queue
```

Do one restaurant end to end before rolling the rest.

---

## Configuration

Configuration lives in `C:\ProgramData\POS-Spooler\config\spooler.env`, with
state and logs as sibling directories. The uninstaller deliberately preserves
`config` and `state`, so a machine keeps its identity across an
uninstall/reinstall; only the Program Files directory is removed.

```env
CLOUD_SERVER_URL=https://pos.example.com
SPOOLER_KEY=shared_setup_key
SPOOLER_ID=primary
SPOOLER_NAME=Front counter
SPOOLER_STATE_DIR=C:\ProgramData\POS-Spooler\state
SPOOLER_LOG_DIR=C:\ProgramData\POS-Spooler\logs
```

`SPOOLER_KEY` is shared across the fleet; `SPOOLER_ID` must be unique per
machine and must match the station assigned to that machine's printers in
Admin → Settings → Printers. Optional buzzer settings
(`KITCHEN_BEEP_ENABLED`, `KITCHEN_BEEP_COUNT`, `KITCHEN_BEEP_DURATION`, and the
`RECEIPT_BEEP_*` equivalents) control the built-in beeper.

The installer reads any existing `spooler.env` and reuses `CLOUD_SERVER_URL`,
`SPOOLER_KEY`, `SPOOLER_ID` and `SPOOLER_NAME` when they are not supplied on the
command line, so a reinstall does not require re-entering them.

---

## Operating a station

**Admin → Settings → Print queue** is the maintenance surface. Per station it
shows online/offline/paused, agent status, last sync, local queue depth,
renderer and helper state, and the last error. It refreshes while the tab is
open.

Two lifecycle actions:

- **Drain station** — stop issuing new work and let the agent finish what it
  holds. Use this for a planned replacement, and wait for the card to show the
  agent has drained.
- **Force replace** — take the station key from an agent that is stuck. It
  accepts a `draining` agent, revokes it and terminalizes stranded jobs as
  outcome-unknown. Use it only once the old machine is stopped, and review the
  stranded work before any manual reprint.

Individual queue rows offer **Reprint** and **Cancel**.

The admin header carries two indicators: a failed-jobs badge covering
`failed` and `dead_letter`, and a stale-station warning for a station that has
queued work but whose agent has not checked in. The stale check is driven from
`printers`, not from `spooler_stations`, so a printer whose agent never
registered is still visible.

### Diagnosing a printer that will not print

A disconnected USB thermal printer looks healthy to Windows: `Get-Printer`
reports `Normal`, and `PRINTER_INFO_2.Status` is `0` with no bits set. The
reliable signals are the PnP presence of the device and the job going to
`Error, Printing` with zero pages printed, which then surfaces as
`WINspool_DRAIN_UNKNOWN`.

```powershell
Get-PnpDevice | Where-Object { $_.InstanceId -match 'USBPRINT' } |
    Select-Object Status, Present, FriendlyName
```

`Present : False`, or a device named `No Printer Attached`, means the printer is
powered off or unplugged — not a software fault.

---

## Historical note

Earlier revisions of this file carried per-branch deployment patch notes going
back to June 2026, from the era when `pos-spooler-printer/` was untracked and
updated by hand-copying files. That era ended on 2026-07-25: the package is now
tracked deployable source, shipped whole by the installers, and print layouts
are produced by the template engine rather than by patched spooler files.

Those notes are preserved in git history and should not be used for any current
deployment. Retrieve them with:

```bash
git log --follow -p -- docs/SPOOLER-CHANGES.md
```
