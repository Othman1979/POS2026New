# Fresh Windows installer build

This directory builds the two offline packages for a genuinely fresh Windows
x64 machine. It does not migrate XAMPP or an existing POS installation.

## Release contract

- Target: Windows 10 1809 (build 17763) or later workstation on native x64
  hardware. Windows Server, ARM64, and pre-1809 builds are rejected by both
  installers.
- The supported OS floor remains 17763. Verify the pinned Node, Typst
  runtime on the clean Windows acceptance VM; removal of the browser does not
  establish compatibility with older Windows versions.
- Build tool: Inno Setup 6.7.3 stable.
- Server AppId: `{E99DB275-DDA0-43A0-95CD-7AE07185122C}`.
- Spooler AppId: `{80657A48-9BCB-4455-8CA9-A18139FDFC58}`.
- Server services: `POSAppMariaDB`, `POSApp`, `POSAppPhpMyAdmin`.
- Spooler service: `POS Print Spooler`.
- Durable data never belongs below `C:\Program Files`.

The server installer and spooler installer are independent packages. The
server package contains no Chromium or printer-spooler payload; install the
standalone spooler package on the workstation physically connected to the
printer and point it at the server's POS URL.

Vendor archives are build inputs, not repository files. Place them under the
ignored `deployment/vendor/` directory, verify each SHA-256 against
`vendor-lock.json`, and verify any available vendor signature before building.
Never invent a digest or commit redistributable binaries without confirming
the applicable licence.

The immutable application payload belongs under `C:\Program Files\POSApp` and
the durable configuration, database, uploads, backups and logs belong under
`C:\ProgramData\POSApp`. Spooler binaries follow the same split under
`C:\Program Files\POS-Spooler` and `C:\ProgramData\POS-Spooler`.
MariaDB's private binaries live under `C:\Program Files\POSApp-MariaDB`, so
removing the immutable POS application cannot leave the preserved database
service pointing at files deleted from the Inno-owned application directory.
The build expands the official MariaDB Windows ZIP into the staged private
runtime payload. The server installer moves that packaged runtime into
`C:\Program Files\POSApp-MariaDB`, then creates the owned `POSAppMariaDB`
instance with `mariadb-install-db.exe` so the service name, data directory, and
port are explicit. The customer-machine installer does not run MariaDB MSI
install or administrative extraction commands.
The installer creates desktop shortcuts for the POS and loopback-only
phpMyAdmin. phpMyAdmin uses the `posapp_maintenance` account; its generated
password is in the Administrators/SYSTEM-only
`C:\ProgramData\POSApp\config\backup.env` file and is never written to release
metadata or an installer command line.

## Startup recovery and installer repair

The installed system owns its Windows-startup recovery. It does not rerun the
full installer at every boot.

- All four services use Automatic startup, two Service Control Manager restart
  attempts, and `FailureActionsOnNonCrashFailures=1`, so a process that reports
  a failed stop is covered as well as a crash.
- The server installer registers `POSAPP Startup Health Repair` as a delayed
  SYSTEM startup task. It starts a stopped existing MariaDB, phpMyAdmin, or POS
  service and performs bounded TCP/HTTP health probes. A running but unhealthy
  service is restarted once, then reported unhealthy if the probe still fails.
- The standalone spooler uses NSSM/Service Control Manager restart policy. Its
  install and update paths are retryable and do not create a boot repair task.
- Machine-readable results are written to
  `C:\ProgramData\POSApp\logs\startup-health.json` and
  `C:\ProgramData\POS-Spooler\logs\startup-health.json`; matching
`startup-repair.log` retains technician-readable server evidence.

Startup repair fails closed when a service registration, executable, config,
or data directory is missing. The status tells the technician to rerun the
matching installer in repair mode. Explicit server repair may restore packaged
MariaDB binaries and a missing `POSAppMariaDB` registration only when the
existing `my.ini` and database directory are present. It never runs
`mariadb-install-db`, replaces secrets, deletes data, or restores a backup in
repair mode. If those durable inputs are missing or corrupt, stop and recover
them deliberately rather than guessing.

Build commands:

```powershell
npm run test:installer
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/runtime-config-probe.ps1
npm run build:installers
```

The spooler has one supported renderer and runtime profile: Typst. Build the
installer family from a clean feature branch:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installers.ps1 -OutputRoot deployment/out/typst-only
```

Alongside the server installers, this produces `POSAPP-Spooler-Typst-Only-Setup.exe`,
`POSAPP-Spooler-Typst-Only-Update.exe`, and
`POSAPP-Spooler-Typst-Only-Runtime-Update.exe`. Setup is for a fresh station. The
Runtime Update converts an existing packaged Full station and removes its Chromium
cache and Puppeteer dependencies while preserving ProgramData configuration and
queue state. The small Update applies only after the station already has the
matching Typst-only runtime; it refuses a Full station with
`runtime_transition_required`.

A compiled build automatically increments the server and spooler patch versions,
commits only their package, lockfile, and Inno identity files, then builds from
that exact clean commit. If compilation is interrupted, the next build resumes
the pending release instead of incrementing twice. Use `-StageOnly` for
non-mutating payload validation, or `-SkipVersionBump` to reproduce an existing
release intentionally. No build command pushes, tags, or deploys anything.

## Packaged update installers

`npm run build:installers` also produces fast core and explicit runtime-transition
updaters for both the server and spooler. These are for machines installed by the packaged
installers only; they intentionally reject source-code/XAMPP deployments and
fresh machines. The two update packages keep the original AppId and install
directory, but stage their payload under the installer's temporary directory
and let the matching updater script own the replacement.

The server updater is layered: `POSAPP-Server-Update.exe` keeps verified
`node_modules` in place, while `POSAPP-Server-Runtime-Update.exe` explicitly
replaces dependencies when their content identity changes. Both verify the owned
`POSApp` service and release metadata, create a compressed checksum-verified
database backup, run only the staged automatic additive migration chain, replace
the selected managed layer, and verify target health/release. Neither recreates
the database, generates secrets, changes ports, or stops/reconfigures MariaDB and
phpMyAdmin. The spooler updater is also layered: `POSAPP-Spooler-Typst-Only-Update.exe` is the fast core path
for application-only changes, while `POSAPP-Spooler-Typst-Only-Runtime-Update.exe` is the
explicit transition path when the installed dependency/Typst hash is missing
or does not match. The core path carries no `node_modules` or compiler runtime and
refuses before stopping the service when `runtimeSha256` is not already known to
match. The runtime path carries complete dependencies and the
Typst 0.15.1 and pinned multilingual fonts. Both use a retryable stop/replace/start operation. Neither path runs npm, downloads dependencies, or
uses the fresh installer as an update mechanism.

The Typst-only filenames above are the sole supported spooler profile. Payload
validation rejects `.cache/puppeteer`, Puppeteer packages, and
`.puppeteerrc.cjs`; the installed release profile forces strict Typst routing even
if an older preserved environment file selected Chromium. Receipts, kitchen tickets,
X/Z, audit, category/Y, all daily reports and expense slips render natively.

The vendor lock continues to verify the official Typst 0.15.1 Windows archive.
During staging, `deployment/tools/patch-typst-fast-watch.js` accepts only that
official executable SHA-256, changes the single verified watcher-timeout
instruction from 100 ms to 5 ms, and verifies the exact resulting SHA-256.
Fresh installers, runtime-transition updates, and the lightweight online
bootstrap all use this same patcher and carry `POSAPP-PATCH.txt`, the Typst
LICENSE and NOTICE beside the executable. An unknown input, ambiguous patch site,
or unexpected output stops packaging before publication.

`C:\ProgramData\POS-Spooler\config\spooler.env` is the sole configuration
authority. Updaters read required values in memory, preserve every byte (including
comments, unknown settings, ordering, line endings, and a portless HTTPS origin),
and never rewrite or restore the file. They also leave queue state, durable
seen-store files, printer configuration, and logs untouched. A machine-wide
process mutex prevents concurrent install, update, removal, or agent maintenance.
An interrupted replacement is recovered by running the same updater or installer
again; there is no persistent transaction journal or startup repair task.

Use the core package when its preflight says the installed runtime ID matches.
Use the runtime package only for the explicit `runtime_transition_required`
case or a deliberately approved runtime refresh. Never uninstall first and do
not delete the previous artifact until the station's physical receipt and
kitchen-printer checks are complete. A same-version/different-commit package,
downgrade, missing or conflicting ownership metadata, bad payload hash, unknown
service, invalid origin, or changed environment hash is refused before
mutation.

Update one server first, then update each standalone spooler station with its
own updater package. Keep the database backup and the updater log under the
corresponding ProgramData directory until the restaurant confirms the release.
The updater's normal result contains paths and hashes, never database
passwords or spooler keys. Do not run an update over the old source/XAMPP
deployment path; those installations are migrated manually by the technician,
and no automated product path is planned.

For evidence, run the non-destructive verifier before an update to create a
baseline, then run it again after the update to compare row counts, ports,
environment/configuration hashes, station identity, and release health:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-smoke.ps1 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-smoke.ps1 -ExpectedServerVersion 1.0.1 -ExpectedServerCommit <40-hex-commit> -IncludeSpooler
```

The first real run writes `tests/installer/results/update-baseline.json`; the
second run compares against it. `-AfterReboot` checks service recovery after
the operator has actually rebooted. A clean Win10/Win11 VM, rollback drill,
and physical printer verification remain required release evidence and are
not implied by the local probes.

Current checkout verification (2026-08-01): Node 22.23.0 staging, both payload
validators, real Inno Setup 6.7.3 compilation, and the installer size gates
pass. The release artifacts below were built from the committed installer
sources on a tracked-clean tree.

Windows acceptance matrix (the same committed installer hashes must be used for
both rows):

- Windows 10 22H2 x64 (build 19045): fresh server install, standalone spooler,
  reboot recovery, and conflict-port checks in a clean reverted VM.
- Windows 11 x64: fresh server install, standalone spooler, reboot recovery,
  and conflict-port checks in a clean reverted VM.
- Windows 10 1809 x64 (build 17763): PENDING. The installer now permits this
  floor on static-dependency evidence; no physical install has been validated on
  it. Close this row before claiming 1809 support in writing.

The current development host is Windows 11 build 26200, so it cannot close the
Windows 10 VM row. Windows 10 remains an application-compatibility target only;
Microsoft ended general support on 2025-10-14 and vendor support policies may
differ.

Verified local release build (2026-08-01):

```text
Release commit: 11d20878a5c00431971b8c8bfc089fe66227d03d
POSAPP-Server-Setup.exe
  bytes: 173410491 (165.38 MiB; max 220 MiB)
  sha256: 10667e1a9ba5c857bfe8e7490d8315ccdf45cfa0214c226968828c281c416958
POSAPP-Spooler-Typst-Only-Setup.exe
  bytes: 174931501 (166.83 MiB; max 180 MiB)
  sha256: c82d09e960fffeb53696c350127fd76d2d46f4af1e59efba0580dd8feb5ac916
```

Both generated sidecars match the files. The artifacts are not Authenticode
signed, so Windows may show an unknown-publisher/SmartScreen warning. Code
signing, the clean-VM acceptance matrix, and physical-printer acceptance remain
release gates rather than locally verified claims. Inno Setup reported its
non-commercial-use notice; commercial distribution must follow its current
licensing terms.

The runtime probe extracts the pinned Apache/PHP/phpMyAdmin archives and asks
the actual binaries to validate the generated configuration. The staged
spooler dependency audit is clean. The staged server currently reports the
known `xlsx@0.18.5` advisory for which npm supplies no fixed release; replacing
SheetJS is a separate application dependency decision, not an installer fix.

Layered spooler build evidence (local, 2026-08-12; not a deployment approval):

```text
fresh setup EXE: 175,097,864 bytes
core stage:     199,447 bytes, 16 files; core EXE: 2,158,824 bytes
runtime stage:  503,206,799 bytes, 4,198 files; runtime EXE: 153,303,943 bytes
runtime id:     0f3ed908e3198947e4f9b48655a56751bdb6d1a65d6196cdf7d544ae99546759
dependencies:   8ae7816e66255a1c5d19484944c06b54e68e4647bc812ed55ea09ad333ba28c6
browser:        be525360dce05426cdc7a1a6bb96df9e4a232f0c8c16bd8975b82b285342139e
fresh EXE sha256:   5c6d455232abe5a5b361a59743fc1a51b9d634836f578ec7ac37603c35a3fc82
core EXE sha256:    f16880b0126df2d4d02bd632c8d4bb90e4d19cdd8a7586eb7d4e56b63e92ef8e
runtime EXE sha256: df341bb202197ee7046f8b0b3652cc98e0ae72d29b4039695f00c0acde0e88ac
```

The local validators, PowerShell probes, focused installer contracts, and
spooler tests pass. These hashes are useful only when regenerated from the same
committed source. Clean Windows 10/11 VM interruption/reboot evidence and the
physical receipt/kitchen-printer gate are still open; this checkout does not
claim customer readiness until both are completed against the final hashes.

Do not run an installer, mutate Windows services/firewall, or touch the live
development database from this repository checkout. Clean-machine acceptance
belongs in a disposable Windows VM and is a later plan task.

## Clean Windows acceptance

Run `tests/installer/fresh-install-smoke.ps1` only on a reverted clean Windows
x64 VM after both installers have been compiled. Use `-WhatIf` for parser and
argument checks on a development machine. The smoke script records a transcript
and JSON results under `tests/installer/results` and covers default ports,
conflict-port selection, service recovery, loopback database/phpMyAdmin,
Private-profile firewall scope, health release identity, backups, and the
all-users `POS App` shortcut. It does not replace physical printer acceptance.

The release VM drill must also exercise installer repair, reverting the VM
between cases:

1. Record database row counts, the active release, configured ports, and the
   hashes of `pos.env`, `backup.env`, and `database\my.ini`.
2. Reboot and wait for the delayed startup task. Confirm all owned services,
   health endpoints, task result, and both startup status files.
3. Delete only the `POSApp`, `POSAppPhpMyAdmin`, or `POSAppMariaDB` service
   registration, one case per reverted snapshot, then rerun the server
   installer in repair mode.
4. Delete only the `POS Print Spooler` registration in its own reverted
   snapshot, then rerun the standalone spooler installer.
5. After every repair, confirm the same database row counts, credential/config
   hashes, ports, and release identity. A repair that initializes a new
   database or changes a secret is a release failure.

## Release acceptance record

A release is not restaurant-ready until the clean-VM smoke test and physical
workflow checklist are completed against the same release commit. Record the
Windows build, selected ports, runtime versions, installer SHA-256 sidecars,
service versions, and customer/kitchen printer models beside the signed
release artifact. The physical checklist is in `docs/printing-runbook.md`.

### Transition from a former Chromium station

Drain the server queue and the station before using the runtime updater. The
updater checks pending local jobs before and after stopping the service and
preserves ProgramData configuration, identity, history and recovery markers.
Historical custom HTML-only jobs without a native layout must finish before the
transition. Built-in legacy jobs can render their saved structured data; new
custom templates include a native layout.

Chromium installation and rollback targets are retired. New packages accept
only the Typst profile; old EXEs retain their embedded historical scripts and
must not be used as current installers. Payload, ownership and Node compatibility
checks remain enforced, and downgrades are blocked.
