# Spooler V2 commit-aware long-poll validation

Date: 2026-08-28
Branch: `codex/spooler-v2-commit-aware-long-poll`
Production-code fixed point tested: `4816e427382471717eddb3fe7a051243a9da613e`
Test host: Windows x64, Node `v24.16.0`, MariaDB test database

## Outcome

The local one-process server/protocol gate passed. The implementation remains Spooler V2 and keeps `POST /api/spooler/v2/sync` as the only claim, acceptance, cancellation, and settlement authority. The new in-process signal carries no job payload and only releases an opted-in idle HTTP sync; every wake is followed by an authoritative database sync.

This is not customer-rollout approval. The target Hostinger worker count and the required 100-cycle HTTPS staging soak were not inspected because this task did not authorize deployment or Hostinger access. Physical printer, Chrome, Windows helper, TCP printer, paper-feedback, and cash-drawer behavior were not changed or re-approved here.

## Commands and results

```powershell
npx vitest run backend/tests/unit/spoolerSyncWake.test.js backend/tests/unit/spoolerLongPollOrchestration.test.js backend/tests/unit/spoolerSyncCadence.test.js backend/tests/unit/spoolerV2OnlyContract.test.js backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/spoolerWakeCommitBoundaries.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printQueueCancellation.test.js backend/tests/integration/printReprint.test.js backend/tests/integration/socketRoleIsolation.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js
```

Result: 15 files, 210 tests passed.

```powershell
npm --prefix pos-spooler-printer test
```

Result: all spooler unit/integration scripts passed, including the hostile-runtime matrix. Its physical matrix remains explicitly unrun.

```powershell
node backend/tests/manual/spoolerV2LongPollHarness.js --live
```

Result: passed against the real Express route and disposable `_test` MySQL database.

```powershell
node backend/tests/manual/spoolerV2MixedJobsHarness.js --live
```

Result: 50/50 jobs completed: 20 kitchen, 20 receipt, 10 reports; zero duplicate transport markers, zero duplicate artifact submissions, and 50 cuts.

```powershell
npm run architecture
npm run architecture:check
git diff --check
```

Result: architecture valid at 219 nodes, 60 flows, 445 steps. The generator repeated 27 existing orphan-node warnings; none was introduced by the new wake node, which is connected to the V2 delivery and receipt flows. Whitespace check passed.

## Measured long-poll results

| Probe | Result | Bound |
|---|---:|---:|
| Old 500 ms short-poll baseline, five agents | 9.591 sync transactions/sec | measured baseline |
| One idle agent, 20 cycles | 0.494 requests/sec/agent | <= 0.6 |
| Five idle agents, 20 cycles each | 0.492 requests/sec/agent | <= 0.6 |
| One-agent accepted TCP connections during 20 cycles | 1 | <= 2 |
| DB leases while five HTTP responses were held | 0 | 0 |
| Pool enqueue increase caused by held requests | 0 | 0 |
| Idle reduction versus measured baseline | 74.4% | positive gain |
| Committed wake response, 20 cycles | 12.3 ms p95 / 12.4 ms max | < 500 ms |
| Missed-publish recovery | 2018 ms | <= 2250 ms |
| Committed job to durable local journal, 20 jobs | 21.0 ms p95 / 27.9 ms max | < 500 ms |
| Committed job to simulated transport start, 20 jobs | 18.6 ms p95 / 25.3 ms max | < 1000 ms |
| Rapid payload-free flood | 50 publishes, 5 responses, 0 remaining waiters | bounded |
| Same-agent storm | 81 successful HTTP responses, 1 throttled | `SYNC_MAX + 1` |
| Storm peak pool usage | 25 in use, 134 enqueues, 0 leaked at end | recorded trade-off |
| Shutdown | 0 remaining waiters | 0 |

The rate storm deliberately demonstrates the hostile cost rather than claiming it does not exist. It reached the configured pool concurrency, queued excess acquisitions, returned the existing successful `throttled: true` response for the policy-crossing request, and released every acquisition (`1769 acquired / 1769 released`, `inUse: 0` at the end of the complete strengthened run).

## Five-agent committed-event workloads

Each row used fresh idle agents and a real committed audit row before each process-local publish. First- and second-pass `runAgentSync` calls were counted by wrapping the actual service export before loading the real router. The producer starts 731 ms out of phase with the 1500 + 500 ms timeout cadence, so the 0.5-event case cannot pass merely through timer alignment.

| Committed events/sec | Published | HTTP requests | First syncs | Second syncs | Total sync transactions/sec |
|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 25 | 25 | 0 | 2.459 |
| 0.5 | 5 | 30 | 30 | 25 | 5.098 |
| 1 | 10 | 50 | 50 | 50 | 9.292 |
| 2 | 19 | 51 | 51 | 50 | 8.845 |

Against the measured 9.591-transaction/sec short-poll baseline, idle traffic fell 74.4% and the phase-shifted 0.5-event workload fell 46.8%. The 1-event workload remained 3.1% below baseline on this host. The 2-event result includes coalescing and must remain a busy-load trade-off rather than a guaranteed saving. A separate 4-publishes/sec, 10-second stress window produced 70 first and 70 second sync transactions; high commit rates can therefore cost more database work than the old idle baseline.

## Exactly-once and ownership evidence

- The full shipped sync client, runtime, journal, printer worker, synthetic renderer, and synthetic transport were composed around 20 sequential real server jobs.
- The local store accepted 20 queue identities, wrote one transport marker per identity, started transport exactly 20 times, created terminal results, and the server settled every row. All 20 local records ended `completed`, with zero pending acceptance or result outbox rows.
- A global wake released all five stations, but the second database sync returned the targeted job only to its printer's station.
- A direct insert with publication omitted was absent from the held response and was claimed by the next authenticated cadence request in 2030 ms.
- Fifty mixed kitchen/receipt/report jobs kept station ownership and serial lanes, while another printer progressed during the simulated offline-printer window.
- Cancellation wakes only for `cancel_requested`; pending-to-`canceled` does not wake an agent. The browser event is emitted to the `staff` room, not globally.
- Drain, forced replacement, and audited reprint publish only after their owning transaction commits. The woken agent observes `draining` or `revoked` through the unchanged sync response.
- Generic `enqueuePrintJobs(transactionConnection, ...)` remains notification-free. Autocommit callers use the named wrapper; transaction callers publish only after their own commit.

## Compatibility matrix exercised

| Client/server case | Evidence |
|---|---|
| Existing V2 client omits `wait_ms` | immediate response integration test |
| Updated V2 client sends `wait_ms: 1500` | real 20-cycle and runtime composition runs |
| Protocol identity | remains `protocol_version: 2`; no `/v3`, V3 folder, EventSource, WebSocket, or agent Socket.IO path |
| Invalid/negative wait | clamped to immediate response |
| Oversized wait | server clamps to 1500 ms inside a 9-second response budget and 10-second client deadline |
| Same-agent overlap | old waiter is superseded; no connection registry or already-connected rejection |
| Abort/shutdown | held fetch aborts and all waiters/listeners clear |
| Signal loss / cross-process signal absence | durable database reconciliation on the next bounded sync |
| Runtime dependencies/schema/config | no package, schema, migration, environment, installer, or protocol transition |

## Invalid experimental runs discarded

Two harness iterations were rejected before the final measurements:

1. The harness used a payload-free publish to stop a zero-event workload and then counted the resulting five second passes. The stop signal was removed from the measurement path.
2. The workload reused agents that intentionally retained unaccepted targeted/missed-signal jobs. Their immediate replay behavior was correct but not idle. The workload matrix was moved to five fresh agents.
3. The shutdown probe initially reused those same busy agents. It was moved to the clean idle group so the probe actually exercised held-response shutdown.
4. The original 0.5-event workload started its two-second producer on the same phase as the 1500 ms hold plus 500 ms recovery delay. Its zero second-pass count proved valid coalescing but was weak evidence for wake behavior. The strengthened harness shifts the producer by 731 ms and separately measures 20 commit-to-response wake cycles.

No production assertion or threshold was weakened to make these runs pass.

## Test-strength mutation checks

Three essential behaviors were deliberately broken one at a time, the focused test was run and required to fail, and production code was then restored byte-for-byte to `HEAD`:

1. Capturing the generation after the first sync failed `captures generation before the first sync and closes the lost-wakeup race` because the expected second authoritative sync disappeared.
2. Re-ingesting the first health snapshot during the second sync failed the orchestration assertion requiring `health: null`.
3. Suppressing publication after a committed autocommit enqueue failed both generation/publication assertions in `spoolerWakeCommitBoundaries.test.js`.

After restoration, `git diff --exit-code HEAD -- backend/routes/spoolerV2.js backend/services/printDispatch.js` passed. These mutation runs are negative evidence; their expected failures are not suite failures in the final branch state.

## Release gates still open

- Inspect the actual target PM2/Node worker count. Supported rollout topology for this phase is one process. With `N` workers, one compromised agent identity can hold up to `N` waiters and the per-process request ceiling multiplies to `N × SYNC_MAX`.
- Run an owner-approved staging soak through the real Hostinger HTTPS domain for at least 100 held cycles plus one committed test job. Record proxy early closes, auth/station responses, reconnect/backoff behavior, client-observed connection reuse, and exactly-once local acceptance.
- Keep the established physical-printer gates separate. These tests used a synthetic renderer/transport and do not prove paper completion latency.

No deployment, Hostinger mutation, installer build, version bump, migration, merge, or push was performed.
