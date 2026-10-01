# Low-resource receipt experiments and research

Production baseline remains `11280216`; benchmark baseline checkout is `49c78fec`. This pass changes experiments and evidence only, preserving the audit/research scope. No production dependency, service or device setting changed.

## Measured results

Six sequential runs each rendered and transmitted 432 customer/kitchen documents through the real TCP transport to a loopback receiver (2,592 total). All received bytes and artifact hashes matched baseline. Nine workloads include Arabic/English, bundles, QR receipts, kitchen voids and subscriptions. Windows job accounting includes Node, Chromium, exited children and the receiver. All jobs, including page recycling/startup, count toward latency and resources. The marker callback is a stub: journal/service/helper and cloud overhead are excluded. Same Node 22.23.0 and staged Chromium throughout; no concurrent benchmarks.

| Experiment | CPU seconds | Elapsed seconds | Peak committed MiB | Sampled peak summed working set MiB |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 19.58 | 28.11 | 248.47 | 399.96 |
| Release decoded image immediately | 17.81 | 28.06 | 246.41 | 401.95 |
| pngjs direct RGBA decode | 21.83 | 28.63 | 233.32 | 379.49 |
| Close initial blank page | 19.42 | 28.36 | 225.20 | 348.73 |
| Close initial blank page repeat | 19.61 | 28.63 | 227.52 | 346.12 |
| Baseline repeat | 19.84 | 28.11 | 247.15 | 408.83 |

**Best supported candidate: close Chromium's unused startup page.** Peak committed memory fell about 8–9%; sampled peak working set fell about 13–15%. CPU was essentially flat. The repeated blank-page run delivered basic customer receipts at median/p95 66.42/99.32 ms and normal kitchen tickets at 67.18/98.02 ms, versus baseline 66.01/99.54 and 66.15/98.25 ms. This is a repeatable memory reduction without a demonstrated speed improvement. Production adoption needs launch-timeout, page-recycle, crash and shutdown regression verification, including the period with no open page. The benchmark succeeded through repeated page recycling but is not that full lifecycle test.

Immediate decoded-image release saved only about 2 MiB committed memory in one run and did not reduce sampled peak working set. Its apparent CPU saving needs repetition; it is not an established memory win. pngjs saved roughly 14–15 MiB committed memory but used about 10–12% more CPU than the two baselines. It is a memory/CPU tradeoff, not the default choice for weak processors.

## Online research and source checks

- [Puppeteer page.close](https://pptr.dev/api/puppeteer.page.close) provides a supported page lifecycle operation. The current renderer creates its own page while Chromium's initial blank page stays open; closing that unused page was the experiment above. No unsupported browser flags or process-sharing changes were used.
- [node-canvas image cleanup discussion](https://github.com/Automattic/node-canvas/issues/2576) suggested assigning an empty buffer to release image state. This was verified against the installed `src/Image.cc`: `SetSource` invokes `clearData` before loading the new source. The adapter clears only a successfully drawn image, after its pixels are on the canvas. It is an experiment, not reliance on an unverified issue comment.
- [pngjs](https://github.com/pngjs/pngjs) supports direct RGBA decoding without native dependencies. The benchmark uses the already-installed root dependency through an adapter, avoiding Cairo's image/drawing/getImageData path. Production canvas remains loaded in this harness, so this does not measure potential installation-size or native-library-unloading savings. It does measure the decode-path tradeoff and output equality on these fixtures. No gamma correction is applied; arbitrary color/profile/alpha fixtures would need broader equivalence checks before adoption.
- [Sharp cache and concurrency controls](https://sharp.pixelplumbing.com/api-utility/) matter for any future native decode experiment: the default operation cache permits 50 MB, and concurrency normally follows CPU cores. A low-resource experiment should explicitly compare bounded cache and one-thread settings; simply adding Sharp with defaults is not evidence of reduced resources. Sharp was researched, not installed or benchmarked here.
- [Node heap limits](https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib) govern V8 old-space, not total Node/native/Chromium memory. Node documents increased garbage-collection work near the limit. Lowering `--max-old-space-size` does not establish a total-device memory cap and can increase CPU; it was not applied.

## What would establish low-end support

These workstation experiments establish relative resource costs, not a minimum supported device. Summed working sets can double-count shared pages and are sampled; committed memory is a separate measure. The renderer still needs a substantial Chromium footprint. Do not advertise support for a specific RAM/CPU tier from these results.

The next acceptance run should use a representative modest Windows station with the full service, realistic retained journal data, customer/kitchen bursts, a long ticket, intermittent printer connectivity and concurrent POS usage. Measure sustained and idle private/working-set memory, CPU, page faults, queue age, and first-byte tail latency. Preserve hash checks, fsync and uncertain-delivery rules. Artificial page CPU throttling alone would not reproduce disk, memory-pressure or printer behavior.

A future idle-browser shutdown could reduce idle memory much further but adds cold-start work and latency to the next print, conflicting with immediate receipt delivery unless deliberately accepted. A browser-free layout rewrite could lower the footprint more radically, but Arabic shaping, templates, fonts and pixel output require a separate proof. Neither was implemented or measured in this pass.

## Reproduce

Run `powershell -NoProfile -File scripts/reviews/spooler-render-resources.ps1 -OutputPrefix scratch/lowend-baseline -Rounds 12 -ReceiptTransport`. Repeat sequentially with fresh prefixes and `-Experiment release-image`, `-Experiment pngjs`, or `-Experiment close-blank`; finish with another baseline. Compare all hashes and all-job percentiles, not warm samples only.

[Per-workload evidence](2026-09-07-low-resource-experiments.json) includes every run's aggregate resources, exact-byte outcome, event-loop delay, and receipt latency. Raw measurements remain under ignored `scratch/spooler-audit/lowend-*`. No physical printer was used, no production configuration changed, and nothing was deployed.
