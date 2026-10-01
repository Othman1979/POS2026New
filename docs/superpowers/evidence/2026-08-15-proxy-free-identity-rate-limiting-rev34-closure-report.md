# Proxy-Free Identity Rate Limiting Rev 3.4 Closure Report

**Date:** 2026-08-15  
**Branch / HEAD:** `codex/webauthn-device-access` / `406d337a`  
**Artifact corrected:** `docs/superpowers/plans/2026-08-14-proxy-free-identity-rate-limiting.md`  
**Previous plan:** rev 3.3, SHA-256 `2cd8fe805d208dff18c683b84624fe2d7440b587dd81f29728827367e99df8f2`  
**Closed plan:** rev 3.4, SHA-256 `ca427e29022d315f070bd65914b9cd74960a4bf39bb36ad4dc3a1ee14d257439`  
**State:** PLAN CLOSED — ready for scoped RED/GREEN execution. No application implementation, deployment, database mutation, merge, push, installer build, or Hostinger action occurred in this correction.

## Scope

This was a surgical correction of the last reviewed Task 5 contracts. Tasks 1–4, the auth-mode cache, the login transaction rules, the limiter-retirement sequence, and the P1/P2/P3 architecture were not redesigned.

## Findings closed

### B13 — Express aliases bypassed the exact matcher

**Problem:** rev 3.3 compared exact method/path strings, while this app uses Express's default case-insensitive, non-strict routing and GET handlers automatically answer HEAD. Requests such as `POST /api/auth/login/`, `POST /API/AUTH/LOGIN`, and `HEAD /api/auth/login-policy` reached real handlers but skipped the parser/gate predicate.

**Correction:** rev 3.4 defines one shared route key that lowercases paths, removes trailing slashes, and maps HEAD to GET. Tight parsers and the gate consume that same predicate.

**Evidence:** a standalone probe using this repo's installed `express@5.2.1` returned 413 for 50 KB JSON bodies on the canonical, trailing-slash, and uppercase login paths. HEAD on the trailing-slash policy path returned 200 with the gate marker present.

### B14 — URL-encoded bodies bypassed the 16 KB boundary

**Problem:** the tight parser covered JSON only; the existing global URL-encoded parser still accepted 1 MB before admission control.

**Correction:** rev 3.4 conditionally runs both `express.json({ limit:'16kb' })` and `express.urlencoded({ extended:true, limit:'16kb' })` above the existing global parsers.

**Evidence:** the corrected probe returned 413 for a 50 KB URL-encoded login body, while an uncovered 50 KB JSON route remained accepted under the existing 1 MB global policy.

### B15 — The watchdog released work it did not cancel

**Problem:** decrementing `inFlight` after 15 seconds did not stop the handler, query, or pool wait. Six new requests every 15 seconds equals 24 per minute, below the 600/minute ceiling; after roughly 150 seconds, 10 active plus 50 queued pool slots could all be occupied.

**Correction:** the watchdog is observational only. It logs a warning but never releases a lease. Only patched `res.end`, response close, or a synchronous downstream throw decrements the semaphore.

**Evidence:** with two deliberately unresolved requests and a 10 ms warning threshold, both warnings fired, a third request still received 429, and only ending an original response admitted the next request.

### B16 — Stream backpressure and missing browser proof

**Problem:** a normal-drain probe proved only that `res.end` eventually fires. A paused backpressured stream can prevent it from being called. `public_menu.json` is served through Express static/sendFile and was therefore capable of holding a concurrency lease. Separately, the plan treated missing Vue unit-DOM dependencies as proof that runtime UI testing was impossible, despite Playwright already being installed.

**Correction:** `public_menu.json` remains inside the single global rate budget but takes no dynamic concurrency lease. Its cache-miss generation is already guarded by the `isGenerating` single-flight flag in `backend/config/menuCache.js`. Dynamic API routes retain the truthful six-request semaphore. The plan also creates a focused `admin.login-boundary.spec.js`, automatically collected by the existing `admin-tests` Playwright project, for the busy and HTTPS-refusal flows.

**Evidence:** the corrected gate probe admitted a rate-counted menu stream and a dynamic request simultaneously. `npx playwright test tests/e2e/specs/admin.dashboard.spec.js --project=admin-tests --list` discovered the setup and admin tests, proving the chosen `admin.*` filename is collected without a dependency or configuration change.

### Specification contradiction — P2 wording

**Problem:** P2 prohibited every hidden state difference while the deliberate real-ceremony/stateless-decoy design necessarily persists challenge/replay state only for a real eligible candidate.

**Correction:** P2 now governs abuse-control keys and delay/limit state. The public response remains uniform; timing remains explicitly outside the guarantee. This preserves the security property without pretending the protocol has identical internal work.

## Probe result

The final standalone probes were read-only, opened no database connection, bound no persistent port, and used only installed dependencies.

```json
{
  "parser_and_alias_cases": [
    { "name": "json /api/auth/login", "status": 413 },
    { "name": "json /api/auth/login/", "status": 413 },
    { "name": "json /API/AUTH/LOGIN", "status": 413 },
    { "name": "form canonical", "status": 413 },
    { "name": "uncovered json", "status": 200 },
    { "name": "HEAD GET alias", "status": 200, "gate": "hit" }
  ],
  "watchdog": {
    "warnings": 2,
    "blockedStatus": 429,
    "admittedAfterEnd": true
  },
  "streamed_menu": {
    "menuAndDynamicAdmitted": true,
    "thirdRequestStatusAfterSharedRateBudget": 429
  }
}
```

## Final plan changes

- Revision advanced from 3.3 to 3.4.
- Added defect records B13–B16 so later implementers do not recreate the failures.
- Replaced the exact predicate with normalized Express-compatible matching.
- Added the tight URL-encoded parser beside the tight JSON parser.
- Replaced the timeout-release lease with a truthful semaphore plus warning-only watchdog.
- Made `public_menu.json` rate-only while keeping every dynamic pre-auth route under concurrency control.
- Corrected unit tests to call patched `res.end()` rather than emitting an unused `finish` event.
- Added explicit hostile tests for aliases, HEAD, both body types, incomplete bodies, stream backpressure, and watchdog under-counting.
- Added focused Playwright runtime proof using the existing dependency and collected project pattern.
- Pinned the Task 3 and Task 5 middleware export sets so each intermediate commit boots with exactly the consumers present at that stage.
- Narrowed P2 and the stated oracle guarantee to abuse-control state.
- Updated the architecture-map instructions, adversarial gate, final verification commands, and known limitations to match the corrected mechanism.

## Closure decision

No unresolved document-level blocker remains in the reviewed scope. The plan is internally executable and its newest Task 5 mechanisms were checked against hostile route aliases, alternate accepted content types, slow streams, timeout interleavings, and the actual test-runner configuration.

The remaining uncertainty is implementation-shaped: the real code and tests do not exist yet. The next valid review point is after RED/GREEN execution of the plan, not another speculative rewrite of the document.
