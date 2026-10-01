# Order-type numbering: workflow audit

Audited the working changes on `codex/order-type-numbering`, starting from `f190f5c9`. All data was generated in guarded loopback databases. No customer database, deployed server, physical printer or payment provider was used.

## Findings fixed

1. **Table saves discarded the selected type.** Saving type 4 and settling without repeating it produced `F-1`, the legacy/no-type counter, instead of `D-1`. `saveTableOrder` now persists a valid type, preserves it when an edit omits the field, and rejects unavailable types before writing an order. Checkout falls back to the locked table's saved type.
2. **Split seats inherited missing or unrelated register selections.** Two seats from a type-4 parent could receive `F-1` and `A-1`. The backend now takes their type from the parent; the split payload and frontend restoration retain it too. Both seats now receive consecutive `D-*` numbers.
3. **The table settlement lock omitted the issued scope.** An already-numbered table could lose its prefix during settlement. `TableSettlementContext` now loads `order_seq_scope` and `order_type_id`. The regression settles an existing `B-1` table and verifies that reference survives.
4. **A late POS activation read could dismiss a newly opened payment dialog.** Reproduced while recovering a split seat in the Arabic UI with delayed held-count responses. Activation now clears stale overlays/input before awaiting settings and badge reads. The same delayed-response flow subsequently completed in both languages.
5. **A temporary Windows journal rename failure could leave a print job uncertain.** One real spooler simulation encountered `EPERM` while atomically replacing a job record. Existing uncertainty handling prevented an automatic resend. Journal replacement now retries only `EPERM`/`EBUSY`/`EACCES`, at most three times with 10/20/40 ms waits. It never deletes the previous record or retries transport. Injected temporary, permanent and non-lock failures verify durable completion after restart, bounded retries and preservation of the previous record.

Two outdated fixtures were corrected: a table-pricing test used a nonexistent type even though the route now persists that field; a fallback kitchen test expected the raw numeric ID despite supplying a different public display number. They now exercise a valid type and an explicit prefixed reference respectively.

## Real workflow results

The final `order-type-workflow-audit.cjs` run completed successfully:

| Area | Verified result |
| --- | --- |
| Cashiers and numbering | Four independent cashier sessions/shifts, five configured types, repeated orders; 229 paid invoices and zero duplicate `(order_seq_scope, order_id)` values |
| Money | Cash/card/split payments with varying quantities; subtotal, tax, total, tender/change and cash/card reconciliation |
| Held workflows | Y hold retains its reference at checkout and across four parallel retries; scheduled hold stays unnumbered until explicit printing; two platform holds settle with their issued references and zero cash/card collections |
| Tables and split seats | Real save/split APIs followed by both seats restored and paid through the built Split Board/POS UI; parent type preserved in the submitted request and saved number |
| Browser | English at 1280 px, Arabic at 1024 px with 4× CPU throttling; normal A/B/D checkouts plus D/D seats; delayed badge responses; zero uncaught page errors |
| Closing shifts | All four shifts closed through the actual API; recorded closing cash matched an independent invoice-cash sum plus opening float; zero variance |
| Printing | 35 customer/kitchen jobs through API → queue → V2 sync → journal → Chromium/canvas → loopback TCP; all acknowledged; every received hash/byte count matched its artifact |
| Database connections | 1,155 acquisitions and releases; zero checked-out connections at completion, zero queued acquisitions and zero connection errors |

Print output totaled **1,694,341 bytes**, delivered in **3,183 ms** in the final simulation. Open-table kitchen tickets correctly use their table identity without consuming a number. The customer receipt's separate invoice-only visibility setting remains supported.

## Performance

Four alternating 50-checkout batches used four concurrent cashiers after a separate 10-checkout warmup. These measured HTTP/Express/MySQL on this workstation, before browser/render work started.

| Setting | Median | p95 | Batch elapsed |
| --- | ---: | ---: | ---: |
| Off | 8.02 ms | 12.37 ms | 136.64 ms |
| On | 7.99 ms | 11.95 ms | 138.91 ms |
| On | 8.06 ms | 11.15 ms | 132.42 ms |
| Off | 6.90 ms | 9.47 ms | 114.61 ms |

The enabled batches showed no material latency spike in this sample; their event-loop p95 was about 10.1 ms. This small local experiment cannot establish Hostinger capacity or physical low-end-PC performance. CPU throttling applies to the browser, not the server, RAM or printer. Journal retry waits occur only on file-lock errors and can delay the spooler thread by a requested total of 70 ms; normal writes add no wait.

## Regression evidence

- Initial table regressions failed before the production fixes; the numbering/store run then passed **257 tests**.
- The broad seven-file integration run passed **311 checks** and exposed the outdated pricing fixture above. That corrected case passed in the focused run. Linked-stock writers and recipe split/merge tests run with numbering both off and on.
- All **14 numbering cases** passed across the focused run and the final cutoff rerun. They cover concurrent allocation, rollback, simultaneous checkout retries, cancellation, mode toggles, catalog changes, migration replay, search, compiled prints, table/split identity and the business-day boundary. The cutoff fixture controls JavaScript Date at a future boundary because MySQL authentication still uses its real clock.
- **70 frontend tests** passed across ownership, catalog wiring, call-center behavior, table read lifecycle, split requests and workflow transitions.
- The full **34-file spooler suite** passed, including journal failure injection, transport/restart safety, fallback rendering and long-report checks.
- Production build, JavaScript syntax checks, architecture generation/check and `git diff --check` passed.

Raw local evidence is under ignored `scratch/`: `order-type-audit-core.log`, `order-type-audit-regressions.log`, `order-type-audit-final-focused.log`, `order-type-cutoff-final.log`, `order-type-payment-race-red.log`, `order-type-journal-red.log`, `order-type-journal-green.log`, `order-type-spooler-suite.log`, `order-type-workflow-audit-final.log`, and `order-type-workflow-audit/results.json`. The harness records its hash and the tracked working diff hash. Interrupted synthetic databases were verified and removed; journals/screenshots remain for inspection.

## Reproduce

Run database and performance workloads sequentially. See [fixture boundaries and browser-cache setup](../agents/verification.md).

```text
npm run test:isolated -- orderTypeNumbering orderSessionStore
npm run test:isolated -- stockLinkedWriters recipeLedgerSplitsMerges tables platformHeldSettlement heldOrderNumber openTableNumbers
npm run test:frontend -- posTerminalOwnership categoryPricePosWiring callCenterWorkflow tableReadLifecycle tableSplitsRequests orderWorkflowTransitions
npm run build
npm test --prefix pos-spooler-printer
node scripts/reviews/order-type-workflow-audit.cjs
npm run architecture:check
```

This audit verifies the exercised flows, not every possible deployment. Physical paper, Windows printer drivers, USB transport on customer hardware, Hostinger latency, a full-day soak, and live JoFotara submission remain outside this run. The test-mode Express server does not start every production background worker; the V2 spooler runtime used here is real.
