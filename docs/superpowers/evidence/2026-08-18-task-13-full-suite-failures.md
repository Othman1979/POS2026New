# Task 13 full-suite failure report

**Date:** 2026-08-18
**Branch:** `codex/spooler-v2-local-print-agent-continued`
**Task 13 commit:** `332288b8e6bad6a3fab38b1dea3c75c9517863c7`
**Command:** `npx vitest run`

## Result

The full repository run completed in 1,136.50 seconds:

- 273 of 276 test files passed.
- 2,968 of 2,975 tests passed.
- 7 tests failed across 3 files.

These failures are **pre-existing relative to Task 13**: Task 13 changed only
the hostile-runtime test, mixed-load harness, release evidence, printing
runbook, and generated architecture files. None of the failing tests or their
production modules were changed by Task 13.

That scope statement does not prove every underlying cause. Confirmed symptoms
and diagnosis confidence are separated below so an unverified explanation is
not treated as fact.

## Failure 1 — tax-exempt cross-module workflow

**File:** `backend/tests/integration/taxExemptWorkflow.test.js:132`

**Failing test:** `keeps exempt money identical through checkout, report, reprint, refund, and JoFotara`

**Observed assertion:**

```text
expected 0 to be close to 22.17
```

Checkout and its audit assertions had already succeeded. The later daily-report
request returned HTTP 200, but `report.body.summary.sales_processed` was `0`
instead of the expected tax-exempt sale total `22.17`.

**Status:** real failure symptom; root cause not confirmed by the full-suite
run. It must be rerun alone before deciding whether this is fixture state,
date/time selection, test pollution, or report logic.

**Focused command:**

```powershell
npx vitest run backend/tests/integration/taxExemptWorkflow.test.js
```

## Failures 2–3 — WebAuthn migration fixture

**File:** `backend/tests/integration/webauthnSchemaMigration.test.js`

### Failure 2

**Line:** `75`

**Failing test:** `migrates the legacy session and preserves business rows`

The test expected:

```text
applied: [2026-08-13-webauthn-registered-device-access-v1]
```

The migration runner instead returned `applied: []` and listed that migration
under `skipped`.

### Failure 3

**Line:** `108`

**Failing test:** `rejects an incompatible partial target before changing the predecessor`

The test created an incompatible partial `auth_sessions` table and expected the
migration preflight to reject. The runner resolved successfully and skipped the
migration because its ledger treated it as already applied.

**Status:** both symptoms are confirmed. They are consistent with migration
ledger/setup state leaking into the fixture, but that cause remains a
hypothesis until the file is rerun alone and its database lifecycle is traced.

**Focused command:**

```powershell
npx vitest run backend/tests/integration/webauthnSchemaMigration.test.js
```

## Failures 4–7 — stale legacy spooler source assertions

**File:** `backend/tests/unit/spoolerReceiptDisplay.test.js`

The four failing tests are:

1. Line 11 — `wires the deployable renderer into physical receipt rows and totals`
2. Line 41 — `renders untrusted HTML with JavaScript, network, and explicit no-sandbox flags disabled`
3. Line 50 — `keeps compiled receipt and kitchen documents behind the standalone spooler validator`
4. Line 119 — `prints receivable collections separately from shift sales tenders`

These tests inspect `pos-spooler-printer/server.js` as text and expect the old
V1 implementation to remain directly inside that file, including
`require('./renderDocument')`, browser-page hardening calls, compiled-document
selection, and receivable-report labels.

The behavior was moved into the V2 renderer rather than removed:

- `pos-spooler-printer/server.js` imports `createArtifactRenderer` from
  `v2/artifact-renderer`.
- `pos-spooler-printer/v2/artifact-renderer.js:7` imports the standalone
  document renderers and compiled-document resolver.
- `artifact-renderer.js:57` selects the compiled document.
- `artifact-renderer.js:439-442` disables JavaScript, aborts network requests,
  and uses `domcontentloaded`.
- `artifact-renderer.js:124,218,243` renders the receivable collection values.

**Status:** confirmed stale source-location assertions. The expected security
and reporting behavior still exists, but the tests look in the former module.
They should assert the current renderer boundary or, preferably, observable
rendered output rather than the old file layout.

**Focused command:**

```powershell
npx vitest run backend/tests/unit/spoolerReceiptDisplay.test.js
```

## Priority and next action

1. Rerun the tax-exempt and WebAuthn files independently before changing code.
2. Update the four spooler tests to validate the current V2 renderer boundary;
   do not copy old strings back into `server.js` merely to satisfy them.
3. Run the three focused files together, then the full suite once after the
   causes are closed.

No fix was made as part of this report.
