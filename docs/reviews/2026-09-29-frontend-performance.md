# Frontend performance pass: 2026-09-29

## Headline

On a venue link, the admin dashboard now loads about 28–32% faster and the customer QR menu about 23–31% faster (Arabic gains the least). A cold register load is about 150–175 ms faster.

Using the register (category switch, add to cart, big carts, the 80-table floor) was already smooth, and it stays smooth.

Baseline was master `cc620cc8`, and the result is master `abccf06f`.

## Method

The measurements used `scripts/reviews/perf-venue-measure.cjs`, derived from `scripts/reviews/pos-frontend-audit.cjs` with network emulation added:

- **Build and data:** the production build, served over a loopback fixture with synthetic data (1,440 products, 80 tables).
- **Browser:** Chromium 148.
- **Network:** CDP emulation of a venue link at 1.6 Mbps down, 750 Kbps up and 150 ms RTT, with brotli.
- **CPU:** throttled 4x.
- **Runs:** median of 3, in English and Arabic.

To reproduce: build each revision with `npx vite build --outDir scratch/perf-hunt/dist-<label>`. Then run `node scripts/reviews/perf-venue-measure.cjs --dist scratch/perf-hunt/dist-<label> --label <label> --compress br --runs 3 --langs en,ar`, and compare with `node scripts/reviews/perf-venue-summary.cjs <before> <after>`. Labels are lowercase, and runs must not share the CPU with other work.

Both builds were measured back to back on a quiet machine. Differences under about 50 ms are within run-to-run noise. These are lab numbers, not measurements from customers' devices.

## Results (en / ar)

| Metric | Before | After | Change |
|---|---|---|---|
| Register cold load, grid painted | 1960 / 2308 ms | 1812 / 2132 ms | −148 / −176 ms |
| Register cold LCP | 2128 / 2632 ms | 1960 / 2460 ms | −168 / −172 ms |
| Register cold transfer | 317.2 / 451.9 KB | 308.1 / 442.9 KB | −9 KB |
| Admin dashboard cold load, ready | 2629 / 2910 ms | 1779 / 2083 ms | **−850 / −827 ms** |
| Admin first contentful paint | 2372 / 2712 ms | 1632 / 1972 ms | −740 / −740 ms |
| Admin cold transfer | 265.9 / 627.9 KB | 232.5 / 594.5 KB | −33 KB |
| QR menu, ready | 1738 / 2240 ms | 1204 / 1718 ms | **−534 / −522 ms** |
| Table QR menu, ready | 1923 / 2452 ms | 1430 / 1948 ms | −493 / −503 ms |
| Warm register reload | 660 / 664 ms | 654 / 664 ms | unchanged |
| Category switch / add to cart (4x CPU) | 64 / 47 ms | 64 / 47 ms | unchanged; 0 long tasks |
| Dropped frames in a 24-click category burst | 0 / 1 | 0 / 2 | noise |
| 80-table floor paint | 133 / 154 ms | 137 / 158 ms | noise |
| Heap growth over 100 interactions | +0.1 MB, 0 nodes, 0 listeners | +0.1 to 0.4 MB, 0 nodes, 0 listeners | no leak |

Initial JS per entry, brotli-11 (from `scripts/reviews/perf-venue-bytes.cjs`):

| Entry | Before | After |
|---|---|---|
| POS / login | 75.9 KB | 66.7 KB |
| POS + register route | 166.5 KB | 157.0 KB |
| Admin | 58.1 KB | 49.0 KB |
| Menu | 61.9 KB | 57.8 KB |
| Print | 77.1 KB | 67.7 KB |

Admin and menu also no longer load the parser-blocking, unminified `/socket.io/socket.io.js`. That file was 152 KB raw and 31–37 KB on the wire, and it was revalidated on every load.

## What changed (one PR each, revert with `git revert -m 1 <merge>`)

Revert order: #70 and #71 edit `vite.config.mjs` after #67. To revert #67, revert #71 and #70 first, newest first. Every other PR reverts on its own.

- **#66:** removed the unused `window.Vue` global, which kept all of Vue in the shared chunk. Every entry is 9 KB brotli smaller.
- **#67:** admin and menu bundle `socket.io-client` in a shared, immutable chunk instead of the blocking script.
- **#68:** admin boot starts the business config, the language and the first page chunk together.
- **#69:** QR menu:
  - removed the fixed 300 ms skeleton wait;
  - the share QR is built only when its dialog opens;
  - the draft is not echoed back;
  - a replaced chunk triggers one reload.
- **#70:** the register route is modulepreloaded from `index.html`.
- **#71:** Chart.js loads when the pace chart draws. It is still tree-shaken, with a render generation guard.

## Looked at and decided against

- **Serving our own brotli, gzip or zstd:** the Hostinger CDN already serves brotli. zstd came out larger than brotli-11 here. Revisit only for an uncompressed deployment.
- **Vite 8.3.0 → 8.3.1:** bug fixes only. It is a routine bump after the release.
- **`build.target` Chrome 111:** about −2% JS, but it drops Chrome 87–110 tills.
- **lightningcss, font preloads, `content-visibility`, extra chunk groups, Vue 3.6 Vapor:** no measurable gain, or not stable yet.
- **Amiri font subsetting:** deferred as a design task. Arabic admin cold load fetches 363 KB of fonts, but they don't block readiness.

## Follow-ups

- Admin preload: canonicalise redirected routes, and skip the preload for non-admin sessions.
- Preload the reports layout together with the report pages.
- Move the oxc runtime helpers out of the vendor-chartjs chunk, so a first PDF export doesn't pull in Chart.js.
- After deploy, run a read-only check that hashed assets come back with `Cache-Control: public, max-age=31536000, immutable` through the CDN.
