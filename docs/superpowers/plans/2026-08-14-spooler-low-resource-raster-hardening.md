# Low-resource spooler raster hardening implementation plan

> **For the implementing agent:** Follow this plan in order. Keep the existing single-job queue, Arabic HTML rendering, alert/cut behavior, acknowledgement semantics, and `spooler.env` handling unchanged. Do not add dependencies, DB work, customer-specific branches, or cash-drawer pulse tuning.

**Goal:** Reduce print latency and memory pressure on low-end Windows POS terminals, make long raster jobs safe for constrained printers, and preserve all existing physical-print and updater guarantees.

**Architecture:** Keep Puppeteer because Chromium performs the Arabic shaping and CSS layout. Replace the PNG re-encode plus `escpos.Image` object-heavy conversion with one direct RGBA-to-ESC/POS encoder that emits bounded `GS v 0` bands. Warm the complete render/decode/encode path at service boot, log only aggregate stage timings, and package Puppeteer's lighter `chrome-headless-shell` as a runtime-layer change.

**Tech stack:** Node.js CommonJS, Puppeteer 24, node-canvas, escpos 3, focused Node assertion tests, Vitest package/update contracts.

## Evidence and non-goals

- The current cash-drawer command is `ESC p 0 25 250`: a 50 ms latch pulse followed by 500 ms off time. ESC/POS pulse timing controls the electrical drawer-kick output; it does not control drawer travel after the latch releases. A drawer that flies open hard needs mechanical inspection or model-specific spring/damper adjustment. Do not shorten the pulse and risk intermittent failure.
- The current raster path decodes the screenshot, rewrites every pixel, encodes a second PNG, decodes it again through `escpos.Image`, creates per-pixel JS objects/arrays, and builds another raster array.
- Measured locally on the same receipt: the current post-processing path used roughly 419-425 MB Node RSS and 196-202 ms steady time; direct RGBA packing used roughly 151-173 MB RSS and 148-150 ms.
- Full Chrome used roughly 329 MB idle / 411 MB active across its process tree; `chrome-headless-shell` used roughly 148 MB idle / 266 MB active in the matched probe.
- Do not parallelize jobs, reduce the 576-dot print width, replace browser Arabic shaping with printer text, close Chromium after every job, change print-queue acknowledgement rules, or alter when the drawer opens.

## Task 1: Pin direct raster encoding with hostile tests

**Files:**
- Create: `pos-spooler-printer/tests/thermal-raster.test.js`
- Create: `pos-spooler-printer/thermal-raster.js`
- Modify: `pos-spooler-printer/tests/run-tests.js` only if discovery is not automatic

1. Add RED tests for exact one-byte bit packing, alpha/brightness threshold behavior, non-byte-aligned widths, invalid dimensions/data, and a 576×5000 image split into ordered bands no taller than 256 rows.
2. Run only `node pos-spooler-printer/tests/thermal-raster.test.js` and confirm it fails because the module is missing.
3. Implement `encodeRasterBands(imageData, options)` with the existing threshold (`alpha > 50`, luminance `< 130`) and exact `GS v 0` headers. Return buffers in top-to-bottom order; default to 256 rows per band.
4. Re-run the focused test and confirm GREEN.

## Task 2: Replace the object-heavy image pipeline without changing job semantics

**Files:**
- Modify: `pos-spooler-printer/server.js`
- Modify: `pos-spooler-printer/tests/spooler-report-rendering.test.js`

1. Expand the spooler rendering harness first so a 513-row job must emit exactly three raw raster bands, and assert one alert, one cut, one close, and one physical write. Assert `escpos.Image.load` and `printer.raster` are not used.
2. Run the focused rendering test and confirm RED.
3. In `processPrintJob`, keep screenshot and node-canvas decode, call `getImageData`, encode bounded bands, then append each band through `printer.raw` before applying alerts and cutting once.
4. Remove PNG re-encoding, `escpos.Image.load`, `printer.raster`, and the mutable-canvas threshold pass.
5. Use `try/finally` around each browser page so render failures cannot leak pages.
6. Re-run the raster and rendering tests and confirm GREEN.

## Task 3: Warm the complete cold path and expose safe stage timings

**Files:**
- Modify: `pos-spooler-printer/server.js`
- Modify: `pos-spooler-printer/tests/spooler-report-rendering.test.js`

1. Add a RED harness assertion proving startup renders a tiny internal Arabic receipt through screenshot, canvas decode, and raster encode without touching a printer.
2. Replace browser-only boot with `warmRenderingPipeline()`. It must create and always close its own page, disable JavaScript/external requests, render a tiny fixed internal document, decode and encode it, discard the result, and leave the browser reusable.
3. Record monotonic per-job durations for render, raster encode, transport, total, and RSS MB. Log only job type, queue ID if present, numeric timings, and memory; never receipt/customer data.
4. Ensure failures retain the existing rejection/acknowledgement behavior and the timing log cannot itself fail printing.
5. Re-run the focused rendering and queue tests.

## Task 4: Package the lighter browser as an explicit runtime-layer change

**Files:**
- Modify: `pos-spooler-printer/.puppeteerrc.cjs`
- Modify: `pos-spooler-printer/package.json`
- Modify: `pos-spooler-printer/server.js`
- Modify: `pos-spooler-printer/tests/browser-smoke.test.js`
- Modify: `deployment/tools/spooler-layer-manifest.js`
- Modify: `backend/tests/unit/spoolerPackageContract.test.js`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`

1. Change package/update contract assertions first to require `chrome-headless-shell` and make them RED.
2. Configure normal `npm ci`/postinstall to skip browser downloads, make `npm run setup-browser` explicitly install `chrome-headless-shell`, and launch Puppeteer with `headless: 'shell'`.
3. Make runtime manifest detection require exactly one build under `.cache/puppeteer/chrome-headless-shell`; keep the whole `.cache` inventory in the browser layer.
4. Update fixture directories and error assertions so an old full-Chrome-only cache fails closed rather than producing an incorrect runtime identity.
5. Install the ignored local shell runtime with `npm run setup-browser`, run the browser smoke test, and verify JavaScript and remote requests remain blocked.
6. This must be delivered to installed customers through the spooler **runtime updater**, not the core-only updater. Do not rebuild installers or run an updater in this task.

## Task 5: Synchronize deployment inventory and architecture documentation

**Files:**
- Modify: `deployment/tools/spooler-layer-manifest.js`
- Modify: `backend/tests/unit/spoolerPackageContract.test.js`
- Modify: `docs/architecture.json`
- Modify: `docs/deferred-spooler-long-report-raster-corruption.md`

1. Add `thermal-raster.js` to the canonical application roots and tracked package contract.
2. Update the spooler architecture node to describe shell-based HTML rendering and bounded direct raster bands; keep queue/idempotency invariants unchanged.
3. Change the deferred long-report note to “mitigation implemented, customer hardware verification pending”; do not close the issue or claim the customer model is confirmed.
4. Run the architecture validator required by the repository.

## Task 6: Break the finished implementation and verify proportionally

1. Run the focused direct-raster test.
2. Run the focused spooler rendering, printer-alert, queue/idempotency, and browser smoke tests.
3. Run the backend spooler package and installer/update contract tests.
4. Run the spooler-owned syntax/test command.
5. Re-run a repeatable local benchmark comparing the new direct path with the recorded baseline; report measured values, not estimates.
6. Inspect `git diff --check`, `git status --short`, and the final diff for secrets, generated cache files, unrelated changes, alert/cut duplication, and updater/config drift.
7. Do not deploy, push, merge, rebuild installers, mutate production, or change `spooler.env`.

## Failure cases the implementation must survive

- Zero/negative/fractional dimensions, insufficient RGBA bytes, and non-byte-aligned widths fail before printing.
- Transparent dark pixels remain white; threshold parity matches the old path.
- A 5,000-row report has no omitted, duplicated, or reordered row and no band exceeds 256 rows.
- A 513-row job emits 256 + 256 + 1 rows but still produces exactly one alert sequence, one cut, one transport write, and one queue acknowledgement.
- A screenshot, decode, page-close, printer connection, or write failure follows the existing error/uncertain-job rules.
- Chromium crash recovery and cold startup do not leak pages or create concurrent printers/jobs.
- Full-Chrome-only cache, missing shell cache, multiple shell builds, or mismatched runtime identities fail closed in packaging/updating.
- Both network and Windows printer paths receive the same concatenated ordered band buffers.
- Cash-drawer behavior remains unchanged because the reported force is not a software pulse-duration problem.
