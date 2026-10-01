# Customer/kitchen capture and TCP experiments

Baseline production code: `11280216`. No production changes were selected: neither fast PNG capture nor TCP_NODELAY demonstrated a repeatable improvement in receipt speed and CPU/memory together.

## Method

Extended the existing benchmark with receipt-only real TCP delivery. Each run renders 288 documents: eight rounds of nine legacy/compiled customer and kitchen workloads, four executions each. Fixtures include bundles, QR receipts, voids and subscriptions. Each artifact is fsynced by the actual renderer, passed to the actual TCP transport (including hash verification), and checked against bytes received by a local TCP server. Every sample, including first-job startup and page recycling, is included in latency percentiles. No reports are included.

Windows job-object accounting includes Node, Chromium and the loopback receiver. CPU totals include exited processes and startup; peak committed memory covers the process tree. Summed working sets are sampled and can double-count shared pages. Runs were sequential with no concurrent test workloads, using packaged Node 22.23.0 and staged Chromium. Ordering: baseline, fast PNG, TCP_NODELAY, repeated baseline, repeated fast PNG.

This measures render-to-receiver delivery, not cloud acceptance or physical printing. The durable transport-marker callback is a test stub, so journal-marker latency is excluded. Network delay, printer buffering, firmware behavior, physical completion, USB/Windows printer paths and packet-loss recovery were not measured. The prior mixed-queue benchmark remains the evidence for scheduling; this test intentionally isolates receipt rendering and TCP transmission.

## Results

| Variant | CPU-seconds | Wall seconds | Peak committed MiB | Sampled peak summed working set MiB |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 14.36 | 24.07 | 242.79 | 409.18 |
| Fast PNG | 13.02 | 18.26 | 247.77 | 396.23 |
| TCP_NODELAY | 13.86 | 19.11 | 246.11 | 388.52 |
| Baseline repeat | 13.67 | 18.98 | 246.91 | 398.86 |
| Fast PNG repeat | 16.69 | 19.89 | 245.68 | 390.47 |

The first baseline's longer total time did not repeat. Fast PNG's CPU advantage reversed on repetition. Its small memory differences do not establish a reliable saving. TCP_NODELAY offered no useful receipt latency improvement over either baseline; a printer-network-specific effect remains possible but unproven by loopback.

| Variant | Basic customer first-byte median / p95 | Normal kitchen first-byte median / p95 |
| --- | ---: | ---: |
| Baseline | 65.49 / 100.32 ms | 66.16 / 99.05 ms |
| Fast PNG | 66.36 / 99.93 ms | 65.36 / 96.02 ms |
| TCP_NODELAY | 66.00 / 100.36 ms | 68.30 / 98.30 ms |
| Baseline repeat | 65.77 / 100.43 ms | 66.04 / 99.49 ms |
| Fast PNG repeat | 66.90 / 105.72 ms | 65.37 / 98.50 ms |

The baseline transport stage alone (connect, hash validation, send and receiver completion) had customer/kitchen medians of about 1.1–1.2 ms. Cutting transport overhead has little local latency headroom. Removing verification or holding persistent printer connections is not justified by this measurement; the latter also needs actual device compatibility evidence.

All 1,440 documents matched baseline artifact hashes and received bytes. Existing transport and worker scripts passed separately, covering marker-before-write, hash mismatch, bounded writes, failure classification and worker scheduling. Tests do not turn bytes-sent confidence into paper-output confidence.

## Reproduce

Run `powershell -NoProfile -File scripts/reviews/spooler-render-resources.ps1 -OutputPrefix scratch/receipt-baseline -Rounds 8 -ReceiptTransport`. Repeat with a fresh prefix and `-Experiment png-speed`, or `-NoDelay`. Keep runs sequential; repeat baseline to detect drift. These flags affect only the benchmark, not production defaults.

[Compact per-workload evidence](2026-09-07-receipt-transport-experiments.json) includes all samples' equality outcome and all-job median/p95 summaries. Raw render/resource JSON and transport/worker logs remain under ignored `scratch/spooler-audit/receipt-*`.

Next useful investigation is a printer-network trace on representative hardware, or an isolated alternative decoder experiment targeting memory. Neither is a demonstrated improvement yet. Idle-time page replacement also remains untested; these sustained receipt runs exercise the current replacement behavior. Keep current production settings based on the evidence above.
