# Shift ending-cash correction

Implemented on the existing `codex/pos-frontend-audit` branch. The previous screen hid ending cash as an unlabeled second input beside Starting Cash after clicking its pencil. The existing backend already supported admin/programmer corrections, including zero.

Closed shifts now show **Ending Cash** with its own edit button. Starting and ending inputs each stay beside their labels, with shared Save Changes/Cancel controls and Arabic translations. Cancel/reopen restores saved values, blank or invalid amounts cannot be submitted, and repeated clicks cannot create multiple pending confirmations. Active shifts retain starting-only editing.

The existing transaction and audit path remains in use. Correcting ending cash updates `actual_cash`; expected cash and sales are preserved. Variance remains actual minus expected, including a real shortage when actual is zero and expected is positive. Equal values produce zero variance. The list and Z-report payload reflect saved corrections; cashier access is rejected.

## Verification

- Before production edits: 9 new frontend regressions failed and 6 existing-behavior cases passed. The built-browser check failed because the Ending Cash edit control was absent.
- Backend baseline: 13 cash-update integration tests passed on a guarded isolated database, including new admin/programmer zero/decimal corrections, cashier rejection, audit records, unchanged orders/expected cash, and list/Z-report variance. No backend production change was necessary.
- After edits: all **712 frontend tests across 114 files passed**. The focused Shifts group passed 41 tests.
- Production build passed. Four real built-UI/API/DB browser cases passed: English/Arabic at 1280/390 px, covering both admin and programmer. They saved 999 -> 0 -> 80 with expected cash 80, verified both audit records and report payloads, and displayed Perfect after the matching correction. An active-shift case saved starting cash zero while preserving status and ending cash.
- English desktop and Arabic mobile screenshots were visually reviewed; no page runtime errors or horizontal document overflow were detected. Logs, screenshots and browser JSON are under ignored `scratch/shift-cash-*`.

One obsolete source-pattern assertion about the old inline input was removed; active-shift access and rendering are covered through the runtime and browser checks. The first added active-shift browser assertion incorrectly expected a null DB default; it was corrected to compare before/after values after observing the fixture's existing `0.00` default.

No schema change, deployment, push or PR is included. Tests used generated loopback fixtures, not customer data or physical printers.
