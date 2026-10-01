# Phase 4 POS State Ownership — Owner Audit

**Branch:** `codex/pos-state-ownership`

**Reviewed commit:** `b3ecffe134103d8c43b902c293bbac50a6e5a8c9`

**Merge base:** `bb71cccba8fcee82ee6f9a9a67ff7643eb923c1a`

## Confirmed findings

### P1 — A stale checkout releases the next session's processing lock

- **Location:** `assets/js/composables/stores/orderSessionStore.js:2526-2625`
- **Reproduction:** Start checkout for Table A; clear that table session; enter Table
  B and start its checkout; resolve Table A while Table B is still pending. Table
  A's unconditional `finally` sets shared `ui.isProcessing` to `false`.
- **Consequence:** Table B's payment button becomes enabled while its request is
  still in flight. A third submission can be sent. Phase 3 server idempotency reduces
  duplicate-charge risk, but it does not make the frontend ownership error safe.
- **Violated invariant:** A stale Table A continuation must not mutate Table B UI
  state; Phase 4's table-session ownership is incomplete.
- **Smallest correction:** Give checkout processing the same monotonic request-owner
  check used by table saves, and clear `isProcessing` only for the latest request.
- **Regression:** Keep Table B unresolved after Table A completes and assert
  `ui.isProcessing === true` until Table B finishes.
- **Proof:** A temporary focused Vitest regression failed with `expected false to be
  true` at that assertion. The temporary test was removed after recording evidence.

### P2 — Split-prefill activation does not invalidate the previous table session

- **Location:** `assets/js/composables/stores/orderSessionStore.js:1000-1010`
- **Reproduction:** Start `loadActiveTableDraft(7)` for the parent table; activate a
  stored split payload with the same table ID through `pos_table_prefill`; resolve the
  parent draft. The split path assigns `activeTable` without advancing
  `tableSessionSeq`, so the parent response writes `activeQrDraft` into the split
  session.
- **Consequence:** A stale QR draft can appear in the restored split workflow and be
  imported into the wrong check.
- **Reachability note:** The current source tree has no writer for
  `pos_table_prefill`, so this is primarily a legacy/handoff path rather than the main
  table-entry path. The exported activation behavior is still incorrect and its key is
  deliberately retained and consumed by Phase 4.
- **Violated invariant:** Every enter/switch/leave transition must invalidate stale
  continuations, even when the old and new contexts share a table ID.
- **Smallest correction:** Route split activation through one enter/switch operation
  that invalidates first; then normalize and persist the active split table.
- **Regression:** Resolve a parent-table draft after same-ID split activation and
  assert the split session retains a null draft.
- **Proof:** A temporary focused Vitest regression failed with the stale cart
  `[{ product_id: 5, qty: 3 }]` instead of `null`. The temporary test was removed.

### P2 — Persistence ownership is not canonical and the plan has no legal repair seam

- **Locations:** `src/components/PosTerminal.vue:1606-1652`,
  `src/components/OrderNotes.vue:645-692`,
  `assets/js/composables/stores/orderSessionStore.js:1000-1100`, and
  `assets/js/composables/stores/orderSession/orderSessionPersistence.js:3-70`
- **Evidence:** Components and the store still read/remove `pos_restore_held_order`,
  `pos_active_table`, and `pos_table_prefill` directly. Three extracted semantic
  operations (`readActiveTable`, `consumeStoredJson`, and `hasPendingTableSession`)
  have no runtime callers.
- **Consequence:** Key names and malformed-data behavior still have multiple owners;
  future key/path changes remain grep-driven and the new adapter gives a false source-
  of-truth signal.
- **Plan conflict:** Task 4 requires rewiring the `PosTerminal` handoff, while the
  global dependency rule forbids components importing leaf modules and freezes the
  facade key sets. No permitted caller seam is specified. Terra briefly crossed the
  leaf boundary and then reverted it, leaving the task incomplete.
- **Smallest correction:** Amend the plan first. The least invasive viable seam is a
  small public browser-session adapter (the existing `posSessionStorage.js`) exposing
  named handoff/table operations; components remain off leaf modules and Vue facade
  keys stay unchanged. Rewire all current writers/readers in the same commit.
- **Regression:** Static ownership test must enumerate runtime key literals and reject
  owned storage mechanics outside the adapter and the checkout cache.

### P2 — Active-table normalization still has multiple implementations

- **Locations:** `assets/js/composables/stores/orderSession/tableSession.js:21-42`,
  `assets/js/composables/stores/orderSessionStore.js:565-580`, and
  `assets/js/composables/stores/orderSessionStore.js:917-934`
- **Evidence:** `loadTableOrder` uses `normalizeActiveTable`, but
  `loadActiveTableOrder` independently rebuilds nearly the same object, and stored
  split activation assigns parsed data without normalization.
- **Consequence:** Adding or correcting a table identity/display field can update one
  path but not empty-table or restored-split paths. The advertised normalization
  source of truth does not exist yet.
- **Smallest correction:** Use `normalizeActiveTable` at all three entry points, with
  explicit overrides for parent-table/original-table fields.
- **Regression:** Feed the same table through load, empty-table activation, and split
  restoration; compare every normalized identity/display field.

### P2 — Split merge identity omits bundle composition

- **Location:** `assets/js/composables/stores/orderSession/splitChecks.js:5-17`
- **Reproduction:** Move two same-ID, same-price, same-note bundle parents whose
  `bundleItems` contain different products. `moveSplitItem` merges them and retains
  only the destination bundle children.
- **Consequence:** The module contract does not preserve full line identity. Current
  persisted table lines are usually separated by `order_item_id`, which limits present
  reachability, but an unsaved or malformed line can lose fulfillment and bundle
  integrity data.
- **Phase linkage:** Phase 1–3 treat persisted bundle children and saved-line identity
  as authoritative. Phase 4 must not collapse a distinct bundle snapshot before those
  modules validate it.
- **Smallest correction:** Include the canonicalized bundle snapshot in merge identity,
  or explicitly reject movable lines lacking the persisted `order_item_id` required by
  the split endpoint.
- **Regression:** The reproduced two-bundle move must produce two destination lines.

### P3 — “Safe” persistence operations are not safe when storage is unavailable

- **Location:** `assets/js/composables/stores/orderSession/orderSessionPersistence.js:26-41`
- **Reproduction:** A storage adapter whose `getItem` and `removeItem` throw causes
  `readOrderSnapshot` to throw; `readJson` catches the read then throws from cleanup.
  `note` is also read outside the guarded helper.
- **Consequence:** The implementation and test surface do not satisfy the plan's
  unavailable-storage case. Some callers catch this, but watcher writes and session
  cleanup can still escape.
- **Smallest correction:** Decide the policy explicitly: either best-effort guarded
  storage with one warning, or document storage availability as a runtime requirement.
  Do not silently claim both.
- **Regression:** Throwing `getItem`/`setItem`/`removeItem` adapter across read, write,
  consume, and clear operations.

### P3 — Execution records are stale and incomplete

- **Locations:** `docs/superpowers/plans/2026-07-23-pos-state-ownership.md:11-400`
  and `assets/js/composables/stores/orderSessionStore.js:839`
- **Evidence:** The plan still says application work has not started and every step is
  unchecked. The store retains a “Task 6 Stubs/Placeholders” label over real code. The
  evidence file omits the final commit and final 3,043-line store count.
- **Consequence:** A lower agent cannot tell implemented work from pending work, and
  may repeat or overwrite Phase 4.
- **Smallest correction:** Record implemented/verified/blocked status per task, remove
  the stale placeholder label, and keep the final full-suite gate explicitly blocked.

## Phase 1–4 alignment

- Phase 1 `SavedOrderLines`, Phase 2 table transaction modules, and Phase 3
  `executeCheckout` are unchanged by `master...HEAD`.
- Public checkout, table-order, and table-split endpoint ownership remains in the
  existing store/route chain.
- The facade contract and upward-import constraints pass.
- The broken split merge identity can erase bundle data before Phase 1–3 validation.
- Phase 3 idempotency limits the stale-checkout double-submit consequence, but does
  not correct Phase 4's UI owner race.
- Phase 5 path migration has not leaked into this branch.

## Verification evidence

- Existing cross-phase and Phase 4 owner cohort: **9 files / 52 tests passed**.
- Temporary adversarial regressions: **four assertions failed as intended** across
  split bundle identity, unavailable storage, split-prefill invalidation, and checkout
  processing ownership. Temporary tests were removed after recording the failures.
- `git diff --check`: passed.
- Production build was already run after the last production change and passed; this
  audit changed documentation only, so it was not rerun.
- The full `npm run test:unit` gate remains inconclusive because the test database
  schema is drifted. This audit does not reinterpret that environmental blocker as a
  pass or as a Phase 4 defect.

## Ponytail deletion pass

- `orderSessionStore.js:917-934`: **shrink:** second active-table normalizer; use the
  existing normalizer with explicit overrides.
- `orderSessionPersistence.js:52-64`: **delete or wire:** three runtime-unused exports
  and their test-only interface. Wire them through the approved public session adapter,
  otherwise remove them.
- `orderSessionStore.js:839`: **delete:** stale placeholder comment; nothing replaces
  it.

`net: -15 lines possible` after using one normalizer; more deletion depends on the
canonical-persistence seam decision.

## Owner verdict

**Resolved and merge-ready.** Commit `52134798` corrected every confirmed finding in
severity order. Checkout completion now releases only its own current request; split
prefill invalidates the previous table-session token; all active-table entry paths use
one normalizer; browser-session mechanics are routed through the public
`posSessionStorage.js` adapter; split identity includes bundle composition; and storage
access is best-effort when the browser adapter throws. The stale placeholder label was
removed and the plan records its implemented state.

Permanent regressions cover each correction. The owner-fix cohort passed 7 files / 163
tests, the Phase 1–3 linkage cohort passed 4 files / 33 tests, the production build
passed, schema drift was zero, and the final wrapper passed 170 files / 1,766 tests.
Phase 5 path migration remains untouched.
