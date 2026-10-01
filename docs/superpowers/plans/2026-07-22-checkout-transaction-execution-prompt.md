# Phase 3 Checkout Transaction Execution Prompt

You are implementing Phase 3 of the POS architecture refactor. Work from the merged `master` commit containing Phases 1 and 2. Use ponytail at full intensity and execute `docs/superpowers/plans/2026-07-22-checkout-transaction.md` exactly, task by task, in an isolated worktree on a `codex/` branch.

Before editing, read completely:

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md`
3. `docs/superpowers/plans/2026-07-22-architecture-foundations.md`
4. `docs/superpowers/plans/2026-07-22-table-order-save-transaction.md`
5. `docs/superpowers/plans/2026-07-22-checkout-transaction.md`
6. `backend/routes/pos/checkout.js`
7. `backend/modules/orders/SavedOrderLines.js`
8. `backend/modules/tables/saveTableOrder.js`
9. Every existing test file named in the Phase 3 plan before changing its assertions.

Mission: extract the existing checkout transaction into `backend/modules/checkout/executeCheckout.js` while keeping `POST /api/pos/checkout` behavior byte-for-byte compatible at the HTTP contract level. The route remains the Express adapter. The module owns connection acquisition, transaction state, locks, pricing, persistence, audit, duplicate recovery, receipt result construction, commit, post-commit effects, rollback, release, and active checkout-lock cleanup.

Hard boundary:

```js
executeCheckout({
    user,
    input,
    io,
    ipAddress,
    authorizeManagerOverride
})
```

`authorizeManagerOverride(managerPin)` is the only request-context bridge. It returns `{ allowed, managerId }` and delegates to the existing request-aware helper from the route. Never pass `req` or `res` into the module, never construct a fake Express request, and never validate a supplied manager PIN earlier or more often than the existing logic does.

Non-negotiable invariants:

- Keep `/api/pos/checkout`, `requireAuth`, and `server.js` checkout rate-limit order unchanged.
- Keep `/api/pos/log_drawer_pop` unchanged.
- Preserve every SQL statement's meaning and ordering, especially shift-before-order/table locks, invoice/order sequence allocation, idempotency preflight/recovery, service-charge state transitions, ghost-order audit atomicity, inventory updates, and table release.
- Preserve error status, message, redaction, and `publicCode` behavior.
- Preserve response fields for normal and duplicate checkout success.
- Set transaction state false immediately after commit; notification/cache failures after commit must not roll back or return failure.
- Keep the Phase 1 Saved Order Lines module as the canonical frozen-line implementation.
- Do not move or redesign `backend/routes/pos/helpers.js`; that is Phase 5.
- Do not add repositories, controllers, factories, dependency containers, TypeScript, packages, schema changes, frontend changes, or speculative submodules.
- Do not split the large transaction merely because it is large. First establish one correct owner; later phases may deepen only with evidence.

Execution discipline:

- Follow red-green-refactor and commit at every plan checkpoint.
- Run only the focused tests listed for each task. Run the full suite once at the final gate, unless production code changes after that gate.
- Never change a pre-existing behavior assertion just to make the refactor pass.
- Compare the benchmark with the recorded baseline; checkout must remain at 24 median/max queries.
- After implementation, review `master...HEAD` as an adversary: trace every early return, thrown error, duplicate key, rollback failure, active lock, connection release, and post-commit notification.
- Search both the route and module for stale duplicate SQL and idempotency logic.
- If the plan conflicts with current code, stop the affected task, cite exact file/line evidence, and amend the plan before proceeding. Do not improvise a broader architecture.

Definition of done: the route is transport-only, the module contains the sole checkout transaction, all focused and full verification passes, build and schema checks pass, checkout queries remain 24, evidence is recorded, and no Phase 4/5 work has leaked into the branch.
