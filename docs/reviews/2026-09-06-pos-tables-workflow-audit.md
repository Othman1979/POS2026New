# POS and tables workflow audit follow-up — 2026-09-06

This follow-up traces the POS and table workflows beyond the representative paths in the [first performance pass](2026-09-06-system-performance-audit.md). The evidence below distinguishes source review, executable regressions and actual browser work. It does not claim that every possible input, timing, device or deployment has been tested.

## Corrections

| Workflow | Reproduced failure | Correction |
| --- | --- | --- |
| Manager PIN during checkout | The transaction held the only pool connection while PIN/capability reads waited for another; the real request exceeded its three-second deadline. | Pass the checkout connection through the existing authorization callback. Use current locking reads for credentials and the overridable catalog; preserve authorization order, independent failure audits, rehash behavior and lockout. |
| PIN-authorized unit price | A price-only edit with a valid manager PIN failed with a subtotal mismatch; the PIN was checked only for other actions such as discounts. | Detect actual unfrozen price changes using the canonical catalog/modifier calculation and authorize immediately before pricing. Preserve frozen prices and fixed permission walls; record the manager on the price audit. This is an API regression, not a claim about a currently visible unit-price editor. |
| Availability and drawer expenses | Both actions committed but kept their connection while menu generation or receipt preparation requested another. | Release before the follow-up work. One-connection requests now finish and expense receipt jobs can be queued. |
| Committed action replies | Notification failures could turn completed refunds, expenses, availability changes, table moves and split mutations into error responses. | Keep notifications best effort after commit. Table moves also reuse the locked group IDs, reducing follow-up reads from three to one. |
| Floor-plan permissions and empty groups | The floor response omitted the user ID needed to load granted actions; a restricted user could clear an empty joined group before the save permission check. | Load grants for the selected user and apply the existing edit permission before the early empty-group branch. |
| Table administration and conflicts | Repeated names in one bulk request caused the whole insertion to fail; an active-split disjoin conflict was reported as a server error. | Deduplicate normalized names within the batch and retain the domain conflict status/code. |
| Split display and settlement | Realtime updates omitted split count and showed the original balance; equivalent six-decimal quantities could fail because of floating-point addition. | Use the same remaining balance/count as the fresh floor view and compare quantities at the database's six-decimal precision. |
| Held tax and creation replay | Save/follow-up accepted replacement hold-time tax settings and the creation fingerprint; continuation could recalculate an income-tax hold using changed live settings. | Retain server-owned hold metadata and the saved registration profile while accepting permitted item/customer edits. |
| Held kitchen baseline | Disabling a printer or removing a category route erased sent lines from the comparison, allowing previously sent quantities to be removed or reduced through an ordinary save/follow-up. | Compare against the full durable sent baseline; current routing decides new work only. |
| Held service charge | Identical UUID snapshot IDs were converted to `NaN`, so unchanged cashier/phone-worker saves failed; creation fingerprints lost the UUID and accepted a different fee as the same request. | Preserve snapshot string identity and reject replacements. Recover older fingerprints only when the incoming UUID independently matches the held row's bound snapshot. |
| Register draft transitions | Late checkout, hold, invoice-read, split, follow-up, baseline or cancellation responses could erase or alter a newer draft. A delayed held checkout could consult the new draft's kitchen flag. | Track the owning draft and user as well as the table session; ignore stale draft effects and freeze the completed sale's printing context. Clear resets the old busy state, while an old response cannot unlock a newer hold. |
| Split restore and navigation | Restored rewritten checks reverted to revision one or lost saved tax settings; a successful split could navigate to the wrong board. | Preserve revision/tax context through restoration and persistence, and honor the requested split-board destination. |

No schema, dependency, deployment, financial calculation model or permission policy redesign was introduced.

## Workflow map

The [table route and branch matrix](2026-09-06-table-workflow-audit.md) covers every public table route/action, exported table operation, group/session locking, save/re-save, print marking, join/disjoin, transfer/swap/merge, split creation/rewrite/cancellation, saved settlement, administration and QR drafts. It records the current global split-management permission policy and the concurrency permutations that remain untested.

The [held and checkout matrix](2026-09-06-held-checkout-workflow-audit.md) covers creation, claim/version/token ownership, edit, kitchen firing and follow-up, baseline confirmation, release, cancellation, ordinary checkout, platform settlement and replay. It also identifies related checkout, subscription and refund coverage. A canceled held order still returns not-found on a lost-response retry; this pass does not replace the cancellation protocol.

The [frontend workflow matrix](2026-09-06-pos-tables-frontend-audit.md) maps catalog/barcode/cart actions, prices and discounts, payment, recalled orders, floor transitions, split editing/restore, delayed responses, persistence and receipt dispatch to tests and browser observations.

The remaining POS routes were inspected at their public boundary: catalog listing/barcode/category-price resolution, availability, order types, private customer lookup, expense categories/creation, service-charge draft creation/abandonment, paid refund versus unpaid void, receipt finalization/status and drawer logging. Existing catalog, pricing, customer, expense, permission, checkout, service-charge and refund suites provide the associated executable checks; these routes were not all clicked manually in the browser.

## Verification

The [compact verification record](../../scripts/reviews/pos-tables-workflow-verification.json) records run counts, scope, raw-evidence references and source hashes. Tests were run in stages; broad runs and final affected reruns are identified separately. Raw test reports and screenshots live in ignored local `scratch/` storage.

- The one-connection manager/pricing/attempt checks passed 19 cases in three files; the original connection regression and price-only regressions failed before the corrections.
- The one-connection availability/expense/refund file passed five cases, including injected failures after commit. Availability and expense requests timed out before the release fix; the partial-refund notification case returned 500 before its fix.
- Checkout, permissions, security, subscription purchase and checkout follow-up/performance checks passed 220 cases in six files.
- Refund, expense, category pricing, catalog/barcode/availability and customer checks passed 117 cases in five files after the POS action fixes.
- Broad table checks passed 327 cases in ten files. The final one-connection table run passed 27 cases in two files; those runs cover 338 distinct definitions after removing overlap.
- Held authority/profile/kitchen/snapshot checks passed 24 final focused cases and 116 related cases across eight files. The related run followed the tax/kitchen corrections; the final focused run followed the UUID corrections.
- The broad frontend run passed 530 cases in 88 files. Final affected frontend checks passed 34 cases in three files, including 17 transition regressions; existing order-store/table-session checks passed 246 cases in two files. The final build passed in 7.41 seconds.
- The combined English and Arabic restaurant browser workflows passed on separately created loopback databases: ordinary sale, table save/re-save/addition, split settlement, partial refund, stock/recipe quantities, counts, reports and rendered A4/thermal output. Both databases were removed after their servers stopped.
- Separate local browser checks passed delayed checkout versus a newer draft, create/rewrite/return-to-board, rewritten split reload/payment with revision two, manager access with the visible Price target-amount control, and Clear during overlapping held requests. No uncaught page errors were observed. The Price control changed quantity, not unit price.
- Architecture validation passed with 232 nodes, 65 flows and 493 steps. Its existing minor CORS configuration note remains; the architecture boundary did not change.

Independent review covered the backend authorization/action changes, held changes, table changes and frontend transitions. It caught an introduced pending-hold/Clear busy-state regression; that correction has a failing-then-passing deferred-response test and an actual browser reproduction.

## Environment boundary

All writes and fault injection used generated, allowlisted loopback test databases. Test receipt/kitchen queues and browser-rendered output are not proof of physical paper completion. The exact deployed POS URL and printer/spooler station were requested for the production/hardware part of the annotation and have not been supplied. Those checks remain pending; no production deployment, production transaction, printer output, push or merge is claimed.

The repository's unrelated `.codex/config.toml` is preserved. Machine environment files, credentials, dependencies and local evidence are not included in the change.
