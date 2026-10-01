# Kitchen subcategory overrides

## Rule

An explicit subcategory assignment replaces inherited parent assignments. If there is no explicit assignment, use the parent category's printers. Explicitly selecting multiple kitchen printers still produces one preparation ticket per selected active printer.

Disabled explicit stations do not trigger fallback to an unrelated parent station. The line is unrouted if none of its explicit stations is active. Removing the assignment restores parent inheritance. The same resolver governs routability checks and ticket construction.

Existing mixed-order tickets may still show other stations' items as `_isOther` context. Those are not primary preparation lines. A ticket containing only the overridden subcategory creates no job for the parent station.

## Experiments and verification

Before changing production code, a new real-MySQL integration suite produced **6 failures and 2 passes**. It demonstrated that parent tickets were incorrectly generated for the override case, including a persisted extra print-queue job.

After the fix, the focused suite passed **62 tests across 6 files**:

- Normal, follow-up, cancellation and void tickets send the special B subcategory to A and its unassigned sibling to B.
- Shared explicit subcategory assignments send to both printers exactly once.
- No explicit assignment inherits the parent.
- A disabled explicit station does not silently redirect to the parent; another active explicit station remains usable.
- Bundle children route independently and preserve multiplied quantities.
- Actual print-queue insertion creates only the override station's job for a subcategory-only ticket.
- One-line and 100-line batches both execute **two database reads**. No per-item query or dependency was added.
- Existing held-order kitchen, held firing, bundle firing and print unit tests pass.

Commands:

```
npm run test:isolated -- kitchenCategoryOverride kitchenPrintRouting print.unit heldOrderKitchen heldOrders.fireKitchen bundle.heldOrders.fire
npm run build:admin
npm run architecture
npm run architecture:check
```

Logs: `scratch/kitchen-override-red.log`, `scratch/kitchen-override-final.log`, `scratch/kitchen-override-build.log`.

The printer settings screen explains the override rule in English and Arabic. No existing printer selections or queued jobs are rewritten. Tests used guarded local fixtures, not physical printers or a hosted deployment. Changes take effect for newly generated jobs after the updated server is started.
