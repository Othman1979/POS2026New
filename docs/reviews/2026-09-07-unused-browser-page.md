# Remove the unused Chromium startup page

Implemented the successful prior experiment in the production renderer. Chromium belongs exclusively to this renderer; its initial pages are closed before the browser is published as ready. Page cleanup shares the existing launch deadline. A failure or timeout retires the browser; the next render can recover. Existing page reuse, raster geometry, output, transport and journal behavior remain unchanged.

Compared baseline `cdb899a0` with the production candidate, using 432 customer/kitchen documents per run and real loopback TCP delivery. Repeated the candidate after the full test suite finished. Measurements ran sequentially, with no tests during resource collection. Node 22.23.0 and staged Chromium were unchanged.

| Metric | Before | After | After repeat |
| --- | ---: | ---: | ---: |
| CPU seconds | 19.62 | 19.95 | 19.70 |
| Batch elapsed seconds | 28.25 | 28.14 | 28.25 |
| Peak job committed memory, MiB | 243.65 | 226.84 | 226.48 |
| Sampled peak summed working set, MiB | 389.62 | 352.75 | 346.21 |
| Customer median / p95 first-byte ms | 67.49 / 100.90 | 66.48 / 117.25 | 66.66 / 100.96 |
| Kitchen median / p95 first-byte ms | 66.55 / 97.51 | 66.04 / 99.43 | 65.87 / 99.29 |

Peak committed memory fell about 7%; sampled working set fell 9–11%. CPU and throughput were essentially unchanged. The higher customer tail in the first candidate run did not repeat; the raw variation remains in the evidence. This is a memory reduction, not a printing-speed improvement.

All 1,296 document artifacts and TCP deliveries matched baseline bytes. All 30 spooler test scripts passed, including real Chromium page recycling, content isolation, browser exit/recovery and the added test that a hung startup-page close reaches the launch timeout, kills the browser and allows a later render. The real-browser test now verifies that only the active rendering page remains. Architecture generation/check passed with its existing recorded defect unchanged.

[Evidence](2026-09-07-unused-browser-page-evidence.json) uses the existing receipt resource benchmark. Reproduce the baseline with `powershell -NoProfile -File scripts/reviews/spooler-render-resources.ps1 -OutputPrefix scratch/blank-before -Revision cdb899a0 -Rounds 12 -ReceiptTransport`; repeat with a fresh prefix and no revision for current code. Do not select the historical close-blank experiment when verifying the production implementation.

Windows job accounting covers the benchmark Node/Chromium/receiver process tree, including exited child CPU. Working sets are sampled and may double-count shared pages. The transport marker callback is stubbed; full-service journal/helper/cloud overhead and real printer behavior are outside this benchmark. This does not certify any minimum-RAM device. No installer/runtime change, physical printing or deployment occurred. A browser-free rewrite remains an unproven, separate investigation.
