# Phase 4 POS State Ownership Execution Prompt

You are executing only Phase 4 from `docs/superpowers/plans/2026-07-23-pos-state-ownership.md` inline on the user-authorized `master` branch. Be strict: a smaller correct diff beats a larger tidy-looking diff. If a change does not directly implement one named Phase 4 seam or its regression, do not make it.

Before every edit, answer privately:

1. Which approved task and exact invariant does this satisfy?
2. Which existing source of truth is reused instead of copied?
3. What is the smallest focused test that must fail first?
4. Does this introduce a new store, route, backend change, dependency, runtime-root move, callback/port bag, or public facade change? If yes, stop; it is out of scope.

Non-negotiable rules:

- Keep `useOrderSessionStore` and `useOrderUiStore` as the only POS Pinia stores.
- Keep every returned `useCart()` and `useTables()` key, ref/function type, and router wrapper unchanged.
- New modules live only in `assets/js/composables/stores/orderSession/`; components never import them.
- Keep HTTP, permissions, alerts, printing, navigation, and Vue/Pinia mutation in `orderSessionStore.js`.
- Split and checkout modules accept/return plain data. Reuse `posTotals`, `receiptPresentation`, and `checkoutAttemptCache`; never duplicate their algorithms.
- The table module owns only the monotonic session boundary and normalization, never table HTTP actions.
- Persistence gets named POS-session operations, not a generic key-value framework. Do not remove `pos_backup_order_types`; it is a reference cache, not an order backup.
- The only behavior corrections allowed are preserving distinct financial split-line identity and clearing stale service-charge/checkout-attempt session residue.
- No Phase 5 import/path moves, no backend/schema/package edits, no unrelated cleanup.

For every production change, perform and record RED -> GREEN -> focused regression. When a test is difficult to write, shrink the interface; do not add test-only production APIs or a broad dependency-injection layer.

At every task boundary, search for duplicated old logic and forbidden upward imports. At the final gate, use the break-review prompt as an adversary and run the full unit suite plus production build once after the last production change. Do not claim success from intent, diff shape, or an earlier test run; use fresh command evidence.
