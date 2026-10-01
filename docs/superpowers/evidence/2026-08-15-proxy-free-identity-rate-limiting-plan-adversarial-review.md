# Proxy-Free Identity Rate-Limiting Plan — Adversarial Review

**Review date:** 2026-08-15  
**Reviewed plan:** `docs/superpowers/plans/2026-08-14-proxy-free-identity-rate-limiting.md`  
**Plan SHA-256:** `c49f0049c123f22a9a2640fc4a15e812fbe279808c0157e3fd5b1ba898a27940`  
**Repository branch / HEAD:** `codex/webauthn-device-access` / `406d337a`  
**Verdict:** **BLOCK EXECUTION**

## Scope and evidence boundary

This is a read-only review of the plan against the current local authentication, registered-browser, rate-limit, and settings-cache contracts. It does not claim that the proposed plan has been implemented, and it does not make production-traffic, Hostinger-topology, customer-data, or customer-device claims.

Evidence used:

- The complete reviewed plan identified by the SHA-256 above.
- `backend/services/requestThrottle.js`
- `backend/routes/auth.js`
- `backend/routes/auth/webauthn.js`
- `backend/services/deviceAccess.js`
- `backend/routes/admin/deviceAccess.js`
- `backend/middleware/auth.js`
- `src/components/Login.vue`
- `src/shared/browserDeviceClient.js`
- `docs/architecture.json`
- A deterministic local SHA-256 collision-slot experiment reproduced below.

No production request was sent. No database or application state was mutated. No implementation test suite was run because the reviewed work is an unexecuted plan; the collision proof is a deterministic local calculation.

## Executive summary

The revised plan correctly repairs several earlier defects: it identifies `DEVICE_AUTH_REQUIRED` as a routing signal, attaches the real credential identity to authenticated requests, releases the database connection before applying delay, couples the redirect and Secure-cookie changes, and openly admits that the global unauthenticated ceiling has shared-fate behavior.

It still cannot be executed safely. Three blocking contradictions remain:

1. The proposed 12/minute `/login/options` bucket lets an unauthenticated attacker repeatedly block one known cashier.
2. The fixed 1024-slot unknown-candidate ring creates a practical saturate-then-probe user-enumeration oracle.
3. The required 15,000-candidate adversarial test is mathematically incompatible with the proposed shared 600/minute global ceiling.

The plan also leaves the global-ceiling response contract and authentication-mode cache semantics insufficiently specified for a lower implementation agent.

## Findings

### F1 — Critical: the options throttle is still a targeted cashier lockout

**Plan evidence**

- Goal line 5 forbids allowing an attacker to lock out or target a specific cashier.
- Invariant 2 at line 49 says no pre-authentication limit may hard-block a specific identity.
- Task 4 lines 335–352 assigns eligible candidates a dedicated bucket and retains the existing 12/minute hard limit.
- Adversarial gate item 2 at line 417 says no unauthenticated sequence may prevent a specific cashier from logging in.

**Runtime evidence**

- The real browser flow calls legacy `POST /api/auth/login` first and then calls `authenticateRegisteredDevice(userNumber)` when it receives `DEVICE_AUTH_REQUIRED` (`src/components/Login.vue:170-182`).
- `authenticateRegisteredDevice` must obtain `/api/auth/webauthn/login/options` before it can sign and verify (`src/shared/browserDeviceClient.js:105-108`).
- `createFixedWindowThrottle` accepts requests while `current.count <= limit` and refuses the next request (`backend/services/requestThrottle.js:37-39`).

**Attack sequence**

1. The attacker knows or guesses the cashier's submitted staff number.
2. The attacker sends 12 unauthenticated `/api/auth/webauthn/login/options` requests for that number within the one-minute window.
3. Those requests consume the eligible candidate's dedicated bucket.
4. The cashier's next options request is request 13 and receives 429 before browser proof can be completed.
5. The attacker repeats the sequence every minute.

The attack needs no registered browser, valid signature, session, proxy manipulation, or global-ceiling saturation. The 600/minute ceiling does not help because the attack needs only 13 requests.

**Impact**

An attacker can remotely deny service to one cashier using exactly the identity the plan promises never to make aimable. This is the same failure class as the earlier PIN lockout, moved from `/api/auth/login` to `/api/auth/webauthn/login/options`.

**Required correction**

Do not hard-deny browser options using a bucket keyed by the submitted cashier number. Changing 12 to a larger number does not fix the design. Task 4 must be redesigned around a pre-authentication browser identity that is not derivable from the cashier number, or must avoid candidate-specific hard denial entirely.

### F2 — Critical: the 1024-slot ring is a practical enumeration oracle

**Plan evidence**

Task 4 proposes:

```js
const UNKNOWN_SLOTS = 1024;
const key = eligible
    ? `candidate:${hashThrottlePart(userNumber)}`
    : `candidate:slot:${parseInt(hashThrottlePart(userNumber).slice(0, 8), 16) % UNKNOWN_SLOTS}`;
```

It then claims that collisions can leak only that a candidate is unknown, never that it is valid.

**Code evidence**

`hashThrottlePart` is ordinary unsalted SHA-256 (`backend/services/requestThrottle.js:3-5`). The slot function is therefore completely predictable offline. No server secret is required to find values mapping to a chosen slot.

**Reproduction**

The following local calculation reproduces the plan's exact slot function:

```js
const crypto = require('node:crypto');
const slot = value => parseInt(
    crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8),
    16
) % 1024;
```

For the synthetic candidate `1234`, the slot is `834`. Scanning only 10,548 synthetic values found these 12 distinct colliders:

```text
probe-1232
probe-1970
probe-2109
probe-3548
probe-5549
probe-5795
probe-6215
probe-6267
probe-6353
probe-7027
probe-9472
probe-10547
```

**Attack sequence**

1. Choose candidate `C` to test.
2. Compute `slot(C)` locally.
3. Find 12 synthetic unknown candidates mapping to that slot.
4. Submit each collider once, filling the unknown slot's 12-request budget.
5. Submit `C` once.

Result:

- If `C` is unknown, it uses the saturated slot and returns 429.
- If `C` is eligible, it uses a fresh dedicated real-candidate bucket and passes.

This is a deterministic user-enumeration oracle requiring 13 requests. The plan's test compares request 13 for a real candidate with request 13 for a **fresh** unknown candidate; it never preconditions the unknown slot. That test proves only the simplest request sequence and misses the actual hostile sequence.

**Impact**

The attacker can discover eligible staff numbers and then use F1 to keep a discovered cashier blocked. The fixed ring prevents unbounded key cardinality but does not preserve known/unknown indistinguishability.

**Required correction**

Known and unknown requests must not select observably different limiter namespaces after any attacker-controlled preconditioning. A corrected test must saturate the exact unknown slot first and then compare the candidate outcomes.

### F3 — Critical: the final test contract cannot pass with the global ceiling

**Plan evidence**

- Task 4 line 277 requires 15,000 distinct unknown `/login/options` requests to leave a known eligible cashier able to obtain options.
- Task 5 lines 378–382 installs one shared global ceiling of 600 unauthenticated requests per minute.
- Adversarial gate item 3 at line 418 repeats the requirement that 15,000 unknown candidates must not deny a known cashier.
- The limitations section correctly admits that saturating the global ceiling degrades everyone.

**Contradiction**

If the 15,000 requests occur in one fixed window, request 601 reaches the shared global ceiling and the subsequent cashier request must be refused. If the test advances time across windows, it no longer tests the burst/exhaustion scenario described by Task 4.

The plan cannot simultaneously require a shared 600/minute fail-closed ceiling and require a legitimate login to survive a 15,000-request burst. This is not an implementation detail; the specifications are mutually exclusive.

**Required correction**

Split the contracts explicitly:

- Prove that distinct attacker-controlled candidate values cannot exhaust a per-key store or selectively deny one cashier below the global ceiling.
- Separately prove and document the accepted shared-fate behavior when the global ceiling itself is saturated.

Do not retain a final gate that denies an accepted limitation elsewhere in the same plan.

### F4 — High: the global-ceiling response contract is not executable

Task 5 says one global middleware should return the "same generic failure as an ordinary bad login" and never return a distinguishable 429 on the login path. There is no single ordinary failure contract across the named surfaces:

- `/api/auth/login-policy` normally returns a 200 policy document.
- `/api/auth/login` can return 403 `DEVICE_AUTH_REQUIRED` in enforced mode or 401 for an invalid number in legacy modes.
- `/api/auth/webauthn/login/options` normally returns a 200 challenge/decoy-shaped response.
- Public preferences return settings JSON.
- `/public_menu.json` returns a file.

A single pre-route middleware cannot imitate all those contracts. A fabricated 401 or 403 can also send the login UI down the wrong branch. Because the global bucket does not vary by submitted candidate, a stable 429 does not itself reveal whether a candidate is valid.

**Required correction**

Name every route covered by the ceiling, define the exact saturation status/code/body for each route family, and add client handling for the login surfaces. Do not leave the lower agent to invent response semantics.

### F5 — High: authentication-mode caching lacks transaction and invalidation rules

**Code evidence**

- `readAuthMode(executor = pool)` accepts an explicit executor (`backend/services/deviceAccess.js:11-13`).
- Bootstrap registration changes `staff_device_auth_mode` from disabled to staged inside a transaction (`backend/services/deviceAccess.js:234-236`).
- The admin endpoint changes staged to enforced in a separate transaction (`backend/routes/admin/deviceAccess.js:226-243`).

Task 5 says only to add a short cache and invalidate it from the existing admin mode-change path.

**Failure modes**

- If explicit executor calls use the process cache, transaction-scoped code may observe a value outside its locked transaction.
- If only the admin path invalidates, successful bootstrap can leave cached `disabled` state after committing `staged`, producing a temporary broken setup/login flow.

**Required correction**

- Cache only default-pool reads.
- Bypass the cache whenever an explicit executor/transaction is supplied.
- Invalidate after commit for every runtime writer: bootstrap disabled-to-staged and admin staged-to-enforced.
- Test read-after-write behavior for both transitions and prove transaction reads bypass the cache.

### F6 — Medium: constraints and verification lists still disagree with implementation steps

1. Global constraint line 35 forbids forwarded-header parsing, while Task 1 explicitly parses `X-Forwarded-Proto`. The intended narrow redirect-only exception is defensible, but the constraint must say so.
2. Invariant 4 says throttle cardinality is bounded by real staff headcount. The plan itself adds 1,024 unknown slots, and the candidate-delay state is keyed by attacker-submitted candidate hashes. The state can be operationally bounded, but not by staff headcount as written.
3. Task 3's file list omits `backend/middleware/auth.js` and `backend/middleware/rateLimit.js` even though the task explicitly modifies both.
4. Task 5 requires a login-screen HTTPS test, but the final focused verification command does not name the existing login component test or another frontend test file that would contain it.

These are not equivalent to F1–F3, but they make the plan ambiguous for a lower agent and weaken its final proof.

## Confirmed strong parts

The following portions should be preserved during revision:

1. `DEVICE_AUTH_REQUIRED` is treated as routing, not a failed credential attempt.
2. Authenticated throttles prefer the registered-browser credential and fall back to user identity.
3. The plan verifies the real `requireAuth` contract and explicitly attaches `req.authCredentialId` instead of reading a nonexistent `req.session` field.
4. Bounded login delay is awaited only after the pooled connection is released.
5. Express proxy trust remains disabled and `req.ip` becomes audit metadata only.
6. The redirect, `ENFORCE_HTTPS`-driven Secure cookie, and client-side HTTP guard are treated as one coupled change.
7. The global ceiling's shared-fate limitation is stated rather than hidden.
8. No new dependency, migration, Redis service, CAPTCHA, or Hostinger-specific proxy variable is required.

## Minimum revision gate before implementation

The plan should not be handed to an implementation agent until all of these statements are true:

1. Knowing a cashier number is insufficient to consume a hard-denial budget belonging to that cashier.
2. Known and unknown candidates remain indistinguishable after an attacker pre-fills any candidate/slot state, not only from a fresh store.
3. Every adversarial test is compatible with the accepted behavior of the global ceiling.
4. The global ceiling has an exact route list and exact response/UI contract.
5. Authentication-mode cache reads and invalidations are transaction-safe and enumerate both runtime writers.
6. The constraints, task file lists, focused verification command, adversarial gate, and known limitations describe the same final architecture.

## Tests the next plan revision must contain

1. Twelve unauthenticated requests using a known cashier number do not prevent the real registered browser from obtaining options.
2. Pre-fill the computed unknown slot for a target candidate, then prove eligible and ineligible outcomes remain indistinguishable.
3. Generate more attacker-controlled identities than every per-key store capacity and prove no legitimate identity is selectively denied below the global ceiling.
4. Saturate the global ceiling and assert the explicitly accepted shared response for every covered route family.
5. Verify the login UI reports global saturation without converting it into session expiry, invalid registration, or HTTPS misconfiguration.
6. Verify cached default-pool auth-mode reads, explicit-executor cache bypass, bootstrap invalidation, and enforced-mode invalidation.
7. Verify no delay occurs while `pool.connectionTelemetrySnapshot().acquired - released` indicates a connection retained by the login handler.

## Final assessment

The five Opus corrections are technically useful and should not be reverted. The remaining failure came from testing isolated thresholds instead of stateful request sequences and from reviewing Tasks 4 and 5 separately rather than composing them.

The plan is materially improved but still unsafe. The correct next action is a focused rewrite of the pre-authentication options limiter and the global-ceiling test/response contracts—not another threshold adjustment and not a wider infrastructure project.
