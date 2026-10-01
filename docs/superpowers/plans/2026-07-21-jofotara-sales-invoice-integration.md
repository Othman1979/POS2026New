# JoFotara Sales Invoice Integration Implementation Plan

**Implementation status (2026-07-21):** Executed on `codex/jofotara-integration` as one reviewed feature commit. The checkboxes below remain the original implementation specification and acceptance checklist.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-operated JoFotara integration that previews or submits finalized POS sales invoices and their saved refunds, stores every submitted legal document idempotently, and prints the returned QR without changing normal checkout availability.

**Architecture:** `orders`/`order_items` remain the immutable sale source and `refunds`/`refund_items` remain the immutable return source. A linked `jofotara_documents` ledger owns legal UUIDs, ICVs, XML, responses, QR text, and submission state; one domain service is called by manual admin routes now and can be called by a post-checkout worker later. Government HTTP calls occur after local transactions and never make a valid POS checkout fail.

**Tech Stack:** Node.js/CommonJS, Express 5, mysql2/InnoDB, Vue 3, native `fetch`, installed `qrcode`, Vitest/Supertest.

## Global Constraints

- Sales invoice only: UBL invoice code `388`; credit note code `381`; no vouchers.
- Use visible `orders.invoice_number` as the sales document number; never expose `orders.invoice_id` as the government invoice serial.
- Cash, card, and split are immediate-payment invoices (`012`). Do not invent receivable (`022`) behavior.
- Service charge is an ordinary invoice line.
- Order discounts must be prorated into line allowances before tax is recalculated.
- Zero-price modifiers create no financial line. Priced modifiers remain part of their parent product line and use the frozen `modifier_surcharge` plus `modifier_tax_amount` created by the prerequisite plan.
- Voids never create JoFotara credit notes. Only committed `kind='refund'` rows may be returned.
- Never resend an accepted document. Timeout/crash uncertainty becomes `unknown`, never an automatic retry.
- Store JoFotara QR data verbatim. Do not decode, rewrite, or regenerate its content.
- Never expose or log `jofotara_secret_key`.
- Seed every seller identity and API credential setting as an empty string. Never ship sample or placeholder tax identities.
- Do not call JoFotara inside a checkout/refund database transaction.
- The temporary XML download action must call the exact production snapshot/XML builder, perform no HTTP request, and create no `jofotara_documents` row.
- Implement this plan only after `2026-07-21-tax-inclusive-priced-modifiers.md` is complete.

---

## File Map

| File | Responsibility |
|---|---|
| `backend/migrations/2026-07-21-jofotara-documents.sql` | Settings seeds and legal-document ledger |
| `backend/tests/fixtures/seed.js` | Test-schema parity |
| `backend/services/JofotaraXmlBuilder.js` | Deterministic legal snapshot and UBL XML |
| `backend/services/JofotaraClient.js` | One HTTP boundary with redacted errors |
| `backend/services/JofotaraService.js` | Eligibility, locking, idempotency, state transitions |
| `backend/routes/admin/jofotara.js` | Admin settings, submission, status, and QR endpoints |
| `backend/routes/admin.js` | Mount JoFotara router |
| `backend/routes/admin/orders.js` | Join compact JoFotara state into order reads |
| `backend/services/ReceiptPresentation.js` | Optional accepted JoFotara QR presentation |
| `assets/js/composables/receiptPrint.js` | Carry QR through canonical receipt payload |
| `src/print/PrintReceiptApp.vue` | Render accepted QR on 80mm receipts |
| `src/admin/pages/Settings.vue` | JoFotara settings tab |
| `src/admin/pages/Orders.vue` | Send/status/QR/return actions |
| `assets/js/admin/i18n.js` | Natural Arabic UI copy |
| `backend/tests/unit/jofotaraXmlBuilder.test.js` | Legal mapping and money tests |
| `backend/tests/unit/jofotaraClient.test.js` | Transport/response parsing tests |
| `backend/tests/integration/jofotara.test.js` | API, idempotency, return, and secret tests |

### Task 1: Create the JoFotara ledger and settings

**Interfaces:**
- Produces one row per source through `UNIQUE source_key`.
- `id` is the numeric ICV.
- `status` is `pending|submitting|accepted|rejected|unknown`.

- [ ] Add a failing schema assertion to `scripts/validate-schema-drift.js`/the existing schema validation fixture for `jofotara_documents` and six setting keys.
- [ ] Create `backend/migrations/2026-07-21-jofotara-documents.sql` with this shape:

```sql
CREATE TABLE IF NOT EXISTS jofotara_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_key VARCHAR(96) NOT NULL,
  order_invoice_id INT NOT NULL,
  refund_id INT NULL,
  original_document_id BIGINT UNSIGNED NULL,
  document_kind ENUM('invoice','credit_note') NOT NULL,
  document_number VARCHAR(96) NOT NULL,
  document_uuid CHAR(36) NOT NULL,
  status ENUM('pending','submitting','accepted','rejected','unknown') NOT NULL DEFAULT 'pending',
  legal_snapshot_json LONGTEXT NULL,
  request_xml LONGTEXT NULL,
  qr_text LONGTEXT NULL,
  response_body LONGTEXT NULL,
  http_status SMALLINT UNSIGNED NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  submitted_by_user_id INT NULL,
  last_attempt_at DATETIME NULL,
  accepted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jofotara_source (source_key),
  UNIQUE KEY uq_jofotara_uuid (document_uuid),
  UNIQUE KEY uq_jofotara_number (document_number),
  KEY idx_jofotara_order (order_invoice_id, status),
  CONSTRAINT fk_jofotara_order FOREIGN KEY (order_invoice_id) REFERENCES orders(invoice_id),
  CONSTRAINT fk_jofotara_refund FOREIGN KEY (refund_id) REFERENCES refunds(id),
  CONSTRAINT fk_jofotara_original FOREIGN KEY (original_document_id) REFERENCES jofotara_documents(id),
  CONSTRAINT fk_jofotara_user FOREIGN KEY (submitted_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO settings (setting_key, setting_value) VALUES
('jofotara_enabled', '0'),
('jofotara_client_id', ''),
('jofotara_secret_key', ''),
('jofotara_income_source_sequence', ''),
('jofotara_seller_tax_number', ''),
('jofotara_seller_registered_name', '')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);
```

- [ ] Mirror the table and settings in `backend/tests/fixtures/seed.js`; do not add JoFotara columns to `orders`.
- [ ] Run `node scripts/validate-schema-drift.js`; expect PASS after applying the migration to the development DB.
- [ ] Commit: `feat(jofotara): add legal document ledger`.

### Task 2: Build deterministic sales and return snapshots

**Interfaces:**
- Produces `buildSalesSnapshot({ order, items, customer, seller })`.
- Produces `buildCreditNoteSnapshot({ refund, refundItems, originalDocument, reason })`.
- Snapshot values are plain JSON and immutable after the first submission attempt.

- [ ] Write failing tests in `backend/tests/unit/jofotaraXmlBuilder.test.js` for:
  - invoice number equals `String(order.invoice_number)`;
  - payment methods `cash|card|split` map to `012`;
  - bundle children (`parent_item_id != null`) are excluded;
  - service-charge rows remain included;
  - zero-price modifiers do not add lines;
  - a new priced modifier stays in its parent line and subtracts frozen `modifier_tax_amount` from the exclusive legal extension;
  - a legacy priced modifier with NULL `modifier_tax_amount` reproduces its stored historical subtotal/tax instead of being reinterpreted;
  - order discount is allocated proportionally across financial lines;
  - final rounding residue is assigned to the last eligible line;
  - tax-inclusive line tax is reconstructed from the frozen rate;
  - mixed positive and zero rates reconcile to `orders.total`;
  - Arabic names and XML-sensitive characters survive snapshot creation.
- [ ] Implement only reusable money helpers inside `backend/services/JofotaraXmlBuilder.js`:

```js
const amount9 = value => Number(value || 0).toFixed(9);
const qty2 = value => Number(value || 0).toFixed(2);
const rate2 = value => Number(value || 0).toFixed(2);
const xmlEscape = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');
```

- [ ] Build each sales line from saved `price_at_sale`, quantity, discounts, tax rate, `modifier_surcharge`, and `modifier_tax_amount`. Keep the modifier inside the parent line. `price_at_sale` already includes the frozen modifier surcharge. For new exclusive-mode rows, the undiscounted legal net unit is `price_at_sale - modifier_tax_amount`; for tax-inclusive catalog rows, derive the whole line net from its gross price and frozen rate; for legacy NULL rows, reconcile against stored `tax_amount` and historical subtotal rather than applying the new rule retroactively.
- [ ] Calculate the line allowance as gross legal net before discounts minus the post-line-and-prorated-order-discount extension. Never emit a separate modifier line.
- [ ] For tax-inclusive pricing derive pre-tax values with `inclusive / (1 + rate/100)` and derive tax as the remainder. Never use the inclusive-mode order header's stored zero tax as the legal VAT amount.
- [ ] Map positive rates to `S`, zero rates to `Z`; reject an unsupported future `O` classification rather than guessing.
- [ ] Build credit-note lines from `refund_items`: `gross=quantity*unit_price`, `allowance=gross-line_subtotal`, `tax=line_tax`, `payable=line_total`.
- [ ] Run `npx vitest run backend/tests/unit/jofotaraXmlBuilder.test.js`; expect PASS.
- [ ] Commit: `feat(jofotara): build immutable legal snapshots`.

### Task 3: Render compliant UBL XML

**Interfaces:**
- Produces `renderSalesInvoiceXml(snapshot, { uuid, icv }) -> string`.
- Produces `renderCreditNoteXml(snapshot, { uuid, icv }) -> string`.

- [ ] Add exact-string tests for namespace declarations, element order, `388`, `381`, `012`, ICV, UUID, currency, tax categories, allowances, and `BillingReference`.
- [ ] Implement the UBL renderer with string templates and `xmlEscape`; do not add an XML dependency.
- [ ] Use `JOD` as document currency and `currencyID="JO"` where required by the supplied production reference.
- [ ] For credit notes require original document number, accepted original UUID, original total, unchanged buyer snapshot, and a non-empty reason.
- [ ] Assert before returning XML that calculated line extension, allowance, tax, and payable totals reconcile to the snapshot within `0.000000001`.
- [ ] Run the focused XML builder test; expect PASS.
- [ ] Commit: `feat(jofotara): render sales and return UBL`.

### Task 4: Add the isolated government transport client

**Interfaces:**
- Produces `submitXml({ clientId, secretKey, xml, fetchImpl = fetch })`.
- Returns `{ outcome, httpStatus, qrText, responseBody }`, where outcome is `accepted|rejected|unknown`.

- [ ] Write failing transport tests using a stubbed `fetchImpl` for accepted JSON with QR, rejected JSON, non-JSON body, HTTP failure, abort timeout, and network failure.
- [ ] Implement `backend/services/JofotaraClient.js` using `AbortSignal.timeout(30000)` and:

```js
await fetchImpl('https://backend.jofotara.gov.jo/core/invoices/', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Client-Id': clientId,
    'Secret-Key': secretKey
  },
  body: JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') }),
  signal: AbortSignal.timeout(30000)
});
```

- [ ] Parse acceptance from the response body as well as HTTP status. Preserve raw text. Return `unknown` for timeout/network ambiguity and never include either credential in thrown errors.
- [ ] Run `npx vitest run backend/tests/unit/jofotaraClient.test.js`; expect PASS.
- [ ] Commit: `feat(jofotara): add redacted submission client`.

### Task 5: Implement idempotent submission orchestration

**Interfaces:**
- Produces `submitSalesInvoice({ invoiceId, actorUserId })`.
- Produces `submitCreditNote({ refundId, actorUserId })`.
- Produces `getOrderJofotaraState(invoiceId)`.

- [ ] Add integration tests proving unpaid/voided orders are rejected, missing `invoice_number` is rejected, accepted documents are not resent, rejected retries reuse XML/UUID/ICV, double-clicks send once, and timeout becomes `unknown`.
- [ ] In `backend/services/JofotaraService.js`, load settings directly from the database and validate enabled state plus all five credentials/seller fields.
- [ ] In a short transaction, lock the source row and `jofotara_documents` row. Create with `crypto.randomUUID()` and these identities:

```js
const sourceKey = `invoice:${order.invoice_id}`;
const documentNumber = String(order.invoice_number);
// Return:
const sourceKey = `refund:${refund.id}`;
const documentNumber = `R-${order.invoice_number}-${refund.id}`;
```

- [ ] Insert first to obtain numeric `id`/ICV, then build and persist snapshot/XML in that same transaction. Reuse them forever.
- [ ] If accepted, return stored state. If recently submitting, return conflict. If unknown, return review-required conflict. If rejected, increment attempt count and reuse the stored payload.
- [ ] Commit `submitting` before calling `submitXml`. Update to `accepted`, `rejected`, or `unknown` afterward in a new transaction.
- [ ] Append a credential-free audit event for every attempt/result.
- [ ] Run `npx vitest run backend/tests/integration/jofotara.test.js`; expect PASS.
- [ ] Commit: `feat(jofotara): orchestrate idempotent submissions`.

### Task 6: Enforce legal refund eligibility

**Interfaces:**
- Credit-note submission consumes one committed `refunds` row and its `refund_items`.

- [ ] Add tests for full, partial, and multiple refunds; cumulative quantities; original-not-accepted; void exclusion; missing reason; and unchanged buyer snapshot.
- [ ] Require `refunds.kind='refund'`, a non-empty saved reason, and an accepted original `invoice` document.
- [ ] Join `refund_items` to their original `order_items` only for identity/quantity verification. Use the saved refund money fields for the return document.
- [ ] Reference the accepted original document row through `original_document_id`; copy buyer and original totals from its immutable `legal_snapshot_json`, never from a currently edited customer.
- [ ] Run the focused integration test; expect PASS.
- [ ] Commit: `feat(jofotara): submit saved refunds as credit notes`.

### Task 7: Add secure admin routes and order status reads

**Interfaces:**
- `GET /api/admin/jofotara/settings`
- `PUT /api/admin/jofotara/settings`
- `POST /api/admin/jofotara/invoices/:invoiceId/submit`
- `GET /api/admin/jofotara/invoices/:invoiceId/xml`
- `GET /api/admin/jofotara/invoices/:invoiceId`
- `POST /api/admin/jofotara/refunds/:refundId/submit`

- [ ] Mount `backend/routes/admin/jofotara.js` in `backend/routes/admin.js`; existing admin/programmer middleware remains the authorization wall.
- [ ] Settings GET returns non-secret fields plus `secret_configured`; settings PUT treats blank secret as “preserve”, with an explicit `clear_secret: true` to remove it.
- [ ] Return stable public error codes for disabled, incomplete configuration, invalid invoice, already submitting, and unknown outcome.
- [ ] Add the temporary XML download route. It requires a finalized eligible invoice and the three XML seller fields (income-source sequence, tax number, registered name), but does not require `jofotara_enabled`, Client ID, or Secret Key. Return `application/xml; charset=utf-8` with a safe attachment filename. Do not call JoFotara, allocate an ICV/ledger row, write audit submission state, or mutate the order. Use a deterministic preview UUID/ICV value clearly isolated from submission identities.
- [ ] Extend `backend/routes/admin/orders.js` list/details queries with compact document status and accepted QR availability, without returning XML/raw government responses in the list.
- [ ] Verify through integration tests that cashiers are denied and secrets never appear in bodies or serialized logs.
- [ ] Commit: `feat(jofotara): expose secure admin workflow`.

### Task 8: Add the Settings tab

**Files:** `src/admin/pages/Settings.vue`, `assets/js/admin/i18n.js`.

- [ ] Add a `jofotara` tab labelled `Electronic invoicing` / `الفوترة الإلكترونية` and a save action that calls only the dedicated admin endpoint.
- [ ] Add fields for client ID, secret, income-source sequence, seller tax number, and registered seller name. Never populate the secret input from a GET response.
- [ ] All fields begin empty on a fresh database. Blank secret on update means preserve the saved secret; only explicit clearing removes it.
- [ ] Show exactly three readiness states: disabled, incomplete, ready. Do not add a live “test invoice” action.
- [ ] Add natural Arabic strings: `رقم المستخدم`, `المفتاح السري`, `تسلسل مصدر الدخل`, `الرقم الضريبي`, `الاسم المسجل`.
- [ ] Run `npm run build:admin`; expect PASS.
- [ ] Commit: `feat(admin): configure electronic invoicing`.

### Task 9: Add Orders actions, return status, and QR modal

**Files:** `src/admin/pages/Orders.vue`, `assets/js/admin/i18n.js`.

- [ ] Add desktop and mobile menu actions using the same state helper:

```js
const jofotaraAction = order => ({
  pending: 'Send to JoFotara',
  submitting: 'Sending…',
  accepted: 'View JoFotara QR',
  rejected: 'Retry JoFotara submission',
  unknown: 'Needs review'
}[order.jofotara_status || 'pending']);
```

- [ ] Hide all actions when integration is disabled. Disable unpaid/voided orders.
- [ ] Add a temporary `Generate XML` / `إنشاء ملف XML` action to the existing three-dot menu for finalized eligible orders. Keep this preview action visible even while submission is disabled so the XML can be reviewed before real credentials are activated. Download the backend response as an `.xml` file; do not duplicate XML construction in Vue.
- [ ] After acceptance open one compact QR modal and offer thermal reprint. Use installed `qrcode` to render `qr_text`; do not transform the text.
- [ ] For accepted originals with saved refunds, show a compact return list where each refund has its own Send/status/QR action. Do not create another refund button or refund calculation path.
- [ ] Add natural Arabic strings including `إرسال إلى الفوترة الإلكترونية`, `عرض رمز QR`, `إعادة محاولة الإرسال`, and `تحتاج إلى مراجعة`.
- [ ] Run `npm run build:admin`; expect PASS.
- [ ] Commit: `feat(admin): manage JoFotara documents from orders`.

### Task 10: Carry accepted QR into 80mm receipt reprints

**Files:** `backend/services/ReceiptPresentation.js`, `backend/services/ReceiptPresentationSources.js`, `assets/js/composables/receiptPrint.js`, `src/print/PrintReceiptApp.vue`.

- [ ] Add receipt-presentation tests proving no QR field for unsent/rejected documents and exact QR text for accepted documents.
- [ ] Add optional `jofotara: { status: 'accepted', uuid, qrText }` to the immutable presentation source when an accepted document exists.
- [ ] Pass the optional block through `buildReceiptPayload` and render one high-contrast QR near the 80mm receipt footer with an accessible fallback document UUID.
- [ ] Do not add A4 output; this project’s operational target is 80mm thermal.
- [ ] Run focused receipt tests and `npm run build:admin`; expect PASS.
- [ ] Commit: `feat(print): include accepted JoFotara QR`.

### Task 11: Final reconciliation and deployment proof

- [ ] Run the modifier prerequisite tests first, then all JoFotara unit/integration tests, schema drift validation, and the admin build.
- [ ] Execute fixtures covering discounts, inclusive tax, mixed rates, service charge, new and legacy priced modifiers, zero-price modifiers, bundle parents, Arabic buyer names, and multiple partial refunds. Assert every legal payable equals the stored POS sale/refund total.
- [ ] Inspect logs from accepted/rejected/timeout fixtures and search for configured client/secret values; expect zero matches.
- [ ] Apply the migration twice on a disposable database; the second application must be harmless.
- [ ] Document deployment order: database migration, backend deployment, admin build deployment, settings entry, one real low-value invoice, QR reprint, then one real return if operationally approved.
- [ ] Commit: `docs(jofotara): add deployment verification`.

## Deferred Until There Is a Real Requirement

- Automatic checkout submission: reuse `submitSalesInvoice` from a post-commit worker; add its setting only then.
- Government status reconciliation for `unknown`: add only when JoFotara supplies a supported lookup/reconciliation endpoint.
- Receivable invoice type `022`: add with a real customer-credit workflow.
- Official `O` zero-rated products: add a product tax-category field and freeze it on `order_items` before submission.
- Buyer NIN/PN/TN administration: add when identified/high-value invoices are required.
