# Table Workflow Audit — Fix Plan Index (2026-07-04)

Source: deep read-only audit of the POS table workflow (floor plan → save → guest check → settle → void/refund → split → join/transfer/disjoin → QR/socket/stale-state). **31 findings** (1 P0, 4 P1, 9 P2, 17 P3) split into **7 TDD plans / 37 tasks**. 3 candidate findings were adversarially **refuted** and are NOT planned (section at bottom).

Each plan is self-contained (writing-plans format: Global Constraints → per-finding red→green TDD tasks with exact file:line, `npx vitest run` commands, and a commit). Execute with `superpowers:subagent-driven-development` (fresh subagent per task + review) or `superpowers:executing-plans`.

> **Nothing here is applied yet.** These are plans only; no source was modified by the audit or the planning pass.
>
> **2026-07-04 audit-policy update:** destructive POS mutations that require an audit row must insert that row with the same transaction connection immediately before `conn.commit()`. Do not use background `pool.query(...).catch(...)` audit logging for void/refund/merge/disjoin/delete operations. If an audit insert fails, the business mutation must roll back too.

---

## Recommended global execution order

Land in this order — later plans edit files earlier plans already touched (see the shared-file matrix). Re-run the affected suites after each plan.

| # | Plan file | Tasks | Findings | Land note |
|---|---|---|---|---|
| 1 | `2026-07-04-table-workflow-1-critical-void-settle.md` | 5 | **P0-1**, P1-3 | **FIRST** — highest severity, smallest diff |
| 2 | `2026-07-04-table-workflow-2-bundle-integrity.md` | 5 | P1-1, P1-2, P3-1 | after 1 (Task 5 overlaps Plan 1 audit region) |
| 3 | `2026-07-04-table-workflow-3-structural-ops.md` | 4 | P1-4, P2-4, P2-5, P3-12 | independent (tables.js structural routes only) |
| 4 | `2026-07-04-table-workflow-4-splits.md` | 6 | P2-3, P3-7, P3-8, P3-9, P3-10 | after 1 (P3-7 depends on P0-1 `!isSplitSettle`) |
| 5 | `2026-07-04-table-workflow-5-refunds.md` | 4 | P2-6, P2-2, P3-3, P3-4 | before/with 6 (both edit refunds.js, disjoint regions) |
| 6 | `2026-07-04-table-workflow-6-void-permissions.md` | 4 | P2-1, P3-2, P3-11, P3-16 | after 5 (adds refunds.js void gate; updates refunds.test.js:78) |
| 7 | `2026-07-04-table-workflow-7-hardening-cleanup.md` | 9 | P2-7, P2-8, P2-9, P3-5, P3-6, P3-13, P3-14, P3-15, P3-17, +dead-branch | **LAST** — P3-6 must sequence after Plan 2 (same `existingItemsForPrint` query) |

**Total: 37 tasks.**

---

## Finding → plan map (coverage check)

| ID | Sev | Finding | Plan |
|---|---|---|---|
| P0-1 | P0 | Split-check settle voids a re-seated table's live order (`checkout.js:624`) | 1 |
| P1-1 | P1 | Printed-lock loop counts bundle child rows → blocks bundle-table edits (`tables.js:1231`) | 2 |
| P1-2 | P1 | Bundle member stock inflates (restore counts children, deduct doesn't) — 5 sites | 2 |
| P1-3 | P1 | Void `audit_events` written before commit → phantom rows on rollback (4 sites) | 1 |
| P1-4 | P1 | Transfer orphans joined children (ghost occupied tables) (`tables.js:290`) | 3 |
| P2-1 | P2 | Empty-cart whole-order void needs only `void_item`, bypasses `void_printed` (`tables.js:975`) | 6 |
| P2-2 | P2 | Over-refund cap under-records void subtotal on 2nd+ partial void (`refunds.js:179`) | 5 |
| P2-3 | P2 | Order-level discount dropped when a bill is split (guests overcharged) | 4 |
| P2-4 | P2 | Disjoin frees any table id → orphans open order (`tables.js:557`) | 3 |
| P2-5 | P2 | Merge hard-DELETEs an order with no `audit_events` (`tables.js:418`) | 3 |
| P2-6 | P2 | `refund_items.item_name` NULL for catalog products (`refunds.js:70`) | 5 |
| P2-7 | P2 | `table_order` doesn't validate Auto-Gratuity fee/tax (`tables.js:1113`) | 7 |
| P2-8 | P2 | `isProcessing` stuck true after every successful table save (`store:864`) | 7 |
| P2-9 | P2 | Blank `allowed_sections` = whole floor; `'0'` = none (`tables.js:136`) | 7 |
| P3-1 | P3 | Saved custom-item (product_id NULL) void bypasses gate + audit (`helpers.js:190`) | 2 |
| P3-2 | P3 | `/refunds` void of printed lines gated only by `pos.refund` (`refunds.js:14`) | 6 |
| P3-3 | P3 | Clamped refund header diverges from `refund_items` line rows (`refunds.js:181`) | 5 |
| P3-4 | P3 | `RefundModal` `isPaid=true` load path is dead code (`RefundModal.vue:158`) | 5 |
| P3-5 | P3 | Socket `table_update` blind-merges a new `current_order_id` (`PosTerminal.vue:1298`) | 7 |
| P3-6 | P3 | `existingItemsForPrint FOR UPDATE` LEFT JOIN locks products (`tables.js:1181`) | 7 |
| P3-7 | P3 | Split settle recharges live catalog prices (`checkout.js:381`) | 4 |
| P3-8 | P3 | Split guest-check prints `tax=0`/`total=subtotal` (`print.js:225`) | 4 |
| P3-9 | P3 | `DELETE /table_splits` discards a served-food check with no audit (`tables.js:1579`) | 4 |
| P3-10 | P3 | Split endpoint doesn't resolve child→parent table_id (`tables.js:1623`) | 4 |
| P3-11 | P3 | `clearCart` gates saved-clear on `void_printed` only (`store:1486`) | 6 |
| P3-12 | P3 | Merge leaves stale `parent_table_id` on released children (`tables.js:426`) | 3 |
| P3-13 | P3 | QR-draft dismiss not `tableSessionSeq`-guarded (`PosTerminal.vue:1237`) | 7 |
| P3-14 | P3 | Tax rollup trusts client `item.tax_rate` for NULL-tax products (`PosCalculator.js:91`) | 7 |
| P3-15 | P3 | FE `checkHasVoids` is dead code after void-modal removal (`store:2087`) | 7 |
| P3-16 | P3 | Remove/reduce saved line doesn't gate on `edit_locked` (`store:1558`) | 6 |
| P3-17 | P3 | Floor-plan waiter badge shows last editor not owner (`tables.js:155/200`) | 7 |
| — | cleanup | Dead `'reason is required'` error-mapper branch (`tables.js:1520`) | 7 |

All 31 findings + cleanup assigned. None dropped.

---

## Shared-file matrix (sequence edits to these)

| File | Plans that edit it |
|---|---|
| `backend/routes/pos/tables.js` | 1, 2, 3, 6, 7 |
| `backend/routes/pos/checkout.js` | 1, 2, 4 |
| `backend/routes/pos/refunds.js` | 5, 6 |
| `backend/routes/pos/helpers.js` | 2 |
| `backend/routes/print.js` | 4 |
| `backend/services/PosCalculator.js` | 7 |
| `assets/js/composables/stores/orderSessionStore.js` | 4, 6, 7 |
| `assets/js/composables/useCart.js` | 7 |
| `src/components/pos/RefundModal.vue` | 5 |
| `src/components/TableSplits.vue` | 4 |
| `src/components/PosTerminal.vue` | 7 |

**Known cross-plan couplings flagged by the planning pass:**
- Plan 1 (audit-timing) and Plan 2 (P1-1 filter, P3-1 audit-build) edit the SAME `tables.js` void region (~1204–1283). Land 1, then 2.
- Plan 2 P3-6/P3-14 note: the `existingItemsForPrint` query (Plan 7 P3-6) is the same one Plan 2's P1-1 reads — Plan 7 P3-6 must land after Plan 2.
- Plan 4 P3-7 depends on Plan 1's `!isSplitSettle` guard on the checkout release block.
- Plan 5 and Plan 6 both edit `refunds.js` (disjoint: money region ~70–226 vs permission gate ~14–62). Plan 6 also updates `refunds.test.js:78` (a refund-only void now correctly 403s under the new gate).
- Plan 5 Task 2 → Task 3 edit the same over-refund cap block; Task 3's BEFORE reflects post-Task-2 state.
- Plan 4 Task 3 → Task 5 share a `splitHeldPayload` shape.

---

## Refuted (do NOT plan or "fix")

- `GET /table_order` has no section-scope check → **REFUTED.** Ownership is enforced (`tables.js:743`); `allowed_sections` is a floor-plan display filter, never an auth gate on any write path. Read matching the write model is consistent.
- Bundle-child sub-removal is unaudited → **REFUTED.** Child removals are durably logged to `bundle_modifications` (`bundleOrderItems.js:107-116`) and gated by `void_printed` via the printed-lock loop.
- Split settle with a custom/open item is falsely rejected → **REFUTED.** Table orders can never persist a custom line (`tables.js:1082-1102` induction), so the precondition is unreachable; the gate is correct (exempting splits would open a kitchen-bypass/price-forge hole).

---

## Verified-correct invariants (regression baselines — don't undo)

Guest check uses table-number identity (not order number); `order_id` (public sequence) deferred to checkout and minted once (`checkout.js:466-483`); table save keeps `orders.order_id` NULL; client subtotal is the server-revalidated anchor, tax/total overridden (`PosCalculator`); saved-row delete FE gate matches backend (`void_item`+`void_printed`); canonical teardown routes through `leaveTableSession` (seq-guarded); `void_reason` fully removed (audit is the source of truth); child-table release on void/checkout/split/disjoin present; destructive audit rows are transactional (`conn.query` before `conn.commit()`), never background writes after commit.
