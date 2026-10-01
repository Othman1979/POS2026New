# Silent registered-browser access validation

## Decision

The POS keeps its existing registered-device lifecycle and per-user limits, but authentication now uses one origin-scoped ECDSA P-256 browser key stored as a non-exportable `CryptoKey` in IndexedDB. The server stores only the public JWK. Login, registration, recovery, and administrative step-up sign a durable one-use, exact-origin challenge without invoking Windows Hello, a Windows PIN, or a password-manager passkey prompt.

This is browser-profile binding, not an immutable physical-device guarantee. Clearing site data removes the key and requires enrollment or recovery. XSS, a compromised browser process/profile, or software with equivalent local privilege remains capable of using the key; this design does not claim hardware-backed non-exportability.

## External evidence refreshed on 2026-08-13

- Google documents that Chrome passkeys may be synchronized by Google Password Manager across Android, Windows, macOS, Linux, and ChromeOS, and that setup/use may require a device unlock or Google Password Manager PIN. That makes passkeys the wrong fit for this POS requirement: no cashier-facing OS/password-manager prompt and one registered browser slot. Source: https://developers.google.com/identity/passkeys/supported-environments
- The W3C Web Cryptography specification defines `CryptoKeyPair`, blocks `exportKey` when a key's `extractable` slot is false, and defines serialization/deserialization protections for non-extractable key material. Source: https://www.w3.org/TR/webcrypto/
- The W3C DBSC publication is still a First Public Working Draft and explicitly identifies itself as work in progress. DBSC may later strengthen session theft resistance, but requiring it now would introduce a browser-specific deployment boundary outside this feature's cross-browser scope. Source: https://www.w3.org/TR/dbsc/

## Adversarial results

- Wrong private key, changed signed message, wrong origin, malformed signature, replayed ceremony, and invalid/private/wrong-curve JWKs are rejected.
- Known-user and decoy proof subjects use the same ceremony-only construction; no internal user ID or decoy marker is encoded in the public message.
- A clean second Chromium browser profile cannot sign in as a user registered in the first profile.
- A real Chromium key remained non-exportable, survived page reload through IndexedDB, and completed the actual Vue login without an authenticator prompt.
- One browser key can be bound independently to multiple restaurant users without sharing their database rows or bypassing one-device/two-device limits.
- The same browser key cannot consume two device slots for one user; replacement and recovery may deliberately rebind it.
- A user deactivated after options issuance cannot create a session; the active user row is rechecked and locked inside verification.
- Registration/replacement/recovery keep their previous row locks and transaction boundaries. Revocation keeps credential-bound session invalidation and Socket.IO eviction.
- Exact origin parsing rejects HTTP outside `localhost`, direct IP origins, paths, credentials, wildcards, duplicates, and missing configuration.
- No MAC address, fingerprint, bearer device cookie, new schema, new authentication dependency, or mandatory DBSC path was introduced.

## Verification

- Focused Vitest: 19 files, 131 tests passed across cryptography, browser client, login/enrollment/recovery UI, policy, ceremonies, sessions, device access, socket revocation, schema migration/authority, and installer configuration.
- Playwright: 1 real-browser scenario passed, covering non-exportable key creation, IndexedDB persistence, actual Vue login, replay rejection, and clean-profile rejection.
- `node scripts/validate-schema-drift.js`: development and test schemas have zero drift.
- `npm run build:admin`: production Vite build passed (303 modules transformed).
- `npm run architecture:check`: passed (198 nodes, 52 flows, 405 steps, 139 distinct files).
- `git diff --check` and Node syntax checks passed before final review.

No production environment, database, deployment, installer artifact, or customer data was changed.
