# Table Order Save Baseline

- Commit: `a193c389`
- Command: `node scripts/benchmark-table-settlement.js`
- Date: 2026-07-22
- Samples: 15 successful requests per operation against `posapp_test`.

```json
{
  "tableSave": {
    "medianMs": 4.88,
    "p95Ms": 16.81,
    "medianQueries": 14,
    "maxQueries": 14
  },
  "checkout": {
    "medianMs": 6.51,
    "p95Ms": 9.62,
    "medianQueries": 24,
    "maxQueries": 24
  },
  "markPrinted": {
    "medianMs": 3.51,
    "p95Ms": 4.02,
    "medianQueries": 5,
    "maxQueries": 5
  }
}
```

Query counts are the Phase 2 regression gate. Timing is local comparative evidence.

## Post-refactor verification

- Commit: `8cdce0ad` plus the final verification follow-up
- Command: `node scripts/benchmark-table-settlement.js`
- Date: 2026-07-22
- Samples: 15 successful requests per operation against `posapp_test`.

```json
{
  "tableSave": {
    "medianMs": 5.03,
    "p95Ms": 12.87,
    "medianQueries": 14,
    "maxQueries": 14
  },
  "checkout": {
    "medianMs": 5.86,
    "p95Ms": 35.35,
    "medianQueries": 24,
    "maxQueries": 24
  },
  "markPrinted": {
    "medianMs": 2.37,
    "p95Ms": 3.02,
    "medianQueries": 5,
    "maxQueries": 5
  }
}
```

The hard query-count gate is unchanged: table save 14, checkout 24, and check-drop 5. Local timings remain comparative evidence only.

## Post-review hardening verification

- Full suite: 163 test files / 1,734 tests passed.
- Production build: passed.
- Schema drift: zero.
- Post-commit inventory broadcast failure: covered by an integration regression test; a committed table order remains successful and persisted when that notification throws.
- Benchmark query counts: table save 14, checkout 24, and check-drop 5 (unchanged).
