# Call-center branch review — findings and gaps

- **Date:** 2026-08-11
- **Branch:** `codex/call-center-held-orders`, HEAD `2ab654e0` (4 commits)
- **Fixed point:** `master` @ `f9afa969` (merge-base; diff `git diff f9afa969...HEAD`, 92 files, ~3,972 insertions)
- **Method:** three parallel review agents (spec completeness vs the 2026-08-10 plan + cancellation design; regression impact on existing flows; security wall + migration packaging), with every headline finding independently re-verified in code by the aggregating reviewer.
- **Spec sources:** `docs/superpowers/plans/2026-08-10-call-center-held-orders.md`, `docs/superpowers/specs/2026-08-10-call-center-order-cancellation-design.md` (foundation plan `2026-08-10-held-order-lifecycle-hardening.md` already on master, excluded).

## Verdict

The feature is substantially complete and the fixed-role security contract genuinely holds at the backend. The branch is **not merge-ready as-is**: it carries 2 confirmed regressions to existing non-call-center functionality, 3 confirmed defects inside the new feature, and 1 project-rule violation. All fixes are small and targeted; nothing is architecturally wrong.

## Verified strengths

These were checked in code / by computation, not taken from the handoff:

- **Fixed-role wall (defense in depth).** `PermissionService.loadUserPermissions` returns `[]` for role `call_center`; `userHas()` hard-returns `false`; `normalizeSessionUser` (backend/middleware/auth.js) strips `permissions`/`allowed_sections` on login, cache pre-warm, cache hit, and DB fallback — a stale `user_permissions` row can never activate. Checkout (all 4 routes), refunds, expenses, service charges, subscriptions, tables, print, drawer, shifts (in-transaction with `FOR UPDATE` row lock in both `auth.js` and `admin/shifts.js`), manager override, and admin routes all reject the role server-side. `executeCheckout` independently 403s the role before any work and blocks platform settlement of phone holds (`CALL_CENTER_PLATFORM_SETTLEMENT_FORBIDDEN`). Call-center sockets never join `staff` (server.js).
- **Attribution cannot be forged.** Cashier `POST /held_orders` strips `call_center_user_id`; order attribution at settle comes only from the locked held row inside `executeCheckout`. Role flips are caught in-transaction by `lockActiveCallCenterActor`; admin role changes wipe grants in the same transaction and evict sessions + sockets.
- **Migration packaging correct by computation.** `.auto.sql` normalized SHA-256 matches `auto-manifest.json`; evidence `.sql` == `.auto.sql`; Hostinger fallback block is a verbatim copy between correct `BEGIN/END AUTO MIGRATION` markers (no DELIMITER/routines/definers); predecessor chain (`held-order-lifecycle-v1`) and target checksum consistent across manifest, `schemaValidation.js`, `bootstrap-database.js`, and baseline. `npm run architecture:check` passes.
- **Audit atomicity respected.** Create/update/claim/release/follow-up/cancel all append audit rows via `conn` before commit; audit failure rolls back. Cancellation records `call_center_user_id` provenance and honors the `xyz=1` suppression contract.
- **Input validation.** `customerPhone.js` is strict (type check, char whitelist, 6–20 digits); all queries parameterized; delivery date regex + roundtrip validated; call-center payloads denylist-checked for financial authority at create and continuation; held carts server-repriced by `canonicalizeHeldCart`.

## Confirmed regressions to existing flows (must fix)

### R1 — Public QR menu loses live availability updates
- **Where:** `backend/routes/pos/catalog.js:464`
- **What:** `req.io.emit('product_availability_changed', payload)` was changed to `req.io.to('staff').emit(...)`. Public QR customer sockets join only `table_room_<id>` (`server.js:360`), never `staff`, but `src/menu/MenuApp.vue:468` listens for this event (pre-existing behavior at f9afa969).
- **Failure scenario:** cashier marks an item unavailable → every customer browsing the QR menu keeps seeing it as orderable until a full page reload.
- **Fix:** restore the global emit for this event (or additionally emit to table rooms). The plan never asked for this scoping.

### R2 — Any 401 now destroys the cashier's persisted draft
- **Where:** `src/shared/authInterceptor.js:38`
- **What:** every internal-API 401 now calls `clearPosOrderSession(localStorage)`, wiping cart, order note, discount, order context, active-table pointer, held-claim handoff, and checkout-attempt cache — for **all roles**. At f9afa969 a 401 removed only `pos_user`, and the draft survived re-login.
- **Failure scenario:** cashier builds a cart, idles past session TTL, next click → 401 → cart and table-session pointer gone; an in-flight held-order claim handoff is orphaned until claim expiry. Contradicts the app's "items still in the cart" guarantee.
- **Fix:** gate the wipe to call-center sessions (its evident purpose) or drop it from the interceptor.

## Confirmed defects in the new feature (should fix before merge)

### D1 — Phone proof on claim is fail-open (customer PII exposure)
- **Where:** `backend/routes/pos/orders.js:253` (guard `if (phone != null && ...)` inside `assertCallCenterHeldRow`), claim route ~`:491` passes `req.body?.customer_phone`.
- **What:** a call-center client that simply **omits** `customer_phone` skips phone matching entirely and receives the full cart including customer name/phone/address for any guessed held ID + version (versions start at 1). The plan requires the normalized phone as proof before PII is returned ("guessed ID/version input cannot reveal another customer's cart"). Exposure is limited to authenticated call-center actors, but it defeats the stated design. All existing tests send the field, so the hole is untested.
- **Fix:** fail closed — require and match `customer_phone` whenever the actor is call_center; add a test that omits the field.

### D2 — Reconnect cannot fail closed on version conflict; overwrites local draft
- **Where:** `src/pos/stores/orderSessionStore.js:864` (`reconnectCallCenterOrder`)
- **What:** the expected version is taken from a **fresh server search** (`matches.find(...)`, then `continueCallCenterOrder(current)`), not from the locally stored claim context. A version changed by another worker therefore never conflicts — the reclaim succeeds at the new version and `restoreHeldOrder` replaces the worker's unsent local edits with the server row.
- **Spec:** plan line 413: "A changed version fails closed, preserves the local draft, and refreshes the exact-phone matches; it never overwrites."
- **Fix:** claim with the stored context version; on 409, keep the draft and refresh matches.

### D3 — Follow-up silently resurrects a cleared discount
- **Where:** frontend payload builder in `src/pos/stores/orderSessionStore.js` (~line 1014: `order_discount` now omitted when value is 0; previously always sent) + backend merge `nextPayload = {...previousPayload, ...submitted}` at `backend/routes/pos/orders.js:1028`.
- **Failure scenario:** restore a hold carrying a 10% discount, clear the discount, add an item, send FOLLOW UP → the hold's `cart_data` still contains the 10% discount, which re-applies at settle. The PATCH/save path still overwrites; only follow-up is affected.
- **Fix:** always send `order_discount` (restore the pre-branch behavior) or make the backend merge treat absence as explicit zero for this field.

## Process / spec gaps

### G1 — `docs/architecture.json` not updated (CLAUDE.md violation)
`git diff f9afa969...HEAD -- docs/` is empty. A new role, two new columns, and five new/changed endpoints is a major-flow change; the project rule requires the map update in the same commit. `architecture:check` passes only because it validates existing references, not coverage of new flows.

### G2 — Playwright covers roughly half of the plan's 20 required browser steps
Present: role creation, stale-state login, no-shift intake, Enter-key probe, cashier toast/badge/filter, worker-B follow-up + cancel with ticket/audit. Missing browser proof for: retry/response-loss (step 9), sent-line reduction guidance + metadata-only save (10), lease expiry/reconnect/version conflict (11), lost cancel response with fired + `xyz=1` (13), `xyz=1` no-audit (14), failure injections (16), cashier checkout copies source + failure recovery (17), step 19, and step 20 is intake-only for the both-themes matrix (match list, cancel confirmation, cards not proven in both themes). Backend Vitest covers much of the 13/14/16 logic, but the plan demanded browser proof.

### G3 — Minor spec deviations
- No compact customer-identity strip with an Edit affordance after Start Order (contract item 5); identity is editable only inside the Send Order modal.
- Cancellation-reason bilingual labels deviate from the design doc's exact strings (e.g. "الزبون غيّر رأيه" vs the approved "العميل غيّر رأيه"); the plan says "exactly as defined".
- Source filter ships a third "Other orders" option beyond the specified All/Phone (benign scope creep).
- Plan-listed test files untouched; role walls were consolidated into the new `callCenterRoleWalls.test.js` with good route coverage (file-list deviation only).

## Lower-confidence findings / owner decisions

- **Claim release skipped on permission-only edits** — `backend/routes/admin/users.js:217`: `releaseActiveHeldClaims` now runs only when the role changes (was unconditional on every PUT). Revoking `pos.hold_orders` from a cashier holding an active claim leaves the hold locked until claim expiry.
- **Customer-phone autofill behavior change** — `backend/routes/pos/catalog.js:500`: duplicate phone numbers now 409 (`CUSTOMER_PHONE_AMBIGUOUS`) and <6-digit input 400s; the frontend swallows both silently, so autofill just stops for existing duplicate data.
- **Cancellation ambiguous-failure reconciliation** relies on `phone-matches`, which JOIN-filters on active non-deferred order types — deactivating the row's order type mid-failure would make the client wrongly treat a failed cancel as committed and clear the draft.
- **Shift-open response change** — missing/inactive target users now 404 (hardening, but a changed response shape); any admin user PUT/DELETE now drops the target's live socket even for a name edit (auto-reconnects).
- **Smells (judgement calls):** `router.use(requireAuth, rejectCallCenterRole)` at `backend/routes/pos/tables.js:98` falls through to routers mounted after it in `backend/routes/pos.js` (double `requireAuth`, unmatched `/api/pos/*` now 401 instead of 404, silent trap if a public route is ever added later — no current route breaks); ~10 raw `role === 'call_center'` string comparisons in PosTerminal.vue plus store/composables despite existing `isCallCenterRole`/`isCallCenter` predicates.

## Recommended fix order

1. R1 (QR menu emit) and R2 (401 draft wipe) — regressions visible to real users on day one.
2. D1 (fail-open phone proof) — PII vs stated contract; smallest diff of the three.
3. D2 (reconnect fail-closed) and D3 (follow-up discount).
4. G1 (architecture map + `npm run architecture`) in the same fix commit series.
5. G2/G3 and the owner-decision items as follow-ups at the owner's discretion.

## Handoff-claim discrepancies

The 2026-08-11 handoff states the final aggressive review fixed "an architecture-boundary leak" and that `npm run architecture:check` passed. The check does pass, but no `docs/` file changed in the branch — the map was never extended for the new flows (G1). All other handoff verification claims were consistent with what this review observed.

## Execution and integration record

- Base branch at feature start: `master` at `f9afa969`.
- Original call-center feature range: `217c6ab2`, `4b843a87`, `eaadae60`, `2ab654e0`.
- Review fixed point: `2ab654e0`.
- Review-fix range: `f19d1b43`, `792ff1e8`, `d382879f`, `0fe48446`, `6088ec66`, `80b73cff`, `3d8983db`, `3c5662f9`, `ec2ed2ab`.
- Recorded review tip before integration metadata: `ec2ed2ab804245ac86c335d155f800fe7a3b2b08`.
- Scoped browser verification passed: call-center 6/6; held-order lifecycle plus call-center 11/11; production build and architecture integrity passed.
- The final full Vitest run exposed one pre-existing stale print-template source assertion at the merge base. The assertion still listed four kitchen heading types after `follow_up` and `cancel` were introduced by the held-order lifecycle work; integration preparation updates that test contract without changing production behavior.
