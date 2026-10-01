# JoFotara Operations Evidence

Date: 2026-07-24

## Official and production reference

- The current ISTD guidance index exposes a technical integration guide and the linking procedures: https://www.istd.gov.jo/AR/List/%D8%A7%D9%84%D8%A7%D8%AF%D9%84%D8%A9_%D8%A7%D9%84%D8%A7%D8%B1%D8%B4%D8%A7%D8%AF%D9%8A%D8%A9_%D9%84%D9%86%D8%B8%D8%A7%D9%85_%D8%A7%D9%84%D9%81%D9%88%D8%AA%D8%B1%D8%A9_%D8%A7%D9%84%D9%88%D8%B7%D9%86%D9%8A
- The official linking guide confirms the static Client-Id/Secret-Key header credentials, UBL 2.1 XML, encoded invoice payload, and `https://backend.jofotara.gov.jo/core/invoices/` endpoint: https://www.istd.gov.jo/ebv4.0/root_storage/ar/eb_list_page/%D8%AF%D9%84%D9%8A%D9%84_%D8%A5%D8%AC%D8%B1%D8%A1%D8%A7%D8%AA_%D8%A7%D9%84%D8%B1%D8%A8%D8%B7_%D8%B9%D9%84%D9%89_%D9%86%D8%B8%D8%A7%D9%85_%D8%A7%D9%84%D9%81%D9%88%D8%AA%D8%B1%D8%A9_%D8%A7%D9%84%D9%88%D8%B7%D9%86%D9%8A_%D8%A7%D9%84%D8%A7%D9%84%D9%83%D8%AA%D8%B1%D9%88%D9%86%D9%8A_%D8%A7%D9%84%D8%A7%D8%B1%D8%AF%D9%86%D9%8A.pdf
- The production-verified local skill reference adds the operational constraint the official linking guide does not define: a timeout or lost response is ambiguous, an accepted document must never be resubmitted, and a credit note requires the accepted original identity.

The official material does not publish a safe retry/status-query protocol. Therefore the implementation must not infer that a timeout, connection reset, non-JSON response, or interrupted process means the document was rejected.

## Existing implementation

### Strong boundaries already present

- `backend/services/JofotaraXmlBuilder.js` owns immutable legal snapshots and exact UBL rendering for sales-tax and income-tax profiles.
- `backend/services/JofotaraClient.js` owns the government HTTP call, credential headers, response classification, timeout, and redacted transport errors.
- `backend/services/JofotaraService.js` owns source eligibility, row locking, UUID/ICV creation, immutable XML persistence, accepted idempotency, retry reuse, and credit-note linkage.
- `backend/routes/admin/jofotara.js` is mounted behind the admin/programmer authorization wall.
- `jofotara_documents.source_key`, UUID, and document number are unique. The table stores snapshots, XML, full response, QR, attempt count, actor, timestamps, and status.
- Normal checkout and refunds do not call JoFotara. Government availability cannot roll back a local sale.
- Accepted QR data already flows through admin reprints and receipt presentation.

### Current state machine

| State | Current meaning | Safe automatic action |
|---|---|---|
| `pending` | Ledger row exists but no current production path commits this state | Submit only when `attempt_count=0` and no attempt timestamp exists |
| `submitting` | Local state committed immediately before the HTTP request | Wait; after two minutes mark `unknown`, never resend |
| `accepted` | Government response classified accepted; QR/raw response retained | None; immutable terminal state |
| `rejected` | An explicit completed attempt was classified rejected | Keep manual retry; reuse the frozen UUID/XML/ICV |
| `unknown` | Timeout, network ambiguity, or interrupted submission | Manual review only; never submit automatically |

### Proven gaps

1. A crashed manual submission can remain `submitting` indefinitely because the Orders UI disables that action and the stale-to-unknown transition currently runs only when submission is called again.
2. There is no unified list or summary for invoice and credit-note documents. Operators must open orders individually.
3. There is no visible count/alert for rejected, unknown, stale, or never-submitted documents.
4. There is no optional automatic discovery of finalized local invoices/refunds. The original integration plan deliberately left this for a later post-checkout worker.
5. The development database currently has JoFotara enabled for the sales-tax profile, three finalized eligible invoices, zero JoFotara document rows, and therefore three locally finalized invoices with no JoFotara submission record. No credential value was printed during this check.

## Evidence-corrected recommendation

1. Add two authoritative settings: `jofotara_auto_submit` (default off) and `jofotara_auto_submit_since` (blank until explicitly enabled).
2. When automatic submission changes from off to on, set the cutoff to database `NOW()`. Never auto-submit historical invoices or documents finalized while automation was off.
3. Add one bounded processor inside the existing JoFotara service. It first changes stale `submitting` rows to `unknown`, then—only when enabled and configured—submits up to five never-attempted invoices/refunds created at or after the cutoff.
4. Never automatically retry `rejected` or `unknown`. A rejected frozen XML needs human/config correction; an unknown result needs government-side verification.
5. Add a read-only operations endpoint returning credential-free summary counts and at most 100 unresolved/recent rows. Do not return XML, legal snapshots, raw response bodies, or settings secrets.
6. Add one admin operations page and one sidebar badge. Reuse existing manual submit endpoints for not-submitted and explicitly rejected sources.
7. Broadcast `jofotara_operations_changed` after automatic or manual state changes so the badge/page refresh through the existing admin realtime bridge.

## Explicit non-goals

- No generic adapter, connector, queue table, event bus, scheduler dependency, repository layer, or state-machine library.
- No government status lookup because no supported lookup endpoint is established by the available official reference.
- No automatic accepted/rejected override for an `unknown` document.
- No automatic historical backfill.
- No call from the checkout/refund transaction or request lifecycle.
- No XML, money, JoFotara profile, receipt, or credit-note redesign.
