# Service-Charge Merge/Void Snapshot Reconciliation — Design

**Date:** 2026-07-11
**Status:** Approved by owner
**Depends on:** Service-charge canonicalization (merged to master, 35c9937c)

## Problem

The canonicalization work deferred two lifecycle gaps, both verified on current master:

1. **Table merge breaks fee-bearing orders.** The merge item-copy matches rows on
   `product_id = ?`; fee lines have `product_id NULL`, which never matches in SQL, so a
   source `Auto-Gratuity` row always copies as a second row. Merging two fee-bearing
   tables leaves two fee lines (next save/settle fails 400 "Only one service-charge
   line"). Worse, merging a fee-bearing source into a fee-less target is a **hard
   dead-end**: the fee row lands on the target, the target has no
   `service_charge_snapshot_id`, and settle fails 400 "snapshot required" until an
   operator manually removes the fee. In every merge, `tables.js` deletes the source
   order row, stranding its bound snapshot in `open_order` forever.
2. **Void/table release strands snapshots.** An empty-cart table release does not delete
   the order; it sets `payment_method='voided'`. The bound snapshot stays `open_order`
   permanently. Voided orders intentionally retain their snapshot foreign key for audit,
   so the fix must transition the snapshot without making cleanup violate
   `fk_orders_service_charge_snapshot`.

Transfer (invoice survives), disjoin (no order deletion), and refund voids of paid
orders (`finalized` is terminal) need nothing.

## Owner policy decision

Service-charge percentage is effectively uniform across tables in practice. On merge:
**keep one fee — never doubled, never blocked.** When both orders carry a snapshot, the
target's survives and the source's fee/snapshot is dropped/abandoned. When rates differ
(rare: settings changed between the two first-adds), the surviving snapshot's frozen
rate wins silently.

Multi-snapshot ownership (preserving both frozen rates independently) was considered
and rejected: it requires a snapshot↔order join table and rewrites the one-fee-line
invariant through the calculator, store, settle, and split allocation — a large blast
radius for a rare operation with, per policy, identical rates anyway.

## Design

### Snapshot service (`backend/services/ServiceChargeSnapshotService.js`)

- Add `'open_order:abandoned'` to the `ALLOWED` transition set.
- Add `abandonOpenOrder(conn, { snapshotId, version, orderId })`: an ownership-aware
  CAS transition requiring `state='open_order'`, `holder_type='order'`, the exact
  `holder_id=orderId`, and the exact version. It sets `state='abandoned'`, clears the
  holder/token, and bumps the version. Generic `transition()` is not sufficient because
  it does not include the old holder in its SQL predicate.
- Add `rehomeOpenOrder(conn, { snapshotId, version, fromOrderId, toOrderId })`: a
  holder swap under version-CAS, state stays `open_order` — the sibling of
  `touchOpenOrder`. It requires `state='open_order'`, `holder_type='order'`,
  `holder_id=fromOrderId`, and the exact `version`; it sets `holder_id=toOrderId` and
  bumps `version`. `affectedRows !== 1` throws the standard 409 conflict.
- Make cleanup reference-aware: no eligible `draft`, `abandoned`, or idle `claimed`
  snapshot is deleted while `orders`, `held_orders`, or a child snapshot references it.
  Voided financial records retain their snapshot rows; abandoned drafts/claims and
  source snapshots from deleted merge orders remain reapable.

### Merge (`backend/routes/pos/tables.js`, inside the existing merge transaction)

Reject identical source/target table IDs before opening the transaction. All snapshot
work happens under the existing row locks, **before** the source order row is deleted.
Load both orders' `service_charge_snapshot_id` and lock both snapshots with
`getForUpdate` when present. Every loaded snapshot must be `open_order`, holder type
`order`, and owned by the invoice whose FK referenced it.

| Target bound | Source bound | Disposition |
|---|---|---|
| no  | no  | nothing |
| yes | no  | target snapshot survives |
| no  | yes | source snapshot re-homes to the target order (`rehomeOpenOrder` + set target's FK); its fee line follows the copy |
| yes | yes | target snapshot survives; source snapshot transitions `open_order → abandoned` |

When the target snapshot survives (target-only or both-bound), call `touchOpenOrder`
inside the merge transaction. This validates its holder and bumps its version so a
terminal holding the pre-merge cart/version cannot overwrite the merged order. A
source-only re-home already performs the equivalent version bump.

- **Fee-row copy:** a fee survives whenever either side had one, but never doubles.
  The item-copy loop skips a source `Auto-Gratuity` row only when the target already
  carries its own fee row. In the both-bound case where the target's fee was removed
  but the source still carries one, the source fee row copies and is then recomputed at
  the target's (surviving) rate. The degenerate case of a source fee row with **no**
  bound snapshot on either side (impossible after the rollout cutoff) is skipped rather
  than reproduce an unsettleable state.
- **Goods-row identity:** normal rows may quantity-merge only when every financially
  relevant persisted field matches: product ID (NULL-safe), item name, price, note,
  discount type, discount value, and tax rate. Otherwise insert a distinct row. This
  prevents a discounted source line from inheriting the target line's discount shape.
  The target order's existing order-level discount continues to win, matching current
  merge behavior; the source order-level discount is not imported.
- **Fee recompute:** after the copy, when a snapshot survives and a fee row exists,
  recompute the canonical fee over the merged goods at the surviving snapshot's frozen
  rate (`canonicalizeServiceCharge` semantics: single line, qty 1, exact rounded price,
  frozen tax rate) and fully restamp one deterministic fee row (`product_id NULL`,
  canonical name/note, quantity `1`, exact price/tax, null discount type, zero discount
  value) **before** `recomputeOrderTotals`. Remove any extra fee rows in the same
  transaction so the one-fee invariant is restored rather than left blocked. Merged
  totals are correct immediately; the next settle's exact-cent check passes with no
  reload-and-save dance. A surviving bound snapshot with no fee line is left bound
  (matches existing fee-removed table behavior; re-add reuses the frozen rate).
- **Audit:** the existing in-txn merge `audit_events` payload gains the snapshot
  disposition: `{ kept, rehomed, abandoned }` snapshot IDs (nulls omitted).

### Void / empty-cart release (`backend/routes/pos/tables.js`, voided-order path)

In the same transaction that sets `payment_method='voided'`, use `abandonOpenOrder` to
transition a bound `open_order` snapshot to `abandoned`. Keep the order FK: it is an
intentional audit link, and reference-aware cleanup must not delete that snapshot. The
split-remainder void needs nothing: a split parent's snapshot is already terminal
(`split_parent`) by the time that void runs.

## Error handling

- Re-home/abandon/touch use the standard snapshot 409 conflict on version/state/holder
  mismatch; a
  concurrent settle or save racing the merge rolls the merge back untouched (existing
  merge transaction semantics).
- The table-transfer catch forwards `error.publicCode`, so snapshot conflicts retain
  `SERVICE_CHARGE_SNAPSHOT_CONFLICT` instead of degrading to an untyped 409.
- No new client behavior is required: merged tables are reloaded through the existing
  table GET, which already returns the bound snapshot; the store's recompute watcher
  finds the fee already canonical.

## Testing

Integration (`tables.test.js` or `serviceChargeSnapshots.test.js`):

1. Merge matrix — all four disposition cases with exact fee cents, surviving snapshot
   ID/state/holder, and orphan-free assertions (`SELECT` the source snapshot: re-homed
   or `abandoned`, never `open_order` on a dead invoice).
2. Settle-after-merge for the source-only case — proves today's dead-end is gone
   (settle 200, snapshot `finalized`, fee exact).
3. Both-bound at differing rates (10% source, 12.5% target) — surviving fee uses the
   target's rate over the combined base, exactly.
4. Void/release of a fee-bearing table — snapshot `abandoned` in the same transaction;
   the order FK remains, later cleanup preserves it, and creating a new draft succeeds.
5. Same-table merge fails without changing the order, items, table, or snapshot.
6. A stale target cart/version fails after merge; a forced snapshot conflict rolls all
   copied items and snapshot transitions back.
7. Same-product lines with different discounts remain financially distinct and produce
   the exact combined fee.
8. Audit payload records kept/rehomed/abandoned IDs; all four disposition cases,
   including neither-bound, are covered.
9. Existing merge/bundle/table suites stay green.

Unit (`serviceChargeSnapshotService.test.js`): `rehomeOpenOrder` happy path, wrong
version, wrong holder; `abandonOpenOrder` happy path, wrong version, wrong holder;
reference-aware cleanup SQL; `open_order:abandoned` allowed; disallowed transitions
still rejected.

## Out of scope

- Multi-snapshot order ownership (rejected above).
- Any change to split, transfer, disjoin, refund, or paid-order flows.
- Backfill of snapshots already stranded before this ships (one-off SQL during the
  rollout window if desired; the reaper handles them once transitioned).
