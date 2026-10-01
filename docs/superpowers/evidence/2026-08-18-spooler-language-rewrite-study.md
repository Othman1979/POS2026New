# Should the spooler be rewritten in Go / Rust / C# / C++?

**Date:** 2026-08-18
**Question (owner):** compiled languages have fast compilers and high performance; the spooler is small; why keep compiling JS libraries and heavy code instead of rewriting it in Go/Rust/C#/C++ — even if that changes how receipts are built?
**Answer in one line:** the premise is half right and points at a real problem, but the heavy thing is not our JavaScript — it is a 265 MB browser we ship to do **Arabic text layout**. That reframes the decision, and it changes which language wins.

## 1. What is actually installed and running (measured, this branch)

| Component | Size | What it is |
|---|---|---|
| `chrome-headless-shell` | **265 MB** | Chromium, shipped to every terminal |
| `node_modules` | **94 MB** | 154 packages; `canvas` alone is 36 MB (Cairo native bindings) |
| Node runtime | ~50-90 MB | shipped as its own update layer |
| **Our actual code** | **~200 KB** | see below |
| (`chrome`, 409 MB in a dev checkout) | — | **not shipped** — `.puppeteerrc.cjs` sets `chrome.skipDownload`, and `spooler-layer-manifest.js:102` packages only `chrome-headless-shell` |

Our code, in full:

| Area | Lines |
|---|---|
| V2 agent (identity, journal, sync, workers, transports, status, renderer glue) | **2,372** |
| Document/report generation (`renderDocument`, `report-html`, `receiptDisplayV1`, raster, alerts) | **1,106** |
| Windows helper (C#) | **389** |

So: **~3,900 lines of our logic riding on ~410 MB of runtime.** The instinct that "the spooler isn't even that big to refactor" is correct about our code. The dependencies are the weight — and they are not there because of JavaScript.

## 2. The finding that changes the decision

`v2/artifact-renderer.js:439` calls **`page.setJavaScriptEnabled(false)`** before rendering.

Chromium executes none of our code. It is used strictly as a **text shaping + layout + rasterization engine**: we hand it HTML with `dir="rtl"` and `font-family: Tahoma, 'Segoe UI'` (`:194`, `:296`); it performs Arabic contextual shaping, bidirectional reordering, line breaking and flexbox column layout; we screenshot the result in 256-row clips (`:449-458`).

That is why an earlier performance plan for this spooler was rejected: the bottleneck was never JS execution, and native ESC/POS text mode cannot render Arabic acceptably. **We pay 265 MB and ~360 ms per large report for typography, not for a scripting runtime.**

Consequence: rewriting the *agent* in Go/Rust/C# while keeping Chromium moves almost none of the weight. The prize is unlocked only by replacing the **renderer**.

## 3. Where the time actually goes (measured earlier this session, dev-class hardware)

| Stage | 200-row Arabic report | Small receipt |
|---|---|---|
| Chromium render (layout + screenshot) | **~360 ms (~65%)** | 86 ms |
| Canvas → raster encode (native Cairo) | **~180 ms (~32%)** | 9 ms |
| TCP transport to printer | ~25 ms | 1-4 ms |
| **Total** | **~560 ms** | ~90-95 ms |
| Peak RSS | 190-360 MB | — |
| Worst synchronous event-loop stall | ~110 ms | ~10 ms |
| Cold start (browser launch + warm render) | ~660 ms | — |

On a Celeron, multiply single-thread figures roughly 3-6×.

**Render + raster = ~97% of a job**, and both are already native code (Chromium, Cairo). Rewriting the ~3% that is our orchestration JavaScript into a compiled language buys approximately nothing in print latency.

## 4. What a rewrite would and would not buy

**Would buy — but only if the renderer is replaced too:**
- Install footprint per terminal: ~410 MB → **~15-30 MB**
- Peak RSS: ~300 MB → ~30-50 MB (this matters on 2-4 GB Celeron terminals)
- Large report: ~560 ms → plausibly **under 100 ms**; the ~110 ms event-loop stall disappears
- Cold start: ~660 ms → tens of ms
- Supply chain: 154 npm packages → a handful of vetted libraries
- No Chromium security-patch treadmill on customer machines
- One self-contained binary: no Node runtime layer, no `node_modules` update transaction

**Would not buy:**
- **Any fix for the failures we actually see in the field.** Permanent offline, duplicate prints, lane stalls, dead stations after rollback — every one is a protocol/state-machine defect (5 HIGH + 10 MEDIUM in the current audit). They are language-independent, and a rewrite would have to re-derive every one of those invariants in a language with none of the current test coverage.
- Perceived speed at the counter: a receipt is ~90 ms warm here (~0.3-0.5 s on a Celeron); paper feed and printer mechanics dominate what a cashier experiences.

## 5. Language assessment — and why the intuitive answer is wrong

The hard part is **Arabic shaping + bidi + receipt layout**, not compute speed. Ranked for *this* job:

| Candidate | Text stack for Arabic | Verdict |
|---|---|---|
| **C# / .NET 8** | **DirectWrite ships inside Windows** and does shaping + bidi natively (it is what Edge and Word use); SkiaSharp bundles HarfBuzz as an alternative. Self-contained single-file AOT binary ≈ 10-20 MB. | **Strongest fit.** The helper is *already* C# (389 lines), already spawned and supervised over NDJSON, already calls Winspool. The target is 100% Windows, so cross-platform is not something we would be giving up. Winspool becomes in-process, which deletes the whole helper-containment defect class (audit M2, M6, P-helper) rather than fixing it. |
| **Rust** | `cosmic-text` (rustybuzz + swash + unicode-bidi) covers shaping, bidi and line layout; `tiny-skia` rasterizes. ~5 MB binary, excellent performance and memory safety. | **Viable second.** Best raw ceiling, but a brand-new toolchain in this repo and we own more of the text stack ourselves. |
| **Go** | **Weakest for this specific job.** `golang.org/x/image/font` has no Arabic shaping; you must cgo-bind HarfBuzz + FriBidi, which on Windows is the most painful build story of the four. | The fast-compiler advantage is a developer-cycle benefit, irrelevant to print latency. Go would be an excellent pick if this work were network/concurrency-shaped — but it is typography-shaped. |
| **C++** | Maximum control (HarfBuzz/FreeType/Skia directly). | Highest ceiling, worst maintenance and safety story for a small team. Not justified here. |

Two framing corrections worth stating plainly: JavaScript is not compiled at install time — what is heavy is Chromium plus native modules (`canvas` = Cairo bindings). And "Go is fast" is true but aimed at the wrong bottleneck: **we are not CPU-bound on our own logic, we are dependency-bound on a layout engine.**

## 6. The surgical path: the renderer is already a clean seam

Rev 2.1's Task 3 created `artifact-renderer.js` with one job and one interface:

```
render(job) -> { path, hash, bytes }     // a bounded, hashed ESC/POS artifact on disk
```

Everything downstream — journal states, transport marker, uncertain/duplicate protection, per-printer lanes — consumes only that artifact. **The renderer can therefore be replaced without touching the state machine we just audited.**

Recommended staging:

1. **Prove the renderer in isolation.** Build a native renderer (C# first choice) as a standalone binary taking the same job JSON and emitting the same artifact. No agent changes.
2. **Differential raster harness — the safety net that makes this honest.** Run the existing 200-row Arabic fixture plus real receipts and kitchen tickets through *both* pipelines and compare rasters pixel-by-pixel with a tolerance report. We have zero visual regression coverage today; this harness is worth building even if we never switch.
3. **Swap behind the interface** on one lab station for one printer type, keeping Chromium as a config-selectable fallback for one release.
4. **Delete Chromium, `canvas`, and — if the agent later moves to C# as well — the Node runtime**, once the canary is clean.

Scope for step 1: the layout vocabulary is small and bounded — centered header lines, two/three-column rows (qty / name / amount), dashed and solid separators, section titles, RTL blocks, a handful of font sizes and weights, no images, fixed 576 px width. The server's compiled-document contract is likewise narrow (`printDocumentCompiler.js` is 282 lines; rows with `item` / `bundle_child` kinds). `thermal-raster.js` (47 lines) ports as-is. The real work is a line-box layout engine plus shaping calls: meaningful, bounded, and the only part that must be rewritten to win the whole prize.

## 7. Recommendation

1. **Do not rewrite now.** Finish the audit remediation first (5 HIGH defects in flight). Rewriting mid-remediation discards a state machine that is close to provably correct and re-derives its invariants in a language with no tests.
2. **Do not rewrite the agent at all, for now.** Those 2,372 lines of sync/journal/worker logic are the audited, valuable part; their language is not the problem.
3. **Do plan a native renderer** — 97% of the cost and 100% of the footprint live there, behind an interface that already exists. C#/.NET first choice, Rust second, Go last *for this particular job*.
4. **Build the differential raster harness regardless.** It closes a real existing test gap and is the precondition for any renderer swap.
5. **Free win available today, no rewrite:** verify on a real installed station that no customer machine carries the 409 MB `chrome` directory. Config and layer manifest say only `chrome-headless-shell` ships; a dev-shaped install would be wasting 409 MB per terminal.

Decision trigger: if field terminals show memory pressure, or a large report's ~0.5-3 s (Celeron) delays kitchen tickets queued behind it, the renderer swap moves from "worth planning" to "do next". Both are already measurable from the `SPOOLER_PRINT_TIMING` line the agent logs for every job.
