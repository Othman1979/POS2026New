# Spooler V2 audit remediation — rev 3 evidence

Date: 2026-08-18  
Branch: `codex/spooler-v2-local-print-agent-continued`  
Scope: execution and adversarial re-audit of `2026-08-18-spooler-v2-audit-remediation.md`

## Verdict

The remediation is closed at the source-code and automated-test level. The final adversarial pass found no remaining defect in the audited runtime/journal, transport/helper, server ownership, migration-authority, or installer-recovery boundaries.

This is not approval for a customer canary. The physical printer and interrupted-Windows-operation gates listed below remain open and must be completed before rollout.

## Remediation commits

| Commit | Result |
| --- | --- |
| `44eed546` | Terminal journal states cannot transition back to printable work. |
| `d0b6b491` | V1 claimers cannot take agent-owned V2 rows. |
| `6fcac46c` | The printing Node process owns the state-root lock and helper fatals reach shutdown. |
| `e8c570f4` | Printer lanes resume after exclusive status probes. |
| `723304ae` | Failed cutover restores the prior service entry point and retains recovery state. |
| `d43165ee` | V1 work is drain-checked before reactivation; revoked agents cannot rewrite station state. |
| `084db483` | Invalid jobs are isolated, registration is re-armed, and sync hints are bounded. |
| `eae67e0e` | Partial Winspool jobs abort, helper restart failures remain safe, and wedged renders are killed. |
| `add85d10` | Unverified status is no longer described as device-confirmed. |
| `4a382fc6` | Journal retention, quarantine visibility, retry barriers, and deadlines are bounded. |
| `b574fea2` | Migration predecessor and V2 renderer tests target the current implementation. |
| `8d30016e` | The August 17 migration is the sole 7-to-9 print-status enum authority. |
| `084fcb20` | Cleanup failure no longer stops sync; diagnostics survive end to end; installer and helper recovery were hardened. |
| `8a80ef66` | Final re-audit races are closed: archived artifact retention, pre-marker helper serialization, failed-watch recovery, and authoritative installer ownership recovery. |

## Final adversarial findings and closures

The first rev 3 pass attacked the fixes rather than trusting their commit messages. It found four moved or previously uncovered boundaries:

1. A cleanup exception could suppress every later sync. The runtime now records `JOURNAL_CLEANUP_FAILED` and continues syncing.
2. Multiple serial-helper requests could receive durable transport markers before Winspool began them. Windows send, probe, watch, and automatic re-watch now share one helper-exclusive queue; only the operation entering the helper can be marked.
3. A rollback or abort could commit while its response was lost. Installer recovery now queries authoritative station protocol. It restores V1 for `v1`, preserves and verifies V2 for `v2`, and stops plus disables the service when authority cannot be established.
4. Cancellation confirmation could archive a record while rendering was still finishing. Failed immediate artifact deletion now persists cleanup metadata on active or archived terminal records without changing their terminal result.

The second pass then attacked those corrections:

- A failed automatic `watch_printers` replay could restart forever and starve printing. Failed watch payloads are now cleared precisely; a newer registration cannot be erased by an older failure.
- Ambiguous installer recovery originally stopped only the current process. The service is now set to `Disabled` before the explicit repair failure, so reboot cannot reactivate an unproved entry point.

Final reviewer results:

- Runtime/journal: canceled state preserved, artifact retained across reopen, zero transports, no unhandled rejection.
- Transport/helper: two concurrent Windows prints produce at most one marker; a hung status/watch cannot mark queued prints; a failed watch restarts once and later printing proceeds.
- Installer/server: response-loss paths converge on authoritative `v1` or `v2`; unknown authority remains stopped and disabled across reboot.

## Verification evidence

The plan's Task 13 gates completed before the final re-audit:

- Focused backend gate: 128/128 passed.
- Full spooler package: passed.
- Application build: passed.
- Architecture check: passed.
- Full repository Vitest run, exactly once: 276/276 files and 2,980/2,980 tests passed in 1,124.21 seconds. The previously recorded seven failures were closed.

After the re-audit corrections:

- `node pos-spooler-printer/tests/v2-platform-helper.test.js`: passed.
- `node pos-spooler-printer/tests/v2-printer-transports.test.js`: passed.
- `node pos-spooler-printer/tests/v2-printer-workers.test.js`: passed.
- `node pos-spooler-printer/tests/v2-job-store.test.js`: passed.
- `npx vitest run backend/tests/unit/installerUpdateContract.test.js`: 36/36 passed.
- PowerShell parser check for `deployment/windows/Install-Spooler.ps1`: passed.
- `npm --prefix pos-spooler-printer test`: passed after the final transport/runtime corrections.
- `npm run architecture:check`: passed with 217 nodes, 59 flows, 446 steps, and all referenced files present.
- `git diff --check`: clean apart from Git's expected CRLF conversion notices.

## Open physical gates

These require controlled hardware or real interrupted Windows operations and were not fabricated from automated evidence:

- affected long-report printer, including the previously reported raster-corruption model;
- Windows shared-printer path;
- direct TCP printer path;
- write-only printer clone;
- paper-out and recovery behavior on the target model;
- LocalMachine DPAPI identity proof across two different machines;
- disk-full injection at every durable journal transition;
- real interrupted fresh install and updater rollback/recovery runs.

Until those gates pass, the correct state is: code-complete and automated-gate clean, but not customer-canary approved.

No branch merge, push, deployment, production migration, or station cutover was performed.
