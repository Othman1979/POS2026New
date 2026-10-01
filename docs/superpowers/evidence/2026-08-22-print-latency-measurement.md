# Print latency reduction — Task 6 evidence

Date: 2026-08-22
Branch: `codex/print-latency-task1`
Spooler package version: `1.2.8`

## Scope and fixed point

This record covers the completed Task 1–5 chain through `2bec2fe5`:

- `30ef9678` — single-flight, backoff-aware, progress-bounded sync scheduling
- `648ca1c9` / `c0fd3d8d` — probe and store-retry cadence separation, including post-marker safety
- `e052d8eb` / `968c50ab` — artifact-size evidence through journal and sync
- `98bd3cbc` / `e79f3393` — prompt result-ready settlement and production-composition proof
- `2bec2fe5` — 500 ms active cadence, 5 s inactive cadence, and matching limiter headroom

No installer was built, no server was deployed, no venue environment was changed, and no customer printer was used during this task.

## Automated gates

| Gate | Result |
| --- | --- |
| Four focused backend files | PASS — 4 files, 51 tests |
| Production build | PASS — Vite built 302 modules |
| `npm run test:unit` (run exactly once) | PASS — schema drift zero; 272 files, 3,000 tests |
| Spooler runner | PASS — 24 test files |
| Architecture generation/check | PASS — 212 nodes, 56 flows, 425 steps, 2 documented defects, 152 files |

The full unit run emitted expected error logs from negative-path fixtures; its final result was green. The physical hostile-runtime matrix remained explicitly skipped because no controlled printer lab was attached.

## Supported-pool cadence experiment

The pre-existing load harness was stale: it slept for 2,000 ms and discarded the response body, so it could neither exercise 500 ms cadence nor detect throttling. It was minimally corrected to accept a cadence, force the supported pool limit of 10, count `throttled` responses, sample `/health`, and fail on DB acquisition queuing or unreleased connections.

Command:

```text
node backend/tests/manual/spoolerV2LoadHarness.js 5 60 500
```

The harness refuses to seed unless `DB_NAME` ends in `_test`; the run used that disposable database.

| Measurement | Result |
| --- | ---: |
| Agents / duration / cadence | 5 / 60 s / 500 ms |
| Sync requests | 583 |
| Sync rate | 9.64/s |
| Sync latency P50 / P95 / P99 | 4 / 8 / 11 ms |
| Throttled responses | 0 |
| `/health` requests | 118 |
| `/health` latency P50 / P95 | 2 / 5 ms |
| Pool created / peak in use | 1 / 2 |
| Pool acquired / released | 1,288 / 1,288 |
| Pool enqueued / errors / active at end | 0 / 0 / 0 |
| Event-loop delay mean / P95 / max | 29.87 / 31.39 / 32.75 ms |

Result: PASS. The supported pool had headroom, ordinary health traffic stayed responsive, and connection-acquisition pressure did not grow.

## Mixed-job experiment

Command:

```text
node backend/tests/manual/spoolerV2MixedJobsHarness.js
```

Result: PASS in deterministic-local mode.

- 50/50 jobs accounted for and completed: 20 kitchen, 20 receipt, 10 daily report.
- Duplicate transport markers: 0.
- Duplicate artifact submissions: 0.
- Cuts: 50.
- Another printer continued while one printer was offline.
- Recovered kitchen delay: 3,000 ms, under the 5,000 ms cap.
- Report maximum delay: 0 ms, under the 30,000 ms cap.

Scope limit: this harness uses its own deterministic timing and does not drive `createAgentRuntime`; the changed wake, backoff, and probe paths are covered by the focused runtime tests instead.

## Physical latency acceptance — not run

The plan requires a real updated agent and connected physical printer for 20 warm samples, one cold sample, and one shared-printer contention sample. That hardware was not available in this workspace, so the following values are intentionally not claimed:

| Required measurement | Status |
| --- | --- |
| Enqueue → `sent`, warm P50/P95 | NOT RUN — physical canary required |
| `sent` → `local_accepted`, warm P50/P95 | NOT RUN — physical canary required |
| `local_accepted` → `acknowledged`, warm P50/P95 | NOT RUN — physical canary required |
| `duration_ms`, `artifact_bytes`, and `confidence` for those rows | NOT RUN — physical canary required |
| First print after agent restart | NOT RUN — physical canary required |
| Receipt contending with a kitchen ticket on one Windows printer | NOT RUN — physical canary required |
| Receipt and kitchen ticket visibly correct on paper | NOT RUN — physical canary required |

Automated readiness is green. The product latency target and physical-print correctness remain a rollout gate, not a result of this local run.

## Rollout gate

Rollout was not authorized or executed. The safe order remains: build and attest the spooler updater; deploy the server while retaining a 2,000 ms cadence; update and physically verify one till; update the remaining tills; only then set 500 ms and watch for throttling. Reversing that order would accelerate probing and retry behavior on older agents.
