# Node update and receipt renderer audit

Audited against `79e5e309`. This follow-up adds repeatable rendering experiments and findings, not production updater or renderer changes. It preserves the earlier Node 20 compatibility decision while specifying how stations could migrate safely.

## Installer findings

1. **High: interrupted runtime replacement can be mistaken for a completed update.** `deployment/windows/Update-Spooler.ps1:201` calls `Copy-OwnedApplication`, including `release.json`, before replacing `node_modules` and `.cache`. If either later copy fails, `Get-ReleaseState` returns `current` on a retry because version and commit already match. The failure handler attempts a restart using the partial installation. Source tracing confirms the sequence; no installed service was fault-injected. Move completion identity after all replacement and verification, and retain recoverable previous files. Merely moving the marker does not provide rollback.
2. **High prerequisite for online upgrades: the runtime update does not contain Node.** `scripts/build-installers.ps1` builds the transition from application files, `node_modules`, and `.cache`; `Update-Spooler.ps1` replaces those roots only. `computeSpoolerRuntimeHash` in `deployment/tools/validate-payload.js` also excludes `runtime/node`. Consequently, a matching runtime hash cannot prove the Node executable satisfies new dependency requirements.
3. **Existing internet bootstrap is incomplete as an upgrade path.** `pos-spooler-printer/service/spooler-service.ps1` downloads a pinned Node 22.23.0 ZIP with a pinned hash when the local runtime is absent. If present, it checks only that the major is 20 or 22; it does not discover a newer patch or migrate an old major. Fresh packaged setup includes the pinned Node executable. Both paths use an application-local runtime, which should remain the ownership boundary.
4. **Updater success is weaker than application readiness.** `Start-Spooler` waits for the Windows service to be Running. The following cloud status request does not require a fresh successful sync from this restart, and a failed request becomes a warning. A Node/native-addon/browser incompatibility can therefore escape this completion check. The fresh installer already has a stronger fresh-sync loop to draw from.

## Recommended online update design

Use the newest **tested compatible LTS release approved for this spooler release**. Do not resolve an unrestricted `latest` executable at station update time. The official [Node download page](https://nodejs.org/en/download) currently lists Node 24 as latest LTS, Node 26 as Current, and Node 20 as EOL; the spooler currently declares only 20/22 support. Keeping existing Node 20 stations functional does not require making Node 20 the target of a new installation.

The concrete implementation should:

1. Inspect the actual service-owned `runtime/node/node.exe --version`, architecture, and OS. Include Node version and executable hash in release compatibility metadata; do not rely on global PATH or only a stored release label.
2. Resolve an approved release manifest, then download exact Node/dependency/browser artifacts into a staging directory while the spooler continues printing. Authenticate the manifest; verify artifact hashes against trusted metadata. Node publishes signed SHASUMS through its [download verification links](https://nodejs.org/en/download). A hash supplied alongside an untrusted download is insufficient authentication.
3. Check disk space and staged Node execution, native canvas loading, Chromium launch, and a known receipt render before stopping the running service. Offline failure or a rejected download should leave the working station untouched; retain an offline package path.
4. Coordinate a brief maintenance transition: stop claiming new work, let active writes reach a durable outcome, then stop the service. Do not run two agents against the same journal. Never reinterpret an uncertain print as safely retryable after restart.
5. Retain the previous application and runtime, replace the complete compatible set, and recover or roll back on copy/startup failure. Preserve machine configuration and journal state. Publish completion identity only after verified application readiness; persist enough transition state to recover from a power loss.
6. Verify a fresh local readiness signal (renderer, native modules, helper and journal) and fresh sync when reachable. A stopped-service interval is unavoidable when replacing its Node process; downloading beforehand keeps internet latency outside that interval.

Test missing/old/current Node, unsupported OS/architecture, offline download, corrupted archive, insufficient disk, locked files, interruption during each copy, native addon failure, browser failure, failed restart, rerun, and rollback. Use disposable installation fixtures and stub services before a real station trial. This is a coherent installer change, not a one-line version bump.

## Rendering measurements

The current path is compiled/legacy document to HTML, a new page in a reused headless browser, bounded PNG screenshots, canvas decode, raster conversion, durable artifact, and printer transport. It already uses one browser and serial rendering. Avoiding repeated page creation is the strongest measured next candidate.

`scripts/reviews/spooler-render-performance.cjs` now accepts `SPOOLER_RENDER_EXPERIMENT=baseline|png-speed|reuse-page`. The experiments are confined to the benchmark wrapper. Each variant rendered all ten existing workloads with one warmup and three measured samples. Runs were sequential on Node 22.23.0 with the staged browser; do not compare these medians directly to runs from a different session.

| Workload | Current | Faster PNG | Reused page |
| --- | ---: | ---: | ---: |
| Legacy customer receipt | 85.2 ms | 85.6 ms | 52.5 ms |
| Legacy kitchen ticket | 80.5 ms | 80.5 ms | 61.6 ms |
| Compiled customer receipt | 96.6 ms | 96.5 ms | 47.6 ms |
| Compiled kitchen ticket | 79.4 ms | 95.1 ms | 61.1 ms |
| 200-row report | 496.0 ms | 431.6 ms | 461.1 ms |

All measured artifact hashes match the baseline for all ten workloads, including bundles, QR receipts, kitchen voids and subscriptions. [All measurements](2026-09-07-spooler-render-experiments.json) include Node-only CPU and sampled RSS. Windows CPU samples are coarse and sometimes zero. They exclude Chromium CPU and memory, are not peak whole-device measurements, and do not establish the absence of device impact. This is a short candidate screen, not a resource soak or queue-latency test.

The reused-page prototype deliberately bypasses per-job page closure and removes the preceding request listener; browser closure disposes it at benchmark completion. It is not production-ready lifecycle code. A production version must retain JavaScript/network restrictions, fully replace document contents, recover from page/browser crashes and render timeouts, clear retired-page references, and verify that no content or listeners accumulate. Measure a long mixed receipt/report run, whole process-tree memory/CPU, event-loop delay and concurrent queue responsiveness on a modest station. Bound retained pages to one and recycle only when evidence supports a limit, outside an active render.

## Techniques and libraries

| Candidate | Assessment |
| --- | --- |
| One reusable page | Best measured next step: roughly halves basic compiled receipt latency without adding renderer concurrency. Needs lifecycle and resource verification above. |
| Puppeteer `optimizeForSpeed` | Existing [screenshot option](https://pptr.dev/api/puppeteer.screenshotoptions), no new library. Mixed results here, including a slower compiled kitchen sample; not a blanket improvement. |
| Sharp for PNG-to-pixels | [Sharp](https://sharp.pixelplumbing.com/) supports image decoding/raw pixels; it does not replace HTML layout. Current receipt raster work is only a small portion of total rendering time. Benchmark only if profiling identifies decoding or event-loop blocking as material; native packaging and pixel thresholds require verification. Not installed or benchmarked here. |
| Direct canvas or SVG layout | Could eliminate browser work but requires implementing layout, Arabic shaping/bidi, wrapping, fonts, QR and custom-template semantics. Existing [node-canvas](https://github.com/Automattic/node-canvas) is already native; adding another drawing library alone does not remove that layout work. No measured justification for this rewrite. |
| Printer-native text commands | A possible specialized path for tightly controlled printers/templates; cannot assume it preserves current multilingual/custom layouts. Requires actual printer validation. |
| More browsers or worker concurrency | Adds simultaneous CPU/memory demand. Not the first choice for low-resource stations when page reuse offers a serial-path win. |
| Whole-document screenshots or lossy JPEG | Whole-page buffers scale with document length; JPEG can alter thresholded text/QR output. Retain bounded lossless captures. |
| Caching complete receipts | Dynamic ticket data means little general reuse. Existing durable artifacts already avoid rendering a retry again; never cache by template alone. |

Priority: repair updater completion/rollback semantics and include Node in the runtime contract; then implement and soak-test one-page reuse; then add approved online runtime delivery. A runtime upgrade enables newer dependencies but is not itself a demonstrated printing speed improvement.

No production code, dependency, global Node installation, service, printer, or station configuration changed in this follow-up. No installer was built or deployed.
