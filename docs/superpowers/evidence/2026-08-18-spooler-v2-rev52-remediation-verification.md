# Spooler V2 Rev 5.2 remediation verification

Date: 2026-08-18
Branch: `codex/spooler-v2-local-print-agent-continued`
HEAD before Task 4 commit: `b1039d6c` (`fix(spooler-v2): isolate Windows printer lanes`)
Method: execute `docs/superpowers/plans/2026-08-18-spooler-v2-rev52-remediation.md` Tasks 1–4 on the existing working tree. No reset, clean, checkout, merge, push, deploy, installer build, or canary.

This file records automated evidence only. It does not approve a customer canary.

## Commits

| Task | Subject | Hash |
|---|---|---|
| 1 | `fix(spooler-v2): make state-root recovery self-healing` | `6e22948d` |
| 2 | `fix(spooler-v2): finish owned work during drain` | `389eab3a` |
| 3 | `fix(spooler-v2): isolate Windows printer lanes` | `b1039d6c` |
| 4 | `fix(spooler-v2): align health and release evidence` | `9eee0d2e` |

## Commands and totals

| Command | Result |
|---|---|
| `node pos-spooler-printer/tests/v2-state-root-lock.test.js` | pass |
| `1..25 \| ForEach-Object { node pos-spooler-printer/tests/v2-hostile-runtime.test.js }` | 25/25 pass |
| `npx vitest run backend/tests/integration/spoolerV2Sync.test.js --reporter=dot` | 26/26 pass |
| `node pos-spooler-printer/tests/v2-printer-workers.test.js` | pass |
| `node pos-spooler-printer/tests/v2-sync-runtime.test.js` | pass |
| `node pos-spooler-printer/tests/v2-job-store.test.js` | pass |
| `node pos-spooler-printer/tests/v2-platform-helper.test.js` | pass |
| `node pos-spooler-printer/tests/v2-printer-transports.test.js` | pass |
| `$csc /nologo /optimize+ /target:exe /out:%TEMP%\PosSpoolerPlatform.rev52.exe ... PosSpoolerPlatform.cs` | compile succeeded |
| `node pos-spooler-printer/tests/external-config.test.js` | pass |
| `npx vitest run backend/tests/integration/spoolerV2Health.test.js --reporter=verbose` | 11/11 pass |
| `npm --prefix pos-spooler-printer test` | pass (all tracked `tests/*.test.js`, including 12/12 hostile rows) |
| `npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Health.test.js backend/tests/integration/spoolerV2Compatibility.test.js --reporter=dot` | 3 files, 39/39 pass |
| `npm run architecture` | wrote `docs/architecture.html` — 217 nodes, 59 flows, 446 steps |
| `npm run architecture:check` | OK — 217 nodes, 59 flows, 446 steps, 157 distinct files |
| `npm run test:unit` | Not rerun after the residual health-race corrections; the user requested focused tests only. The earlier 2998/2998 result is historical evidence from `9eee0d2e`, not proof for the current tree. |
| `git diff --check 9eee0d2e...HEAD` | pass (CRLF warnings only) |

Current evidence is limited to the focused suites recorded above. No current-tree full-suite claim is made.

## Hostile-harness changed outcomes

Re-run after Task 4:

```
node pos-spooler-printer/tests/v2-state-root-lock.test.js
node pos-spooler-printer/tests/v2-printer-workers.test.js
node pos-spooler-printer/tests/v2-sync-runtime.test.js
node pos-spooler-printer/tests/v2-hostile-runtime.test.js
```

Required changed outcomes, now observed:

| Case | Before Rev 5.2 remediation | After |
|---|---|---|
| empty/corrupt `agent.lock` | authorized start stayed `STATE_ROOT_LOCKED` forever | current start quarantines (`corrupt_lock_quarantined`) and fails; next start acquires |
| corrupt stale tombstone | three authorized starts stayed locked; file remained | current start quarantines (`corrupt_tombstone_quarantined`) and fails; next authorized restart recovers |
| retry `stop()` / `start()` | send count stayed 1 | send count increases after retry time |
| throttled sync | urgent path ignored `next_sync_ms` | no second request before `next_sync_ms` |
| concurrent authorized reclaim | at most one owner | still at most one owner (25 hostile repeats + four-contender quarantine boundary) |

Hostile rows are now labeled `source_scan`, `fake_clock_probe`, `real_journal`, `real_child_process`, or `in_process_workers`. Idle-agent measurements no longer report `db_peak_connections: 0` as a database load result. The JSON matrix is not physical evidence.

## Remaining physical gates

Automated tests cannot approve a customer canary. Still open:

- USB / shared Windows / direct TCP printers
- write-only clone / print-server boxes
- paper-out / offline / long-report recovery
- DPAPI / disk-full / interrupted Windows install or update
- leftover helper mutex after a hard Node kill
- `linkSync` on FAT32/exFAT/SMB state directories

Until that matrix is run on the affected hardware, the branch remains **not approved for a customer canary**.
