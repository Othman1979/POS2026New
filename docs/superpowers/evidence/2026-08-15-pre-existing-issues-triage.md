# Pre-existing issues triage — how real are they?

**Date:** 2026-08-15
**Repo state:** `master` @ `74cd4492` (proxy-free rate-limiting work merged, not pushed)
**Method:** read-only inspection plus targeted test runs. No source changed.

Four items were carried out of the rate-limiting review as "pre-existing, not this branch's fault". This is the evidence on each. **One of the four was my error and is withdrawn.**

| # | claim | verdict |
| --- | --- | --- |
| 1 | 26 pre-existing test failures | **Real** — four distinct causes, one worth prioritising, one a false positive |
| 2 | The new e2e spec never runs | **Wrong — withdrawn.** It is correctly wired to Playwright |
| 3 | `setup.js` does not reset module state | **The comment is stale; the claimed cross-file contamination is withdrawn.** |
| 4 | Pool has no acquire timeout | **Real, and worse than a config oversight** |

---

## 1. The 26 failures — real, four distinct causes

### 1a. `printGoldens.test.js` — 22 failures. Stale fixtures, deliberate renderer change.

`2eb23cfa` ("fix: prevent fractional kitchen quantity overlap", 2026-08-11) introduced `.kitchen-item-qty` / `.kitchen-item-name` classes in `pos-spooler-printer/renderDocument.js`, replacing inline `style="width: 75px…"` markup. The golden fixtures were last frozen at `d591e915` (2026-08-10). Verified `d591e915` is an ancestor of `2eb23cfa` — the goldens predate the renderer change and no golden contains the new class names.

So the renderer change was intentional and the fixtures were never regenerated. **Low product risk, real maintenance cost:** 22 permanently-red tests whose entire purpose is to freeze print output, so any *future* print regression now lands in an already-failing file and gets missed.

All 22 predate `2eb23cfa`, and the split between them is worth knowing before regenerating: **receipt** snapshots differ only because the shared document `<style>` block gained the two kitchen classes, while **kitchen** snapshots differ by that *and* by the intended class-based markup replacing inline widths. Nothing else moved.

Fix: review the generated diff once to confirm the new markup is what is wanted, then regenerate all 22 together.

### 1b. `taxExemptWorkflow.test.js` — 1 failure. **Resolved: stale fixture, not a defect. The guard is correct and must stay.**

```
expect(checkout.statusCode).toBe(200)   →   received 409
message: "Service charge changed. Refresh the cart and try again."
```

Confirmed not test pollution — it fails identically in isolation. I originally flagged this as the one item that might be a live customer-facing bug, because the evidence I had could not separate "stale fixture" from "exempt carts genuinely miscompute the service charge". Cross-review separated it, and the separation is verified here:

- The fixture submits `{ id: 'FEE_1', qty: 1, price: 1.74, … }` (`taxExemptWorkflow.test.js:80`) — a fee expressed under the **former tax-inclusive** accounting model.
- `a8a49c82` (2026-08-11, "fix(tax): keep receipt preference out of sale accounting") deliberately moved new sales to net-plus-tax. The server states and enforces it: *"New register sales always use normal net-plus-tax accounting. The setting is only a customer-copy presentation preference."* → `let accountingTaxInclusive = false;` (`executeCheckout.js:791-793`).
- Under current rules the canonical exempt service charge is **2.02**, and the arithmetic is self-consistent both ways: 10% of the 20.15 line is 2.015 → 2.02 net, and 2.02 gross ÷ 1.16 VAT = 1.74 — exactly the stale inclusive-model figure the fixture still sends.
- Direct calculator evidence: `2.02` accepted, `1.74` rejected with precisely the observed 409. The focused client-store test asserting the same accounting rule passes.

So exempt customers **can** check out with a service charge; the guard rejects only the outdated value. Fix is fixture-side, and must move together: submitted fee, totals, persisted prices, audit values, and the downstream receipt/JoFotara expectations.

### 1c. `platformRemittanceRoutes.test.js` — 1 failure. Low severity, protection intact.

```
expected 'ORDER_TYPE_HAS_HISTORY' to be 'PLATFORM_ORDER_TYPE_HAS_HISTORY'
```

`PLATFORM_ORDER_TYPE_HAS_HISTORY` **exists nowhere in the source.** The guard at `backend/routes/admin/printers.js:44-63` runs a single query testing `EXISTS(… FROM orders …)` **and** `EXISTS(… FROM platform_remittances …)`, and blocks deletion with 409 plus the generic `ORDER_TYPE_HAS_HISTORY` when either is true.

So the test's actual intent — "blocks deleting a type with platform history but preserves ordinary deletion" — **is satisfied by the code**. Only the expected code string is fictional. Cosmetic unless something downstream branches on that exact value; nothing does.

### 1d. `orderSessionBoundaries.test.js` — 1 failure. The guard worked; nobody answered it.

The tables facade key set grew from 48 to 51. The three additions — `editSplitGroup`, `moveAllItemToSeat`, `splitEditContext` — are intentional split APIs and are actively consumed by the split UI, so they are genuine public surface rather than accidental leakage. This test exists to force a review whenever the boundary grows; it did its job and nobody answered. Update the frozen expectation from 48 to 51.

### 1e. `frontendRuntimePaths.test.js` — 1 failure. **False positive in the test.**

The rule at `:81` asserts no component imports `pos/stores/orderSession/`. The failing "file" is `src/components/pos/__tests__/callCenterWorkflow.spec.js` — the received content begins `import { describe, expect, it } from 'vitest'`. That spec imports those modules *in order to test them*, which is legitimate.

The collector walks directories with `readdirSync` (`:34-36`) without excluding `__tests__`. **The architectural boundary is not actually violated.** Fix the collector, not the code.

---

## 2. "The new e2e spec never runs" — WRONG, withdrawn

I claimed `tests/e2e/specs/admin.login-boundary.spec.js` never executes, reasoning from `vitest.config.mjs` include patterns alone.

`playwright.config.mjs` sets `testDir: './tests/e2e'` and defines an **`admin-tests` project** at `:42-43` with `testMatch: /specs\/admin\..*\.spec\.js/`. That matches `admin.login-boundary.spec.js` exactly. The spec is correctly placed and correctly wired.

It does not run under `npx vitest run` because e2e specs belong to Playwright — that is the intended separation, not a gap. `npm run test:e2e` runs `playwright test`.

**Root cause of my error:** I read one config and asserted a conclusion that required reading two. Same premise-checking failure as the earlier `.php` recommendation — the finding was about something absent, and I did not check every place it could have been present.

---

## 3. `setup.js` does not reset module state — stale comment, contamination claim withdrawn

`backend/tests/setup.js` resets only the Socket.IO mocks. Its old header incorrectly claimed ownership of module-scope Maps and Sets.

Vitest 4 defaults to isolated test-file environments. Sequential scheduling through `fileParallelism: false` and `maxWorkers: 1` does not disable that isolation. F7 accumulated inside `checkout.test.js` itself because that file sends hundreds of requests as one actor; the existing test-only checkout-limit override closes that case.

No module reset API is needed without a reproducible same-file contamination defect. The correct change is documentation-only: make the setup comments describe the Socket.IO mock lifecycle and leave Vitest's isolation behavior untouched.

---

## 4. No pool acquire timeout — real, and not merely a config oversight

`backend/config/databasePoolOptions.js` sets `waitForConnections: true`, `connectionLimit: 10`, `queueLimit: 50`, `connectTimeout: 10000`.

`connectTimeout` bounds the **TCP handshake**, not the wait for a free pooled connection. And mysql2 **3.20.0 provides no pool acquire timeout at all** — `acquireTimeout` appears in neither its pool implementation nor its typings; it was a `mysql` v1 option that mysql2 never carried forward.

Behaviour that follows:

- requests 1–10 get connections;
- requests 11–60 queue and wait **indefinitely** — there is no configuration that bounds this;
- request 61+ fails immediately once `queueLimit` is reached.

So a handler starved of a connection hangs until its client gives up. Bounding it requires **application-level code** — wrapping `pool.getConnection()` in a timeout — not a config change. That is why this could not simply be "set an acquire timeout" in the rate-limiting work.

This is also the substance behind the gate-watchdog discussion: the gate correctly refuses to release a lease for work it cannot cancel, and the work it cannot cancel is precisely an unbounded `getConnection()` wait. Fixing this at the pool would remove the underlying hazard rather than papering over it in the gate.

---

## Suggested order

**No product defect remains in this list.** All 26 failures are stale test expectations or a test-scope bug; every guard they trip is behaving correctly. That materially lowers the urgency of the whole set — the only item with real production consequence is the pool timeout.

1. **Pool acquire timeout** — the one genuine availability limitation. Needs application-level work because mysql2 offers no config for it, and it underpins the gate's uncancellable-work case.
2. **`printGoldens` regeneration** (22) — biggest block of red, and it currently masks future print regressions. Review the diff once, regenerate together.
3. **`taxExemptWorkflow` fixture** — update the submitted fee to 2.02 along with totals, persisted prices, audit values and the downstream receipt/JoFotara expectations, as one change.
4. **`frontendRuntimePaths` collector** (exclude `__tests__`) and **`orderSessionBoundaries`** (48 → 51) — small test-hygiene fixes.
5. **`platformRemittanceRoutes`** — align the expected code with the generic `ORDER_TYPE_HAS_HISTORY`, or implement the platform-specific one if the distinction is actually wanted.
6. **`setup.js`** — correct the stale comment only; no module-reset machinery is justified.
