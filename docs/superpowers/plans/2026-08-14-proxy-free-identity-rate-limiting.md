# Proxy-Free Identity Rate Limiting Implementation Plan (rev 3.4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `TRUST_PROXY` and every security decision derived from client IP, without (a) letting an attacker hard-deny a *specific* cashier, (b) exposing a deterministic status/body/abuse-control-state oracle for whether a staff number is valid in the enforced registered-device flow, (c) letting unauthenticated authentication traffic exhaust the database outside one explicit candidate-independent global admission gate, or (d) leaving PIN guessing unbounded. Candidate-ring collisions may add at most 5 seconds to a chosen cashier; that bounded, disclosed degradation is accepted because per-candidate state recreates the store-exhaustion defect.

**Plan state:** **READY FOR IMPLEMENTATION.** Rev 3.4 incorporates B7–B16 and closes the final Task 5 review findings without changing the architecture: route matching now mirrors Express's case-insensitive/non-strict behaviour and GET→HEAD fallback; both accepted body formats are capped before the gate; the watchdog observes but never falsifies concurrency accounting; streamed `public_menu.json` responses share the rate bound but not the database-work lease; and the existing Playwright harness proves the two UI states at runtime. Each behaviour was measured against this repo's own `express@5.2.1`, Node v24 and Playwright configuration rather than assumed.

This means the plan is internally executable and its stated evidence holds. It does **not** claim the runtime implementation exists, that the tests pass, or that deployment/device verification has happened. The remaining risk is now execution-shaped: RED/GREEN against the real code is the next thing that can find anything document review cannot.

**What this goal does NOT promise:** immunity from venue-wide degradation under a sustained unauthenticated flood, cryptographic constant-time responses, or protection from generic network/socket floods outside the named authentication routes. Task 5's gate is deliberately shared-fate: all covered routes share 600 admitted requests per minute, and covered dynamic routes additionally share 6 simultaneous requests. Saturating the rate bound affects every covered route; saturating dynamic concurrency affects the other dynamic routes. Exempting known-good identities would be observable, while abandoning live work would falsify the database bound. Both controls require no Hostinger or client-IP knowledge.

**Tech Stack:** Node.js, Express, Vitest, Supertest, MySQL/MariaDB, Vue 3 registered-browser ECDSA P-256 authentication.

---

## The rule that closes this design

Three revisions of this plan each fixed a specific limit and each shipped a new defect of the same family, because each was checked against the simplest request sequence rather than a hostile one. Rev 3 replaces threshold-tuning with a structural rule. **Every finding in rev 1, rev 2 and rev 2a is a violation of one of these three lines, and any future change to the pre-authentication surface must be checked against them before anything else:**

> **P1 — Exactly one submitted-candidate/request-volume hard-denial control exists on the covered pre-authentication surface: the candidate-independent global admission gate.** Its rate and concurrency dimensions return the same `SERVER_BUSY` response. Ordinary validation/authentication failures are not abuse controls; capability-local attempt exhaustion on an unguessable server-issued ceremony id remains allowed because possessing that id is required and exhaustion cannot be aimed by staff number. Every candidate-keyed pressure is bounded delay only; the delay can be aimed through a hash collision, but it can never exceed 5 seconds or deny login.
>
> **P2 — No pre-authentication abuse-control key derivation or abuse-control state transition may consult user existence, eligibility, or another non-public property of the submitted value.** Inputs producing the same public authentication outcome must mutate delay/limit state identically, *under any amount of attacker preconditioning*. Real authentication ceremonies necessarily persist server-side challenge/replay state while stateless decoys do not; that difference is not a limiter, delay, denial, or public response, and timing is explicitly outside the guarantee. In `disabled`/`staged`, successful and invalid PINs are inherently different public outcomes because the PIN is the credential; this property is about hidden abuse-control branching, especially enforced-mode `DEVICE_AUTH_REQUIRED`.
>
> **P3 — Attacker-keyed in-memory abuse state lives in fixed-size structures whose cardinality is a compile-time constant.** Unknown browser candidates create no durable ceremony row; real authentication ceremonies have a 2-minute pending TTL, and a failed authentication ceremony is deleted immediately. Successful consumed rows are legitimate authenticated history and retain the existing one-day cleanup.

The global admission gate is allowed to deny by construction: its key and concurrency count are global constants, so neither varies with anything the attacker submits. It cannot be aimed at one identity and cannot distinguish one candidate from another. That is the entire reason it is allowed to deny.

Net effect on the pre-auth surface after this plan:

| Surface | Control | Can it deny? | Can it be aimed? |
| --- | --- | --- | --- |
| `POST /api/auth/login` | global admission gate + bounded delay ring | gate only | gate: no; delay: collision can add at most 5 s |
| `POST …/webauthn/login/options` | global admission gate only | gate only | no — one global state, no candidate key |
| `POST …/webauthn/login/verify` | global admission gate + one-use authentication ceremony | gate or that ceremony only | no — all invalid-proof states share one public failure |
| `GET /api/auth/login-policy`, public preferences | global rate + dynamic semaphore | yes | no — one global state, no candidate input |
| `GET /public_menu.json` | global rate only | yes | no — one global state, no candidate input |
| Everything authenticated | credential → user key | only the actor's own budget | no |

---

## Defect record — do not reintroduce

**B1 — Remote cashier lockout.** In `enforced` mode `POST /api/auth/login` always returns 403 `DEVICE_AUTH_REQUIRED` and calls `recordFailedLogin()` first (`backend/routes/auth.js:174-177`). The login screen always calls that endpoint before falling back to the device flow (`src/components/Login.vue:170`), and `webauthn.js` never clears the legacy counters. Re-keying that counter from `${req.ip}:${userNumber}` to a global candidate hash means five ordinary logins lock a cashier out of *every* terminal, and any attacker locks any known staff number remotely with five unauthenticated requests, forever. *Violates P1.*

**B2 — Unbounded PIN spray.** Deleting the blanket `/api` limiter (1000/min) and the public limiter (60/min) with nothing in their place. A per-candidate bucket keys on the *submitted* number, so walking `0001, 0002, 0003…` mints a fresh bucket every time and never throttles. With `user_number` being the entire credential, that is the whole attack. Hostinger offers no confirmed endpoint-level rate limiting to delegate this to.

**B3 — Store-exhaustion login outage.** `createFixedWindowThrottle` returns `false` for a **new** key once its store reaches `maxEntries` (10 000) — it fails closed (`backend/services/requestThrottle.js:31-34`). The per-IP leg at `webauthn.js:34` is the only thing bounding how fast one machine mints distinct keys. Removing it lets one attacker create >10 000 distinct candidate keys inside the window, after which every cashier not already resident in the store is refused. *Violates P3.*

**B4 — Outstanding-ceremony venue outage (found in rev 2a; not present in rev 1's reviews).** `/login/options` enforces a **global** cap of 500 pending authentication ceremonies (`OPTION_MAX_OUTSTANDING`, `backend/routes/auth/webauthn.js:399-404`), and **every** options call inserts a `webauthn_ceremonies` row — decoys included (`webauthn.js:406` → `createCeremony` always `INSERT`s, `backend/services/webauthn/ceremonies.js:43`). TTL is 2 minutes (`CEREMONY_TTL_MS`). Today only `optionIpAttempts` (60/min) keeps that cap out of reach. Delete the IP leg and keep a 12/min per-candidate limit, and 42 distinct candidates × 12 = 504 rows inside one window makes every subsequent options call return 429 for **everyone** — and `/login/options` is the only path past `DEVICE_AUTH_REQUIRED` (`Login.vue:182`). That is a total venue login outage costing 504 requests. *Violates P1: a global cap reachable by cheap attacker input is a hard-denial control that is not the ceiling.*

**B5 — Targeted lockout moved, not removed (rev 2/2a).** Retaining the 12/min candidate-keyed hard limit on `/login/options` reproduces B1 on a different route: 12 unauthenticated requests per minute against a known staff number deny that cashier the only route past `DEVICE_AUTH_REQUIRED`. Raising 12 to any number does not fix it. *Violates P1.*

**B6 — Saturate-then-probe enumeration oracle (rev 2a).** Giving eligible candidates a dedicated bucket and unknown candidates a shared 1024-slot ring is distinguishable *after preconditioning*, even with an identical limit on both: `hashThrottlePart` is unsalted SHA-256 (`requestThrottle.js:3-5`), so an attacker computes colliders offline, fills the target's unknown slot with 12 synthetic values, then submits the candidate — 429 means unknown, success means real. 13 requests per candidate. The rev 2a test compared a *fresh* unknown against a real one and never preconditioned the slot, so it passed while the defect stood. *Violates P2.*

**B7 — Hidden delay-state enumeration (found in rev 3).** Rev 3 mapped enforced-mode `DEVICE_AUTH_REQUIRED` to `failed:false` for a real user but mapped the byte-identical unknown-user response to `failed:true`. Repetition therefore produced `0,0,0…` delay for a real user and `0,0,1s,2s,4s,5s` for an unknown user. The HTTP body was uniform while hidden state was not. Rev 3.1 replaces the boolean with explicit `delayAction` and assigns `keep` to every `DEVICE_AUTH_REQUIRED` outcome. *Violates P2.*

**B8 — Repeat-verify and cross-flow oracle (found in rev 3).** Rev 3 normalised only a missing ceremony. A bad proof for a real authentication ceremony terminalised its row, so retrying the same id returned expired/invalid while a stateless decoy id kept returning generic 401. Worse, passing an enrollment/step-up ceremony id to login verification could make the shared catch mark that unrelated ceremony failed. Rev 3.1 makes every candidate-dependent login-proof failure the same 401, deletes only the failed `authentication` row, and never mutates another flow.

**B9 — Threshold and resource-composition contradiction (found in rev 3).** Rev 3 required 600 unknown options calls followed by a successful real call while its own 600/minute ceiling necessarily rejected request 601. It also treated a rate counter as a concurrency bound, although the first 600 requests could arrive together against a 10-connection pool. Rev 3.1 tests rate and concurrency separately in the same constant-key gate and keeps hostile integration traffic explicitly below the gate.

**B10 — Socket-lifetime concurrency lease: a 6-socket venue outage (found in rev 3.1, introduced by rev 3.1's own B9/R3-5 fix).** Rev 3.1 mounted the gate **before** body parsing and released the concurrency lease only on `res.finish`/`res.close`. The lease therefore covered the whole socket lifetime, including the wait for a request body that `express.json` (`server.js:248`) has not yet read. Verified numbers: `server.js` sets neither `server.requestTimeout` nor `server.headersTimeout`, so Node's defaults apply — measured on this machine's Node v24 as `requestTimeout = 300000`, `headersTimeout = 60000`. Complete headers satisfy `headersTimeout`; an incomplete body then holds the socket, and the lease, for **five minutes**.

Attack: open six sockets, send `POST /api/auth/login` with a valid `Content-Length` and one byte of body. Six leases are held, `inFlight` reaches `maxConcurrent`, and **every covered pre-authentication route returns `SERVER_BUSY` for five minutes** — including `/login/options`, the only path past `DEVICE_AUTH_REQUIRED`. Total venue login outage for six sockets and six bytes, repeatable forever, from one machine.

This is ~100× cheaper than the 600-requests/minute dimension it was added beside, and it is **not** covered by the "generic socket flood" limitation: six sockets is not a flood, and the amplification comes from this design choice, not from network volume. A second path reaches the same state without any attacker: `pool.getConnection()` has `waitForConnections: true` with no acquire timeout (`backend/config/databasePoolOptions.js`), so if authenticated checkout traffic occupies all ten connections, gated pre-auth handlers wait indefinitely while holding leases.

Rev 3.4 fixes the *lease*, not the number: the gate moves **after** both tight body parsers so an unsent body cannot hold a lease; buffered dynamic responses release on `res.end`; the only covered streaming route (`public_menu.json`) takes no concurrency lease; and the watchdog reports a hung handler without releasing work it did not cancel. *Violates P1 — a hard-denial control reachable at trivial cost is not the single, expensive, candidate-independent gate the design promises.*

**B11 — Test contracts that the selected runner cannot execute (found in rev 3.2, corrected again in rev 3.4).** `@vue/test-utils`, `jsdom` and `happy-dom` are absent and Vitest runs in Node, so the existing Vitest component check must remain source-contract only. That does **not** mean browser behaviour is untestable: `@playwright/test` is installed and the repo already has an E2E harness. Rev 3.4 keeps the fast source assertions and adds one collected focused Playwright spec for the two runtime states. Separately, `app.use(matcher, parser)` is a chain, not a guard; the parser must be invoked conditionally. *A test contract must be assigned to a runner that can actually execute it.*

**B12 — Non-booting intermediate commit (found in rev 3.2).** The plan told Task 2 to leave no export named `createIpRateLimiter` while `server.js:46,254,264,272` and `backend/routes/admin/printTemplates.js:5,23,30` still imported it. `require` of a missing named export yields `undefined`, so `server.js:254` would throw a `TypeError` at module load — **that commit would not boot**, and the very next task would have fixed it, hiding the break from anyone who ran the tasks back to back. Task 3 compounded it by asserting `server.js` no longer contains `createIpRateLimiter` while deliberately keeping `publicRateLimit`, which uses it. Rev 3.3 retires the factory across three tasks with an explicit table and moves the absence assertion to Task 5. *Every commit in this plan must boot and pass on its own; "the next task fixes it" is not a defence.*

**B13 — Express route-alias gate bypass (found in rev 3.3).** Rev 3.3 compared `req.method` and `req.path` as exact strings. This repo does not enable case-sensitive or strict routing, and Express automatically services `HEAD` through matching `GET` handlers. Measured against `express@5.2.1`: `POST /api/auth/login/`, `POST /API/AUTH/LOGIN`, and `HEAD /api/auth/login-policy` reached their real handlers while the exact predicate returned false. The first two also bypassed the 16 KB parser. Rev 3.4 normalizes case and trailing slashes and maps `HEAD` to `GET` in the one shared predicate. *A security middleware matcher must cover every alias accepted by the protected router.*

**B14 — Content-type parser bypass (found in rev 3.3).** The tight parser covered JSON only, while the existing global URL-encoded parser still accepted 1 MB bodies before the gate. A 50 KB `application/x-www-form-urlencoded` login body parsed and reached the handler successfully. Rev 3.4 conditionally runs both tight parsers before their global counterparts. *A body-size boundary applies to every accepted parser, not only the normal client's content type.*

**B15 — Watchdog accounting escape (found in rev 3.3).** Releasing a lease after 15 seconds did not cancel the handler, its query, or its pool wait. Six new requests could therefore be admitted every 15 seconds while old work remained: 24 per minute, below the 600/minute ceiling, enough to fill the 10 active plus 50 queued pool slots in about 150 seconds. Rev 3.4 makes the watchdog observational only. It logs a stuck handler, but only actual response completion or close decrements `inFlight`. *A semaphore may not forget work it did not cancel.*

**B16 — Stream backpressure and false frontend-test concession (found in rev 3.3).** `res.end` is called before client drain for buffered JSON responses, but not necessarily for a backpressured `sendFile`/stream: a paused 64 MB response kept the lease and denied the next request in a measured probe. `public_menu.json` is the only covered streaming response, so rev 3.4 keeps it inside the global rate budget but skips the database-work lease; cache generation is already single-flight in `backend/config/menuCache.js`. Separately, Vue unit mounting is unavailable, but Playwright is installed and configured. Rev 3.4 adds a collected focused browser spec instead of claiming runtime UI proof is impossible.

Also rejected during review, with reasons:

- A **device cookie** tier — forgeable, so it hands attackers unlimited fresh buckets while only helping honest users; and it would be this codebase's first long-lived cookie.
- A **known-set LRU** exempting recently-successful candidates from the ceiling — it empties on every restart (right after a deploy every real cashier is "unseen" at once), its size is venue-dependent (reintroducing operator tuning), and any exemption is observable. *Violates P2.*
- A **device-proof bypass** of the candidate delay — the device proof message binds `action/origin/ceremonyId/challenge` and **never** the candidate number (`webauthn.js:77-85`), so one legitimate device would become an unthrottled amplifier for grinding every other user's PIN.

---

## Global constraints

- Do not deploy, change Hostinger settings, mutate production data, merge, push, or rebuild installers.
- Do not add a dependency, migration, Redis, CAPTCHA, new environment variable, or proxy discovery.
- **Forwarded headers may influence exactly one thing: the HTTP→HTTPS 301 in Task 1.** No forwarded header may reach a throttle key, a delay key, a lockout, an audit actor, or any authorization decision. (Rev 2a's blanket "no forwarded-header parsing" constraint contradicted its own Task 1; this is the corrected form.)
- **Do not touch POS `localStorage` behaviour.** The twelve `POS_ORDER_KEYS` (cart, order context, active table, held-claim handoff, …) are independent of cookies and must keep surviving refresh and re-login. The only permitted clear-on-401 is the existing `call_center`-scoped one at `src/shared/authInterceptor.js:48`; do not widen it.
- Do not trust `X-Forwarded-For`, `X-Real-IP`, a hop count, `loopback`, or any guessed topology.
- `req.ip` may remain only as explicitly non-authoritative audit/diagnostic metadata (including the existing unused `client_ip` settings field). It may never select, allow, deny, delay, throttle, or authorize anything.
- Do not persist submitted PIN candidates in plaintext keys — use `hashThrottlePart`.
- Do not weaken registered-browser enforcement, exact-origin checks, ceremony replay protection, session revocation, programmer-role rules, or print idempotency.
- Test runner is **Vitest** (`npx vitest run`), one process at a time (shared `posapp_test`). Use focused files; full suite only if a focused failure implies wider breakage.
- Do not edit, stage, or commit these user-owned files:
  - `docs/superpowers/evidence/2026-08-14-webauthn-device-access-adversarial-review.md`
  - `docs/superpowers/evidence/2026-08-15-proxy-free-identity-rate-limiting-plan-adversarial-review.md`
  - `docs/2026-08-14-client-ip-rate-limiting-research.md`

## Invariants — each is a test, and each is checked against a *preconditioned* store, not a fresh one

1. No forwarded header changes any throttle key, delay key, or authorization decision.
2. **P1:** the global admission gate is the only request-volume control that denies on the covered pre-auth routes. No candidate-keyed counter returns 429/403; normal validation and invalid-proof responses remain allowed authentication outcomes.
3. **P2:** every pre-auth abuse-control key is a pure function of request data, and two requests with the same public authentication outcome cause the same delay/limit-state transition. No abuse-control key or state action branches on hidden user existence or eligibility.
4. **P3:** attacker-keyed in-memory state never exceeds its compile-time constant. Unknown browser candidates create zero durable rows; failed authentication rows are deleted immediately; pending real rows expire after 2 minutes.
5. Two different authenticated devices always have independent budgets.
6. Every delay runs **after** the database connection is released.
7. In enforced mode, known and unknown candidates are indistinguishable in status, code, message, shape, and delay-state action on `/login`. On browser verification, every invalid-proof path is equally indistinguishable, including replay/expired/exhausted ids. A valid registered-browser signature may succeed by design. Timing is explicitly outside the guarantee.
8. The global admission gate runs **after** tight JSON and URL-encoded body parsing, caps admitted requests per minute on every covered route, and caps simultaneous dynamic server work. A dynamic lease releases exactly once, on `res.end` or close; the watchdog logs but never releases work it did not cancel. `public_menu.json` shares the rate ceiling but never takes a concurrency lease because its normal path is a static stream and its cache-miss generation is already single-flight. No lease is held while waiting for a request body, and authenticated routes are never counted.

---

## Task 1: Separate hosted HTTPS from proxy trust

**Files:**
- Create: `backend/tests/unit/networkBoundaryPolicy.test.js`
- Modify: `backend/tests/unit/sessionCookies.test.js`, `backend/tests/unit/installerWebAuthnConfig.test.js`
- Modify: `backend/services/sessionCookies.js`, `server.js`
- Modify: `deployment/templates/hostinger.env.template`, `deployment/templates/pos.env.template`
- Delete: `backend/config/trustProxy.js`, `backend/tests/unit/trustProxy.test.js`

- [ ] **Step 1 — failing tests**

```js
// sessionCookies.test.js — policy, not req.secure, decides Secure
it('marks the cookie Secure from deployment policy even behind TLS termination', () => {
    const res = response();
    setSessionCookie(res, 'opaque-token', { secure: false }, { enforceHttps: true });
    expect(res.getHeader('Set-Cookie')).toBe('pos_token=opaque-token; HttpOnly; Secure; SameSite=Strict; Path=/');
});
```

```js
// installerWebAuthnConfig.test.js
expect(`${pos}\n${hostinger}`).not.toMatch(/^TRUST_PROXY=/m);
expect(pos).toContain('ENFORCE_HTTPS=false');
expect(hostinger).toContain('ENFORCE_HTTPS=true');
```

```js
// networkBoundaryPolicy.test.js (new)
const fs = require('node:fs');
const path = require('node:path');
const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

describe('network boundary policy', () => {
    it('never trusts forwarded proxy identity', () => {
        expect(serverSource).not.toContain("require('./backend/config/trustProxy')");
        expect(serverSource).not.toMatch(/app\.set\(['"]trust proxy['"]/);
    });

    it('never decides the redirect from req.protocol (which requires proxy trust)', () => {
        expect(serverSource).not.toMatch(/req\.protocol/);
    });
});
```

Plus redirect behaviour tests (owner decision: **the HTTP→HTTPS redirect is retained**):

```js
// 301 only on positive evidence of http; never on ambiguity (that is the loop).
it('redirects when the edge reports plaintext', () => expectRedirect({ 'x-forwarded-proto': 'http' }));
it('does not redirect when the edge reports https', () => expectPass({ 'x-forwarded-proto': 'https' }));
it('does not redirect when no forwarded protocol is present', () => expectPass({}));
```

- [ ] **Step 2 — run RED:** `npx vitest run backend/tests/unit/sessionCookies.test.js backend/tests/unit/installerWebAuthnConfig.test.js backend/tests/unit/networkBoundaryPolicy.test.js`

- [ ] **Step 3 — implement**
  - In `server.js`: delete the `readProxyPolicy` import (`:46` region), the `proxyPolicy` construction, and `app.set('trust proxy', …)` (`:63`). Keep `const ENFORCE_HTTPS = process.env.ENFORCE_HTTPS === 'true';`. Leave Express at its default `trust proxy = false`.
  - **Retain the HTTP→HTTPS redirect** (owner decision), but stop deriving it from `req.protocol` (`server.js:230`), which only reports `https` when Express trusts a proxy and is therefore the direct cause of the redirect loop. Replace the condition with positive-evidence-only logic:

```js
// Redirect ONLY on positive evidence of plaintext. `req.protocol` is unusable here:
// with trust proxy off it always reports 'http' behind TLS termination, which loops forever.
// Ambiguous case (no forwarded header, no TLS) must NOT redirect — we cannot distinguish
// "direct plaintext" from "proxy that does not forward the header", and guessing loops.
const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
const knownPlaintext = !req.secure && forwardedProto === 'http';
if (knownPlaintext) return res.redirect(301, `https://${host}${req.originalUrl}`);
return next();
```

  - **Why reading this header is safe here, and only here:** forging `X-Forwarded-Proto: https` lets an attacker skip *their own* redirect while browsing plaintext — a choice they could already make by ignoring a 301. It grants no identity, no rate-limit budget, and no authorization. Header trust is dangerous when it feeds identity; this feeds a 301 only. Verified precondition: `req.protocol`/`req.secure` appear in exactly one place in the codebase (this redirect), so nothing else can be influenced.
  - **Hard coupling — do not split these two changes.** This is safe only because the `Secure` cookie decision below stops depending on the protocol. If the cookie still read `req.secure`, a forged header could influence cookie flags.
  - In `backend/services/sessionCookies.js`, make deployment policy the sole decision, keeping the call signature. **This is a live fix, not a refactor:** the current `enforceHttps && Boolean(req?.secure)` (`sessionCookies.js:5`) can never be true behind Hostinger, because Node serves plain HTTP and `req.secure` is always false — so the session cookie ships today **without** the `Secure` flag on the hosted deployment.

```js
function secureFor(_req, options) {
    return options?.enforceHttps ?? process.env.ENFORCE_HTTPS === 'true';
}
```

  - Remove `TRUST_PROXY` from both templates; keep `ENFORCE_HTTPS=true` (Hostinger) and `ENFORCE_HTTPS=false` (Windows).
  - Delete `backend/config/trustProxy.js` and its test. Leave no compatibility shim.

- [ ] **Step 4 — GREEN + commit**

```bash
npx vitest run backend/tests/unit/sessionCookies.test.js backend/tests/unit/installerWebAuthnConfig.test.js backend/tests/unit/networkBoundaryPolicy.test.js && node --check server.js
```

```bash
git commit -m "fix: decouple hosted HTTPS from proxy trust"
```

---

## Task 2: One keyed limiter, with isolated stores

**Files:** `backend/middleware/rateLimit.js`, `backend/tests/unit/rateLimit.test.js`

**Add the new factory; do NOT remove the old one in this task.** Verified consumers of `createIpRateLimiter`: `server.js:46` (used at `:254` `apiRateLimit`, `:264` `publicRateLimit`, `:272` `checkoutRateLimit`), `backend/routes/admin/printTemplates.js:5` (used at `:23`, `:30`), and `backend/tests/unit/rateLimit.test.js:1`. Removing the export here would make `require` yield `undefined` and throw a `TypeError` at `server.js:254` on module load — **the server would not boot on this commit**. The consumers are retired across three tasks and the last one, `publicRateLimit`, does not go away until Task 5:

| Task | What happens to `createIpRateLimiter` |
| --- | --- |
| 2 (here) | `createKeyedRateLimiter` is added beside it. Both are exported. Nothing else changes. |
| 3 | `apiRateLimit`, `checkoutRateLimit` and the two print limiters migrate off it. `publicRateLimit` still uses it. |
| 5 | `publicRateLimit` is replaced by the gate. **Only now** delete `createIpRateLimiter`, its export, and its tests. |

Task 6's scan for `createIpRateLimiter` therefore runs after Task 5 and is expected to be clean at that point, not before.

- [ ] **Step 1 — failing tests:** require an explicit key function; prove two identities are independent; prove a missing identity fails closed via `next(error)`; prove each limiter instance owns a **separate store** (exhausting one does not affect another).

```js
it('rejects a missing key function at construction', () => {
    expect(() => createKeyedRateLimiter({ windowMs: 1000, max: 2 }))
        .toThrow('A rate-limit key function is required.');
});

it('gives each limiter its own store', () => {
    const a = createKeyedRateLimiter({ windowMs: 1000, max: 1, keyForRequest: r => r.k });
    const b = createKeyedRateLimiter({ windowMs: 1000, max: 1, keyForRequest: r => r.k });
    // exhausting `a` for key "x" must leave `b` able to serve key "x"
});
```

- [ ] **Step 2 — implement**

```js
const { createFixedWindowThrottle } = require('../services/requestThrottle');

function createKeyedRateLimiter({ windowMs, max, message = 'Too many requests.', code, onLimit, keyForRequest, maxEntries } = {}) {
    if (typeof keyForRequest !== 'function') throw new Error('A rate-limit key function is required.');
    // Each limiter owns its own store so exhaustion on one surface cannot fail-close another.
    const throttle = createFixedWindowThrottle({ windowMs, limit: max, ...(maxEntries ? { maxEntries } : {}) });

    return (req, res, next) => {
        let key;
        try { key = String(keyForRequest(req) || '').trim(); }
        catch (error) { return next(error); }
        if (!key) return next(new Error('Rate-limit identity is unavailable.'));
        if (!throttle.consume(key)) {
            onLimit?.({ key });
            res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
            return res.status(429).json({ success: false, ...(code ? { code } : {}), message });
        }
        return next();
    };
}

// Both exported until Task 5 retires the last createIpRateLimiter consumer (publicRateLimit).
module.exports = { createIpRateLimiter, createKeyedRateLimiter };
```

- [ ] **Step 3 — GREEN + commit** (`npx vitest run backend/tests/unit/rateLimit.test.js backend/tests/unit/requestThrottle.test.js`)

```bash
git commit -m "refactor: require explicit rate limit identities"
```

---

## Task 3: Key authenticated work by device, then user

Satisfies invariant 5. A cashier working two terminals gets two independent budgets, because each terminal has its own credential. Every limiter here is keyed by the *actor's own* identity, so its hard denial is self-inflicted and can never be aimed at someone else — that is why P1 does not apply to authenticated surfaces.

**Files:** `server.js`, `backend/middleware/auth.js`, `backend/middleware/rateLimit.js`, `backend/routes/pos/checkout.js`, `backend/routes/admin/printTemplates.js`, `backend/routes/spooler.js`, plus `backend/tests/unit/networkBoundaryPolicy.test.js`, `backend/tests/unit/checkoutModuleWiring.test.js`, `backend/tests/integration/printTemplates.test.js`, `backend/tests/integration/spoolerPoll.test.js`.

- [ ] **Step 1 — failing tests**
  - `networkBoundaryPolicy.test.js`: assert `server.js` no longer contains `apiRateLimit` or the server-level checkout mount (`server.js:649`). **Do not assert the absence of `createIpRateLimiter` here** — `publicRateLimit` still uses it until Task 5, so that assertion belongs in Task 5 and would fail red-for-the-wrong-reason if written now.
  - `checkoutModuleWiring.test.js`: assert `checkoutRateLimit` sits **after** `requireAuth` and `rejectCallCenterRole` on `/checkout`, `/checkout/jofotara`, `/checkout/jofotara/status`.
  - `printTemplates.test.js`: prove rotating `X-Forwarded-For` cannot create a fresh budget, and that a second admin on the same peer keeps an independent budget.
  - `spoolerPoll.test.js`: 31 polls for `spooler-a` yield 429 while `spooler-b` on the same peer is unaffected; `/ack` stays outside the budget.

- [ ] **Step 2 — expose the credential id, then key on it.**

  **Verified precondition:** `requireAuth` attaches **only** `req.user` (`backend/middleware/auth.js:215`). There is no `req.session`. `verifyToken` returns the user object, not the session, so a helper reading `req.session?.credential_id` would be `undefined` on every request and silently fall back to user-keying — the per-device guarantee would be absent with no error. Attach it explicitly first.

  In `backend/middleware/auth.js`, immediately after `req.user = user;` (line 215). `tokenCache` and `hashToken` are module-local and already in scope, and the cache entry carries `credentialId` on both the pre-warm and DB-miss paths (`:92`, `:181`):

```js
    req.user = user;
    // Per-device throttle identity. Null in staged/disabled mode (no bound credential).
    req.authCredentialId = tokenCache.get(hashToken(rawToken))?.credentialId || null;
    next();
```

  Then add to `backend/middleware/rateLimit.js`:

```js
// Prefer the registered-browser credential (a real per-device identity) over the user,
// so one cashier on two terminals gets two independent budgets.
const actorKey = req => (req.authCredentialId
    ? `credential:${req.authCredentialId}`
    : (req.user?.id ? `user:${req.user.id}` : null));
```

  Task 3's committed export must be `module.exports = { createIpRateLimiter, createKeyedRateLimiter, actorKey };`. The old factory remains exported only for `publicRateLimit` until Task 5; the new actor helper must already be exported because Task 3's checkout and print routes consume it.

- [ ] Add a test asserting `req.authCredentialId` is populated for a credential-bound session and `null` for a PIN-only session, and that two sessions with different credentials produce different `actorKey` values for the same user id.

- [ ] **Step 3 — remove identity-less server buckets.** In `server.js` delete `RATE_LIMIT_WINDOW`, `RATE_LIMIT_MAX`, `apiRateLimit`, `app.use('/api', apiRateLimit)` (`:252-259`), `CHECKOUT_RATE_LIMIT_MAX`, and the server-level `checkoutRateLimit` (`:271-274`, `:649`). **Keep the `createIpRateLimiter` import (`:46`) and `publicRateLimit` mounted** (`:264`, `:654`, `:670`) — Task 5 replaces that last one with the global admission gate, so the public surface is never unprotected between commits and this commit still boots.

- [ ] **Step 4 — apply per-surface limiters** (each its own instance, therefore its own store):

| Surface | Key | Limit |
| --- | --- | --- |
| `/checkout`, `/checkout/jofotara`, `/checkout/jofotara/status` | `actorKey` | 30/min |
| Print template preview (`printTemplates.js:23`) | `actorKey` | 120/min |
| Print test print (`printTemplates.js:30`) | `actorKey` | 10/min |

  **Do not delete `directPeerIp` (`printTemplates.js:18`)** when the limiters stop using it — it is still the audit `ipAddress` source at `:156`, `:283` and `:302`. It stays as explicitly non-authoritative audit metadata, which the global constraints allow. **Auth ordering verified:** `backend/routes/admin.js:6` applies `requireAuth` before mounting this router at `:57`, so `req.user` and `req.authCredentialId` are populated when `actorKey` runs; the limiter cannot fail closed for lack of identity.
| Spooler `/poll` (`spooler.js:19-20`) | `spooler:<validated id>` | existing `SPOOLER_POLL_RATE_MAX` |

  **Spooler correction (verified):** `resolvePollSpoolerId(req)` already runs and already sets `req.spoolerId` (`backend/routes/spooler.js:19,34`). No new middleware is needed — the change is to drop the IP prefix from the key at `spooler.js:20`, leaving `` `spooler:${spoolerId}` ``. ACK is never limited.

- [ ] **Step 5 — GREEN + commit**

```bash
git commit -m "fix: throttle POS operations by device then user identity"
```

---

## Task 4: Make the pre-authentication surface unaimable and un-probeable

This task carries B1, B3, B4, B5 and B6. Read **The rule that closes this design** before starting; every step below is a direct consequence of P1/P2/P3.

**Files:**
- Create: `backend/services/loginDelay.js`, `backend/tests/unit/loginDelay.test.js`
- Modify: `backend/routes/auth.js`, `backend/routes/auth/webauthn.js`, `backend/services/ManagerOverrideService.js`, `backend/routes/pos/checkout.js` (drawer pop)
- Rename + rewrite: `backend/tests/integration/loginProxyTrust.test.js` → `backend/tests/integration/loginRateLimitIdentity.test.js`
- Modify: `backend/tests/integration/browserDeviceProof.test.js`, `backend/tests/integration/security.test.js`, `backend/tests/integration/permissions.test.js`, `backend/tests/unit/checkoutModuleWiring.test.js`

### Step 1 — the delay primitive (P1 + P3 in one file)

- [ ] Create `backend/services/loginDelay.js`. It is a **fixed-length array**, not a Map — cardinality is a compile-time constant, so there is no growth, no cleanup interval, and no fail-closed point. Key derivation is a pure function of the submitted string, so it is identical for real and fake staff numbers (P2).

```js
const { hashThrottlePart } = require('./requestThrottle');

const DELAY_SLOTS = 4096;
const DELAY_WINDOW_MS = 5 * 60 * 1000;
// index = consecutive failures in the window; the last entry is the cap.
const DELAY_STEPS_MS = [0, 0, 1000, 2000, 4000, 5000];

// `now` is injectable exactly as in requestThrottle.js, so unit tests cover the whole
// schedule without sleeping. There is deliberately NO injectable `wait`: the route awaits
// a plain setTimeout, and the one integration test that must observe the wait tolerates a
// real 1 s delay. Test-only hooks in production auth code are not worth the seam.
function createDelayRing({ now = Date.now } = {}) {
    const slots = Array.from({ length: DELAY_SLOTS }, () => ({ count: 0, startedAt: 0 }));

    // P2: derived from the submitted value alone. No DB, no user lookup, no eligibility.
    const slotFor = value =>
        parseInt(hashThrottlePart(String(value || '').trim()).slice(0, 8), 16) % DELAY_SLOTS;

    return {
        slotFor,
        // Pure read — never touches the pool. Call before the DB phase.
        pendingDelayMs(slot) {
            const state = slots[slot];
            if (now() - state.startedAt >= DELAY_WINDOW_MS) return 0;
            return DELAY_STEPS_MS[Math.min(state.count, DELAY_STEPS_MS.length - 1)];
        },
        recordFailure(slot) {
            const state = slots[slot];
            if (now() - state.startedAt >= DELAY_WINDOW_MS) { state.startedAt = now(); state.count = 0; }
            state.count += 1;
        },
        clear(slot) { slots[slot].count = 0; slots[slot].startedAt = 0; },
        size: DELAY_SLOTS,
    };
}

module.exports = { createDelayRing, DELAY_SLOTS, DELAY_STEPS_MS, DELAY_WINDOW_MS };
```

- [ ] `loginDelay.test.js` must prove:
  - **(P3, replaces the impossible 15 000-request integration test)** feeding 50 000 distinct candidate strings never creates more than `DELAY_SLOTS` slots and never returns a denial — only a delay. This is a pure unit test with no HTTP and no global ceiling, so it does not contradict Task 5. *Rev 2a required 15 000 live `/login/options` requests to leave a cashier able to log in, while Task 5 installed a 600/min ceiling over that same route; those two contracts could never both pass. The property being proven is a property of the data structure, so it belongs in a unit test.*
  - **(P2)** assert the module imports no database handle (`expect(source).not.toMatch(/require\(.*config\/db/)`), and that any two strings chosen to collide return the same slot and accumulate the same delay. Real-user knowledge belongs to the route outcome mapping, never this primitive.
  - The schedule caps at 5 s and resets after `DELAY_WINDOW_MS`.
  - `clear()` on success resets the slot. **State the accepted consequence in a comment:** a real cashier's successful login also resets an attacker sharing that slot. The alternative — never clearing — would let an attacker hold a colliding cashier at 5 s permanently, which is a targeted degradation and strictly worse.

### Step 2 — login: delay, never lockout (fixes B1)

- [ ] **Delete the `recordFailedLogin` and `recordFailedIpLogin` calls from the `DEVICE_AUTH_REQUIRED` branch** at `backend/routes/auth.js:176-177`. That 403 is a routing signal, not a credential failure; the login screen always triggers it before the device flow.
- [ ] Delete `loginAttempts`, `loginAttemptKey`, `getLoginAttemptState`, `isLoginLocked`, `recordFailedLogin`, `clearFailedLogin`, `ipLoginAttempts`, `GLOBAL_IP_MAX_FAILED`, `getIpAttemptState`, `isIpLoginLocked`, `recordFailedIpLogin`, `cleanExpiredLoginAttempts`, `maybeCleanExpiredLoginAttempts`, `lastLoginAttemptsCleanup`, and the `setInterval` at `auth.js:97`. The fixed ring needs none of them.
- [ ] **Invariant 6 — use exactly this shape; do not improvise it.** The pool defaults to **10 connections** (`backend/config/databasePoolOptions.js:13`) and every login takes `SELECT … FOR UPDATE` on a single `settings` row (`auth.js:164-166`), so sleeping while holding a connection starves checkout and printing app-wide. Compute the delay up front, run the entire DB phase to completion, release, and only then wait:

```js
router.post('/login', async (req, res) => {
    const userNumber = String(req.body?.user_number || '').trim();
    if (!userNumber) return sendError(res, 400, "User number is required.");

    const slot = loginDelay.slotFor(userNumber);
    const delayMs = loginDelay.pendingDelayMs(slot);   // pure read; no DB, no connection held

    // ---- DB phase: acquire, work, commit/rollback, release. NEVER await the delay in here.
    let outcome;                                       // { status, body, delayAction: 'record'|'clear'|'keep' }
    let conn;
    try {
        conn = await pool.getConnection();
        // `res` is passed for setSessionCookie ONLY. runLoginTransaction must never send a
        // response — see the extraction rules below; a surviving res.json() silently disables
        // the delay and makes the outer catch throw ERR_HTTP_HEADERS_SENT.
        outcome = await runLoginTransaction(conn, userNumber, req, res);
    } catch (e) {
        // MUST roll back before release, or the connection returns to the pool mid-transaction.
        if (conn) await conn.rollback().catch(() => {});
        logger.error({ err: e }, 'Login: authentication failed');
        outcome = { status: 500, body: { success: false, message: "Authentication failed. Please try again." }, delayAction: 'keep' };
    } finally {
        if (conn) conn.release();                      // released before any waiting
    }

    // ---- Post-DB phase: no connection held from here on.
    // The action follows the PUBLIC authentication outcome, never hidden user existence:
    // invalid PIN -> record; authenticated session -> clear; routing/server result -> keep.
    if (outcome.delayAction === 'record') loginDelay.recordFailure(slot);
    else if (outcome.delayAction === 'clear') loginDelay.clear(slot);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    return res.status(outcome.status).json(outcome.body);
});
```

  Rules this shape enforces, each of which must have a test:
  - `pendingDelayMs` never touches the pool.
  - Every `DEVICE_AUTH_REQUIRED` result sets `delayAction:'keep'`, whether the locked user query found a real ordinary user or no user. It is a routing signal and must neither add delay nor reset a preconditioned slot. This closes B7.
  - A public 401 invalid-PIN result sets `delayAction:'record'`; a successful 200 session sets `delayAction:'clear'`; validation errors and 500s set `delayAction:'keep'`. No hidden database result selects the action.
  - A test asserts that during the delay window the pool has no checked-out connection attributable to the login handler (`pool.connectionTelemetrySnapshot`, exposed at `backend/config/db.js:24`). Drive the slot to the 1 s tier and sample the snapshot mid-flight; this is the one test allowed to spend real wall-clock time.
  - A test asserts a forced 500 leaves the slot's delay unchanged in both directions. **`failNextConnectionQuery` is not a shared helper** — it is defined locally in `backend/tests/integration/checkout.test.js:322` and again in `backend/tests/integration/refunds.test.js:161`. Copy that local pattern into the login test file rather than importing something that does not exist.
  - A preconditioned-state test first accumulates delay with colliding invalid PINs, switches the fixture to enforced mode, then proves a known ordinary user and an unknown candidate receive the same `DEVICE_AUTH_REQUIRED` body and leave the slot unchanged. Do not use wall-clock comparison as the only assertion; assert the explicit `delayAction` contract.
- [ ] **`runLoginTransaction` is NOT a copy-paste extraction — read this before writing it.** The existing `try` block at `auth.js:161-256` *sends* its own responses (`return res.status(403).json(…)`, `return sendSuccess(res, {…})`, `sendError(res, 401, …)`) and it *writes a header* (`setSessionCookie(res, session.rawToken, req)` at `auth.js:232`). Both facts constrain the extraction, and getting either wrong fails silently:
  - **It must take `res` and keep `setSessionCookie`.** Dropping `res` loses the `Set-Cookie` header, so login returns 200 with no session — the client appears to succeed and then behaves as logged-out. Setting a header before the handler later calls `.json()` is fine; headers are not flushed until the body is sent.
  - **It must never send a response.** Every `return res.…json(…)` / `sendSuccess` / `sendError` inside becomes a returned `{ status, body, delayAction }`. If any send survives, the response goes out *before* the handler awaits the delay — the entire anti-spray mechanism silently does nothing while every functional test still passes — and the outer `catch`'s 500 would then throw `ERR_HTTP_HEADERS_SENT` on top of the original error.
  - **Preserve the ordering the current code documents:** `invalidateUserSessions(user.id)` must still run *before* `preWarmToken(...)` (`auth.js:220-223`), or the new token is evicted from the cache the moment it is created.
  - Do not change any SQL, response code, message, enforced-mode behaviour, the programmer exception, transactions, row locks, session revocation, or audit writes.
- [ ] Tests for exactly those failure modes, because none of them is visible in an ordinary assertion:
  - A successful login response still carries `Set-Cookie: pos_token=…` with `HttpOnly; SameSite=Strict; Path=/`.
  - `res.headersSent` is `false` at the moment the post-DB phase begins — assert by spying on `res.end` and recording the ordering against the delay, not by reading the clock alone.
  - With the slot driven to the 1 s tier, a login response does not arrive before the delay has elapsed. This is the assertion that catches a surviving `res.json()` inside the transaction; without it the restructure can regress to a no-op.
  - `grep` the finished `runLoginTransaction` body for `res.` and assert the only match is `setSessionCookie`.

### Step 3 — `/login/options`: delete the limiter and the global cap (fixes B3, B4, B5, B6)

This is the step that ends the loop. Rev 1 removed one leg of the options throttle and created B3. Rev 2 replaced it with a candidate bucket and created B5. Rev 2a replaced that with an eligibility-branched ring and created B6. All three attempts share one assumption — that `/login/options` needs a per-candidate limit. **It does not.** Options verifies nothing; it issues a challenge. Guessing happens at `/login/verify`, which requires an ECDSA signature over a server-issued challenge. Rev 3.1 makes an authentication challenge one-attempt and deletes it on expected failure; the shared `MAX_ATTEMPTS=3` remains for non-login ceremony flows. The per-candidate limit existed only to bound (a) ceremony-row creation and (b) enumeration — and both are better solved directly.

- [ ] **Delete `assertOptionThrottle`, `optionIpAttempts`, `optionIdentityAttempts`, `OPTION_IP_MAX_ATTEMPTS`, `OPTION_IDENTITY_MAX_ATTEMPTS`** (`webauthn.js:21-25,31-37`) and the call at `:398`. `/login/options` carries no per-identity limit at all. With no candidate-keyed control there is nothing to aim (P1) and nothing to probe (P2).
- [ ] **Delete `OPTION_MAX_OUTSTANDING` and the pending-count query** (`webauthn.js:23,399-404`). It is a global hard-denial control reachable by cheap attacker input — exactly what P1 forbids — and it is the B4 outage.
- [ ] **Replace it with a stateless decoy, so unknown candidates write nothing.** `proofMessage` reads only `flow`, `id` and `challenge` (`webauthn.js:77-85`), so a synthetic object produces a byte-identical response shape with no `INSERT`:

```js
const user = await getUserByNumber(userNumber);
// Unknown/ineligible: no DB row at all. Spray cannot grow the ceremonies table,
// so there is nothing left for a global outstanding cap to protect.
const ceremony = user
    ? await getCeremony((await createCeremony({ flow: 'authentication', userId: user.id })).id, pool)
    : { id: crypto.randomUUID(), flow: 'authentication', challenge: crypto.randomBytes(32) };
return res.json({ success: true, ceremony_id: ceremony.id, message: proofMessage(ceremony, origin) });
```

- [ ] **Bound durable row growth without another hard cap.** Only eligible candidates create rows. Pending authentication rows expire after 2 minutes, so the 600/minute global gate bounds attacker-created pending rows to roughly 1,200. On an expected authentication failure, delete that `flow='authentication'` row in the same transaction instead of retaining it as `failed` for one day. Successful consumed rows require a real registered-browser signature and keep the existing one-day audit/replay cleanup. `pruneExpiredCeremonies` remains the safety net for abandoned pending rows. Put this arithmetic beside the deleted cap so nobody re-adds B4.
- [ ] **Make `/login/verify` one-use and uniform across every invalid-proof state.** Do not call shared `assertPendingCeremony` and then blindly pass its result to `finishFailedAttempt`; that is the B8 cross-flow bug. At this route only:
  1. Lock the requested row.
  2. If it is missing, belongs to another flow, is expired, is terminal, or has exhausted attempts, roll back without mutating it and return 401 `WEBAUTHN_AUTHENTICATION_FAILED` with the exact ordinary bad-signature body.
  3. For a pending `authentication` row, record the attempt and verify user/credential/signature.
  4. If that expected proof fails, `DELETE FROM webauthn_ceremonies WHERE id=? AND flow='authentication'`, commit, and return that same 401. The authentication challenge is deliberately one-attempt; `MAX_ATTEMPTS=3` remains for the other shared ceremony flows.
  5. On success, retain the existing consume/session transaction. On an unexpected database/server error, roll back and return the existing 500; never convert infrastructure failure into an authentication result.

  This produces the same public response for a never-issued id, a replayed/expired/exhausted id, a deactivated user, and a bad signature. Submitting an enrollment, bootstrap, approval, or step-up id cannot consume, fail, delete, or increment that ceremony.

  Use one route-local error factory and one route-local deletion statement; do not change shared ceremony semantics for enrollment/bootstrap/step-up:

```js
const loginAuthenticationFailed = () =>
    publicError('WEBAUTHN_AUTHENTICATION_FAILED', 401, 'This browser is not registered for this user.');

const usableAuthenticationCeremony = ceremony => ceremony
    && ceremony.flow === 'authentication'
    && ceremony.terminal_state === 'pending'
    && new Date(ceremony.expires_at).getTime() > Date.now()
    && Number(ceremony.attempt_count) === 0;

// Inside /login/verify, after SELECT ... FOR UPDATE:
if (!usableAuthenticationCeremony(ceremony)) {
    await conn.rollback();
    return sendError(res, loginAuthenticationFailed());
}

// On any expected user/credential/signature failure after the attempt is recorded:
await conn.query("DELETE FROM webauthn_ceremonies WHERE id=? AND flow='authentication'", [ceremony.id]);
await conn.commit();
committed = true;
return sendError(res, loginAuthenticationFailed());
```

  Do not change or import the shared `MAX_ATTEMPTS`; non-login flows keep their three-attempt contract. Replace the existing throws for decoy/inactive-user/no-credential/failed-mark cases with the route-local delete-and-401 branch so expected failures cannot escape through the generic catch. The existing catch must rollback unexpected errors. Remove the `/login/verify` call to `finishFailedAttempt`; other routes keep using it unchanged.
- [ ] **Known residual, state it honestly:** the stateless options path and missing-id verify path do less database work than a real candidate. This plan guarantees no deterministic status/body/abuse-control-state oracle, not cryptographic constant-time behavior. Do not add fake fixed padding: database variance defeats that claim while slowing every cashier. Closing timing analysis would require a separately designed constant-work protocol.
- [ ] Delete or rewrite any test asserting `WEBAUTHN_OPTIONS_THROTTLED` or `WEBAUTHN_OUTSTANDING_LIMIT`; both codes disappear from `webauthn.js`. Keep the entries in the `sendError` message map only if some other route still throws them (verified: neither is thrown elsewhere — remove both).

### Step 4 — preserve all three override surfaces, keyed and serialized by the actor

- [ ] Do not leave the deleted login-attempt helpers referenced by `POST /api/auth/manager_override`. Preserve the existing role sets, response bodies, PIN rehashes, and audit behavior on each surface; this is an abuse-control change, not an authorization refactor.
- [ ] Reuse `ManagerOverrideService`'s existing attempt store for all three namespaces:
  - standalone route: `manager_override:user:${req.user.id}`;
  - inline permission override: `permission_override:user:${user.id}`;
  - drawer pop: `drawer_pop:user:${req.user.id}`.
  `ipAddress` remains audit metadata only. Separate namespaces prevent one surface from consuming another surface's budget.
- [ ] Extend that existing store, not the fixed candidate ring, with a per-key `inFlight` flag and the same bounded delay schedule. Only enter this control when a manager PIN was actually supplied. `beginOverrideAttempt(key)` must atomically reject a second concurrent verification for that exact authenticated actor/surface before any PIN query and then await the delay with no DB connection held. **Reject with the contract that already exists** — throw the same shape as the existing lockout, `statusCode = 429` (`backend/services/ManagerOverrideService.js:85`), so callers, clients and tests need no new branch. Do not invent a new status or code for it. `finishOverrideAttempt(key, 'failed'|'success'|'server-error')` must always clear `inFlight`; failure advances the existing 5-failure/5-minute state, success clears it, and server error preserves it. Every caller uses `try/finally`, so aborts and exceptions cannot leave the actor permanently busy.
- [ ] Keep the existing 5-per-5-minutes hard lockout. It is authenticated and actor-keyed, so it can only deny the attacking session's own surface. The in-flight reservation closes the parallel-guess bypass; the bounded delay makes a sustained four-digit privileged-PIN sweep materially slower without introducing cross-user hash collisions.

### Step 5 — tests

- [ ] In `loginRateLimitIdentity.test.js` (renamed from `loginProxyTrust.test.js`, whose current assertions are proxy-trust-dependent and must be rewritten, not adapted):
  - **(B1)** In enforced mode, twenty consecutive `DEVICE_AUTH_REQUIRED` responses for one staff number do not prevent that number from logging in via the device flow.
  - A valid staff number and a nonexistent one return **byte-identical** status, code, and message in enforced mode and both select `delayAction:'keep'`. *Pins the currently-accidental response behaviour at `auth.js:174` and the deliberate B7 state contract.*
  - Rotating `X-Forwarded-For` never changes the delay or the outcome.
  - Below Task 5's global gate, no candidate delay or candidate state ever produces a 429 from `/api/auth/login`.
  - Two concurrent attempts on each authenticated override namespace allow one verifier and reject the second before PIN comparison; the next request proceeds after the first releases its reservation. Verify the three role sets and audit event names remain unchanged.
- [ ] In `browserDeviceProof.test.js`:
  - **(B5)** 100 unauthenticated `/login/options` requests for a known cashier's number leave that cashier able to obtain options and complete the device flow.
  - **(B4)** A clearly sub-ceiling batch of 50 distinct unknown candidates creates **zero** `webauthn_ceremonies` rows, then a real cashier obtains options successfully. Rate-boundary behavior belongs to Task 5's isolated gate test; never require request 601 to succeed.
  - **(B8)** A never-issued id and a real ceremony with a bad signature return the same 401 body. Repeat both ids and prove the second responses remain identical. Repeat the matrix with expired, terminal, and exhausted authentication rows.
  - Submit valid pending enrollment and step-up ceremony ids to `/login/verify`; both return the generic authentication failure, while their original rows remain pending with unchanged attempt counts.
  - After every expected failed real authentication proof, assert its row was deleted immediately. After successful proof, assert the consumed row and one-use replay protection remain.

### Step 6 — GREEN + commit

```bash
git commit -m "fix: remove client IP, aimable lockouts and global caps from authentication"
```

---

## Task 5: One explicit global admission gate (fixes B2 and B9)

**Files:** `server.js`, `backend/middleware/rateLimit.js`, `backend/services/deviceAccess.js`, `backend/routes/auth/webauthn.js`, `backend/routes/admin/deviceAccess.js`, `src/components/Login.vue`, `src/shared/i18n/ar.json`, `backend/tests/unit/rateLimit.test.js`, `backend/tests/unit/networkBoundaryPolicy.test.js`, `backend/tests/integration/browserDeviceProof.test.js`, `src/components/__tests__/loginWebAuthn.spec.js`, `src/shared/__tests__/i18nCatalog.spec.js`, and create `tests/e2e/specs/admin.login-boundary.spec.js`.

- [ ] **Step 1 — failing tests:** concurrent unauthenticated policy/options requests must not occupy more than 6 dynamic leases or exhaust the DB pool; request 601 in a fixed window returns the documented uniform response; the gate runs **after** both tight parsers; route aliases accepted by Express cannot bypass either boundary; six unsent bodies take no lease; `public_menu.json` consumes rate budget but no concurrency lease; `res.end` and `close` release exactly once while the watchdog only warns; authenticated/non-covered routes bypass the gate; Vitest source contracts cover placement/copy, and a focused Playwright spec proves the actual `SERVER_BUSY` and HTTPS-refusal UI flows.

- [ ] **Step 2 — cache the auth mode, transaction-safely (F5).** `readAuthMode()` hits MySQL on every call (`deviceAccess.js:11-14`) with ten call sites in `webauthn.js` alone, while `Login.vue` calls `/login-policy` on mount *and* on every login click. With the blanket `/api` limiter gone this is the next flood target against a 10-connection pool.

  Exact semantics — a naive cache here is a correctness bug, not just a perf tweak:
  - **Cache only default-pool reads.** `readAuthMode(executor)` with a non-pool connection/transaction executor must bypass the cache entirely and query through that executor, or transaction-scoped code could observe a value from outside its own lock. Passing the module pool itself remains cacheable. `requireUnboundStagedSession` relies on the transaction path (`webauthn.js:99-106`): its `forUpdate` path already does its own locked `SELECT … FOR UPDATE` and must keep doing so.
  - **Use one in-flight promise for a cold/expired default-pool read.** Without single-flight, 100 simultaneous cache misses still issue 100 queries before the first query populates the cache. Use a generation counter: invalidation increments the generation, clears the cached value, and detaches the old promise; an older promise may resolve for its original caller but may not repopulate the new generation.
  - **TTL exactly 5 seconds**, and invalidate explicitly after commit in **both** runtime writers:
    - `disabled → staged`, written inside `completeRegistration` (`deviceAccess.js:234-236`) — invalidate in `/bootstrap/verify` after `conn.commit()` (`webauthn.js:503`). *Without this, a successful bootstrap leaves a cached `disabled`, and the operator's setup flow breaks for the length of the TTL.*
    - `staged → enforced`, written by the admin route — invalidate after `conn.commit()` (`backend/routes/admin/deviceAccess.js:243`), next to the existing `invalidateUnboundSessions()`.
  - `POST /api/auth/login` reads the mode via its own locked `SELECT … FOR UPDATE` (`auth.js:164-166`), not via `readAuthMode`, so it is already correct — do not "optimise" it onto the cache.
  - Tests: cached default-pool read; 100 concurrent cold reads issue exactly one query; non-pool executor bypass; read-after-write across both transitions; invalidation racing an older in-flight read cannot repopulate stale mode.

  Use this state shape; the generation check is what prevents a pre-invalidation query from writing stale mode back afterward:

```js
const AUTH_MODE_CACHE_TTL_MS = 5000;
let authModeGeneration = 0;
let cachedAuthMode = null;
let cachedAuthModeUntil = 0;
let authModeReadInFlight = null;

async function queryAuthMode(executor) {
    const [[row]] = await executor.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode' LIMIT 1");
    return MODE_VALUES.has(row?.setting_value) ? row.setting_value : 'disabled';
}

async function readAuthMode(executor = pool) {
    if (executor !== pool) return queryAuthMode(executor); // transaction/explicit connection: never cached
    if (cachedAuthMode && Date.now() < cachedAuthModeUntil) return cachedAuthMode;
    if (authModeReadInFlight) return authModeReadInFlight;

    const generation = authModeGeneration;
    const pending = queryAuthMode(pool)
        .then((mode) => {
            if (generation === authModeGeneration) {
                cachedAuthMode = mode;
                cachedAuthModeUntil = Date.now() + AUTH_MODE_CACHE_TTL_MS;
            }
            return mode;
        })
        .finally(() => {
            if (authModeReadInFlight === pending) authModeReadInFlight = null;
        });
    authModeReadInFlight = pending;
    return pending;
}

function invalidateAuthModeCache() {
    authModeGeneration += 1;
    cachedAuthMode = null;
    cachedAuthModeUntil = 0;
    authModeReadInFlight = null;
}
```

- [ ] **Step 3 — the gate: one rate bound, one truthful dynamic-work semaphore.** Add `const logger = require('../config/logger');` and `createGlobalPreAuthGate` beside `createKeyedRateLimiter` in `backend/middleware/rateLimit.js`; do not add another service or dependency. It owns one fixed-window throttle with the sole key `global:preauth`, `maxEntries:1`, **600 admitted requests/minute**, plus one integer capped at **6 simultaneous dynamic requests**. `public_menu.json` consumes rate budget but takes no dynamic lease. The rate check always runs first, so concurrency rejection still advances the one global ceiling. After Task 5 retires the old factory, export exactly the live middleware API: `module.exports = { createKeyedRateLimiter, createGlobalPreAuthGate, actorKey };`.

  The concurrency counter is a semaphore, not a TTL cache. A watchdog may report stuck work, but it must never decrement `inFlight`: releasing without cancelling the handler lets old queries remain while six new requests enter every warning interval, eventually filling the pool. Only `res.end`, `close`, or a synchronous downstream throw releases a dynamic lease.

```js
const GATE_LEASE_WARN_MS = 15_000;

function createGlobalPreAuthGate({
    windowMs = 60_000,
    max = 600,
    maxConcurrent = 6,
    leaseWarnMs = GATE_LEASE_WARN_MS,
    now = Date.now,
    trackConcurrency = () => true,
} = {}) {
    const requests = createFixedWindowThrottle({ windowMs, limit: max, maxEntries: 1, now });
    let inFlight = 0;
    const rejectBusy = (res) => {
        res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ success: false, code: 'SERVER_BUSY', message: 'The server is busy. Try again in a moment.' });
    };

    return (req, res, next) => {
        if (!requests.consume('global:preauth')) return rejectBusy(res);
        if (!trackConcurrency(req)) return next();
        if (inFlight >= maxConcurrent) return rejectBusy(res);

        inFlight += 1;
        let released = false;
        let watchdog = null;
        const release = () => {
            if (released) return;
            released = true;
            inFlight -= 1;
            if (watchdog) clearTimeout(watchdog);
        };
        watchdog = setTimeout(() => {
            logger.warn('Pre-auth gate: dynamic request still running after warning threshold.');
            // Observation only. Never release work that has not ended or been cancelled.
        }, leaseWarnMs).unref();

        const originalEnd = res.end;
        res.end = function patchedEnd(...args) {
            release();
            return originalEnd.apply(this, args);
        };
        res.once('close', release);
        try { return next(); }
        catch (error) { release(); throw error; }
    };
}
```

  Construct one gate instance in `server.js`. Use one normalized predicate for the tight parsers and the gate. The normalization deliberately mirrors this app's Express defaults: routing is case-insensitive, trailing slashes are accepted, and a matching `GET` handler also services `HEAD`. Gating a double-trailing-slash 404 is harmless; missing an alias that reaches a real handler is not.

```js
const PRE_AUTH_ROUTES = new Set([
    'POST /api/auth/login',
    'GET /api/auth/login-policy',
    'POST /api/auth/webauthn/login/options',
    'POST /api/auth/webauthn/login/verify',
    'GET /api/auth/webauthn/status',
    'POST /api/auth/webauthn/enroll/options',
    'POST /api/auth/webauthn/enroll/verify',
    'GET /api/system/public_preferences',
    'GET /public_menu.json',
]);
const normalizePreAuthPath = (value) => {
    const pathValue = String(value || '/').toLowerCase();
    return pathValue.length > 1 ? pathValue.replace(/\/+$/, '') : pathValue;
};
const preAuthRouteKey = (req) => {
    const method = req.method === 'HEAD' ? 'GET' : String(req.method || '').toUpperCase();
    return `${method} ${normalizePreAuthPath(req.path)}`;
};
const isPreAuthRoute = (req) => PRE_AUTH_ROUTES.has(preAuthRouteKey(req));
const preAuthGate = createGlobalPreAuthGate({
    trackConcurrency: (req) => normalizePreAuthPath(req.path) !== '/public_menu.json',
});
```

  Put **both** tight parsers above the existing global parsers. `app.use(matcher, parser)` is a chain, not a guard, so invoke each parser conditionally. This preserves the currently accepted JSON and URL-encoded formats without adding another content-type policy.

```js
const tightPreAuthJson = express.json({ limit: '16kb' });
const tightPreAuthForm = express.urlencoded({ extended: true, limit: '16kb' });
app.use((req, res, next) => (isPreAuthRoute(req) ? tightPreAuthJson(req, res, next) : next()));
app.use((req, res, next) => (isPreAuthRoute(req) ? tightPreAuthForm(req, res, next) : next()));

// Existing global 1 MB parsers remain here. A body already consumed above is a no-op.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || '1mb' }));

// After both global parsers, before route mounts.
app.use((req, res, next) => (isPreAuthRoute(req) ? preAuthGate(req, res, next) : next()));
```

  Tests must prove: canonical JSON and URL-encoded bodies below 16 KB parse; oversize bodies of both types return 413; uppercase and trailing-slash route aliases receive the same parser/gate treatment; `HEAD` for every covered GET is counted; percent-encoded and doubled internal-slash paths that Express rejects remain 404; and an uncovered 50 KB route retains the global 1 MB limit. This keeps both properties: no covered accepted body costs more than 16 KB to parse, and no lease is held while a request body is incomplete.

  Match these unauthenticated routes, replacing `publicRateLimit` (`server.js:654,670`):

  - `POST /api/auth/login`
  - `GET  /api/auth/login-policy`
  - `POST /api/auth/webauthn/login/options`
  - `POST /api/auth/webauthn/login/verify`
  - `GET  /api/auth/webauthn/status`
  - `POST /api/auth/webauthn/enroll/options`
  - `POST /api/auth/webauthn/enroll/verify`
  - `GET  /api/system/public_preferences`
  - `GET  /public_menu.json` — rate budget only; never a concurrency lease

  **Now retire the last IP-keyed limiter.** With `publicRateLimit` replaced, delete `PUBLIC_RATE_LIMIT_MAX`, `publicRateLimit`, its two mounts (`server.js:654,670`), the `createIpRateLimiter` import (`server.js:46`), the factory itself in `backend/middleware/rateLimit.js`, and its tests. This is the only task where that deletion leaves a booting server — see the retirement table in Task 2.

  Nothing else. Do not mount it above `/api` — authenticated traffic must never share this bucket. `OPTIONS` preflights bypass it. The authenticated `device-request/*`, `bootstrap/*`, and `step-up/*` routes also bypass it because they already require a durable session.

  **Saturation response — rate saturation is identical on every route above; dynamic concurrency saturation uses the same response:**

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
{ "success": false, "code": "SERVER_BUSY", "message": "The server is busy. Try again in a moment." }
```

  **Why a plain 429 is correct here, and why rev 2a's "same generic failure as a bad login" was not:** there is no single ordinary failure contract to imitate — `/login-policy` returns a 200 policy document, `/login` returns 401 or 403 `DEVICE_AUTH_REQUIRED`, `/login/options` returns a 200 challenge, `/public_menu.json` returns a file. A fabricated 401/403 would also misroute the client: `Login.vue:175` branches into the device flow on `DEVICE_AUTH_REQUIRED`, and `authInterceptor.js:39-52` redirects to `/login?reason=expired` on a 401 carrying `SESSION_REQUIRED`/`SESSION_INVALID`. A 429 leaks nothing, because both gate dimensions are global constants — their state does not vary with the submitted candidate. *Verified: `authInterceptor.js` only reacts to 401 with those two codes, so a 429 passes through to the caller untouched.*

  **State the trade-off in a comment where the gate is constructed:** the rate gate is shared-fate at 600 admitted requests per minute; the six-request semaphore is shared by the covered dynamic routes only. `public_menu.json` is rate-only because streaming backpressure is client-controlled while its cache-miss database generation is already single-flight. The semaphore releases only when work actually ends or closes. **Neither dimension may exempt known users**: any identity-based exemption is observable and becomes a saturate-then-probe oracle.

  Tests use a fresh factory instance with small injected bounds rather than spending 600 real HTTP requests. Prove requests 1–600 are admitted by calling each mocked response's patched `end()` before the next request, then prove request 601 is rejected. Separately prove six unresolved dynamic responses are admitted, the seventh gets the identical 429, and ending or closing one admits the next. Do not emit `finish`: the gate deliberately does not listen to it. In integration, keep hostile traffic clearly below 600 and verify `pool.connectionTelemetrySnapshot()` never attributes more than six checked-out requests to the covered pre-auth burst.

  **B10 regression tests — all three are required; the first is the one rev 3.1 would have failed:**

  - **Mount point (unsent body).** Supertest's `Test` finalizes the request on `.then()`/`.end()` and offers no supported partial-body mode, so use a raw `http.request` against the app on an ephemeral port and never call `.end()`. Verified on this repo's Node/express: a request written but not ended stays in flight with no response, which is exactly the hostile state being reproduced.

```js
const server = app.listen(0);
const { port } = server.address();
const stuck = [];
for (let i = 0; i < MAX_CONCURRENT; i += 1) {
    const req = http.request({ port, method: 'POST', path: '/api/auth/login',
        headers: { 'content-type': 'application/json', 'content-length': '64' } });
    req.write('{"user_number":"');   // deliberately incomplete — never .end()
    stuck.push(req);
}
// A normal covered request must still be ADMITTED, not SERVER_BUSY.
await request(server).get('/api/auth/login-policy').expect(200);
stuck.forEach(req => req.destroy());
await new Promise(resolve => server.close(resolve));
```

    Also assert structurally that the gate wrapper is registered *after* the body parsers in `server.js`, so the property survives a later refactor that the behavioural test might not catch.
  - **Slow reader.** Serve a large `public_menu.json`-shaped stream, pause the client after one chunk, and prove it consumed rate budget but no dynamic lease: six paused readers must not make a normal dynamic request return `SERVER_BUSY`. Do not claim that `res.end` is independent of stream backpressure.
  - **Watchdog.** With a small injected `leaseWarnMs`, admit `maxConcurrent` dynamic requests whose handlers never respond, advance past the warning threshold, and assert a warning was logged **and the next request remains rejected**. End one original response and assert the next request is then admitted. This proves the watchdog never under-counts live work.

- [ ] **Step 4 — client handling.** In `src/components/Login.vue`, add `SERVER_BUSY` to the error-code maps at `:198-201` and `:206-214` so the user sees "The server is busy. Try again in a moment." A 429 body reaches the `else` branch at `:197` with `data.code` intact, so no control-flow change is needed — only the message entry and its catalog entry in `src/shared/i18n/ar.json`. It must **not** be treated as session expiry, an unregistered browser, or an HTTPS misconfiguration.

- [ ] **Step 5 — guard the one gap the retained redirect deliberately leaves.**

  Task 1 **keeps** the HTTP→HTTPS redirect, but by design it fires only on an explicit `x-forwarded-proto: http` and passes through when no forwarded header is present — because that ambiguous case is what loops. That leaves exactly one uncovered configuration: `ENFORCE_HTTPS=true`, served over plain `http://`, with no forwarded header. There the browser **rejects the `Secure` cookie**, `pos_token` is never stored, and the user login-loops with no explanation.

  Cover it at the client, where the protocol is known for certain and no header trust is needed:
  - Include the policy flag in the existing `/login-policy` response (`auth.js:22-33`, e.g. `enforce_https: ENFORCE_HTTPS`).
  - In `Login.vue`, before attempting login, if `policy.enforce_https === true && window.location.protocol !== 'https:'`, show `This POS must be opened over HTTPS before you can sign in.` instead of submitting. Do not redirect from the client; refuse and explain.

  This and the `SERVER_BUSY` message are the only frontend changes in this plan. It converts a silent, confusing outage into an actionable message, and it cannot be spoofed because `window.location.protocol` is observed locally rather than taken from a header.

- [ ] **Frontend proof — use both existing runners (B11/B16).** Vitest has no DOM, so keep its fast source-contract assertions. Runtime behaviour belongs in the already-installed Playwright harness; do not add a dependency.
  - In `loginWebAuthn.spec.js`, slice the `login` function the way that file already does and assert the source contains the `SERVER_BUSY` key in both error maps, contains the `policy.enforce_https === true && window.location.protocol !== 'https:'` guard, and that the guard appears **before** the `api/auth/login` fetch in the slice.
  - Assert the guard does **not** call `window.location.href` (refuse-and-explain, never client redirect).
  - Extend `src/shared/__tests__/i18nCatalog.spec.js` to require the new Arabic catalog key in `src/shared/i18n/ar.json`.
  - Create `tests/e2e/specs/admin.login-boundary.spec.js`; its `admin.*` filename is already collected by the existing `admin-tests` Playwright project. In each test create a clean browser context, intercept `/api/auth/login-policy`, and navigate to `/login` over the configured local HTTP origin.
  - Test 1 intercepts `/api/auth/login` with `429` and the exact `SERVER_BUSY` body, submits a number, and asserts `.text-error` contains `The server is busy. Try again in a moment.` while the page remains on `/login`.
  - Test 2 returns `{ success:true, mode:'disabled', supported:true, enforce_https:true }` from `/login-policy`, counts any `/api/auth/login` request, submits a number, asserts `.text-error` contains `This POS must be opened over HTTPS before you can sign in.`, and asserts the login request count remains zero.
  - Run `npx playwright test tests/e2e/specs/admin.login-boundary.spec.js --project=admin-tests`. Expected: 3 passed (the existing setup dependency plus 2 focused browser tests). This is focused browser proof, not the full E2E suite.

- [ ] **Step 6 — GREEN + commit**

```bash
git commit -m "fix: bound unauthenticated request volume without client IP"
```

---

## Task 6: Architecture map and adversarial gate

- [ ] Update `docs/architecture.json`: proxy trust permanently disabled; the app retains its own HTTP→HTTPS redirect, fired only on an explicit `x-forwarded-proto: http` and never on a missing header, with Hostinger Force HTTPS as a second layer in front; `ENFORCE_HTTPS` drives Secure cookies; `req.ip` is observed-peer metadata only; throttles keyed by credential → user for authenticated work; manager override namespaces are actor/surface keyed with one verifier in flight; covered pre-auth routes share a 600/minute gate mounted after normalized 16 KB JSON/form parsing; dynamic routes additionally share a truthful six-request semaphore released only when work ends, while streamed `public_menu.json` is rate-only; candidate delay applies only to PIN login; `DEVICE_AUTH_REQUIRED` preserves delay state; `/login/options` carries no per-identity limit and unknown candidates create no ceremony row; failed login-authentication ceremonies are deleted immediately while other flows remain untouched. Then run `npm run architecture && npm run architecture:check`. Never hand-edit the HTML.

- [ ] **Scans must return nothing:**

```bash
rg -n "TRUST_PROXY|createIpRateLimiter|ipLoginAttempts|optionIpAttempts|OPTION_MAX_OUTSTANDING|loginAttemptKey" server.js backend deployment/templates scripts
```

- [ ] **Adversarial gate.** The diff fails if any statement below is false. Each is stated as a property of the design, not a threshold, so it stays checkable after future edits:
  1. **P1:** the global admission gate is the only submitted-candidate/request-volume control that can deny on the covered pre-auth routes. Its rate and concurrency dimensions emit the same 429. No 429/403 is a function of a candidate-keyed counter; ordinary invalid authentication responses and capability-local exhaustion on unguessable ceremony ids are not candidate throttles.
  2. **P2:** every pre-auth abuse-control key is a pure function of request data, and every equal public outcome causes the same delay/limit-state action. In enforced mode, real and unknown `DEVICE_AUTH_REQUIRED` both use `keep`; neither hidden existence nor eligibility selects `record`/`clear`.
  3. **P3:** attacker-keyed in-memory state cardinality is a compile-time constant; 50 000 distinct candidates create no more than `DELAY_SLOTS` slots and no denial. Unknown browser candidates create zero rows, failed authentication rows are deleted immediately, and pending real rows expire after 2 minutes.
  4. No forwarded header changes any throttle key, delay key, or authorization decision.
  5. Below explicit global-gate saturation, no candidate-targeted unauthenticated sequence — including preconditioned slots and colliding hashes — prevents a specific cashier from logging in or degrades them beyond the 5 s delay cap.
  6. In enforced mode, known and unknown candidates are indistinguishable in status, code, message, shape, and delay-state action on `/login`. `/login/options` remains shape-uniform. Every invalid-proof state on `/login/verify` — missing, bad signature, repeated, expired, terminal, exhausted, inactive user — returns the same 401 body after hostile preconditioning. Valid signature success is intentionally different; timing is not claimed constant.
  7. Unknown candidates create zero `webauthn_ceremonies` rows.
  8. Two authenticated devices have independent budgets; the same user cannot reset a budget by opening a tab.
  9. No delay is awaited while a pooled DB connection is held.
  10. Hostinger mode always emits `Secure` cookies; local mode emits non-Secure and performs no redirect. The retained redirect fires only on an explicit `x-forwarded-proto: http`, proven by a test that a header-less request passes through rather than 301s. No code path reads `req.protocol`.
  11. Rate saturation at request 601 returns 429 `SERVER_BUSY` on every covered route; dynamic concurrency saturation at request 7 returns that identical body. `res.end` and `close` release a dynamic lease exactly once; the watchdog logs and never releases. Both tight parsers and the gate use the same normalized route predicate, covering case/trailing aliases and GET→HEAD fallback. Six unsent bodies take no lease, and stalled `public_menu.json` readers take no concurrency lease.
  12. Audit actor/event/entity/time and the existing diagnostic `client_ip` response are unchanged; network address is explicitly non-authoritative and never feeds a decision.
  13. No new env var, migration, or dependency. The only UI changes are the `SERVER_BUSY` message and the HTTPS-mismatch refusal.
  14. A cashier's POS draft (cart, order context, active table) still survives refresh and re-login. Only `call_center` sessions clear it on 401.
  15. Auth-mode cache: default-pool reads cached and single-flight, explicit-executor reads bypass, both writers invalidate after commit, and a stale in-flight read cannot repopulate after invalidation.
  16. Standalone manager override, inline permission override, and drawer pop have separate actor-keyed namespaces, an atomic one-in-flight verifier per actor/surface, unchanged authorization/audit contracts, and no client-IP key.
  17. **Every task's commit boots and passes on its own.** After each task, `node --check server.js` succeeds and the app starts — no task may leave a `require` pointing at a removed export for a later task to repair (B12). `createIpRateLimiter` survives until Task 5 by design.
  18. **No test asserts behaviour the selected runner cannot execute.** Vitest keeps source-contract checks because it has no DOM; the installed Playwright harness proves the two runtime login states in a collected `admin.*` spec.
  19. **The tight JSON parser, tight URL-encoded parser and gate share one normalized `isPreAuthRoute` predicate and invoke middleware conditionally.** Case, trailing slash and GET→HEAD aliases accepted by Express are covered; `app.use(matcher, handler)` is forbidden because it is a chain rather than a guard.

- [ ] **Final focused verification** (every pre-existing file was verified; files explicitly marked Create/Rename are produced by their owning task):

```bash
npx vitest run backend/tests/unit/networkBoundaryPolicy.test.js backend/tests/unit/loginDelay.test.js backend/tests/unit/sessionCookies.test.js backend/tests/unit/installerWebAuthnConfig.test.js backend/tests/unit/rateLimit.test.js backend/tests/unit/requestThrottle.test.js backend/tests/unit/checkoutModuleWiring.test.js backend/tests/unit/webauthnCeremonies.test.js backend/tests/integration/loginRateLimitIdentity.test.js backend/tests/integration/browserDeviceProof.test.js backend/tests/integration/webauthnDeviceAccess.test.js backend/tests/integration/printTemplates.test.js backend/tests/integration/spoolerPoll.test.js backend/tests/integration/security.test.js backend/tests/integration/permissions.test.js backend/tests/integration/auth.test.js src/components/__tests__/loginWebAuthn.spec.js src/shared/__tests__/i18nCatalog.spec.js
```

Then run the build and the two focused browser checks using the existing harness:

```bash
npm run build
npx playwright test tests/e2e/specs/admin.login-boundary.spec.js --project=admin-tests
```

```bash
git commit -m "docs: document proxy-free POS security boundaries"
```

---

## Known limitations — state these, do not paper over them

1. **PIN sweeping is only fully mitigated in `enforced` mode.** A per-candidate delay punishes *repeats*; a single pass trying each number once never leaves the zero-delay tier, so only the global gate's rate dimension bounds it. In `disabled`/`staged` mode `user_number` alone grants a session, so the real control is enabling enforced mode, where a signature from a registered browser is also required. **Treat enforced mode as the security control and this plan as defence in depth.**
2. **The global admission gate is shared-fate by necessity.** Saturating 600 admitted requests/minute returns `SERVER_BUSY` for every covered route; six simultaneous dynamic requests block other dynamic covered routes until one actually ends or closes. A watchdog reports stuck work but cannot safely forget it without cancellation. `public_menu.json` is rate-only. Any identity exemption is observable and becomes an oracle; there is no client-specific exception without a trustworthy client identity.
3. **Slot collisions are visible as latency, not denial.** An attacker who computes colliders for a cashier's slot can add up to 5 s to that cashier's login. That is the accepted price of a fixed-size structure (P3); the alternative — per-candidate state — is B3.
4. **The decoy path is marginally faster than the real path.** The guarantee is no deterministic status/body/abuse-control-state oracle, not cryptographic constant-time behavior. Fake fixed padding would add cashier latency without proving constant work; a true constant-work protocol is a separate security design.
5. **Counters are in-process and reset on restart or deploy.** Persisting them is a separate hardening project.
6. **True end-client IP audit attribution is unavailable on Hostinger managed hosting.** `ip_address` records the immediate observed peer, which may be the proxy. The plan does not fake it.
7. **This is application authentication hardening, not volumetric DDoS protection.** The gate protects the named authentication/public routes and the database work they trigger. A *volumetric* socket flood — enough concurrent connections to exhaust Node's own accept capacity — requires an authoritative upstream edge control, which is not assumed here. **This limitation does not extend to cheap application-level amplification:** route aliases, accepted body formats, incomplete bodies, streamed responses and watchdog accounting each have explicit regression proof.
8. **Authenticated routes outside checkout, print templates and spooler poll have no volume bound after this plan.** Task 3 removes the blanket `/api` limiter (1000/min), which was IP-keyed and therefore effectively a single global bucket behind the proxy. The routes that keep an explicit budget are listed in Task 3 Step 4; every other authenticated route now relies on session authentication, role checks and audit alone. That is deliberate — a keyless global bucket over authenticated traffic is the shared-fate problem this plan removes from the pre-auth surface, and an authenticated abuser is identified, revocable and logged. It is recorded here so the change in posture is visible rather than discovered later.

## Future deployment gate — not authorised here

Before any hosted deployment: confirm Hostinger SSL and Force HTTPS are enabled for the exact domain; confirm `http://` redirects at the edge while `https://…/health` reaches Node with no loop; confirm a real login sets `pos_token` with `HttpOnly; Secure; SameSite=Strict`; finish registered-device rollout in `enforced`; confirm no `TRUST_PROXY` is reintroduced.
