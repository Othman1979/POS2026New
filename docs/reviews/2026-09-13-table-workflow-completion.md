# Table workflow completion

The accepted table-workflow plan is complete on `codex/tables-workflow-hardening`. The remaining tasks were implemented and verified serially in the same conversation, with local task-sized commits. There was no push, PR, merge or deployment.

## Audit fixes

| Item | Completed behavior | Evidence |
| --- | --- | --- |
| F1 | Refuse bill combinations that would lose or expand an order-wide discount | [Discount protection](2026-09-13-tables-f1-discount-merge.md) |
| F2 | Preserve saved tax/price contexts when combining bills | [Saved tax](2026-09-13-tables-f2-saved-tax-merge.md) |
| F3 | Refuse saves from an older bill revision | [Save revisions](2026-09-13-tables-f3-save-revision.md) |
| F4 | Bind table moves to reviewed bill/group identities; recover committed retries once | [Action recovery](2026-09-13-tables-f4-action-recovery.md) |
| F5 | Enforce section and QR-draft access consistently | [Access](2026-09-13-tables-f5-access.md) |
| F6 | Bound paid-split parent lookups with the focused index | [Paid split index](2026-09-13-tables-f6-paid-split-index.md) |
| F7 | Derive floor split counts from scoped table snapshots and coalesce reads | [Floor counts](2026-09-13-tables-f7-floor-counts.md) |
| F8 | Reuse locked merge rows and batch saved tax stamps | [Merge resources](2026-09-13-tables-f8-merge-resources.md) |
| F9 | Open split bills directly using server identity | [Direct split navigation](2026-09-13-tables-f9-direct-splits.md) |
| F10 | Correct Arabic join feedback | [Arabic warning](2026-09-13-tables-f10-arabic-join-warning.md) |

## Requested features and discovered follow-ups

- [Independent seating](2026-09-13-independent-table-seating.md): join busy/free tables while keeping their bills separate; exclude printed bills. Migration preserves issued legacy shared bills. Physical seating survives independent split/settlement.
- [Item and quantity transfer](2026-09-13-table-item-transfer.md): move selected whole/fractional quantities to empty or busy tables; preview both totals; Select all items can combine compatible bills. Saved line, recipe, stock and service-charge ownership survive, with durable retry recovery.
- [Simpler split controls](2026-09-13-split-quantity-controls.md): reuse quantity selection in both directions, retain advanced fractions behind a disclosure, bound initial rendering and allow unpaid items to consolidate onto the Remaining Check after another check is paid.
- [Confirmed-save recovery](2026-09-13-table-save-refresh-recovery.md): preserve the acknowledged draft if its metadata refresh fails or newer edits arrive.
- [POS seating controls](2026-09-13-pos-seating-controls.md): use the seating relation for Join/Disjoin, apply printed-seat eligibility and preserve unsaved POS edits while separating seating.

Each linked report records its focused regressions, adversarial/end-to-end cases and applicable resource measurements. English/Arabic desktop/mobile flows exercised actual built UI, HTTP and isolated MySQL, including reload, save, splitting, payment, stock/recipe conservation, stale actions and lost responses. Generated fixture cleanup was checked after each completed task. These are local verification results, not production performance measurements.

Kitchen relocation notices and explicit waiter handoff were optional ideas in the original audit, outside the accepted three-stage implementation. Moving items does not re-fire the food. Deployment packaging and deployment were not requested; the seating migration is committed source for the later deployment workflow.
