# Settings notice and realtime recovery after connection drops (2026-09-26)

A customer's POS showed "تعذّر تحديث الإعدادات. يتم استخدام آخر إعدادات تم تحميلها" (Settings could not be refreshed. Using the last loaded settings) and kept it. The notice is not a guard rejection: `GET /api/system/settings` has no rate limit or subscription check. It appears after any failed read (network drop, server restart answering 503 STARTING, a database error, the 15-second deadline). Diagnosis in this pass found that the notice was only the visible part of weaker recovery.

## Defects found (each reproduced by a test that failed on the old code)

| Defect | Evidence | Effect |
| --- | --- | --- |
| A failed settings read was never retried; the reconnect handler joined the failing read and the focus handler ran only while the socket was down | Old production build: the notice stayed 12 s after the server recovered (browser check) | Notice stays until someone presses Retry |
| socket.io does not retry a connection the server refuses | Real socket.io 4.8.3: after one "Server is starting." refusal, one attempt in 3 s, `socket.active` false. Old build: no reconnect within 20 s after a restart that refused two handshakes | Every terminal that reconnects during a restart loses realtime updates until a reload |
| `verifyToken` returned "no user" when the database failed | HTTP answered 401 `SESSION_INVALID`, socket refused "Unauthorized:" (integration test) | A database blip logs cashiers out |
| The socket middleware awaited `findActiveSession` unguarded | Handshake hung; the rejection was unhandled (integration test) | In production the crash handler shuts the server down, which then refuses reconnects during startup |

## Fixes

| Commit | Change |
| --- | --- |
| `7fa54582` | A failed session check throws `SessionCheckUnavailableError`: HTTP 503 `SESSION_CHECK_UNAVAILABLE` with `Retry-After`, socket refusal "Service unavailable."; invalid sessions still get 401/"Unauthorized:" |
| `4f427ce8` | The POS socket reconnects after a refusal other than "Unauthorized:" (1, 2, 4 ... 30 s plus up to 1 s jitter) |
| `32e704db` | Failed settings reads get quick retries; reconnect forces a fresh read; the refresh notice shows only if the automatic retry fails too (a failed first load still shows at once) |
| `7114b32c` | The admin realtime bridge and the customer QR menu reconnect after a refusal too, through one shared helper (`src/shared/socketRefusalRetry.js`); a database error during the QR table check answers "Service unavailable." instead of "Unauthorized: Verification failed." |
| `1899f61d` | No clock after the three quick retries (2, 5, 10 s): recovery follows the server's socket heartbeat (every 25 s, already sent), a reconnect, a settings change, focus or Retry, each a no-op while settings are fine |

## Verification

- Backend `sessionCheckAvailability` (new), auth, socket, table-access and device-proof suites; updated unit tests for the new failure contract. Mutation checks: reverting either server change fails the new tests.
- Frontend `useTerminalSettings`, `useSocketRefusalRecovery` (new), `posTerminalOwnership`, full frontend suite. Mutations removing the retry, the notice delay or the reconnect fail them.
- `node scripts/reviews/settings-recovery-browser.cjs` on the production build, English desktop and Arabic mobile (fixture heartbeat 2 s): a healthy terminal sends 0 settings reads across 5 heartbeats; a recovered blip is never shown (retry after about 2 s); a short outage notice appears after about 2.4 s and clears about 5 s after recovery without Retry; a long outage gets quick retries at 2/5/10 s and then recovers on the next heartbeat (about 0.8 s after the server returned; without the heartbeat hook it stays failed); a 503 session check keeps the cashier signed in on /pos; a restart refusing two handshakes reconnects in 4.5-5.7 s and delivers the next realtime event. The blip, outage and restart scenarios fail on the old build.

Limits: loopback fixtures, not a customer network or the Hostinger edge. While settings keep failing and the socket is connected (for example the database is down), each terminal reads once per 25 s heartbeat until one succeeds; a healthy terminal sends none. Checkout still never retries automatically.
