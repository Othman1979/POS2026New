# Fable branch handoff: registered-browser access and staged spooler hardening

Generated: 2026-08-14
Repository: `C:\xampp\htdocs\posapp`
Branch: `codex/webauthn-device-access`

## 1. Executive state

This branch contains two separately committed bodies of work:

1. **Authentication/device-access work**, including the adversarial hardening that accompanies this handoff.
2. **Low-resource spooler performance work**, isolated in commit `8d87a317`.

Do not review, merge, or deploy them as though they are one feature.

| Item | Current value |
| --- | --- |
| Pre-hardening branch HEAD | `8d87a317` |
| Local `master` / `origin/master` | `4d9cbbb9542817d1a55e1dfeb7e7e072a10a1439` |
| Merge base | `4d9cbbb9542817d1a55e1dfeb7e7e072a10a1439` |
| Branch commits ahead at this handoff | 11 |
| Branch published to origin | No; `origin/codex/webauthn-device-access` does not exist |
| Spooler hardening commit | `8d87a317` |
| Server version | `1.0.6` |
| Spooler version | `1.2.6` |
| Intended working tree after the handoff commit | Clean |

Nothing in this report proves production deployment, production migration, environment mutation, or physical-printer success.

## 2. Commit chain

In chronological order:

| Commit | Purpose |
| --- | --- |
| `0a5e3d16` | Initial registered-device/WebAuthn schema, sessions, routes, UI, tests, and installer support |
| `6c84869c` | Restored strict schema-drift parity |
| `58b23bf4` | Added unrelated infrastructure hardening plan documents |
| `651189d6` | Replaced authenticator-prompt login with silent registered-browser cryptography |
| `99a9291a` | Simplified Device Access settings UI |
| `1a2d0ab2` | Added automatic browser-request creation and administrator approval |
| `a71f0143` | Hardened login, sessions, socket revocation, approval resume/cancel, errors, and hostile paths |
| `fb83e87f` | Added hidden programmer maintenance access and removed device recovery |
| `3f64c947` | Recorded the long-report raster-corruption diagnosis |
| `8d87a317` | Hardened the low-resource spooler renderer, bounded startup stalls, and preserved updater layer ordering |
| handoff commit | Closed the adversarial device-access findings and recorded the evidence, plan, and current verification |

`58b23bf4` is documentation scope creep relative to device access. Do not mistake its Hostinger/spooler plans for implementation in this branch.

## 3. Final authentication design — ignore the obsolete WebAuthn framing

The branch name, migration names, and first implementation plan still say “WebAuthn.” That is historical naming. The **current runtime does not invoke Windows Hello, Windows PIN, Touch ID, or a passkey manager**.

The final design is:

- The browser generates one ECDSA P-256 key pair for the POS origin using native Web Crypto.
- The private key is non-exportable and stored in IndexedDB.
- The server stores only the public JWK.
- Login, enrollment completion, and security step-up sign durable, one-use, exact-origin challenges.
- A clean browser profile cannot authenticate as a user registered in another profile because it lacks the private key.
- Clearing site data deletes the key and requires browser registration again.

This is **browser-profile binding**, not MAC binding, immutable physical-device identity, TPM attestation, or protection from software controlling the registered browser profile.

The branch deliberately removed `@simplewebauthn/browser` and `@simplewebauthn/server`; it uses browser Web Crypto, IndexedDB, and Node's built-in `crypto` only.

Primary implementation files:

- `src/shared/browserDeviceClient.js`
- `backend/services/browserDeviceCrypto.js`
- `backend/routes/auth/webauthn.js`
- `backend/services/webauthn/ceremonies.js`
- `backend/services/webauthn/credentials.js`
- `backend/services/staffSessions.js`
- `backend/routes/admin/deviceAccess.js`
- `src/admin/components/settings/DeviceAccessSettings.vue`
- `src/components/Login.vue`

The `webauthn_*` database/table/file names remain for schema compatibility. Renaming them would add migration risk without changing security.

## 4. User flow

### Authentication modes

- `disabled`: ordinary PIN login works. Device Access can bootstrap the first administrator browser.
- `staged`: ordinary users can still log in by PIN. A first login from an unregistered browser automatically creates a browser approval request.
- `enforced`: ordinary users need the correct PIN and proof from a registered browser key.

Only `staged -> enforced` is available through ordinary Device Access settings. Enabling enforcement revokes active PIN-only sessions.

### First privileged browser

1. Configure an exact allowed HTTPS origin, or `http://localhost:<port>` for isolated local development.
2. Configure a high-entropy `DEVICE_AUTH_BOOTSTRAP_SECRET` outside Git.
3. Log in as administrator while mode is disabled.
4. Open Settings → Device Access.
5. Enter the bootstrap secret and a browser label.
6. The current browser creates its key and becomes the first registered administrator browser.

The source templates include `DEVICE_AUTH_ALLOWED_ORIGINS`, but they do **not** generate or persist `DEVICE_AUTH_BOOTSTRAP_SECRET`. Hostinger/local operators must provision it securely before bootstrap.

### Ordinary cashier/staff browser

1. The user enters the familiar numeric PIN.
2. In staged mode, an unregistered browser automatically creates a pending approval request.
3. A registered administrator opens Device Access and approves the detected browser.
4. The waiting browser proves possession of the exact pending key and receives a bound session.
5. In enforced mode, another clean browser cannot log in as that user until access is replaced or revoked/registered by an administrator.

### Limits

- `cashier`, `waiter`, `table_manager`, and `call_center`: one active browser credential.
- `admin`: two active browser credentials.
- `programmer`: excluded from device binding entirely; see the next section.

## 5. Programmer maintenance access and recovery removal

Device recovery was removed from the login UI, router, client, service, and API routes. Tests assert that the removed endpoints return 404 and no recovery link exists.

The break-glass path is now a hidden `programmer` identity:

- It can log in by its numeric login from any browser without registered-browser proof.
- It remains subject to ordinary session expiry and one-session replacement.
- It can administer Device Access without browser step-up, but exact-origin checks remain.
- It cannot start or complete device enrollment, use browser-key login, or retain a credential-bound session even if rows are inserted directly.
- It is omitted from normal user and device-access lists.
- Admin APIs cannot create or assign the programmer role.
- Successful programmer login writes a security audit event.

### Seed behavior

The implemented programmer login is **not the previously discussed static `1062005` value**.

For a fresh Windows server installation:

- `installer-config.js` generates one random twelve-digit numeric programmer login.
- `bootstrap-database.js` inserts one administrator and one programmer only under the existing empty-user-table guard.
- The fresh installer shows the programmer login once in its completion result.
- It is not written to `.env` or installation metadata.
- Repair and updater paths do not rotate or reveal it.

Existing installations do not receive this programmer automatically through the WebAuthn migration. Adopting this branch on an existing customer requires an explicit, reviewed maintenance-user provisioning decision; do not silently insert one into production data.

Existing eight-digit programmer values are not rejected or rotated by runtime login. The twelve-digit rule applies only to newly generated fresh-install seeds.

### Security trade-off

The programmer login is an intentional universal browser-binding bypass. Whoever knows it has privileged remote access. It must be unique, stored privately by the operator, rate-limited through the normal login path, and treated as a break-glass credential—not a shared cashier/admin PIN.

## 6. Sessions and revocation invariants

The branch replaces the legacy single `users.session_token` model with durable `auth_sessions` rows:

- Raw session tokens remain cookie-only and are stored in the database only as hashes.
- Idle lifetime is 30 minutes; absolute lifetime is 12 hours.
- Registered-browser sessions reference a credential.
- Re-login revokes the prior session at the applicable user/credential boundary.
- User edits/deactivation, shift close, credential replacement/revocation, and enforcement transition revoke matching durable sessions.
- Revocation also evicts token-cache entries and disconnects matching Socket.IO session/credential rooms.
- Enforced sessions without a valid active credential are rejected, except for the programmer exemption.
- The periodic cache touch repeats the active-user, credential ownership/eligibility, enforced-mode, and PIN-only programmer checks instead of trusting a warm cache entry.

Do not accept a change that updates only the database but leaves HTTP cache or Socket.IO authority alive.

## 7. Database and deployment impact

The branch adds the migration ledger entry:

- Name: `2026-08-13-webauthn-registered-device-access-v1`
- Checksum: `20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09`
- Required predecessor: `2026-08-13-split-quantity-precision-v1`
- Normal, preflight, verify, `.auto.sql`, manifest, baseline, bootstrap, and Hostinger fallback surfaces are present.

The migration adds registered-credential, ceremony, recovery-history, and durable-session schema. Recovery runtime was later removed, but historical schema is intentionally not rewritten.

Deployment prerequisites:

- Exact `DEVICE_AUTH_ALLOWED_ORIGINS`; no paths, wildcards, credentials, duplicates, or direct IP addresses.
- HTTPS for non-localhost origins.
- `ENFORCE_HTTPS=true` when activating an online origin.
- `TRUST_PROXY=false` for direct/LAN installs. A hosted deployment must use the exact immediate reverse-proxy IP/CIDR; blanket `true`, hop counts, `linklocal`, and `uniquelocal` are rejected.
- A high-entropy `DEVICE_AUTH_BOOTSTRAP_SECRET` for first-browser bootstrap.
- Start in `disabled`, bootstrap, operate in `staged`, enroll users, then explicitly enable `enforced` only after readiness review.

Do not deploy this branch to production merely to “test the UI.” Server startup can run automatic migrations. Production migration, environment changes, and enforcement require separate explicit authorization.

## 8. Recorded device-access verification

The current hardening validation reports:

- 12 focused authentication/installer/session files: 77 tests passed.
- Spooler package and installer/updater contracts: 39 tests passed.
- Full spooler-owned test command passed, including hanging warm-up/launch, late-close, retry, band order, one-alert, one-cut, and acknowledgement coverage.
- Production Vite build passed with 302 modules transformed.
- Architecture check passed at 198 nodes, 52 flows, and 407 steps.
- Both working-tree and cached diff checks passed.

Earlier committed validation records report:

- Silent-browser focused verification: 19 files / 131 tests passed.
- Real-browser Playwright: non-exportable IndexedDB key creation, reload persistence, actual Vue login, replay rejection, and clean-profile rejection passed.
- Production Vite build passed with 303 modules transformed.
- Schema drift was zero at the validation point.
- Architecture check passed.
- Earlier migration/session/device/socket review recorded 137 focused tests across 14 files, isolated scratch migration tests, concurrent bootstrap and final-slot races, failed-safe replacement, and real Socket.IO revocation.

Evidence files:

- `docs/superpowers/evidence/2026-08-13-silent-browser-device-access-validation.md`
- `docs/superpowers/evidence/2026-08-13-webauthn-device-access-validation.md`

These are recorded results, not a substitute for rerunning the current branch after new edits.

### Manual validation still missing

The following real-device/browser matrix has not been completed:

- Windows Chrome
- Windows Edge
- iPhone Safari
- Android Chrome

The browser-crypto design should not trigger OS passkey prompts, but real mobile storage persistence, private/incognito behavior, site-data clearing, browser updates, and the full approve/revoke/re-register operator flow still need hands-on testing before production enforcement.

## 9. Committed low-resource spooler work

Commit `8d87a317` contains the isolated low-resource printing implementation.

Implemented in commit `8d87a317`:

- Direct RGBA-to-ESC/POS bit packing.
- Maximum 256-row raster bands for long reports.
- Removal of second PNG encode/decode and `escpos.Image` conversion.
- Full Arabic render/decode/raster warm-up at service startup.
- A warm-up barrier so the first print cannot compete with warm-up on a Celeron.
- Independent launch and warm-up deadlines; a timed-out launch resets for retry and a Chromium process resolving after abandonment is closed.
- Per-job render, raster, transport, total-time, and RSS logging without receipt/customer data.
- Runtime switch from Full Chrome to Puppeteer `chrome-headless-shell`.
- Runtime manifest and installer/updater allowlist hardening.

Fresh measurements from the implementation session:

- Full Chrome process tree: 393 MB RSS.
- Headless Shell process tree: 225 MB RSS, about 43% lower.
- Full Chrome disk runtime: 408.2 MiB.
- Headless Shell disk runtime: 264 MiB.
- Same long Arabic document: 0.0882% black/white pixel difference, same raster length.
- 576×5,000 raster reconstructed exactly across 20 ordered bands.
- 513-row test emitted 256 + 256 + 1 rows with one drawer kick, one cut, and one job acknowledgement.

Verification completed after the final committed change:

- Full spooler-owned test command passed.
- Spooler package + installer/updater contracts: 39 tests passed.
- Architecture check passed.
- Cached diff check passed.

### Spooler rollout boundary

- This browser-engine change requires a newly built **Spooler Runtime Updater**. The small core updater is insufficient.
- No installer/updater executable was rebuilt.
- No customer spooler was updated.
- No physical printer has validated the shell-rendered receipt/kitchen/report output yet.
- `spooler.env` was not changed and must remain byte-for-byte preserved by the updater.

Plan: `docs/superpowers/plans/2026-08-14-spooler-low-resource-raster-hardening.md`

Open issue: https://github.com/xyzbk/posappv4/issues/1

Issue #1 still describes the fix as deferred. The committed code implements the universal banding mitigation, but the issue should remain open until the affected printer passes a controlled short/long physical comparison. Do not claim the customer-specific root cause is proven.

## 10. Cash-drawer diagnosis

No cash-drawer behavior was changed.

The bundled command is `ESC p 0 25 250`, which applies a 50 ms electrical latch pulse and a 500 ms off interval. The software releases the latch; the drawer spring/mechanics determine how violently the tray travels. Shortening the pulse is not a proven speed control and risks intermittent failure to open.

The correct next action for a drawer that flies open is model-specific mechanical inspection: spring/damper adjustment if supported, mounting stability, and drawer/printer compatibility.

## 11. Known risks and decisions Fable must surface

1. **Branch name/design mismatch:** runtime is browser Web Crypto, not passkey WebAuthn.
2. **Browser binding limit:** it binds a browser profile, not physical hardware or MAC address.
3. **Programmer bypass:** necessary break-glass access but a high-impact privileged credential.
4. **Existing-customer provisioning:** programmer seed is fresh-install only.
5. **Bootstrap configuration:** the secret is required but intentionally not generated into tracked templates.
6. **Manual device matrix:** still pending; production enforcement is not ready solely from automated tests.
7. **Automatic migration risk:** deploying the server can mutate schema; never deploy this branch casually.
8. **Recovery history:** recovery runtime is gone, but recovery-named schema remains intentionally.
9. **Unpublished branch:** only local workspace contains the branch.
10. **Rollout separation:** spooler changes require a runtime updater plus physical printer gate; authentication requires exact hosted proxy configuration and the manual browser/device matrix.
11. **Issue drift:** GitHub issue #1 is older than the committed banding implementation.
12. **Unrelated docs:** commit `58b23bf4` added Hostinger/spooler plan documents unrelated to authentication.

## 12. Recommended Fable assignment

Give Fable this instruction:

> Work in `C:\xampp\htdocs\posapp` on `codex/webauthn-device-access`. Read `CLAUDE.md`, `docs/architecture.json`, and `docs/2026-08-14-fable-branch-handoff.md` first. Do not deploy, migrate production, change environment values, build installers, merge, push, or rewrite customer data. Treat the current browser-key design—not the obsolete passkey plan—as authority. Aggressively retest programmer PIN-only boundaries, explicit proxy trust, known/unknown option parity under saturation, cache/session/socket revocation, staged/enforced transitions, clean-profile denial, approval resume/cancel, migration parity, recovery-route absence, bounded spooler startup, exact raster ordering, one-alert/one-cut/one-ack behavior, runtime-updater completeness, and `spooler.env` preservation. Report evidence and prioritized defects before changing code.

## 13. Suggested read-only orientation commands

```powershell
git branch --show-current
git status --short
git log --oneline master..HEAD
git diff --stat master...HEAD
git diff master...HEAD -- backend src server.js deployment docs/architecture.json
git show --stat 8d87a317
git show 8d87a317 -- pos-spooler-printer deployment/tools/spooler-layer-manifest.js scripts/build-installers.ps1
```

## 14. Suggested focused verification commands

Run only after orientation and only against local/test databases:

```powershell
npx vitest run backend/tests/unit/trustProxy.test.js backend/tests/unit/requestThrottle.test.js backend/tests/unit/browserDeviceCrypto.test.js backend/tests/unit/webauthnCeremonies.test.js backend/tests/unit/webauthnConfig.test.js backend/tests/unit/webauthnCredentials.test.js backend/tests/unit/webauthnPolicy.test.js backend/tests/unit/staffSessions.test.js backend/tests/unit/sessionCookies.test.js
npx vitest run backend/tests/integration/loginProxyTrust.test.js backend/tests/integration/browserDeviceProof.test.js backend/tests/integration/webauthnDeviceAccess.test.js backend/tests/integration/webauthnSocketRevocation.test.js backend/tests/integration/auth.test.js backend/tests/integration/users.test.js backend/tests/integration/installerBaseline.test.js
npx vitest run src/shared/__tests__/browserDeviceClient.spec.js src/shared/__tests__/authInterceptor.spec.js src/components/__tests__/loginWebAuthn.spec.js src/components/__tests__/deviceEnrollment.spec.js src/admin/pages/__tests__/deviceAccessSettings.spec.js
npx playwright test --config playwright.browser-device.config.mjs
node scripts/validate-schema-drift.js
npm run build:admin
npm run architecture:check
Push-Location pos-spooler-printer; npm test; Pop-Location
npx vitest run backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js
git diff --check
git diff --cached --check
```

Do not run the production updater or any Hostinger operation as validation.
