# Refund and POS Frontend Foundation — Evidence Record

**Date:** 2026-07-24  
**Branch inspected:** `master` at `7ce8322c`  
**Purpose:** Establish the real ownership problems before planning another refactor. This is evidence and design reasoning, not implementation.

## Executive finding

Two earlier observations were directionally right but too broad:

1. `backend/routes/pos/refunds.js` is still a backend editability ceiling, but **paid refunds are already correctly owned** by `backend/services/RefundService.js`. The remaining target is the reachable unpaid-table void transaction embedded in the Express route.
2. The frontend has large files, but **file length is not the root defect**. `orderSessionStore.js` is already hidden behind two production facades, while `PosTerminal.vue` still mixes shell lifecycle, two major visual workspaces, catalog mutations, realtime reconciliation, and direct transport calls. The store should be decomposed only where a deep private interface can be proven; the component and transport seams are clearer first targets.

## Repository facts

### Current sizes and surfaces

| Surface | Current evidence | Meaning |
|---|---:|---|
| `backend/routes/pos/refunds.js` | 733 physical lines | Express adapter plus an inline unpaid-table void transaction |
| `backend/services/RefundService.js` | 303 physical lines | Existing paid-refund domain transaction, also reused by subscription administration |
| `src/pos/stores/orderSessionStore.js` | 3,089 physical lines | One shared order aggregate containing cart, table, split, checkout, and related orchestration |
| `src/components/PosTerminal.vue` | 2,002 physical lines | About 889 template lines, about 950 script lines, plus scoped CSS |
| `useCart()` facade | 102 pinned public keys | Broad compatibility interface used by POS components |
| `useTables()` facade | 55 pinned public keys | Broad compatibility interface used by table components |
| Direct runtime `fetch()` occurrences under `src` | 158 | 23 are in `orderSessionStore.js`; only 3 are in `PosTerminal.vue`; 101 are under admin pages/components |

The earlier line estimates of roughly 2,829 and 1,821 are now stale because features landed afterward. The important trend is that these surfaces continue to grow when feature ownership is not moved with the feature.

### Production call graph

`useOrderSessionStore()` has only two direct production consumers:

- `src/pos/useCart.js`
- `src/pos/useTables.js`

All Vue components consume the compatibility facades. This is valuable encapsulation: an internal store refactor can preserve callers exactly. It also means a replacement public store hierarchy is not required merely to protect callers.

Known facade consumers are bounded:

- `useCart()`: `PosTerminal.vue`, `OrderNotes.vue`, `CheckoutModal.vue`, `CartNotesModal.vue`, `ModifierSelectorModal.vue`, `SubscriptionModal.vue`, plus tests.
- `useTables()`: `PosTerminal.vue`, `OrderNotes.vue`, `TableSplits.vue`, `TableFloorPlan.vue`, `CheckoutModal.vue`, `SplitCheckModal.vue`, plus tests.

`backend/tests/unit/orderSessionBoundaries.test.js` pins both key sets and representative ref/function semantics. Existing tests also prohibit components from importing the private `src/pos/stores/orderSession/` leaf directory.

## Backend ownership evidence

### Paid refunds are not the extraction target

The route dispatches `intent === 'refund'` before entering the large inline block. It starts a transaction and calls:

```js
refundPaidOrder(conn, {
  invoiceId,
  items,
  refundMethod,
  reason,
  actorId,
  ipAddress
})
```

`refundPaidOrder()` already owns the difficult paid-refund rules:

- locked order and item reads;
- subscription-management guard;
- immutable paid-order validation;
- tax registration freeze;
- bundle integrity and historical name recovery;
- cumulative refundable-quantity checks;
- server-authoritative subtotal/tax/total allocation;
- stock restoration;
- `refunds` and `refund_items` writes;
- order refund-status transition;
- audit write within the transaction.

It is also called by `backend/routes/admin/subscriptions.js`. Moving or replacing it would create churn and risk without improving ownership.

### The inline block is void-only even though it still branches on refund

After the paid-refund branch returns, the remaining block can only receive `intent === 'void'`. Nevertheless, it retains conditionals such as:

- `kind === 'void' ? ... : ...`;
- paid-refund money-cap branches;
- paid-refund status calculation;
- refund-method selection.

Those paid branches are unreachable in that block. The route also duplicates `toMoneyCents()` and `allocateMoneyAcrossRows()` from `RefundService.js`, although only the void-side allocation remains reachable there. This is concrete duplication and cognitive noise, not a hypothetical architecture complaint.

### Reachable unpaid-table void responsibilities

The reachable transaction performs, in order:

1. probe the order and acquire the table-group lock through `lockTableSession()`;
2. validate the locked table/order relationship and printed-table permission;
3. freeze missing tax-registration history;
4. lock/validate order items and persisted bundle structure;
5. recover missing historical item names;
6. reject service-charge line selection;
7. resolve requested quantities against the current live bill;
8. derive kitchen-void parent/child rows;
9. calculate and cent-align void ledger rows;
10. restore stock when enabled;
11. insert the void header and item rows;
12. either void/release the full table group or shrink/rebuild/reprice a partial order;
13. transition the service-charge snapshot correctly;
14. recompute the live order totals for a partial void;
15. write the audit event in the same transaction;
16. commit;
17. best-effort print the kitchen void ticket and broadcast/cache-invalidate after commit.

This is one cohesive use case. It belongs in one deep module, not a controller/repository/service stack.

### Existing regression strength

`backend/tests/integration/refunds.test.js` contains extensive coverage for permissions, stale table bindings, lock order, rollback on audit failure, kitchen routing, service charges, bundles, tax, stock, joined tables, repeated partial voids, and whole-order voids. Additional cross-feature protection exists in:

- `backend/tests/integration/serviceChargeSnapshots.test.js`
- `backend/tests/integration/taxSourceOfTruth.test.js`
- `backend/tests/integration/tables.test.js`
- `backend/tests/integration/reportsRefunds.test.js`

The extraction must reuse these behavioral tests and add a static ownership test. It does not need a rewritten parallel test universe.

## Frontend ownership evidence

### The store is large, but already encapsulated

The store exposes roughly the union of the two compatibility facades plus internal values. Its responsibilities include:

- order/cart state and persisted restoration;
- pricing projections and receipt presentation;
- order types, customer lookup, notes, modifiers, discounts, courses;
- service-charge snapshots;
- table session loading/saving/printing/holding;
- split-check construction and recovery;
- table transfer/join/disjoin;
- paid checkout and post-checkout state transitions;
- open-table void recovery.

The danger is not that components import internals—they do not. The danger is that adding a table or checkout feature can require editing a 3,089-line implementation and understanding several interleaved state machines.

### Why a multi-store rewrite is not automatically better

Cart, table, split, and checkout state do not have independent lifecycles:

- a table load replaces the active cart;
- checkout consumes table ownership and clears/reloads both domains;
- service-charge snapshots span cart and table persistence;
- a saved-item void must preserve unsaved cart changes;
- split restoration reconstructs a cart and table settlement context;
- table closure invalidates in-flight ownership sequences.

Splitting these into multiple public Pinia stores would require cross-store reads and actions in both directions or a new coordinator. Pinia supports store composition, but its own guidance warns that mutually composed setup stores must not both read each other's state during setup because that can create loops. In this codebase the coupling is real, so a file-based split could disguise rather than remove it.

### `PosTerminal.vue` has clearer seams

The template already contains two complete workspaces:

- catalog navigation/product grid (`categories-sidebar` and `product-stage`);
- cart sidebar, line editing, numpad, totals, and sale actions.

The script additionally owns:

- product-card presentation and availability long-press behavior;
- catalog/cart price and availability reconciliation;
- active table and QR orchestration;
- socket registration and teardown;
- shift bootstrap;
- page-level modals and navigation.

The catalog and cart workspaces each combine visual layout with their own interaction logic, making them component seams. The global lifecycle, route navigation, socket wiring, and modal coordination belong in the terminal shell unless a later extraction can expose a genuinely small interface.

### Direct `fetch()` is a symptom, not a universal defect

There are 158 direct runtime occurrences, but their ownership differs:

- calls inside `useAuth`, `useProducts`, or `useTerminal` already sit inside feature owners;
- 23 calls inside `orderSessionStore.js` repeat request/JSON mechanics inside the large aggregate;
- 3 calls in `PosTerminal.vue` are misplaced: product availability and category-price refresh belong to product/catalog ownership; shift lookup belongs to auth ownership;
- the 101 admin calls belong to many independent admin features and are outside this POS-foundation scope.

A mass conversion to a generic HTTP wrapper would touch many stable features while preserving the same domain scattering. The useful rule is **components do not own domain transport when an existing feature owner exists**, and repeated order-session endpoints live behind one private order-session API module.

## Primary-source research and its application

### Vue composables

Vue defines composables as units that encapsulate stateful logic and explicitly allows extracting them for code organization, not only reuse. It recommends grouping by logical concern and keeping returned sources explicit. That supports a private table workflow or catalog synchronization module **only when its inputs and outputs remain coherent**, not one helper file per function.  
Source: [Vue — Composables](https://vuejs.org/guide/reusability/composables)

Vue also says to use composables for logic and components when both logic and visual layout are being reused/owned. That supports extracting complete catalog and cart workspace components instead of chopping the template into decorative fragments.  
Source: [Vue — Composables, comparisons](https://vuejs.org/guide/reusability/composables#comparisons-with-other-techniques)

### Pinia store composition

Pinia allows stores to use other stores but documents the circular setup-state restriction. It also describes a flat store architecture rather than nested namespaced modules. That makes a forced cart-store/table-store graph a risky choice here unless dependency direction can first be proven one-way.  
Source: [Pinia — Composing Stores](https://pinia.vuejs.org/cookbook/composing-stores)

Pinia setup stores must expose state for Pinia/devtools to track it. Private implementation modules can still create refs that the owning store returns, but hiding state merely to make a file look smaller would break the model.  
Source: [Pinia — Defining a Store](https://pinia.vuejs.org/core-concepts/)

### Shared state and component boundaries

Vue recommends moving genuinely shared state out of components instead of prop drilling or synchronizing duplicate state. The extracted workspace components should therefore consume the existing facades and must not clone cart/table state into local copies.  
Source: [Vue — State Management](https://vuejs.org/guide/scaling-up/state-management.html)

Vue notes that explicit local component registration makes dependencies easier to locate and maintain. The new workspace components should be locally imported by `PosTerminal.vue`; no global component registration is needed.  
Source: [Vue — Component Registration](https://vuejs.org/guide/components/registration)

### Incremental migration

Martin Fowler's Strangler Fig guidance favors gradual replacement because full rewrites routinely miss existing behavior and delay feature work. This repository has heavily exercised financial and session behavior, so compatibility facades and one seam per commit are safer than a store rewrite.  
Source: [Martin Fowler — Strangler Fig Application](https://martinfowler.com/bliki/StranglerFigApplication.html)

## Candidate comparison

| Candidate | Locality / leverage | Main risk | Decision |
|---|---|---|---|
| Move paid refund logic again | Low; already owned and reused | Duplicates/weakens a good seam | Reject |
| Extract one void use-case module | High; removes SQL and transaction control from Express | Financial behavior drift during move | Adopt with characterization and wiring gates |
| Add controllers + repositories for refunds | Low; mostly pass-through layers | File explosion and navigation cost | Reject |
| Rewrite one endpoint per file | Low | Artificial fragmentation | Reject |
| Split order session into cart/table/checkout Pinia stores immediately | Unproven | Circular state coordination and duplicated transitions | Reject as default |
| Keep store forever because callers are hidden | Medium short-term, poor long-term | Continued feature interleaving | Reject |
| Extract private workflow seams behind unchanged facades | High if dependency budget is small | Context-bag abstraction if forced | Adopt with an abort gate |
| Split `PosTerminal` into tiny presentational pieces | Low | Prop/event explosion | Reject |
| Extract complete catalog and cart workspaces | High | Scoped-style and lifecycle drift | Adopt, one workspace at a time |
| Mass-migrate all 158 fetch calls | Low for this scope | Broad churn, no domain ownership gain | Reject |
| Move misplaced POS transport to current owners and one private order API | High | Response/error contract drift | Adopt with response-shape tests |

## Design invariants

1. `useCart()` and `useTables()` remain the public compatibility interfaces during this work.
2. Components never import private `orderSession/` implementation modules.
3. No duplicate reactive source of truth is introduced.
4. No TypeScript migration, new state library, query library, controller layer, repository layer, or generic integration framework is added.
5. The backend route remains responsible for HTTP parsing and response translation; the void module owns the use case and transaction.
6. `req` and `res` never cross into backend modules.
7. Transaction lock order, audit atomicity, bundle reconstruction, stock restoration, service-charge transitions, and post-commit kitchen behavior remain exact.
8. A private frontend workflow extraction proceeds only if its inbound dependency interface is small and named. A large context bag is a failed design, not success.
9. Each new file must delete or relocate a coherent body of ownership. No file exists only to forward one function.
10. The work is behavior-preserving. UI redesign, payment-terminal integration, admin HTTP migration, and feature additions are separate scopes.

## Brutal conclusion

The backend fix is clear and worth doing now. The frontend needs disciplined incremental extraction, but a grand store rewrite would be architecture theater. The strongest foundation is an unchanged public surface over fewer, deeper private owners, plus two real component workspaces and correct transport ownership. The plan should permit stopping an extraction when the dependency graph proves it shallow; refusing a bad split is part of the design.
# Table workflow dependency gate (execution evidence)

The candidate is the cohesive table/session region: table refs and session tokens, workspace load/activation, table order load/save/print, held orders, split checks, relationships, and table service-charge snapshot coordination. The main action region alone spans roughly 900 lines; including owned state and computed permissions clears the plan's 500-line depth floor.

| Dependency class | Concrete dependency | Boundary decision |
| --- | --- | --- |
| Table-owned state | active table, QR draft, session sequence, settings/sections/tables, workspace loading, splits, held orders | Move; the workflow creates and returns the same refs. |
| Order facts | cart and customer/order metadata, totals, tax mode, service-charge snapshot/removal state | One explicit `readOrderDraft()` capability; no copied refs or mirrored state. |
| Order commands | clear/reset an order draft; refresh service-charge amount | Two named commands, preserving root ownership of general order lifecycle. |
| UI | existing `orderUiStore` instance | One explicit `ui` capability; the workflow does not import another store. |
| Actor/permissions | current user/shift; permission checks | `getActor()` and `can()` capabilities. |
| Service-charge policy | whether automatic table service charge currently applies | `shouldAutoApplyServiceCharge()` capability; the policy remains defined once in the root store. |
| Transport | named functions in `orderSessionApi.js` | One `api` capability. |
| Navigation/presentation | router destinations are already passed per action; dialogs/toasts use the existing global POS surface | No router or component dependency. |

Gate result: **pass, eight named inbound capabilities** (`api`, `ui`, `readOrderDraft`, `clearOrderDraft`, `refreshServiceCharge`, `getActor`, `shouldAutoApplyServiceCharge`, `can`). No generic `context`, `deps`, or `helpers` bag is required. If implementation reveals an additional hidden dependency that pushes the honest interface over 12, the extraction must be abandoned rather than concealed behind a bag.

# Settled facade consumer audit

The post-extraction production scan parsed every `src/**/*.vue` and `src/**/*.js` caller, including direct destructuring and member access through local facade bindings. It found 92 of 102 `useCart()` keys and 49 of 55 `useTables()` keys in active production callers.

Two cart keys with no production read remain intentionally compatible: `activeIdempotencyKey` has a dedicated facade lifecycle test, and `pendingSubscriptionSale` is explicitly pinned by the subscription wiring contract. The other eight unreferenced cart exports were removed: `activeModifierQty`, `editingInvoiceId`, `editingOrderId`, `isCoursingEnabled`, `openCourseModal`, `selectedOrderTypeName`, `serviceChargeTaxRate`, and `showOrderTypeDropdown`.

All six unreferenced table exports were removed: `canHoldOrder`, `dragData`, `saveTableOrder`, `selectedTableId`, `showHeldOrdersModal`, and `tableMode`. Internal state that still coordinates active behavior remains private. The one-line `saveTableOrder()` alias and the dead root members `isCoursingEnabled`, `openCourseModal`, `selectedOrderTypeName`, and `serviceChargeTaxRate` were deleted because repository-wide searches proved they had no independent production or test role. Final facade sizes are 94 cart keys and 49 table keys.

# Final execution verification

- Static ownership: the two facades are the only production callers of `useOrderSessionStore()`; `PosTerminal.vue` and `orderSessionStore.js` contain zero direct `fetch()` calls; components contain zero private order-session imports; package manifests are unchanged; the 101 admin transport calls are untouched.
- Focused frontend/state union: 12 files and 195 tests passed, covering session boundaries, store behavior, UI state, checkout/split transforms, request owners, authentication hydration, component ownership, and refund wiring.
- Refund transaction integration: 60 tests passed.
- Table integration: 182 table tests and the table post-commit test passed.
- Production build: 280 modules transformed successfully.
- Real browser smoke at 390x844: cashier login, shift, catalog selection, mobile cart opening, cash checkout, and paid-success state passed against the test database.
- Real browser table smoke at 1280x800: waiter login, table open, product add, table save, return navigation, and occupied floor-plan state passed against the test database.

The configured Playwright health check cannot serve clean SPA routes from a Git worktree whose absolute path contains `.worktrees` because Express `sendFile()` treats the dot-prefixed path segment as hidden. The smoke harness therefore fulfilled `/pos` and `/tables` documents from the same server's compiled `/index.html`; all API, authentication, database, router, and Socket.IO traffic remained on the real test server.
