# POSApp system performance and stability audit

Started from `01ef8df1316484a19e1f655c676d0b86901f5914` on `codex/system-performance-audit`. This audit implements reproduced problems in the existing design. It does not infer performance from file size. The existing untracked `.codex/config.toml` and machine configuration were preserved. No push, merge, protection change, deployment, or production test was performed.

## Verified improvements

| Area | Reproduced problem | Result |
| --- | --- | --- |
| Period reports | A day-filtered report aggregates discounts across all historical order items; some adjacent paid-order queries wrap indexed dates in `COALESCE` | Existing indexed date predicates now scope the work. Local period metrics: **195.9 → 14.2 ms**. Discount subquery: **129.4 → 0.45 ms**, **100,002 → 3 rows read**. |
| Table and checkout connections | Completed transactions retain a pool lease while kitchen/realtime work needs another; under saturation requests can wait on their own completed connections | Release immediately after commit, retaining transactional pricing, locks, inventory and audit writes. Ten HTTP lifetime cases passed with an asserted actual **one-connection pool**, including join/disjoin PIN authorization before the transaction. |
| Catalog pagination | Three quick Load More calls issue three requests for the same offset; append can supersede a category request | All catalog requests own the loading lock. Browser: **three clicks → one append**, **120 → 135 distinct displayed products**. Existing products remain visible. |
| Admin settings | An invalidated response can repopulate the old cache; remote settings and reconnects do not refresh consumers | Generation checks and shared refreshes preserve current flags. Browser verifies remote table, stock, recipe and Arabic language changes, including clearing filters or views that become unavailable. |
| Order history | Older page responses overwrite newer results; a quick date selection requests the same list twice | Cancel/ignore superseded reads, cancel work on deactivation, and batch quick date changes. Browser: Yesterday makes **one list request**. |
| Floor plan | Return/reconnect uses the loaded-cache shortcut; refreshes during an active read are lost; a reassigned table can adopt an old cart | Return/reconnect requests a fresh snapshot, forced bursts share one follow-up, cold callers share one read, and reassignment uses existing session teardown. Browser verifies **one snapshot** at startup, return and actual offline/online recovery. Unit regressions preserve newer, saved and split sessions. |
| Public menu | Direct writes expose partial JSON; failed writes corrupt the previous file; concurrent cold callers resolve before publication | Write a temporary file then atomically replace the menu. Retain the last complete JSON on failure, clean partial output, and let callers await coalesced generation. All **three regressions failed before and passed after**. |
| Spooler HTTP | Timeout and shutdown cancellation end at response headers, leaving a stalled body able to block sync | Read the body within the deadline. Local loopback: a **250 ms** deadline closed in **255 ms**; caller cancellation closed in **4 ms**. |
| Spooler recovery | Failed journal write/fsync skips temporary-file cleanup; an old Windows watch failure restores a renamed target | Three injected disk failures leave **zero temporary files**, preserving durable state and retry recovery. Stale subscription failure cannot replace the current printer target. |
| Verification | Fixture seeding accepts an inherited application DB; lock and fixture ignore `DB_PORT`; pure frontend checks require MySQL and server setup | Validate loopback/allowlisted destinations before connecting, honor the port, reliably close locks, add `test:frontend` and a guarded `test:isolated` runner with owned-DB cleanup. |

The report workload is 50,000 historical orders and items plus one sale in the selected day, on local MariaDB 10.4.32. It uses the same fixture before and after, one warmup and five measured period reads. These results are not production throughput or hardware guarantees. See [backend evidence](2026-09-06-backend-runtime-audit.md), [frontend evidence](2026-09-06-frontend-runtime-audit.md), and [spooler evidence](2026-09-06-spooler-runtime-audit.md) for exact scope and reproduction.

## Coverage and changes deliberately avoided

| Examined flow or resource | Evidence and boundary |
| --- | --- |
| Startup and database runtime | Inspected readiness/migration sequencing, shared pool options, bounded acquisition, quiet-period probes, disconnect telemetry, session rechecks and shutdown. Existing runtime/pool regression checks passed. No production cold-start or customer RAM/CPU measurement was made. |
| Checkout and payments | Inspected server pricing, paid-invoice immutability, checkout idempotency/recovery, post-commit work and stock/recipe calls. Preserved those authorities; removed the unreachable second authentication check. |
| Tables, splits, holds and refunds | Inspected group-first locks, line identity, split conservation, held claims/version/replay, refund tender/restocking and recipe reversals. Broad business regressions and built-browser settlement/refund flows passed. |
| Inventory and reports | Kept batched stock reads/updates and the merged recipe ledger. The new report fix uses existing indexes and financial SQL; no schema migration, balance cache or reporting-model change. |
| Frontend loading and live state | Inspected stores, route loading, catalog paging, admin lists/settings and floor-plan recovery. Built Vue components are exercised directly where useful. No file-size splitting, CSS redesign, dependency addition or broad module extraction. |
| Printing | Inspected sync cadence/settlement, dispatch/routing, worker lanes/retries, artifacts/renderer deadlines, TCP/Windows transport, watchdog/purge and retained journals. Post-marker uncertainty and no-auto-reprint behavior remain intact. |
| Retained journal work | With 14,000 archived and 10 small synthetic active records, eight hot operations took 0.407–0.622 ms per sample; startup parsing took 434 ms. This did not justify a maintained index. The fixture does not establish representative full-ticket memory or disk use. |
| Dead code and test value | Removed the unreachable checkout guard and unused financial SQL import. Replaced HTTP source-shape timeout assertions with real stalled-body/cancel behavior. No speculative dead-code sweep; dynamic, installer and deployment paths remain part of reachability checks. |
| Agent workflow | Added [focused verification guidance](../agents/verification.md) and linked it from `AGENTS.md`. Reused the established fixture, review preload, Vitest, Vue plugin and browser scripts. Required Release gate checks were not weakened. |

## Validation

**1,113 distinct Vitest cases passed across 118 files**, the union of targeted runs, not a claim about one full-suite invocation:

- 512 backend business/report/lifetime cases in 16 files, including the 463-case broad table/checkout/refund/recipe run. After moving join/disjoin authorization, 32 existing relationship/guard cases and the final ten one-connection lifetime cases passed.
- 516 frontend cases in 87 files on the final frontend source, with a deliberately invalid `DB_HOST`: no database setup or connection is needed. This run took about 13.1 seconds on the local machine.
- 48 runtime, pool, fixture-safety, settings-cache and menu cases in nine files; 37 related cart/table/permission cases in six files. The final menu test also passed after removing its obsolete fixed wait.
- Eleven separate focused spooler scripts passed under packaged Node 22.23.0. These are reported separately from the Vitest total.

The complete existing restaurant browser workflow passed in **English and Arabic**, each on a fresh guarded loopback database: ordinary sale, ingredient/recipe setup, three saved burgers, unchanged re-save, one added burger, split settlement, partial refund, receipt/waste/corrections/count, day report/A4/thermal rendering, next-day opening and refund while the ledger is disabled. Numeric checks verified that settlement did not repeat ingredient usage and reversal retained the correct quantities/costs.

Ten targeted frontend browser observations passed, including remote settings, Arabic/RTL, rapid pagination, floor-plan lifecycle and actual socket recovery. No uncaught browser errors were recorded. An independent agent reviewed the frontend/DX changes; the resulting hidden-filter and duplicate-startup findings were reproduced and corrected. Root independently reviewed the spooler and backend changes. The backend agent independently reviewed fixture safety, menu publication and test commands. No further actionable issue remained in those final reviewed changes.

The final production build passed in 7.34 seconds. Architecture validation passed: 232 nodes, 65 flows and 493 steps; the pre-existing minor CORS configuration note remains. Architecture and table ownership did not change, so generated architecture artifacts were not rewritten. Backend/browser databases created for this audit were removed after their servers/connections stopped. Raw traces and screenshots remain in ignored local scratch storage; the [compact verification record](../../scripts/reviews/system-audit-verification.json) preserves outcomes and source hashes.

## Remaining limits at the first pass

The later [POS and tables workflow follow-up](2026-09-06-pos-tables-workflow-audit.md) resolves the checkout manager-PIN connection gap below and records additional workflow fixes and verification. The original measurements and suite counts above describe this first pass only.

- **Checkout with a mid-transaction manager override still uses separate pooled authorization reads.** The one-connection result covers ordinary checkout and the corrected join/disjoin PIN flows. Moving checkout authorization changes security and audit timing, so this pass does not claim that path is solved or validated at pool size one.
- No physical paper completion, customer printer/USB/network performance, production load, Hostinger behavior, installer rebuild or complete Release gate run was verified. No production configuration recommendation is inferred from the local measurements.
- Some migration integration tests still use fixed dedicated databases. The new runner isolates the main fixture, not those separate databases; full backend runs remain serial. See the verification guidance before parallelizing them.

All changes remain local on the named feature branch. Deployment and remote integration require separate authorization.
