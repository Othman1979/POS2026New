# Verification of the test-baseline and pool-acquisition plan

**Date:** 2026-08-16
**Plan reviewed:** `docs/superpowers/plans/2026-08-16-test-baseline-and-pool-acquisition-hardening.md`
**Repo state:** `master` @ `74cd4492`, working tree unchanged (all probes created for this review were deleted)
**Method:** every claim was re-derived from source or measured. Nothing was accepted from the plan's own text. Probe files were created, run, and removed; `git status` is identical before and after.

**Verdict: the plan is sound and safe to execute.** One gap will stop execution at Task 3, three items are minor corrections. No design flaw, no incorrect value, no unsafe production change.

---

## Findings

### F1 — Task 3 Step 3 fixes one of two identical assertions (execution-blocking)

`platformRemittanceRoutes.test.js` asserts the fictional code **twice**, both inside the same `it()`:

- `:180` `expect(blocked.body.code).toBe('PLATFORM_ORDER_TYPE_HAS_HISTORY');`
- `:194` `expect(remittanceBlocked.body.code).toBe('PLATFORM_ORDER_TYPE_HAS_HISTORY');`

The plan's snippet names only `blocked`. Confirmed both must change: `backend/routes/admin/printers.js:45-65` runs a **single** query with `EXISTS(… orders …)` and `EXISTS(… platform_remittances …)` and returns the one generic code for either branch.

Executing the snippet literally leaves `:194` red, and Task 3 Step 5 ("all selected tests pass") fails. Self-revealing, but it should say both lines.

### F2 — Task 6 Step 1 points at an invariant list that does not exist

`docs/architecture.json` has top-level keys `meta, layers, nodes, flows, defects`. There is no "database/runtime invariant list": `invariants` occurs once, as a **flat array of 45 strings at `meta.invariants`**. Zero flows carry an `invariants` key.

The `core-db` node and its `sub` field are as the plan describes, and the replacement text is a superset of the current value — that half is fine.

### F3 — golden regeneration writes LF into a CRLF working tree (verified harmless)

`core.autocrlf=true` with no `.gitattributes` rule for `.html`. The goldens are CRLF on disk (31 CR / 31 LF) but the committed blob is LF-only (0 CR / 31 LF). `generate.js` uses `writeFileSync`, which does not translate, so regeneration produces LF files.

Measured non-destructively: rewriting a golden to pure LF produces **an empty `git diff --stat`** — git's clean filter normalizes it away. Line endings will not pollute the Step 3 diff.

The one visible effect is git printing `warning: in the working copy of '…', LF will be replaced by CRLF the next time Git touches it`. Given Task 1's rule "Stop if any other difference appears", the plan should say this warning is expected so it is not misread as a stop condition.

### F4 — the acquire limit equals `connectTimeout` (diagnostic only)

`databasePoolOptions.js:36` sets `connectTimeout: 10000`; the plan sets the acquire limit to 10,000 ms. A handshake that takes just under 10 s races the acquire timer, so the surfaced code can become `DB_POOL_ACQUIRE_TIMEOUT` rather than the underlying connect error. Both fail at the same wall-clock point and neither leaks; only the diagnostic label changes. Worth one sentence in the plan, not a design change.

---

## What was independently reproduced

### Task 1 — print goldens

Rendered all 22 cases in memory from `pos-spooler-printer/renderDocument.js` and diffed against the frozen files.

- 22 of 22 differ.
- Distinct added fragments across the whole set: **two CSS rules** —
  `.kitchen-item-qty { flex: 0 0 auto; min-width: 75px; padding-right: 12px; white-space: nowrap; }` and
  `.kitchen-item-name { flex: 1 1 auto; min-width: 0; text-align: left; }` — plus `kitchen-item-qty` / `kitchen-item-name` class markup.
- Distinct removed fragments: the old `<style>` block and the inline `width: 75px; flex-shrink: 0; text-align: left` / `flex: 1; text-align: left` item columns. Nothing else.
- On a receipt golden, content outside `<style>` is byte-identical.
- `cases.json` holds 22 cases, 17 receipt and **5 kitchen** — matching the plan's "only the five kitchen documents".
- `printGoldens.test.js` = 2 static `it` + `it.each(cases)` → **24 tests, 22 failing**, as the plan states.
- `generate.js` ends with `generated ${cases.length} print goldens` → "generated 22 print goldens".

### Task 2 — tax-exempt values

Sent the plan's **exact** proposed request through the real Express app, database, report, print queue, JoFotara and refund paths. Every asserted value matched:

| plan asserts | measured |
| --- | --- |
| checkout 200, `tax_exempt:true, tax:0, total:22.17` | ✓ |
| order `1 / '22.17' / '0.00' / '22.17'` | ✓ |
| `lines[0].price_at_sale` 20.15 | `"20.150000"` |
| `lines[0].price_before_tax_exemption` 20.15 | `"20.150000"` |
| `lines[1].price_at_sale` 2.02 | `"2.020000"` |
| `lines[1].price_before_tax_exemption` **null** | `null` |
| audit `25.68 / 22.17 / 3.51 / 0` | ✓ exactly |
| report `sales_processed` 22.17 | ✓ |
| receipt `taxAmount 0`, `(معفي من الضريبة)`, `total 22.17` | ✓ |
| refund 22.17, `'22.17' / '0.00' / '22.17'` | ✓ |

The asymmetry the plan asserts — goods line keeps a non-null `price_before_tax_exemption` equal to its price, fee line gets `null` — is real, not a typo. `original_total: 25.68` could not be derived from the obvious arithmetic and is confirmed only by measurement; the plan is right to treat these as measured facts.

Inputs confirmed at `:15-28`: product price 20.000000 + `Cheese` modifier 0.15 (cart sends 20.15), service charge 10% at 16%.

### Task 3 — boundary guards

- `frontendRuntimePaths.test.js:40` already normalizes with `.split(path.sep).join('/')`, so the plan's `file.split('/').includes('__tests__')` filter **works on Windows**.
- Running the collector: 130 component files, **exactly one** violator (`src/components/pos/__tests__/callCenterWorkflow.spec.js`); the filter reduces it to zero. Eight `__tests__` directories exist under the scanned roots.
- `sourceConsumers()` at `:49` does scan `backend/tests` deliberately — the plan's warning against a global exclusion is correct.
- `TABLE_KEYS` has **49** entries; `useTables()` returns **52**. Set difference is exactly `editSplitGroup`, `moveAllItemToSeat`, `splitEditContext`. (My earlier triage said 48 → 51; the delta and the names were right, the absolute counts were not.)
- Production consumers confirmed: `TableSplits.vue:318,509` and `SplitCheckModal.vue:13,112,179,200,207`.

### Task 4 — Vitest isolation

This contradicted my own triage, so it was settled by experiment. Two probe files sharing `ManagerOverrideService`: file A wrote `overrideAttempts`, file B asserted the state was gone. Under the repo's real config, B measured **`leaked: false, size: 0`** — module state does **not** cross test files. `npx vitest --help` independently reports `--isolate … (default: true)`.

**The plan is right and my triage's section 3 premise was wrong.** `fileParallelism: false` / `maxWorkers: 1` schedule execution; they do not share a module registry. The correction and the refusal to add reset machinery are both justified.

The comment text the plan replaces exists as described (`setup.js:1-7`, the `Reset Between Tests` heading at `:37`, `vitest.config.mjs:21-23`).

### Task 5 — the pool seam

Read from mysql2 3.20.0 source:

- `lib/base/pool.js:192` (`query`) and `:236` (`execute`) both call **`this.getConnection`** — dynamic dispatch, so an own-property patch on the instance covers them.
- `lib/promise/pool.js:20` (`getConnection`) calls `corePool.getConnection`; `query`/`execute` delegate to `corePool.query`/`corePool.execute`.
- `traceCallback` (`lib/tracing.js:55-60`) falls through to `fn.apply(thisArg, args)` when no tracing subscriber exists, so the callback identity reaching `_connectionQueue` is unchanged.
- `mysql2/promise.js:45-56` is literally `createPool(opts)` + `new PromisePool(corePool, thePromise)`, and `Pool.promise()` is `new PromisePool(this, …)` — **the construction swap in Step 7 is equivalent**, and `inheritEvents(pool, this, ['acquire','connection','enqueue','release'])` keeps `pool.on('connection', …)` and `attachDatabasePoolTelemetry(pool, …)` working unchanged.

Ran the plan's wrapper **verbatim** against the real test database:

| probe | result |
| --- | --- |
| running SQL survives a 40 ms acquire limit | `SELECT SLEEP(0.08)` completed in 85.6 ms |
| queued acquisition bounded | rejects `DB_POOL_ACQUIRE_TIMEOUT`; pool `{all:1, free:0, queued:1}` |
| late connection released | after release `{all:1, free:1, queued:0}`, next query succeeds |
| 50-waiter saturation | all 50 → `DB_POOL_ACQUIRE_TIMEOUT`, peak `queued:50`, drains to `{free:1, queued:0}`, pool usable |
| queue-limit error preserved | `Queue limit reached.` in 0.0 ms |
| destroyed connection re-entry | 1 warning, `{free:1, queued:0}`, pool usable |
| log payload | `{code:'DB_POOL_ACQUIRE_TIMEOUT', timeout_ms:40}` only — no SQL, host or credentials |
| cold connect latency (8 samples) | min 0.7 / med 1.4 / **max 8.3 ms** — the 40 ms integration budget holds |

Then created the plan's three Task 5 files exactly as written and ran them under Vitest: **4 passed, 0 failed** (3 unit, 1 integration). All three files were deleted afterwards.

Additional check the plan does not make: across 93 non-test `getConnection()` sites, **none** is combined with `fetch`/`axios`/`http(s).request`. No connection is held across network I/O, so the 10 s bound cannot fire on a legitimately long external call.

### Task 6 — gates

- `24 + 1 + 4 + 4 + 10 = 43` — the plan's "43 passed" is exact.
- `--reporter=dot` and `--reporter=verbose` are both valid in Vitest 4.1.8 (`--reporter=basic` would not be).
- `build:admin`, `architecture`, `architecture:check`, `test:unit` all exist in `package.json`.
- `pretest:unit` (`scripts/validate-schema-drift.js`) passes: "zero drift detected".
- `npm run architecture:check` passes today: 198 nodes, 52 flows, 407 steps, 138 files.
- `git add …/*.html` under PowerShell passes the pathspec to git, which globs it itself — correct as written.

---

## Note on staging

Task 4 Step 5 stages `docs/superpowers/evidence/2026-08-15-pre-existing-issues-triage.md`, which is currently **untracked**. That newly tracks it — intended, but worth being deliberate about. The plan's constraint correctly protects the user-modified `2026-08-14-webauthn-device-access-adversarial-review.md` and the catalog-backed priced-note plan.
