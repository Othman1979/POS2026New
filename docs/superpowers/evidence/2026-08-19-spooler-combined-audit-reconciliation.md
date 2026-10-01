# Combined printing-system audit — reconciliation of the two 2026-08-19 reviews

Sources:
- **A (defect audit):** `docs/superpowers/evidence/2026-08-19-spooler-stack-failure-audit.md` — four-domain adversarial failure audit, every claim re-verified against source. Overall 6/10.
- **B (discussion brief):** `docs/2026-08-19-printing-system-discussion-audit.md` (Grok) — product/topology/security discussion brief with S1–S10 straw-man decisions. Overall 7.8/10.

They audited different layers and combine cleanly: A = "what breaks in the machinery", B = "what the product/ops posture should be". The score gap is scope, not disagreement — B rates the architecture as designed; A rates what happens when machines die, and docks for self-healing/visibility gaps B did not probe.

## Corrections to B (both re-verified by grep before recording)

1. **B's evidence index cites "lease 120s" (`spoolerSync.js`) as a live control. It is dead code.** `locked_until` is written on claim (spoolerSync.js:228) and cleared on settle, but no query anywhere reads it. There is no lease expiry. (A, CRIT-3.)
2. **B's stack table says a dead agent's in-flight rows "become dead_letter." Only manually.** That happens solely via admin force-replace (`spoolerAgents.js:189-195`); nothing automatic transitions them. A dead station's `sent` rows strand until a human intervenes. (A, CRIT-3.)
3. Minor: B says "server clamps claim capacity to 50 = backpressure." True server-side, but the agent never enforces its own advertised capacity (`agent-runtime.js:98-125` accepts everything) — backpressure holds only while the server is honest. (A, MEDIUM.)

## Verified additions from B that A missed (spot-checked 2026-08-19)

- **`print_method` defaults to `'browser'`** (backend/routes/system.js:59). Register-checkout kitchen dispatch fires only when `printMethod === 'backend'` and is un-awaited fire-and-forget (src/pos/stores/orderSessionStore.js:2293-2295). Until the setting is flipped, the audited stack is unused for walk-in register orders and grill tickets silently do not print.
- ~~Unrouted kitchen items silently dropped on the register path~~ **OWNER RULING 2026-08-19: not a defect.** An unrouted category means receipt-only by design (drinks etc.) — the register's silent skip is the intended behavior on every path. Grok's S3 was backwards. The real bug is the inverse: the held/table path 422s the whole kitchen confirm when ANY item is unrouted (`HELD_KITCHEN_UNROUTED_ITEMS`, HeldOrderKitchenDispatch.js:329-331 and :372-374; full unfiltered cart passed at backend/routes/pos/orders.js:1118), so fried chicken + unrouted drink on a table order blocks instead of printing the chicken ticket. Fix direction: exclude unrouted items from held kitchen dispatch/snapshot lines (they are receipt-only), fail only on integrity errors. Architecture defect `d-unrouted-kitchen-items-silent` should be reclassified as intended behavior in the same change. Charging and the customer receipt were never affected on any path.
- **`GET /api/admin/printers` is open to any authenticated non-call-center user** (backend/routes/admin.js:10-22, deliberate documented exception) and exposes printer network IPs to cashiers.
- Receipt-printer choice is `localStorage` only (`pos_receipt_printer_id`), not bound to session or registered browser — a habit, not a server fact.
- Shared site-wide `SPOOLER_KEY` bootstrap secret; plain `http://` accepted for sync (`x-agent-token` replayable on open Wi-Fi).
- One serial Chromium page: a tall Z-report can hold kitchen tickets for up to the 30s render timeout during a rush.
- Long-report raster mitigation is code-complete but never physically verified on the affected printer.
- Topology reality: Wi-Fi TCP:9100 printers are the actual Saturday-night failure mode no protocol fixes.

## Merged priority list (supersedes both docs' individual orderings)

**P0 — the system must actually be on and honest (B's Block 1 + A's cheapest CRITs):**
1. Flip `print_method` to `backend` as the supported mode / new-install default (B S1) and fire kitchen from register checkout regardless of receipt method (B S2). Every other score is fiction until this is decided.
2. Held/table kitchen dispatch must skip unrouted (receipt-only) items instead of 422-blocking the whole order (owner ruling above; replaces B S3, which recommended the opposite). Reclassify `d-unrouted-kitchen-items-silent` as intended behavior.
3. Agent crash-loop guard: catch store-write failures in the print path; add `unhandledRejection` backstop (A CRIT-1 — one guard, hottest path).
4. Swap the two mis-ordered lines in `Update-Spooler.ps1:401-403` (journal before recovery scripts) (A CRIT-4 — two-line fix).
5. Drain: honest confirm text + runbook recovery section (rotate `agent.json`) (A CRIT-5 — bit the owner live 2026-08-19).

**P1 — recovery machinery (A's domain):**
6. Lease reclaim or delete the lease: either read `locked_until` and reclaim pre-transport rows to `pending` (post-`sent` rows go to dead_letter, never auto-retry — preserves B S4's no-duplicate rule), or drop the column and stop implying a lease exists (A CRIT-3).
7. Winspool `completed` semantics: follow up the returned `windowsJobId` until the Windows queue drains, or record a non-terminal `spooled` confidence (A CRIT-2).
8. Retry cap + reclass: cap local `transient_safe` retries then dead-letter + badge (A HIGH, B 6.4-C); reclassify pre-write `WINSPOOL_OPEN_FAILED` as `transient_safe` (A HIGH).
9. Add per-retry jitter to the sync backoff (A HIGH, Imunify360 incident class).

**P2 — posture and polish (mostly B, needs owner/product decisions):**
10. Remote visibility: a station that has not synced in N minutes, or whose service is disabled by repair, must surface in the admin UI, not only in a local log / an open Settings tab (A HIGHs).
11. HTTPS required when the sync URL leaves the private LAN (B S9); hide printer IPs from the cashier GET (B 5.4-D).
12. Receipt-printer binding to registered browser — only after device login is enforced everywhere (B S7, YAGNI until then).
13. Pause/deprioritize report rendering while kitchen jobs are queued (B 4.4-B) — only if a real rush measurement shows starvation.
14. Physical short/long report test on the affected printer to close the raster defect (B S8); ban Wi-Fi TCP:9100 in the deployment standard (B S5).

**Agreed non-goals (both docs):** no Socket.IO revival, no auto-retry after transport started, no auto-reassign of uncertain jobs to another station, no second Chromium without a measurement.

## Combined score

**6.5/10 as deployed today** (B's 7.8 assumed the lease worked and did not probe the crash/updater/visibility failure modes; A's 6 did not credit the product-layer strengths B verified — routing, idempotency keys, sanitization, fail-closed held-order dispatch). P0 items 1–5 are one small round of work and lift it to ~8.

## Decision: stale-station visibility (2026-08-21)

CRIT-3 / P1-6 is closed by visibility, not mutation. A partitioned-but-alive agent may still hold or have already printed `sent`/`local_accepted` rows; server-side reclaim or delete reopens duplicate paper. `locked_until` stays dormant (written on claim, never read). The admin header now receives `stale_print_stations` when a station has queued work (`pending`/`sent`/`local_accepted`/`cancel_requested`) and no fresh active/draining agent. Empty-set transitions emit `{ stations: [] }` so the chip and warn-dot clear; staff connect emits the current set so a new session does not wait for the next transition. No `UPDATE` against `print_queue`.
