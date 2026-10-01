# POS and Tables runtime audit — Vue/Vite frontend, 2026-09-24

Audit only. No application code, dependency, configuration or database change. The only new artifacts are this report and the ignored measurement recipe/results under `scratch/vue-audit-2026-09-24/`.

Scope: the [revised plan](../plans/2026-09-24-pos-performance-plan.md) as a starting point, checked against the actual source on `codex/retire-subscriptions` (HEAD `7a7e25c7`, no working-tree changes under `src/`), current official Vue 3.5 guidance, and fresh **production-build** measurements. Prior findings ([Opus audit](2026-09-24-pos-performance-opus-audit.md), [Vue Guide findings](2026-09-24-vue-guide-runtime-findings.md), [plan review](2026-09-24-pos-performance-plan-review.md)) are referenced, not re-derived.

## Verdict in one paragraph

Rendering is already cheap: every cart action measured (select row, quantity 1→2→1, deselect) presents in **5–10 ms at 4× CPU** in the production build, English or Arabic. What the cashier actually waits on is **blocking `mode="out-in"` transitions**: the route fade (POS↔Tables **395/195 ms → 30 ms**), the floor-plan section fade (**~200 → 38 ms**) and the checkout payment-method fade (**~275 → 40 ms**). The plan covers only the first. The second largest cost is **request churn that also wipes the category cache**: stock events (already proven) and, newly identified, every KeepAlive re-activation of the POS. The plan's "narrow catalog updates" step should be demoted: it is a correct dependency analysis but the measured saving is a few milliseconds and not user-visible.

## Method

- Recipe: `scratch/vue-audit-2026-09-24/harness-transitions.cjs` (derived from the existing `scratch/opus-audit/harness.cjs`; synthetic read-only JSON fixtures, real Socket.IO, writes rejected, no server/DB import). Fixture: 12 categories × 120 products, 40 tables in **two** sections.
- Build: `scratch/opus-audit/noenv-dist`, a **production** Vue build of the current source (no `[Vue warn]` in emitted chunks; no `src/` file newer than the build). This corrects the dev-build caveat on earlier numbers.
- Chromium 148.0.7778.96 headless, Node 24.16.0, CDP CPU throttle 4×, 0 ms RTT, English desktop 1440×900 and Arabic mobile 390×844, 5 rounds × 3 iterations (n = 15 per cell), variants interleaved.
- A/B without code change: variant `notrans` injects test-browser-only CSS `transition:none !important` on `.fade-*`, `.section-fade-*` and `.checkout-state-*` active classes. Vue detects no CSS transition and resolves enter/leave on the next frame ([Transition docs](https://vuejs.org/guide/built-ins/transition), "Transition Modes"). This isolates the blocking cost of the transitions from everything else.
- "Presented" = predicate true on the DOM, then one `requestAnimationFrame` plus a macrotask. Script/style/layout deltas come from CDP `Performance.getMetrics`. Results: `scratch/vue-audit-2026-09-24/results/transitions-cpu4.json`; all 20 runs had zero page/console errors, zero unmapped endpoints, zero write attempts.
- Limits: loopback, synthetic simple products, 4× throttle on an i7-14700KF is not a low-end PC. Numbers are directional, not customer claims.

## Measurements (median [min–max] ms, n = 15)

| Interaction | EN desktop base | EN desktop no transition | AR mobile base | AR mobile no transition |
| --- | ---: | ---: | ---: | ---: |
| POS → Tables presented | **395** [386–514] | **31** [19–169] | 391 [372–508] | 27 [18–157] |
| Tables → POS presented | **195** [175–259] | **31** [19–100] | 204 [181–329] | 37 [22–83] |
| Floor section 1 → 2 | **198** [184–211] | **37** [30–41] | 200 [182–235] | 38 [30–41] |
| Floor section 2 → 1 | 192 [187–215] | 39 [29–39] | 207 [163–217] | 39 [37–42] |
| Checkout: open dialog | 5 [2–66] | 10 [2–67] | 10 [4–50] | 11 [5–54] |
| Checkout: cash → card | **276** [256–279] | **39** [29–42] | 274 [256–278] | 42 [37–44] |
| Checkout: card → cash (tendered input painted) | **275** [258–278] | **40** [18–47] | 274 [259–277] | 42 [11–44] |
| Checkout: close | 6 [1–11] | 7 [2–13] | 8 [4–11] | 8 [1–17] |
| Cart: select row | 9 [5–14] | 10 [5–16] | 10 [7–13] | 10 [7–15] |
| Cart: qty 1 → 2 (numpad) | 6 [1–15] | 6 [1–14] | 8 [3–15] | 6 [3–13] |
| Cart: qty 2 → 1 | 9 [3–13] | 10 [6–20] | 10 [5–14] | 9 [8–12] |
| Cart: deselect | 10 [7–63] | 9 [4–24] | 10 [5–17] | 9 [8–15] |

Cart-action breakdown (base, medians): script 0.7–1.6 ms EN / 1.4–3.2 ms AR; style 1–4 ms; layout ≤ 2 ms. Arabic translation walkers per action: select/deselect 1 walker, 41 text nodes visited (cart panel only); quantity change 2 walkers, 163 nodes (cart panel plus the catalog grid). Route and section switches were unchanged by the cart work and vice versa, so the columns are independent.

## Confirmed findings

### 1. Route fade: confirmed in production, 395/195 → ~30 ms

`src/App.vue:2–23` wraps `router-view` in `<transition name="fade" mode="out-in">` (150 ms, `App.vue:246–254`). With `out-in`, Vue inserts the entering route only after the leaving one finishes, so KeepAlive switches pay the leave before the retained screen is even re-attached. POS → Tables also includes the floor plan's forced reload on activation (`TableFloorPlan.vue:1052–1055`), which is why the base number is higher than the return trip.

Recommendation unchanged from the plan: remove the route-level Transition, keep `keep-alive :include` and both boot shells. Do not use `:css="false"` (crashes on first render per the earlier audit). If a visual cue is wanted later, use an enter-only CSS animation on each route root that does not gate mounting.

### 2. Floor-plan section switch has the same blocking mechanism — not in the plan

`src/components/TableFloorPlan.vue:181–182`: `<transition name="section-fade" mode="out-in">` around `<div :key="activeSection">`, 150 ms opacity+transform (`TableFloorPlan.vue:2052–2063`). Every tab tap (and every swipe, `handleSwipeLeft/Right` at 801–815) unmounts the whole grid, waits 150 ms, then mounts the new section. Measured **~200 → 38 ms** presented.

Recommendation: drop `mode="out-in"` and the leave phase. Keying the wrapper by section is still useful for scroll reset; an enter-only animation (`section-fade-enter-*` only, or a keyframe on `.tables-grid`) keeps the visual cue without a blocking leave. Verify swipe, join/transfer mode bars, empty-section state, RTL translate direction and the section room join/leave watcher (`TableFloorPlan.vue:849–860`).

### 3. Checkout payment-method switch delays the tendered input by ~235 ms — not in the plan

`src/components/pos/CheckoutModal.vue:229`: `<Transition name="checkout-state" mode="out-in">` around the cash/card/split/platform panes; CSS at `src/pos.css:2338–2348` (180 ms opacity, **220 ms transform**). Switching to cash makes `#checkout-tendered` appear only after the 220 ms leave, then it fades in. Measured **~275 → 40 ms**. A cashier who types the tendered amount immediately after tapping CASH is typing into nothing for a quarter second.

Recommendation: remove `mode="out-in"` here; keep an enter-only fade if desired. The opus audit flagged this as "measure first"; it is now measured. Keep the dialog-level `pos-modal` transition: dialog open/close is 5–10 ms because the panel mounts immediately and only the backdrop animates.

### 4. KeepAlive re-activation of the POS re-reads everything and wipes the category cache — not in the plan

`src/components/PosTerminal.vue:1285–1334` (`onActivated`): after the first activation every return to `/pos` awaits `terminal.loadSettings()` and `fetchHeldOrderSummary()`, then `refreshCatalogAndCart()` → `products.fetchData({ forceFull: true })` (`PosTerminal.vue:927–931`) → `invalidateCatalogSnapshots()` (`src/pos/useProducts.js:148–155, 331`) → all six cached category scopes are dropped, the non-lightweight catalog payload is fetched, all 120 cards are re-patched, and `refreshCartCatalogPrices` POSTs `category-prices/resolve` when the cart has items. Net per Tables → POS return: 3–4 requests, one full grid re-render, and the next few category taps go to the network again.

The reason is legitimate: `onDeactivated` (`PosTerminal.vue:1369–1396`) removes every socket listener, so events (stock, availability, settings, held orders) and reconnects that happen while the floor plan is visible would otherwise be missed. That does not require an unconditional refresh, only a *dirty* signal.

Recommendation (design, then prototype): keep lightweight "dirty" listeners registered across deactivation (or a small module-level counter in `useSocket.js` incremented on `connect` after a `disconnect`, plus per-event dirty flags set by tiny handlers). On activation, refresh exactly what is dirty: catalog only if an inventory/availability/settings/reconnect signal arrived; held summary only on `held_orders_changed`; settings only on `settings_changed`. Unknown state (first activation, counter changed) keeps today's full refresh. This preserves every correctness guarantee the current code relies on while removing the common-case cost. The floor plan (`TableFloorPlan.vue:1052–1055`, one `get_tables` read per activation) could use the same signal but its single request is cheap and tables change often; lower priority.

This shares the invalidation mechanism with the stock-event churn the plan already targets (plan §3); implement the coalescing/scoping there once and reuse it here.

### 5. Stock-event churn: prior evidence stands

Mechanism and cost were proven in the opus audit (§3) and corrected in the plan review (§Phase 2). Source unchanged: `PosTerminal.vue:933–943` → `fetchData({ forceFull: true })`. Nothing new to add except finding 4 above, which multiplies the cost for waiters who alternate between the floor plan and the register.

### 6. Catalog re-render coupling exists but costs milliseconds

The dependency chain identified earlier is real: `PosCatalogWorkspace.vue:201–215` (mobile summary reads `cartItems.length` and `cartTotal` under `lg:hidden`), `productQuantities` (`:266–269`) and `productCardStyles` (`:340–343`) build new Maps on every cart mutation. Measured effect in production at 4× CPU: quantity change **script 0.8–1.6 ms EN, 2.3–3.2 ms AR**, presented 6–10 ms; selecting a cart row does **not** walk the catalog in Arabic (41 nodes = cart panel only), so `selectedCartIndex` only couples when a notes-category product is on screen (`isNoteActive`, `:335–339`).

Assessment: correct analysis, low user-visible value. Extracting the mobile summary and returning the previous Map identity when contents are equal (the official [computed-stability pattern](https://vuejs.org/guide/best-practices/performance#computed-stability), `computed((oldValue) => …)`) is cheap and safe, but the stock-threshold class (`:162–164`) legitimately depends on exact quantities, so quantity changes must still re-render when stock is enabled. Do this only as a small cleanup after findings 1–4, and do not expect a visible change. Per-card components are not justified: Vue's guide warns instance overhead can exceed the saving, and the measured render is already ~1 ms.

### 7. Things that are already right and should stay

- Lazy route chunks (`router.js:7–8`), idle preload of Checkout/Modifier/CartNotes (`PosTerminal.vue:535–566`), async modals with bounded retry (`src/pos/lazyPosComponent.js`). Checkout opens in 5–10 ms.
- Bounded category LRU with subcategory derivation, request ids, abort controllers and a 15 s deadline (`useProducts.js:190–264, 328–422`); table workspace reads coalesced with one trailing request (`tableOrderWorkflow.js:634–653`); settings reads coalesced (`useTerminal.js:101–107`).
- Indexed `getQtyInCart` (`orderSessionStore.js:1863`), cart render model computed once (`cartRenderModel.js`), `cartQuantityIndex` computed.
- Floor clock ticks every 30 s and is stopped on deactivation (`TableFloorPlan.vue:767–776, 1082`); table update handler patches a single row when told which one (`:971–981`).
- Deactivation cleanup of listeners and timers in both screens (`PosTerminal.vue:1369–1396`, `TableFloorPlan.vue:1079–1096`).
- Translation is skipped entirely in English (0 walkers measured); Arabic walks are bounded and batched per frame (`runtime.js:348–390`).

## Guidance check against current official docs

- Vue stable is **3.5.43**; **3.6.0-rc.9** (2026-09-18) is still a pre-release ([releases](https://github.com/vuejs/core/releases)). Installed 3.5.34. Patch update is separate housekeeping; no runtime speedup should be promised from it. Vapor remains an experiment, as the plan says.
- Vite is at **8.3.0** ([docs](https://vite.dev/guide/performance)); installed 6.4.3. Vite's performance guide is about dev-server/build speed, not runtime; nothing in it changes these findings. Upgrade separately for build speed if wanted.
- `shallowRef` for the product rows: the [official guide](https://vuejs.org/guide/best-practices/performance#reduce-reactivity-overhead-for-large-immutable-structures) says the overhead "typically becomes noticeable … where a single render needs to access 100,000+ properties". The grid accesses roughly 25 tracked properties × 120 cards ≈ 3,000 per render, and `applyProductAvailabilityChanges` (`useProducts.js:172–176`) mutates rows in place. Not recommended; the plan's "no blanket shallowRef" holds.
- `v-memo`/virtualization: guide positions them for large lists; measured render is ~1 ms script for 120 cards. Not recommended (agrees with plan).
- Props stability / computed stability: applicable to finding 6, with the value caveat above.
- Transition: the guide confirms `mode="out-in"` inserts the entering element only after the leave completes, which is exactly the cost in findings 1–3; its performance section only says to prefer `opacity`/`transform`, which these transitions already do. The problem is the mode and the wait, not the animated property.

## Hypotheses (not measured; low expected value, listed so they are not mistaken for findings)

- **Arabic translator fallback cost.** For untranslatable text such as `12.50 JD` each visit runs `normalizeText`, a dictionary miss and up to 30 regex tests in `dynamicTranslations` (`runtime.js:279–297`), and `isKnownRenderedValue` (`:474–476`) repeats that twice more. 163 nodes per quantity change at ~1.5 ms extra script total, so at most ~1 ms is attributable. A bounded memo per language, or `data-no-i18n` on the price `<p>` (`PosCatalogWorkspace.vue:181–184`; note `"JD"` alone *is* in `ar.json:594`, so check whether the untranslated price is intended before exempting it), would remove it. Not user-visible.
- **`transition-all` + `filter` on product cards.** `PosCatalogWorkspace.vue:158` uses `transition-all`; `pos.css:920–927` applies `filter: brightness()` on `:hover`/`:active`. `filter` promotes the card to its own paint and animates on every mouse pass. Only affects mouse users; needs a paint trace before acting.
- **`:has()` selector** at `pos.css:1207` (`.pos-polish .fixed.inset-0:has(.modal-panel)`). Modern engines scope `:has` invalidation to ancestors of the mutated node; with the subject limited to `.fixed.inset-0` overlays the exposure is small. Trace before touching, as the plan says.
- **Compositing-layer wrappers.** `PosTerminal.vue:236` and `PosCartWorkspace.vue:3` force `translate3d(0,0,0); backface-visibility: hidden` on large containers. These create persistent layers (viewport-sized memory) and also turn `position: fixed` descendants into transform-relative boxes. Probably neutral for speed; worth a layer-panel look on a low-memory device, not a priority.
- **O(categories²) chevron check.** `PosCatalogWorkspace.vue:98, 114` run `categories.some(...)` per category button per render. Negligible below ~100 categories; a precomputed parent set would be a one-line tidy-up if it ever shows in a profile.
- **`loadTables` re-runs `setLanguage` on every floor activation** (`TableFloorPlan.vue:883`), which queues a whole-root translation walk in Arabic. Bounded by the frame batcher; not visible.

## Where the plan should change

1. **Add findings 2 and 3 to the urgent batch.** Same mechanism, same fix shape and same verification pattern as the route fade, and each is a directly felt ~160–235 ms wait on a very frequent tap (section tab, payment method). Together with finding 1 they are the entire measured user-visible latency in this audit.
2. **Add finding 4 (activation refresh) to §3.** It reuses the coalescing/scoping work and removes 3–4 requests plus a cache wipe per Tables → POS return in the common case.
3. **Demote §2 (narrow catalog updates) to a small follow-on.** Keep the summary extraction and identity-stable maps as a cleanup if convenient; stop treating it as a latency win. The plan's own acceptance rule ("drop results within noise") will otherwise reject it after the work is done.
4. **Treat these numbers as the production baseline** the plan asked for in §0, for these four journeys. Category switching, add-to-cart and stock bursts still need their own production-build baseline before those edits; reuse the opus harness with `noenv-dist` (or a fresh `envDir: false` build) rather than the earlier dev-build runs.

## Recommended order

| # | Change | Files | Expected user-visible effect (4× CPU, production) | Risk / verification |
| ---: | --- | --- | --- | --- |
| 1 | Remove route-level `out-in` fade | `src/App.vue` | POS↔Tables 395/195 → ~30 ms | Low. `routerPermissions.spec.js`, `tableReadLifecycle.spec.js`, `login-first-paint.cjs`, one POS→Tables→table→POS browser pass EN+AR; confirm no double route root |
| 2 | Remove `out-in` on floor section switch (enter-only cue) | `src/components/TableFloorPlan.vue:181, 2052–2063` | Section tap ~200 → ~38 ms | Low. Swipe, RTL, join/transfer bars, empty section, scroll reset |
| 3 | Remove `out-in` on checkout payment state | `src/components/pos/CheckoutModal.vue:229`, `src/pos.css:2338–2348` | Card↔cash ~275 → ~40 ms; tendered input usable immediately | Low–medium (payment UI). `checkout-ui-browser.cjs`; focus lands in `#checkout-tendered` on cash; split pane fields |
| 4 | Stock-event coalescing + scope-preserving refresh (plan §3) and dirty-signal activation refresh (finding 4) | `PosTerminal.vue` (`onInventoryChanged`, `onActivated`/`onDeactivated`), `useProducts.js`, `useSocket.js` | Fewer full re-reads per sale on other terminals; Tables→POS return without 3–4 requests and cache wipe when nothing changed | Medium (freshness). `useProductsRequests.spec`, `useProductsCategoryRecovery.spec`, `posSettingsRefresh.spec`; fake-timer burst cases; reconnect-while-on-Tables case must still refresh |
| 5 | Mobile-summary extraction + identity-stable quantity/style maps | `PosCatalogWorkspace.vue` | ≤ 1–3 ms script per cart action; not visible | Low. `catalogDerivation.spec`, `cartQuantityIndex.spec`; stock-threshold class still updates on qty change |
| 6 | Hypotheses above | — | Unknown, likely ≤ 1 ms each | Trace first; skip if nothing shows |

Skip: `shallowRef` on catalog rows, `v-memo`, virtualization, per-card components, Vue 3.6/Vapor, Vite 8 as a runtime measure. Housekeeping (Vue 3.5.43, production build mode guard, startup overlap, favicon/preferences) stays as already documented in the earlier reviews.

## Implementation results (same day, `codex/retire-subscriptions`)

Rows 1–5 of the recommended order plus the build-mode guard and the startup overlap were implemented as one commit per task. Production builds of `7a7e25c7` (t0) and the final commit, same harnesses, 4× CPU, medians:

| Journey | t0 | final |
| --- | ---: | ---: |
| POS → Tables / Tables → POS presented (EN) | 419 / 244 ms | 30 / 2 ms |
| Requests per Tables → POS return with no events | 3 | 0 |
| Floor section switch | ~200 ms | ~25 ms |
| Checkout card → cash (tendered input painted) | ~270 ms | ~10 ms |
| Stock burst, 5 events 150 ms apart (100 ms RTT): catalog reads / main thread | 5 full reads / 227–368 ms | 2 lightweight reads / 83–145 ms |
| Cached-category revisit after a stock burst | 138–183 ms (network) | 5–45 ms (cache, then one background revalidation) |
| Login keypad warm / cold (EN, 100 ms RTT) | 464 / 733 ms | 167 / 440 ms |
| POS first card warm / cold (EN, 100 ms RTT) | 786 / 1318 ms | 574 / 1039 ms |
| Cart actions (select, qty, deselect) | 6–13 ms | 6–10 ms (unchanged, as predicted) |

Full frontend suite: 131 files / 935 tests passing; `login-first-paint`, `checkout-ui-browser` and `pos-category-stall-browser` pass. Raw results: `scratch/vue-audit-2026-09-24/results/t0-vs-final*.json`, `scratch/opus-audit/results/t3-vs-t4-stock.json`. One Arabic-mobile uncached-category sum showed a single elevated tail in the startup run (1356 vs 1014 ms sum of six switches) with cached switches identical; treat as noise unless it repeats.

Known tradeoffs introduced: a stock event that lands while a category read is in flight aborts and re-issues that same-scope read (one extra lightweight request; final state still authoritative); cached categories marked stale paint immediately and are corrected within one round trip.

## Evidence

- Recipe: `scratch/vue-audit-2026-09-24/harness-transitions.cjs` (env: `ROUNDS=5 CASES=en-desktop,ar-mobile SCENARIOS=nav,sections,cartActions,checkout OUT=transitions-cpu4`).
- Results: `scratch/vue-audit-2026-09-24/results/transitions-cpu4.json` (full runs and `summary`), `results/_report-extract.txt` (the cells above), `results/smoke.json`, `results/smoke-ar.json`.
- Build measured: `scratch/opus-audit/noenv-dist` (production mode; identity checked against the working tree as described in Method).

## Ecosystem upgrade (same day)

Safety tag: `pre-ecosystem-upgrade` at `b760dde8`. Each step is one commit including its `package-lock.json`; reverting any single commit with `git revert <hash> && npm ci` restores the previous installable state.

| Package | Before | After |
| --- | --- | --- |
| vue | 3.5.34 | 3.5.43 |
| vue-router | 4.6.4 | 5.3.1 |
| pinia | 2.2.8 | 4.0.3 |
| @vueuse/core | 14.4.0 | 15.0.0 |
| vite | 6.4.3 | 8.3.0 (Rolldown) |
| @vitejs/plugin-vue | 5.2.4 | 6.0.9 |

Commits (chronological): `636a6e0e` Vue, `97bcf5a1` Pinia (installed before the router because vue-router 5's optional peer requires pinia >=3.0.4), `4966dfe7` @vueuse/core, `a1ea9232` Vite 8 + plugin-vue 6, `7e425cba` vue-router (lands after Vite 8 because vue-router 5's optional vite peer requires ^7.3 || ^8 — reverting `a1ea9232` while keeping `7e425cba` cannot `npm ci`; revert `7e425cba` first or together).

Config decision: `build.target` pinned to `['chrome87','edge88','firefox78','safari14']` (the Vite 6 default; Vite 8 would raise it to Chrome 111 / Safari 16.4) so older POS terminals keep working. `rollupOptions` -> `rolldownOptions`, `manualChunks` -> `output.codeSplitting.groups`, `commonjsOptions` removed (Rolldown handles the `.cjs` permission policy natively).

Build time: ~14.4 s (Vite 6) -> ~6.2 s (Vite 8) for the `vite build` step; `npm run build` wall time 15.6 s -> 7.8 s. Bundle gzip total: 1317.5 kB -> 1319.9 kB over 102/103 JS+CSS files (+0.2 %, within noise). `vendor-chartjs` and `vendor-socketio` groups emit; `vendor-xlsx` has no modules outside the self-contained worker bundle, as before; no `runtime-*.js` chunk appeared.

Verification per step: production guard OK at every step; full frontend suite 131 files / 935 tests green on Vue 3.5.43, Pinia 4.0.3 and Vite 8; `login-first-paint` x3, `checkout-ui-browser` (12 checks) and `pos-category-stall-browser` (4 combos) pass on the Vite 8 output and dev server (which also confirms vite-plugin-vue-devtools 8.2.1 works on Vite 8). Review scripts print a pre-existing `envFile` deprecation warning under Vite 8 (their own `createServer({ envFile: false })` option); a transient `[Vue warn]: inject() can only be used inside setup()` appears in the checkout fixture console but the script's no-error check still passes.

A/B, pre-upgrade vs post-upgrade build (RTT 100 ms, CPU x4, 5 rounds, zero errors):

| Metric (median) | pre EN | post EN | pre AR | post AR |
| --- | ---: | ---: | ---: | ---: |
| loginCold / loginWarm markMs | 457 / 173 | 456 / 165 | 618 / 185 | 618 / 184 |
| posCold / posWarm markMs | 1085 / 588 | 1089 / 568 | 1210 / 599 | 1226 / 608 |
| loginCold jsEnc bytes | 82437 | 83418 | 160614 | 159795 |
| posCold jsEnc bytes | 187303 | 187752 | 265480 | 264129 |
| nav / categoryUncached / categoryCached / addToCart sums (contentMs) | 576 / 953 / 73 / 81 | 554 / 972 / 70 / 91 | 782 / 1074 / 71 / 85 | 711 / 1001 / 75 / 99 |

Interaction A/B (3 rounds, zero errors): all medians within noise — nav./pos 13.4 -> 12.9 ms (EN) and 10.8 -> 11.0 ms (AR), sectionSwitch ~23 -> ~22-24 ms, checkout.toCard ~37 ms both, checkout.toCash ~16-18 ms both, nav./pos apiRequests 0 both. Cart-scenario `domText` identical between pre and post in English and Arabic (331 chars each).
