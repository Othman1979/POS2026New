# WebAuthn registered-device access validation

Date: 2026-08-13
Branch: `codex/webauthn-device-access`

## Local evidence

- Focused authentication/session/device-access/socket regression set — 137 tests passed across 14 files.
- Automatic migration chain plus fresh installer baseline — 15 tests passed against isolated scratch databases.
- Exact-predecessor WebAuthn migration attack — 2 tests passed: legacy session migration preserved seeded users/products/categories/orders, while an incompatible partial target schema was rejected before any predecessor mutation.
- Concurrent bootstrap-start probe — exactly one ceremony was created; the second request returned the expected conflict and no duplicate pending ceremony remained.
- Final-slot registration race — one of two competing administrator registrations committed; the other received `WEBAUTHN_DEVICE_LIMIT_REACHED`, leaving exactly the two permitted credentials.
- Failed safe replacement probe — a synced replacement was rejected and the old cashier credential remained active and unmodified.
- Real route/socket probe — authenticated credential revocation durably revoked only the matching session, evicted its cache entry, and disconnected that credential room while the administrator's second credential stayed connected.
- Focused client suites — 19 tests passed across login, enrollment, recovery, Device Access, WebAuthn client, and Arabic catalog files.
- Installer/update contracts — 35 tests passed, including exact WebAuthn dependency pins and the server RuntimeTransition dependency boundary.
- `npx playwright test --config playwright.webauthn.config.mjs` — 2 tests passed with Chromium CDP virtual authenticators.
  - A platform-style, user-verified, non-backed-up credential registered through the real browser ceremony and authenticated through the server.
  - Reusing the consumed authentication ceremony was rejected.
  - A second browser context without the authenticator could not complete an assertion.
  - A virtual authenticator marked backup-eligible/backed-up was rejected with `WEBAUTHN_MULTI_DEVICE_UNSUPPORTED`.
  - Unknown PIN options retained the same two-descriptor shape.
- `npm run build:admin` — passed.
- `npm run architecture:check` — passed after the architecture model and registered-device UI/session flow update.
- `npm audit --omit=dev --audit-level=high` — 0 high-severity findings.
- `node scripts/validate-schema-drift.js` — zero drift after backing up and bringing the local development database through the exact receipt-display, split-quantity, and WebAuthn migration chain. User, product, category, and order row counts were unchanged.

## Manual device matrix

`PENDING — hardware unavailable` for the required owner-controlled matrix:

| Device class | Browser | Result |
| --- | --- | --- |
| Windows 10/11 | Chrome | PENDING — hardware unavailable |
| Windows 10/11 | Edge | PENDING — hardware unavailable |
| iPhone | Safari | PENDING — hardware unavailable |
| Android | Chrome | PENDING — hardware unavailable |

No production enforcement decision is implied by the local virtual-authenticator results. A real device is acceptable only when the verified result is `singleDevice`, `credentialBackedUp=false`, platform-attached, and user-verified. Synced-only results remain unsupported.

## Scope boundary

This evidence uses only the isolated test database and localhost origin. It contains no credential IDs, WebAuthn responses, enrollment codes, recovery codes, session tokens, bootstrap secrets, or customer data. Production migration, environment changes, deployment, and enforcement remain separate explicit operations.
