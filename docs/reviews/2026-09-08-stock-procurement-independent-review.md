# Independent procurement review and corrections

Reviewed `05c43433`, `cee49dfc`, and `48ec7a34` against the existing C+J handoff, then repaired the defects below. **The original completion claim is rejected.** The repaired document APIs and direct receiving workflow are locally verified, but C and C-specific J still lack the operator workflows listed at the end. A+B is not reopened by this status. No application database, deployment, push or hardware benchmark was involved.

## Reproduced and fixed

| Severity | Failure | Correction |
| --- | --- | --- |
| High | A read-only inventory user could retrieve supplier unit cost through `/stock/lookup`. | Apply the same recursive cost redaction to barcode pack responses; capabilities drive receiving controls. |
| High | Posting read receipt lines before obtaining the document lock. An old transaction snapshot posted 2 units even though the locked draft had been edited to 5. | Lock the current document and its lines before posting; require the observed version. The same rule applies to returns and price corrections. |
| High | A return transaction with an old snapshot missed another committed return and could exceed its original receipt limit. | Serialize on the source receipt and use locked per-line returned counters. Counter, stock operation and dirty marker commit or roll back together. |
| High | An explicit PO line ID could be paired with a different physical stock item. | Match revision, source line and stock identity; reject ambiguous repeated-item mapping and mismatched suppliers. |
| High | Different create payloads using one request key were silently treated as successful retries; the tests endorsed this behavior. | Store immutable canonical create hashes; changed intent is 409. Concurrent identical creates converge on one document. Old pre-hash keys fail closed and require opening the original document. Internal stock-operation keys are namespaced by document identity. |
| High | After the server posted a delivery but the response was lost, retry attempted a PATCH of the already-posted draft. Network errors with ordinary messages were not marked uncertain, and the exposed Retry callback retained its original no-op. | Persist the exact pending request/post identity in user-scoped session storage, retain a reactive Retry callback, retry posting directly, and recover it after reload. Posted history stays read-only. |
| Medium | Fractional pack multiplication silently truncated sub-six-place stock. | Reject unrepresentable conversions instead of rounding physical quantity down. |
| Medium | Returning two receipt lines for the same stock key failed the core ledger's duplicate-key rule. | Enforce each receipt-line limit, then combine physical quantities before posting one movement per key. |
| Medium | Repeated PO items could share or overwrite received counters during amendment; received terms could change. | Require one-to-one source mapping, preserve original revisions, reject changes to received pack/cost terms and copy counters in the batch insert. |
| Medium | CSV split-on-comma parsing corrupted quoted barcodes; inactive supplier SKU fallback could look valid; each row issued its own lookup queries. | Bounded quoted-field parser, exact active item/pack/SKU matching, supplier checks, original row numbers and two batched identity queries. Staging preserves the requested business date. |
| Medium | Opening history dropped the business date, charges and tax, and treated a posted receipt as a new editable document. | Restore the complete saved header and retain posted identity; provide an explicit new-delivery action and draft reload for conflicts. |
| Medium | Receiving styles changed global `input`, `select` and control styling; desktop width was capped at 390 px. | Scope the stylesheet, restore available width, bound large drafts to 20 rendered lines, and preserve RTL numeric/date direction. |
| High | The real fresh installer failed the runtime validator because recipe and A+B projection prerequisites were absent. | Complete the canonical 89-table fresh baseline, indexes and migration ledger seeds; update the verified baseline hash. The actual installer test now passes. |

The initial real-DB adversarial run was **7 passed / 5 failed** (`scratch/procurement-review-red.json`). Those five failures are corrected. The two added frontend cases also failed before their fixes. Intermediate failed runs remain historical evidence, not current completion claims.

## Query and transaction changes

Receipt default position lookup is two queries for the whole draft instead of two per line. Cost allocation and PO received-counter updates each use one bounded write instead of one per line. Amendment counter copies are part of the existing batch insert. Create hashes are written in the header insert. Vendor return posting reads current counters rather than aggregating all prior return documents. CSV preview fetches item/pack identities in two set queries. The real one-line-versus-100-line receipt test asserts equal query counts and correct allocated totals and stock balances.

There are no CPU/RSS/latency promises. Query bounds and real transaction behavior are the evidence required by the user's revised scope. No new service, queue or library was introduced. Direct receiving remains optional-supplier/optional-PO.

## Verification

Results overlap; do not add the counts together.

| Artifact/check | Result |
| --- | --- |
| `scratch/procurement-acceptance-final.json` | **18/18** real HTTP/MySQL cases: original flows plus reproduced security/precision/identity/snapshot bugs, simultaneous identical creates, fixed query count for 100 lines, quoted/inactive CSV, repeated-item PO amendments and combined physical returns and server document search. |
| `scratch/procurement-source-final.json` | **37/37** procurement, stock-ledger and migration checks. Later receipt query cleanup and amendment additions are covered by the 18-case final run. |
| `scratch/procurement-review-final.json` | **179/179** combined procurement, migration, real installer and schema/manifest checks. |
| `scratch/procurement-schema-final.json` | **157/157** current schema authority and manifest/hash/manual-fallback unit checks. |
| `scratch/procurement-integrity-upgrade.json` | Exact predecessor → request integrity, existing posted returns initialize counters, then no-op replay: **1/1** targeted integration check. |
| `scratch/procurement-full-upgrade.json` | Exact historical July 29 floor → complete current managed chain, schema and ordered ledger: **1/1** targeted integration check. |
| Frontend | **10/10** receiving/sidebar checks, including lost post response, history restoration and line-cap behavior. Removed CSS-string and assigned-array-length assertions. |
| `scratch/stock-receiving-browser.json` | Built UI in English at 1280 px and Arabic at 390 px. Scan, pack conversion, history beyond 50, actual 100-line draft with 20 visible rows and continuation; no page errors or horizontal overflow. English additionally commits a post, discards its response, reloads and retries; physical stock proves no duplicate. |
| Build/architecture | Production admin build and generated architecture checks pass. |

All mutation fixtures use guarded generated loopback databases, with the existing explicitly named installer/upgrade fixtures where required. Tests never reseed the application database. Scratch evidence is ignored locally; the test sources and browser workflow are tracked.

## Migration and rollback boundary

`2026-09-08-procurement-request-integrity-v1` follows the original procurement migration. It adds four create hashes and a receipt-line return counter initialized from already-posted returns. Automatic SQL, normalized SHA-256, manifest predecessor and cumulative manual fallback agree. The fresh baseline contains the final schema and exact ledger evidence; it contains no business rows.

Existing documents without create hashes remain readable/postable by ID; blind create-key replay fails closed instead of inventing a historical payload. Perform cutover with source writers stopped, then start one compatible application version. A version switch is not a safe rollback after new documents have posted. Never delete stock journals to undo deployment. No production cutover is claimed here.

## Remaining operator gaps at review time (closed locally on 2026-09-09)

1. **Supplier and pack workspace:** create/edit/archive suppliers and packs through the UI, search/continue beyond the first lookup page, show base units and pack cost basis clearly. Existing APIs alone do not satisfy the operator contract.
2. **PO workflow:** create, review, approve, amend, cancel outstanding quantities and receive partial deliveries through the UI. The current selector includes approved and partially received first-page orders; continuation and full source-line selection still need proper support. Show and bind exact source lines and remaining quantities before posting.
3. **Returns and price corrections:** source-linked entry, review, posting, history and detail screens. Detail/edit APIs now exist, but there is no complete operator workflow. Price corrections are retained cost evidence; effective receipt-cost presentation and report consumption must be explicitly implemented and reconciled. Do not advertise them as H valuation or completed accounting.
4. **Import review:** show every row error, editable correction/preview, and explicit draft creation. Current backend preview is corrected, but the UI still picks the first error and stages valid imports automatically. Retain a stable staging request across response loss/reload and pack changes; prove this whole browser path.
5. **Complete operating acceptance:** shared business-period behavior, history/filter operation across every document kind, lookup pagination, Arabic copy, permission-specific journeys, and reload/conflict recovery for all of those newly completed workflows. Do not claim these from direct-receipt tests.

A later executor implemented those five operator-workflow gaps locally. That work does not reopen the API defects above and does not accept H valuation or D–I. See `docs/reviews/2026-09-09-stock-procurement-operator-workflows.md`. D count sessions, E recipe versions, F preparation, G locations/lots, H valuation/close and I purchasing intelligence remain open; J follows each workspace. Do not reopen removed hardware benchmark gates.
