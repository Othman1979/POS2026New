# Receipt template builder release evidence

## Automated evidence

- Application branch: `codex/receipt-template-builder`.
- Spooler renderer and artifact validation are covered by the tracked spooler tests.
- Template engine covers structural roles, trusted money bindings, JoFotara QR, positioned once bands, overlap warnings, and optional-logo omission.
- Compiler covers trusted enqueue ownership and store-logo path/name, realpath, magic-byte, and size controls.

### Automated release gate (2026-07-26)

- `npm run test:unit -- --silent`: 199 files and 2,073 tests passed.
- `npx playwright test tests/e2e/specs/admin.print-templates.spec.js --project=admin-tests`: 5 passed.
- `npm run build`: passed.
- `node scripts/validate-schema-drift.js`: zero drift after the test fixture reset.
- `backend/migrations/2026-07-25-print-templates-verify.sql` against local `posapp`: zero migration blockers.
- `node pos-spooler-printer/tests/run-tests.js`: passed with the local Chrome executable.

These checks prove the application, compiler, queue contract, and simulated spooler path. They do not substitute for the physical-paper evidence below.

## Deployment evidence — required before release

| Item | Result |
|---|---|
| Migration verifier has zero blockers | Passed against local `posapp` on 2026-07-26 |
| Spooler `1.2.0` at every receipt/kitchen station | Pending operator run |
| Built-in receipt and kitchen printed at every station | Pending physical proof |
| Custom receipt/kitchen test jobs acknowledged and paper-confirmed | Pending physical proof |
| Accepted JoFotara QR scanned from printed paper | Pending physical proof |
| Positioned header, Arabic long list, logo, missing-logo fallback, rollback | Pending physical proof |
| Excluded hardcoded report smoke test | Pending physical proof |

## Mixed-version decision

- New spooler + old backend: legacy output may print.
- Old spooler + new backend: legacy/v1 non-QR output may print, but accepted JoFotara receipt use is **NO-GO**.
- New spooler + new backend: compiled receipt/kitchen artifacts print; reports remain hardcoded.

## Load capture template

Run 100 receipt and 100 kitchen fixture jobs without physical device writes. Record compile p50/p95, maximum serialized payload, database query count, and memory growth below. The targets are p95 under 250 ms and payloads under 768 KB; a miss is a finding, not a reason to loosen limits.

| Run date | p50 | p95 | Max payload | DB queries | Memory growth | Finding |
|---|---:|---:|---:|---:|---:|---|
| 2026-07-26 | 1.39 ms | 2.54 ms | 5,536 bytes | 500 (2.5/job) | 13,451,464 bytes | Passed: 100 receipt + 100 kitchen jobs persisted; p95 and payload size are below the release targets. |

The capture used `enqueuePrintJobs()` against `posapp_test` with two active fixture printers. It includes receipt/kitchen model compilation, template resolution, hashing, and the actual `print_queue` insert, but intentionally does not claim or send any job to a device.

### Compiler baseline (2026-07-26)

This is a non-device, direct compiler baseline—not the required durable-enqueue load proof above. It compiled 100 built-in receipt fixtures and 100 built-in kitchen fixtures in one process:

| Jobs | p50 | p95 | Max artifact | DB queries | Heap growth |
|---:|---:|---:|---:|---:|---:|
| 200 | 0.12 ms | 0.33 ms | 4,723 bytes | 0 | 1,841,144 bytes |

It is comfortably below the 250 ms / 768 KB targets, but the durable-queue run remains required because it includes payload preparation, database resolution, hashing, and queue persistence.

## Test-database recovery (2026-07-26)

`posapp_test` was found in a partial reset state and initially failed schema drift verification. The repository’s existing test-only seed harness was rerun with a query-boundary trace: it created `print_templates` as expected, completed the reset, and the schema-drift validator then reported zero drift. No production database or application schema was changed.
