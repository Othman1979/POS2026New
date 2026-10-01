# Programmer Maintenance Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed one hidden programmer identity per fresh installation, let that identity log in without registered-browser binding, and remove the device-recovery feature completely.

**Architecture:** Reuse the existing PIN login and programmer authority. Generate one random eight-digit `user_number` during a fresh installer run, pass it only to database bootstrap, display it once in the protected installer result, and never write it to environment or installation metadata. Recovery schema remains as immutable migration history, but every runtime and UI recovery surface is removed.

**Tech Stack:** Node.js, Express, MySQL/MariaDB, Vue 3, PowerShell/Inno Setup, Vitest.

## Global Constraints

- Work only on `codex/webauthn-device-access`; do not merge, push, deploy, or mutate production.
- `programmer` remains unassignable through admin user APIs and omitted from user/device lists.
- Only `programmer` bypasses registered-browser enforcement; all other active roles retain current binding rules.
- The programmer number is exactly eight decimal digits, generated with `crypto.randomInt`, unique from seeded `009384`, and unique per fresh installation.
- Repair/update paths never rotate or reveal an existing programmer number.
- No new dependency, password column, environment secret, schema migration, or schema-history rewrite.
- Recovery routes must return 404 because the routes no longer exist; merely hiding links is insufficient.
- Existing session expiry, one-session replacement, cookie-only authentication, rate limiting, cache eviction, and Socket.IO disconnection remain intact.

---

### Task 1: Fresh-install programmer seed

**Files:**
- Modify: `deployment/tools/installer-config.js`
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `deployment/tools/verify-install.js`
- Modify: `deployment/windows/Install-PosServer.ps1`
- Test: `backend/tests/unit/installerConfig.test.js`
- Test: `backend/tests/integration/installerBaseline.test.js`

**Interfaces:**
- Produces: `generateNumericCode(digits = 8): string` and bootstrap options `programmerUserNumber`, `programmerName`.
- Consumes: existing protected temporary installer JSON and one-time result dialog.

- [ ] Add failing tests proving numeric generation is eight digits, bootstrap inserts exactly one admin and one programmer, the values differ, verification requires one active programmer, and the installer result exposes the programmer number only for a fresh install.
- [ ] Run the two focused installer test files and confirm failure because generation/seeding is absent.
- [ ] Implement `generateNumericCode` with `crypto.randomInt(10 ** 7, 10 ** 8)`, include `programmerUserNumber` in fresh `generate-secrets`, validate the bootstrap inputs, and insert both users in the existing empty-table guard.
- [ ] Pass the value through fresh PowerShell bootstrap, add it to the one-time result message, and extend install verification without persisting it in `.env` or `install.json`.
- [ ] Re-run the focused installer tests and confirm green.

### Task 2: Programmer-only browser-binding exemption

**Files:**
- Modify: `backend/routes/auth.js`
- Modify: `backend/services/staffSessions.js`
- Modify: `backend/routes/admin/deviceAccess.js`
- Modify: `backend/services/deviceAccess.js`
- Modify: `src/components/Login.vue`
- Test: `backend/tests/integration/auth.test.js`
- Test: `backend/tests/integration/webauthnDeviceAccess.test.js`
- Test: `src/components/__tests__/loginWebAuthn.spec.js`

**Interfaces:**
- Produces: ordinary `/api/auth/login` success for an active programmer in staged/enforced mode; existing `DEVICE_AUTH_REQUIRED` behavior for every other role.
- Produces: valid unbound programmer sessions under enforced mode and programmer access to device administration without device step-up.

- [ ] Add failing tests for enforced programmer login, enforced cashier/admin denial, inactive programmer denial, unbound programmer session validation, programmer device-admin access, and hidden programmer device-list behavior.
- [ ] Run the focused auth tests and confirm the expected failures.
- [ ] Move the enforced-mode decision after the locked user lookup, exempt only `role === 'programmer'`, retain transactional session replacement, and append a security audit event for successful programmer login.
- [ ] Allow unbound programmer sessions in `findActiveSession`, let programmer device-admin requests bypass registered-device step-up, hide programmer from device listings/readiness, and exclude programmer from enforcement credential requirements.
- [ ] Make Login attempt the normal endpoint first, then fall back to registered-browser proof only on `DEVICE_AUTH_REQUIRED`, so unsupported browsers can still log in as programmer.
- [ ] Re-run the focused auth tests and confirm green.

### Task 3: Delete device recovery runtime surface

**Files:**
- Delete: `src/components/DeviceRecovery.vue`
- Delete: `backend/services/deviceRecovery.js`
- Modify: `src/router.js`
- Modify: `src/components/Login.vue`
- Modify: `src/shared/browserDeviceClient.js`
- Modify: `src/admin/composables/useDeviceAccess.js`
- Modify: `src/admin/components/settings/DeviceAccessSettings.vue`
- Modify: `backend/routes/auth/webauthn.js`
- Modify: `backend/routes/admin/deviceAccess.js`
- Modify: `backend/services/deviceAccess.js`
- Test: `src/components/__tests__/loginWebAuthn.spec.js`
- Delete: `src/components/__tests__/deviceRecovery.spec.js`
- Modify: `src/admin/pages/__tests__/deviceAccessSettings.spec.js`
- Modify: `src/shared/__tests__/browserDeviceClient.spec.js`
- Modify: `backend/tests/integration/webauthnDeviceAccess.test.js`

**Interfaces:**
- Removes: `/device-recovery`, `/api/auth/webauthn/recovery/options`, `/api/auth/webauthn/recovery/verify`, `/api/admin/device-access/recovery-codes/rotate`, and all client recovery functions.
- Preserves: existing registered-browser enrollment, replacement, revocation, bootstrap, approval, login, and step-up.

- [ ] Replace recovery-positive tests with failing absence tests: no login link/router route/client method/admin control, and all removed APIs return 404.
- [ ] Run the focused UI/client/API tests and confirm failure while recovery remains reachable.
- [ ] Delete the recovery component/service and remove every recovery import, handler, throttle, payload field, generated-code response, readiness condition, prompt, and composable action.
- [ ] Remove recovery handling from registration completion while retaining normal add/replace/bootstrap behavior; do not edit migration SQL or baseline tables.
- [ ] Re-run focused UI/client/API tests and confirm green.

### Task 4: Architecture and final verification

**Files:**
- Modify: `docs/architecture.json`
- Generate: `docs/architecture.html`

**Interfaces:**
- Documents: programmer exemption and absence of runtime recovery while preserving historical schema facts.

- [ ] Remove recovery UI/service nodes and recovery flow edges, update device-access descriptions, installer seed flow, and enforced-session invariants.
- [ ] Run `npm run architecture` and `npm run architecture:check`.
- [ ] Run the complete focused installer/auth/device-access/UI set, then `npm run build:admin`.
- [ ] Review `git diff --check`, recovery-symbol search, secret/config search, and `git diff --stat`; fix any scoped defect found.
- [ ] Commit the verified change on the feature branch without merging, pushing, or deploying.
