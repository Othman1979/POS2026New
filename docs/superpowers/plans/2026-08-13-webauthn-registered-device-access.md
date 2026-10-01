# WebAuthn Registered-Device Access Implementation Plan

> **For Luna/executor:** Read `CLAUDE.md` and `docs/architecture.json`, verify branch/status, then execute Tasks 1–10 in order with their focused RED/GREEN checks. Do not spawn subagents, weaken a security condition for compatibility, invent hardware results, or touch production. If required hardware is unavailable, record that manual gate as pending and complete only the work that can be truthfully verified locally.

**Goal:** Keep the existing cashier numpad login habit while making a valid PIN insufficient by itself: an active user must also prove possession of an administrator-approved, device-bound WebAuthn credential. Privileged users may have two active registered credentials; every other role may have one. Administrators can add, replace, and immediately revoke access without deleting users or changing restaurant data.

**Decision:** **GO, with strict conditions.** WebAuthn is the correct web standard for this threat on stable HTTPS deployments. `@simplewebauthn/server` and `@simplewebauthn/browser` are the recommended implementation libraries for this CommonJS Express/Vue application. The design must reject multi-device/synced passkeys, require user verification, store ceremonies durably, replace the current single-token session column, and refuse activation on unsupported origins.

**Target stack:** Vue 3, Express 5 CommonJS, MySQL/MariaDB, Socket.IO, `@simplewebauthn/server@13.3.2`, `@simplewebauthn/browser@13.3.0`, Vitest, Supertest, Playwright Chromium/CDP.

**Execution boundary:** Preserve unrelated changes and the existing untracked plans. Stop before commit, push, installer build, deployment, environment mutation, or production migration unless the user explicitly authorizes that exact action after reviewing the evidence.

## Execution status (2026-08-13)

The implementation is complete on the feature branch through local verification and hostile review. The review closed fail-open staged login, platform-attachment, enrollment-expiry, inactive-user, stable-user-handle, readiness UI, manual enrollment, error propagation, session-cookie duplication, migration-preflight, real socket-revocation, final-slot race, failed-safe-replacement, and runtime-update evidence gaps. The required real-device matrix remains `PENDING — hardware unavailable`; production enforcement is therefore not ready and has not been enabled. The user explicitly authorized a local commit in the current turn; push, installer build, deployment, production migration, environment mutation, and production enforcement remain out of scope.

---

## Research Verdict

### Why WebAuthn fits

- WebAuthn creates a public/private key credential scoped to a relying-party domain. The server stores only the public key; login requires a fresh challenge signed by the registered authenticator. A guessed cashier/admin PIN is therefore insufficient.
- NIST identifies WebAuthn as phishing-resistant through verifier-name binding and replay-resistant through fresh challenges. This directly improves on the current reusable numeric credential.
- Windows Hello supports WebAuthn on Windows 10 version 1903 and later and can keep a passkey locally in the Windows Hello container. Microsoft documents that Windows Hello keys can be TPM-protected and device-bound.
- WebAuthn registration/authentication are already supported by the project runtime: SimpleWebAuthn v13 requires Node 20+, while the packaged server runtime is Node 22.23.0. The server package exposes a CommonJS `require` entry, so the repository does not need an ESM conversion.

Primary evidence:

- [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)
- [NIST SP 800-63B phishing and replay resistance](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)
- [Microsoft Windows WebAuthn support](https://learn.microsoft.com/en-us/windows/win32/webauthn/-webauthn-portal)
- [Microsoft Windows Hello device-bound keys](https://learn.microsoft.com/en-us/windows/security/book/identity-protection-passwordless-sign-in)
- [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server)

### Conditions that cannot be compromised

1. **Stable secure origin.** WebAuthn is available only in secure contexts: HTTPS, or HTTP on `localhost`. RP IDs are domain names, not direct IP addresses. `https://hashemi.shawermajwana.com` is a valid shape; `http://192.168.x.x:3000` is not. The server must never derive trusted origins from the request `Host` header.
2. **One device means a single-device credential.** Synced passkeys can appear on every device in an Apple/Google/Microsoft credential cloud. The verified WebAuthn backup-eligibility flag must be `singleDevice`, and `credentialBackedUp` must be false. Registration fails otherwise. Microsoft explicitly distinguishes locally saved Windows Hello passkeys from synced credential-manager passkeys.
3. **Platform authenticator requested.** Registration requests `authenticatorAttachment: 'platform'`, `residentKey: 'discouraged'`, and `userVerification: 'required'`. The server also rejects a response reported as cross-platform. This prevents ordinary enrollment into a portable USB key or phone-assisted cross-device flow.
4. **Fresh, one-use ceremonies.** Registration, authentication, step-up, and recovery challenges are persisted, expire quickly, are consumed once under a row lock, and cannot survive replay.
5. **WebAuthn is required at login, not merely at enrollment.** A long-lived “trusted browser” cookie by itself would recreate the same bypass under a different name.

Sources for the constraints:

- [W3C origin/RP-ID and exact-origin validation rules](https://www.w3.org/TR/webauthn-3/#sctn-validating-origin)
- [W3C single-device versus multi-device backup flags](https://www.w3.org/TR/webauthn-3/#sctn-credential-backup)
- [Microsoft local and synced passkey behavior](https://support.microsoft.com/en-us/windows/synchronize-passkeys-to-your-microsoft-account-be9de83c-6803-4ccc-81f2-e1fcc2fb8110)
- [SimpleWebAuthn passkey/device-type guidance](https://simplewebauthn.dev/docs/advanced/passkeys/)

### Honest limits

- Standard browser WebAuthn binds an account to a credential/authenticator, not to a MAC address or universally readable hardware serial. The UI must say “registered access key/device,” not claim a MAC lock.
- The one/two-device policy is transactionally enforceable as one/two active **credentials**. Standard non-attested WebAuthn cannot prove that two credentials sit on two distinct pieces of hardware, and an administrator-selected device label is display metadata, never security authority. This does not let a user exceed the credential cap, but it means the product must not advertise hardware-inventory certainty.
- The platform-attachment result is useful policy input but is not equivalent to enterprise hardware attestation. This version blocks the stated remote-login attack under normal browser/OS behavior; it does not certify the terminal manufacturer or TPM. If that later becomes mandatory, direct attestation plus a reviewed FIDO Metadata Service policy is a separate hardening project.
- A device that only offers a synced passkey is deliberately unsupported. It must not be silently accepted to improve convenience. The enrollment UI explains how to choose local Windows Hello; actual target Android/iOS devices must pass the single-device pilot before being approved.
- An enrollment code authorizes one credential registration; it does not prove where the browser is physically located. The code must be created by a recently verified administrator and entered only on the intended terminal. A deliberately dishonest authorized administrator can still register the wrong device unless the project later adds managed-device attestation/MDM; the UI and runbook must state this instead of pretending WebAuthn reveals a MAC address.
- WebAuthn does not neutralize malicious code already executing on the legitimate POS origin or a stolen active session cookie. The existing self-only CSP, HTTP-only `SameSite=Strict` cookie, short idle timeout, step-up checks, and immediate revocation remain part of the boundary.
- Anyone controlling a registered terminal through remote-desktop software can act through that terminal. RDP/remote-control policy is an operational control, not something WebAuthn can detect reliably.
- `users.user_number` remains the string PIN/lookup value in this project. It is no longer sufficient by itself after enforcement. Hashing or redesigning that field at rest is explicitly deferred so this change does not rewrite production user data or break leading-zero behavior.

### Library version decision

- Pin `@simplewebauthn/server` to **13.3.2**, not an older v13 build. Its changelog records the fix for GHSA-6hxq-p678-4hr2 in attestation-chain verification.
- Pin `@simplewebauthn/browser` to **13.3.0**.
- Commit `package-lock.json`. This is a real server dependency transition, so the Windows server updater must use its **RuntimeTransition** payload once for this release. It is not a spooler change.

Evidence:

- [SimpleWebAuthn 13.3.2 changelog](https://github.com/MasterKale/SimpleWebAuthn/blob/master/CHANGELOG.md#v1332)
- [SimpleWebAuthn browser API](https://simplewebauthn.dev/docs/packages/browser/)

### Why session-device binding is not hidden inside this version

W3C's Device Bound Session Credentials specification explicitly separates the problems: WebAuthn provides interactive secure sign-in, while DBSC is complementary protection after sign-in because WebAuthn credentials are not tied to individual web sessions. Chrome documents hardware-backed DBSC availability on Windows starting with Chrome 145, but that does not provide a dependable all-browser/all-phone baseline. RFC 9449 DPoP is designed around sender-constrained OAuth tokens; retrofitting a custom WebCrypto request-signing scheme into this cookie-authenticated POS would touch every HTTP retry and Socket.IO path without guaranteeing hardware-bound storage.

Therefore v1 does not claim that a copied live cookie is unusable elsewhere. It minimizes that residual risk with host-only HTTP-only strict cookies, durable revocation, a 30-minute idle limit, a 12-hour absolute limit, and recent WebAuthn step-up for security mutations. A later, separately piloted DBSC layer is recommended for managed Chrome-on-Windows terminals once its exact support and fail-closed behavior are proven; it must never silently weaken to an ordinary long-lived cookie while claiming device binding.

Evidence:

- [W3C DBSC: WebAuthn and DBSC are complementary](https://www.w3.org/TR/dbsc-1/#webauthn-and-silent-mediation)
- [Chrome: DBSC available on Windows](https://developer.chrome.com/blog/dbsc-windows-announcement)
- [RFC 9449: DPoP scope and browser/XSS limits](https://www.rfc-editor.org/rfc/rfc9449.html)

---

## Verified Current-State Constraints

- `src/components/Login.vue` posts only `{ user_number }`; the server treats a matching active row as fully authenticated.
- `backend/routes/auth.js` stores one SHA-256 session-token hash in `users.session_token`, so a second login revokes the first.
- `backend/middleware/auth.js` shares `verifyToken()` between HTTP and Socket.IO and caches sessions for a sliding 30 minutes.
- User edits/deactivation and both ordinary/admin shift close paths revoke current sessions. These semantics must remain.
- Admin and programmer are privileged roles. Device limits are therefore:
  - `admin`, `programmer`: maximum **2** active credentials each.
  - `cashier`, `waiter`, `table_manager`, `call_center`: maximum **1** active credential each.
- Call-center permissions, held-order rules, checkout authority, audit suppression rules, and print/spooler identity are not changed by this feature.
- The codebase has both online HTTPS deployment and Windows/LAN installation modes. Device enforcement must default to disabled and refuse activation where the active origin cannot perform WebAuthn.

---

## Security Contract

### Authentication modes

Store `staff_device_auth_mode` in `settings` with exactly three values:

- `disabled` (default): legacy PIN login works; credentials may be prepared only through the protected bootstrap/enrollment process.
- `staged`: both legacy and WebAuthn login work while administrators enroll all active users. Every legacy session is visibly marked unbound in Device Access.
- `enforced`: legacy `/api/auth/login` never issues a session. Only a verified WebAuthn assertion may create a staff session.

Mode transitions:

- `disabled -> staged`: requires the one-time bootstrap secret and successful first privileged credential registration.
- `staged -> enforced`: requires a recent WebAuthn step-up by an admin/programmer, valid RP configuration, at least one active privileged credential, a generated recovery batch, and an explicit decision for every active user (credential enrolled or account deactivated). The transaction revokes every legacy/unbound session.
- `enforced -> staged/disabled`: not available as an ordinary settings toggle. It requires an emergency recovery ceremony or operator-controlled maintenance procedure so a compromised admin session cannot weaken authentication.

### Credential policy

Every accepted registration must satisfy all of the following:

- Exact configured expected origin and RP ID.
- Fresh unconsumed challenge, maximum age 2 minutes.
- `requireUserVerification: true` and verified `userVerified === true`.
- `credentialDeviceType === 'singleDevice'`.
- `credentialBackedUp === false`.
- Requested and reported platform attachment; `internal` transport is stored as defense-in-depth evidence, never as the sole authority.
- Registration requests `attestation: 'none'`; v1 does not collect identifying attestation data or pretend it has an authenticator trust policy that has not been built.
- Credential ID is new globally and the user still has a free slot, or the ceremony names one exact credential to replace.
- Slot check, insert, replacement revocation, session revocation, challenge consumption, and audit insert occur in one transaction with `FOR UPDATE` locks.

Every accepted assertion must re-check the signed backup eligibility/state returned by verification. If it is no longer `singleDevice` with `credentialBackedUp === false`, deny the login or step-up, revoke that credential and its sessions transactionally, and record a metadata-only security event. Never update a now-disallowed backup state and then issue a session.

Store the credential’s AAGUID, attestation format, transports, attachment report, backup flags, and last-used time for support/audit. Never store biometric data; WebAuthn does not return it.

### Session policy

- Replace `users.session_token` with durable `auth_sessions` rows.
- One active session per WebAuthn credential. Re-login on the same registered credential revokes only that credential’s prior session.
- Two different privileged credentials can therefore hold two independent sessions. A one-slot role remains effectively single-session.
- Legacy login in `disabled`/`staged` keeps the current one-session-per-user behavior and creates an unbound `auth_sessions` row with `credential_id = NULL`.
- Continue using an HTTP-only, `SameSite=Strict` session cookie. Keep raw tokens out of the database and logs.
- Add an absolute session lifetime (12 hours) on top of the current 30-minute idle timeout. WebAuthn step-up is valid for five minutes only.
- Deactivation, security-relevant user edits, credential revocation/replacement, recovery, and shift close revoke matching rows durably, evict in-memory cache entries, and disconnect live Socket.IO clients.
- User deactivation also marks every credential revoked. A later reactivation must use a new administrator-approved enrollment; it must not silently resurrect an old terminal.

### Bootstrap and recovery

- A weak pre-existing admin session cannot authorize the first trusted credential by itself.
- Online deployments use a high-entropy `WEBAUTHN_BOOTSTRAP_SECRET` managed outside Git. The server compares it in constant time, never logs it, and permanently marks it consumed after the first successful privileged registration.
- The first registration upgrades the current admin session to the new credential, enters `staged` mode, and generates a printable one-time recovery batch.
- Recovery codes are random high-entropy values, displayed once, stored only as SHA-256 hashes, rate-limited, and single-use. Recovery also requires the privileged user’s manager PIN when one exists.
- Recovery never creates a session immediately. It authorizes one short-lived replacement registration; successful registration atomically consumes the code, revokes old credentials/sessions, registers the new credential, and then issues the new bound session.
- If a working privileged credential exists, normal admin replacement is used instead of recovery.

---

## Data Model

### `users` addition

- `webauthn_user_handle VARBINARY(64) NULL`
- Unique index on non-null handles. Generate 32 random bytes on first registration and reuse the same handle for all credentials belonging to that user.

### `webauthn_credentials`

- `id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY`
- `user_id INT NOT NULL`
- `credential_lookup BINARY(32) NOT NULL UNIQUE` — SHA-256 of raw credential ID for indexed lookup.
- `credential_id VARBINARY(1024) NOT NULL`
- `public_key BLOB NOT NULL`
- `counter BIGINT UNSIGNED NOT NULL DEFAULT 0`
- `device_type ENUM('singleDevice','multiDevice') NOT NULL`
- `backed_up TINYINT(1) NOT NULL DEFAULT 0`
- `authenticator_attachment ENUM('platform','cross-platform') NULL`
- `transports VARCHAR(255) NULL` — validated JSON array of known transport strings.
- `aaguid CHAR(36) NULL`
- `attestation_format VARCHAR(32) NULL`
- `device_label VARCHAR(100) NOT NULL`
- `status ENUM('active','revoked') NOT NULL DEFAULT 'active'`
- `registered_by_user_id INT NULL`
- `registered_at`, `last_used_at`, `revoked_at`, `revoked_by_user_id`, `revoke_reason`
- Index `(user_id, status)`; foreign keys to `users` with deliberate `CASCADE` only for credential ownership and `SET NULL` for audit actors.

Credential IDs may exceed ordinary MySQL index limits, hence the fixed binary lookup hash plus byte-for-byte comparison of the stored ID after lookup.

### `webauthn_ceremonies`

- UUID primary key.
- `flow ENUM('bootstrap_registration','enrollment_registration','authentication','step_up','recovery_registration')`; verification endpoints reject every cross-flow use even when a challenge is otherwise valid.
- Nullable target `user_id` (null only for decoy authentication), requesting admin, optional exact replacement credential, and explicit `is_decoy`.
- Raw random WebAuthn challenge with its own two-minute expiry, optional enrollment-token hash with its own ten-minute expiry, optional recovery-code row reference, and intended device label.
- Attempt count, issued/consumed timestamps, and bounded terminal state. Do not turn IP or user-agent data into a browser-fingerprint authority.
- Index flow/target-user/challenge-expiry and token-hash/token-expiry lookup paths. No ceremony lives only in process memory.

### `auth_sessions`

- UUID primary key and unique `token_hash CHAR(64)`.
- `user_id`, nullable `credential_id`, `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `webauthn_verified_at`, `revoked_at`, `revoke_reason`.
- Index active sessions by user and by credential.
- The migration copies still-valid `users.session_token` hashes into unbound rows, then removes the obsolete `users.session_token` column. Removing it makes rollback to a pre-WebAuthn binary fail closed instead of silently reopening PIN-only login.

### `webauthn_recovery_codes`

- ID, privileged `user_id`, recovery-batch UUID, unique code hash, created/used timestamps, creator, and optional expiry.
- A new batch invalidates every unused code in the prior batch.

### Existing `audit_events`

Use the existing transactional audit service for:

- `device_auth_bootstrapped`
- `device_credential_registered`
- `device_credential_replaced`
- `device_credential_revoked`
- `device_auth_mode_changed`
- `device_recovery_codes_rotated`
- `device_recovery_used`

Do not include raw credential IDs, challenges, enrollment tokens, recovery codes, session tokens, or bootstrap secrets in audit JSON.

These new authentication-authority events are non-suppressible: an `xyz=1`, admin, or programmer actor must still leave the same metadata-only trail. Add an explicit narrow option/helper for device-security events without changing suppression semantics for existing held-order, call-center, or business-operation audits.

### Existing `settings`

- `staff_device_auth_mode`: `disabled`, `staged`, or `enforced`; default `disabled`.
- `webauthn_bootstrap_consumed`: `0` until the first privileged credential is committed, then permanently `1` unless an operator performs the documented emergency reset procedure.

Recovery readiness is derived from live credential/recovery rows; do not add a stale boolean setting for it.

These two keys are security-owned state, not ordinary store preferences. Never add them to the generic `POST /api/system/settings` `allowed_keys` list or expose them through its response. That route must explicitly reject a payload containing either key, even for an admin, rather than silently report success. Only the Device Access service may read or mutate them, under the transition, step-up, transaction, and audit rules above.

---

## API Contract

### Public/authentication endpoints

- `GET /api/auth/login-policy`
  - Returns mode, whether this configured origin is supported, and a generic help message. Never returns registered credential IDs or whether a submitted PIN exists.
- `POST /api/auth/webauthn/login/options { user_number }`
  - Applies existing per-PIN/IP limits and, for every syntactically valid PIN, returns HTTP 200 with a ceremony ID plus `PublicKeyCredentialRequestOptionsJSON` containing exactly two descriptors.
  - Real active credential descriptors are padded with random decoy IDs to two entries. Unknown/inactive/unregistered users receive a decoy ceremony with two random IDs. Verification always returns the same generic failure for a decoy, so response status, shape, and credential count do not disclose whether a PIN exists or whether it belongs to a privileged role.
  - Options issuance has its own strict IP and PIN+IP throttle and a bound on outstanding ceremonies; an attacker cannot fill the database simply by requesting options and abandoning them.
- `POST /api/auth/webauthn/login/verify { ceremony_id, response }`
  - Consumes the ceremony, verifies origin/RP/challenge/UV/signature/counter and active credential ownership, updates the counter/backup state, creates a credential-bound session, and returns the existing login success payload.
- `POST /api/auth/webauthn/enroll/options { enrollment_code }`
- `POST /api/auth/webauthn/enroll/verify { ceremony_id, response }`
  - Used on the new target device; never accepts an arbitrary client-supplied user ID or replacement ID.
- `POST /api/auth/webauthn/recovery/options { user_number, recovery_code, manager_pin, device_label }`
- `POST /api/auth/webauthn/recovery/verify { ceremony_id, response }`
  - Available without an existing session because it is the lockout path. It accepts only a privileged target account, verifies that account's own manager PIN when configured, and uses generic errors plus strict independent IP/account/code throttling.
  - The recovery code remains unused until registration verification succeeds. The final transaction consumes it, revokes the target user's old credentials/sessions, inserts the replacement credential, audits the recovery, and issues one bound session; a failed/cancelled ceremony changes none of that state.
- `POST /api/auth/webauthn/step-up/options` and `/verify`
  - Requires an existing bound session and updates only that session’s recent-verification timestamp.

The old `POST /api/auth/login` remains available only in `disabled` and `staged`. In `enforced`, it returns a stable `DEVICE_AUTH_REQUIRED` error and never writes a cookie or session row, including when an old cached frontend calls it.

### Administrator endpoints

All routes require admin/programmer plus a WebAuthn-bound session; mutations require a step-up no older than five minutes. Mutations also require JSON and an exact configured `Origin`; retain the host-only strict cookie so a same-site sibling origin cannot exercise these routes.

The sole exception is first setup while mode is `disabled`:

- `POST /api/admin/device-access/bootstrap/options { bootstrap_secret, device_label }`
- `POST /api/admin/device-access/bootstrap/verify { ceremony_id, response }`
  - These require the existing admin/programmer session **and** the high-entropy environment bootstrap secret. They are permanently disabled after `webauthn_bootstrap_consumed=1`. Successful verification binds/upgrades that exact current session; it never creates a second anonymous session.

- `GET /api/admin/device-access`
  - Returns users, role-derived slot limit, active credentials, display metadata, session count, pending enrollment, and recovery readiness.
- `POST /api/admin/device-access/enrollments`
  - Body: `{ user_id, action: 'add'|'replace', replace_credential_id?, device_label }`.
  - Returns a 10-minute, high-entropy one-time enrollment code and URL exactly once.
- `DELETE /api/admin/device-access/enrollments/:id`
- `POST /api/admin/device-access/credentials/:id/revoke`
  - Requires reason; cannot remove the last usable privileged credential unless a recovery path is ready and the actor explicitly confirms.
- `POST /api/admin/device-access/recovery-codes/rotate`
- `POST /api/admin/device-access/mode`
  - Enforces the mode-transition prerequisites and performs session revocation atomically.

### Replacement semantics

- **Safe replace:** the old credential remains active while the new device enrolls. The new credential insert and old credential/session revocation commit together. An expired/cancelled enrollment leaves the old device untouched.
- **Lost/stolen device:** “Revoke now” invalidates the old credential and sessions immediately, then creates a separate add enrollment. Downtime is intentional and visible.
- Role change from a two-slot privileged role to a one-slot role returns `409 DEVICE_LIMIT_EXCEEDED` until the administrator selects which credential to keep. Never revoke an arbitrary device silently.

---

## Implementation Tasks

### Task 1: Pin dependencies and enforce immutable RP configuration

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `backend/services/webauthn/config.js`
- Create: `backend/tests/unit/webauthnConfig.test.js`
- Modify: `deployment/templates/hostinger.env.template`
- Modify: `deployment/templates/pos.env.template`

**Interfaces:**

- `loadWebAuthnConfig(env): { rpName, rpID, expectedOrigins }`
- `validateWebAuthnOrigin(config, origin): boolean`
- `assertWebAuthnRuntimeReady({ config, mode, enforceHttps }): void`

- [ ] Write failing tests proving exact-origin matching, RP-ID/domain relationship, HTTPS requirement, `http://localhost:<port>` exception, rejection of direct IP origins, rejection of host-header-derived values, and fail-closed behavior when mode is `staged`/`enforced` without complete config.
- [ ] Run `npx vitest run backend/tests/unit/webauthnConfig.test.js` and observe the expected RED failure.
- [ ] Install exact versions: `npm install --save-exact @simplewebauthn/server@13.3.2 @simplewebauthn/browser@13.3.0`.
- [ ] Implement the smallest pure configuration module. Parse a comma-separated exact origin allowlist; do not support wildcards or arbitrary subdomains.
- [ ] Add tracked non-secret variable shapes. For Hostinger the intended shape is `WEBAUTHN_RP_ID=hashemi.shawermajwana.com` and `WEBAUTHN_ALLOWED_ORIGINS=https://hashemi.shawermajwana.com`; do not add a real bootstrap secret.
- [ ] Give the local template `localhost`/configured POS-port values only. Document that LAN-IP terminals cannot enable WebAuthn until served through a stable trusted HTTPS name.
- [ ] Never infer RP/origin values from `Host`, installer discovery, or an existing public URL. Existing `pos.env`/Hostinger environment values remain untouched by updates; missing WebAuthn configuration leaves the feature disabled until an operator explicitly provisions the non-secret RP/origin values and private bootstrap secret.
- [ ] Run the focused test to GREEN and run `npm audit --omit=dev`; review, do not blindly apply dependency upgrades.

### Task 2: Add authoritative WebAuthn/session schema without touching business data

**Files:**

- Create: `backend/migrations/2026-08-13-webauthn-device-access.preflight.sql`
- Create: `backend/migrations/2026-08-13-webauthn-device-access.sql`
- Create: `backend/migrations/2026-08-13-webauthn-device-access.auto.sql`
- Create: `backend/migrations/2026-08-13-webauthn-device-access.verify.sql`
- Modify: `backend/migrations/auto-manifest.json`
- Modify: `deployment/database/baseline.sql`
- Modify: `deployment/database/manifest.json`
- Modify: `deployment/database/hostinger-manual-migrations.sql`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `backend/services/schemaValidation.js`
- Modify: `scripts/validate-schema-drift.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`
- Modify: `backend/tests/integration/installerBaseline.test.js`
- Create: `backend/tests/integration/webauthnSchemaMigration.test.js`

**Interfaces:**

- New ledger tip: `2026-08-13-webauthn-device-access-v1` with a generated immutable checksum.
- Required schema counts cover four new tables, exact columns/indexes/foreign keys/checks, `users.webauthn_user_handle`, absence of `users.session_token`, and the two device-auth settings rows.

- [ ] Write RED schema-authority and scratch-database migration tests first. Prove upgrade from the exact current ledger tip, preservation of all users/products/orders/categories, copying of non-null session hashes, idempotent clean failure on drift, and fresh-baseline parity.
- [ ] Run only `npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/webauthnSchemaMigration.test.js backend/tests/integration/installerBaseline.test.js` and observe the intended failures.
- [ ] Run the preflight read-only against test fixtures. Reject unexpected duplicate credential/session table names, incompatible `users` columns, or a wrong predecessor; never repair customer data heuristically.
- [ ] Add tables/constraints/settings exactly as specified above. Create tables first, copy legacy token hashes into `auth_sessions`, then drop `users.session_token`, then record the ledger row.
- [ ] Keep automatic SQL Hostinger-safe: no procedure, trigger, delimiter, definer, dynamic SQL, or production-specific IDs.
- [ ] Update baseline, bootstrap, fixture, manual SQL, manifest hash, and validator as one authority set.
- [ ] Run the focused schema tests to GREEN and `node scripts/validate-schema-drift.js`.

### Task 3: Replace single-column sessions with credential-aware durable sessions

**Files:**

- Create: `backend/services/staffSessions.js`
- Create: `backend/services/sessionCookies.js`
- Create: `backend/tests/unit/staffSessions.test.js`
- Modify: `backend/middleware/auth.js`
- Modify: `backend/routes/auth.js`
- Modify: `backend/routes/admin/users.js`
- Modify: `backend/routes/admin/shifts.js`
- Modify: `backend/tests/unit/auth.unit.test.js`
- Modify: `backend/tests/integration/auth.test.js`
- Modify: `backend/tests/integration/shift.test.js`
- Modify: `backend/tests/integration/users.test.js`
- Modify: `backend/tests/helpers/auth.js`

**Interfaces:**

- `createLegacySession(conn, user): { rawToken, session }`
- `createCredentialSession(conn, user, credentialId): { rawToken, session }`
- `verifySession(rawToken): Promise<SessionIdentity|null>`
- `revokeSessionByToken`, `revokeUserSessions`, `revokeCredentialSessions`, `revokeShiftUserSessions`
- Cache entries carry `sessionId`, `credentialId`, `user`, `shiftId`, idle expiry, and absolute expiry.

- [ ] Write RED tests for migrated-token lookup, disabled/staged single-session legacy login, one active session per credential, two independent admin credentials, absolute and idle expiry, logout, user update/deactivation, ordinary shift close, forced admin shift close, and cache eviction.
- [ ] Extract cookie setting/clearing without changing flags or browser-visible behavior.
- [ ] Implement durable session creation/lookup/revocation. Query `auth_sessions JOIN users LEFT JOIN webauthn_credentials` on cache miss and reject inactive users, revoked sessions, expired sessions, or revoked credentials.
- [ ] Preserve call-center normalization and permission loading exactly.
- [ ] Replace every `users.session_token` write/read. A repository-wide `rg -n "session_token"` may find only migration/history assertions after completion.
- [ ] Keep current test helpers on legacy login while mode is disabled so unrelated integration tests do not require fake authenticators.
- [ ] Run the named focused tests to GREEN.

### Task 4: Implement the WebAuthn ceremony and credential core

**Files:**

- Create: `backend/services/webauthn/adapter.js`
- Create: `backend/services/webauthn/ceremonies.js`
- Create: `backend/services/webauthn/credentials.js`
- Create: `backend/services/webauthn/policy.js`
- Create: `backend/tests/unit/webauthnPolicy.test.js`
- Create: `backend/tests/unit/webauthnCeremonies.test.js`
- Create: `backend/tests/unit/webauthnCredentials.test.js`

**Interfaces:**

- The adapter is the only module importing SimpleWebAuthn server functions.
- `beginRegistration`, `finishRegistration`, `beginAuthentication`, `finishAuthentication`, `beginStepUp`, `finishStepUp` accept injected DB/config/clock/random providers for deterministic tests.
- Public errors expose stable codes; logs contain ceremony IDs and outcome classes only, never credential/challenge/token bodies.

- [ ] Write RED tests for wrong origin/RP ID, wrong challenge, expired/consumed ceremony, replay, missing UV, multi-device/backup rejection, cross-platform rejection, unknown credential, credential/user mismatch, counter regression/clone signal, duplicate credential lookup hash, and malformed transports.
- [ ] Write cross-flow confusion tests proving a bootstrap, enrollment, authentication, step-up, or recovery ceremony is accepted only by its matching verification service/route.
- [ ] Prove authentication and step-up reject and revoke a formerly accepted credential if its signed backup eligibility/state becomes disallowed; no session may be issued from that assertion.
- [ ] Write concurrency tests in which two registrations race for the last slot; exactly one transaction may commit.
- [ ] Wrap `generateRegistrationOptions`, `verifyRegistrationResponse`, `generateAuthenticationOptions`, and `verifyAuthenticationResponse`; do not implement WebAuthn crypto manually.
- [ ] Use `excludeCredentials` for the user’s existing credentials and `allowCredentials` for active credentials only.
- [ ] Store and update the verified counter and latest backup flags after each successful assertion.
- [ ] Prune expired/consumed ceremonies in bounded batches and prove abandoned option requests cannot grow the table without limit.
- [ ] Run the three focused unit files to GREEN.

### Task 5: Add bootstrap, enrollment, replacement, revocation, and recovery APIs

**Files:**

- Create: `backend/routes/auth/webauthn.js`
- Create: `backend/routes/admin/deviceAccess.js`
- Create: `backend/services/deviceAccess.js`
- Create: `backend/services/deviceRecovery.js`
- Modify: `backend/services/auditEvents.js`
- Create: `backend/tests/integration/webauthnDeviceAccess.test.js`
- Modify: `backend/routes/auth.js`
- Modify: `backend/routes/admin.js`
- Modify: `backend/routes/admin/users.js`
- Modify: `backend/routes/system.js`
- Modify: `backend/tests/integration/settingsValidation.test.js`

**Interfaces:**

- Routes and transition rules match the API contract above.
- Enrollment/recovery codes contain at least 128 bits of randomness; display encoding may be grouped for readability but must not reduce entropy.

- [ ] Write RED integration cases for one-time bootstrap, invalid/absent bootstrap secret, first credential/session upgrade, staged mode, privileged/nonprivileged caps, options-request throttling, outstanding-ceremony bounds, pending-enrollment expiry/cancel, safe replacement, urgent revocation, recovery-code rotation/use/replay, missing recent step-up, user deactivation/reactivation, and role downgrade with excess credentials.
- [ ] Hash bootstrap input before constant-time comparison and permanently consume first setup in the same transaction as first credential registration.
- [ ] Implement add/replace/revoke under user/credential row locks. Pending or failed safe replacement must never revoke the old credential.
- [ ] Require a recent WebAuthn step-up for every mutation after bootstrap.
- [ ] Append non-suppressible device-security audit events inside the same transaction as each security mutation. Prove an `xyz=1` actor is still recorded, while unrelated existing audit-suppression tests remain unchanged.
- [ ] Prove the generic settings GET does not expose either security key and its POST rejects attempts to set either key without changing stored values. Keep both keys out of `allowed_keys`; do not rely on silent ignore behavior.
- [ ] Return generic unauthenticated errors; admin endpoints may return actionable stable codes without secrets.
- [ ] Run the focused integration test to GREEN.

### Task 6: Replace the browser login with PIN plus WebAuthn assertion

**Files:**

- Create: `src/shared/webauthnClient.js`
- Create: `src/shared/__tests__/webauthnClient.spec.js`
- Create: `src/components/DeviceEnrollment.vue`
- Create: `src/components/DeviceRecovery.vue`
- Modify: `src/components/Login.vue`
- Modify: `src/router.js`
- Modify: `src/shared/i18n/ar.json`
- Modify: `src/shared/__tests__/i18nCatalog.spec.js`
- Create: `src/components/__tests__/loginWebAuthn.spec.js`
- Create: `src/components/__tests__/deviceEnrollment.spec.js`
- Create: `src/components/__tests__/deviceRecovery.spec.js`

**Flow:**

1. User enters the same 1–8 digit PIN on the existing numpad.
2. In enforced mode, submit requests authentication options and calls `startAuthentication()`.
3. Windows Hello/device authenticator asks for local face/fingerprint/device PIN.
4. The verified response endpoint sets the existing HTTP-only session cookie and returns the current role/permissions payload.
5. The existing role redirects and POS session-storage cleanup run only after verified success.

**Enrollment flow:**

1. `/device-enrollment` is a public, sessionless route that accepts the one-time enrollment code from a form.
2. A QR may carry the code only in a URL fragment such as `/device-enrollment#code=...`; fragments are not sent in HTTP requests. The component reads it once and immediately removes it with `history.replaceState` before calling the options endpoint.
3. Never place enrollment or recovery codes in query parameters, route params, analytics, local/session storage, referrers, logs, or error reports.
4. The page shows the administrator-chosen user name/device label only after the opaque code is accepted, then registers the local platform credential. Success redirects to login; it does not silently authenticate the enrolled user.

**Locked-out privileged recovery flow:**

1. In enforced mode, Login offers a restrained “Lost registered device?” route to `DeviceRecovery.vue`.
2. The privileged user enters their user number, one printed recovery code, their own manager PIN when configured, and a new device label.
3. The browser performs a fresh platform registration. Only successful server verification consumes the recovery code and returns a bound session.
4. The UI never reveals whether the account, PIN, or recovery code was the failing element.

- [ ] Write RED client tests for supported/unsupported browser, user cancellation (`NotAllowedError`), network failure, expired ceremony retry, server policy error, and a successful serialized response.
- [ ] Test manual enrollment, fragment-code consumption/removal, absence of secrets from URLs/storage/logs, expired/used code behavior, synced/cross-platform rejection copy, and successful enrollment without automatic login.
- [ ] Test locked-out privileged recovery success, cancellation without code consumption, generic invalid-input errors, throttle behavior, and no recovery surface for nonprivileged accounts.
- [ ] Write a source/behavior test proving enforced mode never calls legacy `/api/auth/login`, and disabled mode retains current behavior.
- [ ] Keep the numpad layout, keyboard controls, graphite/light token usage, leading zeros, loading lock, and role redirects unchanged.
- [ ] Use calm, specific UI states: “Verify this registered device,” “This device is not registered,” “This passkey is synced and cannot be used for one-device access,” and “Ask an administrator to move your access.” Add natural Arabic equivalents.
- [ ] Do not expose credential IDs, registered-device counts, or whether another PIN is valid in public error text.
- [ ] Run `npx vitest run src/shared/__tests__/webauthnClient.spec.js src/components/__tests__/loginWebAuthn.spec.js src/components/__tests__/deviceEnrollment.spec.js src/components/__tests__/deviceRecovery.spec.js src/shared/__tests__/i18nCatalog.spec.js`.

### Task 7: Build the Device Access settings surface

**Files:**

- Create: `src/admin/components/settings/DeviceAccessSettings.vue`
- Create: `src/admin/composables/useDeviceAccess.js`
- Create: `src/admin/pages/__tests__/deviceAccessSettings.spec.js`
- Modify: `src/admin/pages/Settings.vue`
- Modify: `src/shared/i18n/ar.json`

**UI contract:**

- Add one `Device access` tab in Settings rather than bloating the user-edit modal.
- Top status strip: `Disabled`, `Enrollment in progress`, or `Enforced`, with explicit prerequisites and no ambiguous toggle.
- One compact row per active user: name, role, `used/limit`, device labels, last used, pending enrollment, and one primary action.
- “Add” appears only with a free slot. “Replace” requires selecting the old credential. “Revoke now” is visually destructive and always requires a reason/confirmation.
- Enrollment result shows a client-generated QR whose one-time code is in the URL fragment only, plus grouped fallback code, expiry countdown, and a copy action. The plaintext code disappears when the modal closes and cannot be fetched again.
- Recovery codes are displayed once with print/download guidance but never put in localStorage or ordinary app logs.
- Enabling enforcement opens a readiness checklist listing every user without a credential and every unbound session that will be terminated.

- [ ] Write RED composable and source tests for limits, mode readiness, add/replace/revoke payloads, expiring enrollment display, recovery-code one-time handling, and natural Arabic labels.
- [ ] Implement the component with existing admin tokens, focus-visible states, keyboard support, RTL layout, responsive rows, and no decorative card explosion.
- [ ] Trigger step-up when the backend reports `WEBAUTHN_STEP_UP_REQUIRED`, then replay the intended mutation only once.
- [ ] On a successful credential mutation, refresh server state; do not optimistically invent security state.
- [ ] Run the focused frontend tests and `npm run build:admin`.

### Task 8: Make revocation immediate for HTTP cache and live Socket.IO clients

**Files:**

- Modify: `server.js`
- Modify: `backend/middleware/auth.js`
- Modify: `backend/services/staffSessions.js`
- Modify: `backend/routes/admin/users.js`
- Create: `backend/tests/integration/webauthnSocketRevocation.test.js`
- Modify: `backend/tests/integration/socketRoleIsolation.test.js`

- [ ] Write RED socket tests proving credential revocation, safe replacement, user deactivation, security edit, and shift close disconnect the affected browser immediately while leaving another admin credential connected.
- [ ] After staff handshake, join `user:<id>`, `session:<id>`, and (when bound) `credential:<id>` rooms. These names contain internal numeric/UUID identifiers only.
- [ ] Add a single revocation helper that updates DB state first, then evicts local cache and calls Socket.IO `disconnectSockets(true)` for the exact affected rooms.
- [ ] Preserve spooler/customer handshake branches and call-center room isolation exactly.
- [ ] Run only the two socket-focused integration tests to GREEN.

### Task 9: Attack the implementation with real WebAuthn protocol tests

**Files:**

- Create: `playwright.webauthn.config.mjs`
- Create: `tests/e2e/webauthn-web-server.cjs`
- Create: `tests/e2e/specs/webauthn-device-access.spec.js`
- Create: `docs/superpowers/evidence/2026-08-13-webauthn-device-access-validation.md`

Chrome DevTools Protocol exposes a virtual WebAuthn authenticator specifically for automated testing: [CDP WebAuthn domain](https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/).

- [ ] Use an isolated WebAuthn test database/port; do not toggle the normal E2E database into enforced mode.
- [ ] Add an internal CTAP2 virtual authenticator with UV, no resident key, automatic presence, `backupEligibility=false`, and `backupState=false`.
- [ ] Prove full browser registration and login, remote browser without the authenticator denied, assertion replay denied, user cancellation safe, wrong PIN generic, and disabled legacy endpoint denied after enforcement.
- [ ] Add a virtual multi-device authenticator and prove registration is rejected.
- [ ] Prove 1-slot cashier replacement, 2-slot admin simultaneous sessions, third-admin-device rejection, role downgrade conflict, revocation of HTTP and socket access, and recovery completion.
- [ ] Add concurrency probes for two enrollments consuming one final slot and two verification requests replaying one ceremony.
- [ ] Run `npx playwright test --config playwright.webauthn.config.mjs`.
- [ ] Run the minimum real-device matrix: Windows 10/11 with Chrome and Edge, iPhone with Safari, and Android with Chrome. For each attempt, record only device class, OS/browser major version, registration outcome, `credentialDeviceType`, `credentialBackedUp`, attachment, UV result, and the resulting support decision in `docs/superpowers/evidence/2026-08-13-webauthn-device-access-validation.md`; never record credential IDs or customer data.
- [ ] Accept a device/browser combination only when the verified result is `singleDevice`, not backed up, platform-attached, and user-verified. A synced-only phone is an explicit unsupported result with the planned clear UI; never relax the policy to make the matrix pass.
- [ ] On any two accepted real devices available to the owner, prove both admin credentials can hold independent sessions and a third registration is rejected. If the required devices are unavailable, write `PENDING — hardware unavailable`; do not claim release readiness or enable enforcement.
- [ ] Do not enable production enforcement if the real-hardware result is multi-device, if the active origin differs from configuration, or if recovery/replacement has not been physically rehearsed.

### Task 10: Architecture, installer/updater, and release-readiness review

**Files:**

- Modify: `docs/architecture.json`
- Generate: `docs/architecture.html`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`
- Modify: `backend/tests/unit/installerPackageContract.test.js`
- Modify: `deployment/tools/validate-payload.js` only if the new env/runtime contract requires it
- Modify: `deployment/windows/Install-PosServer.ps1` only if bootstrap configuration is provisioned for fresh local installs

- [ ] Update architecture facts and flows: PIN is no longer sufficient in enforced mode; session authority lives in `auth_sessions`; credential limits, mode transition, recovery, origin binding, and socket revocation are explicit invariants.
- [ ] Run `npm run architecture` then `npm run architecture:check`.
- [ ] Prove the server **core** updater rejects this dependency-changing build with `runtime_transition_required` and the **RuntimeTransition** payload contains the new dependency tree. Do not change spooler packages or payloads.
- [ ] Prove the updater preserves the installed `pos.env` byte-for-byte, fresh installer baseline/config remains valid, and an HTTP LAN-IP install stays `disabled` rather than exposing a broken enforcement toggle.
- [ ] Run focused verification:
  - `npx vitest run backend/tests/unit/webauthnConfig.test.js backend/tests/unit/staffSessions.test.js backend/tests/unit/webauthnPolicy.test.js backend/tests/unit/webauthnCeremonies.test.js backend/tests/unit/webauthnCredentials.test.js`
  - `npx vitest run backend/tests/integration/webauthnSchemaMigration.test.js backend/tests/integration/webauthnDeviceAccess.test.js backend/tests/integration/webauthnSocketRevocation.test.js backend/tests/integration/auth.test.js backend/tests/integration/shift.test.js backend/tests/integration/users.test.js`
  - `npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/installerBaseline.test.js backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js`
  - `npx vitest run src/shared/__tests__/webauthnClient.spec.js src/components/__tests__/loginWebAuthn.spec.js src/components/__tests__/deviceEnrollment.spec.js src/components/__tests__/deviceRecovery.spec.js src/admin/pages/__tests__/deviceAccessSettings.spec.js src/shared/__tests__/i18nCatalog.spec.js`
  - `npx playwright test --config playwright.webauthn.config.mjs`
  - `npm run build:admin`
  - `git diff --check`
- [ ] Review the complete diff for secrets, production-specific data, accidental business-table changes, legacy-login bypasses, stale cache paths, and installer payload scope.
- [ ] Stop after local verification. Do not commit, push, build installers, deploy, alter Hostinger environment, migrate production, or enable enforcement unless the user explicitly requests that exact next action.

---

## Hostile Scenario Checklist

The implementation is not complete until each case is either automated or documented with evidence:

- [ ] Cashier knows their correct PIN at home but has no registered credential: denied.
- [ ] Attacker guesses a valid admin PIN/user number: denied before session creation.
- [ ] Unknown, inactive, or unenrolled account does not reveal useful enumeration detail.
- [ ] Old cached frontend calls legacy login after enforcement: denied.
- [ ] Synced/cloud-backed passkey: registration denied.
- [ ] Cross-platform/portable authenticator offered during ordinary enrollment: denied by policy under supported browsers; result recorded for later attestation hardening decisions.
- [ ] Authentication response used twice: second request denied.
- [ ] Registration response used twice: second request denied.
- [ ] Challenge created before process restart: still verifiable once because it is durable.
- [ ] Two processes/requests race for the last device slot: one commit only.
- [ ] Safe replacement expires/fails: old device remains usable.
- [ ] Safe replacement succeeds: old credential, HTTP sessions, cache, and sockets die in the same state transition.
- [ ] Stolen device “revoke now”: access dies before new enrollment begins.
- [ ] Cashier moves from terminal A to B: exactly one active credential remains.
- [ ] Admin uses two registered devices concurrently: both remain valid.
- [ ] Admin attempts a third credential: deterministic 409, no partial rows.
- [ ] Admin role is downgraded while two credentials exist: blocked until one is selected/revoked.
- [ ] User deactivation or security edit: all sessions and sockets revoked; held-order claim behavior remains unchanged.
- [ ] Cashier shift closes: all that user’s sessions are revoked as today.
- [ ] Admin force-closes another shift: target user sessions are revoked as today; actor’s unrelated session remains.
- [ ] Recovery code is wrong, expired, reused, or brute-forced: denied/rate-limited with generic response.
- [ ] Recovery registration fails: old state is not partially destroyed.
- [ ] Enrollment/recovery code is absent from query strings, route params, HTTP access logs, browser storage, referrers, analytics, and error reports.
- [ ] Generic system settings GET/POST cannot expose or mutate authentication mode/bootstrap state.
- [ ] All admin devices lost: rehearsed recovery works without disabling enforcement.
- [ ] RP domain/origin changes: login fails closed and documented recovery/re-enrollment procedure is used.
- [ ] `http://localhost:<configured-port>` works for isolated local validation; LAN IP and ordinary HTTP cannot enable enforcement.
- [ ] Database dump exposes public keys and hashes only, not private keys, raw session tokens, bootstrap secret, or recovery codes.
- [ ] Logs, audits, telemetry, screenshots, and validation artifacts never contain WebAuthn responses, challenges, credential IDs, session tokens, enrollment codes, or recovery codes. Credential IDs appear only where required in the TLS-protected WebAuthn exchange and restricted server-side credential storage/processing.
- [ ] Existing call-center, held-order, split-check, receipt-tax, checkout, and spooler invariants remain unchanged.

---

## Final Acceptance Gate

The feature may be called ready only when all are true:

- [ ] Correct PIN alone can never create a session in `enforced` mode.
- [ ] Every enforced session is linked to one active verified WebAuthn credential.
- [ ] Verified backup eligibility is single-device and backup state is false for every active credential.
- [ ] Privileged cap 2 and all-other-role cap 1 are transactionally enforced, not UI-only.
- [ ] Admin replacement/revocation/recovery are understandable, tested, auditable, and immediately effective.
- [ ] Existing installations upgrade without altering products, categories, orders, users, grants, held orders, or printer data; only ephemeral legacy session hashes are migrated.
- [ ] Stable HTTPS origin configuration is explicit and exact; unsupported LAN origins remain safely disabled.
- [ ] Real-device evidence exists for every device/browser family advertised as supported; the minimum matrix covers Windows Chrome/Edge, iPhone Safari, and Android Chrome. Untested or synced-only combinations remain explicitly unsupported.
- [ ] The dependency-changing release is packaged as a server runtime transition; spooler artifacts remain untouched.
- [ ] Production activation is a separate explicit operation with its own backup, health, release-identity, schema, login, replacement, recovery, and root-route checks.
