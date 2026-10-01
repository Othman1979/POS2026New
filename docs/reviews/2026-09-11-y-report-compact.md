# Compact thermal Y report

Implemented on `codex/pos-frontend-audit` after `5e7860a2`, following the approved 100-item layout experiment. Production changes are confined to `pos-spooler-printer/v2/artifact-renderer.js`.

Y's item section now prints name, quantity and amount in three columns. Ordinary items occupy one row; long names wrap completely. Item names remain 25px and amounts 20px. Numeric columns can expand for large/fractional values so the numbers stay on one line. The currency appears in the amount heading. No rows are omitted or truncated.

Calculations, category/subcategory totals, order count, dates and the final report marker remain. Y receipt details stay omitted. A4, other thermal report layouts, canonical report generation, recovery archives, transport, raster band size, retry rules and the final cut command are unchanged. No dependency was added.

## Verification

- Tests first: the new compact-report case failed against the old layout (`scratch/y-compact-red.log`). After implementation, all six cases pass: 100 items, 200 items, long English/Arabic names, large and fractional values, a date period and an empty item list. They assert every cell's content and order, retained calculations, escaping, both paper edges, original font sizes and single-line numeric values.
- All **33 spooler test scripts pass** using packaged Node **22.23.0**, including the existing ten-case hostile layout test and transport/journal/restart safety checks (`scratch/y-compact-spooler-all.log`).
- The real API → database queue → V2 sync/journal/workers → Chromium/canvas → loopback TCP harness passes with a **100-item Y**, total **1,000.00**, all items retained and no receipt details. Its **303,406 bytes** match both local and cloud artifact hashes. X/Z still pass. A lost result acknowledgement followed by restart does not duplicate delivery; a pre-send refusal recovers once. The generated DB and temporary journal are removed (`scratch/y-compact-e2e.log`).
- Full rendered images were generated; representative normal and long-name output was visually inspected. Raster checks cover every row and verify the final cut. Production server/frontend code was not changed, so their earlier suites were not repeated for this renderer-only change.

## Measured comparison

`scripts/reviews/y-report-performance.cjs` compares the production HTML with `5e7860a2` using the same current renderer and synthetic payloads. Both variants are warmed, followed by five samples each with alternating order. No other test workload ran during measurement. Times below are local warm-render medians, including screenshot/raster generation and durable artifact creation.

| Fixture | Prior → current bytes | Reduction | Estimated paper, prior → current | Render time, prior → current |
| --- | ---: | ---: | ---: | ---: |
| 100 ordinary items | 502,790 → 303,406 | 39.7% | 872.5 → 526.5 mm | 349 → 263 ms |
| 200 ordinary items | 949,382 → 548,310 | 42.2% | 1,647.5 → 951.5 mm | 630 → 442 ms |
| 100 items, 25 with very long names | 718,878 → 573,526 | 20.2% | 1,247.5 → 995.3 mm | 578 → 463 ms |

All items, quantities and amounts were checked after rendering. The resulting 100/200-item artifacts cover all **4,212 / 7,612 rows** in **17 / 30 raster bands** respectively. Baseline/current headers and calculations are identical; the comparison changes only Y item layout. Paper estimates use 8 dots/mm and exclude the unchanged trailing line feeds.

Evidence: `scratch/y-report-performance/results.json`, its full/preview PNGs, and `scratch/y-compact-performance.log`. Local timings do not establish physical paper completion, Windows driver behavior or performance on a customer's hardware. The renderer change requires updating installed spooler source; no deployment was performed.
