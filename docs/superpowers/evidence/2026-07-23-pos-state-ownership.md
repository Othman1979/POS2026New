# POS State Ownership Evidence

## Task 1 baseline

- Baseline commit: `15fe341b763a515f790ca46921755650675728eb`
- Recorded: 2026-07-23 (Asia/Amman)
- `orderSessionStore.js`: 3,295 lines.
- `npx vitest run backend/tests/unit/orderSessionBoundaries.test.js`: expected RED. The two facade contract cases passed; the sole failure was the absent planned `assets/js/composables/stores/orderSession/` directory.
- `npm run build`: passed in 5.89 seconds (6.81 seconds wall clock); 270 modules transformed.
- Relevant build assets: `dist/index-BMrrk6b-.js` 336.49 kB (89.32 kB gzip), `dist/admin-HD1fpNr9.js` 9.48 kB (3.54 kB gzip), `dist/chunks/receiptPresentation-DGaORCym.js` 5.92 kB (2.25 kB gzip), and `dist/chunks/posSessionStorage-f-G_Q1Sw.js` 0.22 kB (0.17 kB gzip).

These sizes are comparative evidence only; Phase 4 has no bundle-size threshold.

## Implementation verification

- Focused split boundary/store cohort: 135 passing tests.
- Focused checkout/cache/store/facade cohort: 137 passing tests.
- Focused persistence/table cohort: 143 passing tests.
- Focused final table boundary/facade/store cohort: 149 passing tests.
- Final post-fix focused store/facade/table-boundary cohort: 131 passing tests.
- Owner-fix Phase 4 cohort: 7 files / 163 tests passed.
- Owner-fix Phase 1-3 linkage cohort: 4 files / 33 tests passed.
- Production build after the owner fixes: passed in 6.60 seconds; 274 modules transformed. `dist/index-DS1sSpsK.js` is 336.96 kB (89.60 kB gzip) and `dist/chunks/posSessionStorage-C24doS0A.js` is 2.98 kB (1.15 kB gzip).
- `npm run pretest:unit`: passed with zero schema drift.
- `npm run test:unit -- --silent`: passed 170 test files / 1,766 tests in 721.42 seconds. This wrapper included a fresh zero-drift schema precheck.
- Final `orderSessionStore.js`: 3,033 lines, down from the 3,295-line baseline while retaining the public facades.
- Owner-fix implementation commit: `52134798` (`fix: harden POS state ownership`).
