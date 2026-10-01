# Rev 3.4 Implementation — Adversarial Review, Cross-Review and Resolution

**Date:** 2026-08-15
**Branch:** `codex/webauthn-device-access`
**Reviewed at:** `ce302bd6` (6 commits over `406d337a`)
**Status:** three defects fixed on top of `ce302bd6`; two of my findings withdrawn after cross-review; one new blocker found by measurement and fixed.

## Scope and evidence boundary

Read-only review, then implementation of the agreed fixes. Probes ran outside the repo against the real `express@5.2.1`, `supertest` and the real `backend/middleware/rateLimit.js`. Two full test-suite runs and one baseline run were executed against the shared `posapp_test` database, one vitest process at a time. No merge, push, deployment, migration, or Hostinger change.

Findings were cross-reviewed. Where the cross-review corrected me, the correction is recorded with its evidence rather than quietly dropped.

## Verdicts after cross-review

| | severity | verdict | outcome |
| --- | --- | --- | --- |
| **F1** `.php` suffix bypasses the pre-auth gate | critical | confirmed by both reviewers | **fixed** |
| **F2** watchdog does not release the lease | — | **withdrawn — not a defect** | no change |
| **F3** override delay runs inside an open transaction | high | confirmed, ceiling corrected | **fixed** |
| **F4** `public_menu.json` concurrency exemption undocumented | — | **withdrawn — factually wrong** | no change |
| **F5** override window rollover + dead exports | medium | confirmed, more reachable than I reported | **fixed** |
| **F6/F7** test-harness rate limiting | blocker | upgraded from "conditional risk" — wrong limiter identified, then measured | **fixed** |

---

## F1 — Critical: `.php` bypassed the entire pre-authentication gate

The gate and the tight 16 KB parsers matched on `req.path` at `server.js:237-268`. A legacy normalizer stripped `.php` from `req.url` at `server.js:608-618` — after the gate, before the route mounts at `:639`. So `/api/auth/login.php` was not in `PRE_AUTH_ROUTES`, passed ungated and unparsed, was then rewritten, and reached the real handler.

Measured against the **real application** (cross-review): `/api/auth/login` with a 50 KB body → `413`; `/api/auth/login.php` with the same body → `401 Invalid user number`; `/api/auth/login-policy.php` → `200`. All 8 covered `/api` routes bypassed.

Impact: `PRE_AUTH_ROUTES` is the sole hard-denial control in the design — P1 permits only that gate to deny, and every other pre-auth pressure was reduced to bounded delay on that basis. Skipping it restored unbounded PIN sweeping (defect B2), invalidated the row-growth bound behind B4, and was invisible to the gate's own counters.

**Fix: the normalizer was deleted, not relocated.** An earlier draft of this review recommended moving it above the gate. That recommendation carried an unverified premise — that the legacy behaviour had a consumer worth preserving. It does not: zero `.php` references in `src/`, zero in `pos-spooler-printer/`, no `api/….php` anywhere in the repo's JS/Vue/HTML/MD, no `.htaccess` template, and `git log --all -S'.php' -- src/` empty for all history. The normalizer entered at `5f7ae74b` ("Full backup before Vue Router SPA refactoring") and never had a caller. The only PHP in the project is bundled phpMyAdmin in the Windows installer (`deployment/templates/httpd.conf.template:13`), a separate Apache on its own port that never proxies the POS API.

The page-level 301s at `server.js:688-699` (`/login.php` → `/login`) were kept: explicit `app.get` routes for human bookmarks, no URL rewriting, never reach the gate.

**Two regression tests, because the defect class matters more than the suffix:**
- `preAuthGate.test.js` — `POST /api/auth/login.php` and `GET /api/auth/login-policy.php` return 404 against the real app, and the login handler's message is asserted absent. This also satisfies the "verify against the running app, not a replica" requirement.
- `networkBoundaryPolicy.test.js` — asserts `server.js` contains **no `req.url =` after the gate mount**. The defect is a path rewrite downstream of a path-matching security control; this pins that class.

**Why the existing tests missed it:** `preAuthGate.test.js` and `networkBoundaryPolicy.test.js` did test route aliases — uppercase, trailing slash, double slash — but every alias tested is one the matcher itself normalizes. Neither tested an alias **invented by later middleware**.

## F2 — Withdrawn: the watchdog behaviour is correct as shipped

I reported that the gate's watchdog logs without releasing the lease. That is intentional and specified: the plan requires the concurrency counter to be a semaphore rather than a TTL cache — *"A watchdog may report stuck work, but it must never decrement `inFlight`: releasing without cancelling the handler lets old queries remain while six new requests enter every warning interval, eventually filling the pool"* — and its regression test requires the next request to stay rejected. `backend/tests/unit/rateLimit.test.js` matches that contract.

The engineering argument is also right: releasing a lease does not cancel the waiting database operation, it just admits more work behind it. The gate reporting live work as live is the correct behaviour.

**Root cause of my error:** I reviewed the implementation against the rev 3.3 plan I had authored rather than the rev 3.4 plan that actually shipped. Same class as the F1 recommendation error — an unverified premise — one level up.

The pool's indefinite `getConnection()` wait (`backend/config/databasePoolOptions.js`, `waitForConnections: true`, no acquire timeout) remains a genuine availability limitation, but it is a separate concern and not evidence against the gate.

## F3 — High: the manager-override delay ran inside an open transaction

`beginOverrideAttempt` awaited a delay while three of four call paths held a pooled connection with a transaction open:

| path | connection | transaction | override call | released |
| --- | --- | --- | --- | --- |
| `backend/modules/checkout/executeCheckout.js` | `:234` | `:275` | `:758`, `:812`, `:991` | `:2139` |
| `backend/modules/tables/tableRelationships.js` | `:509` | `:511` | `:522` | `:614` |
| `backend/modules/tables/tableRelationships.js` | `:619` | `:621` | `:632` | `:711` |
| drawer pop, `backend/routes/pos/checkout.js` | — | — | before any query | already correct |

Cross-review telemetry showed one connection acquired and unreleased for 1,002 ms during a third attempt. **Correction accepted:** the reachable ceiling is 4 s, not the 5 s I reported — `OVERRIDE_MAX_FAILED = 5` fires the lockout on the fifth failure, so `OVERRIDE_DELAY_STEPS_MS[5] = 5000` is unreachable. Measured progression `0, 0, 1003, 2010, 4001`, then immediate 429. Ten such checkouts park the whole 10-connection pool while holding row locks.

**Fix: the delay was removed rather than relocated**, and this corrects an error in the original plan's own rationale. That plan claimed the delay makes a ~1,440-guesses/day privileged-PIN sweep "materially slower". It does not: with a 5-failure lockout over a 5-minute window, the rate is 5 attempts per window — 1,440/day — with or without the delay, whose reachable total is 7 s against a 300 s window. The lockout and the in-flight guard are the controls doing the work.

This is deliberately different from `/login`, where the delay **is** the control precisely because there is no lockout there — a lockout on login would be aimable at a cashier (defect B1). `backend/services/loginDelay.js` and the login path are untouched.

## F4 — Withdrawn: the exemption was documented

I reported the `trackConcurrency` exemption for `public_menu.json` as undocumented scope drift. It is specified in the plan's invariant 8, in the gate construction, and in `docs/architecture.json`. Same root cause as F2 — reviewing against the wrong revision of the plan.

## F5 — Medium: window rollover shed both the in-flight guard and an unexpired lockout

`getOverrideAttemptState` returned a fresh `{ …, inFlight: false }` whenever `now - firstAttemptAt > OVERRIDE_LOCKOUT_MS`, ignoring `lockedUntil` and discarding `inFlight`. Two consequences:

- the parallel-guess guard disappeared for a verification straddling the boundary;
- because `firstAttemptAt` is preserved across failures, a lockout set by a late fifth failure was shed as soon as the window measured from the *first* failure expired — up to five minutes early.

**Cross-review correction accepted:** this is more reachable than I described. It does not need a request in flight for five minutes; earlier failures make `firstAttemptAt` old, so an ordinary request need only cross the boundary.

**Fix**, aligning the lazy reset with the module's own periodic sweep, which already required both conditions: expire only when the window has passed **and** the lockout has elapsed, and carry `inFlight` through the reset.

**A second instance surfaced while writing the test.** `cleanExpiredOverrideAttempts` — the 10-minute timer — deleted stale entries without checking `inFlight`, so the sweep could drop the guard exactly as the lazy path did. It now never evicts an entry whose verification is still running. Writing the test is what exposed it; reasoning alone had not.

Dead exports `isOverrideLocked` and `clearFailedOverride` were removed along with their definitions, after confirming zero callers anywhere in `backend/` including tests. `recordFailedOverride` is still used internally and was kept.

## F7 — Blocker: the branch broke 40 checkout tests (F6, corrected and upgraded)

I originally filed this as F6, "no test escape hatch for the gate — mechanically possible but unverified", and named the wrong limiter. Cross-review downgraded it to a conditional risk after a full-suite attempt showed no `SERVER_BUSY`. Both of us were wrong about the mechanism; measurement settled it.

`backend/tests/globalSetup.mjs` had raised four limits for the test suite, with a comment explaining exactly why. Commit `81339d2e` removed all four, correctly for three of them — those limiters no longer exist. But `checkoutRateLimit` was re-created in `backend/routes/pos/checkout.js` with a **hardcoded** `max: 30` keyed by `actorKey`, and `checkout.test.js` drives hundreds of checkouts as one actor as fast as it can.

Measured attribution, running the six failing files at the branch point:

| file | `406d337a` | `ce302bd6` |
| --- | --- | --- |
| `printGoldens.test.js` | 22 | 22 |
| `orderSessionBoundaries.test.js` | 1 | 1 |
| `frontendRuntimePaths.test.js` | 1 | 1 |
| `taxExemptWorkflow.test.js` | 1 | 1 |
| `platformRemittanceRoutes.test.js` | 1 | 1 |
| **`checkout.test.js`** | **0 — fully passing** | **40** |

26 failures pre-date the branch; the branch introduced exactly 40, all in `checkout.test.js`, presenting as `expected 429 to be 200/400/403` plus cascading state errors from checkouts that never completed.

**Fix:** restore the optional override — `max: Number(process.env.CHECKOUT_RATE_LIMIT_MAX || 30)` — and the corresponding line in `globalSetup.mjs`, with its stale "all requests share loopback IP" comment rewritten to describe actor-keyed throttling. This adds no operator configuration: `CHECKOUT_RATE_LIMIT_MAX` appears in no env template and never did; production leaves it unset and gets 30, which is far above a real terminal that cannot complete a checkout every two seconds. The pre-auth gate and print limiters were deliberately **not** raised — measured against the full suite, neither is reached.

## Verification

| | result |
| --- | --- |
| `checkout.test.js` after fix | **116 passed, 0 failed** (was 40 failing) |
| Focused list — 12 files incl. gate, login, override, tables, security, permissions | **310 passed, 0 failed** |
| `npm run build` | green |
| Full suite before fixes | 66 failed / 2839 passed (6 files failed) |
| Full suite after fixes | **26 failed / 2882 passed** (5 files failed) |

The remaining 26 are exactly the pre-existing set, file for file and count for count, identical to `406d337a`. `checkout.test.js` no longer appears. The arithmetic closes: 2839 + 40 restored + 3 newly added = 2882, and the test total moves 2905 → 2908 for the three regression tests added here. **The branch now introduces zero test failures.**

Pre-existing failures (26, unchanged by this work and out of scope): 22 in `printGoldens.test.js` — kitchen-ticket HTML goldens drifted against `.kitchen-item-qty`/`.kitchen-item-name` markup — plus one each in `orderSessionBoundaries`, `frontendRuntimePaths`, `taxExemptWorkflow`, `platformRemittanceRoutes`. These fail identically at `406d337a` and should be triaged separately.

## Notes for whoever picks this up next

- **`tests/e2e/specs/**` is not in the vitest `include` patterns** (`vitest.config.mjs:26-30`), so the `admin.login-boundary.spec.js` this branch added never runs under `npx vitest run`. It executes only under `npm run test:e2e`.
- **`backend/tests/setup.js`'s comment is stale.** It claims to clear module-scope Maps between test files; it only resets the Socket.IO mocks. With `fileParallelism: false, maxWorkers: 1`, throttle state accumulates across the entire run — the mechanism behind F7. Pre-existing, not introduced here.
- The pool's indefinite `getConnection()` wait is a real availability limitation and a reasonable separate piece of work.
