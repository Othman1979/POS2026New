# POS and tables frontend workflow audit — 2026-09-06

This follow-up examined draft ownership, checkout completion, and the split workflow beyond the earlier catalog/settings/request audit. It does not claim exhaustive path or branch coverage. Backend permissions, money authority, pool lifetime, and physical printing have separate verification boundaries.

## Corrections supported by reproduction

| Trigger | Previous result | Corrected result | Evidence |
| --- | --- | --- | --- |
| Start checkout, move through Tables to a new register draft, then receive the old success | New cart and its checkout retry cache were cleared | Completion only clears the draft, table session, and operator that submitted it | Failing-then-passing transition test; local browser using the production build charged Burger while preserving the newer Drink |
| An old checkout fails after another draft opens | Old error appeared in the newer checkout | Failure and processing cleanup respect draft ownership | Transition test |
| Restore another draft while hold, held follow-up, baseline confirmation, cancellation, or invoice editing is awaiting a response | Older completion cleared or replaced newer cart/customer/edit state | A draft sequence supplements the existing table sequence; stale responses leave the newer draft alone | Failing-then-passing tests for each action |
| Clear a draft while its hold request is pending, then start another hold | The old busy flag could remain set; blindly clearing it later would unlock the new request | Clear uses the existing transient UI reset; older completion cannot release the newer hold's busy flag | Independent review finding; failing-then-passing two-hold test and local browser with both responses deliberately delayed |
| A saved-table void or split completes after another table opens | Old completion could close or clear the newer table | Completion and void reload continuation check their session owner | Transition tests |
| Submit split twice before the UI updates | Two split requests could be sent | The action checks the shared busy flags before posting | Transition test |
| Restore a rewritten split, including after full reload | Revision was discarded and payment submitted revision 1; tax snapshots were incomplete | Revision, exemption, registration, pricing, and receipt tax snapshots survive restore/persistence | Raw-row and processed-card tests create a fresh store; browser restores revision 2, reloads, submits revision 2 and pays |
| Create a split or save edited checks | Creation could fall back to the floor; editing ended on an empty POS | Both success paths return to the Split Board through the router; fallback navigation honors the requested destination | Transition tests and local browser using the production build |
| A fired held checkout completes after another held draft replaces it | Kitchen decision read the new draft's fired flag | Kitchen decision uses the submitted held snapshot | Transition test; no physical kitchen claim |
| Another sale replaces the receipt preview while a prior receipt is printing | Duplicate dispatch could use the later sale | Receipt and duplicate dispatch receive the completed sale snapshot; delayed table navigation also checks the current draft | Transition test plus existing checkout suite |

The changes are in the existing session store, table workflow, table normalization, and terminal/table facades. No new dependency, persistence schema, or architectural module was introduced.

## Flow and branch coverage matrix

“Browser” below means Chromium against the production build at loopback port 3014, with a generated review database and fixture accounts. “Tests” means the actual focused suite named below, not an assertion that every combination was exercised.

| Flow | Branches exercised or reviewed | Evidence in this pass | Remaining boundary |
| --- | --- | --- | --- |
| Login → open shift → POS | Admin and cashier login; shift opening; ready catalog | Browser | WebAuthn, shift close/reopen races, and every role/permission combination were not replayed here |
| Catalog → cart | Category/product display; click-add; cart selection; cross-view draft replacement | Browser; existing frontend and order-store suites | Hardware barcode scanners and every modifier/bundle/scale-price combination were not browser-replayed in this pass |
| Quantity/amount → manager access → checkout | Cashier Price disabled; temporary manager access enables it; target 3 JD gives quantity 1.5 at unit price 2 JD; card checkout with zero discount | Browser | The current Price control changes quantity to a monetary target. It does not edit unit price. Backend unit-price override authority is integration-tested separately |
| Register checkout | Success, failure, later draft, preserved retry cache; held kitchen decision; duplicate receipt payload | Transition tests; delayed-success browser | Every cash/card/split/receivable/platform combination under arbitrary network ordering was not replayed |
| Held order | New hold, current hold success, late hold/follow-up/baseline/cancel responses; Clear during a hold followed by another hold | Transition tests; existing order-store suite; delayed two-hold browser | Claim lease contention and lost-response retry authority need backend integration evidence; current call-center search/reconnect UI branches are not claimed fully covered |
| Invoice editing | Late invoice load cannot overwrite a restored draft | Transition test | Full edit/refund/void combinations and every historical invoice format were not replayed here |
| Table draft/save | Enter table, add items, save, create split; old void completion after another table opens | Browser and transition tests | Transfer/join/disjoin and remote ownership changes are addressed by the separate backend/table audit; no exhaustive multi-terminal browser claim |
| Split create/edit/restore/settle | Create check; move another item in edit; return to board; restore rewritten check; full reload; pay revision 2; duplicate submit guard; newer-table ownership | Browser and transition tests | Tax-mode/exemption permutations are covered by fresh-store tests, not live fiscal integration; all legacy split formats and mixed paid/unpaid rewrites were not browser-replayed here |
| Settings/runtime mode | Existing cache, catalog, floor and settings tests still pass in the broad frontend check | Earlier audit plus this pass's broad frontend run | The new targeted browser script does not repeat the previous English/Arabic settings toggles; root's EN/AR acceptance run is separate |
| Receipt/guest check/fiscal completion | Completed-sale payload stays stable; old table completion cannot redirect a newer nonempty draft; existing receipt/fiscal order-store tests pass | Transition and existing order-store tests | No physical printer, cash drawer, card terminal, paper completion, live JoFotara, or production environment was used |

## Verification and artifacts

- `npm run test:frontend`: 88 files / 530 tests passed before the final two split-navigation tests and the independent-review hold test were added. Subsequent affected checks passed with the final source. This broad run was captured in terminal output; no raw JSON reporter file was requested.
- Final affected frontend command: `npm run test:frontend -- src/pos/orderWorkflowTransitions.spec.js src/components/pos/__tests__/tableSplitsBoard.spec.js src/components/pos/__tests__/splitCheckModal.spec.js`: 3 files / 34 tests passed; 17 are the new transition regressions.
- `npm run test:isolated -- backend/tests/unit/orderSessionStore.test.js backend/tests/unit/tableSession.logic.test.js`: 2 files / 246 tests passed after the final Clear correction. The old receipt assertion now verifies the invoice and the shared completed-sale payload instead of requiring mutable object identity.
- Final production build: `npm run build:admin` passed (349 modules, 7.41 seconds).
- Targeted local browser runs: the five main workflow steps passed; after the final Clear correction, the affected two-hold browser also passed. Both had zero uncaught page errors. The printer fixture had no assigned receipt printer, so the visible print warning is expected and is not paper-output evidence.
- Tracked compact browser evidence: [pos-tables-frontend-browser-verification.json](../../scripts/reviews/pos-tables-frontend-browser-verification.json).
- Final Clear regression browser evidence: [pos-held-clear-browser-verification.json](../../scripts/reviews/pos-held-clear-browser-verification.json); local runnable script and raw result are `scratch/pos-held-clear-browser.cjs` and `scratch/pos-held-clear-browser.json`.
- Local runnable browser script and raw output: `scratch/pos-tables-transitions-browser.cjs` and `scratch/pos-tables-transitions-browser.json`; both are ignored review artifacts.
- Local screenshot: `scratch/pos-tables-new-draft-preserved.png` (visually inspected; the new Drink remains in the cart while the old Burger payment-success alert is visible).

The targeted browser's fixture database was `posapp_review_recipe_p1_a077fe000002`. Its server was stopped; cleanup verified no connected database sessions before dropping this exact schema, then confirmed the schema was absent. No production data, machine environment file, deployment, commit, or push was changed by this frontend subtask.
