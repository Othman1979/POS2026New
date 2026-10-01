# Phase 4 POS State Ownership — Owner Break Prompt

You now own Phase 4. Treat Terra's implementation, the Phase 4 plan, and the
existing tests as claims to disprove. Use ponytail at full intensity: reject
real defects and unnecessary machinery, but do not invent architecture or
expand into Phase 5.

## Scope lock

- Review `master...HEAD` on `codex/pos-state-ownership`, plus any working-tree
  changes. Establish the base with `git merge-base master HEAD`; never assume
  the documented base is current.
- Read the Phase 1–4 plans, roadmap, evidence, every changed file, every direct
  caller, and every test asserting the changed interfaces.
- Do not modify production code during the audit. Findings must be proven
  before fixes are authorized.
- Do not add stores, dependencies, backend/schema changes, path moves,
  callback bags, or generic persistence abstractions.
- Do not mistake a passing static source-text assertion for runtime proof.

## Owner invariants

1. `useOrderSessionStore` remains the only persistent Order/Table state owner;
   `useOrderUiStore` remains the transient UI owner.
2. `useCart()` and `useTables()` retain their exact keys, ref/function
   semantics, and router wrappers. Components import facades, never leaf
   modules.
3. Split transformations conserve quantity and money and preserve the Phase 1
   Saved Order Line financial identity consumed by Phase 2/3 settlement.
4. Checkout transformations freeze the intended request/receipt inputs while
   the existing cache remains the only idempotency implementation.
5. One named persistence adapter owns Order/Table session keys and cleanup.
   Logout, idle expiry, cashier switch, and held-order handoff cannot leak or
   recreate stale state.
6. One table-session token invalidates every stale Table A continuation after
   leave or switch to Table B. Normalization preserves every field consumed by
   Phase 2 save and Phase 3 checkout.
7. HTTP, permissions, alerts, printing, navigation, and Pinia/Vue mutation stay
   in the store. Phase 1–3 backend modules, URLs, payload shapes, middleware,
   SQL, and query counts remain untouched.
8. Each extracted module earns its interface. Apply the deletion test: if it
   is merely pass-through machinery, report the smallest deletion or merge.

## Attack sequence

### A. Diff and wiring truth

- Inventory every changed path and export/import edge.
- Search all runtime callers and destructuring sites for facade bypasses,
  stale imports, missing exports, unused exports, and circular/upward imports.
- Compare the implementation against every Phase 4 task and explicit
  deferral. Account for deviations in both directions: missing work and extra
  work.

### B. Phase 1→4 contract chain

- Trace a frozen table line from Phase 1 `SavedOrderLines`, through Phase 4
  split identity/payload construction, into Phase 2 table save and Phase 3
  checkout. Compare field names, nullability, numeric coercion, modifiers,
  tax, surcharge, discount, IDs, and quantities.
- Trace checkout request/result/idempotency ownership from the Phase 4 browser
  transformation through the Phase 3 route/module response.
- Trace active-table identity and normalized fields into all table-save,
  split-settlement, guest-check, and checkout callers.

### C. Adversarial behavior

- Split: malformed/zero/non-finite/fractional quantities; same product with
  different persisted IDs, price, note, modifiers, tax, surcharge, and
  discounts; cent remainders; empty/single seats; conservation and payload
  parity.
- Checkout: mutate cart/table/customer/payment/order type/user/shift after the
  request starts; duplicate success; missing/present server receipt; print
  failure; Table A resolving after Table B becomes active.
- Persistence: malformed JSON, throwing storage, empty/zero/null values, deep
  cart mutation, repeated mount, consume-once handoff, watcher recreation,
  logout/idle/admin clear, and cashier switch.
- Tables: pause every load/save/draft/checkout continuation, then leave/switch;
  use null/string/number IDs and verify no stale cart, QR, active table, error,
  receipt, or navigation is applied.

### D. Test honesty

- Verify tests execute runtime behavior rather than matching implementation
  text where behavior is practical.
- Find branches introduced or moved without direct regression coverage.
- Run the smallest relevant cohorts for each hypothesis. Run the full suite
  only after concrete production fixes, or to close the existing unresolved
  final gate once the test database is trustworthy.
- Treat the schema-drift blocker as unresolved evidence, not as a Phase 4 pass
  or failure. Report exactly what can and cannot be concluded.

### E. Ponytail deletion pass

- Find duplicated formulas, key lists, normalizers, wrappers, one-caller
  exports, speculative options, callback indirection, dead aliases, and tests
  coupled to private implementation.
- Report a complexity finding only when a smaller implementation preserves the
  owner invariants and testability. End this section with `net: -N lines
  possible`, or `Lean already. Ship.`

## Evidence and reporting

For each finding provide:

- severity `P0`–`P3`;
- exact file and line;
- reproducible input, sequence, or import trace;
- violated plan/phase invariant;
- user-visible or maintenance consequence;
- smallest correction and smallest regression test.

Findings come first. Separate confirmed defects, plan misalignments,
maintainability weaknesses, and residual test gaps. Do not report style
preferences, theoretical risks, or failures caused solely by an unprepared
test database. If no issue is found, say so and state the remaining blind
spots. Never mark Phase 4 complete until the final gate has fresh, conclusive
evidence after the last production change.
