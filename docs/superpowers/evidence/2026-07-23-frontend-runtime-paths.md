# Phase 5B frontend runtime paths baseline

Recorded on 2026-07-23 from branch `codex/phase-5-helper-paths` after the Phase 5A backend commits.

## Baseline inventory

- Old runtime tree: 22 JavaScript files under `assets/js`.
- Old-path consumers: 81 `src/` and `backend/tests/` JavaScript/Vue files.
- `vite.config.mjs` and `vitest.config.mjs` have no `@` alias.
- Phase 4 leaf directory: `assets/js/composables/stores/orderSession`.
- Public facades: `assets/js/composables/useCart.js` and `assets/js/composables/useTables.js`.
- Phase 4 public-boundary contract remains covered by `backend/tests/unit/orderSessionBoundaries.test.js`.
- Baseline path characterization: `backend/tests/unit/frontendRuntimePaths.test.js` (3 tests).

## Build baseline

- `npm run build`: passed before the path move; four Vite entries were built (`index`, `admin`, `print_receipt`, `menu`) in approximately 6.76 seconds.
- Phase 5A backend baseline retained zero schema drift and settlement query ceilings of 14/24/5; frontend path work must not modify backend files or those contracts.

## Task 2 checkpoint

- Commit: `17a6de6c refactor: move shared browser runtime into src`.
- Added the identical URL-based `@ -> src` alias to `vite.config.mjs` and `vitest.config.mjs`.
- Moved the five shared files to `src/shared`: i18n, auth interceptor, favicon injector, system settings, and receipt printing.
- Updated runtime imports, dynamic imports, mocks, and source-reading localization tests; moved receipt printing now imports `@/utils/receiptPresentation.js`.
- Shared path cohort passed 3 files and 18 tests; production build passed (four Vite entries, approximately 5.11 seconds after the shared move).

## Task 3 checkpoint

- Commits: `bbfc3445 refactor: move POS runtime into src`, `9192b877 refactor: update POS runtime imports`.
- Moved the complete 17-file Phase 4 POS graph to `src/pos`, preserving both Pinia stores, both public facades, and the `stores/orderSession` leaf directory.
- Updated all runtime imports, dynamic imports, `vi.mock` IDs, direct test imports, and source-reading paths. No component imports a Phase 4 leaf module.
- Deleted the empty `assets/js` tree; `Test-Path assets/js` is `False`.
- Zero-old-path search across `src`, `backend/tests`, `vite.config.mjs`, and `vitest.config.mjs` is clean.
- POS focused cohort passed 23 files and 212 tests; final path/boundary static checks passed.
- Production build passed after the complete move (four Vite entries, approximately 5.57 seconds).

## Task 4 adversarial/final gate

- Final owner checks: no `assets/js` references in `src`, `backend/tests`, or either Vite config; `assets/js` is deleted; no component imports `src/pos/stores/orderSession/*`; no POS helper imports remain.
- `backend/tests/unit/frontendRuntimePaths.test.js`, `orderSessionBoundaries.test.js`, and facade checks passed (10 tests).
- Final full unit run: 178 test files, 1,778 tests; 177 files/1,777 tests passed. The single failure is the unchanged `subscriptionManagement.test.js` date-window assertion (`subscription_collections` expected 21.6, observed 0) and reproduces in isolation; Phase 5 does not modify `subscriptionMetrics.js`, that route, or its test data.
- `npm run pretest:unit`: passed; zero schema drift.
- `npm run build`: passed; all four entries (`index`, `admin`, `print_receipt`, `menu`) built in approximately 5.69 seconds.
- `git diff --check`: passed. The full path move is represented by Git renames; no adapter or duplicate old tree is tracked.

## Post-Luna owner correction

- Replaced the ineffective component boundary loop, which iterated only old-path consumers and therefore checked zero files in the final state.
- The final boundary now scans JavaScript, TypeScript, Vue, and config consumers; asserts the exact 22-file manifest; proves both aliases occur exactly once; and rejects alias, `src`, or relative imports of Phase 4 leaves from components/admin.
- Removed the deleted POS helper from coverage configuration and added the final HTTP/module owners.
- Made the subscription purchase fixture timestamp deterministic inside its asserted metrics window.
- Final full gate: 178 files / 1,780 tests passed.
