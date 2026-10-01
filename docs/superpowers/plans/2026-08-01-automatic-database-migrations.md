# Automatic Database Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply approved, versioned POS database migrations automatically during application startup before schema validation and before the HTTP port opens.

**Architecture:** A small manifest declares the exact migration name, ledger checksum, normalized SQL file hash, and required predecessor. A single runner holds a MySQL advisory lock on one pooled connection, verifies the manifest and ledger, executes Hostinger-safe SQL statement-by-statement, verifies that each script recorded its expected ledger row, and releases the lock. `startServer()` runs it before the existing fail-closed schema validator.

**Tech Stack:** Node.js CommonJS, mysql2/promise, MySQL/MariaDB advisory locks, Vitest, existing SQL migrations.

## Global Constraints

- Work on `codex/automatic-db-migrations`; do not merge or push until verification passes.
- Preserve `.codex/`, `POS1.zip`, and `posapp.7z` untracked and untouched.
- Do not scan `information_schema` and invent schema repairs; only manifest-listed migrations may run.
- Do not add a dependency or generic migration framework.
- Do not apply preflight or verifier SQL as migrations.
- Reject `DELIMITER`, `PROCEDURE`, `TRIGGER`, and `DEFINER` in automatic SQL because Hostinger Web/Cloud imports do not support them.
- Do not continue after a failed migration, missing predecessor, checksum conflict, file-hash conflict, lock timeout, or missing ledger confirmation.
- Keep the existing `validateRequiredSchema()` call as the final authority before `server.listen()`.
- Automatic coverage starts at the exact `2026-07-29-subscription-receivables-v1` floor and applies every schema migration dated July 31 through August 1 in ledger order.

---

### Task 1: Manifest and fail-closed runner

**Files:**

- Create: `backend/migrations/auto-manifest.json`
- Create: `backend/migrations/2026-07-31-platform-held-order-settlement.auto.sql`
- Create: `backend/migrations/2026-07-31-tax-exempt-checks.auto.sql`
- Create: `backend/migrations/runPendingMigrations.js`
- Create: `backend/tests/unit/automaticMigrations.test.js`
- Create: `backend/tests/integration/automaticMigrations.test.js`

**Interfaces:**

- `splitMysqlScript(sql: string): string[]` for multiline, semicolon-terminated Hostinger-safe statements
- `runPendingMigrations(pool, options?): Promise<{ applied: string[], skipped: string[] }>`
- `options.manifestPath` exists only to inject a fixture manifest in tests.

- [ ] Write unit tests first for multiline statement parsing, forbidden-routine rejection, cross-platform file-hash enforcement, already-applied checksum validation, missing predecessor rejection, lock timeout, post-execution ledger verification, SQL-body redaction, and lock release on failure.
- [ ] Run `npx vitest run backend/tests/unit/automaticMigrations.test.js` and observe failure because the runner does not exist.
- [ ] Add a manifest containing platform-held settlement then tax-exempt checks, with exact predecessor, ledger checksums, and SHA-256 hashes for both shipped SQL files.
- [ ] Implement the smallest runner that validates the manifest, takes `GET_LOCK('posapp_schema_migrations', 60)`, processes entries serially, verifies target/predecessor ledger rows, executes parsed SQL statements, verifies the target ledger row afterward, and always calls `RELEASE_LOCK` before releasing the connection.
- [ ] Run the unit test to green.
- [ ] Write an integration test that recreates the exact July 29 schema floor, runs both real shipped SQL files, and verifies the platform column/payment enum plus tax-exempt columns, permission, and both ledger checksums. Drop the isolated scratch database during cleanup.
- [ ] Run `npx vitest run backend/tests/unit/automaticMigrations.test.js backend/tests/integration/automaticMigrations.test.js` to green.

---

### Task 2: Startup ownership and documentation

**Files:**

- Modify: `server.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`
- Modify: `docs/architecture.json`
- Generate: `docs/architecture.html`

**Interfaces:**

- `startServer()` must call `runPendingMigrations(db)` before `validateRequiredSchema(db)` and both before `server.listen()`.

- [ ] Add a failing source-boundary assertion proving migration, validation, and listen order.
- [ ] Run `npx vitest run backend/tests/unit/schemaAuthority.test.js` and observe the intended failure.
- [ ] Import and await `runPendingMigrations(db)` in `startServer()` before schema validation. Update the startup fatal log to cover migration or validation failure without exposing credentials.
- [ ] Run focused unit and integration migration tests to green.
- [ ] Update architecture JSON with the manifest/runner ownership, advisory-lock behavior, and startup order; generate HTML with `npm run architecture` and verify with `npm run architecture:check`.

---

### Task 3: Hostile verification, merge, and release

- [ ] Verify the current configured database produces a no-op result and still passes `validateRequiredSchema()`.
- [ ] Run `npx vitest run backend/tests/unit/automaticMigrations.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/installerBaseline.test.js`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` and inspect every changed path.
- [ ] Hostile-review concurrent startups, partial DDL, malformed manifests, path traversal, duplicate names, checksum changes, missing privileges, missing baseline, and SQL files that omit their ledger insert. Fix only reproduced in-scope defects with another red-green cycle.
- [ ] Commit the feature, fast-forward it into `master`, delete the feature branch, and push `master` to the explicitly approved `https://github.com/xyzbk/posappv4.git` only after all checks pass.

## Acceptance Checklist

- [ ] A database already at tax-exempt v1 is not modified.
- [ ] A database at the exact July 29 subscription-receivables floor receives both July 31 migrations automatically.
- [ ] A database older than the July 29 floor or with unknown checksums is rejected with an actionable baseline error.
- [ ] Concurrent startups cannot run the same migration twice.
- [ ] Changed SQL or ledger checksums fail closed.
- [ ] Failed/partial execution never advances to schema validation or HTTP listen.
- [ ] Fresh installer databases remain a no-op because their latest ledger already exists.
- [ ] No secrets or SQL bodies are printed in startup logs.
