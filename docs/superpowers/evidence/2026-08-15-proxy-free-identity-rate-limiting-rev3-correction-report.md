# Proxy-Free Identity Rate Limiting Rev 3.1 Correction Report

**Date:** 2026-08-15  
**Branch / HEAD:** `codex/webauthn-device-access` / `406d337a`  
**Corrected plan:** `docs/superpowers/plans/2026-08-14-proxy-free-identity-rate-limiting.md`  
**Corrected plan SHA-256:** `3bc9cd3ae04dd3d8a01dbd0ee90248543b757ecc69b39eac1ca6c35e60c035f6`  
**Plan state:** **CLOSED FOR IMPLEMENTATION**  
**Runtime implementation state:** **NOT EXECUTED BY THIS REVIEW**

## Scope and evidence boundary

This report covers the defects found when Rev 3 was composed against the current authentication, browser-credential, ceremony, database-pool, manager-override, and Express middleware paths. It records the evidence, the correction now written into Rev 3.1, and the hostile checks used to decide whether the plan is internally executable.

No application source, database, environment, production host, installer, or deployment was changed. No runtime suite was executed because this task corrected an implementation plan rather than implementing it. The automated evidence in this review consists of read-only source inspection, path/contract scans, Markdown validation, and deterministic state-machine/threshold probes.

## Executive result

Rev 3's structural direction was retained: no client-IP identity, no candidate-keyed hard denial, stateless unknown browser challenges, one global candidate-independent boundary, and fixed-size delay state.

Rev 3.1 closes the defects found in the final composed review:

1. enforced-mode delay state no longer reveals real users;
2. replaying a failed verification no longer reveals whether its ceremony was real;
3. login verification cannot mutate enrollment, bootstrap, approval, or step-up ceremonies;
4. request 601 is no longer required to pass a 600-request boundary;
5. the global boundary now limits simultaneous work as well as per-minute volume;
6. cold authentication-mode cache misses are single-flight and invalidation-race safe;
7. failed authentication rows are deleted immediately instead of accumulating for a day;
8. every manager-override surface has an explicit actor/surface key and one verifier in flight;
9. the security goal now states its real boundaries instead of claiming constant-time or zero targeted latency.

## Findings, evidence, and corrections

### R3-1 — Critical: hidden delay state enumerated enforced users

**Problem**

Rev 3 assigned `failed:false` to a real user's `DEVICE_AUTH_REQUIRED` response but `failed:true` to an unknown user, although current enforced-mode routing returns the same 403 body for both. Repetition therefore changed latency differently while preserving an identical HTTP response.

**Evidence**

- Current enforced login checks `users[0]?.role !== 'programmer'`; `undefined !== 'programmer'` is true, so an unknown number and an ordinary real user both return `DEVICE_AUTH_REQUIRED` (`backend/routes/auth.js:174-182`).
- Deterministic schedule probe:
  - real path under Rev 3: `0, 0, 0, 0, 0, 0`;
  - unknown path under Rev 3: `0, 0, 1000, 2000, 4000, 5000` milliseconds.

**Solution in Rev 3.1**

- Replace the ambiguous boolean with `delayAction: 'record' | 'clear' | 'keep'`.
- Every enforced-mode `DEVICE_AUTH_REQUIRED` uses `keep`, regardless of hidden user existence.
- Only public 401 invalid-PIN outcomes record failure; only successful authenticated sessions clear it; routing, validation, and server failures preserve it.
- Add a preconditioned-state test that asserts the explicit state action, not only response bytes or wall-clock timing.

Plan evidence: lines 370-412 and adversarial gate item 2.

### R3-2 — Critical: repeating login verification recreated the existence oracle

**Problem**

A never-issued stateless id remained missing on every retry. A real ceremony with a bad signature was changed to terminal `failed`; retrying it then returned an expired/invalid response. One failed request followed by one retry distinguished real from unknown candidates.

**Evidence**

- `/login/verify` locks the row, calls `assertPendingCeremony`, and sends candidate-dependent failures through one catch (`backend/routes/auth/webauthn.js:429-455`).
- `finishFailedAttempt` terminalises any supplied ceremony (`backend/routes/auth/webauthn.js:162-167`).
- `assertPendingCeremony` exposes distinct invalid, expired, and exhausted states (`backend/services/webauthn/ceremonies.js:89-107`).

**Solution in Rev 3.1**

- Login authentication challenges are one-attempt.
- Missing, wrong-flow, expired, terminal, previously-attempted, inactive-user, and invalid-signature paths all return the same 401 `WEBAUTHN_AUTHENTICATION_FAILED` body.
- An expected failure for a real authentication row deletes that row inside the locked transaction and commits before responding.
- Unexpected database/server failures still roll back and return 500; they are not disguised as bad credentials.
- Tests repeat real and never-issued ids and compare both the first and second responses, then repeat the matrix for expired, terminal, and attempted rows.

Plan evidence: lines 431-467 and tests at lines 491-495.

### R3-3 — High: login verification could destroy another ceremony flow

**Problem**

Submitting an enrollment or step-up ceremony id to `/login/verify` caused `assertPendingCeremony` to reject its flow, after which the shared catch could pass that existing row to `finishFailedAttempt`. The login endpoint could therefore terminalise a valid ceremony owned by another workflow.

**Evidence**

- The row is loaded before flow assertion (`backend/routes/auth/webauthn.js:429-430`).
- The catch calls `finishFailedAttempt(conn, ceremony)` whenever the mutation flag is false (`backend/routes/auth/webauthn.js:450-454`).
- `finishFailedAttempt` does not verify the ceremony flow (`backend/routes/auth/webauthn.js:162-167`).

**Solution in Rev 3.1**

- A missing, terminal, expired, attempted, or non-authentication row is rolled back and reported generically without any write.
- Only a pending `flow='authentication'` row may be attempted or deleted by login verification.
- Cross-flow tests submit pending enrollment and step-up ids and assert their state and attempt count remain unchanged.

### R3-4 — Critical specification contradiction: request 601 was required to succeed

**Problem**

Rev 3 required 600 unknown `/login/options` calls followed by a successful real cashier call, while Task 5 admitted exactly 600 requests per minute. The legitimate call was request 601 and therefore necessarily failed.

**Evidence**

A deterministic fixed-window probe admitted exactly 600 sequential requests and rejected request 601. There is no implementation capable of satisfying both requirements simultaneously.

**Solution in Rev 3.1**

- Integration tests use clearly sub-ceiling hostile batches: 50 unknown options requests for row-growth proof and 100 same-candidate requests for absence of candidate lockout.
- The rate boundary is tested independently with a fresh gate factory: finish requests 1-600 sequentially, then require request 601 to return the documented 429.
- Concurrency behavior is tested independently so rate and in-flight state cannot invalidate each other's proof.

Plan evidence: B9, lines 488-495, and lines 565-625.

### R3-5 — High: a per-minute counter did not protect the database from a concurrent burst

**Problem**

The first 600 requests could arrive simultaneously. The database defaults to 10 connections and a queue of 50, so a much smaller uncached pre-authentication burst could occupy the pool or queue before the rate threshold was reached.

**Evidence**

- Pool defaults: `connectionLimit=10`; a zero configured queue is normalised to 50 (`backend/config/databasePoolOptions.js:10-33`).
- JSON parsing currently occurs before route mounts (`server.js:248-249`), and authentication routes are mounted later (`server.js:648`).
- Unknown options still require a user lookup; real options additionally insert and read a ceremony (`backend/routes/auth/webauthn.js:391-408`).

**Solution in Rev 3.1**

- One `createGlobalPreAuthGate` owns both global dimensions: 600 admitted requests/minute and 6 simultaneous admitted requests.
- Both dimensions use no candidate, IP, cookie, forwarded header, or database identity and emit the same `SERVER_BUSY` response.
- The gate is mounted after startup/CORS but before body parsing and only on the exact public authentication/menu/preferences route set.
- `finish` and `close` use one idempotent release function, preventing leaked or double-released capacity.
- Six admitted requests leave four of the default ten database connections available to checkout/printing work in the worst pre-auth-only allocation.

Accepted boundary: saturating either global dimension is shared-fate. It can temporarily reject all covered pre-authentication routes, but it cannot target a chosen cashier or reveal a candidate. Generic volumetric/socket DDoS remains outside this application-level plan.

### R3-6 — High: a value-only auth-mode cache still allowed a cold-miss stampede

**Problem**

A five-second value cache alone does not protect the pool when many requests arrive immediately after startup or expiry. Every caller can miss before the first query returns and issue its own query.

**Evidence**

- `readAuthMode()` currently performs a query for every call (`backend/services/deviceAccess.js:11-14`).
- `/login-policy` calls it directly, and the WebAuthn router has multiple additional call sites.
- The setting has two runtime writers: bootstrap registration sets `staged` (`backend/services/deviceAccess.js:234-236`) and the admin route sets `enforced` (`backend/routes/admin/deviceAccess.js:226-243`).

**Solution in Rev 3.1**

- Default-pool reads share one in-flight promise.
- Transaction/non-pool executor reads bypass the cache.
- A generation counter prevents an old pending read from repopulating after invalidation.
- Both runtime writers invalidate only after commit.
- Tests cover 100 concurrent cold reads, both write transitions, transaction bypass, and invalidation racing a stale promise.

Plan evidence: lines 509-563.

### R3-7 — High: failed authentication rows were not bounded by the two-minute pending calculation

**Problem**

Rev 3 claimed a roughly 1,200-row bound using the two-minute pending TTL. Expected failed proofs were terminalised, however, and terminal rows are retained for one day. Sustained options-plus-invalid-verify traffic could therefore leave hundreds of thousands of rows despite staying below the pending count.

**Evidence**

- Pending rows are removed after expiry, but terminal rows remain until `consumed_at` is older than one day (`backend/services/webauthn/ceremonies.js:134-140`).
- Current login verification terminalises expected failures through `finishFailedAttempt`.

**Solution in Rev 3.1**

- Expected failed login-authentication rows are deleted immediately.
- Abandoned pending real rows retain the two-minute TTL.
- Stateless unknown candidates write no row.
- Successfully consumed rows require a valid registered-browser signature and retain existing cleanup as legitimate history/replay evidence.

### R3-8 — High: deleting login-attempt helpers broke standalone manager override

**Problem**

Rev 3 deleted `loginAttemptKey`, `isLoginLocked`, `recordFailedLogin`, and `clearFailedLogin`, but the live authenticated `/api/auth/manager_override` route still calls them. The plan mentioned the service and drawer paths without replacing this third consumer.

**Evidence**

- Standalone override uses the login-attempt helpers (`backend/routes/auth.js:264-302`).
- Inline permission override has its own store (`backend/services/ManagerOverrideService.js:7-143`).
- Drawer pop uses that store with another IP-prefixed key (`backend/routes/pos/checkout.js:146-187`).

**Solution in Rev 3.1**

- Preserve all three role sets, PIN rehash behavior, responses, and audit event names.
- Reuse the existing override store with separate authenticated namespaces:
  - `manager_override:user:<id>`;
  - `permission_override:user:<id>`;
  - `drawer_pop:user:<id>`.
- Add one atomic in-flight verifier per actor/surface and a bounded delay before PIN queries, with no DB connection held.
- Failure advances the existing 5-per-5-minute control, success clears it, and server failure preserves it. Every path releases in `finally`.
- Tests attack all three namespaces concurrently and verify authorization/audit parity.

### R3-9 — Medium: stated guarantees and executable file/test paths disagreed

**Problem**

Rev 3 claimed no aimable degradation while accepting a five-second collision delay, claimed no user enumeration while explicitly accepting a timing signal, named nonexistent `src/i18n.js`, and omitted existing frontend contract tests.

**Evidence**

- The real catalog is `src/shared/i18n/ar.json`.
- Existing focused tests are `src/components/__tests__/loginWebAuthn.spec.js` and `src/shared/__tests__/i18nCatalog.spec.js`.
- The fixed ring uses unsalted SHA-256 slots, so a chosen slot can be collided offline; denial is prevented, but up to five seconds of latency is aimable.

**Solution in Rev 3.1**

- The goal now promises no targeted hard denial and no deterministic status/body/state oracle in enforced mode; it explicitly accepts bounded collision latency and non-constant database timing.
- P3 applies to attacker-keyed abuse state, not all durable authentication history.
- The real i18n and frontend test paths are named in Task 5 and the final focused command.
- Fake constant-time padding was rejected: it adds cashier latency without proving constant work.

## Final hostile checks

The corrected plan was attacked against these sequences:

1. repeated known and unknown enforced-mode PIN submissions after preconditioning a colliding delay slot;
2. bad real signature followed by replay of the same ceremony id;
3. never-issued id replayed the same number of times;
4. expired, terminal, and previously-attempted authentication ids;
5. enrollment and step-up ids submitted to login verification;
6. 600 sequential gate admissions followed by request 601;
7. six unresolved gate admissions followed by concurrent request 7, then finish/close release;
8. 50,000 distinct delay candidates against fixed ring cardinality;
9. 100 concurrent cold authentication-mode reads;
10. invalidation while an older authentication-mode read is still unresolved;
11. concurrent PIN guesses on each manager-override namespace;
12. forwarded-header rotation against every throttle/delay key;
13. source/path scans for deleted IP-keyed helpers, nonexistent files, placeholders, and contradictory test thresholds.

Deterministic probe results:

```json
{
  "gate": {
    "sequential_allowed": 600,
    "request_601_allowed": false,
    "first_six_concurrent_allowed": true,
    "request_7_concurrent_allowed": false,
    "request_after_release_allowed": true
  },
  "enforced_delay_action": {
    "known": "keep",
    "unknown": "keep",
    "same": true
  }
}
```

Markdown checks passed:

- no `TBD`, `TODO`, placeholder error handling, or “confirm this yourself” language;
- balanced code fences;
- every modified/test path exists except the two files explicitly created and the test explicitly renamed by the plan;
- the final focused command includes the existing login and i18n tests;
- the corrected goal, adversarial gate, and known limitations describe the same trade-offs.

## Closure decision

The plan is closed for implementation because the remaining limitations are explicit boundary conditions, not contradictions hidden inside the design:

- global rate/concurrency saturation is shared-fate;
- a computed delay-slot collision may add at most five seconds but cannot deny login;
- the decoy path is not claimed cryptographically constant-time;
- counters reset on process restart;
- true end-client IP is unavailable and is not used as security identity;
- generic volumetric DDoS remains an upstream concern.

These limitations do not recreate candidate-targeted lockout, deterministic registered-user enumeration, unbounded attacker-keyed state, ceremony cross-flow mutation, or database-pool exhaustion below the explicit global admission gate.

Implementation, focused RED/GREEN tests, architecture regeneration, build verification, commit, merge, push, and deployment remain separate future actions. This report authorises none of them.
