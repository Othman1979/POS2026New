# Proxy-Free Identity Rate Limiting — Rev 3.3 Verification Report

**Date:** 2026-08-15
**Branch / HEAD:** `codex/webauthn-device-access` / `406d337a`
**Plan produced:** `docs/superpowers/plans/2026-08-14-proxy-free-identity-rate-limiting.md` (rev 3.3, 835 lines)
**Plan SHA-256:** `2cd8fe805d208dff18c683b84624fe2d7440b587dd81f29728827367e99df8f2`
**Predecessor reviewed:** rev 3.1, SHA-256 `3bc9cd3ae04dd3d8a01dbd0ee90248543b757ecc69b39eac1ca6c35e60c035f6`
**Plan state:** READY FOR IMPLEMENTATION — **requesting adversarial review before execution**

## Purpose of this report

Rev 3.1 was closed for implementation. This round reopened it, found one critical denial channel introduced by rev 3.1's own fix (B10), and then found five more defects — four of them in my own rev 3.2 corrections — by **measuring** framework behaviour instead of reasoning about it.

This report exists so Sol can attack rev 3.3 with the same evidence I had. Section 6 lists what I deliberately did **not** verify; that is the recommended starting point.

## Scope and evidence boundary

Read-only review plus throwaway measurement. Specifically:

- No application source, template, migration, database, environment, installer, or deployment was modified. `git status` shows only documentation files.
- **No test suite was run.** The shared `posapp_test` database was not touched.
- The plan was **not executed**. No task in it has been implemented.
- Measurement was done with a standalone probe script in the session scratchpad (reproduced verbatim in section 5). It `require`s this repo's installed `express` and `supertest` and binds an ephemeral localhost port. It reads no repo source, opens no database connection, and was deleted from nothing — it lives outside the repo and is not committed.

Everything asserted below is either a file/line I opened, or a number the probe printed.

## 1. Findings against rev 3.1

### B10 — Critical: socket-lifetime concurrency lease gave a 6-socket venue outage

**Problem.** Rev 3.1 mounted the global admission gate **before** body parsing and released its concurrency lease only on `res.finish`/`res.close`. The lease therefore spanned the whole socket lifetime, including the wait for a request body that `express.json` (`server.js:248`) had not yet read.

**Evidence.**
- `server.js` sets neither `server.requestTimeout` nor `server.headersTimeout` (grep over `server.js`: no match).
- Measured Node defaults on this machine: `requestTimeout = 300000`, `headersTimeout = 60000` (Node v24.16.0).
- Complete headers satisfy `headersTimeout`; an incomplete body then holds the socket for the full `requestTimeout`.
- `backend/config/databasePoolOptions.js` sets `waitForConnections: true`, `connectionLimit: 10`, `queueLimit: 50`, and **no acquire timeout** — so a handler parked on `pool.getConnection()` also holds a lease indefinitely, with no attacker involved.

**Attack.** Six sockets, `POST /api/auth/login`, valid `Content-Length`, one byte of body. `inFlight` reaches `maxConcurrent` and every covered pre-auth route returns `SERVER_BUSY` for five minutes — including `/login/options`, the only path past `DEVICE_AUTH_REQUIRED` (`src/components/Login.vue:182`). Six sockets and six bytes, repeatable, from one machine. Roughly 100× cheaper than the 600-requests/minute dimension it was added beside.

**Why the existing limitation did not cover it.** Rev 3.1's known-limitation 7 excluded "generic socket floods". Six sockets is not a flood, and the amplification came from the design choice rather than from network volume. Limitation 7 has been narrowed so it can no longer be read as covering cheap application-level amplification.

**Correction in rev 3.3.** The *lease* is fixed, not the number, on all three of its holds:
1. gate mounts **after** body parsing → an unsent request body cannot hold a lease;
2. lease releases on a patched **`res.end`** rather than `res.finish` → a slow *reader* (e.g. trickling `/public_menu.json`) cannot hold one either. This second hold was found while writing the justification for the first and was **not** in my original B10 report;
3. a watchdog (`leaseMaxMs`, 15 s) bounds the only remaining case, a handler that never responds.

Accepted residual, now stated in the plan: after a watchdog fire, `inFlight` under-counts until the request truly ends, so the gate may briefly over-admit. Bounded by the pool's own `connectionLimit`/`queueLimit` underneath, and strictly better than a lease held forever.

### B11 — Blocking: test contracts this repo cannot execute

**Problem.** Rev 3.1 (inherited from rev 2a) required frontend assertions that the login screen "refuses to submit" under `enforce_https` and "renders the busy message" for `SERVER_BUSY`.

**Evidence.**
- `@vue/test-utils`, `jsdom`, and `happy-dom` are **all absent** from `package.json` (dependencies and devDependencies).
- `vitest.config.mjs:12` pins `environment: 'node'`.
- `src/components/__tests__/loginWebAuthn.spec.js:1-25` reads `Login.vue` as **text** and asserts `toContain` / ordering. It is a source-contract test, not a component test.
- The plan's own global constraints forbid adding a dependency.

No component can be mounted and no DOM exists, so those assertions were unwritable under the plan's own rules.

**Correction.** Frontend proof is now explicitly source-contract only, matching that file's existing style: assert the `SERVER_BUSY` key appears in both error maps, assert the `enforce_https` guard exists and precedes the `api/auth/login` fetch in the sliced `login` function, assert the guard does not call `window.location.href`. `npm run build` is the only other gate. The plan states plainly that runtime rendering of those two states is unproven by automated test in this repo.

## 2. Findings against my own rev 3.2 corrections

These are defects I introduced while fixing B10. They are listed separately because they are the strongest evidence that the newest layer of any revision is the thinnest.

### B12 — Critical: an intermediate commit that would not boot

**Problem.** Rev 3.2's Task 2 said "leave no export named `createIpRateLimiter`".

**Evidence.** Consumers verified by grep at the time of writing:
- `server.js:46` (import), used at `:254` `apiRateLimit`, `:264` `publicRateLimit`, `:272` `checkoutRateLimit`
- `backend/routes/admin/printTemplates.js:5` (import), used at `:23`, `:30`
- `backend/tests/unit/rateLimit.test.js:1`

`require` of a missing named export yields `undefined`, so `server.js:254` throws a `TypeError` at module load. **The server would not boot on that commit**, and the following task would have repaired it — hiding the break from anyone running the tasks back to back. Task 3 compounded it by asserting `server.js` no longer contains `createIpRateLimiter` while deliberately keeping `publicRateLimit`, which uses it.

**Correction.** An explicit three-task retirement table: Task 2 adds `createKeyedRateLimiter` beside the old factory (both exported), Task 3 migrates `apiRateLimit`/`checkoutRateLimit`/the two print limiters, Task 5 replaces `publicRateLimit` and only then deletes the factory. The absence assertion moved from Task 3 to Task 5. New adversarial-gate item 17: every task's commit boots and passes on its own.

### Parser wiring — `app.use(matcher, parser)` is a chain, not a guard

**Problem.** Rev 3.2 introduced a tight 16 KB parser for the covered pre-auth routes, written as `app.use(preAuthRouteMatcher, express.json({ limit: '16kb' }))`.

**Evidence (measured, section 5, `use_two_fns_applies_parser_to_all`).** With a matcher that simply calls `next()`, that form returned **413 `entity.too.large`** for a 50 KB body on an **uncovered** route. It would have imposed a 16 KB body limit across the entire application.

**Correction.** One shared predicate `isPreAuthRoute`, invoked conditionally by both mounts:

```js
app.use((req, res, next) => (isPreAuthRoute(req) ? tightPreAuthJson(req, res, next) : next()));  // above server.js:248
app.use((req, res, next) => (isPreAuthRoute(req) ? preAuthGate(req, res, next) : next()));       // below server.js:249
```

Measured behaviour of that pair (section 5, `probe1`): covered small body → 200 and parsed; covered oversize → 413; **uncovered 50 KB body → 200 at the 1 MB limit**. Third case is now a required regression test. New adversarial-gate item 19.

### `runLoginTransaction` — an extraction that would fail silently

**Problem.** Rev 3.2 called `runLoginTransaction` "a pure extraction of the existing body of the `try` block at `auth.js:161-256`".

**Evidence.** That block does two things the description ignored:
- it **sends its own responses** — `return res.status(403).json(…)`, `return sendSuccess(res, {…})`, `sendError(res, 401, …)`;
- it **writes a header** — `setSessionCookie(res, session.rawToken, req)` at `auth.js:232`.

Two silent failure modes follow. Drop `res` and login returns 200 with no `Set-Cookie` — the client appears to succeed, then behaves as logged out. Leave any send inside and the response ships *before* the handler awaits the delay: the entire anti-spray mechanism becomes a no-op while every functional test still passes, and the outer `catch` would then throw `ERR_HTTP_HEADERS_SENT` on top of the original error.

**Correction.** `runLoginTransaction(conn, userNumber, req, res)` takes `res` for `setSessionCookie` **only** and may never send. Explicit tests: `Set-Cookie` present on success; response does not arrive before the 1 s delay elapses; `grep` the finished function body for `res.` and assert the only match is `setSessionCookie`. Also pinned: `invalidateUserSessions` must still run before `preWarmToken` (`auth.js:220-223`).

### `failNextConnectionQuery` — cited as if it were shared

**Evidence.** It is defined locally in `backend/tests/integration/checkout.test.js:322` and again in `backend/tests/integration/refunds.test.js:161`. There is no shared export.

**Correction.** The plan now names both definitions and instructs copying the local pattern rather than importing something that does not exist.

## 3. Repo-evidence checks — claim, command, result

| Claim in the plan | How checked | Result |
| --- | --- | --- |
| `pool.connectionTelemetrySnapshot` exists | grep | `backend/config/db.js:24` ✓ |
| `failNextConnectionQuery` is shared | grep | **false** — local in two test files |
| `src/i18n.js` is the catalog | `ls` | **false** — `src/shared/i18n/ar.json` (Sol's earlier correction confirmed) |
| `loginWebAuthn.spec.js` / `i18nCatalog.spec.js` exist | `ls` | ✓ both |
| A DOM harness exists | package.json + vitest config | **false** — none; `environment: 'node'` |
| `npm run build` exists | package.json scripts | ✓ |
| `requireAuth` precedes the print limiters | read | ✓ `backend/routes/admin.js:6` mounts `requireAuth`; router mounted `:57` |
| Spooler poll needs a new middleware for `req.spoolerId` | read | **false** — already set at `backend/routes/spooler.js:34`; only the IP prefix at `:20` needs removing |
| `directPeerIp` is dead once limiters move | grep | **false** — still the audit `ipAddress` at `printTemplates.js:156,283,302`; must be kept |
| Drawer pop uses an IP-prefixed key | read | ✓ `backend/routes/pos/checkout.js:158` |
| `maxEntries: 1` trips the fail-closed branch | traced `requestThrottle.js:29-35` | **no** — the expired entry is deleted before the size check |
| A 413 from the tight parser stays JSON | read | ✓ global handler `server.js:763` reads `err.status`, returns `{success:false,message}` |
| Another middleware patches `res.end` | grep | none — only `helmet` (header-only), so the patch is unique |
| Covered-route payloads fit 16 KB | read `src/shared/browserDeviceClient.js:107-120` | ✓ ceremony id + base64url P-256 signature + JWK, a few hundred bytes |

## 4. What rev 3.1 got right and rev 3.3 preserves

Unchanged, and deliberately so: `DEVICE_AUTH_REQUIRED` as a routing signal with `delayAction:'keep'`; the explicit tri-state over the earlier boolean; one-attempt login ceremonies with immediate deletion of failed authentication rows; no cross-flow ceremony mutation; single-flight auth-mode cache with a generation counter and both post-commit invalidations; three actor-keyed manager-override namespaces with one verifier in flight; rate and concurrency tested separately; `req.ip` demoted to non-authoritative audit metadata; P1/P2/P3 as the governing rules.

## 5. Reproducible probe

Saved outside the repo, in the session scratchpad. Re-runnable with `node <path>` from anywhere. It binds `127.0.0.1` on an ephemeral port and touches no database.

Measured output on `express@5.2.1`, `supertest@7.2.2`, Node v24.16.0:

```json
{
  "tight_parser_small_covered":     { "status": 200, "body": { "ok": true, "size": 22 } },
  "tight_parser_oversize_covered":  { "status": 413, "body": { "err": "entity.too.large" } },
  "global_parser_big_other_route":  { "status": 200, "body": { "ok": true, "size": 51211 } },
  "use_two_fns_applies_parser_to_all": { "status": 413, "body": { "err": "entity.too.large" } },
  "res_end_patch_fired_for": {
    "/json": true, "/send": true, "/redirect": true,
    "/status204": true, "/file": true, "/stream": true
  },
  "response_events_order": ["finish", "close"],
  "unref_returns_timeout": { "sameObject": true, "clearable": true },
  "raw_http_request_holds_open": { "stillOpen": true, "gotResponse": false },
  "supertest_has_write_without_end": { "hasWrite": true, "hasEnd": true }
}
```

Reading of each line:

1–3. The conditional two-parser design works: covered bodies parse under the tight limit, oversize covered bodies 413, and **uncovered routes keep the 1 MB limit**.
4. The `app.use(matcher, parser)` form does **not** gate — it applied the tight limit app-wide. This is the measurement that caught my own defect.
5. Releasing the gate lease on a patched `res.end` covers every Express response path, including `sendFile` and a piped stream.
6. `finish` fires before `close`; both fire. The idempotent release guard is required, not decorative.
7. `Timeout.unref()` returns the same object, so `watchdog = setTimeout(...).unref()` remains `clearTimeout`-able.
8. A raw `http.request` written but never ended stays in flight with no response — the B10 regression test technique is valid.
9. Supertest exposes `.write`, but finalizes on `.then()`/`.end()` and has no partial-body mode; the plan's wording was corrected from "cannot express this" to that precise statement.

## 6. What I did NOT verify — recommended attack surface

Attack these first; I have no evidence either way.

1. **Nothing has been executed.** No RED, no GREEN, no build. Every test contract in the plan is a claim about a test that has never been written or run.
2. **The `runLoginTransaction` restructure is unproven end to end.** I verified the coupling that makes it dangerous; I did not verify that the extracted function reproduces the existing transaction's behaviour for the programmer exception, the staged-mode registered-credential branch (`auth.js:188-197`), or `req.io` emission ordering.
3. **The `res.end` patch was measured on a bare Express app, not on this app.** `helmet` is the only other response middleware I found, but I did not exercise the patch against the real route stack, socket.io's HTTP upgrade handling, or the static-file middleware.
4. **`maxConcurrent = 6` has not been load-checked against real venue behaviour.** `/login` serialises on a single `settings` row `FOR UPDATE` (`auth.js:164-166`), so concurrent logins queue while holding leases. I argued 6 is safe post-fix; I did not measure a shift-change burst or a post-deploy reload storm.
5. **`GATE_LEASE_MAX_MS = 15000` is a judgement, not a measurement.** I did not sample real handler durations for the covered routes.
6. **The auth-mode cache generation counter is unexercised.** The interleaving it defends against (invalidate while an older read is in flight) is reasoned, not observed.
7. **Stateless-decoy timing is explicitly not claimed constant.** The plan states this; nobody has measured the actual delta.
8. **Task 6's architecture-map update** (`docs/architecture.json`, `npm run architecture:check`) has not been dry-run.

## 7. Specific review requests

1. **B10's fix, hardest.** Is releasing on `res.end` sufficient, or is there a fourth hold I have not found? Consider HTTP/1.1 keep-alive, pipelined requests, and `socket.io`'s upgrade path.
2. **The watchdog residual.** Over-admission after a watchdog fire is accepted and bounded by the pool. Is that reasoning wrong under any sequence — for instance repeated watchdog fires under a slow database?
3. **`isPreAuthRoute` as an exact method+path predicate.** Express 5 uses path-to-regexp v8. Does exact-path matching miss anything real — trailing slashes, case, percent-encoding, `OPTIONS` preflights, or a route mounted under a prefix I have not accounted for?
4. **B12's retirement table.** Please walk the six commits and confirm each one boots and passes independently. That is the property I broke once already.
5. **The frontend concession.** Is source-contract-only proof acceptable for the `enforce_https` refusal, or does that gap justify revisiting the no-new-dependency constraint?
6. **Anything in section 6.**

## 8. Status

The plan is internally consistent, every cited path/helper/mount order has been opened and confirmed, every framework behaviour it depends on has been measured against this repo's own dependencies, and every task's commit is intended to boot on its own.

I am **not** claiming it is defect-free. Four consecutive revisions have each shipped a defect in their newest layer, including both of mine. Rev 3.3's newest layer — the `res.end` release, the conditional parser wiring, the retirement table — has had exactly one reviewer.

Requesting adversarial review before any implementation. Nothing here authorises execution, commit, merge, push, migration, or deployment.
