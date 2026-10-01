# Ingredient operations: continuous stock

## Operating model

1. Add ingredients with their stock units and link them to product recipes. Establish the quantities physically on hand with a first count, including an explicit zero for an empty ingredient.
2. Record incoming deliveries in one form, covering up to 100 ingredients. Enter quantities in the displayed stock units; optional cost is per displayed unit. All entered rows save together or none save.
3. Existing recipe tracking records usage and reversals from linked sales when enabled. This change does not change refund/restocking policy or ordinary product inventory.
4. Record waste against the affected ingredient with its existing reason selection.
5. Count periodically or when investigating a discrepancy. Select the ingredients being counted, enter quantities (including zero for empty stock), and review the differences before saving. Unselected ingredients remain unchanged. The server compares against the latest balance and uses the physical count as the new balance. Stock carries across days without another opening entry.
6. Review shortages separately from count discrepancies. In history, enter the correct receipt/waste quantity and a reason in one form (zero cancels its effect). The server records a linked adjustment and retains the original entry. Later physical counts remain authoritative. Correct a mistaken count with a new physical count, preserving the original history.

## Implementation

- Replaced the pre-filled daily-opening modal with blank multi-ingredient delivery/count entry. The main table no longer promotes daily opening as a required operation.
- Added `POST /api/admin/ingredients/batch`, within the existing admin authorization boundary and transaction wrapper. It validates at most 100 unique active ingredients, locks them in ID order, validates the complete retry payload, and audits/emits once on success. Receipts use four service queries; counts additionally read each ingredient's current count and movement tail for reconciliation.
- An unconfirmed browser save preserves its key and locks quantities for a safe retry. Confirmed validation failures allow editing. Closing a draft requires a discard decision.
- The legacy opening service now retains count-comparison metadata on subsequent counts; its initial 100-ingredient query-budget test still passes.
- Filters form a compact group with labels above full-width fields. Less common filters expand below. Row receipt/count actions are visible; unit-based discrepancies remain visible even when no consumption exists to calculate a percentage.
- No schema migration, new dependency, deployment, or business-stock test mutations.

## Evidence

- Initial new workflow tests failed because the batch service did not exist; implementation made them pass.
- Full frontend suite: 544 tests / 90 files passed. Final focused batch/page/i18n run: 13 tests / 3 files passed. Production admin build and architecture checks passed.
- Isolated backend runs passed: service, admin API, refunds/voids, Phase 1 and Phase 3 regressions, new workflow and performance tests. Final workflow run: five tests passed, including atomic rollback, concurrent retry, changed retry payload rejection, carry-forward, explicit zero and legacy recount comparison. API coverage verifies cashier rejection and one audit event on replay.
- Actual in-app browser saves used a newly created disposable loopback database. Initial chicken count 10 kg plus a delivery of 2 kg yielded 12 kg. A subsequent count of 11 kg showed -1 kg; potatoes left blank stayed at 5 kg. Reversing the 5 kg potato receipt yielded 0 kg and retained the reason and original movement in history. The fixture was removed afterward.
- Inspected the Arabic live page and delivery form at desktop and 390 x 700. Filter labels and actions remain visible; long forms scroll while footer actions stay reachable. Live application stock was not changed by these checks.
- Final 1280 x 800 check: table and container both measured 968 px, with receipt, count and More controls fully visible on one row.

## Boundaries

These are software and disposable-fixture checks. They do not establish real kitchen portion accuracy or whether a particular restaurant's refund should physically return ingredients. Recipe linkage, recipe tracking configuration and actual staff measurements remain necessary for meaningful expected stock.

## Setup, recipes and corrections follow-up

- Ingredient setup asks for a name and one stock unit with concrete examples. Shortage reminder, cost per stock unit and pack details are optional disclosures. Unit changes convert existing quantities/costs; changing dimensions in a new draft explicitly clears incompatible optional values. Incomplete packaging and accidental draft dismissal are guarded.
- Recipes offer searchable ingredient selection and inline creation of a missing ingredient, preserving existing lines. Changing compatible units converts the quantity; a separate multi-portion preview does not alter the per-sold-portion recipe.
- History defaults to seven days with today/month/custom presets. Custom dates use equal grid columns. Entries label the resulting balance and identify corrected originals even when the correcting row is outside the current page. A correction form accepts the intended quantity plus reason, previews the delta, and reuses its request key after an unconfirmed response. Count entries lead directly to recording the current physical quantity.
- `POST /api/admin/ingredient-movements/:id/amend` retains the existing authorization, transaction, audit and post-commit event boundaries. It writes a linked delta rather than a replacement receipt: correcting an entry before a later count must not change that counted balance. Legacy cancellation remains supported. No schema or dependency changes.
- Verification: 552 frontend tests across 91 files passed, including new setup conversion/discard/pack checks, recipe conversion/inline-creation checks, and correction validation/uncertain-retry checks. Isolated backend checks passed 16 workflow/admin/performance tests and 25 service/report/reversal/Phase 3 regressions. Coverage includes preserved later counts, zero cancellation, immutable originals, one audit on replay, reason validation and cashier rejection.
- In-app browser saves used a freshly created disposable database: a recipe draft retained 150 g chicken while creating and adding oil, then saved both lines. A 5 kg receipt corrected to 3 kg produced a -2 kg linked adjustment; the original and reason remained visible. That fixture was removed. Live Arabic setup and correction forms were inspected at 390 x 700 without saving stock mutations; scrolling and footer actions remained usable. Automated checks and visual inspection do not replace observing actual staff use.

## Operation-first interface follow-up

- Default view now shows ingredient, expected stock and history. Four direct operations lead the page: receive delivery, count, record waste, and view shopping needs. The detailed ledger, discrepancy filters, editing, explanations and portions remain in the secondary movement-details view.
- Delivery/count forms begin with ingredient selection rather than every ingredient's inputs. Adding an ingredient focuses its quantity; selected rows stay visible when searching for another. Duplicates are prevented, rows can be removed, and every selected row needs an explicit quantity. Purchase costs and pack entry are optional disclosures.
- Count review displays the actual quantities and differences before submission; users can return to edit. Waste starts by selecting one ingredient and then entering quantity and reason.
- Verification: 15 focused frontend tests passed, including selection/removal, blank and zero counts, review-before-write, search preservation, and unchanged retry keys. Production build passed. In-app Arabic desktop and 390 x 700 checks covered default/detail views, aligned expanded filters, selection focusing, hidden costs, count review and draft discard, and waste selection. No stock writes were made during this UI follow-up; persistence continues to use the previously verified batch API.
