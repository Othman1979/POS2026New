# Held-order and checkout workflow audit — 2026-09-06

This follow-up reviewed the manager-PIN transaction path and the held-order server lifecycle on `codex/system-performance-audit`, starting from `f464a828`. The checkout fixes belong to the main audit; this note records the held changes, their reproductions, and the checkout branch coverage inspected alongside them. It does not claim every conceivable checkout permutation has been exercised.

## Corrected held-order behavior

`backend/routes/pos/orders.js` now preserves the held row's accounting mode, receipt mode, registration profile, exemption, context version, source marker, and original hold-request fingerprint when merging a save or follow-up. Customer details and cart edits still follow the existing permissions and claim/version rules. An absent server field stays absent rather than being introduced by the submitted cart.

Before this change, a cashier without `pos.tax_exempt` could create and claim a taxable hold, submit `tax_exempt_at_hold: true` through either continuation endpoint, then finalize an exempt platform sale. The same spread could replace the registration profile or tax-inclusive mode. Changing `_hold_request_fingerprint` also made the original creation request return a conflict instead of recovering its earlier result. These failures were reproduced through actual HTTP routes against an isolated local MySQL database.

Continuation calculations also use the hold's saved registration profile. Before the change, an income-tax hold edited after live settings changed to sales tax persisted 16% product rates under its saved income profile. Save, follow-up, and explicit kitchen-baseline confirmation share the corrected canonicalizer.

Saving a recalled hold with an unchanged service charge now compares snapshot IDs as strings. They are UUIDs; the previous numeric comparison turned both matching IDs into `NaN` and rejected the save. A route regression reproduced that 409, then verified save through platform settlement with the frozen fee. A different UUID still fails without changing the row, version, or claim.

The same UUID correction applies to phone-worker continuation, which can retain a previously authorized fee while editing customer details. Creation fingerprints now include the actual fee UUID, so another snapshot at the same version cannot masquerade as the same original hold request. Older active fee holds can still replay their previous fingerprint, but only after the incoming UUID independently matches the row's bound UUID. Replacing that UUID is rejected under both fingerprint formats; an absent snapshot remains absent.

Kitchen reduction/removal checks now use the entire durable sent baseline. Current active printer mappings decide which new preparation lines are eligible for dispatch; they cannot erase evidence of previously sent quantities. Before the change, disabling the original printer or removing its category mapping allowed both save and follow-up to remove/reduce sent work. Follow-up could even queue an unrelated new line while silently removing the old one. Four route regressions reproduced HTTP 200 for operations that now fail atomically with `HELD_KITCHEN_SENT_LINE_CONFLICT`. Two positive cases verify that unchanged sent lines can coexist with newly routed additions after routing changes.

## Checkout authorization review

The minimal connection-lifetime fix passes checkout's existing connection through the route adapter to `ManagerOverrideService.authorizeManagerOverride` and `PermissionService.getOverridableKeys`. The manager-candidate and permission-catalog SELECTs use that executor. Transactional callers use current locking reads so an earlier repeatable-read snapshot cannot revive disabled managers, revoked roles/PINs, or older override-catalog entries. Callers outside checkout retain the default pool behavior.

Independent PIN success/failure/lockout audits and opportunistic rehash updates remain fire-and-forget pool work. Awaiting them while checkout owns the only connection would restore the self-wait; moving failed-attempt auditing into the transaction would lose it on rollback. Existing fixed checkout, subscription-feature, tax-exemption, and service-charge authorization ordering was retained.

The review also found that Temporary Manager Access promised price overrides but a price-only checkout never rechecked its PIN. The main checkout patch now detects a real difference on an unfrozen product line, using the same catalog-plus-modifier calculation as price application, and verifies the PIN immediately before applying prices. Frozen lines and unused PINs retain their prior behavior. The price-override audit now carries the approving manager identity.

## Workflow and coverage map

The rows below identify the existing focused suites inspected; entries outside the held verification commands are a coverage map, not a claim that this sub-audit reran them.

| Workflow | Boundary challenged | Coverage inspected |
| --- | --- | --- |
| Fresh cash, card, split payment | Correct tender/change, real catalog prices, fixed permissions, atomic sale and stock | `backend/tests/integration/checkout.test.js`; `checkoutPerformanceContract.test.js` |
| Manager discount and price-only edit | Occupied one-connection pool, valid/invalid PIN, unused PIN, current credentials/catalog, durable failed-attempt audit, lockout | `backend/tests/integration/managerOverrideCheckout.test.js`; `permissions.test.js`; `security.test.js`; `auth.test.js`; `backend/tests/unit/orderPricing.test.js` |
| Lost checkout response and concurrent submits | One committed invoice, idempotency ownership, duplicate recovery after rollback/release, stable public numbers | `checkout.test.js`; `checkoutPostCommit.test.js`; `managerOverrideCheckout.test.js` |
| Register held orders | Single lease winner, stale version/token rejection, shared recall, catalog repricing, recoverable failed checkout, creation/save/release replay | `heldOrders.test.js`; claimed-hold cases in `checkout.test.js` |
| Held tax/accounting authority | Save/follow-up cannot forge exemption/profile/mode; original hold request still replays; authorized exemption and saved income profile survive continuation; service-charge UUID identity survives register/phone edits and binds new/legacy creation replay | `heldOrderAuthority.test.js` |
| Kitchen hold/fire/follow-up/cancel | Durable queue, positive delta only, stable sent-line identity, cancellation from stored baseline, route changes cannot erase sent quantities | `heldOrders.test.js`; `heldOrders.fireKitchen.test.js`; `heldOrders.autoFire.test.js`; `heldOrderAuthority.test.js`; `backend/tests/unit/heldOrderKitchenDispatch.test.js` |
| Bundled held orders | Child expansion, stable preparation identity, current/frozen bundle integrity, positive quantity deltas | `bundle.heldOrders.fire.test.js`; bundle cases in `heldOrders.test.js` and `platformHeldSettlement.test.js` |
| Platform settlement | Both permissions, own open shift, provider identity/configuration, phone-source exclusion, frozen money/service charge/bundles, concurrent one-invoice result, stock rollback; unfired holds are supported | `platformHeldSettlement.test.js`; `heldOrderAuthority.test.js` |
| Table and split settlement | Locked saved rows, parent/table provenance, frozen allocation/discounts, stale cents/line swaps, joined tables | Table audit owns this verification; related cases in `checkout.test.js` and table integration suites |
| Subscription purchase and collection | Cash/card/split ledger, receivable authorization, single activation on retry, immutable buyer terms, ordinary checkout cannot sell hidden plan products | `subscriptionPurchase.test.js`; `subscriptionRedemptions.test.js`; `subscriptionCollections.test.js` |
| Refund and unpaid void | Intent/permission separation, stored money/quantity authority, no over-refund, atomic stock/audit, split-cent preservation, committed result survives notification failure | `refunds.test.js`; `reportsRefunds.test.js`; paid-refund notification regression in `posActionLifetime.test.js` |

Held cancellation currently deletes the held row; a response-loss retry receives not-found rather than a stored cancellation replay. The deletion prevents a second cancellation print, and the list can establish that the hold is gone. This audit did not redesign that API's recovery response.

## Verification

New focused regression command:

```powershell
node scripts/test-isolated.cjs backend/tests/integration/heldOrderAuthority.test.js --reporter=verbose
```

Result on the final held patch: **24 passed**. The tax/metadata/profile tests were first observed failing before the correction, and the four routing-change reductions/removals separately failed before the kitchen correction. Matching service-charge UUID saves failed before the register/phone string-comparison fixes; changed UUIDs were incorrectly accepted under the prior creation fingerprint. The final run also verifies same-UUID legacy replay, different-UUID rejection, missing snapshot behavior, and valid new kitchen additions.

Existing related regression command:

```powershell
node scripts/test-isolated.cjs backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/heldOrders.autoFire.test.js backend/tests/integration/bundle.heldOrders.fire.test.js backend/tests/integration/platformHeldSettlement.test.js backend/tests/unit/heldOrderLifecycleService.test.js backend/tests/unit/heldOrderKitchenDispatch.test.js --reporter=dot
```

Result after the tax and kitchen fixes: **7 files, 116 passed**. The final UUID identity and replay corrections received the subsequent focused 24-case run above. Together, this held verification covered **140 passing cases**. `git diff --check` also passed.

The runner creates a fresh allowlisted local fixture database and removes only the database it created. No production database, installed printer, environment file, or deployment was changed. Queue assertions verify durable job creation and baseline protection, not physical paper output or printer capacity. The changes keep existing routes, response shapes, schema, and service boundaries.
