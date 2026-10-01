# Phase 4 POS State Ownership Break-Review Prompt

You are the adversarial reviewer for Phase 4 of the POS architecture refactor. Use ponytail at full intensity. Your job is to disprove the refactor's safety, not to admire its organization. Review the implementation against `docs/superpowers/plans/2026-07-23-pos-state-ownership.md`, the merged Phase 1–3 plans, and the actual runtime callers. Do not implement Phase 5 and do not propose speculative architecture.

Before reviewing, read completely:

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md`
3. `docs/superpowers/plans/2026-07-22-architecture-foundations.md`
4. `docs/superpowers/plans/2026-07-22-table-order-save-transaction.md`
5. `docs/superpowers/plans/2026-07-22-checkout-transaction.md`
6. `docs/superpowers/plans/2026-07-23-pos-state-ownership.md`
7. Every Phase 4 changed file and every directly importing caller/test.

Establish the exact review base with `git merge-base master HEAD`, then inspect both committed and working-tree changes. Never assume a function moved correctly because its tests are green. Trace inputs, mutation, awaits, outputs, cleanup, and callers.

## Attack order

### 1. Public facade breakage

- Instantiate `useCart()` and `useTables()` and compare their exact sorted keys, ref/function types, and router wrappers with the Task 1 baseline.
- Search all imports and destructuring sites in `src/` and `assets/js/`. Find any caller bypassing the facades or any renamed/missing property.
- Verify extracted functions did not leak through the public API and facade files did not gain business branches.

### 2. Split conservation and identity

- Try zero, negative, non-finite, fractional, 1/3, 1/6, and compound splits. Prove quantity is conserved to the backend's 0.0001 tolerance.
- Use two same-product lines with different price, note, modifiers, frozen order-item ID, tax, and service-charge status. Prove no merge loses financial identity established by Phase 1.
- Attack fixed discounts larger than subtotal, zero-subtotal seats, remainder allocation ties, empty seats, one seat, and service-charge cents that do not divide evenly.
- Compare the final posted JSON field-for-field with the pre-refactor store behavior. The module may construct data; only the store may authorize, alert, fetch, mutate UI state, or navigate.

### 3. Checkout identity and post-await isolation

- Mutate cart, table, customer, payment, order type, discount, tax mode, active user, and shift after `fetch` starts. Confirm the request and receipt use the intended frozen values while stale-session guards protect current state.
- Replay identical and changed attempts across modal close/open and reload. Prove exactly one fingerprint source and one hash/cache implementation exist.
- Exercise cash, card, split, table settlement, restored split, edited invoice, subscription purchase, service-charge claim, duplicate success, backend receipt present/absent, and print failure.
- Prove server totals and `receipt_display_v1` retain precedence, a completed key is handled once, and a late Table A checkout never clears Table B.
- Search for copied money, receipt, fingerprint-hash, or idempotency algorithms.

### 4. Persistence corruption and cross-user residue

- Enumerate every literal storage key in the old store, `PosTerminal.vue`, auth/logout/idle/admin callers, and new adapter. Account for each key; do not rely on the plan's list.
- Test malformed JSON, unavailable storage, empty strings, zero values, null snapshots, deep cart mutation, one-time handoff consumption, repeated mount, logout, idle expiry, admin-session clear, and cashier switch.
- Prove `pos_service_charge_snapshot` and `pos_checkout_attempt` are cleared with order/session data. Prove reference/config storage is not accidentally deleted.
- Prove watchers cannot recreate cleared data during reset, especially the intentionally suppressed empty-cart write.
- Reject generic key-value wrappers or duplicate key arrays. One named adapter should own order/session key mechanics; the existing checkout attempt cache may own its internal value format.

### 5. Table-session races

- Pause each table/draft/save/checkout request, then leave or switch tables before resolving it. Try null, number, and string table IDs.
- Prove every stale callback checks the same boundary and cannot restore cart, QR draft, active table, processing errors, or navigation for the departed session.
- Verify enter/switch/leave always advances the token as before and clears QR residue. Verify active-table persistence is written/removed at the same semantic points.
- Compare every normalized active-table field, including waiter ownership, printed status, split parent IDs, invoice/order/ticket display IDs, and timestamps.
- Reject a new Table Pinia store, port/callback bag, hidden HTTP action, or order↔table circular import.

### 6. Phase alignment and scope

- Confirm no backend, SQL, schema, dependency, endpoint, response shape, middleware, root runtime path, or component import path changed.
- Confirm Phase 1 Saved Order Lines and Phase 2/3 backend modules remain untouched and frontend payload fields still match them.
- Confirm all new runtime files stay under the current `assets/js` root for Phase 4; Phase 5 will perform moves with `git mv` and update path-reading tests.
- Inspect `tableFloorPlan.transfer.static.test.js`; it must still read a valid unchanged transfer block or be replaced by an equally strong runtime test in the same commit.
- Search for dead old functions, duplicate formulas, unused imports/exports, placeholder TODOs, commented-out implementations, broad cleanup, and files changed only for aesthetics.

## Evidence standard

Report findings first, ordered P0–P3, with exact file and line, reproducible input/sequence, consequence, and the smallest correction. Do not report style preferences or theoretical risks.

For every correction:

1. Add or strengthen the smallest failing regression.
2. Confirm RED for the intended reason.
3. Make the narrowest fix.
4. Run the owning focused cohort.
5. Re-run `git diff --check` and the relevant duplicate/ownership searches.

After all concrete findings are fixed, run the final full unit suite and production build once unless the phase already ran them after the last production-code change. Record exact counts and build sizes. Do not rerun the full suite merely for a docs-only commit or clean fast-forward merge.

The phase is rejected if any public facade key changes, any checkout/split payload drifts, storage cleanup leaves cross-user order residue, table races can paint stale state, an extracted rule has two implementations, a new circular store dependency appears, or Phase 5 path migration leaks into the branch.

If no issue is found, say so explicitly and list residual test gaps; do not manufacture findings.
