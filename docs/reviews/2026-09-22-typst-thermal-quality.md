# Typst thermal quality candidate

## Noto follow-up

The subsequent requested font switch removes IBM Plex from the Typst font stack,
vendor lock, font staging list, installer preflight and package contract fixtures.
Latin now uses Noto Sans; Arabic uses Noto Sans Arabic; emoji uses Noto Emoji.
Noto's font-wide vertical metrics made receipts excessively tall in the first
experiment. Final explicit bounds are 1.05em above / 0.4em below baseline with
0.52em minimum leading; the ink-gap regression still passes. Existing font weights
remain 400/600/700 and are supplied by the pinned variable font files.

Verified with a Noto-only font directory (no IBM or system-font fallback): all
13 real E2E workloads and the raster line-spacing check pass, alongside the
typst-renderer, thermal-raster and renderer-router tests. The 79 Windows installer
checks pass. Decoded output was visually inspected; final evidence is in
`scratch/thermal-quality-noto-final`. The timings below describe the prior IBM
candidate, not measurements of this Noto revision. No physical printer was used.
Previously built installers remain unchanged; a new runtime package is required
to remove IBM files from installed machines.

The restaurant paper sample showed crowded Arabic items and notes. This change stays local to the spooler: no server, database, printer routing or template migration is required. Previously compiled native layouts use the corrected renderer on their next render; already-rendered spool artifacts are not rewritten.

## Changes

- Use font ascender/descender bounds and a 0.36em minimum interline leading. The real raster regression initially found only one blank dot between accented/descending lines; the corrected output has at least five.
- Replace the nonbreaking inline label spacer with a breakable space, and give edge-aligned pairs an eight-dot gutter. Long invoice references wrap instead of colliding with the date; the date remains at the right edge.
- Use existing threshold raster conversion for solid thermal text strokes, replacing whole-document ordered dithering. No new library, process, higher-resolution buffer, font download, or host rendering is introduced. Black/white image modules retain exact raster semantics; grayscale artwork may lose tonal detail and needs physical acceptance if used.
- Preserve explicit font weights and item/note association. Additional font substitutions and supersampling were not adopted without evidence they justify their cost.

## Verification and limits

Five focused spooler test programs passed: typst-renderer, thermal-raster, renderer-router, v2-artifact-renderer and v2-renderer-page-reuse. The real compiler/Chromium comparison passed 13 workloads: receipt and kitchen fixtures, long content, Arabic accents and mixed English, notes/modifiers, restaurant-style Arabic item names, QR/image assets and custom positioned content. Decode final ESC/POS bytes to PNG and verify one cut, correct drawer/beep commands, nonblank images, artifact hashes, legacy selection and missing-Typst fallback. No paper was printed. The receipt fixtures are synthetic, not customer invoices.

Local process-tree measurements, 105 warm samples per run (same pinned patched Typst 0.15.1 and Chromium 152):

| Metric | Previous Typst | Final candidate | Chromium |
| --- | ---: | ---: | ---: |
| Warm median | 40.22 ms | 42.59 ms | 62.38 ms |
| Warm p95 | 44.20 ms | 59.14 ms | 112.29 ms |
| Process-tree peak commit | 145.04 MiB | 151.94 MiB | 234.41 MiB |
| Total job CPU | 3422 ms | 4438 ms | 9891 ms |

The candidate is approximately 32% faster at the median, 47% faster at p95 and 35% lower peak commit than Chromium in this local run. Relative to previous Typst it costs about 2.4ms median, 15ms p95, 6.9MiB peak commit and 30% more CPU. Repeated preliminary candidate runs showed similar p95 (59–60ms). Longer receipts are an intentional readability cost: the basic fixture grew from 638 to 847 dots; Chromium was 950. Do not describe this as a free performance improvement or as verified on customer hardware.

Evidence: ignored `scratch/thermal-quality-before`, `scratch/thermal-quality-final`, and `scratch/thermal-quality-{baseline,final,chromium}-resource.{render,resources}.json`. Resource runs used `scripts/reviews/spooler-render-resources.ps1 -CompiledOnly -Rounds 5`; baseline files were restored from HEAD temporarily and candidate bytes restored in a finally block. E2E command: `node scripts/reviews/typst-spooler-e2e.cjs`, with SPOOLER_TYPST_EXE, SPOOLER_TYPST_FONT_DIR and PUPPETEER_CACHE_DIR pointing to the staged Full runtime.

Ready for a small physical acceptance trial, not proof of identical Chromium paper quality. Compare Arabic dots/joins, long notes, receipt length and QR scanning on the restaurant's actual printer/paper/density. Existing installers built before this commit do not contain these changes.
