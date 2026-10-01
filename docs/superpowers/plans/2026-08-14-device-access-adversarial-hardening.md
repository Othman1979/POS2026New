# Device Access Adversarial Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every confirmed authentication and staged-spooler defect from the 2026-08-14 adversarial review without adding a migration, dependency, recovery workflow, or production deployment step.

**Architecture:** Keep the existing browser-key and durable-session design. Make `programmer` a strictly PIN-only maintenance identity at every device-credential boundary, replace blanket proxy trust with an explicit allowlist, make login-option limits indistinguishable for known and unknown identifiers, revalidate cached sessions authoritatively on their existing 60-second touch, and bound spooler warm-up/launch waits. Preserve the updater's runtime-before-core attestation gate and byte-identical `spooler.env` handling.

**Tech Stack:** Node.js 22, Express 5, Vue 3, MySQL/MariaDB, Vitest/Supertest, Windows PowerShell updater, Puppeteer Headless Shell.

## Global Constraints

- Work only on `codex/webauthn-device-access`; do not merge, push, deploy, migrate production, rebuild installers, or change Hostinger settings.
- Preserve customer data, secrets, `spooler.env`, unrelated user changes, and the existing staged spooler work.
- Do not add a schema migration or npm dependency.
- The programmer identity remains hidden, superuser-equivalent, PIN-only, usable from any browser, and audited on every successful login.
- Ordinary staff retain the familiar numeric-login workflow and existing browser-approval UX.
- Keep selective 401 interception: session failures redirect; domain authentication failures must reach their caller.
- Keep `programmer` allowed to administer other users' device access without browser step-up, but never allow a programmer credential, programmer-bound session, or programmer browser-key login.
- Direct Windows/LAN installations default to no trusted proxy. Hosted deployments must explicitly configure the exact immediate proxy address/CIDR; `true`, hop counts, and broad private-network aliases are forbidden.
- Browser-login options use a 60-second fixed window: 60 requests per resolved client IP, 12 requests per resolved client IP plus SHA-256 identifier, and at most 500 globally pending, unexpired authentication ceremonies.
- Runtime updater must precede core updater whenever runtime attestation differs; do not weaken this gate.
- Follow focused RED/GREEN cycles and commit spooler and authentication work separately.

## Evidence and accepted scope

- Express documents that `trust proxy: true` accepts the left-most `X-Forwarded-For` value and is unsafe unless the final trusted proxy overwrites all forwarded headers: <https://expressjs.com/en/guide/behind-proxies/>.
- A local runtime probe confirmed the current app behavior: a supplied `X-Forwarded-For` became `req.ip` while `req.socket.remoteAddress` remained loopback.
- OWASP requires generic authentication responses and recommends throttling that cannot be bypassed merely by changing source IP: <https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html>.
- The current `/login/options` uses per-user pending rows for real users but one shared decoy bucket for unknown users. Four decoys therefore create a stable status-code oracle.
- `ROLE_LIMITS.programmer` is `2`; `getActiveUser` and `completeRegistration` accept programmer; `/login/verify` accepts any matching eligible credential. This directly contradicts the documented PIN-only programmer boundary.
- `touchSession` checks only session expiry/revocation, while `findActiveSession` also checks active user, eligible credential, enforced mode, and role. Current mutators revoke correctly, but the cache path is structurally weaker.
- Puppeteer documents a 30-second launch timeout and 180-second protocol timeout, but the staged warm-up barrier has no independent deadline. A barrier-only timeout is insufficient because `processPrintJob` immediately awaits the same launch promise again.
- The spooler updater already verifies exact runtime attestation before applying a core payload, so the layer-order concern needs verification, not a redesign.

## Deliberately rejected changes

- Do not redirect every internal HTTP 401. That would turn wrong manager PIN, unregistered browser, and failed browser proof into false "session expired" redirects.
- Do not add a recovery page, manager recovery PIN, CAPTCHA, Redis, a new rate-limit package, or a ceremony schema column.
- Do not merely add `programmer_login` to browser-key login. The correct invariant is that browser-key login for programmer cannot exist; numeric programmer login remains the sole audited path.
- Do not use only a one-line warm-up `Promise.race`. Browser launch itself must be bounded and its cached promise reset after failure.
- Do not trust `linklocal`, `uniquelocal`, `true`, or a numeric hop count. Those settings can let direct LAN clients or shorter proxy paths supply forwarded values.

## Adversarial self-review prompt

> Attack this plan as an unauthenticated internet client, a direct LAN client, a malicious authenticated programmer, a compromised administrator session, a stale browser session, a crafted database row, and a low-resource Windows spooler. For authentication, test fresh and existing installations; 8-, 12-, and oversized numeric inputs; known, unknown, inactive, programmer, and ordinary users; zero, four, and globally saturated pending ceremonies; rotated `X-Forwarded-For` and spoofed `X-Forwarded-Proto`; direct sockets and explicitly trusted proxies; staged/enforced mode transitions; programmer credentials inserted directly in the database; programmer ceremonies created without the normal route; user deactivation, credential revocation, and mode flips while a token is cached; enrollment-code mismatches; removed recovery actions; and every response-code/timing discrepancy that could enumerate an identity. For printing, hang browser launch, hang warm-up after launch, resolve a timed-out launch late, fail warm-up normally, start the first print concurrently, retry after failure, and verify exactly one print, alert, cut, acknowledgement, correct band order, and unchanged `spooler.env`. Attack updater order in both runtime-first and core-first sequences. Reject any repair that needs a new table, new dependency, production fact, secret, broad proxy trust, recovery path, or hidden behavior change.

## Attack results and corrections applied to this plan

1. **Direct service bypass found:** changing only the UI/list or `ROLE_LIMITS` is insufficient. The plan excludes programmer inside `getActiveUser`, `getUserByNumber`, capacity policy, registration completion, browser login, and durable session eligibility.
2. **Legacy-row bypass found:** a manually inserted programmer credential could otherwise keep an already cached or durable session. The plan makes authoritative session lookup/touch reject credential-bound programmer sessions.
3. **Oracle fix bypass found:** per-identifier decoy buckets alone stop the four-decoy oracle but still allow unlimited distinct-candidate requests. The plan adds both client-IP and client-IP-plus-hashed-identifier fixed-window limits, plus one identity-neutral global pending cap.
4. **Proxy alternative rejected:** using raw socket addresses only would collapse every hosted client onto one reverse-proxy address. The plan keeps Express's standard proxy resolution but requires an explicit exact proxy allowlist and defaults to direct mode.
5. **HTTPS bypass found:** changing `trust proxy` while continuing to read raw `X-Forwarded-Proto` would preserve header spoofing. HTTPS enforcement must use `req.protocol` after the explicit trust policy.
6. **Credential entropy gap found:** eight decimal digits are too small for a universal, single-factor maintenance credential. Fresh installers will generate twelve digits; ordinary user PIN limits remain unchanged.
7. **Warm-up fix bypass found:** timing out only the barrier still re-awaits a hung launch. Browser launch receives an AbortSignal plus an outer deadline; a timed-out promise is cleared and a late browser is closed. Warm-up itself falls open after its own deadline.
8. **Updater split re-checked:** runtime attestation already blocks core-first transitions. Preserve and rerun its focused contracts; no updater rewrite is warranted.
9. **Interceptor claim rejected:** the current selective session-error codes are the correct boundary. No interceptor change is planned.
10. **Bootstrap authority clarified:** programmer may administer bootstrap settings, but may not bootstrap a credential for itself because all target resolution rejects the role.
11. **Expired-cap denial found:** counting by recent issue time would let already expired pending rows block every identity. The global cap counts only pending ceremonies whose `expires_at` is still in the future.

---

### Task 1: Bound staged spooler startup without weakening print correctness

**Files:**
- Modify: `pos-spooler-printer/server.js`
- Modify: `pos-spooler-printer/tests/spooler-report-rendering.test.js`
- Verify: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Consumes: existing `getBrowserInstance()`, `warmRenderingPipeline()`, `startupWarmupPromise`, and runtime-before-core updater attestation.
- Produces: bounded `launchBrowser()`, `withTimeout()`, and `startupWarmupBarrier`; no new package or environment requirement.

- [x] **Step 1: Write failing tests for a hanging warm-up and hanging browser launch**

Extend the existing spooler harness so a first warm-up render can remain pending while a later print render succeeds, and so a launch promise can remain pending. Set tiny test-only environment deadlines before loading the module. Assert that warm-up timeout releases the first print, launch timeout rejects instead of hanging, the next call retries launch, and late resolution closes the abandoned browser.

- [x] **Step 2: Run the focused spooler test and verify RED**

Run: `node pos-spooler-printer/tests/spooler-report-rendering.test.js`

Expected: timeout assertions fail because `startupWarmupBarrier` and `getBrowserInstance` are currently unbounded outside Puppeteer's own implementation.

- [x] **Step 3: Implement the minimum bounded waits**

Use `AbortController`, Puppeteer's documented `signal` and `timeout` launch options, one small `withTimeout(promise, ms, message)` helper that clears its timer, identity-check the cached launch promise in `finally`, close a browser that resolves after abandonment, and make the startup barrier log then fall open. Do not cancel or duplicate a successful shared launch.

- [x] **Step 4: Run focused GREEN verification**

Run: `node pos-spooler-printer/tests/spooler-report-rendering.test.js`

Expected: PASS, including existing one-browser, one-page-at-a-time, band-order, one-alert, one-cut, and no-second-PNG-decode assertions.

- [x] **Step 5: Run spooler package/updater contracts and commit the isolated staged spooler work**

Run:

```powershell
Push-Location pos-spooler-printer; npm test; Pop-Location
npx vitest run backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js
git diff --check
```

Expected: all focused commands pass; core-first runtime mismatch remains blocked; `spooler.env` mutation remains absent.

Commit only the already staged spooler scope plus this timeout correction as `fix: harden low-resource spooler rendering`.

### Task 2: Replace blanket proxy trust and strengthen the fresh programmer credential

**Files:**
- Create: `backend/config/trustProxy.js`
- Create: `backend/tests/unit/trustProxy.test.js`
- Create: `backend/tests/integration/loginProxyTrust.test.js`
- Modify: `server.js`
- Modify: `deployment/templates/pos.env.template`
- Modify: `deployment/templates/hostinger.env.template`
- Modify: `deployment/tools/installer-config.js`
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `deployment/tools/verify-install.js`
- Modify: `backend/tests/unit/installerConfig.test.js`
- Modify: `backend/tests/integration/installerBaseline.test.js`
- Modify: `src/components/Login.vue`
- Modify: `src/components/__tests__/loginWebAuthn.spec.js`

**Interfaces:**
- Produces: `readTrustProxySetting(raw)` returning `false` or an array containing only `loopback` and exact IP/CIDR entries.
- Preserves: ordinary admin/staff PINs at 1-8 digits; only fresh programmer generation becomes 12 digits.

- [x] **Step 1: Write failing unit and integration tests**

Assert that blank/`false` proxy configuration returns `false`; `true`, `all`, hop counts, `linklocal`, `uniquelocal`, wildcards, and malformed CIDRs throw; exact IPv4/IPv6/CIDR and `loopback` values pass. Against the actual Express app, send the configured failed-login limit plus one requests with a constant candidate and rotating `X-Forwarded-For`; the final request must be 429 because forwarded input is untrusted by default. Assert the login UI permits 12 digits, installer generation returns 12 digits, bootstrap rejects other lengths, and install verification expects one 12-digit programmer.

- [x] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run backend/tests/unit/trustProxy.test.js backend/tests/integration/loginProxyTrust.test.js backend/tests/unit/installerConfig.test.js backend/tests/integration/installerBaseline.test.js src/components/__tests__/loginWebAuthn.spec.js
```

Expected: current `trust proxy: true`, 8-digit generation, and 8-digit UI cap fail the new assertions.

- [x] **Step 3: Implement explicit proxy policy and 12-digit programmer generation**

Set `app.set('trust proxy', readTrustProxySetting(process.env.TRUST_PROXY))`; use only `req.protocol` for HTTPS enforcement; add non-secret template guidance with direct mode as the default and a blank hosted placeholder that must be filled with a verified immediate proxy address before deployment. Generate the programmer with `generateNumericCode(12)`, validate `^[1-9][0-9]{11}$`, and raise only the login screen input cap to 12. Existing installations and ordinary staff numbers remain accepted at their current lengths; this is fresh-install entropy hardening, not a credential rotation.

- [x] **Step 4: Run GREEN verification**

Run the Step 2 command again. Expected: all focused tests pass, including the runtime rotated-forwarded-header proof.

### Task 3: Make programmer strictly PIN-only at every credential and session boundary

**Files:**
- Modify: `backend/services/webauthn/policy.js`
- Modify: `backend/services/deviceAccess.js`
- Modify: `backend/services/staffSessions.js`
- Modify: `backend/tests/unit/webauthnPolicy.test.js`
- Modify: `backend/tests/integration/webauthnDeviceAccess.test.js`
- Modify: `backend/tests/integration/browserDeviceProof.test.js`

**Interfaces:**
- `maxCredentialsForRole('programmer')` returns `0`.
- Device-access user lookup returns no programmer target.
- Durable session lookup/touch rejects `role='programmer'` whenever `credential_id IS NOT NULL`.

- [x] **Step 1: Write failing hostile tests**

Add tests proving a programmer cannot start enrollment for itself, cannot complete a forged/direct ceremony, is treated as a decoy by browser-login options, cannot obtain a browser-key session from a directly inserted credential, and cannot keep a directly inserted credential-bound durable session. Preserve the passing test that programmer PIN login works, emits `programmer_login`, and can administer another user's devices without step-up.

- [x] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run backend/tests/unit/webauthnPolicy.test.js backend/tests/integration/webauthnDeviceAccess.test.js backend/tests/integration/browserDeviceProof.test.js
```

Expected: current role limit, target lookup, registration completion, and browser-key login accept the programmer and fail the new assertions.

- [x] **Step 3: Implement defense in depth**

Set programmer capacity to zero with stable `WEBAUTHN_ROLE_UNSUPPORTED`; exclude programmer in both device-access user lookup functions; retain capacity checks in start and completion; and reject programmer credential sessions in both authoritative session query paths. Do not remove the programmer bypass from `requireRecentStepUp`, because it still administers ordinary users.

- [x] **Step 4: Run GREEN verification**

Run the Step 2 command again. Expected: hostile tests pass and the existing numeric programmer administration/audit test remains green.

### Task 4: Remove the login-options oracle and strengthen cached-session revalidation

**Files:**
- Create: `backend/services/requestThrottle.js`
- Create: `backend/tests/unit/requestThrottle.test.js`
- Modify: `backend/routes/auth/webauthn.js`
- Modify: `backend/services/staffSessions.js`
- Modify: `backend/services/webauthn/ceremonies.js`
- Modify: `backend/services/browserDeviceCrypto.js`
- Modify: `backend/tests/integration/browserDeviceProof.test.js`
- Modify: `backend/tests/integration/webauthnDeviceAccess.test.js`
- Modify: `backend/tests/unit/staffSessions.test.js`
- Modify: `backend/tests/unit/browserDeviceCrypto.test.js`

**Interfaces:**
- Options throttling consumes a 60-per-minute IP bucket and a 12-per-minute IP-plus-SHA-256-identifier bucket before user lookup.
- Outstanding authentication count is one global, identity-neutral cap of 500 pending, unexpired ceremonies.
- `touchSession(id)` applies the same user/credential/mode/programmer eligibility as `findActiveSession`.
- `constantTimeOpaqueHashEquals(left, right)` compares fixed SHA-256 digests safely.

- [x] **Step 1: Write failing oracle, cache, and comparison tests**

After four unknown option requests, assert a new unknown and a known user receive the same successful response shape. Unit-test the fixed-window helper with 60 distinct identifier keys sharing one IP: request 61 must fail at the IP bucket while request 13 for one identifier fails at the narrower bucket; advance the injected clock past 60 seconds and assert both reset. Insert 500 pending authentication ceremonies directly and assert known and unknown requests receive the same 429 code and public body; expire all 500 and assert options immediately work again. Directly deactivate a user, revoke a credential, flip staged to enforced, and create a programmer credential session without calling normal revocation helpers; each subsequent `touchSession` must return false. Assert constant-time digest comparison accepts equal hashes, rejects unequal/malformed values, and the removed recovery action is not accepted.

- [x] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run backend/tests/unit/requestThrottle.test.js backend/tests/integration/browserDeviceProof.test.js backend/tests/integration/webauthnDeviceAccess.test.js backend/tests/unit/staffSessions.test.js backend/tests/unit/browserDeviceCrypto.test.js
```

Expected: the four-decoy response diverges, `touchSession` accepts bypassed ineligible rows, and recovery/timing cleanup assertions fail.

- [x] **Step 3: Implement uniform limits and authoritative touch**

Implement one small dependency-free fixed-window helper with an injectable clock and bounded stale-entry cleanup. Hash identifiers before using them as in-memory keys; enforce the exact 60/12 per-minute limits; replace the per-user/decoy pending count with the exact global cap of 500; preserve identical public responses. Join users/credentials in `touchSession` and apply the same eligibility predicates as `findActiveSession`. Move fixed-hash comparison into `ceremonies.js`, use it for enrollment verification, remove the dead recovery public message, and remove `recovery_registration` from browser proof actions.

- [x] **Step 4: Run GREEN verification**

Run the Step 2 command again. Expected: all focused security tests pass without schema changes.

### Task 5: Documentation, full scoped verification, and authentication commit

**Files:**
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Modify: `docs/2026-08-14-fable-branch-handoff.md`
- Add: `docs/superpowers/evidence/2026-08-14-webauthn-device-access-adversarial-review.md`
- Add: `docs/superpowers/plans/2026-08-14-device-access-adversarial-hardening.md`

- [x] **Step 1: Update architecture and handoff truthfully**

Document the explicit proxy trust boundary, 12-digit programmer seed, strict PIN-only programmer invariant, identity-neutral option limiting, authoritative session touch, bounded spooler warm-up, accepted residual risks, and the fact that no deployment or production migration occurred. Preserve the external review as historical evidence; do not rewrite its original claims.

- [x] **Step 2: Regenerate and verify architecture**

Run:

```powershell
npm run architecture
npm run architecture:check
```

Expected: generated HTML matches JSON and every referenced file/line is valid.

- [x] **Step 3: Run final scoped verification**

Run:

```powershell
npx vitest run backend/tests/unit/trustProxy.test.js backend/tests/integration/loginProxyTrust.test.js backend/tests/unit/installerConfig.test.js backend/tests/integration/installerBaseline.test.js src/components/__tests__/loginWebAuthn.spec.js backend/tests/unit/webauthnPolicy.test.js backend/tests/integration/webauthnDeviceAccess.test.js backend/tests/unit/requestThrottle.test.js backend/tests/integration/browserDeviceProof.test.js backend/tests/unit/staffSessions.test.js backend/tests/unit/browserDeviceCrypto.test.js backend/tests/integration/webauthnSocketRevocation.test.js
npm run build:admin
Push-Location pos-spooler-printer; npm test; Pop-Location
npx vitest run backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js
npm run architecture:check
git diff --check
```

Expected: zero failed tests, successful admin build, successful spooler checks, valid architecture, and no whitespace errors.

- [x] **Step 4: Review final diff against the attack prompt**

Confirm no `trust proxy: true`, raw forwarded-proto trust, programmer credential capacity/path, per-user-vs-decoy pending query, recovery runtime action, unbounded startup barrier, new migration, new dependency, secret, production mutation, updater gate regression, or `spooler.env` write exists.

- [x] **Step 5: Commit authentication hardening**

Stage only the authentication, installer, documentation, and test files from Tasks 2-5. Commit as `fix: close device access adversarial gaps`. Do not merge, push, or deploy.
