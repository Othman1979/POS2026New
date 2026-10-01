# Settings reliability fixes and failure verification

Completed on `codex/order-type-numbering`, following the read-only audit at `scratch/order-type-settings-reliability-audit.md`. No customer database, physical printer, deployment, push or PR was used.

## Changes

1. **Bound settings and checkout waits.** Settings reads now have a 15-second deadline covering headers and JSON. A failed initial read shows a translated Retry banner and prevents checkout/receipt printing with default settings. Checkout waits at most 30 seconds, retains its frozen payload and idempotency key after uncertainty, and never retries automatically. Already-loaded settings introduce no asynchronous gap before capturing checkout data.
2. **Coalesce terminal settings loads.** Concurrent consumers share one request. A settings-change event during that request schedules a fresh follow-up; repeated events in that interval coalesce. Failed refreshes retain the last good snapshot and show an error. Cold-load failures remain distinguishable from a valid snapshot.
3. **Limit settings-save work.** General Settings submits only edited fields, skips unchanged saves, and retains unsaved edits after failure or edits made while saving. Immediate language saves update that baseline. Backend catalog/dashboard/menu invalidation now follows the submitted keys; POS reloads products only for catalog-related settings, while unscoped events retain full recovery. The catalog projection and backend invalidation share the same key list.
4. **Reuse held-order settings.** Immediate hold creation passes its existing transaction's numbering flag into the numbering helper. Other callers retain the fallback read. No counter allocation, locking or rollback semantics changed.

Surrounding verification also fixed a post-sale wait: print admission now has a 30-second deadline. Missing acknowledgement reports uncertainty, leaves the sale saved and skips an optional second automatic receipt. It neither falls back to browser printing nor resends the uncertain job. A timeout is not presented as a known print failure.

No new library or global financial-settings cache was introduced. Backend authorization and policy locks remain in place.

## Test-first evidence

| Finding | Reproduction before correction | Verification |
| --- | --- | --- |
| Settings/checkout deadlines | Seven new regressions failed against the original implementation | Stalled headers/bodies, cold-load recovery, frozen tender/key, late-response suppression and no automatic retry |
| Settings race | Three new race cases failed | Shared request, required follow-up, retained successful snapshot when follow-up fails |
| Refresh work | Six frontend and seven backend cases failed; three General Settings save cases also failed | Scoped invalidation on a real DB, fresh catalog metadata, edited-fields-only saves and explicit retry |
| Hold flag reread | Both numbering modes performed the redundant scalar SELECT | Both modes reuse the flag; held/reprint/scheduled/platform workflows pass |
| Print uncertainty | Stalled admission kept printing busy; uncertain receipt still allowed a second automatic copy | Bounded wait, saved sale, no browser fallback, no automatic second receipt, correct uncertainty wording |

The broad store run exposed its older terminal mock missing the new readiness contract. After updating it, three existing table-race cases also caught an unnecessary wait on the already-ready path. The production fast path was corrected; the complete 246-test store file passed.

The A4 rendering fixture intermittently timed out starting a second Vite server. It now imports its component through the existing Vitest Vue transform. All 18 rendering assertions remain intact and pass; no A4 production code changed.

## Final verification

- **769 frontend tests across 119 files passed.** The 29 focused terminal/checkout/ownership tests also passed after the final uncertainty-message correction.
- **684 checks across the 19-file numbering/table/stock/store selection passed across the broad run and corrected store rerun.** This selection includes backend integration/unit tests and two table frontend files; it is not an additional disjoint count of frontend tests. It covers linked-stock writers, recipe ledger table/split/merge behavior, held/platform orders, settings validation, role projection and catalog invalidation.
- **Real connection loss before and after COMMIT:** the isolated test destroys the checkout's actual DB connection at each boundary. The first request returns uncertainty; same-key recovery produces one invoice, the original typed number and correct total. A subsequent new checkout receives the next number.
- Production build, architecture check and `git diff --check` passed.

## Built browser and spooler experiment

The expanded `scripts/reviews/order-type-workflow-audit.cjs` completed on a generated loopback database:

| Area | Observed result |
| --- | --- |
| Sales | 234 paid invoices, four cashier sessions/shifts, five configured types, zero duplicate `(order_seq_scope, order_id)` values |
| Ordinary workflows | Cash/card/split, repeated types, Y holds, scheduled printing, platform settlement, tables and split seats |
| Browser | Built English UI at 1280px; Arabic at 1024px with 4× browser CPU throttling; zero uncaught page errors |
| Cold settings failure | Actual 503 response, visible translated Retry, successful recovery in both languages |
| Committed response loss | English: lost, truncated and timed-out responses; Arabic: lost and truncated responses. All five recover the same invoice/reference and exact original request, including 20.00 tender, 14.20 change and 5.80 total |
| Reload/mode change | Lost-response cases recover after page reload; every fault case also changes numbering mode before retry, without changing the issued reference |
| Print uncertainty | A real queue admission succeeds but its acknowledgement is withheld. The browser reaches its deadline, warns of uncertainty, and makes only one receipt request |
| Recovery printing | Each recovered checkout creates exactly one kitchen and one customer job; no print was requested before checkout recovery was confirmed |
| V2 delivery | 45 jobs through API → queue → V2 sync → journal → Chromium/canvas → loopback TCP; all hashes and byte counts match |
| Shift reconciliation | All four shifts closed through the API with zero variance against independently summed invoice cash |
| Connections | 1,355 acquisitions and releases, zero checked-out connections at completion, zero queued acquisitions and zero connection errors |

The simulator received **2,188,966 bytes** in **3,776 ms**. This measures artifact delivery to a TCP sink, not physical paper speed.

The first expanded harness attempt stopped at an assertion that expected a print warning before the 30-second deadline. The sale dialog intentionally closes immediately when payment is saved; the assertion now waits for the print deadline. No production change was needed for that harness failure. The completed rerun passed all phases.

## Performance

The new flag remains part of checkout's existing settings query. Normal typed allocation still uses three sequence statements versus one in shared mode; the transaction's authoritative counters and locks remain intact.

Four alternating 50-checkout batches ran with four concurrent cashiers after a separate 10-checkout warmup, without another test workload running:

| Mode | Median | p95 | Batch elapsed |
| --- | ---: | ---: | ---: |
| Off | 8.97 ms | 13.33 ms | 154.02 ms |
| On | 9.58 ms | 13.43 ms | 161.47 ms |
| On | 8.90 ms | 12.92 ms | 158.04 ms |
| Off | 8.61 ms | 19.60 ms | 157.53 ms |

No material latency regression was observed in this local sample. The measurements do not establish Hostinger capacity, physical four-core/4GB behavior or a full-day soak. Browser CPU throttling does not throttle server CPU, memory or printer hardware.

## Evidence and limits

Ignored evidence: `scratch/settings-f*-*.log` for RED/GREEN runs, `settings-final-backend.log`, `settings-store-final-green.log`, `settings-final-verified-frontend.log`, `settings-print-certainty-green.log`, `settings-workflow-final.log`, and `order-type-workflow-audit/results.json`. The workflow JSON records its revision, tracked diff hash, harness hash and per-phase results; per-database JSON files preserve earlier attempts. `settings-fixture-cleanup.json` verifies that all nine recorded generated databases from this work are absent.

The exercised failures and all reproduced findings are closed. Physical printers/drivers, live Hostinger conditions, live JoFotara submission, a complete production-worker soak and process-crash combinations remain outside this verification. This is evidence of the covered behavior, not a 100% guarantee for every deployment or failure combination.
