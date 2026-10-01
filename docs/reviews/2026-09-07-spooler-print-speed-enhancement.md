# Measured printing-speed enhancement

Baseline: `ca34458c`. Scope: local rendering and its effect on delivery latency. Installer, Node versions, dependencies, transport ordering, and durable delivery rules are unchanged.

## Implemented

- Reuse one restricted Chromium page for up to eight documents, then replace it within the existing render deadline. Keep one browser and serial rendering; no job batching or additional browser concurrency.
- Dispose the document element handle after measuring its bounds. Replace the complete document on each render; configure network blocking and disabled JavaScript once per page.
- Release the Cairo raster surface immediately after encoding each capture instead of retaining its native pixel allocation until garbage collection. Screenshot dimensions and ESC/POS band geometry remain unchanged.
- Retire a browser after a failed render and recover on the next job. Discard stale page references when the browser disconnects. Check abandonment after asynchronous render steps so a late operation cannot write into a cleaned-up artifact. A hung page replacement is subject to the render timeout.

## Measurement-driven selection

Unrestricted reuse lowered CPU but retained more memory in exploratory runs. Isolated 32-document reuse without explicit surface release used 322 MiB peak committed memory versus the baseline's 310 MiB. Eight-document reuse alone still reached 316 MiB. Releasing the native surface brought peaks below baseline. With surface release, the 32-document option retained roughly 29 MiB more steady working-set memory than baseline; eight-document reuse retained roughly 9–15 MiB more. The eight-document limit was selected for the more conservative sustained-memory tradeoff.

Each resource run rendered 800 documents: twenty rounds of ten workloads, with four executions per workload per round. Workloads include legacy customer/kitchen receipts, a 200-row report, and compiled basic, bundle, QR, normal/void kitchen, and subscription tickets. Resource totals include every execution and startup. Per-workload medians exclude the first execution in each four-job group; the complete-batch time includes page replacement costs.

Runs used Node 22.23.0 and the staged Chromium on this Windows host. Each final comparison ran alone, with tests stopped. A Windows job object accounts for Node and Chromium CPU, including exited child processes, and peak committed memory. Working sets are sampled about every 100 ms and summed; shared pages may be counted more than once. These are different memory measures and must not be conflated.

| Whole 800-document workload | Baseline | Eight-document reuse + surface release, two runs |
| --- | ---: | ---: |
| Total CPU work | 107.5 CPU-seconds | 63.9 / 51.0 CPU-seconds |
| Elapsed time including startup | 112.1 s | 89.9 / 83.8 s |
| Peak job committed memory | 310.5 MiB | 290.8 / 294.3 MiB |
| Sampled peak summed working set | 456.3 MiB | 440.7 / 441.0 MiB |
| Early steady working set, median | 372.7 MiB | 380.0 / 383.3 MiB |
| Late steady working set, median | 371.2 MiB | 380.7 / 385.8 MiB |
| Event-loop delay p99 | 29.9 ms | 33.5 / 30.6 ms |
| Event-loop delay maximum | 237.6 ms | 228.7 / 238.9 ms |

CPU work fell 40–53%, batch time 20–25%, and peak committed memory 5–6%. Steady working set is slightly higher; it remained roughly stable rather than increasing continuously over these runs. Event-loop p99 did not improve and was up to 3.6 ms higher; maximum delay was similar. This is not a claim that every resource metric improved or that all customer hardware is proven safe.

Final-run render medians and p95 values (60 measured samples per workload):

| Workload | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| Compiled customer receipt | 97.2 / 131.2 ms | 62.7 / 68.1 ms |
| Compiled kitchen ticket | 93.8 / 111.3 ms | 62.7 / 69.2 ms |
| Legacy customer receipt | 86.9 / 125.9 ms | 52.6 / 65.8 ms |
| Legacy kitchen ticket | 96.2 / 112.2 ms | 62.5 / 66.9 ms |
| 200-row report | 496.9 / 545.0 ms | 463.0 / 486.0 ms |

All artifact hashes matched baseline across all ten workloads and every measured candidate run. No lossy encoding, resolution reduction, or template simplification was used.

## Delivery and recovery verification

The existing four-lane mixed-burst benchmark uses actual loopback TCP receivers and durable artifacts. Three samples per variant gave median acceptance-to-first-byte times:

| Job | Before | After |
| --- | ---: | ---: |
| Report | 506.5 ms | 473.6 ms |
| New kitchen ticket | 529.9 ms | 518.0 ms |
| New customer receipt | 615.7 ms | 570.5 ms |
| Already-rendered artifact | 5.7 ms | 6.5 ms |

Every received byte matched its artifact. Rendering remains nonpreemptive, so queue gains depend on the work already in progress. The ready-artifact path is unchanged; its sub-millisecond median difference is not a speed improvement claim.

All 30 spooler test scripts passed after the final changes. New real-Chromium coverage checks complete document replacement, repeat-byte equality, network/script restrictions, listener stability, closed-page recovery, screenshot failure, browser exit, and 65 further renders spanning page replacement boundaries. Focused deadline coverage verifies a hung page close cannot block recovery; existing late-page, rendering-timeout, worker ordering, and transport tests also pass. Architecture generation/check passed with its existing recorded defect unchanged. No backend suite was needed for this renderer-only change.

## Reproduce and limitations

Use [focused verification](../agents/verification.md), [the Windows resource runner](../../scripts/reviews/spooler-render-resources.ps1), [render benchmark](../../scripts/reviews/spooler-render-performance.cjs), and [queue benchmark](../../scripts/reviews/spooler-queue-performance.cjs). Compare against revision `ca34458c`. Use fresh output prefixes and run variants sequentially. [Compact evidence](2026-09-07-spooler-page-reuse-evidence.json) contains all isolated candidates, source hashes, and raw-result hashes. Raw results and test logs remain under ignored `scratch/spooler-audit/`.

These are finite local runs, not an all-day soak, low-memory station test, or physical paper verification. CPU totals cover the benchmark process tree rather than unrelated host applications. Node 20 remains supported by the unchanged requirements, but these executions used Node 22. No deployment, installed service change, printer operation, dependency upgrade, or machine configuration change was performed.
