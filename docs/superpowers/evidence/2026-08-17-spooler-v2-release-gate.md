# Spooler V2 release-gate evidence

Date: 2026-08-18
Branch: `codex/spooler-v2-local-print-agent-continued`
Commit under test: `ef8a685b6d80915b8aed7801c7667f9358892be0`
Machine: Windows `win32/x64`, Node `v24.16.0`, 28 logical CPUs, 32,606 MiB RAM

This is release-gate evidence, not a canary approval. Automated checks ran on the
current feature branch. The physical-printer matrix could not run on this
development machine, so the canary remains blocked until the named printers are
tested and photographed without customer content.

## Commands and results

| Gate | Command | Result | Evidence |
| --- | --- | --- | --- |
| V2 hostile runtime matrix | `node pos-spooler-printer/tests/v2-hostile-runtime.test.js` | PASS | 12 rows passed; V2 entry had zero Socket.IO/V1 poll references; transport marker ordering, durable restart/cancel state, lane isolation, status-probe exclusion, station locking, updater recovery, and bounded helper/renderer checks passed. |
| Deterministic mixed load | `node backend/tests/manual/spoolerV2MixedJobsHarness.js` | PASS | Exactly 20 kitchen, 20 receipt, 10 report jobs; 50/50 accounted; 50 local identities; 0 duplicate markers/submissions; 3,000 ms recovered-kitchen delay; 0 ms report delay; p95 pickup-to-transport 18,000 ms. |
| Live V2 HTTP mixed load | `node backend/tests/manual/spoolerV2MixedJobsHarness.js --live` | PASS | Disposable `*_test` DB only; real `/prepare`, `/register`, and `/sync`; 50/50 accounted; 0 duplicate markers/submissions; 3,138 ms recovered-kitchen delay; 158 ms maximum report delay; p50/p95/p99 pickup-to-transport 132/18,168/18,182 ms; process RSS 116 MiB; DB peak connections 0 in the local harness-owned worker (server pool was exercised by HTTP sync). |
| Spooler focused suite | `npm --prefix pos-spooler-printer test` | PASS | Existing V1/V2 tests plus the new hostile test pass. The suite also exercised helper timeout/restart, renderer timeout, durable journal recovery, transports, workers, and status monitor. |
| Full repository Vitest run | `npx vitest run` | **7 pre-existing failures** | 273/276 test files and 2,968/2,975 tests passed in 1,136.50 seconds. The seven failures are outside Task 13: one stale tax-exempt fixture, two WebAuthn migration-fixture assertions, and four legacy `spoolerReceiptDisplay` source-string assertions. Task 13 does not modify any of those files; they remain documented in the pre-existing triage and are not silently counted as a green full-suite result. |

The live harness seeds and drops only the disposable database selected by
`.env.test`; it refuses a database name that does not end in `_test`. It inserts
three network-printer rows and 50 queue rows, runs the real V2 HTTP lifecycle,
then removes its queue rows during cleanup. No production database, Hostinger
environment, station, or physical printer was touched.

The full repository run is recorded separately from the release-gate result on
purpose. It is not green on this branch: the command completed with seven
failures after exercising 276 files. Those failures are existing fixture/source
expectation debt, not Task 13 behavior, and the Task 13 decision below does not
pretend that a red full suite is a passing release signal.

## Automated hostile matrix

The matrix records the commit and machine profile above for every row. Static
guards are used only where the behavior is owned by a separate integration or
Windows process; they do not stand in for the physical gate.

| Scenario | Result | Captured metric / proof |
| --- | --- | --- |
| V2 package/runtime inspection | PASS | `v2-server.js` contains no Socket.IO import, V1 `/poll` path, or alternate delivery call; it wires the authenticated pull sync client. |
| 1/5/10/50/100 idle agents | PASS | Deterministic in-process probe measured p95 sync at 0–0.01 ms for the 1–5 acceptance tier; DB occupancy was 0 because the probe deliberately does not claim to be a server-pool load test. |
| HTTP timeout/401/403/500/server restart | PASS for bounded client/runtime behavior | Existing sync-client and runtime tests cover HTTP error classification, registration retry, and backoff; the hostile matrix proves 500 backoff and revoked pause. A production restart/network outage remains an operational canary check. |
| Lost registration/sync/result response | PASS | Durable local acceptance/outbox and idempotent accept/restart paths passed; no new local identity is generated for an existing queue record. |
| Concurrent capacity-one syncs | PASS | `spoolerSync` station row is `FOR UPDATE`, capacity is clamped to 50, and V1 claim code reads the same station authority. Integration coverage remains in `backend/tests/integration/spoolerV2Sync.test.js`. |
| Crash at every local transition | PASS for journal boundaries | `transport_started` reopens as `uncertain`; pre-marker cancellation is `canceled`; atomic journal writes leave no `.tmp` runnable file. |
| Second process/state-root copy | PASS by helper contract; physical process gate not run here | Helper source owns a canonical-path global mutex, emits `STATE_ROOT_LOCKED`, exits 73, and uses LocalMachine DPAPI. The existing Windows-capable helper test is the physical execution gate. |
| Cancel before/after response, acceptance, render, marker | PASS for durable local boundary | Cancellation before marker is terminal `canceled`; after the marker the job is never made runnable and remains outcome-unknown/uncertain. |
| Replacement with `sent`, `local_accepted`, `cancel_requested` | PASS by service/integration coverage | Replacement code terminalizes unresolved old-agent rows as outcome-unknown and does not assign them to a new agent; focused cutover tests pass in the Task 12 baseline. |
| Revoked old agent returns | PASS | Runtime receives `revoked`, persists status, stops workers before any transport, and reports zero post-revocation transports. |
| V1 claim races prepare/register | PASS by shared station authority | Both claim and V2 prepare/register lock the same durable station row; protocol mode gates the claim. |
| Helper/browser hang or death | PASS for bounded runtime behavior | Existing platform-helper and artifact-renderer tests pass; request timeout restarts the helper and renderer timeouts close/recycle the browser. |
| Probe during transport | PASS | Status monitor routes through the printer lane and records zero probe calls while a lane is busy. |
| Offline printer then recovery | PASS | Another kitchen lane progresses during a 15-second offline window; live harness drains the recovered kitchen lane in 3,138 ms. |
| Interrupted updater journal phases | PASS by Task 12 focused evidence; physical interruption not rerun in this gate | Installer/update/repair contract tests prove V1/V2/paused journal states and preserve `.env`, identity, and durable jobs. |

## Mixed-load measurements

The required mix was run across three logical printers. Printer 1 was held
offline for 15 seconds while printer 2 continued kitchen work. Both modes
reported 50 unique queue identities, 50 completed outcomes, zero duplicate
transport markers, zero duplicate artifact submissions, and 50 cuts. The
deterministic run's worst pickup-to-transport p95/p99 was 18,000 ms, caused by
the deliberately offline lane's bounded retry schedule; the live run measured
18,168/18,182 ms at p95/p99. The non-offline kitchen lane was not held behind
the report lane. The live run's maximum report pickup-to-transport time was 158
ms, well below the 30-second report cap.

This is a scheduler and protocol acceptance result, not proof that a printer
accepted paper. Helper and Chromium counts are zero in the harness because it
uses a deterministic renderer/transport double; the physical matrix below is
where the real process counts and paper behavior are recorded.

## Physical matrix — BLOCKED, not waived

This host has no controlled printer lab. The following rows remain open and are
required before a customer canary:

1. The affected long-report printer: receipt, kitchen, and 200-row report;
   record artifact hashes, timing, and a customer-free photograph.
2. A Windows USB/shared printer: the same three documents and helper status.
3. A direct TCP printer: bounded write timing and reconnect behavior.
4. A cheap write-only clone: record `unknown` device confidence; do not claim
   paper feedback.
5. One feedback-capable printer with paper-out and cover-open conditions.

Any physical failure is a release blocker. No paper result is inferred from an
HTTP acknowledgement, `bytes_sent`, `os_accepted`, or a write-only status.

## Rollback and canary decision

Task 12's focused installer/update/repair contract evidence remains the rollback
proof: failed prepare leaves V1 untouched; a registered-but-unaccepted V2 agent
can self-rollback; after first V2 acceptance the station remains V2 and paused
until an explicit recovery action. This gate did not run an installer or mutate
an installed station.

Decision: **automated gates pass; canary is not approved yet**. Collect the
physical matrix on a controlled test station, then run the final verification
commands in the plan in one process at a time. Retain V1 for two stable V2
releases after any approved canary; do not merge, push, deploy, migrate
production, or rebuild customer installers from this commit as part of Task 13.
