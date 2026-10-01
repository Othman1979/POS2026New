# Adversarial review — `codex/webauthn-device-access`

> **Addendum, 2026-08-14 (added after the review below was delivered).**
>
> **The branch has moved on.** Two commits landed on top of the reviewed HEAD, outside this review session:
> - `8d87a317` "fix: harden low-resource spooler rendering" — the staged spooler work described in §"F4" and the staged-scope sections is now **committed**, no longer index-only.
> - `15fe232e` "fix: close device access adversarial gaps" — acts on the findings below.
>
> Branch HEAD is now `15fe232e`; `3f64c947` remains an ancestor, so the findings below were accurate for the tree they were written against. **Re-verified after the fix commit:**
> - **F1 — closed.** `ROLE_LIMITS.programmer` is now `0` (was `2`) in `backend/services/webauthn/policy.js`. This closes the audit gap structurally rather than by adding an event: with no credential possible, a programmer can never use the WebAuthn login path, so its logins always traverse the numeric path that writes `programmer_login`. Note `programmer_login` is still absent from the WebAuthn route — correct given the limit, but it becomes load-bearing again if that limit is ever raised.
> - **F2 — closed.** New `backend/config/trustProxy.js` replaces the unconditional `app.set('trust proxy', true)`. `readTrustProxySetting` accepts only `loopback` or explicit IP/CIDR entries and returns `false` when unset or `"false"`, so `req.ip` is no longer derived from an arbitrary client `X-Forwarded-For`. Default is fail-closed.
> - **F3 — closed.** The two-bucket split in `/login/options` is gone. The outstanding-ceremony count is now a single query with no `user_id` / `is_decoy` branch, and it runs *before* `getUserByNumber`, so real and nonexistent numbers follow an identical path to the limit check. The oracle is removed.
> - **F5, F6** — `staffSessions.js`, `ceremonies.js`, and `browserDeviceCrypto.js` were all touched by the fix commit (including removal of the dead `recovery_registration` action); not individually re-verified.
>
> **One design note on the F3 fix.** The outstanding-ceremony limit is now *global* rather than per-identity — a shared-fate resource across the whole deployment. The cap was raised from 4 to 500 at the same time, which makes accidental lockout from concurrent legitimate logins very unlikely. The residual is that a single unauthenticated host can still create 500 pending ceremonies within the 2-minute ceremony TTL (roughly 4 requests/second, varying `user_number` to get fresh throttle keys) and thereby return 429 to every registered-browser login system-wide until the window rolls. Scoping the limiter per-IP or per-identifier-hash would remove the shared-fate property. Low-to-medium; noted, not re-tested.
>
> ---
>
> **Third addendum — final review of `406d337a`, no new findings. REVIEW CLOSED (2026-08-14).** Reviewed by direct code tracing, no agents. N1, N2, N3, and the LOW count drift are all closed; nothing new was found.
>
> - **N1 closed.** `readProxyPolicy` (`trustProxy.js`) throws when `ENFORCE_HTTPS=true` and trust proxy resolves `false`, called at `server.js:61` at module scope, so the process cannot reach `listen()` in the redirect-loop configuration. Verified no bypass: a non-empty `TRUST_PROXY` either throws or yields a non-empty array, so there is no "empty array passes `=== false`" case. The template's new `{{TRUST_PROXY}}` placeholder fails closed twice over — `renderTemplate` throws on a missing value during provisioning, and a hand-copied template fails `isAddressOrCidr` at boot. Local/Windows installs are unaffected (`ENFORCE_HTTPS=false`).
> - **N2 dissolved, not merely patched.** With a real proxy IP/CIDR now enforced, Express walks the `X-Forwarded-For` chain and `req.ip` is the actual client again, so each terminal has its own bucket and the venue-wide collapse cannot occur. Separately, manager override no longer checks or feeds the global IP bucket (`auth.js:272`, and `recordFailedIpLogin` removed), which makes the **pre-existing** `ipLoginAttempts.delete(userIp)` on success (present on master at the same spot) actually reachable while locked — previously the IP check blocked the only recovery path. Residual, bounded and accepted: if no live session exists when a single client IP locks out, recovery waits out `LOGIN_LOCKOUT_MS` (5 min, self-healing), and manager-override failures no longer trip a venue-level counter (per-`(ip,user)` 5-per-5-min cap plus audit events remain).
> - **N3 closed, and the duplicate-print risk is structurally absent.** `renderWithDeadline` (30s, configurable) wraps the per-job render at `server.js:871`, which sits *before* the transport block, so a timeout can never have emitted printer bytes. Four follow-on concerns were chased and cleared: `discardBrowser` nulls `browserInstance`, and `getBrowserInstance` guards on `isConnected()` while `browserLaunchPromise` self-nulls on settle, so a killed browser can never be handed out again; `Promise.race` attaches handlers to both promises, so the losing render's later rejection is handled and cannot crash the process on `unhandledRejection`; and `processPrintJob` is called from exactly one place (`processNextQueueJob:399`) behind the `isProcessingLocalQueue` guard, with both the HTTP-poll and socket entry points funnelling through `addToPrintQueue:362`, so renders never overlap and `discardBrowser` has no cross-job collateral damage.
> - **Count drift closed.** `meta.counts` now matches actual content (198 / 52 / 407). `MySQL tables: 52` was checked against `baseline.sql` and is correct — 52 `CREATE TABLE` statements.
> - **Observations, not defects, no action required.** The warm-up barrier's worst case moved from a hard 15s to roughly 45s (bounded launch 30s + bounded render 15s) because the outer `withTimeout` was removed in favour of the inner deadline; this is arguably more correct, since the old outer cap released the barrier while warm-up was still running, defeating its purpose. And a deployment that terminates TLS upstream while setting `ENFORCE_HTTPS=false` would not trip the boot guard and would still collapse `req.ip`; that is a self-inflicted misconfiguration with the same bounded 5-minute consequence.
>
> **Final position: the branch is merge-ready.** The only outstanding requirement is operational and now fail-closed rather than silent — Hostinger must supply its exact immediate proxy IP/CIDR in `TRUST_PROXY`, and the server refuses to start without it instead of entering a redirect loop.
>
> ---
>
> **Second addendum — adversarial re-review of the fix commits (2026-08-14, later).** Three fresh attacker agents were run against `8d87a317` and `15fe232e` specifically, looking for what the *fixes* broke. Every finding below was re-verified in code by the aggregator.
>
> **All original findings (F1, F2, F3) are genuinely closed** — verified, not taken on trust. F1 is closed four layers deep, not just by `ROLE_LIMITS.programmer = 0`: `getActiveUser`/`getUserByNumber` filter `role <> 'programmer'` (`deviceAccess.js:24,33`), and `staffSessions.js` rejects any programmer session carrying a credential in both SQL and JS, on both the cache-miss (`:94,109`) and periodic-revalidation (`:133`) paths. A credential enrolled during the vulnerable window therefore cannot produce a session. The 12-digit seed moved all four producer/consumer sites in one commit (generator, bootstrap, install verifier regex, keypad cap), with `varchar(50)` storage, a `UNIQUE KEY`, and structurally disjoint namespaces (admin PINs capped 1–8 digits vs. a fixed 12). Session revalidation content now mirrors `findActiveSession` and fails closed on DB error; a ≤60s stale window remains, which is pre-existing throttle behaviour, not a new regression. Spooler: **no duplicate-print risk** — the only new retry re-launches the browser on the *next* job, never resends a job whose bytes may have reached a printer; one-kick/one-cut/one-ack is preserved; launch timeout genuinely kills the Chromium process via `controller.abort()` rather than orphaning it; the runtime-layer gate is real via the pre-existing `requiredRuntime` exact-match check in `Update-Spooler.ps1`.
>
> **New defects introduced or left by the fixes:**
>
> - **N1 (CRITICAL, deployment-gated) — blank `TRUST_PROXY` + `ENFORCE_HTTPS=true` is an infinite redirect loop.** `hostinger.env.template` ships `TRUST_PROXY=` (line 4) and `ENFORCE_HTTPS=true` (line 13). Blank resolves to `false`, so Express ignores `X-Forwarded-Proto`; `server.js:90` is `http.createServer`, so the socket is never encrypted; `req.protocol` is therefore unconditionally `'http'`, and `server.js:229` 301-redirects every non-local request to `https://`, which the proxy forwards back as plaintext, looping forever. Deploying the hosted template as shipped makes the site **100% unreachable from the first request**. This is a regression: under the previous unconditional `trust proxy: true`, `req.protocol` resolved to `'https'` and no redirect fired. The dependency is documented in the code comment at `server.js:214` but nothing enforces it — the only two `TRUST_PROXY` references in the backend are the parser and the single `server.js:61` call. **Fix:** refuse to boot when `ENFORCE_HTTPS` is true and trust proxy resolves false; consider whether `TRUST_PROXY=loopback` is the correct Hostinger default.
> - **N2 (HIGH, deployment-gated) — the same blank value makes the login lockout venue-wide.** `backend/routes/auth.js` was not touched by the fix and still keys `GLOBAL_IP_MAX_FAILED = 20` on `req.ip` (`:153-156`, and manager override at `:270-272`). Behind a proxy with trust disabled, every client shares the proxy's IP, so 20 failed logins in total across all staff within the 5-minute window returns 429 to **everyone at that venue** for 5 minutes, repeatable at will. The new `requestThrottle` service is wired only into `webauthn.js` and does not cover this path. `loginProxyTrust.test.js` exercises only the per-user bucket with a fixed `user_number`, so this blast radius is untested.
> - **N3 (HIGH, spooler) — the per-job render is still unbounded; the stall was relocated, not eliminated.** `withTimeout` guards the browser launch (`server.js:446`, 30s) and the startup warm-up (`server.js:514`, 15s), but the per-job `renderHtmlToRasterBands` call at `server.js:854` is unwrapped. Jobs are processed serially, so one wedged `page.setContent`/`page.screenshot` freezes the entire print queue — kitchen tickets and receipts alike — until Puppeteer's *unconfigured default* `protocolTimeout` (~180s) reaps it. That is a library default, not an intentional bound like the 15s/30s used elsewhere, and it applies to every job all day rather than once at boot. **Fix:** one line, wrapping line 854 in the existing `withTimeout` helper.
> - **N4 (MEDIUM, hygiene) — orphaned programmer credential rows.** A credential enrolled during the window between `fb83e87f` and `15fe232e` stays `status='active'` forever. It is inert against all four rejection layers, but `listDeviceAccess` filters programmers out so it never surfaces for cleanup, and no migration backfills it. Only matters if a future feature trusts "active row means legitimate" without re-adding the role filter.
> - **N5 (LOW).** A malformed `TRUST_PROXY` throws synchronously at `server.js:61` with no guard, so a typo crash-loops under a process manager (intentional per its tests, but loud-and-dead rather than degrade). `0.0.0.0/0` and `::/0` are correctly rejected, though entries validate independently so `0.0.0.0/1,128.0.0.0/1` would jointly pass — operator-input only, not attacker-reachable. Separately, `architecture.json`'s own `meta.counts` block is stale (196 nodes / 405 steps) against the file's actual content (198 / 407).
>
> **Merge assessment:** the security work is sound and merging deploys nothing. N1 and N2 are both triggered by a single unset deployment value and must be resolved before any Hostinger deployment; N3 is worth its one-line fix before the spooler reaches a customer.
>
> **Correction to "Limits of this review" below.** That section states no database was touched. That is not fully accurate: one review agent ran an ad-hoc `supertest` script against an ephemeral Express instance during its verification pass (not the project test suite, and it left a stray process that has since been cleaned up). No project test suite was run and no repository file was modified by any agent, but the claim "no database touched" should be read as "no project test suite executed; one isolated ad-hoc request script was run by an agent."

- **Date:** 2026-08-14
- **Branch:** `codex/webauthn-device-access`, HEAD `3f64c947`
- **Merge base / master:** `4d9cbbb9` (committed scope = `git diff master...HEAD`, 9 commits, 88 files, +8,546 / −209)
- **Second, separate scope:** the staged spooler work in the git index (`git diff --cached`, 16 files, +444 / −111), **not** part of HEAD
- **Reviewed against:** `docs/2026-08-14-fable-branch-handoff.md`
- **Method:** five parallel read-only attacker agents on disjoint file sets (crypto/ceremonies, sessions/revocation, policy/modes/admin authz, migration parity + recovery removal, staged spooler), plus an independent lane run by the aggregating reviewer (handoff fact-check, installer/programmer seed, frontend interceptor). Every severe claim was re-verified in code by the aggregator before inclusion. Handoff assertions were treated as claims to disprove, not as evidence.
- **Not done:** no test suite was executed, no migration applied, no database touched, no installer or updater built, no deployment, no code changed. All findings are static-analysis based unless marked otherwise.

## Verdict

The cryptographic core is genuinely well built and survived direct attack: challenge replay, origin binding, signature/algorithm pinning, and credential-to-user binding all hold. Migration packaging is correct by computation. The defects are **not** in the crypto — they are in the identity and accountability layer around it, and they compose into one coherent chain that takes an attacker from unauthenticated network access to persistent, unaudited privileged access.

**Not merge-ready.** One HIGH chain (F1+F2+F3), one MEDIUM availability gap in the staged spooler, and several LOW items.

---

## Headline: a confirmed chain to silent, persistent privileged access

Each link below was traced in code. Individually they rank Low to Medium; combined they are the most serious result of this review. This chain applies when device auth is in `staged` or `enforced` mode.

1. **Unauthenticated account-existence oracle.** `POST /login/options` counts outstanding ceremonies in two different buckets: a *per-user* bucket for real accounts (`user_id = ?`) but a single *global shared* bucket for every nonexistent account (`is_decoy = 1`), at [webauthn.js:408-416](backend/routes/auth/webauthn.js:408). Sending `OPTION_MAX_OUTSTANDING` (4) requests with bogus user numbers fills the shared decoy bucket. From then on, any nonexistent number returns `429` while any real number returns `200` — a clean binary oracle that defeats the exact anti-enumeration purpose the decoy ceremony exists to serve.
2. **The oracle is effectively unthrottled.** `assertOptionThrottle` keys on `` `${req.ip}:${userNumber}` `` ([webauthn.js:43](backend/routes/auth/webauthn.js:43)), so each candidate number is its own throttle key and probing distinct candidates never accumulates. Probing is therefore cheaper and quieter than login brute force: it triggers no account lockout and writes no failed-login record.
3. **It identifies the break-glass credential specifically.** The generated programmer login is the only eight-digit numeric login in a fresh install (the seeded administrator is `009384`, staff PINs are shorter), so an existing eight-digit number is almost certainly the programmer — the one identity the design deliberately hides from every list endpoint.
4. **The numeric-login rate limiter can be bypassed.** Both counters at [auth.js:147-158](backend/routes/auth.js:147) key on `req.ip`, while [server.js:60](server.js:60) sets `app.set('trust proxy', true)` unconditionally, making `req.ip` derive from the client-supplied `X-Forwarded-For` header. Varying that header per request means neither the 5-attempt per-user nor the 20-attempt per-IP counter ever accumulates.
5. **Once authenticated, the programmer can self-enroll a browser credential with no step-up.** `requireRecentStepUp` opens with `if (req.user?.role === 'programmer') return next();` ([admin/deviceAccess.js:64](backend/routes/admin/deviceAccess.js:64)), and the enrollment target is resolved by `getActiveUser`, which filters on `is_active` only, with capacity checked against `ROLE_LIMITS.programmer = 2` ([policy.js:6](backend/services/webauthn/policy.js:6)) — not `0`.
6. **Thereafter, logins leave no audit trail.** `programmer_login` is written in exactly one place, [auth.js:211](backend/routes/auth.js:211), on the numeric-PIN path. The WebAuthn login route emits no audit event at all — the only events in that file are `device_enrollment_requested`, `device_enrollment_cancelled`, and `device_step_up_verified`.

**Caveat, stated honestly:** every endpoint in this chain enforces an exact `Origin` header against the allowlist before anything else, so a cross-site web attacker cannot drive it. A scripted non-browser client (curl and equivalents) sets `Origin` freely, so the chain is available to any attacker with network reach to the server. Step 4's practicality also depends on deployment: the Windows LAN install has no fronting proxy to sanitize `X-Forwarded-For`, whereas a Hostinger deployment behind lsnode may overwrite it.

---

## Findings

### F1 — Programmer is not excluded from device binding, and WebAuthn logins are unaudited (HIGH, confirmed)

The handoff states in §4 that `programmer` is "excluded from device binding entirely" and in §5 that "successful programmer login writes a security audit event." Both are false as written, and they fail together.

The exclusion exists only in *listing* SQL, so the admin picker never offers a programmer; the authorization path has no role check at all. `ROLE_LIMITS.programmer = 2` grants the same credential capacity as admin. `beginEnrollment` ([deviceAccess.js:104](backend/services/deviceAccess.js:104)) resolves its target through `getActiveUser` (no role filter) and passes `assertRoleCapacity` because the limit is nonzero. The route reaching it, `POST /device-access/enrollments`, is guarded by `requireRecentStepUp`, which exempts programmer outright.

The consequence is the audit gap in step 6 above. A programmer who enrolls a credential once can authenticate indefinitely through the WebAuthn path with no `programmer_login` row ever written. The entire governance story for a break-glass credential is that every use is recorded; this is a durable, self-service way around it.

This requires already holding programmer access, so it is insider accountability evasion rather than remote privilege escalation on its own — but it is precisely what the audit trail exists to catch, and the chain above supplies the way in.

**Fix direction:** set `ROLE_LIMITS.programmer = 0` and reject the role explicitly in `beginEnrollment`; write a `programmer_login` audit event on the WebAuthn login path as well as the numeric one.

### F2 — Login rate limiting is defeatable because `req.ip` is client-controlled (HIGH in context, confirmed in code; runtime-dependent)

Detailed as step 4 above. Both `trust proxy: true` and the throttle are **pre-existing on master** — this branch introduces neither. What the branch changes is the stakes: it puts a universal device-binding bypass behind that throttle. Roughly 26 bits of entropy (an eight-digit number) is thin protection for an identity that can log in from any browser, and it is the only barrier once the oracle in F3 identifies the target.

**Fix direction:** set `trust proxy` to the specific hop count or proxy list rather than `true`, or derive the throttle key from the socket address. Consider raising the programmer login's entropy.

### F3 — `/login/options` is an account-existence oracle (MEDIUM, confirmed)

Detailed as steps 1-2 above. Note that in this system `user_number` *is* the sole login credential, so enumerating valid numbers is directly valuable rather than merely informational.

**Fix direction:** give decoy ceremonies a per-submitted-identifier bucket (for example keyed on a hash of the submitted user number) so a nonexistent account is throttled indistinguishably from a real one.

### F4 — Warm-up barrier has no timeout; a stall blocks all printing (MEDIUM, staged spooler)

`startupWarmupBarrier = startupWarmupPromise.catch(...)` at [pos-spooler-printer/server.js:466](pos-spooler-printer/server.js:466) fails open only on *rejection*. Every job awaits it at [server.js:483](pos-spooler-printer/server.js:483). A warm-up that **hangs** rather than rejects never settles, and then every print job blocks behind it — not just the first. There is no `Promise.race` or timeout in the diff.

Severity is calibrated to MEDIUM rather than HIGH because the render path disables none of Puppeteer's internal timeouts (no `timeout: 0`, no `protocolTimeout` override, `setContent` uses `waitUntil: 'domcontentloaded'`), so the realistic worst case is a bounded 30-second-to-3-minute total print outage rather than a permanent one. That still lands on the low-resource Celeron hardware this change specifically targets, and it is untested — the new harness's mock Puppeteer never hangs.

**Fix direction:** one line — race the barrier against a timeout that logs and falls open.

### F5 — Cache-hit session revalidation is narrower than cache-miss (MEDIUM, latent, not currently live)

On a cache miss, `findActiveSession` checks `users.is_active`, credential status, and the enforced-mode credential requirement ([staffSessions.js:86-111](backend/services/staffSessions.js:86)). On a cache hit, the at-most-once-per-60-seconds `touchSession` checks only `revoked_at` and the two expiries ([staffSessions.js:115-130](backend/services/staffSessions.js:115)). Any future path that deactivates a user, revokes a credential, or flips enforcement *without* also setting `revoked_at` would leave a warm session authenticating for up to 30 minutes.

This was traced to a conclusion rather than reported as an alarm: the sole user-deactivation path does revoke durable sessions in-transaction at [users.js:294](backend/routes/admin/users.js:294), and all six current revocation call sites set `revoked_at`. It is a structural asymmetry, not a live hole. Socket.IO has no equivalent blind spot — its per-socket timer calls the fully authoritative `findActiveSession` unconditionally.

**Fix direction:** a guard comment at minimum, or fold the `is_active`/credential/mode checks into `touchSession`.

### F6 — Lower-severity items

- **Interceptor fails open on unrecognized 401 shapes (LOW).** [authInterceptor.js:35-45](src/shared/authInterceptor.js:35) redirects to login only when the body carries `SESSION_REQUIRED` or `SESSION_INVALID`, parsed inside a `try`. A non-JSON 401 (an HTML error page from a proxy) or any future bare `sendError(res, 401, ...)` leaves the user on a silently broken page instead of the login screen. The design itself is sound — those two codes come from exactly the two `requireAuth` failures at [auth.js:207,212](backend/middleware/auth.js:207), and letting domain 401s through to the caller is the intent.
- **Non-constant-time enrollment-code comparison (LOW).** [webauthn.js:560](backend/routes/auth/webauthn.js:560) uses `!==` on a SHA-256 hex digest where `verifyBootstrapSecret` correctly uses `timingSafeEqual`. Theoretical over network jitter; a leak still is not a preimage of the 160-bit code.
- **Dead recovery artifacts (LOW).** An unreachable `WEBAUTHN_RECOVERY_INVALID` message at [webauthn.js:204](backend/routes/auth/webauthn.js:204) whose only producer was deleted, and `'recovery_registration'` still listed in `ALLOWED_ACTIONS` at [browserDeviceCrypto.js:8](backend/services/browserDeviceCrypto.js:8), unreachable because `flow` is always server-chosen. Cleanup debt only.
- **Bootstrap gate is admin-or-programmer (LOW).** `requireAdmin` accepts both, so §4's "log in as administrator" is imprecise. Practically inert since programmer is already superuser-equivalent.
- **Spooler layer split (rollout gate, not a defect).** `thermal-raster.js` is in the shared `APPLICATION_ROOTS` layer while `chrome-headless-shell` is runtime-only. A machine receiving the core updater first would run the new `server.js` with no shell binary and fail every print. The plan document flags this and defers it to the runtime updater's gate, which is outside this diff and untested by it — consistent with the handoff's §9 rollout boundary.

---

## What genuinely holds (attacked and survived)

**Cryptography.** Challenges are 256-bit `crypto.randomBytes`. Every verify path takes a `SELECT ... FOR UPDATE` row lock inside a transaction and consumes via an atomic compare-and-swap — `UPDATE ... WHERE terminal_state='pending'` with an `affectedRows === 1` check that otherwise throws `WEBAUTHN_CEREMONY_REPLAYED` ([ceremonies.js:113-127](backend/services/webauthn/ceremonies.js:113)). The three verify paths that commit without a visible `finishCeremony` call — including the public, unauthenticated `/enroll/verify` — consume indirectly through `completeRegistration`, which calls it at [deviceAccess.js:233](backend/services/deviceAccess.js:233) inside the same transaction. Ceremonies also cap at three attempts and check flow match and expiry before any signature work.

Origin binding is exact string equality via `Array.includes` ([config.js:40](backend/services/webauthn/config.js:40)), with config-time canonicalization through `new URL()` rejecting non-HTTPS (except `http://localhost`), raw IPs, wildcards, embedded credentials, any path/query/fragment, and anything where `parsed.origin !== value`. Curve and hash are server-pinned (`kty:'EC', crv:'P-256'`, `crypto.verify('sha256', …, {dsaEncoding:'ieee-p1363'})`); no client `alg` field is ever read, so algorithm confusion has no surface. The signed message is fully server-constructed with `action = ceremony.flow`, so a signature made for enrollment cannot verify at login. Credential lookup is scoped to `ceremony.user_id`, which is always set server-side, so no client can assert an arbitrary target user. Proof fields reject control characters, preventing delimiter-injection field shifting.

**Sessions.** Raw tokens are cookie-only and stored as SHA-256 hashes; 30-minute idle and 12-hour absolute lifetimes are both enforced per request, with the cache path capping the idle slide at the absolute deadline. Re-login revokes at the correct boundary inside row-locked transactions. All six revocation call sites pair the DB write with token-cache eviction and socket disconnection. Enforced-mode credential requirement is double-enforced, in SQL and again in JS.

**Policy.** Mode transitions are staged→enforced only, gated and session-revoking, with mass assignment blocked. The bootstrap secret requires 256 bits, fails closed when unset, and compares via SHA-256 plus `timingSafeEqual`. Approval binds the exact key, so swapping the public key between request and completion fails; cancelled and expired ceremonies cannot complete. Credential limits are race-safe under `FOR UPDATE` with a recheck at commit. Admin APIs genuinely cannot create, assign, edit, or delete the programmer role.

**Migration packaging (verified by computation, not trust).** `.sql` and `.auto.sql` are byte-identical and both SHA-256 values match `auto-manifest.json`. The ledger checksum `20a660bd…` embedded in the migration's own `INSERT INTO schema_migrations` matches the manifest, and the declared predecessor `2026-08-13-split-quantity-precision-v1` matches that entry's checksum. The full 19-entry manifest chain is continuous. The Hostinger fallback block, extracted programmatically from between its markers, is byte-for-byte identical to the `.auto.sql`, and the post-floor slice matches manifest order index-for-index. All six SQL surfaces are free of `DELIMITER`, routines, triggers, definers, and grants. `runPendingMigrations.js` only *adds* a fail-closed preflight gate. Every statement is existence-guarded, so a half-failed run is safely retryable despite MySQL's non-transactional DDL. `docs/architecture.json` **was** properly updated (196 nodes, 52 flows, 405 steps; `architecture:check` passes) — the rule the previous branch violated is satisfied here.

**Recovery removal is complete.** All 25 routes across the three router files were enumerated; none is recovery-named. There are zero reads or writes against `webauthn_recovery_codes` outside schema introspection. The frontend component, route, link, and client functions were traced as added-then-deleted in `fb83e87f`. The retained recovery-named schema is genuinely dormant.

**Staged spooler correctness.** The property most worth breaking — duplicate receipts or lost acknowledgements from banding — holds cleanly. Band emission at [server.js:809-814](pos-spooler-printer/server.js:809) is a plain synchronous `for...of` with `applyPrintAlerts` and `printer.cut().close()` *outside* the loop, so out-of-order bands are structurally impossible and a 20-band job yields exactly one drawer kick, one cut, one acknowledgement. Band-start math and a full per-pixel 576×5000 twenty-band reconstruction were verified, bit order is MSB-first per the `GS v 0` spec, and the 513-row case provably emits 256 + 256 + 1. Timing logs carry only queue id, print type, numeric timings, and RSS — no receipt or customer data on any path including error handlers. The diff also incidentally fixes a pre-existing page leak by adding `try/finally { await page.close() }`. `.env` exclusion in the build script is pre-existing and untouched.

## Handoff accuracy

Every independently checkable fact is accurate: HEAD, merge base, commit count, 88 files / +8,546 / −209, unpublished branch, versions 1.0.6 and 1.2.6. `@simplewebauthn` really was added in `0a5e3d16` and removed in `651189d6`, with zero residual imports and zero lockfile entries. `DEVICE_AUTH_ALLOWED_ORIGINS` ships in both env templates while `DEVICE_AUTH_BOOTSTRAP_SECRET` ships in none, exactly as described. The programmer login is `crypto.randomInt`-generated at eight digits, written only to ACL-protected `secrets.json` and `bootstrap.json`, both deleted in a `finally` block that runs on every path, and shown once on fresh installs only — so "not written to .env or installation metadata" holds in effect.

The two claims that fail are both in §4/§5 and are covered by F1: programmer is **not** excluded from device binding, and programmer login is **not** universally audited.

## Recommended order

1. **F1** — close the programmer enrollment path and add the missing audit event. Smallest diff, removes the chain's endpoint.
2. **F3** — per-identifier decoy bucket. Removes the chain's entry point.
3. **F2** — scope `trust proxy` correctly. Fixes a pre-existing weakness that several defenses silently depend on; worth its own commit and note since it is not this branch's code.
4. **F4** — timeout on the warm-up barrier, before any spooler rollout.
5. **F5, F6** — guard comment and cleanup at the owner's discretion.

## Limits of this review

No tests were run, so nothing here is runtime-proven; every finding is traced statically and marked accordingly. The chain's practicality depends on deployment specifics (fronting proxy behaviour for `X-Forwarded-For`) that were not measured. The handoff's own §8 "manual validation still missing" matrix — Windows Chrome, Windows Edge, iPhone Safari, Android Chrome, plus private-browsing and site-data-clearing behaviour — remains outstanding and is not addressed by this review.
