# Rev 3.4 pre-implementation experiment report

**Date:** 2026-08-15  
**Plan tested:** `docs/superpowers/plans/2026-08-14-proxy-free-identity-rate-limiting.md`  
**Probe:** `scripts/prototype-proxy-free-plan-adversarial.js`

## Verdict

Rev 3.4 is strong enough to execute. The hostile prototype found **no new structural defect** in the plan. I rate the plan **9.3/10 overall** before implementation: its algorithms and in-process HTTP composition have direct experimental support; the remaining uncertainty is integration work that cannot exist until the plan is implemented.

This is deliberately not a claim that unimplemented production code is proven correct. It is evidence that the plan's proposed mechanisms stand when made executable in isolation, including the edge cases that broke earlier revisions.

## Safety boundary

The probe imports the repository's real `createFixedWindowThrottle` and `hashThrottlePart`, and uses the installed `express@5.2.1`, body parsers, Node HTTP server, raw sockets, and Supertest. It does not import application routes, connect to MySQL, change application behavior, deploy, or touch customer data.

## Measured result

One complete visible run:

```text
20 tests passed, 0 failed, 264 ms
50,000 hostile semaphore transitions
50,000 distinct delay-ring candidates
4,096 fixed delay slots
5,000 ms observed maximum candidate delay
100 concurrent cold auth-mode reads collapsed to one query
```

The completed harness was then run 20 more times:

```json
{
  "Runs": 20,
  "Failures": 0,
  "MinMs": 364.0,
  "MaxMs": 398.0,
  "AverageMs": 381.8
}
```

That is **420 named scenario executions with zero failures** for the final harness version. Each named scenario contains multiple assertions; the abuse tests additionally perform 50,000 state transitions or candidates per run.

## Attacks and outcomes

| Attack or failure mode | Experiment | Outcome |
|---|---|---|
| Case/trailing-slash route bypass | Sent 50 KB JSON to canonical, trailing-slash, uppercase, and query-string login aliases | Every accepted Express alias returned 413 |
| Form-parser bypass | Sent a 50 KB URL-encoded login body | Returned 413 |
| Accidental global body-limit expansion | Sent the same 50 KB JSON to a non-covered route | Remained accepted under the existing 1 MB global parser |
| GET-to-HEAD alias bypass | Used `HEAD /api/auth/login-policy`, then tested the shared rate budget | HEAD was covered and consumed the budget |
| Malformed path expansion | Tried double slash and percent-encoded path variants | They remained 404 and did not become protected-handler aliases |
| Client-IP partitioning or spoofing | Rotated `X-Forwarded-For` values through 600 requests and changed route on request 601 | Request 601 was uniformly denied; headers and route could not create a new bucket |
| Off-by-one global ceiling | Exercised requests 1 through 601 | 1-600 admitted, 601 returned the exact `SERVER_BUSY` body, then the window reset |
| Lease double-release | Fired both `close` and `end` for the same response | Counter returned to zero exactly once |
| Watchdog over-admission | Held the only lease past the warning threshold | Warning fired; the next request still returned 429 until real completion |
| Synchronous downstream failure | Threw inside the admitted middleware chain | Lease was released immediately |
| Random lifecycle corruption | Ran 50,000 deterministic admit/end/close/reject transitions | Counter always equaled live responses and stayed within 0-6 |
| Slow-body lease exhaustion | Opened six raw POST sockets with declared but unfinished JSON bodies | A normal policy request still entered; parsers held no dynamic leases |
| Real six-request saturation | Held six live Express handlers, then sent a seventh | Seventh returned the uniform 429; completing the six restored admission |
| Slow public-menu reader | Paused an actual HTTP client against a backpressured public-menu stream | A dynamic policy request still entered with `maxConcurrent=1` |
| Keep-alive leak | Sent ten sequential protected requests over one keep-alive socket | All returned 200 and the live counter returned to zero |
| Candidate-state exhaustion | Fed 50,000 distinct candidate strings into the delay ring | Storage stayed fixed at 4,096 slots; delay never exceeded 5 seconds |
| Preconditioned collision | Found a real SHA-derived collision, raised its slot to the cap, then read through both candidates | Both saw the same bounded delay; neither could be hard-denied; success cleared the shared slot |
| Cold-cache stampede | Started 100 simultaneous default-pool auth-mode reads | Exactly one underlying query ran |
| Stale cache resurrection | Invalidated while an older read was unresolved, completed a new read, then resolved the old one | Old result reached only its original caller and did not repopulate cache |
| Transaction cache contamination | Read through a non-pool executor | It bypassed the default-pool cache |
| Hosted HTTPS redirect loop | Modeled explicit `http`, explicit `https`, missing header, and encrypted socket | Only explicit forwarded `http` on an unencrypted socket redirected |
| Insecure hosted cookie | Modeled cookie policy independently from request protocol | `ENFORCE_HTTPS=true` always produced Secure policy |
| Decoy ceremony exhaustion | Requested 50,000 unknown candidates | Ceremony-row count remained zero |
| Cross-flow ceremony mutation | Submitted an authentication ceremony ID to an enrollment flow | Generic failure returned and the authentication row remained intact |
| Failed-proof reuse | Failed a real authentication proof, then retried the same ID | First failure deleted it; retry received the same generic failure |
| Manager-override cross-user denial | Started overlapping verifier work for same and different actor/surface keys | Only the identical actor/surface pair was rejected |
| Sleeping with a DB lease | Executed the planned login phase ordering in a trace model | Commit and release occurred before delay and response |

## Strength by layer

| Layer | Rating | Reason |
|---|---:|---|
| Abuse-control algorithms | 10/10 | Fixed cardinality, delay cap, constant global key, cache generation, and terminal ceremony behavior survived direct hostile state tests |
| Express/HTTP composition | 9.7/10 | Real parser aliases, raw incomplete bodies, live concurrency, backpressure, and keep-alive were exercised with the installed runtime |
| Database transaction integration | 8.5/10 | Ordering and cache races were executable, but actual route/transaction code does not exist yet and MySQL was intentionally untouched |
| Browser and hosted topology | 8.0/10 | Decision rules are internally consistent; actual UI behavior, Hostinger headers, Secure cookie, and production TLS remain post-implementation gates |

## What the experiments do not prove

These are execution gates, not missing plan design:

1. The implemented middleware must be mounted in the exact planned order in the real `server.js`.
2. The real login transaction must never send a response internally and must release its MySQL connection before the delay.
3. Both auth-mode writers must invalidate only after commit.
4. The browser must visibly handle `SERVER_BUSY` and refuse unsafe HTTP without a redirect loop.
5. The exact hosted domain must be checked for Force HTTPS, forwarded protocol behavior, and a `Secure; HttpOnly; SameSite=Strict` session cookie before deployment.
6. A low-end terminal and the hosted runtime should receive a focused load check after implementation; the values 600/minute and 6 concurrent requests are defensible bounds, but they are policy choices rather than hardware measurements.

## Recommendation

Stop revising the design and execute Rev 3.4 test-first. No experiment exposed another mechanism-level blocker. Further pre-implementation rewriting would now provide less confidence than implementing the plan and running its focused integration, browser, MySQL, and hosted verification gates.

## Reproduction

```powershell
node scripts\prototype-proxy-free-plan-adversarial.js
```

The probe is intentionally one command, dependency-free beyond packages already installed in this repository, and safe to run without a database.

## Evidence identity

```text
CA427E29022D315F070BD65914B9CD74960A4BF39BB36AD4DC3A1EE14D257439  plan
31AAF1D0F4049B0058A6224C2E212852B8A65D93D6A2F27EF98E2D3E32F4FA69  probe
```
