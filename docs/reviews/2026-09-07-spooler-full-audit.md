# Full spooler audit — 2026-09-07

Implemented on `codex/spooler-performance-audit`, against baseline `68dbc3de`. Focus: queue latency, durable delivery, recovery, and useful verification. Large files were not treated as defects or split for size. Node 20 compatibility is retained at the user's request; dependencies and runtime requirements are unchanged.

## Changes

1. Capture up to 1,024 raster rows per browser screenshot instead of 256. Output still uses the same 256-row ESC/POS bands, 576-pixel width, and serial browser. This removes browser round trips without collecting jobs or delaying dispatch.
2. Dispatch an already-rendered artifact to an independent printer while the browser renders another job. Earlier work on the same printer still blocks it; job ownership, cancellation, and retry deadlines remain enforced.
3. Send committed sync results before awaiting the unrelated staff badge count query. Notifications remain best effort after the response.
4. Record the station's first acceptance once per accepted batch instead of once per accepted job. A 25-job batch uses 31 query calls instead of 55, with all jobs accepted.
5. Treat Windows `WINspool_JOB_STUCK` as an uncertain delivery. This error occurs after writing and ending the document; absence of a PRINTING observation cannot establish that nothing printed. Automatic retry would risk duplicates. Pre-write failures remain retry-safe.
6. Bound the platform helper's startup handshake and close failed initial startup attempts, preventing an unowned restart loop. Ignore late ready messages from a retiring helper.
7. Reject malformed successful HTTP responses before applying spooler state. An HTML HTTP 200 response previously could reactivate a locally paused/revoked runtime. Validate sync envelope collections as well.
8. Complete artifact writes even when the underlying filesystem performs a short write. Preserve fsync, rename, and hash checks. Also measure actual raster work rather than reporting zero milliseconds.

Verification guidance now documents browser cache setup and repeatable local benchmarks. The README links the existing copy-folder installation workflow. The architecture map describes the changed rendering and scheduling behavior. Tests cover observable failures and ordering; the obsolete safe-retry expectation and synchronous badge assertion were corrected.

## Measured performance

Local sequential comparisons used the same installed dependencies, Node 22.23.0, and headless Chrome 146. Each rendering workload had one warmup and three measured runs. These are local medians, not production percentiles or paper completion times.

| Rendering workload | Before | After |
| --- | ---: | ---: |
| 8-item receipt | 219.2 ms | 103.4 ms |
| 12-item kitchen ticket | 229.2 ms | 96.1 ms |
| 200-row report | 1,509.2 ms | 498.5 ms |
| Compiled basic receipt | 228.9 ms | 116.0 ms |
| Compiled bundle receipt | 230.7 ms | 112.9 ms |
| Compiled JoFotara QR receipt | 230.4 ms | 101.1 ms |
| Compiled kitchen ticket | 179.9 ms | 96.5 ms |
| Compiled kitchen void | 130.1 ms | 98.0 ms |
| Compiled subscription | 129.7 ms | 95.6 ms |
| Compiled subscription void | 129.6 ms | 94.6 ms |

Every measured output across all ten workloads has identical before/after bytes and SHA-256. The report requires eight screenshots instead of thirty. A maximum-size individual RGBA capture buffer grows from 0.5625 MiB to 2.25 MiB; total rendering memory includes other buffers and browser allocations.

A mixed burst starts a report, then injects a new kitchen job, new receipt, and ready artifact on independent printer lanes. Four loopback TCP sinks measure acceptance to first received bytes, over three runs:

| Job | Before | After |
| --- | ---: | ---: |
| Report | 1,526.3 ms | 507.7 ms |
| New kitchen ticket | 1,547.4 ms | 532.1 ms |
| New receipt | 1,726.2 ms | 617.7 ms |
| Ready artifact | 1,724.3 ms | 7.9 ms |

All twelve jobs in each variant completed locally and delivered exactly their artifact bytes. Rendering remains nonpreemptive: new jobs needing rendering still wait for an in-progress render, now shorter. No added batching delay, faster polling, or extra browser was introduced.

## Coverage and evidence

| Path | Verification |
| --- | --- |
| Claim, acceptance, settlement, cancellation, health, reprint, routing | Guarded isolated backend integration and unit tests |
| Journal durability, recovery, ownership, retry and worker ordering | Full spooler suite and focused regression cases |
| Templates, raster bands, artifact integrity | Real browser rendering, band parsing, byte comparisons, injected short writes |
| Independent printer delivery | Actual loopback TCP byte capture plus worker ordering regressions |
| Windows transport uncertainty and helper startup | Simulated transport failures/startup silence; existing helper tests including temporary compiled C# DPAPI/mutex checks |
| Installation and dependency exposure | Source/documentation review and dependency audit; no installer rebuild or station deployment |

The full spooler runner passed all 29 scripts. Following the final response-validation change, affected sync-client/runtime/connect checks and all six new audit regressions passed. Backend verification totals 486 passing tests across 38 files, using the latest whole-file results: the broad run initially exposed one badge-notification timing assertion, which was corrected and its entire file rerun successfully. Architecture generation/check passed with the existing minor CORS note.

The unchanged journal probe with 14,000 archived small synthetic records and ten active records opened in 1,134 ms; eight hot operations took 0.816–1.407 ms across samples. This does not justify another active-index implementation. It does not measure full-ticket archive memory or disk footprint.

- [Compact measurements, source hashes, and verification provenance](2026-09-07-spooler-audit-evidence.json)
- [Real rendering benchmark](../../scripts/reviews/spooler-render-performance.cjs)
- [Mixed queue benchmark](../../scripts/reviews/spooler-queue-performance.cjs)
- [Focused verification commands](../agents/verification.md)

## Remaining findings and limits

The production dependency audit reports four high-severity entries along one Puppeteer browser-installation dependency chain involving `extract-zip`. The [upstream path-traversal advisory](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) has no patched extract-zip release. npm's suggested Puppeteer 25 upgrade requires Node 22.12 or newer and conflicts with the user's explicit Node 20 requirement. This finding remains unresolved; no forced upgrade or unverified override was applied. The vulnerable operation is malicious ZIP extraction during browser installation, rather than receipt parsing.

Physical printer behavior, USB delivery, customer networks, cloud latency, customer CPU/RAM, and rebuilt installers were not validated. Node 20 compatibility was preserved in source and dependency requirements, but this audit's execution used Node 22.23.0. Full-ticket retention footprint remains unmeasured. Local byte delivery does not prove paper output, and uncertain outcomes must not automatically resend.

All changes and verification are local. No installed service, station environment, production database, deployment, push, or merge was performed.
