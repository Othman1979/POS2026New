# POSApp security audit

**Scope:** read-only review of `skelvar/posappv4` at `master` (`94f97f95`).  
**Date:** 2026-09-17.  
**Method:** source review of auth/session, injection, CSRF, secrets, payments/cash drawer, uploads, Windows spooler privileges, and recent hardening/regression patterns. No application code was changed. Secret values are not reproduced here.

This is a static audit. It does not claim production exploitability from a live deployment.

---

## Executive summary

The runtime has several real controls: HttpOnly `SameSite=Strict` session cookies, cookie-only (no bearer) staff auth, hashed durable sessions, parameterized SQL on request paths, Helmet CSP, CORS deny-by-default, pre-auth rate limiting, checkout price authority on the server, and a V2 spooler that separates a bootstrap key from a per-agent secret.

The highest residual risk is **LAN authentication**, not a classic remote unauthenticated RCE:

1. Staff login is **possession of `user_number` only** (1–8 digits for ordinary users). Fresh Windows installs seed a **published default administrator number**.
2. Those cookies are **not `Secure`** on the shipped Windows template (`ENFORCE_HTTPS=false`), and the POS port is opened on the Private firewall profile.
3. An authenticated administrator can wipe operational sales data if they also know the **compiled-in default maintenance password hash**.

Together, anyone who can reach a typical Windows LAN POS can often become admin with a documented default PIN, then reset orders/shifts/JoFotara documents unless those defaults were changed. That is a **High** chain, not a single Critical internet-facing hole.

Injection and CSRF look comparatively healthy. SQLi on user input is parameterized. CSRF relies on `SameSite=Strict` plus CORS deny-by-default rather than tokens. XSS is mostly contained by Vue text interpolation, print HTML escaping, and CSP; the remaining stored-XSS residual is same-origin `/uploads` after magic-byte image checks.

No live `.env`, cloud API keys, or private keys were found in the tree. The two credential-shaped values in source are a **hardcoded SHA-256 maintenance verifier** and the **documented installer admin PIN**.

---

## Known-finding verification

| # | Claim | Verdict | Severity |
|---|---|---|---|
| 1 | Hardcoded `DEFAULT_PASSWORD_HASH` on operational reset | **Confirmed.** Admin/programmer session still required. | **High** |
| 2 | `ENFORCE_HTTPS` gates the cookie `Secure` flag | **Confirmed.** Windows template ships `false`. Hosted redirect also trusts `Host`. | **High** (LAN cookie theft); **Medium** (hosted Host-header redirect) |
| 3 | NSSM download without checksum in `service/install-pos-service.bat` | **Confirmed.** Modern spooler installer **does** checksum. | **High** |
| 4 | Brand-icon magic-byte upload + static `/uploads` | **Confirmed.** Admin-only; SVG rejected; Helmet `nosniff` applies. Residual polyglot/same-origin risk. | **Medium** |
| 5 | `SPOOLER_KEY` bootstrap + agent auth in `spoolerV2.js` | **Confirmed.** Design is sound; shared fleet key + HTTP agent token remain the residuals. | **Medium** (key); **High** (LocalSystem + unsigned NSSM on the legacy bat path) |
| 6 | CORS deny-by-default when `CORS_ORIGIN` unset | **Confirmed as a control**, not a defect. | n/a (positive) |

---

## Findings

### H1 — Hardcoded maintenance password hash on operational reset

**Severity:** High  
**Paths:** `backend/routes/admin/maintenance.js`, mounted under `backend/routes/admin.js` (`requireAuth` + `requireAdmin`)

`POST /api/admin/maintenance/reset-operational-data` compares `sha256(password)` to `MAINTENANCE_RESET_PASSWORD_HASH` or a **compiled-in 64-hex SHA-256 default**. Comparison is timing-safe. Tests override the env hash and prove cashiers cannot call it.

Anyone with the repository can recover a weak default offline. Combined with an admin session (see H2), this wipes orders, holds, shifts, subscriptions, JoFotara documents, print jobs, and sequences while keeping users/catalog/sessions.

**Remediation**

- Delete `DEFAULT_PASSWORD_HASH`. Refuse to run the handler unless `MAINTENANCE_RESET_PASSWORD_HASH` is a non-default 64-hex value set in env.
- Prefer a high-entropy secret compared with a KDF (scrypt/argon2), not a single SHA-256 of a password.
- Rate-limit this route independently of login. Rotating the hash should be part of every install/repair checklist.

---

### H2 — PIN-only login plus a published default administrator number

**Severity:** High  
**Paths:** `backend/routes/auth.js` (`POST /api/auth/login`), `backend/routes/admin/users.js` (`normalizeUserNumber`), `deployment/tools/bootstrap-database.js`, `deployment/windows/Install-PosServer.ps1`, `docs/printing-runbook.md`

Architecture is explicit: **`user_number` is the entire credential**. Ordinary numbers are 1–8 digits and stored/returned in plaintext on the admin users API (`presentUserProfile`). Manager override PINs are 4–8 digits and bcrypt-hashed. Programmer numbers are 12-digit generated values and bypass registered-device mode.

Fresh installs seed a **fixed administrator `user_number` published in the installer, tests, and printing runbook**. Windows templates leave device binding disabled. Login delay is keyed by an HttpOnly browser cookie **plus** candidate number: a new browser or cleared cookie starts a fresh 3-failure window. The shared pre-auth gate (600/min) bounds raw request volume but does not stop a slow PIN sweep from many clients.

**Remediation**

- Treat the seeded admin number as a bootstrap secret: force change on first login, or generate it per install the way the programmer number is generated.
- Raise the minimum staff PIN length (6–8) and reject trivial sequences.
- Enable registered-device mode on any host that is reachable beyond a physically controlled counter.
- Key login throttles by observed peer in addition to browser cookie, and keep the existing candidate-keyed delay.

---

### H3 — Session cookies omit `Secure` unless `ENFORCE_HTTPS=true`

**Severity:** High on Windows/LAN; Medium extra on hosted  
**Paths:** `backend/services/sessionCookies.js`, `backend/services/loginDelay.js`, `server.js`, `deployment/templates/pos.env.template`, `deployment/templates/hostinger.env.template`

`secureFor()` is solely `ENFORCE_HTTPS === 'true'`. Cookies are otherwise `HttpOnly; SameSite=Strict; Path=/` with no `Max-Age` (browser-session cookie). Idle 30 min / absolute 12 h are enforced in `auth_sessions`.

Windows `pos.env.template` ships `ENFORCE_HTTPS=false`. The installer opens the POS port on the Private firewall profile (`Install-PosServer.ps1`). A LAN or captive-portal attacker who can see HTTP can steal `pos_token` and reuse the staff session.

When `ENFORCE_HTTPS=true`, the HTTP→HTTPS redirect fires only on `X-Forwarded-Proto: http` (trust proxy stays off — good against proto spoofing for `req.protocol`). The redirect target is `https://${req.headers.host}${req.originalUrl}`. A client-supplied `Host` plus `X-Forwarded-Proto: http` is an **open redirect**.

Startup warns when HTTPS is disabled. Login UI also refuses to POST if the policy says HTTPS is required and the page is `http:`.

**Remediation**

- Keep `ENFORCE_HTTPS=true` on every non-localhost origin, including LAN if terminals can use a stable HTTPS name.
- If HTTP must remain for bare-IP terminals, isolate the VLAN and treat cookie theft as in-scope.
- Allow-list `Host` (or ignore `Host` and redirect to a configured public origin).
- Do not enable Express `trust proxy` unless the immediate hop is a pinned address/CIDR.

---

### H4 — Legacy POS service installer downloads NSSM without a checksum

**Severity:** High  
**Paths:** `service/install-pos-service.bat` (`:get_nssm`)

The script requires Administrator, downloads `https://nssm.cc/release/nssm-2.24.zip` with `Invoke-WebRequest`, copies `win64\nssm.exe`, and installs **PosApp** to auto-start. NSSM’s default service account is **LocalSystem**. There is no SHA-256 check.

Contrast: `pos-spooler-printer/service/spooler-service.ps1` pins NSSM/Node hashes and comments that the binaries “run as SYSTEM afterwards.” Packaged `Install-PosServer.ps1` / `Install-Spooler.ps1` expand a vendored archive, not a live download.

A compromised or redirected NSSM zip becomes SYSTEM on the POS host (Node, `.env`, MariaDB on loopback, uploads, backups).

**Remediation**

- Deprecate or delete `service/install-pos-service.bat` in favor of the packaged installer.
- If the bat must remain, pin SHA-256, verify before extract, and refuse to install on mismatch (copy the spooler helper).
- Run the POS/spooler services as a locked-down account, not LocalSystem, once print/DPAPI requirements are mapped.

---

### H5 — Spooler and POS Windows services run as SYSTEM

**Severity:** High (impact), Medium (likelihood on a well-installed packaged box)  
**Paths:** `service/install-pos-service.bat`, `pos-spooler-printer/service/spooler-service.ps1`, `deployment/windows/Install-Spooler.ps1`, `pos-spooler-printer/v2/platform-helper.js`

NSSM is used without `ObjectName`, so services inherit **LocalSystem**. The spooler then:

- loads `SPOOLER_KEY` and the agent secret;
- talks to printers (including cash-drawer ESC/POS);
- spawns a C# platform helper and Chromium for rasterization;
- stores agent identity with LocalMachine DPAPI (`agent-identity.js`).

SYSTEM is convenient for DPAPI-LocalMachine and raw printer I/O. It also means a spooler RCE or supply-chain hit is a full machine compromise, and the shared bootstrap key on that box can register additional stations (H6).

**Remediation**

- Document SYSTEM as an accepted residual for packaged installs, or introduce a dedicated service account with printer and ProgramData ACLs only.
- Keep agent secrets off the bootstrap key; rotate `SPOOLER_KEY` after staff/PC turnover.
- Do not reuse the unsigned bat path (H4).

---

### M1 — Shared `SPOOLER_KEY` bootstrap; agent secret is the real station credential

**Severity:** Medium  
**Paths:** `backend/routes/spoolerV2.js`, `backend/services/spoolerAgents.js`, `pos-spooler-printer/server.js`, `docs/printing-runbook.md`

Confirmed design:

| Endpoint | Guard | Notes |
|---|---|---|
| `POST /register`, `POST /status` | `x-spooler-key` vs `SPOOLER_KEY` (length-checked timing-safe compare) | Fleet-wide bootstrap |
| `POST /sync` | `x-agent-id` + `x-agent-token` hashed SHA-256, timing-safe | Per-agent; station mismatch is 409 |

Registration validates UUID/station/hash shape, is idempotent for the same agent+hash, and returns `409 station_occupied` / `station_busy` when appropriate. Force-replace is an admin path. Production agent startup fails closed without `CLOUD_SERVER_URL` and `SPOOLER_KEY`.

Residual (already noted in `docs/2026-08-19-printing-system-discussion-audit.md`): any print PC with the shared key can **register a new unused `SPOOLER_ID`** and call `/status`. It cannot steal another station’s in-flight jobs without that agent secret or admin force-replace. Agent tokens travel as headers on HTTP when the cloud URL is `http://` (typical LAN).

**Remediation**

- Prefer HTTPS to the POS origin; treat HTTP agent tokens as LAN-secret.
- Bind bootstrap to an allow-list of `SPOOLER_ID`s, or mint one-time registration tokens.
- Keep force-replace audited (already is) and require step-up on hosted deployments.

---

### M2 — Brand-icon magic-byte check, then same-origin static `/uploads`

**Severity:** Medium  
**Paths:** `backend/routes/system.js` (`POST /api/system/brand-icon`), `server.js` (`app.use('/uploads', express.static(uploadDir))`)

Upload is `requireAuth` + `requireAdmin`, 1 MB memory storage, extension taken only from sniffed magic bytes (PNG/JPEG/ICO/WEBP). GIF/SVG/HTML/PHP are rejected. Filename is always `store_icon.<ext>`. Old `store_icon.*` files are deleted. Public preferences expose the path.

`/uploads` is served as static files from the same origin as the SPA. Helmet applies (including default `X-Content-Type-Options: nosniff`). CSP `img-src` includes `'self'`; `script-src` is `'self'` only.

Residual: magic bytes are not a full parser; polyglot images and ICO/WEBP oddities can still be stored. Same-origin static hosting is a stored-content gadget if a future path serves a dangerous type or drops `nosniff`. Catalog import (`backend/routes/admin/import.js`) trusts a `.xlsx` **filename** and a 5 MB cap — weaker than the icon sniffer (Low, admin-only).

**Remediation**

- Serve uploads from a separate origin, or force `Content-Disposition: attachment` / immutable cache plus explicit image Content-Type.
- Re-encode images with a parser (e.g. sharp) instead of writing sniffed bytes.
- Sniff catalog workbooks by ZIP/OOXML magic, not `.xlsx` suffix.

---

### M3 — Manual cash-drawer pulse has no second factor; admin pops skip audit rows

**Severity:** Medium  
**Paths:** `backend/routes/pos/checkout.js` (`POST /api/pos/log_drawer_pop`), `pos-spooler-printer/v2/artifact-renderer.js`

Cashiers, admins, and programmers can enqueue `print_type: 'cash_drawer'` to a chosen receipt printer. There is no manager PIN and no keyed rate limit (unlike checkout’s 30/min). `appendAuditEvent` runs **only for `cashier`**. Admin/programmer no-sale pops are log-only.

Receipts and drawer-sourced expense slips also emit the drawer kick. That is expected for cash sales. The no-sale path is the theft/control gap. Client-chosen `receipt_printer_id` can target another counter’s printer (also noted in the 2026-08-19 printing audit).

There is **no card-processor integration**; `card` is a till method. Checkout re-prices from the catalog (`executeCheckout` / `applyDatabasePrices`) and rejects cash tender below total.

**Remediation**

- Require a manager override (or a dedicated drawer permission) for no-sale pops.
- Audit every role, not only cashiers.
- Rate-limit `log_drawer_pop` per actor.
- Bind default receipt printer server-side per station where possible.

---

### M4 — QR table tokens are bearer capabilities and are listed to floor staff

**Severity:** Medium  
**Paths:** `backend/routes/pos/tables.js`, `server.js` (Socket.IO customer handshake), `src/menu/MenuApp.vue`

Guest menu/draft/socket access is `tableId` + `qr_code_token` (32 hex bytes). Tokens appear in query strings (`/menu.html?table=&token=`), so they land in logs, Referers, and screenshots. Failed socket auth **logs the provided token**. `GET /api/pos/get_tables` returns `qr_code_token` for every visible table to any staff with tables access.

Comparisons are not constant-time (Low). Guest sockets may write arbitrary JSON carts; import onto the POS **rebinds product id → catalog price** (`importQrDraftItems`), so guests cannot set their own price. They can still spam drafts.

**Remediation**

- Stop returning QR tokens on the floor-plan payload; fetch a token only when generating a QR image.
- Do not log `providedToken`. Prefer short-lived tokens or rotate on each print.
- Cap draft size and validate cart shape on the socket write.

---

### M5 — Hosted HTTPS redirect uses the raw `Host` header

**Severity:** Medium  
**Paths:** `server.js` (`ENFORCE_HTTPS` middleware)

Covered under H3. Isolated here because Hostinger templates set `ENFORCE_HTTPS=true`. An attacker who can make the app see `X-Forwarded-Proto: http` (trivial from the client; the app treats that as “known plaintext”) gets a 301 to `https://<attacker-controlled Host>/…`.

**Remediation**

- Redirect only to a configured `PUBLIC_ORIGIN`.
- Reject requests whose `Host` is not in an allow-list.

---

### M6 — Programmer login bypasses registered-device mode

**Severity:** Medium (accepted break-glass; residual is accountability)  
**Paths:** `backend/routes/auth.js` (`runLoginTransaction`)

`programmer` skips the WebAuthn/device requirement. The number is 12 digits and generated per install — much stronger than staff PINs — but it remains a single factor over HTTP on LAN. Docs already treat this as privileged remote access.

**Remediation**

- Keep the number unique and private; do not print it into world-readable completion files if those files leave the machine.
- Consider requiring device binding even for programmer once a privileged credential exists.

---

### L1 — Selected 500 responses leak `err.message` instead of the generic handler

**Severity:** Low  
**Paths:** `backend/routes/system.js` (settings GET/POST, backup-status, brand-icon write), `server.js` (`GET /api/health`)

The global Express handler sanitizes production 500s. Several system routes still `sendError(res, 500, e.message)`. `/api/health` includes `error: err.message` on DB failure (authenticated? no). Information leak only.

**Remediation**

- Use the same generic 500 text as the global handler; log the real error server-side.

---

### L2 — CSRF tokens are absent; defense is cookie + CORS policy

**Severity:** Low (residual)  
**Paths:** `backend/services/sessionCookies.js`, `backend/config/corsPolicy.js`, `backend/middleware/auth.js`

Staff APIs accept only the `pos_token` cookie (no `Authorization` bearer). Cookies are `SameSite=Strict`. HTTP CORS is `origin: false` when `CORS_ORIGIN` is unset; Socket.IO allows missing Origin or same-Host Origin only. Cross-site browser CSRF against cookie auth is therefore blocked in current browsers.

Residual: old browsers, non-browser clients, or a future `CORS_ORIGIN=*` mistake (the parser already rejects `*`).

**Remediation**

- Keep `CORS_ORIGIN` unset on same-origin Windows installs.
- Add a CSRF token only if a first-party cross-site browser origin is required.

---

### L3 — Unauthenticated information surfaces

**Severity:** Low  
**Paths:** `backend/routes/config.js` (`GET /api/config/business`), `backend/routes/system.js` (`GET /api/system/public_preferences`), `server.js` (`/public_menu.json`, `/health`)

Business timezone/day-start, store name/icon, catalog prices, and health/release identity are public. That matches QR menu needs. Health/release can help an attacker fingerprint versions.

**Remediation**

- Keep menu/public preferences public. Consider reducing `/health` on hosted internet origins.

---

### L4 — Socket.IO customer token compare is not constant-time

**Severity:** Low  
**Paths:** `server.js` (customer handshake), `backend/routes/pos/tables.js` (draft GET)

`!==` on a 32-hex token. Practical exploitation is unlikely next to network jitter.

**Remediation**

- Reuse the existing `timingSafeEqual` helper.

---

## Positive controls (not findings)

- **CORS deny-by-default** — `createCorsPolicy('')` sets HTTP `origin: false`; Socket.IO same-host only. Tests in `backend/tests/unit/corsPolicy.test.js`. Recent commit `c574188f` (“Default browser access to same origin”) matches this.
- **Cookie-only staff auth** — `requireAuth` ignores bearer tokens.
- **Durable sessions** — SHA-256 token hash, idle/absolute expiry, single-session login revoke, Socket.IO recheck.
- **SQL** — request paths use bound parameters. Dynamic `IN (?)` lists are placeholder-built. `schemaMetadata.js` interpolates `information_schema` names extracted from the SQL text itself, not from the client.
- **XSS / print** — Vue `{{ }}` on menu/POS; print HTML goes through `escapeHtml`; CSP `script-src 'self'`; no `v-html` on operator UI. `innerHTML` uses in `useIdleTracker.js` / `bootstrap.js` is static markup.
- **Checkout money** — server catalog prices; cash tender checks; checkout rate limit; manager override lockout (5 / 5 min) with in-flight serialization.
- **phpMyAdmin / MariaDB** — `Listen 127.0.0.1`, `Require local`, `bind-address=127.0.0.1`.
- **Secrets hygiene** — `.env` / `.env.*` gitignored; templates use placeholders; installer generates spooler/DB secrets; no AWS/private-key blobs found.
- **Pre-auth gate** — tight 16 KB parsers and shared 600/min on login and public menu; comment in `server.js` records removal of a `.php` alias that used to skip that gate.
- **Trust proxy off** — `req.ip` is observed-peer only; forwarded proto is not used to mark the socket secure.

---

## SQLi / XSS / CSRF summary

| Class | Result |
|---|---|
| SQLi | No exploitable user-controlled query construction found on HTTP routes. Integration tests in `backend/tests/integration/security.test.js` send classic payloads into login/checkout fields. |
| XSS | No confirmed stored/reflected XSS in staff or QR Vue surfaces. Residual: same-origin uploads (M2) and `'unsafe-inline'` styles (CSP). |
| CSRF | Cookie `SameSite=Strict` + CORS deny-by-default is the control. No synchronizer token (L2). |

---

## Secrets in the repository

| Item | Present? | Notes |
|---|---|---|
| Live `.env` / cloud keys / PEM | **No** | Ignored; templates only |
| Hardcoded maintenance SHA-256 | **Yes** | H1 — verifier, not a live env secret |
| Published default admin PIN | **Yes** | H2 — documented installer seed |
| `SPOOLER_KEY` / DB passwords | **Placeholders only** | `{{SPOOLER_KEY}}`, `.env.example` dummy |
| JoFotara client secrets | **Empty settings defaults** | Stored in DB/settings at runtime, not in git |

Do not commit machine `pos.env`, `spooler.env`, or `bootstrap.json`.

---

## Recent unsafe / hardening patterns

Reviewed recent `master` history (permissions, tables, kitchen print, `c574188f` CORS default).

**Hardening that should stay**

- CORS/Socket.IO same-origin default.
- Removal of the `.php` API alias that skipped the pre-auth gate (`server.js` comment).
- Proxy trust left disabled; Secure cookies tied to `ENFORCE_HTTPS`.
- Spooler V2: hashed agent token, station lock, production fail-closed, checksummed NSSM on the packaged/PowerShell path.

**Gaps that are still open**

- Legacy `service/install-pos-service.bat` unsigned NSSM download.
- Compiled-in maintenance hash.
- PIN-only login + published admin seed + `ENFORCE_HTTPS=false` on Windows.
- System routes that still return raw `e.message` on 500.
- Host-header redirect when HTTPS is enforced.
- QR tokens in floor-plan JSON and socket logs.

---

## Suggested fix order

1. Remove `DEFAULT_PASSWORD_HASH`; require a deployment-specific maintenance hash (H1).
2. Rotate/generate the administrator `user_number` per install; force change; lengthen staff PINs (H2).
3. Stop shipping unsigned NSSM download; keep checksummed vendor NSSM only (H4).
4. Turn on HTTPS (or accept LAN cookie theft in writing); pin redirect Host (H3, M5).
5. Audit and PIN-gate no-sale drawer pops (M3).
6. Stop listing QR tokens on `get_tables`; stop logging guest tokens (M4).
7. Re-encode brand icons; optional separate upload origin (M2).
8. Allow-list spooler IDs or one-time bootstrap tokens (M1).
9. Generic 500s on system/health routes (L1).

---

## Out of scope / not verified

- Live Hostinger or store LAN configuration (only templates and installers).
- Runtime fuzzing, dependency CVE sweep, and Word/Excel parser exploits in the catalog importer.
- Whether any production site still uses `service/install-pos-service.bat` versus the packaged EXE.
)
