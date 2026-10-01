# Silent Browser Device Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing one-device-per-staff and two-device-per-privileged-user controls while replacing Windows Hello/WebAuthn prompts with silent proof from a non-exportable browser key.

**Architecture:** The browser creates one ECDSA P-256 key pair per POS origin, stores the non-exportable private `CryptoKey` in IndexedDB, and exports only its public JWK. Existing durable one-use ceremonies provide exact-origin challenges. Enrollment binds the public key to a user's existing device slot; login and administrative step-up sign a server-generated challenge without Windows Hello, a Windows PIN, a Google account, or a synced passkey. Existing credential/session/recovery tables remain in place to avoid a needless database migration; their historical `webauthn_*` names are treated as storage compatibility names.

**Tech Stack:** Vue 3, browser Web Crypto and IndexedDB, Express, Node.js `crypto`, MySQL/MariaDB, Vitest, Supertest, Playwright.

## Global Constraints

- Keep current device limits: one active device for cashier, waiter, table manager, and call center; two for admin and programmer.
- Preserve disabled, staged, and enforced modes, bootstrap, enrollment, replacement, revocation, recovery codes, audit events, durable sessions, and exact Socket.IO eviction.
- PIN remains the familiar user selector. Enforced login requires both the PIN-selected user and a valid signature from one of that user's registered browser keys.
- Never store a private browser key, enrollment code, recovery code, bootstrap secret, PIN, or session token in the database, logs, URLs, or application storage.
- Keep enrollment codes in URL fragments and erase the fragment before contacting the API.
- Require configured exact origins and HTTPS, with the existing isolated `http://localhost` development exception.
- Do not add a dependency. Use native Web Crypto, IndexedDB, and Node.js `crypto`.
- Do not add a schema migration. Reuse the not-yet-merged registered-device tables and their credential/session foreign keys.
- Do not implement MAC-address collection, browser fingerprinting, Google-synced passkeys, spooler-key authentication, or required DBSC.
- DBSC is deferred because the 17 April 2026 specification is an editor's draft and its browser-specific refresh/fallback behavior is not a reliable cross-browser authorization boundary.

## Evidence and attack record

- WebAuthn/passkeys require an authenticator ceremony and commonly invoke Windows Hello or a password-manager PIN. Google Password Manager passkeys sync between devices, so they cannot enforce one physical browser slot.
- A MAC address is not available to a public web origin and would require a native/extension/local-network component; it is also spoofable.
- A bearer device cookie alone can be copied. The design therefore requires a per-ceremony signature from a non-exportable browser private key.
- Web Crypto does not normatively guarantee hardware storage. This design truthfully binds to the browser profile, not immutable physical hardware. Clearing site data requires re-enrollment; copying an entire compromised profile remains outside browser-only guarantees.
- IndexedDB does not synchronize as a passkey provider does. A shared POS browser can reuse the same key for several user bindings; each user's database row and slot remains independent.
- Unknown-user login creates a decoy ceremony and returns the same public failure shape as a known user with no matching key.
- One-use, row-locked ceremonies stop signature replay. The signed message includes protocol version, action, exact origin, ceremony ID, user-bound opaque subject, and random challenge to prevent cross-flow and cross-origin reuse.
- Replacement and recovery remain transactional: the old credential is revoked only after the new public key and proof are accepted.
- Credential revocation keeps exact session/socket eviction. A copied old assertion cannot create a new session after its ceremony or credential is consumed/revoked.

---

### Task 1: Browser-key cryptographic boundary

**Files:**
- Create: `backend/services/browserDeviceCrypto.js`
- Create: `backend/tests/unit/browserDeviceCrypto.test.js`
- Modify: `backend/services/webauthn/policy.js`
- Modify: `backend/tests/unit/webauthnPolicy.test.js`

**Interfaces:**
- Produces: `normalizePublicJwk(jwk)`, `serializePublicJwk(jwk)`, `parseStoredPublicJwk(buffer)`, `buildDeviceProofMessage(input)`, `verifyDeviceProof(input)`, and `newCredentialId()`.
- Consumes: native Node.js `crypto` only.

- [ ] **Step 1: Write failing unit tests**

Test P-256 JWK validation, rejection of private `d`, wrong curves, malformed coordinates, exact canonical message construction, valid IEEE-P1363 ECDSA proof, changed action/origin/challenge rejection, and random credential IDs.

- [ ] **Step 2: Run RED**

Run: `npx vitest run backend/tests/unit/browserDeviceCrypto.test.js backend/tests/unit/webauthnPolicy.test.js`

Expected: FAIL because `browserDeviceCrypto.js` and the browser-device policy do not exist.

- [ ] **Step 3: Implement the minimal native cryptographic boundary**

Use `crypto.createPublicKey({ key: jwk, format: 'jwk' })` and `crypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature)`. Accept only `EC`, `P-256`, 32-byte base64url `x` and `y`, and no private `d`. Bound message format:

```text
posapp-browser-device-v1\n<action>\n<origin>\n<ceremony-id>\n<subject>\n<challenge>
```

- [ ] **Step 4: Run GREEN**

Run the same Vitest command and require zero failures.

### Task 2: Browser IndexedDB key client

**Files:**
- Create: `src/shared/browserDeviceClient.js`
- Create: `src/shared/__tests__/browserDeviceClient.spec.js`
- Delete: `src/shared/webauthnClient.js`
- Delete: `src/shared/__tests__/webauthnClient.spec.js`

**Interfaces:**
- Produces: `isBrowserDeviceSupported()`, `getOrCreateBrowserPublicKey()`, `signBrowserDeviceMessage(message)`, `authenticateRegisteredDevice(userNumber)`, enrollment, recovery, and step-up functions matching existing UI callers.
- Consumes: `window.crypto.subtle`, IndexedDB, and existing `fetchJson`.

- [ ] **Step 1: Write failing client tests**

Use injected fake storage/crypto boundaries to prove one key is reused, private key export is never requested, enrollment sends only public JWK plus signature, login signs the server's exact message, and missing/deleted browser keys produce stable `BROWSER_DEVICE_KEY_MISSING` errors without inventing identity.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/shared/__tests__/browserDeviceClient.spec.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement minimal IndexedDB and Web Crypto code**

Create one non-exportable ECDSA P-256 private key and export only the public key. Store the `CryptoKeyPair` under one fixed origin-scoped IndexedDB key. Sign UTF-8 messages with ECDSA/SHA-256 and send base64url IEEE-P1363 signatures.

- [ ] **Step 4: Run GREEN**

Run the same Vitest command and require zero failures.

### Task 3: Replace WebAuthn server ceremonies

**Files:**
- Modify: `backend/routes/auth/webauthn.js`
- Modify: `backend/services/deviceAccess.js`
- Modify: `backend/services/webauthn/credentials.js`
- Modify: `backend/services/webauthn/ceremonies.js`
- Modify: `backend/services/staffSessions.js`
- Modify: `backend/services/webauthn/config.js`
- Delete: `backend/services/webauthn/adapter.js`
- Modify: `backend/tests/integration/webauthnDeviceAccess.test.js`
- Create: `backend/tests/integration/browserDeviceProof.test.js`
- Delete: `backend/tests/unit/webauthnAdapter.test.js`

**Interfaces:**
- Login options return `{ ceremony_id, message }` with uniform decoy behavior.
- Verification accepts `{ ceremony_id, signature }`; registration additionally accepts `{ public_key }`.
- Stored `public_key` is canonical UTF-8 JWK JSON; `credential_id` remains a random server identifier and existing numeric row IDs continue binding sessions.

- [ ] **Step 1: Write failing integration tests**

Cover valid silent login, wrong key, changed origin, changed action, changed challenge, replay, unknown user, revoked credential, one-versus-two device limits, concurrent final-slot enrollment, replacement rollback, recovery rollback, step-up bound to the current session credential, and shared-browser public key bound independently to two users.

- [ ] **Step 2: Run RED**

Run: `npx vitest run backend/tests/unit/browserDeviceCrypto.test.js backend/tests/integration/browserDeviceProof.test.js backend/tests/integration/webauthnDeviceAccess.test.js`

Expected: new browser-device flows fail against WebAuthn routes.

- [ ] **Step 3: Replace only the ceremony verification boundary**

Keep throttles, row locks, transactions, mode checks, session creation, recovery, auditing, and socket eviction. Replace SimpleWebAuthn option generation/verification with canonical signed messages and Node verification. Update `last_used_at` only after valid proof. Rename public error copy to registered-browser language while keeping stable compatibility codes where changing them adds no safety.

- [ ] **Step 4: Run GREEN**

Run the same focused command and require zero failures.

### Task 4: Update UI and remove prompt-specific configuration

**Files:**
- Modify: `src/components/Login.vue`
- Modify: `src/components/DeviceEnrollment.vue`
- Modify: `src/components/DeviceRecovery.vue`
- Modify: `src/admin/components/settings/DeviceAccessSettings.vue`
- Modify: `src/shared/i18n/ar.json`
- Modify: component contract tests under `src/components/__tests__` and `src/admin/pages/__tests__`
- Modify: `deployment/templates/hostinger.env.template`
- Modify: `deployment/templates/pos.env.template`
- Modify: `backend/tests/unit/installerWebAuthnConfig.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `playwright.webauthn.config.mjs`
- Create: `playwright.browser-device.config.mjs`

**Interfaces:**
- UI imports the new browser-device client.
- Enrollment button silently creates/reuses the browser key; no text promises a Windows/browser prompt.
- Configuration retains exact allowed-origin and bootstrap-secret compatibility, but RP name/ID are no longer runtime requirements.

- [ ] **Step 1: Update failing UI/config contracts**

Assert no production/client import of `@simplewebauthn`, no Windows/passkey prompt copy, exact origin remains required, and the bootstrap secret remains server-managed.

- [ ] **Step 2: Run RED**

Run the focused frontend and installer-config tests and confirm failures reference old WebAuthn behavior.

- [ ] **Step 3: Implement minimal UI/config changes and remove both SimpleWebAuthn dependencies**

Keep page structure and device-management actions unchanged. Replace only capability checks, calls, and text. Regenerate the lockfile through `npm uninstall @simplewebauthn/browser @simplewebauthn/server`.

- [ ] **Step 4: Run GREEN**

Run focused frontend/config tests and require zero failures.

### Task 5: Attack, browser verification, and architecture truth

**Files:**
- Modify: `tests/e2e/specs/webauthn-device-access.spec.js`
- Modify or delete: `tests/e2e/webauthn-web-server.cjs`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Create: `docs/superpowers/evidence/2026-08-13-silent-browser-device-access-validation.md`

**Interfaces:**
- E2E creates two isolated browser contexts to prove a registered key in context A cannot authenticate from context B, while the same key can bind several users without bypassing per-user limits.

- [ ] **Step 1: Run adversarial focused tests**

Attempt replay, altered messages, copied public keys without private keys, deleted IndexedDB keys, revoked credentials, two concurrent enrollments, cross-origin requests, stale sessions, and a second clean browser context.

- [ ] **Step 2: Run proportional repository verification**

Run focused unit/integration suites, the device-access E2E project, `npm run build:admin`, `npm run architecture:check`, schema authority/drift checks, and installer configuration contracts. Do not run unrelated business-domain suites unless a shared failure requires it.

- [ ] **Step 3: Update architecture and validation evidence**

Replace WebAuthn-specific invariants with exact browser-key guarantees and limitations. Regenerate architecture HTML and record commands/results without secrets or customer data.

- [ ] **Step 4: Review and commit**

Inspect `git diff --check`, search for stale runtime SimpleWebAuthn imports and prompt copy, verify the intended file list, then commit the complete scoped replacement.
