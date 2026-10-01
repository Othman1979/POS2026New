# Phase 5 Plan Review Evidence

**Reviewed baseline:** `5448280d`

**Scope:** roadmap Phase 5 planning only; no Phase 5 production code executed.

## Baseline inventory

- `backend/routes/pos/helpers.js`: 857 lines.
- POS helper consumers include POS routes, auth/print/admin routes, Phase 2/3 modules, printing services, and direct tests.
- `assets/js`: 22 bundled runtime JavaScript files.
- `assets/js` path consumers: 81 source/test files.
- Vite and Vitest had no `@` alias.
- Phase 4 final gate at the reviewed baseline: 170 files / 1,766 tests, production build passed, zero schema drift.

## Findings and plan corrections

### P1 — Phase 5 was not executable

The roadmap contained two bullets but no task sequence, exact paths, interfaces, caller manifest, regressions, or acceptance gates. A lower-context agent could not execute it safely.

**Correction:** created independent backend-helper and frontend-path implementation plans. They can be reviewed and executed separately and each has its own final gate.

### P1 — The helper ownership list omitted real stateful and cross-domain behavior

The helper also owns table realtime SQL/socket payloads, manager override lockout/audit state, payment validation, checkout locks, settings, cache spy seams, cash validation, saved-line diffs, and pass-through infrastructure. Forcing these into five vague owners would either create dumping grounds or break Phase 1-3 boundaries.

**Correction:** added an explicit ownership table with direct infrastructure imports, existing owners where available, and only eight justified new seams.

### P1 — A mechanical helper move could invalidate Phase 3 post-commit tests

`executeCheckout.js` deliberately calls cache invalidators through the mutable helper module object; `checkoutPostCommit.test.js` spies on those properties. Destructuring the final cache imports would make the spy miss production and produce false test confidence.

**Correction:** the backend plan requires importing the real cache module object and updating the spy to that exact object.

### P1 — Frontend moves could leave passing but ineffective mocks

Vitest mocks and production code currently use identical relative `assets/js` IDs. Moving production imports without updating every `vi.mock` ID can leave mocks targeting adapters or dead paths.

**Correction:** the frontend plan treats runtime imports, mocks, test imports, and source-reading paths as one atomic caller class and adds a mock-identity attack to the break prompt.

### P2 — The alias instruction lacked a stable implementation

Neither config currently defines aliases. A plain `path.resolve('src')` depends on cwd and adding the alias to Vite alone breaks Vitest resolution.

**Correction:** both configs receive the same URL-based `@` alias in the first commit that consumes it.

### P2 — “One cohort at a time” conflicted with Phase 4’s cohesive POS graph

Moving Phase 4 leaf modules separately from their store/facades creates adapter chains and mixed old/new mock identities.

**Correction:** shared browser infrastructure is one cohort; the full 17-file POS graph is the second cohort and moves as a unit.

### P2 — Source-reading tests were easy to miss

Several tests read `orderSessionStore.js`, facades, terminal code, and i18n by literal filesystem path rather than importing them.

**Correction:** the frontend plan names the critical source-reading tests and requires a repository-wide zero-old-path search.

### P2 — Temporary adapters had no deletion proof

The roadmap required adapters but did not say whether they could be committed or how cleanup was proven.

**Correction:** adapters are uncommitted scaffolding only; each task deletes them after `rg` reaches zero old callers and Git identity is inspected.

### P2 — Previous phase performance gates were absent

Moving SQL-owning helper functions can accidentally add reads or alter lock/query order even when endpoints still pass.

**Correction:** Phase 5A retains the Phase 2/3 settlement benchmark ceilings of 14/24/5 median/max queries.

## Review verdict

The original Phase 5 roadmap text was **not execution-ready**. The corrected pair of plans and adversarial prompt are aligned with Phases 1-4 and are ready for a separate execution review. Phase 5 itself remains unstarted.
