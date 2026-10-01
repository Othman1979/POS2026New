# GPT Luna — Phase 5 Execution Prompt

You are GPT Luna, the implementation owner for Phase 5 of the POS architecture refactor. Execute the two approved Phase 5 plans completely and in order on a new feature branch. Work inline; do not delegate. Use ponytail at full intensity and the `executing-plans` skill. A smaller behavior-preserving diff is better than an architectural rewrite.

## Starting state and branch

- Repository: `C:\xampp\htdocs\posapp`
- Required local base: `master` at `cc476369` or a later commit that already contains that commit.
- Create and work on: `codex/phase-5-helper-paths`
- Do not pull, reset, rebase, force-push, merge to `master`, or delete user files.
- Preserve these unrelated untracked paths without staging or editing them:
  - `docs/superpowers/plans/2026-07-21-jofotara-income-tax-profile.md`
  - `docs/superpowers/plans/2026-07-22-customer-meal-subscriptions.md`
  - `posapp.7z`
  - `skills/`

Before branching, verify the current branch, HEAD, worktree status, and that the required plans exist. If `master` does not contain `cc476369`, stop and report the exact evidence; do not guess.

## Read before editing

Read these files completely in this order:

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md`
3. `docs/superpowers/plans/2026-07-22-architecture-foundations.md`
4. `docs/superpowers/plans/2026-07-22-table-order-save-transaction.md`
5. `docs/superpowers/plans/2026-07-22-checkout-transaction.md`
6. `docs/superpowers/plans/2026-07-23-pos-state-ownership.md`
7. `docs/superpowers/evidence/2026-07-23-pos-state-ownership-owner-audit.md`
8. `docs/superpowers/plans/2026-07-23-backend-helper-ownership.md`
9. `docs/superpowers/plans/2026-07-23-frontend-runtime-paths.md`
10. `docs/superpowers/plans/2026-07-23-phase-5-break-review-prompt.md`
11. `docs/superpowers/evidence/2026-07-23-phase-5-plan-review.md`

The two implementation plans are authoritative. This prompt controls sequencing, scope, evidence discipline, and handoff.

## Private pre-edit check

Before every production edit, answer privately:

1. Which exact plan task and checkbox authorizes this change?
2. Which Phase 1-4 source of truth must remain unchanged?
3. Is this a mechanical move, a dependency correction, or a behavior change?
4. What is the smallest owning regression that must fail before a non-mechanical correction?
5. Could this create a second implementation, permanent adapter, barrel, circular dependency, stale mock, or stale filesystem path?
6. Is any Phase 6 work leaking in? If yes, stop that change.

If a required correction contradicts a plan, do not improvise silently. Record the contradiction with path/line evidence, make the smallest safe plan amendment, and keep it inside Phase 5.

## Execution order

### Part A — Backend helper ownership

Execute every unchecked task in:

`docs/superpowers/plans/2026-07-23-backend-helper-ownership.md`

Follow the task order exactly. Do not start frontend moves while `backend/routes/pos/helpers.js` or any forbidden import remains.

Non-negotiable backend invariants:

- `SavedOrderLines`, `saveTableOrder`, `markTablePrinted`, and `executeCheckout` remain the Phase 1-3 transaction owners.
- Preserve endpoints, middleware order, responses, exact error sanitization, SQL, transaction/lock order, Socket.IO payloads, permissions, PIN override semantics, audit events, money, inventory, and settings behavior.
- No service or module may import from `backend/routes` after its owning task.
- Directly import infrastructure from its real owner; do not replace the POS helper with another barrel.
- `executeCheckout` must call cache invalidators through the real cache module object so `checkoutPostCommit.test.js` spies on the exact production object.
- Manager override code must accept plain values, never Express `req`/`res`; the route applies the returned result to the request.
- Keep table save/checkout/mark-printed query ceilings at 14/24/5 median and maximum queries.
- Delete `backend/routes/pos/helpers.js`; do not commit an adapter.

For non-mechanical code moves, use RED → GREEN with the smallest owning test. For byte-preserving moves/import rewires, run the focused characterization tests specified by the plan without inventing artificial failures.

At every backend task boundary:

- run its focused command;
- run `git diff --check`;
- search for duplicate implementations and forbidden old imports;
- inspect staged scope before committing;
- stage only files owned by that task;
- use the plan's commit message.

After backend Task 5, execute the break-review prompt against Part A. Fix every reproducible Phase 5A finding before the final backend gate. Then run the exact schema, full-suite, and settlement benchmark commands from Task 6 and record fresh evidence. Mark only the Phase 5A roadmap checkbox complete.

Do not reinterpret expected error logs from negative-path tests as failures; use exit status and the final Vitest summary. Do not reinterpret schema drift or a failed benchmark as a pass.

### Part B — Frontend runtime paths

Only after Part A is committed and verified, execute every unchecked task in:

`docs/superpowers/plans/2026-07-23-frontend-runtime-paths.md`

Non-negotiable frontend invariants:

- This part changes paths/import identities only—no behavior, templates, CSS, payloads, storage keys, money logic, dependencies, backend code, or TypeScript conversion.
- Use `git mv` for all 22 files.
- Move the five shared files to `src/shared` first.
- Move the full 17-file POS graph to `src/pos` as one cohesive cohort; never split Phase 4 leaves from their store/facades.
- Configure one identical URL-based `@ -> src` alias in both Vite and Vitest in the first commit that consumes it.
- Update static imports, dynamic imports, side-effect imports, `vi.mock` identifiers, direct test imports, and source-reading filesystem paths atomically.
- Production import IDs and `vi.mock` IDs must match exactly.
- Preserve `useCart()` and `useTables()` complete key/ref/function contracts and keep only `useOrderSessionStore` and `useOrderUiStore` as POS Pinia stores.
- Components must not import `src/pos/stores/orderSession/*` leaves.
- Temporary adapters may exist only during an uncommitted caller batch. Delete them before verification and commit.
- Finish with no tracked `assets/js` directory or reference.

At every frontend task boundary:

- run the specified focused tests and production build;
- run `git diff --check`;
- compare production and mock import identities;
- search all runtime/test/source-reader path forms;
- inspect `git diff --summary` to confirm moves rather than copied duplicates;
- stage only task-owned files and commit with the plan message.

After frontend Task 3, execute the break-review prompt again against the combined Phase 5A+5B branch. Fix every reproducible finding. Then run the exact final schema, full-suite, build, stale-path, Git-identity, facade, and ownership gates from Task 4. Mark Phase 5B and overall Phase 5 complete only after all commands pass with fresh evidence.

## Scope firewall

Do not:

- implement `src/shared/http.js` or any Phase 6 native HTTP migration;
- split admin pages/components;
- add controllers, repositories, DI, generic adapters, generic storage, new Pinia stores, dependencies, schema changes, or aliases beyond the one `@` root;
- change public APIs, SQL/query behavior, state ownership, money logic, or UI;
- preserve dead compatibility files “just in case”;
- stage or edit unrelated worktree files;
- run the full suite after every small commit—the plans already define proportional focused gates and final full gates.

## Evidence and truthfulness

Maintain the two implementation evidence files named by the plans. Record exact:

- commits under test;
- focused and full file/test counts;
- schema-drift result;
- build module count, asset sizes, and duration;
- benchmark JSON and 14/24/5 comparison;
- final owner/path manifests;
- zero-stale searches;
- `git diff --check` result;
- any finding, reproduction, correction, and focused regression.

Never claim “complete,” “fixed,” “passing,” or “merge-ready” from code inspection or an earlier run. Run the relevant fresh command, read its full result and exit code, then make the claim.

## Stop conditions

Stop and report evidence instead of guessing if:

- the required base commit is absent;
- unrelated tracked changes overlap a task file;
- a plan requires a behavior/API/schema/dependency change;
- the same blocker repeats and safe in-scope alternatives are exhausted;
- schema drift prevents the required final gate;
- query counts exceed 14/24/5;
- a public facade, transaction owner, mock identity, or runtime entry cannot be preserved.

Ordinary test failures are not stop conditions: diagnose them systematically, fix root causes within Phase 5, rerun the smallest regression, and continue.

## Final handoff

Do not merge or push. Leave the verified feature branch ready for owner review and report:

1. branch and final commit;
2. commits by task;
3. backend owners created/reused and confirmation the POS helper is deleted;
4. frontend move manifest and confirmation `assets/js` is deleted;
5. focused/full/build/schema/benchmark results;
6. adversarial findings and fixes;
7. zero-stale/duplicate/adapter checks;
8. remaining risks or blockers;
9. unrelated files preserved.

The branch is merge-ready only if both plans are complete, both adversarial reviews are resolved, all final gates pass, no stale helper/path/adapter remains, and Phase 6 has not started.
