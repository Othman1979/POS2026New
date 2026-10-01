# Receipt Template Builder — Complete Spooler-Only Implementation Plan

> **For agentic workers:** Execute this plan sequentially on a feature branch. Use `executing-plans` for inline work or `subagent-driven-development` when delegated. Stop at every phase gate for review. Steps use checkbox (`- [ ]`) syntax.
>
> **Status:** All phases are implementation-ready. Phase 5 is intentionally the last required phase because exact positioning and the existing store logo are part of the requested designer; generic barcodes, arbitrary uploads, and multi-width output remain excluded.
>
> **Execution rule:** Use Ponytail at full intensity. Keep the implementation in a few deep modules, run focused RED/GREEN checks per task, run the broader gates once per phase, and stage only the files named by the active task.
>
> **Suggested branch:** `codex/receipt-template-builder`. Do not execute directly on `master` and do not merge before the Phase 5 release gate.

**Goal:** Let an administrator design the backend/spooler customer receipt or guest check and every kitchen-ticket state—normal, void, subscription, and subscription-void—without allowing a template to recalculate backend-owned money.

**Architecture:** The backend validates a closed JSON definition, binds it to trusted receipt/kitchen models, and compiles self-contained 80mm HTML/CSS at the final durable-queue seam. The tracked spooler validates and rasterizes that artifact; immutable database revisions plus acknowledged, human-confirmed paper tests control activation and rollback.

**Tech Stack:** Node.js/CommonJS, Express 5, MySQL/MariaDB with `mysql2`, Vue 3 Composition API, Vite, Vitest, Playwright, Socket.IO durable print queue, tracked Puppeteer/canvas/ESC-POS spooler, and the already-installed `qrcode` package.

## Global Constraints

### Included

- Backend compilation and durable print-queue ownership.
- The tracked `pos-spooler-printer/` rendering path.
- Customer receipts and kitchen tickets only.
- An admin editor, sandboxed server-artifact screen preview, and real spooler test-print lifecycle.
- JoFotara QR on a customer receipt only when the backend has an authoritative accepted JoFotara document with a non-empty QR payload.

### Explicitly excluded

- Browser receipt printing and browser receipt preview as output paths. Do not modify `src/components/pos/ReceiptPreviewModal.vue` or `src/print/PrintReceiptApp.vue` in Phases 0–5.
- Z/X reports, category-item reports, Y/held-order reports, audit reports, daily reports, expense slips, or any other report. They continue through their current hardcoded spooler branches.
- A generic report builder.
- A generic QR/barcode node in Phases 0–4. The JoFotara QR node is a narrow legal-document feature, not arbitrary encoded content.
- 55/58mm or 88mm paper, responsive paper widths, pagination, subreports, template inheritance, per-branch inheritance, or controller/service/repository layers.
- Recompiling an exact historical queue reprint. `backend/services/printReprint.js` must preserve the original queued artifact byte-for-byte.

The admin builder is a browser UI, but it is only an **authoring and spooler-preview tool**. It is not a browser print surface. The real output target remains the backend queue and the spooler.

## Evidence this plan is built on

- `backend/services/printDispatch.js:37` is the shared `enqueuePrintJobs()` boundary used by normal and transactional producers.
- `backend/routes/admin/subscriptions.js:613-629` clones an old kitchen payload, changes it to a void ticket, and then enqueues it. Compiling in each route would leave this clone carrying stale normal-ticket HTML.
- `backend/routes/print.js:622-636` spreads client guest-check data. A client-supplied compiled artifact therefore has to be stripped at the final enqueue boundary, not merely trusted because it passed through a route.
- `backend/services/printReprint.js:49-100` intentionally inserts a new job directly from the stored historical payload. That is the correct exact-reprint behavior and remains outside template recompilation.
- `pos-spooler-printer/server.js:450-600` owns the current receipt layout and respects `receipt_config.layout`; `:603-658` owns the current kitchen layout; report branches begin afterwards and are not builder targets.
- `backend/services/JofotaraService.js:84-92` exposes QR text only for `status === 'accepted'`; `finishSubmission()` persists the accepted status and returned QR.
- `backend/routes/admin/orders.js:195-200` already demonstrates the authoritative query: an accepted `jofotara_documents` row keyed to the invoice.
- The root already depends on `qrcode@^1.5.4`; no QR runtime dependency is needed.
- The only writer found for `pos_print_payload` is the report workflow in `src/admin/composables/useThermalReportPrint.js`; this does not justify bringing `PrintReceiptApp.vue` into the builder.

## Architecture

The backend creates this versioned artifact:

```js
{
  version: 1,
  docType: 'receipt' | 'kitchen',
  html: '<div>...</div>',
  css: '...',
  widthPx: 576,
  templateRevisionId: 'builtin:receipt-v1', // or builtin:kitchen-v1, revision:<positive-id>, preview:unpublished
  compilerVersion: 1
}
```

It is attached as `payload.data.compiled_document_v1`.

Only runtime/test artifacts may use `builtin:*` or `revision:<id>`. The preview endpoint stamps `preview:unpublished`; that value is rejected at the durable enqueue seam, so preview HTML can never become a printable trusted artifact.

```text
trusted receipt/kitchen payload
            │
            ▼
enqueuePrintJobs(executor, payloads)
            │
            ├─ remove any incoming compiled_document_v1
            ├─ reports/other types: return unchanged
            ├─ assemble trusted receipt or kitchen model
            ├─ enrich paid receipt with accepted JoFotara QR, if one exists
            ├─ compile custom template → default template → omit artifact
            └─ hash and persist the final payload
            │
            ▼
tracked spooler validates artifact + payload hash
            │
            ├─ valid receipt/kitchen artifact: render it
            └─ absent artifact: current v1/legacy fallback
```

Compilation belongs at the **final enqueue seam**, not in `print.js`, `kitchenPrintRouting.js`, or each feature route. That gives one source of truth and automatically recompiles mutated payloads such as subscription voids.

Use four cohesive backend modules, not one file per node or endpoint:

- `printDocumentModel.js`: assemble trusted receipt/kitchen models.
- `printTemplateEngine.js`: catalog, schema validation, and compilation behind a small public interface.
- `printTemplateDefaults.js`: the two built-in template definitions and existing receipt-layout compatibility.
- `printDocumentCompiler.js`: final orchestration, JoFotara lookup, template selection, fallback, and payload attachment.

Storage adds one more deep module in Phase 3:

- `printTemplateManager.js`: revision reads/writes, optimistic concurrency, physical-test confirmation, activation, rollback, and active-template resolution.

The admin editor stays in four feature files:

- `src/admin/pages/PrintTemplates.vue`: page orchestration, toolbar, lifecycle actions, and responsive pane selection.
- `src/admin/components/PrintTemplateEditor.vue`: band/node tree and property controls.
- `src/admin/components/PrintTemplatePreview.vue`: sandboxed 576px screen approximation of the server artifact.
- `src/admin/composables/usePrintTemplates.js`: feature requests and local workspace state; no Pinia store.

Do not create a class/file per node type, a repository layer, a generic template SDK, or a second frontend representation of the schema.

## Stable module interfaces

These names remain unchanged across phases so lower-context executors do not invent parallel paths:

```js
// backend/services/printDocumentModel.js
buildReceiptDocumentModel(data, options) // model | null
buildKitchenDocumentModel(data, options) // model

// backend/services/printTemplateEngine.js
validateTemplate(template, profile) // normalized template or throws named error
compileTemplate(template, model, context) // Promise<{ artifact: compiled_document_v1, warnings: [] }>
getTemplateCatalog(docType) // immutable JSON-safe catalog for the admin editor

// backend/services/printTemplateDefaults.js
getBuiltinTemplate(docType, options) // template definition
getTemplateFixture(docType, fixtureKey) // trusted fixture payload
listTemplateFixtures(docType) // [{ key, label }]

// backend/services/printTemplateManager.js (Phase 3)
getTemplateWorkspace(executor, docType)
getTemplateRevision(executor, docType, revisionId)
saveTemplateRevision(executor, input)
confirmTemplateTest(executor, input)
activateTemplateRevision(executor, input)
resolveActiveTemplate(executor, docType, options = {})

// backend/services/printDocumentCompiler.js
prepareQueuedPrintPayload(executor, payload, options) // Promise<payload>
```

`options.revisionOverrideId` accepts a saved numeric revision id or the internal sentinel `'builtin'` only from the authenticated admin test-print route through `enqueuePrintJobs(..., options)`. It is never read from request payload data and is removed before queue persistence.

`profile` is server-owned `{ allowAbsoluteOnce, allowStoreLogo }`: both flags are false through Phase 4 and enabled only by their Phase 5 task. `context` is also server-owned and contains only compilation mode (`runtime|preview|test`), fixed/injected clock values for deterministic tests, the selected template revision id, and the optional validated store-logo data URI. No endpoint accepts either object from request JSON. Runtime attaches only `result.artifact`; warnings go to preview responses and structured server logs, never into the durable printer contract.

## Template definition contract

Every node has an opaque stable `id`, a known `type`, optional `visibleWhen`, and a closed `style` object. There is no CSS text field.

```js
{
  schemaVersion: 1,
  docType: 'receipt' | 'kitchen',
  paper: { widthPx: 576 },
  bands: [{
    id: 'header',
    kind: 'once' | 'repeat',
    layout: 'flow' | 'absolute',
    source: 'rows' | 'items' | null,
    filter: null | { path, op, value },
    visibleWhen: null | { path, op, value },
    height: null | integer,
    nodes: []
  }]
}
```

Node shapes:

```js
{ id, type: 'text', text: { en, ar, mode: 'auto' | 'both' }, style }
{ id, type: 'field', path, label: { en, ar, mode: 'auto' | 'both' }, style }
{ id, type: 'row', nodes: [], style }
{ id, type: 'divider', variant: 'dashed' | 'solid', style }
{ id, type: 'spacer', size: 4 | 8 | 12 | 16 | 24 }
{ id, type: 'jofotara_qr', size: 96 | 128 | 160, style }
{ id, type: 'store_logo', size: 64 | 96 | 128, style } // Phase 5
```

Allowed style tokens:

- `fontFamily`: `sans | mono | arabic` mapped to fixed Windows-safe stacks.
- `fontSize`: `xs | sm | base | lg | xl | 2xl | 3xl` mapped by the compiler.
- `fontWeight`: `normal | bold | black`.
- `align`: `left | center | right`.
- `direction`: `auto | ltr | rtl`.
- `width`: `25 | 33 | 50 | 67 | 75 | 100` percent.
- `marginTop` / `marginBottom`: `0 | 4 | 8 | 12 | 16 | 24` pixels.
- Phase 5 absolute nodes add integer `x`, `y`, `widthPx`, and `heightPx`, snapped to 4px and bounded by their `once` band.

The compiler owns every mapping. The database stores tokens, never raw CSS.

## Non-negotiable decisions

1. **Backend compiles; spooler renders.** No page JavaScript, network request, expression evaluator, `eval`, `node:vm`, or user HTML.
2. **Only receipt and kitchen jobs may consume `compiled_document_v1`.** A compiled artifact on a report is ignored/rejected; it never replaces report markup.
3. **Financial values are bindings, not expressions.** Templates cannot add, subtract, multiply, round, or format money independently. `summary.total` already includes tax.
4. **The compiled artifact is trusted; the request is not.** Any incoming compiled artifact or incoming JoFotara object is deleted. Paid-receipt values come from persisted orders. A guest check remains explicitly provisional and is server-recomputed under the existing current-cart trust boundary; the builder does not promote it into a legal paid receipt.
5. **Flow layout owns repeating regions.** Absolute positioning is permitted later only inside a fixed-height `once` band with clipped overflow.
6. **80mm / 576px only.** The current renderer and screenshot clip are fixed to this width.
7. **`receiptDisplayV1.cjs` stays.** It is the safe financial fallback for existing paid receipts. Malformed v1 remains fail-closed.
8. **Historical queue reprints remain historical.** Reprinting a queue job preserves the exact stored template revision and QR state. Reprinting an order through the normal print endpoint creates a fresh job and may include a QR accepted since the original print.
9. **JoFotara never blocks checkout or the first receipt.** Submission is asynchronous. If acceptance has not happened when the print payload is compiled, no QR prints. A later order reprint after acceptance includes it.
10. **No hidden report migration.** Report builders stay in their current hardcoded spooler path; templates, schemas, endpoints, storage, and UI never target reports in this plan.
11. **Do not retire `receipt_config`.** Excluded browser rendering and old spoolers still consume it. The built-in receipt template reads it for compatibility; removal belongs to a later browser-print deletion/fleet-retirement change.

## Fallback and corruption rules

### Receipt

At backend compilation time:

1. Valid active custom template.
2. Valid compiled built-in default, preserving the safe portion of the current `receipt_config.layout` order.
3. Omit `compiled_document_v1` and let the spooler use the existing receipt v1 renderer.
4. Legacy renderer only when receipt v1 genuinely does not exist.
5. A present malformed receipt v1 remains fail-closed.

Exception: for a paid stable invoice, check authoritative JoFotara state even if receipt-model assembly fails. An accepted row with empty QR throws `JOFOTARA_QR_MISSING`; an accepted QR over the byte cap throws `JOFOTARA_QR_TOO_LARGE`; an accepted invoice without a trusted receipt v1/model throws `JOFOTARA_RECEIPT_MODEL_UNAVAILABLE`; QR generation/default compilation failure throws `JOFOTARA_QR_RENDER_FAILED`. Every case returns HTTP 409 and inserts no print job. An accepted legal document must not downgrade to output that omits its QR.

### Kitchen

1. Valid active custom template.
2. Valid compiled built-in default.
3. Omit the artifact and use the current legacy kitchen renderer.

### Corrupted queued artifact

A present artifact that fails payload integrity or spooler shape validation does **not** silently downgrade. The job fails with a diagnosable NACK/dead-letter result. Fallback is for a backend compile failure before enqueue, not for altered data after persistence.

## JoFotara QR contract

The customer receipt has a dedicated `jofotara_qr` semantic node. It is not a general QR node.

The backend may populate it only when all conditions are true:

- `print_type === 'receipt'`.
- The receipt is a paid invoice, not a guest check or held/provisional check.
- A stable internal invoice id and public invoice number are present.
- `jofotara_documents.source_key = CONCAT('invoice:', internalInvoiceId)` and `order_invoice_id` match the invoice.
- `status = 'accepted'`.
- `qr_text` is non-null and non-empty.

The QR payload is treated as opaque text and encoded verbatim with the existing `qrcode` package. Never decode it, modify it, derive it from the invoice, or accept it from the browser. A missing JoFotara document or pending, submitting, rejected, and unknown states render no QR. `status='accepted'` with empty QR is corrupted operational state and fails closed with the named error above.

Bound QR input to 4,096 UTF-8 bytes before generation. A larger accepted payload is a named operational error, not an excuse to truncate or print a different code.

The built-in receipt template includes the conditional QR node. Accepted JoFotara receipts gain the official QR. Safe existing layouts retain parity; a legacy `receipt_config.layout` that omitted required identity/items/totals/payment/tax-profile content is deliberately repaired instead of reproducing an unsafe receipt.

## Structural semantic-role rules

Roles are inferred from node type, binding, and repeat source. A free `role` string is not proof. A spacer or literal text node cannot claim to be a total or an item band.

### Receipt

- Store identity: exactly one required `store.name` binding; address and phone remain optional.
- Document identity: permitted invoice/ticket identity binding plus date.
- Item band: exactly one primary repeat over `rows`.
- Each primary row: name, quantity, and bound net amount.
- Summary: bound subtotal, conditional bound discount, conditional bound tax, and bound total.
- Payment: bound payment method; cash/card allocations when present.
- JoFotara: exactly one required `jofotara_qr` node with no user-authored visibility condition. The node itself renders empty unless the trusted model is accepted, so a custom layout cannot suppress an available official QR.

### Kitchen

- Ticket type: one required field bound to server-owned `meta.ticketTypeLabel`, derived from the closed `meta.ticketType` enum (`normal|void|subscription|subscription_void`). The template may style and position it but cannot rewrite the VOID meaning.
- Public order/table identity.
- Exactly one primary repeat over `items` where `_isOther !== true`.
- Each primary row: quantity, name, and conditional note/modifiers.
- One explicit secondary `_isOther === true` band or an explicit validator-approved decision to omit routed context. The built-in template preserves today's `ALSO ON ORDER` behavior.

Required primary bindings and every ancestor containing them may not use `visibleWhen`. The primary repeat may not define a custom filter. The compiler records primary row keys and asserts each appears exactly once. Unknown source, duplicate primary repeat, or missing row binding is a compile failure.

## Resource limits

Save-time validation and print-time expansion are different problems and must not be conflated.

### Deterministic template limits, checked at save/activation

| Limit | Value |
|---|---:|
| Nodes | 300 |
| Nesting depth | 5 |
| Static text per node | 500 UTF-8 characters |
| Paper width | exactly 576px |
| Absolute layout | fixed-height `once` bands only; height 40–1,200px on the 4px grid |
| Sum of absolute once-band heights | at most 2,400px per template |

### Runtime compilation limits, checked before enqueue

| Limit | Value |
|---|---:|
| Expanded nodes | 2,000 |
| `html` + `css` bytes | 256 KB |
| Entire serialized queue payload | 768 KB |
| JoFotara QR encoded bytes | included in the 256 KB artifact cap |

Printable model strings use the existing sanitizer with these caps: public identities/phone values 100 characters; names, labels, and item names 200; addresses 300; notes and custom header/footer text 500. JoFotara QR text is not sanitized as display prose; it follows the separate exact-byte contract above.

If custom compilation exceeds a runtime limit, compile the default. If the default also exceeds it, omit the artifact, record the named failure, and keep the legacy/v1 payload. A 250ms compile time is a benchmark and telemetry alert, not a fake hard validator: wall-clock variance is not a deterministic validity rule, even though QR generation is asynchronous. Deterministic caps provide the safety boundary.

---

## Phase 0 — Extract and freeze the current spooler renderer

Pure behavior preservation. No template code yet.

### Task 0.1: Extract the renderer

**Files:** Create `pos-spooler-printer/renderDocument.js`; modify `pos-spooler-printer/server.js`, `pos-spooler-printer/tests/receipt-display.test.js`, `backend/tests/unit/spoolerReceiptDisplay.test.js`; create `pos-spooler-printer/tests/render-document.test.js`.

- [ ] Move only the customer-receipt and kitchen-ticket HTML builders out of `server.js`, exposing narrow `renderReceiptDocument(data)` and `renderKitchenDocument(data)` functions with no logic changes.
- [ ] Keep sockets, queue handling, Puppeteer, thresholding, image rasterization, device writes, and cutting in `server.js`.
- [ ] Retarget source-contract tests in the same commit.
- [ ] Leave every report builder in `server.js`. Do not move or normalize report markup during this extraction.
- [ ] Run the existing spooler suite, including representative report branches, to prove the move did not regress excluded output.

### Task 0.2: Golden receipt/kitchen fixtures

**Files:** Create `backend/tests/fixtures/printGoldens/`; create `backend/tests/unit/printGoldens.test.js`.

Freeze current output for:

- exclusive and inclusive receipts;
- item and order discounts;
- bundle parent/child and service charge;
- cash, card, and split tender;
- guest check;
- Arabic and multiline notes;
- 0, 50, and long-name item cases;
- safe and required-block-omitting custom `receipt_config.layout` orders;
- accepted JoFotara order **before** the new QR node, as the explicit baseline;
- normal, void, subscription, and subscription-void kitchen tickets;
- primary and `_isOther` kitchen items.

Normalize only insignificant inter-tag whitespace. Do not normalize classes, attributes, text, order, or values.

### Task 0.3: Physical baseline

- [ ] Print one representative receipt and every kitchen variant on real 80mm hardware.
- [ ] Record printer/spooler version and a compact result table under `docs/superpowers/evidence/`. Keep only representative optimized paper photos/contact sheets (target ≤500KB each); do not commit every raw phone photo.
- [ ] Print one representative excluded report as a regression smoke check; it is not a builder fixture.

### Phase 0 gate

```powershell
node pos-spooler-printer/tests/run-tests.js
npx vitest run backend/tests/unit/spoolerReceiptDisplay.test.js backend/tests/unit/printGoldens.test.js
npm run test:unit
```

Commit: `refactor(print): extract and freeze spooler document renderer`

---

## Phase 1 — Trusted models and inert compiler

Nothing is connected to enqueue or the spooler compiled branch. Deleting the new backend modules must leave production behavior unchanged.

### Task 1.0: Vocabulary proof

Hand-author and compile two throwaway definitions:

- the hardest receipt: bundle + service charge + both discount kinds + Arabic note + split tender + accepted JoFotara QR;
- subscription-void kitchen ticket with primary and `_isOther` items.

The allowed vocabulary is deliberately small: `text`, `field`, `row`, `divider`, `spacer`, and `jofotara_qr`. Headers use ordinary nodes and conditions; do not create `builtin_header`. Delete the spike after it proves or corrects the vocabulary.

### Task 1.1: Assemble document models

**Files:** Create `backend/services/printDocumentModel.js`; create `backend/tests/unit/printDocumentModel.test.js`.

Receipt model:

```js
{
  store: { name, address, phone, customHeaderText, customFooterText },
  meta: {
    invoiceDisplayNo, ticketDisplayNo, orderDisplayNo, internalInvoiceId,
    date, orderTakenAt, printRequestedAt, cashier, orderTypeName,
    tableNumber, hashNumber, provisional, note
  },
  customer: { name, phone, address, deliveryDate },
  payment: { method, cashAmount, cardAmount, amountTendered, changeDue },
  jofotara: { status: 'accepted', qrText } | null,
  rows: [], summary: {}, taxMode, status, currency, decimals
}
```

Kitchen model contains `meta` (including closed `ticketType` and server-owned `ticketTypeLabel`), `items`, `voidTicket`, `subscriptionRedemption`, and `printerLabel`; it exposes no money paths.

- [ ] Receipt without valid `receipt_display_v1` returns `null`; the backend then omits the compiled artifact.
- [ ] Copy receipt row/summary money only from validated `receipt_display_v1`. For paid cash/card/split metadata, reuse the existing `CheckoutValidation.validatePayments()` contract instead of reimplementing tender arithmetic; assert in cents that a split exposes both positive cash and card allocations and the stored change relationship remains valid. Provisional guest/held checks use a separate non-paid metadata branch and can never gain a legal invoice or JoFotara model.
- [ ] Reuse `printText.sanitizePrintString()` while assembling every database/request-derived printable string, with field-appropriate caps and preserved tab/newline behavior. Do not copy its control-byte regex into the model/compiler. Template-authored literal strings reject forbidden control bytes at validation and are HTML-escaped at compilation.
- [ ] Kitchen assembles without receipt v1 and exposes no money field.
- [ ] The four kitchen states map to four exact bilingual `ticketTypeLabel` values; a client-supplied label is ignored.
- [ ] `printRequestedAt` is the server enqueue/compile timestamp. The existing void label may remain visually identical, but this value is not claimed to be the printer's hardware-write instant.

### Task 1.2: Deep template engine

**Files:** Create `backend/services/printTemplateEngine.js`; create `backend/tests/unit/printTemplateEngine.test.js`.

Public interface only:

```js
validateTemplate(template, profile)
await compileTemplate(template, model, context) // { artifact, warnings }
getTemplateCatalog(docType)
```

Internal responsibilities:

- closed bilingual field catalog;
- schema and enum validation;
- structural required-role validation;
- catalog-only binding resolution;
- tax-mode-aware money formatter;
- escaped HTML and whitelisted style tokens;
- `eq|neq|gt|gte|lt|lte|truthy|falsy` conditions over catalog paths;
- repeat expansion over declared sources only;
- runtime expansion/byte limits;
- primary-item exactly-once assertion;
- artifact version stamping.

Schema:

```js
{
  schemaVersion: 1,
  docType: 'receipt' | 'kitchen',
  paper: { widthPx: 576 },
  bands: [{ id, kind: 'once' | 'repeat', layout: 'flow',
            source, filter, visibleWhen, nodes: [] }]
}
```

- [ ] Unknown properties, paths, nodes, styles, sources, conditions, or enums fail with named errors.
- [ ] Reject `__proto__`, `prototype`, and `constructor` keys at every depth before normalization or object spread.
- [ ] Phase 1 rejects every `layout:'absolute'` definition with `TEMPLATE_FEATURE_NOT_ENABLED`; Phase 5 adds it only for fixed-height `once` bands.
- [ ] Required roles are recognized structurally, not from author labels.
- [ ] Every interpolated string is escaped.
- [ ] Money reaches output only through money-typed catalog bindings and one formatter.
- [ ] Static owner-authored text such as `Minimum order 5.00 JD` remains legal; the guarantee is no template computation, not censorship of literal text.
- [ ] `jofotara_qr` accepts only the trusted model field and emits nothing unless status is exactly accepted and QR text is non-empty.
- [ ] QR rendering is asynchronous, uses the installed `qrcode` package to produce a bounded `data:image/png` URI, and uses no remote resource.

### Task 1.3: Built-in templates and existing layout compatibility

**Files:** Create `backend/services/printTemplateDefaults.js`; create `backend/tests/unit/printTemplateParity.test.js`.

- [ ] Define the current receipt and all kitchen variants with ordinary nodes.
- [ ] Parse `receipt_config` defensively. Missing, malformed, non-object, or non-array `layout` data selects the canonical built-in order with a named warning; it never aborts compilation.
- [ ] Resolve the built-in receipt's band order from a valid current `storeInfo.receipt_config.layout`: preserve the relative order of known unique blocks, discard unknown/duplicates, and reinsert every required store-header/document-identity/items/totals/payment/tax-summary/JoFotara block in canonical relative position. Customer/footer remain optional. Record the repaired-layout warning in preview/compile diagnostics without rewriting the setting.
- [ ] Include the conditional JoFotara QR node in the receipt default.
- [ ] Preserve current custom header/footer behavior.
- [ ] Do not consume `use_invoice_no_only`; it belongs to excluded browser presentation and the current spooler does not use it.

Parity expectations:

> **Execution correction (Phase 1.3 evidence):** literal Phase 0 HTML parity is
> neither a valid nor a safe target for a compiled artifact. Most Phase 0 receipt
> fixtures intentionally lack `receipt_display_v1` and must remain legacy-only;
> valid v1 fixtures are rendered through a new compiler-owned wrapper/CSS grammar.
> Do not add raw HTML, a legacy compatibility renderer, or fixture-specific
> exceptions to make the strings equal. Phase 0 goldens remain regression tests
> for the legacy spooler fallback. This task instead freezes compiler output for
> valid trusted receipt/kitchen models. Phase 2 verifies paper/content parity
> through the spooler; it is the authoritative compatibility gate.

- All valid trusted no-QR receipt models compile to deterministic Phase-1 artifact
  goldens. Their rows, money values, labels, metadata, and safe legacy block order
  must be asserted against the same source fixtures; only compiler-owned document
  wrapper/CSS grammar may differ from Phase 0 legacy HTML.
- A required-block-omitting legacy layout compiles with required blocks restored;
  freeze that intentional safety divergence in its compiled-artifact golden.
- Accepted JoFotara receipt equals the compiled no-QR baseline plus the
  server-rendered QR block; no other model text or money changes.
- Kitchen variants compile to deterministic artifact goldens with a fixed clock
  and the same trusted ticket/item content as the corresponding Phase 0 fixture.

### Task 1.4: Final compilation orchestrator, still inert

**Files:** Create `backend/services/printDocumentCompiler.js`; create `backend/tests/unit/printDocumentCompiler.test.js`.

Public interface:

```js
prepareQueuedPrintPayload(executor, payload, options = {})
```

Rules:

- Clone the payload and always delete incoming top-level or `data`-level `compiled_document_v1` and `jofotara`.
- Return non-receipt/kitchen payloads otherwise unchanged.
- For receipts, require trusted v1 before compilation.
- Query JoFotara only for a paid receipt with both stable internal and public invoice identities, and do that check independently of successful receipt-model assembly so an accepted legacy invoice cannot silently print without its QR.
- Require matching `source_key`, `order_invoice_id`, accepted status, and non-empty QR text.
- Compile selected custom template when storage exists; otherwise built-in. In Phase 1 only the built-in resolver exists.
- On named compile failure, try built-in default; on default failure omit the artifact and return the complete legacy/v1 payload, except that an accepted JoFotara QR must fail closed as specified above.
- Never mutate source payloads.

Tests must cover accepted, accepted-with-empty-QR, accepted-with-missing/malformed-receipt-v1, pending, submitting, rejected, unknown, 4,097-byte accepted QR, QR generator failure, guest-check, held-check, mismatched invoice id, and forged client JoFotara states.

### Phase 1 gate

```powershell
npx vitest run backend/tests/unit/printDocumentModel.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateParity.test.js backend/tests/unit/printDocumentCompiler.test.js
npm run test:unit
npm run build
```

Do not claim a physical compiled-output gate in this inert phase: the spooler does not consume the artifact until Task 2.1. Phase 1 proves normalized HTML parity and QR generation; Phase 2 performs the first legitimate paper comparison and QR scan.

Commits:

1. `feat(print): add trusted receipt and kitchen template engine`
2. `feat(print): add default templates and compilation fallback`

---

## Phase 2 — Safe spooler rollout and queue ownership

Do not deploy a partially completed Phase 2. The task order lets compatible code land safely, but the phase gate governs deployment.

### Task 2.1: Spooler capability first

**Files:** Modify `pos-spooler-printer/renderDocument.js`, `pos-spooler-printer/package.json`; modify `pos-spooler-printer/tests/render-document.test.js`, `backend/tests/unit/spoolerReceiptDisplay.test.js`, `backend/tests/unit/spoolerPackageContract.test.js`.

- [ ] Honor `data.compiled_document_v1` only when outer `print_type` and artifact `docType` are the same receipt/kitchen type.
- [ ] Validate version, width, byte limits, required strings, and forbidden active content.
- [ ] Keep the spooler validator intentionally independent from the backend compiler because the spooler is deployed as a standalone trust boundary. Prevent drift with `spoolerPackageContract.test.js`, which compiles backend fixtures and asserts that spooler `1.2.0` accepts the same artifact version, width, type, and byte caps. Do not create a shared runtime package solely for these few constants.
- [ ] Render inline HTML/CSS with JavaScript disabled, a CSP equivalent to `default-src 'none'; img-src data:; style-src 'unsafe-inline'`, and request interception that aborts external/file navigation. Allow only compiler-emitted markup and bounded PNG/JPEG/WebP/ICO data images; reject script/iframe/object/embed/link/meta/form elements, event-handler attributes, remote/file/javascript URLs, and CSS imports. A validation failure NACKs rather than falling back.
- [ ] Keep `#receipt-body`, 576px clip, Puppeteer settings, thermal threshold, device write, and cut unchanged.
- [ ] Ignore/reject compiled artifacts for every report type.
- [ ] With no artifact, run the current receipt/kitchen/report paths unchanged.
- [ ] Bump the tracked spooler package from `1.1.0` to `1.2.0`. This is the minimum version allowed to confirm template test paper in Phase 3; do not infer capability from an unversioned acknowledgement.

This can reach spoolers before backend attachment because it sees no new field yet.

Commit: `feat(spooler): render validated receipt and kitchen artifacts`

### Task 2.2: Keep kitchen idempotency semantic

**Files:** Modify `backend/services/printJobIdentity.js`; modify `backend/tests/unit/printJobIdentity.test.js`.

Kitchen keys currently include a payload hash. If template bytes enter that hash, a template edit can produce two physical tickets for one batch. Add a semantic hashing view that excludes only `data.compiled_document_v1` for kitchen idempotency. Keep the full payload hash for integrity. Do not change report key formulas.

- [ ] Same kitchen batch/data with two template revisions produces one idempotency key.
- [ ] A real kitchen data change still produces a different key.
- [ ] Receipt and report contracts remain stable unless an existing test proves a required adjustment.

Commit: `fix(print): keep kitchen dedup independent of template bytes`

### Task 2.3: Verify full-payload integrity

**Files:** Modify `backend/services/printQueue.js`, `pos-spooler-printer/server.js`; extend their focused tests.

- [ ] Backend `payload_hash` covers the exact persisted payload after trusted compilation and before queue-envelope fields.
- [ ] Spooler reconstructs that object by removing only `queue_id`, `idempotency_key`, and `payload_hash`; `printer_id` and `print_type` remain because they were part of the stored payload.
- [ ] Remove the self-certifying `payload.payload_hash` fallback from `parsePayload`; the DB column is authoritative.
- [ ] Existing rows with a null DB hash print with an explicit warning. Do not refuse legitimate pre-migration jobs.
- [ ] A mismatched non-null hash NACKs and dead-letters with a diagnosable reason.

Commit: `feat(print): verify queued payload integrity at the spooler`

### Task 2.4: Compile at the final enqueue seam

**Files:** Modify `backend/services/printDispatch.js` and the guest-check normalization in `backend/routes/print.js`; extend `backend/tests/unit/printDispatchOwnership.test.js`, `backend/tests/integration/print.authz.test.js`, and subscription reversal tests.

Inside `enqueuePrintJobs()`:

1. `await prepareQueuedPrintPayload(executor, payload)`.
2. Build semantic idempotency and full integrity hashes from the prepared payload.
3. Persist that same prepared payload.

Do not attach artifacts in `backend/routes/print.js` or `backend/services/kitchenPrintRouting.js`; they remain payload owners, not template owners.

Required attacks:

- [ ] A guest-check request carrying forged `compiled_document_v1` is stripped and server-recompiled.
- [ ] Remove the current guest-check branch that accepts `data.receipt_display_v1`. `backend/routes/print.js` always rebuilds the provisional presentation from submitted current-cart items/discount inputs plus the authoritative tax setting, and the compiler uses only that rebuilt model. A client v1 is neither retained nor used as a compatibility assertion.
- [ ] A forged QR/JoFotara object is stripped.
- [ ] Receipt and kitchen payloads still contain all legacy fields beside the artifact, so old spoolers work.
- [ ] A report carrying a forged artifact remains on its hardcoded renderer.
- [ ] `backend/routes/admin/subscriptions.js:613-629` clones a normal ticket to void; enqueue recompiles it and the artifact contains the void/subscription-void header, not stale normal HTML.
- [ ] Normal kitchen routing compiles once per payload at enqueue, not once per route layer.
- [ ] Compile failure omits the artifact but does not lose the print job.
- [ ] Accepted JoFotara is the deliberate exception: empty QR returns HTTP 409 `JOFOTARA_QR_MISSING`; over-cap QR returns `JOFOTARA_QR_TOO_LARGE`; missing trusted receipt model returns `JOFOTARA_RECEIPT_MODEL_UNAVAILABLE`; QR generation/default compile failure returns `JOFOTARA_QR_RENDER_FAILED`. None inserts a queue row. Missing-document and non-accepted receipts keep the ordinary fallback.
- [ ] `backend/services/printReprint.js` is unchanged and exact queue reprints preserve original bytes.
- [ ] A fresh order reprint through `/api/print/print` after JoFotara acceptance gains the accepted QR; an exact queue reprint does not rewrite history.

Commit: `feat(print): compile templates at durable queue ownership boundary`

### Phase 2 gate

```powershell
npx vitest run backend/tests/unit/printJobIdentity.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/spoolerReceiptDisplay.test.js backend/tests/integration/print.authz.test.js
node pos-spooler-printer/tests/run-tests.js
npm run test:unit
npm run build
```

Physical matrix on one tracked spooler:

- exclusive and inclusive paid receipts;
- guest check;
- cash, card, and split tender;
- accepted JoFotara receipt with a QR that scans to the exact stored text;
- pending/rejected/unknown JoFotara receipts with no QR;
- normal, void, subscription, and subscription-void kitchen tickets;
- primary plus `_isOther` kitchen items;
- one representative Z/X or category report to prove it remains unchanged;
- backend-old/spooler-new compatibility, plus a backend-new/spooler-old **non-QR** smoke test. Record the latter as rollout compatibility only, never as a supported accepted-JoFotara state: an old spooler cannot render the new official QR artifact;
- corrupted artifact and corrupted payload-hash NACK behavior.

---

## Phase 3 — Durable revisions, activation, and real test-print lifecycle

Phase 3 makes templates administrable without yet exposing node editing. The page can inspect built-in/current definitions, preview trusted fixtures, test print, activate, and roll back saved revisions created through the backend contract tests.

### Task 3.1: Guarded schema migration and startup authority

**Files:**

- Create `backend/migrations/2026-07-25-print-templates-preflight.sql`.
- Create `backend/migrations/2026-07-25-print-templates.sql`.
- Create `backend/migrations/2026-07-25-print-templates-verify.sql`.
- Modify `backend/tests/fixtures/seed.js`.
- Modify `backend/services/schemaValidation.js`.
- Modify `backend/tests/unit/schemaAuthority.test.js`.

**Produces:** three durable tables, two initial document rows, and a startup failure when the migration is missing or altered.

Use these exact authority constants everywhere in this task:

```js
const MIGRATION_NAME = '2026-07-25-print-templates-v1';
const MIGRATION_CHECKSUM = 'd5ef4e76335b81799b8caff7b2aa6fc276c80b34896b433dff70b913dff34c07';
```

- [ ] **RED:** extend `schemaAuthority.test.js` so missing template tables, required columns, indexes, checks, foreign keys, or the new migration ledger entry cause `SCHEMA_MIGRATION_REQUIRED`.
- [ ] **RED command:**

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js
```

Expected: FAIL because the new schema counts and migration files do not exist.

- [ ] Create the guarded phpMyAdmin-safe migration using the repository's `schema_migrations` checksum pattern. The canonical table definitions are:

```sql
CREATE TABLE print_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_type VARCHAR(16) NOT NULL,
  active_revision_id BIGINT UNSIGNED NULL,
  draft_revision_id BIGINT UNSIGNED NULL,
  lock_version INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_print_templates_document_type (document_type),
  CONSTRAINT chk_print_templates_document_type CHECK (document_type IN ('receipt','kitchen'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE print_template_revisions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_id BIGINT UNSIGNED NOT NULL,
  revision_no INT UNSIGNED NOT NULL,
  schema_version SMALLINT UNSIGNED NOT NULL,
  definition_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  definition_hash CHAR(64) NOT NULL,
  created_by INT(11) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_compile_error_code VARCHAR(64) NULL,
  last_compile_error_message VARCHAR(500) NULL,
  last_compile_failed_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_print_template_revision_no (template_id, revision_no),
  UNIQUE KEY uq_print_template_revision_hash (template_id, definition_hash),
  KEY idx_print_template_revisions_history (template_id, created_at, id),
  CONSTRAINT fk_print_template_revisions_template FOREIGN KEY (template_id) REFERENCES print_templates(id) ON DELETE RESTRICT,
  CONSTRAINT fk_print_template_revisions_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_print_template_revision_no CHECK (revision_no > 0),
  CONSTRAINT chk_print_template_revision_json CHECK (JSON_VALID(definition_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE print_template_revision_tests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  revision_id BIGINT UNSIGNED NOT NULL,
  printer_id INT(11) NULL,
  printer_name VARCHAR(200) NOT NULL,
  printer_endpoint_key VARCHAR(255) NOT NULL,
  queue_id INT(11) NULL,
  spooler_version VARCHAR(64) NOT NULL,
  acknowledged_at DATETIME NOT NULL,
  confirmed_by INT(11) NULL,
  confirmed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_print_template_revision_test_queue (queue_id),
  KEY idx_print_template_tests_revision_printer (revision_id, printer_id, confirmed_at, id),
  CONSTRAINT fk_print_template_tests_revision FOREIGN KEY (revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_print_template_tests_printer FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL,
  CONSTRAINT fk_print_template_tests_queue FOREIGN KEY (queue_id) REFERENCES print_queue(id) ON DELETE SET NULL,
  CONSTRAINT fk_print_template_tests_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE print_templates
  ADD CONSTRAINT fk_print_templates_active_revision
    FOREIGN KEY (active_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_print_templates_draft_revision
    FOREIGN KEY (draft_revision_id) REFERENCES print_template_revisions(id) ON DELETE RESTRICT;

INSERT IGNORE INTO print_templates (document_type) VALUES ('receipt'), ('kitchen');
```

- [ ] Preflight must stop unless a database is selected and `users`, `printers`, `print_queue`, `settings`, `audit_events`, and `schema_migrations` have the columns/types referenced above. It performs no mutation.
- [ ] Verify must return a final numeric `blocking_findings` covering the three table shapes, two template rows, columns/indexes/checks/foreign keys, JSON validity, and the exact migration ledger checksum.
- [ ] Use the exact authority constants above in the migration guard/ledger, verifier, `schemaValidation.js`, and `schemaAuthority.test.js`. Any mismatch is a blocking startup/verifier failure.
- [ ] Add all three tables to test fixture teardown/creation in foreign-key-safe order.
- [ ] **GREEN:** run the unit test, apply the migration to development and test databases, run the verifier against both, then run schema drift validation.

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js
node scripts/validate-schema-drift.js
```

Expected: PASS and zero drift.

- [ ] Commit: `feat(print-templates): add durable revision schema`

Rollback: the old application safely ignores these additive tables. Do not drop them during an application rollback; set both `active_revision_id` values to `NULL` only through the activation interface if custom rendering must be disabled.

### Task 3.2: Revision manager and optimistic concurrency

**Files:**

- Create `backend/services/printTemplateManager.js`.
- Create `backend/tests/unit/printTemplateManager.test.js`.
- Modify `backend/services/printDocumentCompiler.js`.

**Consumes:** `validateTemplate`, `getBuiltinTemplate`, `stableStringify`, `appendAuditEvent`.

**Produces:** the six stable manager functions named in the interface section and live, printer-specific active-template resolution.

- [ ] **RED:** cover built-in resolution when `active_revision_id IS NULL`, custom resolution for a confirmed printer, built-in fallback for a new/untested printer, workspace history, immutable save, same-hash idempotency, reuse of an older identical revision, stale `expectedLockVersion` returning a named `PRINT_TEMPLATE_CONFLICT`, and invalid JSON/schema rejection before a transaction begins.
- [ ] Implement `getTemplateWorkspace()` with one template-row read, one bounded history read (`LIMIT 50`), and bounded set-based printer/test coverage reads. Never query coverage once per revision or once per printer. Return active/draft definitions and revision metadata; represent the built-in active definition as `{ kind:'builtin', id:null }`.
- [ ] Implement `saveTemplateRevision()`:

  1. Validate and normalize outside the transaction.
  2. Hash `stableStringify(normalizedDefinition)` with SHA-256.
  3. Lock the single template row by unique `document_type` using `FOR UPDATE`.
  4. Compare `lock_version` to `expectedLockVersion`; mismatch throws `PRINT_TEMPLATE_CONFLICT` with HTTP 409.
  5. Reuse an existing same-hash revision or insert `MAX(revision_no)+1` while the template row is locked.
  6. Set `draft_revision_id`, increment `lock_version`, append `print_template_revision_saved`, and commit.

- [ ] Never update `definition_json`, `definition_hash`, or `schema_version` after insert. Per-printer test confirmations are append-only rows; diagnostic columns are lifecycle metadata, not definition mutation.
- [ ] Implement `resolveActiveTemplate(executor, docType, options)` so `NULL` means the effective built-in definition. The compiler passes `printerId` and the payload's current `storeInfo.receipt_config`; the admin workspace loads the same setting once from the database. On every runtime resolution, use one bounded indexed query through the supplied executor to read the printer's current `role`, `is_active`, and `active_endpoint_key`, the active revision, and whether that exact revision+printer+endpoint has a confirmation. Never trust an endpoint copied into request/payload data. A missing, inactive, or wrong-role target throws `PRINT_PRINTER_UNAVAILABLE` before queue insertion; it must not create a permanently pending job or send a receipt to a kitchen device. A valid newly added, reconfigured, or untested printer receives the built-in with `PRINT_TEMPLATE_PRINTER_UNTESTED`. This never deletes or rewrites `receipt_config`.
- [ ] Do **not** add a process cache in this plan. One local indexed resolution query per queued receipt/kitchen document gives immediate correctness after activation, rollback, confirmation, printer reconfiguration, and across multiple backend processes. Phase 5 measures query count and p95; add a coherently invalidated cache in a later measured change only if this read is proven material.
- [ ] On a custom runtime compile failure, update only that revision's `last_compile_error_*` fields through the supplied executor, then compile the built-in fallback. Do not write success metadata on every sale.
- [ ] **GREEN:**

```powershell
npx vitest run backend/tests/unit/printTemplateManager.test.js backend/tests/unit/printDocumentCompiler.test.js
```

Expected: PASS.

- [ ] Commit: `feat(print-templates): own immutable revisions and activation reads`

### Task 3.3: Admin read, save, revision, and preview endpoints

**Files:**

- Create `backend/routes/admin/printTemplates.js`.
- Modify `backend/routes/admin.js`.
- Create `backend/tests/integration/printTemplates.test.js`.

**Endpoints:**

```text
GET  /api/admin/print-templates/:docType
GET  /api/admin/print-templates/:docType/revisions/:revisionId
POST /api/admin/print-templates/:docType/revisions
POST /api/admin/print-templates/:docType/preview
```

- [ ] **RED:** non-admin access is 403 through the existing admin router; invalid doc type/fixture/revision is 400/404; malformed/oversized definitions are 422; stale save is 409; valid save creates exactly one immutable revision; repeated identical save does not duplicate rows.
- [ ] `GET :docType` returns this stable response shape:

```js
{
  success: true,
  template: {
    id, docType, lockVersion,
    active: { kind, id, revisionNo, definition },
    draft: { kind, id, revisionNo, definition },
    revisions: [{ id, revisionNo, definitionHash, createdAt, createdByName,
                  printerCoverage: [{ id, name, tested, confirmedAt, spoolerVersion }],
                  lastCompileErrorCode, lastCompileErrorMessage,
                  lastCompileFailedAt, isActive, isDraft }]
  },
  printers: [{ id, name, role, endpointLabel }],
  catalog,
  fixtures
}
```

`printers` contains only currently active printers matching `docType`; `endpointLabel` is an admin-safe display string, not a credential. `tested` is true only when that revision's stored printer id and endpoint snapshot match the current generated endpoint key.

- [ ] Return no JoFotara response bodies, credentials, arbitrary filesystem paths, queue payloads, or internal SQL errors.
- [ ] `POST revisions` accepts only `{ definition, expectedLockVersion }` and passes the authenticated user id/IP to the manager audit event.
- [ ] A successful save returns the refreshed `template`/`printers` workspace contract (plus catalog/fixtures only on the GET). Confirmation and activation do the same in Task 3.4. The frontend replaces its lock version from that response and does not issue a redundant immediate GET.
- [ ] `POST preview` accepts `{ definition, fixtureKey }`, compiles only a server-owned fixture model, returns `{ artifact, warnings: [] }`, and never writes a revision or queue row.
- [ ] The accepted-JoFotara fixture uses a fixed non-production QR payload containing `TEMPLATE TEST - NOT A LEGAL DOCUMENT`; preview/test endpoints never query or expose a real customer's QR.
- [ ] Reuse `createIpRateLimiter` locally: preview allows 120 requests/minute per IP. Do not add another rate-limit dependency.
- [ ] Inject an uneditable `TEMPLATE PREVIEW — NOT A SALE` wrapper outside template HTML for preview context. A template cannot hide it.
- [ ] Use parameterized SQL and the existing `sendAdminError`/global error translation pattern. Do not introduce a second auth middleware or rate-limit library.
- [ ] **GREEN:**

```powershell
npx vitest run backend/tests/integration/printTemplates.test.js
```

Expected: PASS.

- [ ] Commit: `feat(print-templates): expose revision and preview endpoints`

### Task 3.4: Test-print confirmation, activation, and rollback

**Files:**

- Modify `backend/routes/admin/printTemplates.js`.
- Modify `backend/services/printTemplateManager.js`.
- Modify `backend/services/printDispatch.js`.
- Modify `backend/tests/integration/printTemplates.test.js`.
- Modify `backend/tests/unit/printDispatchOwnership.test.js`.

**Endpoints:**

```text
POST /api/admin/print-templates/:docType/test-print
GET  /api/admin/print-templates/test-jobs/:queueId
POST /api/admin/print-templates/:docType/revisions/:revisionId/confirm-test
POST /api/admin/print-templates/:docType/activate
```

- [ ] Extend `enqueuePrintJobs(executor, payloads, options = {})` and `enqueueAndProcessJobs(io, payloads, options = {})` with one private server-call option: `revisionOverrideId` (`number|'builtin'`). Never read the override from payload/request data; remove it before persistence.
- [ ] Test print accepts `{ revisionId:null|number, printerId, fixtureKey }`; `null` selects the effective built-in through the internal `'builtin'` sentinel. Query the printer and require active role `receipt` for receipt or `kitchen` for kitchen. Build a server fixture and unique test batch/request id, compile that exact selection through the normal enqueue seam, and inject `TEMPLATE TEST — NOT A SALE` outside customizable HTML.
- [ ] Reuse `createIpRateLimiter` on test-print at 10 requests/minute per IP, and disable the UI action while its request is pending. This limits accidental paper floods without changing ordinary print throughput.
- [ ] The test endpoint returns the real queue id. `GET test-jobs/:queueId` returns only id, status, device status, attempts, acknowledged time, spooler version, and public error; it verifies the payload is a template-test job before revealing it.
- [ ] `confirm-test` accepts `{ queueId }`, locks the revision and queue rows by primary key, requires `status='acknowledged'` and `spooler_version >= 1.2.0`, verifies the exact artifact id `revision:<routeRevisionId>`, doc type, and selected printer id, then inserts one append-only `print_template_revision_tests` row with printer name, current `active_endpoint_key`, spooler version, and acknowledged-time snapshots and appends `print_template_test_confirmed`. The unique nullable queue key makes repeated confirmation idempotent while allowing later queue cleanup. Parse numeric major/minor/patch locally; do not add a semver dependency. Built-in test jobs are allowed and must be inspected during rollout, but they create no revision-test row and need no confirmation endpoint because built-in rollback is always available.
- [ ] `activate` accepts `{ revisionId:null|number, expectedLockVersion, reason }`. `null` restores the built-in. A custom revision must belong to this template and have a confirmed matching id+endpoint-key test for **every currently active printer** with the matching role (`receipt` or `kitchen`); zero matching active printers is a 409. Inside one short transaction, lock by document type, compare the version, update `active_revision_id` and `draft_revision_id`, increment `lock_version`, and append `print_template_activated` or `print_template_rollback` with old/new revision ids, tested printer ids, and reason.
- [ ] Confirmation and activation become visible only after their transaction commits. Because runtime resolution is uncached, the next queued document observes committed state; a failed transaction leaves the previous database state authoritative.
- [ ] An older revision may be activated as rollback without a new print only when its confirmations still cover every current id+endpoint-key. Adding or reconfiguring a printer creates a visible coverage gap and requires a new test on that physical endpoint.
- [ ] Even after activation, `resolveActiveTemplate` must serve the built-in to a newly added, reconfigured, or previously untested printer until that exact endpoint is test-printed and confirmed; ordinary production printing is never the test.
- [ ] **RED attacks:** unknown numeric revision cannot test; built-in can test without creating a revision; built-in confirmation is rejected as unnecessary; the 11th same-IP test request in a minute is 429; queue merely `sent` cannot confirm a custom revision; acknowledged old/unknown spooler version cannot confirm; wrong printer role is 409; another template's revision is 404; forged queue id is 409; repeating the same valid confirmation is idempotent 200 while reusing that queue for another revision is 409; stale activation is 409; zero printers or one untested active printer blocks activation; built-in restore succeeds and never deletes history. After confirming/activating a custom revision, create or reconfigure a valid printer and prove the very next resolution serves built-in until exact confirmation; change its role, deactivate/delete it in the database test fixture, and prove the next enqueue fails before inserting a queue row.
- [ ] **GREEN:**

```powershell
npx vitest run backend/tests/integration/printTemplates.test.js backend/tests/unit/printDispatchOwnership.test.js
```

Expected: PASS.

- [ ] Commit: `feat(print-templates): require physical proof before activation`

### Task 3.5: Read-only admin workspace and safe preview

**Files:**

- Create `src/admin/pages/PrintTemplates.vue`.
- Create `src/admin/components/PrintTemplatePreview.vue`.
- Create `src/admin/composables/usePrintTemplates.js`.
- Create `src/admin/pages/__tests__/printTemplatesPage.spec.js`.
- Modify `src/admin/pageRegistry.js`.
- Modify `src/admin/components/Sidebar.vue`.
- Modify `src/admin/App.vue`.
- Modify `src/shared/i18n.js`.
- Create `tests/e2e/specs/admin.print-templates.spec.js`.

- [ ] Register one `print-templates` page in the Management navigation, titled “Print Templates / قوالب الطباعة”. Do not add it to `cachedPages`; an unsaved editor must not survive invisibly.
- [ ] Reuse the existing admin card, command-bar, button, border, typography, dialog, empty-state, and responsive spacing language from Orders/Customers/Inventory. Do not introduce a second design system or generic gradient-heavy builder shell.
- [ ] `usePrintTemplates.js` owns `fetchJson` calls, `AbortController` cancellation, loading/error state, selected doc type, workspace, fixture, revision selection, preview artifact, printers, and lifecycle actions. It owns no schema rules; the backend remains authoritative.
- [ ] The Phase 3 page is definition-read-only: receipt/kitchen tabs, active/draft status, revision history, required/tested printer coverage, fixture selector, server preview, per-printer test status, custom-revision confirm-paper/activate, and restore-built-in actions. A built-in test shows acknowledgement and inspection guidance but no Confirm Paper button because built-in is not a stored revision and is always an available rollback.
- [ ] Render the artifact inside `<iframe sandbox="" :srcdoc="previewDocument">`. Add no `allow-scripts`, `allow-same-origin`, or network permission. Wrap server `html`/`css`; never use owner-authored raw HTML.
- [ ] Label it “Screen layout preview — paper output may differ”. Do not add a fake thermal toggle: the admin browser does not execute the spooler's canvas threshold. Physical paper confirmation is the source of truth.
- [ ] Desktop uses a status/history column plus centered 576px preview. Under 900px, switch to segmented `Status | Preview | History` panes; keep the iframe at its truthful 576px canvas inside a locally scrollable preview viewport, never by overflowing the page or pretending the paper width changed. Buttons remain at least 44px high.
- [ ] Destructive-looking actions use existing admin confirm dialogs. Activation/rollback require a reason. Show 409 conflicts as “This template changed in another admin session; reload before continuing.”
- [ ] Poll only the selected test queue id every 2 seconds while its status is non-terminal and the page is visible; stop on unmount, terminal state, or after 60 seconds. Provide manual refresh afterward.
- [ ] **RED/GREEN:** source contract verifies registry/sidebar/title/sandbox/no browser print; E2E logs in as admin, opens both doc types, changes fixture, previews, and proves non-admin redirection remains intact.

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
npx playwright test tests/e2e/specs/admin.print-templates.spec.js --project=admin-tests
npm run build
```

Expected: PASS.

- [ ] Commit: `feat(admin): add print-template lifecycle workspace`

### Phase 3 gate

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/unit/printTemplateManager.test.js backend/tests/unit/printDocumentCompiler.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/integration/printTemplates.test.js src/admin/pages/__tests__/printTemplatesPage.spec.js
node scripts/validate-schema-drift.js
npm run build
```

For this pre-editor phase, use an authenticated admin request to save one unchanged copy of each built-in definition as a custom revision; do not seed production tables manually. Then execute one real receipt and one real kitchen revision test job, wait for spooler acknowledgement, inspect the paper, confirm it in the admin page, activate, print one production-safe guest check/kitchen fixture, and restore built-in. Do not continue if physical confirmation or rollback is unclear.

---

## Phase 4 — Full flow-layout editor

Phase 4 makes the builder usable without arbitrary positioning. It edits only the closed schema and sends complete definitions to the backend.

### Task 4.1: Band/node editor with accessible reordering

**Files:**

- Create `src/admin/components/PrintTemplateEditor.vue`.
- Modify `src/admin/pages/PrintTemplates.vue`.
- Modify `src/admin/pages/__tests__/printTemplatesPage.spec.js`.
- Modify `src/shared/i18n.js`.

- [ ] **RED:** the source contract expects the editor only for a draft workspace, six Phase 1 node types, stable id generation using `crypto.randomUUID()`, move-up/down controls, and no GrapesJS/drag dependency/raw CSS textarea.
- [ ] Show a node library filtered by doc type. Adding a node creates a schema-valid minimal node with a stable id. Receipt-only `jofotara_qr` is unavailable in kitchen.
- [ ] Render a nested band/node tree with selection, duplicate for optional nodes, move up/down, and delete. Do not implement HTML5 drag-and-drop: explicit buttons work with keyboard, touch, and small screens without another state machine.
- [ ] Client-side guards mark structural required nodes as locked and explain why. They are convenience only; a forged request still reaches backend structural validation.
- [ ] Required primary repeat bands cannot be duplicated, filtered, hidden, or deleted. Optional nodes may be removed.
- [ ] Use local `ref(structuredClone(definition))` state. Do not mutate props, active definitions, or revision history objects.
- [ ] **GREEN:**

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
npm run build
```

Expected: PASS.

- [ ] Commit: `feat(admin): add accessible print-template structure editor`

### Task 4.2: Closed property inspector and responsive editing

**Files:**

- Modify `src/admin/components/PrintTemplateEditor.vue`.
- Modify `src/admin/pages/PrintTemplates.vue`.
- Modify `src/admin/pages/__tests__/printTemplatesPage.spec.js`.

- [ ] Build controls directly from the server catalog and fixed token lists. Do not duplicate field validity rules in a frontend catalog.
- [ ] Text controls: English, Arabic, display mode `auto|both`.
- [ ] Field controls: catalog path, bilingual label, label mode.
- [ ] Style controls: exact `fontFamily`, `fontSize`, `fontWeight`, `align`, `direction`, `width`, and margin tokens defined above.
- [ ] Visibility controls: one catalog path, one allowed operator, and a typed scalar. Hide the control entirely for required nodes/ancestors.
- [ ] Divider and spacer controls expose only their enums. QR exposes only size/alignment; it never exposes QR content.
- [ ] Add “Reset draft to active” and “Reset draft to built-in” as local operations requiring confirmation; neither writes until Save Revision.
- [ ] Track dirty state by stable normalized serialization, not deep watchers that rewrite state. `onBeforeRouteLeave` and `beforeunload` warn only when dirty.
- [ ] Desktop layout: structure left, preview center, inspector right. Under 900px use `Structure | Preview | Properties` tabs. Do not pretend pixel dragging works on mobile; all token controls remain fully usable.
- [ ] Every input has an associated label; icon-only buttons have translated `aria-label`; selection/focus is visible; reduced-motion disables preview/editor transitions.
- [ ] **GREEN:** source tests plus build.

```powershell
npx vitest run src/admin/pages/__tests__/printTemplatesPage.spec.js
npm run build
```

- [ ] Commit: `feat(admin): add bounded template property controls`

### Task 4.3: Save, preview, test, publish, conflict, and rollback workflow

**Files:**

- Modify `src/admin/composables/usePrintTemplates.js`.
- Modify `src/admin/pages/PrintTemplates.vue`.
- Modify `tests/e2e/specs/admin.print-templates.spec.js`.
- Modify `src/shared/i18n.js`.

- [ ] Preview the local definition after 300ms idle using one abortable request. Abort the old preview on another edit, doc-type switch, fixture switch, or unmount. A failed preview shows the named backend error and never substitutes stale HTML from another definition.
- [ ] Save sends `{ definition, expectedLockVersion }`; success replaces workspace/lock version, marks clean, and selects the saved revision. A 409 keeps local edits and offers Reload or Copy JSON to clipboard for recovery.
- [ ] Test Print is enabled for the unmodified built-in or for a saved revision matching the current local hash. A local change after save disables it until another save.
- [ ] Confirm Paper is shown only for a saved custom revision and enabled only after its real queue status is `acknowledged`. Built-in test jobs show their terminal result without creating confirmation data. Custom activation is enabled only after every active matching printer is covered; restore-built-in remains independently available.
- [ ] Rollback chooses a revision whose test coverage still matches all active printers, or built-in; it requests a reason, calls the same activation endpoint, refreshes workspace, and invalidates any local draft selection.
- [ ] E2E real workflow: edit bilingual header → preview → save → select printer → test print request → simulate/perform acknowledged queue in test DB → confirm → activate → reload page → verify active revision → roll back to built-in. Add a second browser context or direct request to prove stale version gets 409 without losing local edits.
- [ ] E2E scope assertions: browser receipt files remain untouched; report print jobs never carry template artifacts; mobile viewport can reach Structure, Preview, and Properties controls without horizontal body overflow.
- [ ] **GREEN:**

```powershell
npx playwright test tests/e2e/specs/admin.print-templates.spec.js --project=admin-tests
npm run build
```

Expected: PASS.

- [ ] Commit: `feat(admin): complete print-template publishing workflow`

### Phase 4 gate

```powershell
npx vitest run backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateManager.test.js backend/tests/integration/printTemplates.test.js src/admin/pages/__tests__/printTemplatesPage.spec.js
npx playwright test tests/e2e/specs/admin.print-templates.spec.js --project=admin-tests
npm run build
```

Physical gate: customize and print each kitchen state plus exclusive, inclusive, split-tender, Arabic, and accepted-JoFotara receipt fixtures. Verify required content survived every customization, scan the JoFotara QR, activate both templates, print again through ordinary POS/backend workflows, then roll back both to built-in.

---

## Phase 5 — Exact once-band positioning and existing store logo

Phase 5 completes the requested positioning/logo capability without opening arbitrary uploads, arbitrary HTML, or absolute repeating items.

### Task 5.1: Absolute positioning inside fixed once bands

**Files:**

- Modify `backend/services/printTemplateEngine.js`.
- Modify `backend/tests/unit/printTemplateEngine.test.js`.
- Modify `src/admin/components/PrintTemplateEditor.vue`.
- Modify `src/admin/components/PrintTemplatePreview.vue`.
- Modify `src/admin/pages/__tests__/printTemplatesPage.spec.js`.

- [ ] **RED backend cases:** absolute repeat bands rejected; missing, below-40, above-1,200, off-grid, or over-2,400-total band heights rejected; negative/non-integer/off-grid coordinates rejected; node width/height below 4px rejected; `x+widthPx>576` rejected; `y+heightPx>band.height` rejected; overlapping nodes allowed but warned; required nodes clipped outside the band rejected rather than warned.
- [ ] Compiler emits one `position:relative; height:Npx; overflow:hidden` once band and fixed `position:absolute` node boxes. It emits no user CSS and no transform expressions.
- [ ] Add a Flow/Positioned toggle only for `once` bands. Switching to Positioned gives existing children bounded defaults and requires confirmation; switching back removes coordinate properties.
- [ ] Desktop preview supports pointer dragging/resizing using Pointer Events, 4px snapping, keyboard arrow movement (Shift = 16px), and numeric inspector inputs. The server still revalidates every coordinate.
- [ ] On mobile, disable pointer dragging and retain numeric x/y/width/height controls. Do not create a second mobile schema.
- [ ] Preview shows clipping and overlap warnings returned by the backend. Saving is blocked only by errors; activation still requires paper confirmation.
- [ ] **GREEN:**

```powershell
npx vitest run backend/tests/unit/printTemplateEngine.test.js src/admin/pages/__tests__/printTemplatesPage.spec.js
npm run build
```

Expected: PASS.

- [ ] Commit: `feat(print-templates): add bounded once-band positioning`

### Task 5.2: Reuse the existing store brand icon

**Files:**

- Modify `backend/services/printDocumentCompiler.js`.
- Modify `backend/services/printTemplateEngine.js`.
- Modify `backend/tests/unit/printDocumentCompiler.test.js`.
- Modify `backend/tests/unit/printTemplateEngine.test.js`.
- Modify `src/admin/components/PrintTemplateEditor.vue`.
- Modify `src/shared/i18n.js`.

- [ ] Add one `store_logo` node. It has size/alignment/position only; it cannot accept a URL, path, base64 value, upload, or arbitrary image.
- [ ] Leave both built-in templates unchanged; the logo appears only after an administrator adds the optional node to a custom revision.
- [ ] Only when the selected template contains `store_logo`, load the authoritative `store_icon` setting through the supplied executor (kitchen payloads do not carry `storeInfo`). Accept only `/uploads/store_icon.(png|jpg|ico|webp)`, take `path.basename`, resolve under the repository `uploads` directory, verify the resolved path remains inside that directory, sniff magic bytes again, and reject missing/mismatched files. Pass the bounded data URI in compiler context; do not add a money-capable kitchen model field.
- [ ] Embed the bytes as a MIME-correct data URI only when the raw file is at most 96KB and the final artifact remains under 256KB. Oversize/missing logo makes that optional node render empty with a named preview warning; it must not drop the receipt/kitchen job.
- [ ] Do not add `sharp`, another upload endpoint, an asset table, or a per-template file store. The spooler's existing final raster threshold makes the embedded logo monochrome on paper; physical confirmation catches unsuitable artwork.
- [ ] Security tests: `../` traversal, absolute path, SVG/HTML/PHP, forged extension, magic mismatch, symlink escape where supported, missing file, 96KB+1, and total-artifact overflow. All fail closed for the image while preserving the document fallback.
- [ ] UI shows “Uses the Store Brand Icon from Settings” and links/navigates to Settings when absent. It never offers an upload inside the builder.
- [ ] **GREEN:**

```powershell
npx vitest run backend/tests/unit/printDocumentCompiler.test.js backend/tests/unit/printTemplateEngine.test.js
npm run build
```

Expected: PASS.

- [ ] Commit: `feat(print-templates): embed the existing store icon safely`

### Task 5.3: Final rollout evidence and operational documentation

**Files:**

- Modify `docs/SPOOLER-CHANGES.md`.
- Create `docs/superpowers/evidence/2026-07-25-receipt-template-builder.md`.
- Modify focused tests only if the documented rollout exposes a real missing assertion.

- [ ] Document deployment order: migration → tracked spooler `1.2.0` on **every** target receipt/kitchen station → verify each station with built-in jobs → backend/admin bundle → save/test/confirm custom drafts → activate receipt → activate kitchen. Never deploy the artifact-producing backend first: an old spooler would ignore the accepted-JoFotara QR artifact.
- [ ] Document rollback order: activate built-in for kitchen and receipt → confirm new jobs omit custom revision ids → application rollback if needed. Never delete revisions or queue history.
- [ ] Record app commit, spooler version, printer model/DPI, Windows machine, template revision ids, queue ids, representative optimized paper photos/contact sheets, QR scan result, and each matrix result. Keep raw captures outside Git.
- [ ] Mixed-version proof: new spooler/old backend prints legacy; old spooler/new backend prints legacy/v1 for non-QR compatibility but is explicitly a deployment **NO-GO** for accepted JoFotara receipts because it cannot render the required QR; new/new prints the artifact; reports remain hardcoded in all combinations.
- [ ] Load proof: enqueue 100 receipt and 100 kitchen fixture jobs without physical device writes, measure compile p50/p95, serialized payload maximum, DB query count, and memory growth. Target p95 under 250ms and every payload under 768KB; treat misses as findings, not reasons to loosen caps silently.
- [ ] Full physical matrix: all Phase 2 cases, every kitchen variant, custom flow layout, one positioned header, Arabic, long item list, store logo, accepted QR scan, missing-logo fallback, rollback, and one excluded report smoke test.
- [ ] Commit: `docs(print-templates): record rollout and physical verification`

### Phase 5 / release gate

```powershell
node pos-spooler-printer/tests/run-tests.js
npm run test:unit
npx playwright test tests/e2e/specs/admin.print-templates.spec.js --project=admin-tests
npm run build
node scripts/validate-schema-drift.js
```

Release only after the migration verifier reports zero blockers and the physical evidence document has no unresolved receipt-money, required-kitchen-content, QR, clipping, fallback, idempotency, or report-isolation finding.

## Explicitly rejected

- `custom_html`, scriptable templates, expression languages, sandboxed evaluators.
- GrapesJS, jsreport, ReportBro, Carbone, JasperReports.
- A `cut` node; the spooler cuts after rasterization.
- A file/class per node type.
- Generic adapters, repositories, DI containers, or controllers for two document types.
- Converting browser printing, reports, or all admin print flows “for consistency.”
- Blocking checkout while waiting for JoFotara acceptance.
- Printing a pending/unknown/rejected/client-supplied JoFotara QR.
- Arbitrary template image uploads; the builder reuses the already-secured store brand icon.
- Generic QR/barcode content, per-printer templates, and per-order-type templates without a named installation requirement.
- 55/58mm, 88mm, or automatic paper-width scaling.

---

## Lower-agent execution prompt

```text
Act as the senior owner of a live restaurant POS executing the attached receipt-template-
builder plan. Use Ponytail at full intensity. Work on a feature branch and execute exactly
one task at a time in plan order. Do not redesign later phases while implementing the current
task. Stop at every phase gate and report evidence before continuing.

Before each task, reread its named files and confirm every anchor against current source.
Hold scope absolutely:
- Only backend/spooler customer receipts and kitchen tickets.
- Admin UI may author, preview the server artifact, and submit real spooler test-print jobs.
- ReceiptPreviewModal.vue, PrintReceiptApp.vue, window.print(), reports, Z/X, category,
  Y/held-order reports, audit reports, and expense slips are not builder output surfaces.
- Templates never compute money and never accept arbitrary HTML or QR payloads.
- JoFotara QR comes only from an accepted authoritative database document.
- Existing queue reprints preserve historical bytes.
- The builder supports only 80mm/576px output.
- receipt_config remains for excluded browser/old-spooler compatibility.
- Screen preview is an approximation; activation requires acknowledged and human-confirmed paper.

For each task: run the exact RED check and prove the intended failure; implement the smallest
change behind the named deep-module interface; run the exact GREEN check; inspect the diff
for scope drift, duplicate catalogs/money logic, client-supplied HTML/QR, and stale source-
matching tests; then make the named narrow commit. Never weaken a test or fallback merely to
make a gate green. Preserve unrelated worktree changes.

At a physical gate, stop and request the owner's printer result if you cannot operate the real
hardware. Do not mark the phase complete from unit/browser tests alone. Return task evidence,
commit hash, remaining risks, and GO/NO-GO.
```

## Adversarial attack prompt

```text
Assume this spooler-only plan can print an incorrect customer receipt or a misleading
kitchen ticket even while every named test passes. Attack it using current source evidence.

1. Enumerate every backend producer reaching enqueuePrintJobs, including transactional
   producers and payload clones. Find any path that could bypass trusted compilation.
2. Forge compiled_document_v1 and jofotara fields through guest-check and report requests.
   Prove the final enqueue seam strips them before hashing.
   Prove a self-footing but false client guest-check v1 cannot become the compiled model.
3. Prove report types can never consume a compiled receipt/kitchen artifact.
4. Delete/spoof every required semantic role. Prove structure, bindings, unconditional
   ancestors, and exactly-once primary item coverage are validated.
5. Construct wrong money under exclusive, inclusive, order-discount, bundle, service-charge,
   split-tender, and cent-apportionment cases using only legal nodes. The attack must fail.
6. Test accepted, pending, submitting, rejected, unknown, empty, forged, and mismatched
   JoFotara states. Only accepted authoritative QR text may reach the artifact.
7. Prove immediate checkout does not wait for JoFotara and document the fresh-order-reprint
   versus exact-queue-reprint difference.
8. Attack subscription normal→void cloning and prove enqueue replaces stale compiled HTML.
9. Prove template revision bytes cannot change kitchen idempotency, while real item changes do.
10. Prove the spooler hashes the exact stored payload shape, null legacy hashes still print,
    and non-null corruption fails closed.
11. Exceed static and expanded limits separately. Prove runtime overflow falls back without
    losing the print job or breaking the 1MB transport envelope.
12. Run mixed-version rollout permutations and physical receipt/kitchen prints. Smoke one
    excluded report to prove no accidental migration.
13. Race two admin sessions saving and activating. Prove lock_version rejects stale state and
    that no revision definition mutates after insertion.
14. Forge physical confirmation with pending, sent, wrong-type, wrong-revision, and another
    template's queue jobs. Add, reconfigure, change the role of, and delete printers between confirmation and activation. Prove
    only acknowledged matching paper covering every currently active role printer can activate.
15. Attack preview srcdoc, bilingual text, conditions, style tokens, and the editor request with
    script tags, raw CSS, external URLs, oversized JSON, unknown fields, and prototype keys.
16. Attack store_logo with traversal, symlink escape, SVG/HTML/PHP, magic mismatch, missing and
    oversized files. Prove the optional logo disappears without losing required document output.
17. Attack absolute positioning: repeat bands, negative/off-grid/overflow boxes, clipped required
    content, overlap, mobile controls, and coordinate forgery sent directly to the backend.
18. Prove an old application can ignore additive template tables and built-in activation is a
    complete operational rollback without deleting revisions or queue history.

Reject any finding based only on line count or personal style. Return blocking findings,
high-risk corrections, overengineering to delete, missing tests, and GO/NO-GO. Do not execute.
```

## Review corrections incorporated

This revision supersedes the earlier four-surface design.

1. Browser receipt output was removed by owner decision; only the backend/spooler path is authoritative for this builder.
2. Reports that use the same spooler remain independent hardcoded documents.
3. Compilation moved from route producers to `enqueuePrintJobs()` after the subscription-void clone exposed stale-artifact risk.
4. Incoming compiled HTML and QR data are explicitly untrusted and removed at that seam.
5. Existing `receipt_config.layout` compatibility moved into the built-in default and remains stored for excluded browser/old-spooler compatibility.
6. Required semantic roles became structural and exactly-once, not user-assignable labels.
7. Runtime expansion limits were separated from save-time validation; 250ms became telemetry, not an unenforceable safety limit.
8. `builtin_header` was removed; kitchen variants are expressible with ordinary nodes and trusted state.
9. Phase 2 deployment order now lands spooler capability, semantic idempotency, and integrity before backend attachment.
10. JoFotara QR moved into core receipt support, with an accepted-database-only trust rule and truthful asynchronous behavior.
11. Storage now uses three tables: one optimistic-lock row per document type, immutable JSON revisions, and append-only per-printer paper confirmations—plus the existing audit ledger, with no repository/controller framework.
12. The screen preview is explicitly approximate; an acknowledged queue job plus human paper confirmation is required before activation.
13. Logo support reuses the existing secured store icon, avoiding another uploader, asset table, and image dependency.

## Final execution verdict

- **Phases 0–5:** executable in order after a fresh-source line-anchor pass by the assigned worker. Do not deploy a partial Phase 2 or activate any unconfirmed revision.
- **Handoff suitability:** tasks expose stable interfaces, exact files, focused RED/GREEN gates, narrow commits, migration verification, rollback, browser workflow, and physical proof. A lower-context worker should not invent architecture outside this document.
- **Abandon/redesign condition:** if default receipt/kitchen templates cannot match the Phase 0 goldens without special-casing individual fixtures, the vocabulary is wrong. Redesign the vocabulary instead of accumulating renderer exceptions.
