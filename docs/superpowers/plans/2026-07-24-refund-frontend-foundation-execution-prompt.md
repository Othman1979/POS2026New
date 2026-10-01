# Strict Execution Prompt — Refund and POS Frontend Foundation

Use this prompt in a fresh execution turn. It authorizes implementation of the two linked plans, not broader cleanup.

---

You are the owner of a behavior-preserving foundation refactor in `C:\xampp\htdocs\posapp`.

Start goal mode with this concrete objective:

> Extract the unpaid open-table void transaction into one deep backend module and improve POS frontend editability through truthful transport ownership, two complete workspace components, and only a dependency-gated private table workflow, while preserving every public API, financial invariant, reactive source of truth, caller contract, and cashier/table behavior.

Before editing, read completely and obey:

1. `docs/superpowers/evidence/2026-07-24-refund-frontend-foundation.md`
2. `docs/superpowers/plans/2026-07-24-open-table-void-ownership.md`
3. `docs/superpowers/plans/2026-07-24-pos-frontend-editability.md`
4. repository instructions such as `AGENTS.md`, if present
5. the full `ponytail` skill
6. the full `executing-plans`, `test-driven-development`, `verification-before-completion`, `backend-code-review`, and relevant Vue/frontend-review skills

Do not use the brainstorming skill. The design has already been selected. Do not reinterpret goal mode as permission to broaden scope.

## Governing skill resolutions

- `ponytail` runs at **full** intensity for the entire task. Apply its ladder after tracing each real flow: reuse existing ownership, prefer deletion, add the fewest files, and reject speculative abstractions.
- There is no dedicated Pinia skill installed. Use the repository evidence, Vue 3 skill, and official Pinia constraints already cited in the evidence document. Do not install another skill or dependency for this task.
- The Vue skill generally prefers TypeScript, but this approved plan explicitly forbids a TypeScript migration. Preserve the repository's JavaScript Vue style and use existing `<script setup>` conventions.
- TDD is mandatory for new boundaries and behavior changes: write the smallest test, observe the expected failure, implement the minimum change, and observe green. Do not commit a deliberately red checkpoint.
- Existing characterization tests that already cover moved behavior are evidence; do not clone them just to claim new coverage.
- Backend/frontend review checklists are adversarial gates after implementation, not authorization to redesign unrelated code.
- Verification claims require fresh command output. Earlier tests may guide scope but cannot be reported as current proof.
- Do not use subagents for core reasoning or implementation; execute inline as requested.

## Exact self-command

> Work like the repository owner who must support this POS at 3 a.m. Trace every caller and transaction before moving code. Preserve behavior first, improve ownership second, reduce code third. A shorter file with duplicated state, a wide context bag, circular stores, altered response semantics, lost scoped CSS, or reordered financial effects is a failure. Follow the two approved plans in sequence, one green checkpoint at a time. When a proposed extraction is not deep enough, delete the proposal instead of forcing it. Never expand into admin HTTP, TypeScript, UI redesign, paid-refund redesign, terminal integrations, or unrelated cleanup. Prove every completion claim with focused tests, static negative checks, diff review, and the required smokes. Stop before merging and report truthfully.

## Operating discipline

- Work on a feature branch named `codex/refund-pos-foundation` unless an equivalent feature branch for this exact task already exists.
- Run the `using-git-worktrees` preflight before implementation. The current checkout was observed as normal `master`, and the four authoritative 2026-07-24 evidence/plan documents are untracked. Never create an isolated checkout that silently loses them: either preserve/commit only those exact governing documents first when authorized, or recreate/verify their exact contents inside the isolated worktree. Do not stage the older unrelated untracked plans, `posapp.7z`, or `skills/`.
- Inspect `git status`, current branch, and HEAD first. Preserve all pre-existing untracked and unrelated files; do not stage them.
- Revalidate plan line numbers and current callers against HEAD. Paths and ownership are authoritative; old line counts are not.
- Execute inline in the listed order. Do not delegate core reasoning or implementation.
- Use `apply_patch` for manual edits.
- Make the smallest coherent commit at each plan checkpoint.
- Run targeted tests after the relevant change. Do not rerun the full suite after every small edit or again after a no-change merge.
- If a test fails, diagnose the root cause before changing code. Never weaken a financial, lock-order, ownership, or facade-contract assertion to make a refactor pass.
- Keep a live plan with one in-progress task.
- Send concise progress updates at least every 60 seconds during long work.

## Scope locks

You may modify only files named by the two plans plus directly corresponding focused tests. A newly discovered correctness bug may be fixed only when it is caused/exposed by this work or blocks an invariant; record why it is in scope.

Forbidden expansions:

- paid-refund redesign or moving `refundPaidOrder()` away from its subscription caller;
- controllers, repositories, ORM, transaction framework, error hierarchy, DI framework;
- TypeScript migration or new dependencies;
- new public Pinia stores for cart/table/checkout;
- admin-dashboard HTTP migration;
- UI redesign, class cleanup, wording changes, terminal-provider work, or unrelated feature additions;
- renaming/moving `useCart.js`, `useTables.js`, `orderSessionStore.js`, or public routes;
- one helper per file;
- generic `context`, `services`, `deps`, or `helpers` bags that hide broad coupling;
- duplicate reactive state during migration;
- staging any pre-existing untracked document, archive, skill directory, or unrelated change.

## Backend execution law

Treat the paid and unpaid operations as different semantics behind one endpoint:

- paid refund remains `RefundService.refundPaidOrder(conn, ...)` and remains reusable by subscriptions;
- unpaid table void becomes `backend/modules/refunds/voidOpenTableOrder.js` with exactly one exported use-case function;
- the module owns connection acquisition, transaction, SQL, locks, stock, service-charge transitions, audit, and post-commit use-case effects;
- the route owns request parsing, intent dispatch, permission preflight where applicable, and HTTP translation;
- never pass `req` or `res` into the module;
- pass the kitchen printer as a narrow callback and call it with the same `io, payload` contract as today;
- preserve table-group-first lock order and all transaction statement ordering;
- audit must commit atomically with the void;
- kitchen/realtime/cache work must remain post-commit; a non-critical post-commit failure must be logged and must never cause a committed void to be reported as an uncommitted failure;
- delete the unreachable refund branches only after the route-to-module intent boundary proves they cannot execute;
- do not create a generic shared refund/void calculator unless the remaining algorithms are byte-for-byte semantic equivalents. Similar math with different lifecycle meaning stays separate.

Attack the backend diff before accepting it:

1. Can a stale table/order binding mutate anything?
2. Is any order/item lock acquired before the canonical table-group lock?
3. Can a permission failure occur after a mutation?
4. Can an audit row survive a rollback or a void survive without its audit?
5. Can bundle children, kitchen quantities, stock, service-charge snapshot, and order totals disagree after a partial void?
6. Can a socket, printer, or cache exception produce HTTP failure after commit?
7. Can a paid refund accidentally reach the void module or vice versa?
8. Did the route retain any void SQL or did the module gain Express knowledge?
9. Did the extraction change public error messages/codes/statuses or response fields?
10. Did any paid-refund or subscription reuse get duplicated?

Do not proceed to the frontend until the backend focused tests, static ownership checks, and manual transaction-order review are green. Commit the verified backend checkpoints.

## Frontend execution law

The goal is ownership, not smaller files at any price.

### Contracts first

- Pin direct production consumers of `useOrderSessionStore()` to `useCart.js` and `useTables.js`.
- Build a truthful per-consumer facade key manifest before deleting anything.
- Preserve all currently used ref/function semantics.
- Components must continue to avoid private order-session leaf imports.

### Transport

- `orderSessionApi.js` owns request serialization and response parsing for the store's current domain calls; it must not be a set of meaningless one-line aliases.
- Keep stale-request guards, UI transitions, and reactive mutations in the store.
- Move the three terminal requests to `useProducts`/category price ownership and `useAuth` as the plan states.
- Do not mass-migrate stable calls elsewhere merely to reduce a count.
- Preserve every caller's distinction between HTTP status, body success, tolerant JSON, and network failure.

### Workspace components

- Extract catalog first, verify it, commit it; then cart, verify it, commit it.
- Move complete markup plus its interaction logic and scoped styles.
- Do not redesign or normalize CSS during the move.
- Consume existing facades directly to avoid prop drilling and cloned state.
- Maximum combined shell props/events per workspace: 6. If exceeded, stop and redraw ownership.
- Preserve desktop, narrow/mobile, touch/long-press, RTL, scroll, modal, and accessibility behavior.
- Leave global route/socket/page activation and shell-modal orchestration in `PosTerminal.vue` unless an extracted owner can expose a truly small interface.

### Private table workflow gate

Before creating `tableOrderWorkflow.js`, write the dependency matrix required by Task 5. Do not create the file until the matrix proves all gates:

- at most 12 named inbound capabilities;
- no generic bag;
- one-way dependency direction;
- same refs returned through the root store;
- no new Pinia store;
- at least 500 cohesive lines relocate;
- no duplicate state or compatibility implementation;
- root retains genuine cart/table/checkout coordination.

If the gate fails, do not force the extraction. Record the exact dependency obstruction, leave the production store intact, and continue with verification. That is a valid and preferable outcome.

Attack each frontend diff before accepting it:

1. Are any refs copied instead of shared?
2. Did a component lose parent scoped styles after extraction?
3. Did a timer, socket, window, document, or barcode listener lose teardown?
4. Can activation/deactivation register duplicate listeners?
5. Did a stale table/catalog request gain permission to overwrite a newer session?
6. Did response parsing or non-2xx handling change?
7. Did the facade return a non-ref where callers expect a ref, or lose a function binding?
8. Did component extraction create a large prop/event surface?
9. Did a private module import a facade/store/component/router and create a cycle?
10. Did any file appear without passing the deletion test?
11. Did mobile cart, RTL, long press, notes products, QR draft, split, and table modes remain connected?
12. Did unrelated admin fetch calls or UI get touched?

## Verification policy

Follow the exact increasing-scope commands in the plans. Add only tests that cover a real uncovered contract.

Minimum required evidence before completion:

- backend ownership static test;
- full `refunds.test.js` plus named service-charge/tax/table/report coverage;
- order-session boundary and store tests;
- focused transport/component tests;
- Vite production build;
- cashier checkout Playwright smoke;
- waiter/table Playwright smoke if the table workflow is extracted;
- narrow viewport manual/smoke verification for the catalog/cart moves;
- final `rg` negative checks;
- manual diff review against every invariant.

Do not claim success from test results alone. Read the final route, module boundaries, component imports, store return surface, lifecycle teardown, and diff. Compare `git diff --stat` and the list of new files against the plans. Run `git diff --check`.

Run the whole Vitest suite once only if the final touched surface warrants it or targeted evidence reveals uncertainty. Do not rerun it merely because commits were merged without code changes.

## Completion report

Before marking the goal complete:

- list commits and exact files added;
- state whether the table workflow passed or failed its dependency gate;
- report facade key counts before/after and justify every deletion;
- report direct `fetch()` counts for `PosTerminal.vue`, `orderSessionStore.js`, POS runtime, and the whole frontend, while explaining why the global number was not blindly optimized;
- report line counts only as secondary evidence;
- report targeted tests/build/smokes actually run and their results;
- report remaining risks honestly;
- confirm unrelated files were not staged;
- do not merge to `master` unless the user explicitly requests it after review.

The quality bar is not “the files are shorter.” The quality bar is: one source of truth, deep owners, small truthful interfaces, preserved financial/session invariants, fewer reasons to touch the central files, and no architecture theater.

---
