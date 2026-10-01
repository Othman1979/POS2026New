# Typst spooler renderer implementation

## Result

The spooler now has an opt-in local Typst renderer for server-compiled receipt and
kitchen tickets. Chromium remains the default and the fallback for reports, legacy
payloads, unsupported compiled layouts, a missing/crashed/timed-out Typst process,
or invalid Typst output. Fallback finishes inside `renderer.render()` before the
artifact is journaled and before any transport marker can be written.

The backend resolves the template and model once, then stores Chromium HTML/CSS and
a bounded renderer-neutral `nativeLayout` in the same `compiled_document_v1` envelope.
The Typst adapter validates and consumes only `nativeLayout`; it never reads or parses
the HTML/CSS fields. Typst layout, PNG generation and ESC/POS rasterization remain on
the Windows workstation. The change adds no server query, table, migration, queue
column or server-side renderer process. A basic receipt carries about 7 KB of native
layout in addition to its existing 7.5 KB Chromium representation; a normal kitchen
ticket adds about 4.2 KB.

The Windows runtime pins the official Typst 0.15.1 release archive and IBM Plex Sans Arabic Regular, SemiBold and
Bold by SHA-256, with Noto Sans, Noto Sans Arabic and monochrome Noto Emoji as
fallbacks. Packaging accepts only the official executable hash, applies one verified
four-byte machine-code change through `deployment/tools/patch-typst-fast-watch.js`,
and verifies the exact resulting executable hash. The patch
reduces Typst's editor-oriented watch event batch timeout from 100 ms to 5 ms; the
compiler, renderer, CLI, fonts and generated documents are unchanged. The runtime
ships Typst's LICENSE, NOTICE and `POSAPP-PATCH.txt` plus each font's OFL license,
ignores system fonts, uses one compiler
thread and keeps one persistent compiler process. Typst output uses a deterministic 4-by-4
ordered bilevel conversion that preserves grayscale glyph coverage while leaving
Chromium's established threshold path unchanged. The pattern carries its absolute
row origin across bounded raster surfaces so 256-row clips cannot introduce seams.
PNG height, PNG bytes, ESC/POS bytes, diagnostic output and raster surface rows are
bounded. Cash-drawer jobs bypass both document renderers. Artifact filesystem
failures do not retry through a second renderer.
Each watched compilation carries a random 128-bit raster sentinel. The renderer
verifies the sentinel in the padded eight-row block returned by Typst and removes
the whole block before ESC/POS encoding, so a delayed watch event can never print
the preceding ticket or leave an antialiased footer mark.

Failed compilations delete the current job's `assets-*` directory without removing
the last successful compile's assets. Missing, crashed, timed-out or invalid-output
runtime failures open a 30-second retry cooldown with no timer or background work;
Chromium handles subsequent queued tickets immediately and a later ticket probes
Typst again. This prevents one degraded renderer from adding its full timeout to
every job in a busy queue. The native adapter also accepts the template engine's
`apart` label layout, so valid saved templates do not fall back only because of a
style-token mismatch.

## Automated and visual acceptance

`scripts/reviews/typst-spooler-e2e.cjs` passed eleven real compiler/render workflows:

- basic, bundle, accepted-JoFotara, hostile long-content, hostile bilingual and mixed manual/modifier/note-category receipts;
- normal, void, subscription and subscription-void kitchen tickets;
- a saved-template-shaped receipt with a logo and absolute English/Arabic footer.

For every workflow, real Typst and Chromium output was converted to durable ESC/POS,
hash-verified, decoded back to PNG, checked for nonblank bounded raster output and
compared for beep, drawer and single-cut parity. The accepted JoFotara QR and custom
logo remained raster images. An old queued artifact without `nativeLayout` skipped
Typst and rendered through Chromium without being counted as a failed render. A
missing Typst executable produced a real Chromium artifact with `TYPST_UNAVAILABLE`
recorded as the fallback reason. Generated images and JSON evidence are under ignored
`scratch/typst-spooler-e2e/`.

Visual inspection confirmed connected Arabic, mixed Arabic/English direction,
emoji fallback, wrapped item names and notes, positioned columns, QR, logo and
custom template output. The receipt date remains right-aligned without the former
Arabic `وقت الطباعة` label and is reduced to date, hour, minute and AM/PM. The built-in
receipt identity, cashier and item-heading rows use intrinsic grids rather than
fixed-height browser boxes. Date/time shares the Invoice row, order type shares the
Order row, and Cashier remains on its own line. Receipt fields use a consistent
six-point gap, the store identity lines use twelve-point separation, and the
item-heading divider has a small explicit gap instead of the former reserved box.
A padded render sentinel is fully removed before ESC/POS encoding so antialiasing
cannot leave a dotted footer.

The ordered-raster revision, initially measured with Cairo, reran the original nine
real workflows plus a mixed Arabic/English hostile receipt with diacritics, numerals,
emoji and long notes.
Solid black and white modules remain bit-exact, including QR and logo pixels, while
intermediate glyph coverage becomes deterministic printed dots instead of being
discarded at one threshold. Before/after decoded artifacts are retained under the ignored
`scratch/typst-font-raster-comparison/` directory for review. On the same host, five
rounds covering 140 documents changed median raster time from 1.92 ms to 3.66 ms and
total wall time from 21.37 s to 21.77 s (+1.9%). Peak committed memory changed from
156.8 MB to 149.6 MB in that sample. These timings establish a bounded local cost;
physical paper remains the authority for thermal appearance. IBM Plex was also
rendered through the hard-threshold path as a controlled comparison. That path looks
cleaner in a zoomed one-bit PNG but discards partial glyph coverage, so the final IBM
runtime retains ordered conversion for smoother thermal edges without supersampling.
Against the immediately preceding Cairo build, the same five-round, 140-document
local run changed median warm render time from 137.43 ms to 138.04 ms, p95 from
155.79 ms to 161.39 ms and wall time from 21.77 s to 22.34 s. Job CPU fell from
4.97 s to 4.86 s and peak committed memory from 149.6 MB to 144.9 MB in this sample.
The small mixed changes are within local-run noise and show no material resource cost;
they do not predict physical-printer latency.

The accepted JoFotara receipt's normalized 421-by-421 QR raster retained the same
SHA-256 before and after the font and dither change; font metrics can move its vertical
position without changing its modules.

## Sustained isolated measurement

Both final candidates rendered the same seven built-in compiled workloads for 20
rounds and four iterations each: 560 documents. They ran sequentially from the same
isolated production stage. The Windows Job Object accounted for Node and all child
processes; 100 ms samples recorded summed working sets. Durable ESC/POS hashes were
checked for every render.

| Metric | Chromium | Fast-watch Typst 0.15.1 | Change |
| --- | ---: | ---: | ---: |
| Wall time | 45.556 s | 28.402 s | -37.7% |
| Throughput | 12.29 docs/s | 19.72 docs/s | +60.4% |
| Job CPU | 33.531 s | 13.688 s | -59.2% |
| Peak committed memory | 230.2 MiB | 149.3 MiB | -35.1% |
| Peak summed working set | 377.5 MiB | 182.8 MiB | -51.6% |
| Max Node RSS | 156.9 MiB | 141.0 MiB | -10.1% |
| First render | 461.46 ms | 294.67 ms | -36.1% |
| Median warm render | 62.61 ms | 42.94 ms | -31.4% |
| p95 warm render | 112.70 ms | 61.27 ms | -45.6% |
| p99 warm render | 124.53 ms | 67.78 ms | -45.6% |
| p99 event-loop delay | 28.90 ms | 42.70 ms | +13.80 ms |
| Max event-loop delay | 257.95 ms | 61.80 ms | -76.0% |
| Processes created | 77 | 4 | -73 |

The stock official Typst executable had a 137.71 ms warm median, 156.47 ms p95
and 84.045 s wall time on the same 560-document workload. Source inspection found
the cause in Typst 0.15.1's watcher: `BATCH_TIMEOUT` is fixed at 100 ms to combine
closely spaced editor file events. POSApp writes a complete generated source once,
so that delay provided no safety benefit. The 5 ms candidate removed that floor.
Three independently built/byte-patched 560-document runs produced 42.84-43.27 ms
medians and 59.01-60.39 ms p95 values before the final production-stage run above.

The official and patched executables have the same length and differ at exactly four
bytes in one verified instruction. All seven patched artifact hashes, byte counts and
heights matched stock Typst across all 560 renders. Another 11-workload end-to-end run
from the staged executable covered normal and hostile English/Arabic receipts,
JoFotara QR, custom logo/layout, kitchen variants, legacy skip and missing-Typst
fallback. More than 1,680 consecutive comparison renders completed without a stale
or partial output.

A native Node binding prototype was faster in a small probe, but the available
`typst.ts` Node compiler was a pre-release build, targeted Typst 0.15.0 rather than
the pinned 0.15.1 release, and introduced another native dependency supply chain.
It was not adopted. The final implementation keeps the official CLI and existing
single-process lifecycle, applies no server load, adds no per-ticket process churn,
and preserves the sentinel that rejects stale watcher output.

The p99 event-loop delay was 13.8 ms higher in this local sample even though the
maximum delay, CPU, memory, process count and total wall time all fell. These are
local workstation measurements. They establish renderer and artifact behavior, not
physical paper, cutter, driver or customer-hardware performance.

Commands and raw outputs:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installers.ps1 -StageOnly -SkipDependencyInstall -SkipVersionBump
node scripts/reviews/typst-spooler-e2e.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reviews/spooler-render-resources.ps1 -OutputPrefix scratch/typst-final-stage2-chromium -Renderer chromium -CompiledOnly -Rounds 20
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reviews/spooler-render-resources.ps1 -OutputPrefix scratch/typst-final-stage2 -Renderer typst -Rounds 20
```

This remains a canary feature. Enable it on one runtime-updated station with
`SPOOLER_RENDERER=typst`, run physical receipt, kitchen, QR and fallback checks, and
return to `SPOOLER_RENDERER=chromium` by editing the protected spooler environment and
running the maintained refresh command. Chromium remains packaged during the canary.
