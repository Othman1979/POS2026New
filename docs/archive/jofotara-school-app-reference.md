# Historical school-app JoFotara reference

This is an archived example, not instructions for POSApp. Its claims of live acceptance refer to the source school's integration and have not been revalidated here. Use skills/jofotara-invoice-integration/SKILL.md and current POS source/tests for implementation.

Known differences: POSApp preserves document UUID/XML across attempts, requires explicit acceptance plus a QR, serializes quantities and amounts to six decimals, and supports partial returns and income profiles. Do not copy this example's per-submission UUID generation, two-decimal quantities, HTTP-success fallback, or disk-archive assumptions into POSApp. Sections below are retained only for historical comparison; references to fixed/mandatory behavior describe the old example, not newly verified protocol requirements.

Extracted from a production integration accepted by the live JoFotara API
(`school-invoice-app/backend/services/jofotara.service.js`). Scope: single company,
sales invoices (فاتورة مبيعات) and their credit notes. Income receipts/vouchers excluded.

Everything marked **[overridable]** is a default from the reference implementation
(`school_app` MySQL DB) — rename/replace freely in your own system. XML element names,
attribute values, and code lists are **fixed by JoFotara** and must not change.

---

## 1. Transport & Auth

One endpoint, one verb, two static headers. No OAuth, no session, no signing.

```
POST https://backend.jofotara.gov.jo/core/invoices/
Client-Id:     <jofotara_user_id>      (issued by ISTD portal)
Secret-Key:    <jofotara_secret_key>   (issued by ISTD portal)
Content-Type:  application/json

{"invoice": "<base64 of the UTF-8 UBL XML>"}
```

Node example (the exact production pattern):

```js
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);
const response = await fetch('https://backend.jofotara.gov.jo/core/invoices/', {
  method: 'POST',
  headers: { 'Client-Id': clientId, 'Secret-Key': secretKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') }),
  signal: controller.signal
});
const body = JSON.parse(await response.text()); // may also be plain text on errors — try/catch
clearTimeout(timeout);
```

- Timeout: 30 s. The API can be slow; do not retry blindly on timeout (the invoice may have landed).
- Never log Secret-Key. Mask it (`ab****yz`) in any diagnostics.

### Credentials checklist (obtained once from the ISTD JoFotara portal per income source)

| Credential | Where it goes | Reference column [overridable] |
|---|---|---|
| Client-Id | HTTP header | `jofotara_configs.jofotara_user_id` |
| Secret-Key | HTTP header | `jofotara_configs.jofotara_secret_key` |
| Income source sequence (TSP, تسلسل مصدر الدخل) | XML: `SellerSupplierParty/Party/PartyIdentification/ID` | `jofotara_configs.jofotara_tsp` |
| Seller tax number (الرقم الضريبي) | XML: `AccountingSupplierParty/PartyTaxScheme/CompanyID` | `company_settings.tax_number` |
| Seller registered name | XML: `PartyLegalEntity/RegistrationName` | `company_settings.institution_name` |

---

## 2. Invoice Type Code Matrix

`<cbc:InvoiceTypeCode name="NNN">CCC</cbc:InvoiceTypeCode>` — the **value** is the document
kind, the **name attribute** is the tax-track/payment variant:

| Document | value (code) | name attr | Notes |
|---|---|---|---|
| Sales invoice, cash (نقدية) | `388` | `012` | VAT per line |
| Sales invoice, receivable/credit (ذمم) | `388` | `022` | VAT per line; only the name differs |
| Sales credit note (return, إشعار دائن) | `381` | `012` | adds `BillingReference` |
| (out of scope) income cash invoice | `388` | `011` | no per-line VAT |

Reference implementation picks `012` vs `022` from a per-invoice payment-type flag
(`trans.vchr_type = 'CASH' | 'CREDIT'` [overridable]); the code stays `388` for both.

Other fixed code lists:
- `PaymentMeansCode listID="UN/ECE 4461"`: `10` = cash (default), `42` = bank transfer.
- Tax category `schemeID="UN/ECE 5305"`: `S` = standard VAT (with `<cbc:Percent>`), `Z` = zero-rated, `E` = exempt.
- Customer ID `schemeID`: `TN` = tax number (default), `NAT` = national ID.

---

## 3. Standard Sales Invoice XML (annotated template)

Production-accepted shape. `{placeholders}` show the source value; see §4 for the field map.
Formatting rules: **amounts `toFixed(9)`**, quantities `toFixed(2)`, percents `toFixed(2)`,
dates `YYYY-MM-DD`. XML-escape every interpolated value (`& < > " '`). UTF-8; Arabic is fine.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>{invoice number, e.g. INV-001}</cbc:ID>
  <cbc:UUID>{fresh random UUID v4, generated per submission}</cbc:UUID>
  <cbc:IssueDate>{sale date YYYY-MM-DD}</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="012">388</cbc:InvoiceTypeCode>   <!-- 012 cash / 022 credit -->
  <cbc:Note>{free-text note, may be empty or Arabic}</cbc:Note>
  <cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>{ICV: NUMERIC invoice counter/sequence — never a UUID or doc-no string}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>          <!-- the seller (you) -->
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>{seller tax number}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>{seller registered name}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>          <!-- the buyer -->
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="TN">{customer number / tax no; "-" for walk-in}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:PostalZone/>                              <!-- value optional; empty accepted -->
        <cbc:CountrySubentityCode/>                    <!-- empty element accepted in prod -->
        <cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>{customer number again}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>{customer name; "Cash customer" for walk-in}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
    <cac:AccountingContact><cbc:Telephone/></cac:AccountingContact>
  </cac:AccountingCustomerParty>
  <cac:SellerSupplierParty>              <!-- income source sequence (TSP) -->
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID>{income source sequence / TSP}</cbc:ID>
      </cac:PartyIdentification>
    </cac:Party>
  </cac:SellerSupplierParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>
  </cac:PaymentMeans>
  <cac:AllowanceCharge>                  <!-- document-level: SUM of all line discounts -->
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="JO">{Σ line discounts, 9dp}</cbc:Amount>
  </cac:AllowanceCharge>
  <cac:TaxTotal>                         <!-- document-level total VAT -->
    <cbc:TaxAmount currencyID="JO">{Σ line tax amounts, 9dp}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="JO">{Σ gross (qty×price, BEFORE discount), 9dp}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="JO">{TaxExclusive − discounts + tax, 9dp}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="JO">{Σ line discounts, 9dp}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="JO">{Σ line net totals, 9dp}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <!-- one InvoiceLine per item row -->
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>                   <!-- 1-based line index -->
    <cbc:InvoicedQuantity unitCode="PCE">{qty, 2dp}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="JO">{max(qty×price − discount, 0), 9dp}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="JO">{line tax, 9dp}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="JO">{line net total = lineExtension + tax, 9dp}</cbc:RoundingAmount>
      <cac:TaxSubtotal>
        <cbc:TaxAmount currencyID="JO">{line tax again, 9dp}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">{S if tax>0 else Z}</cbc:ID>
          <cbc:Percent>{tax rate %, 2dp — e.g. 16.00; Z lines emit 0.00}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>{item name}</cbc:Name></cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="JO">{unit price, 9dp}</cbc:PriceAmount>
      <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason>
        <cbc:Amount currencyID="JO">{line discount, 9dp}</cbc:Amount>
      </cac:AllowanceCharge>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>
```

Currency quirk (verified in production): line/total amounts use `currencyID="JO"` while the
document currency codes are `JOD`. Keep it exactly like this.

Template invariants (what production always does — deviate at your own risk):
- **Element order is exactly as shown** — keep it; UBL is order-sensitive.
- `unitCode` is always `PCE`; other UN/ECE unit codes were never exercised.
- `<cbc:Note>` is always emitted, even when empty.
- `TaxSubtotal` intentionally has **no** `TaxableAmount` (unusual for UBL 2.1 — a generic UBL
  validator may flag it, but this exact shape is what JoFotara accepts).
- Walk-in customer: `cbc:ID` and `CompanyID` = `-`, `schemeID` stays `TN`, name `Cash customer`.
- The document-level `AllowanceCharge` is emitted even when total discount is `0.000000000`.
- Tax `Percent` is *derived* (`tax / lineExtension × 100`, 2 dp) — this derived value has always
  been accepted alongside the stated amounts.

---

## 4. Field Map — XML ⇄ source data

Reference source columns are from `school_app` (tables `co_<id>_trans` header +
`co_<id>_trans_items` lines). **All [overridable]** — map to your POS's own fields;
the "Meaning" column is the contract.

### Header (one row per invoice — `trans` [overridable])

| XML target | Meaning | Reference column |
|---|---|---|
| `cbc:ID` | Invoice number (unique per company) | `trans.doc_no` |
| `cbc:UUID` | Random UUID v4 minted at submission time | generated, not stored beforehand |
| `cbc:IssueDate` | Sale date | `trans.sale_date` |
| `cbc:Note` | Free-text note | `trans.note` |
| ICV `cbc:UUID` | Numeric submission counter | `trans.z_no` / `trans.ano`, fallback timestamp |
| `InvoiceTypeCode@name` | `012` cash / `022` credit | `trans.vchr_type` (`CASH`/`CREDIT`) |
| Customer `cbc:ID` + `CompanyID` | Customer/tax number, `-` if none | `trans.cust_no` |
| Customer `RegistrationName` | Customer name, `Cash customer` if none | `trans.cust_name` |

### Lines (one row per item — `trans_items` [overridable])

| XML target | Meaning | Reference column |
|---|---|---|
| `cbc:InvoicedQuantity` | Quantity (>0, default 1) | `trans_items.qty` |
| `cbc:PriceAmount` | Unit price before tax/discount | `trans_items.unit_price` |
| Line `AllowanceCharge/Amount` | Discount amount for the line | `trans_items.discount` |
| Line `TaxAmount` | VAT amount for the line | `trans_items.tax` |
| Line `RoundingAmount` | Line net total incl. tax | `trans_items.net_total` |
| `cac:Item/cbc:Name` | Item description | `trans_items.item_name` |

### Line math (compute exactly this)

```
grossAmount         = qty × unitPrice
lineExtensionAmount = max(grossAmount − discount, 0)
taxAmount           = stored tax  (or infer: netTotal − lineExtension when netTotal > lineExtension)
netTotal            = stored net  (or lineExtension + taxAmount)
taxRate%            = lineExtension > 0 && tax > 0 ? tax / lineExtension × 100 : 0
taxCategory         = taxAmount > 0 ? 'S' : 'Z'
```

Document totals: `TaxExclusive = Σ gross`, `AllowanceTotal = Σ discount`, `TaxTotal = Σ tax`,
`TaxInclusive = TaxExclusive − Allowance + Tax`, `Payable = Σ netTotal` (fallback TaxInclusive).

---

## 5. Settings / config shape [overridable]

The reference stores one config row per credential set (`jofotara_configs`) and points the
company at it. For a single-company POS, a flat config object/env file is enough:

| Setting | Default | XML/HTTP target |
|---|---|---|
| `client_id` | — (required) | `Client-Id` header |
| `secret_key` | — (required) | `Secret-Key` header |
| `tsp` (income source seq) | — (required) | `SellerSupplierParty…cbc:ID` |
| `tax_number` | — (required) | supplier `PartyTaxScheme/CompanyID` |
| `seller_name` | — (required) | supplier `RegistrationName` |
| `endpoint` | `https://backend.jofotara.gov.jo/core/invoices/` | POST URL |
| `invoice_type_code` | `388` | `InvoiceTypeCode` value |
| `invoice_type_name` | `012` (cash) / `022` (credit) | `InvoiceTypeCode@name` |
| `return_type_code` / `_name` | `381` / `012` | credit-note type code |
| `payment_means_code` | `10` | `PaymentMeansCode` |
| `customer_id_scheme` | `TN` | customer `cbc:ID@schemeID` |
| `postal_zone` | empty (omit or `<cbc:PostalZone/>`) | customer address |
| `zero_tax_category` | `Z` | tax category when no VAT |
| `default_return_reason` | e.g. `ارجاع فاتورة` | credit-note reason fallback |
| `send_to_api` | `true` | dry-run switch (§9) |
| `timeout_ms` | `30000` | request timeout |

---

## 6. Local persistence you SHOULD keep [overridable]

Three columns on the invoice record (reference: on `trans`):

| Column | Type | Purpose |
|---|---|---|
| `qr_status` | TINYINT | `1` = accepted by JoFotara, `0` = not sent / rejected |
| `qr_text` | TEXT | QR string returned by JoFotara — **must be printed on the invoice** |
| `qr_response` | TEXT | Full raw JSON response + your request metadata. Source of truth; needed for credit notes |

Also save every submitted XML to disk (`data/jofotara/<invno>-<timestamp>.xml` in the
reference) — audit trail + UUID recovery for returns.

Stored `qr_response` shape used by the reference:

```json
{
  "attempted": true, "ok": true, "status": 200,
  "body": { "EINV_STATUS": "SUBMITTED", "EINV_QR": "..." },
  "requestMetadata": {
    "invoiceKind": "standard",
    "invoiceId": "INV-001",
    "invoiceUuid": "<the UUID v4 you generated>",
    "invoiceTypeName": "012", "invoiceTypeCode": "388",
    "documentTotal": 116.0,
    "xmlFile": "INV-001-2026-06-20T10-30-00-000Z.xml"
  }
}
```

---

## 7. Response parsing (defensive — field names vary by environment)

Success decision, in order (any rejection short-circuits):

1. HTTP not ok → **rejected**
2. `body.EINV_RESULTS.status === "ERROR"` → rejected
3. `body.EINV_STATUS` matches `/NOT_SUBMITTED|ERROR|REJECT/i` → rejected
4. `body.EINV_RESULTS.ERRORS` non-empty array → rejected
5. `body.EINV_STATUS` matches `/SUBMITTED|ACCEPT|PASS|SUCCESS/i` → **accepted**
6. `body.EINV_RESULTS.status` matches `/PASS|SUCCESS|ACCEPT/i` → accepted
7. Fallback: HTTP ok

Extraction (walk the whole JSON recursively — nesting depth varies):
- **QR string**: first non-empty string under any key matching `/qr/i` (commonly `EINV_QR`).
- **Government UUID**: exact keys `EINV_INV_UUID`, `EINV_UUID`, `INV_UUID`, `INVOICE_UUID`,
  `invoiceUuid`, `invoiceUUID`; else any `/uuid/i` key (not `/qr/i`) whose value matches the
  RFC 4122 pattern.

**Idempotency rule:** before submitting, check your stored response — if the invoice was already
accepted, return the stored result and DO NOT resubmit (each send mints a new UUID = a new legal
document, and a rejected retry would overwrite your proof of acceptance).

---

## 8. Returning an invoice (credit note / sales return, إشعار دائن)

**Scope guard: this section is for returning a SALES INVOICE only.** Receipt/income-voucher
returns are a different flow (different XML builder without per-line tax, different config,
`RV_` file prefix) and are **out of scope** for this skill — do not apply this section to
receipts, and do not apply receipt-return docs to invoices.

A return is a **new document** submitted to the same endpoint with the same auth (§1). It is not
an edit or a delete — the original invoice stays on record; the return offsets it.

### 8.1 Prerequisites

You need three facts about the **original invoice**, and it must have been **accepted** first:

| Needed | Where it goes | How to get it |
|---|---|---|
| Original invoice number | `BillingReference…cbc:ID` | your DB |
| Original invoice UUID | `BillingReference…cbc:UUID` | see resolution order below |
| Original payable total | `BillingReference…cbc:DocumentDescription` (9 dp) | your DB or the saved XML |

The UUID is the `<cbc:UUID>` **of the original accepted submission** (the UUID v4 you minted
when you sent it). Resolution order used in production:

1. **Saved original XML file on disk** — read `<cbc:UUID>` from it. Skip files that are
   themselves returns (type code `381` or containing `<cac:BillingReference>`).
2. **Stored response metadata** — `qr_response.requestMetadata.invoiceUuid` (§6).
3. **Manual input** — let the user paste the UUID.
4. Last resort: a UUID extracted from the stored response body via the §7 UUID keys — this is
   the only thing the "government UUID" extraction is for.

If none resolve: **fail** with "send the original invoice to JoFotara first, or enter the
original UUID manually". Never submit a return with a guessed/fresh UUID in `BillingReference`.

### 8.2 Return record in your DB [overridable]

The reference creates a local row for the return before submitting:

- New doc number: `R_<original invno>` (strip any existing `R_`/`R-` prefix first, so a
  re-return doesn't become `R_R_…`). User-overridable. Saved XML file: `R_<invno>-<timestamp>.xml`.
- Marked as a return: `vchr_type = 'INCOME_RETURN'`, with `original_invno = <original doc_no>`.
  (The `INCOME_RETURN` label is a historical local marker in the reference DB — it marks sales
  invoice returns too. Any distinct marker works in your system [overridable]; it never goes
  into the XML.)
- Line items copied from the original invoice's lines (qty, price, discount, tax, net).
- **Idempotent creation**: if a row with that doc-no + return marker already exists, reuse its
  rows — do not insert twice.
- The return's own `qr_status` / `qr_text` / `qr_response` are stored on the RETURN row, with
  `requestMetadata.invoiceKind = "income-return"` plus `originalInvoiceId`, `originalInvoiceUuid`,
  `originalDocumentTotal`, and `returnReason`.

A return **reason** is required (`InstructionNote`); fall back to a configured default
(e.g. `ارجاع فاتورة`) when the user gives none.

### 8.3 Return line math (differs slightly from §4)

```
quantity            = qty > 0 ? qty : 1
unitPrice           = unit_price > 0 ? unit_price : line net_total   ← fallback differs from §4
lineExtensionAmount = max(quantity × unitPrice − discount, 0)
taxAmount           = stored tax (NO inference from net totals)
netTotal            = stored net_total (or lineExtension + tax)
taxRate%            = lineExtension > 0 ? tax / lineExtension × 100 : 0
taxCategory         = taxRate > 0 ? 'S' : 'Z'
```

Document totals for returns — **all amounts stay POSITIVE** (the type code `381` is what makes
it a credit; do not negate anything):

```
TaxExclusiveAmount   = Σ gross (qty × unitPrice)
AllowanceTotalAmount = Σ discounts
PayableAmount        = Σ (lineExtension + tax)
TaxInclusiveAmount   = PayableAmount            ← note: NOT the §4 formula
document TaxAmount   = Σ line taxes
```

### 8.4 Complete return XML template (production-accepted)

Same formatting rules as §3 (9-dp amounts, `currencyID="JO"`, element order load-bearing).
Differences from the standard invoice are marked `<-- RETURN`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>{return doc number, e.g. R_POS-1001}</cbc:ID>
  <cbc:UUID>{fresh random UUID v4 for the RETURN itself}</cbc:UUID>
  <cbc:IssueDate>{return date YYYY-MM-DD}</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="012">381</cbc:InvoiceTypeCode>          <!-- RETURN: 381; name comes from
       config return_type_name (default 012) — production does NOT mirror a 022 original -->
  <cbc:Note>{original invoice's note if non-empty, ELSE the return reason, ELSE default reason}</cbc:Note>
  <cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>
  <cac:BillingReference>                                             <!-- RETURN: link to original -->
    <cac:InvoiceDocumentReference>
      <cbc:ID>{original invoice number}</cbc:ID>
      <cbc:UUID>{original ACCEPTED submission's UUID}</cbc:UUID>
      <cbc:DocumentDescription>{original payable total, 9dp}</cbc:DocumentDescription>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>{numeric counter — the return has its OWN ICV}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <!-- identical to §3: seller tax number, VAT scheme, RegistrationName -->
  </cac:AccountingSupplierParty>
  <!-- RETURN: customer party — copy the ENTIRE <cac:AccountingCustomerParty> block VERBATIM
       from the original submitted XML when available (preserves exactly what the government
       accepted). Fallback when the original XML is gone: -->
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:SellerSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID>{income source sequence / TSP}</cbc:ID></cac:PartyIdentification>
    </cac:Party>
  </cac:SellerSupplierParty>
  <cac:PaymentMeans>
    <!-- same configured payment_means_code as forward invoices (default 10) — not per-original -->
    <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>
    <cbc:InstructionNote>{return reason — REQUIRED}</cbc:InstructionNote>   <!-- RETURN -->
  </cac:PaymentMeans>
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="JO">{Σ line discounts, 9dp}</cbc:Amount>
  </cac:AllowanceCharge>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="JO">{Σ line taxes, 9dp}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="JO">{Σ gross, 9dp}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="JO">{= PayableAmount, 9dp}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="JO">{Σ discounts, 9dp}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="JO">{Σ (lineExtension + tax), 9dp}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <!-- Lines: IDENTICAL structure to §3 including the per-line <cac:TaxTotal> block
       (TaxAmount, RoundingAmount, TaxSubtotal with S/Z category and Percent). -->
  <cac:InvoiceLine> … </cac:InvoiceLine>
</Invoice>
```

Submission, response parsing, QR extraction, and storage are identical to §§1, 6–7. The return
gets its own QR string to print.

### 8.5 Return pitfalls

- Wrong UUID in `BillingReference` (the doc number, a fresh UUID, or the QR string) → rejection.
  It must be the original submission's accepted `<cbc:UUID>`.
- Negating amounts — everything stays positive; `381` carries the meaning.
- Omitting `InstructionNote` — the reason is required on returns.
- Rebuilding the customer block from your DB when you still have the original XML — copy it
  verbatim instead; a drifted customer block can mismatch what was accepted.
- The reference implementation's idempotency guard covers only the DB row creation, **not**
  re-submission of an already-accepted return — add the same accepted-check (§7) before
  re-sending a return.
- Do not reuse the return flow for receipts — that is a separate document family (income track)
  with different XML and is out of this skill's scope.

---

## 9. Dev/test mode & pitfalls

- **Dry run**: gate the POST behind a `send_to_api` flag (env `JOFOTARA_SEND_TO_API=false` in the
  reference). XML is still built and saved to disk — lets you eyeball output without credentials.
- Missing Client-Id/Secret-Key → skip the POST and surface a clear config error, don't send.
- Validate before sending; warn on: empty seller tax number, empty TSP, no lines, no customer name.
- The API sometimes returns plain text instead of JSON — `try { JSON.parse } catch` and keep raw.
- Response `EINV_STATUS` etc. appear in UPPER or lower case depending on environment — check both.
- Timeout ≠ rejection: the document may have been accepted; check before resubmitting.

## 10. Known limits of this reference (honest unknowns)

- **No government sandbox** is known — the only test mode is the local dry-run flag above.
- **ICV**: production sends a per-invoice numeric sequence with a `Date.now()` fallback; strict
  monotonicity was never enforced and never caused a rejection. Treat it as "any positive number,
  ideally an increasing counter".
- **Rejection payloads** are not standardized: expect `EINV_RESULTS.ERRORS` as an array of
  objects with message text, but shapes vary — store the raw body and show it to a human.
- **`E` (exempt) tax category** is defined in the code lists but was never sent in production;
  only `S` and `Z` are battle-tested.
- **Field length/charset limits** are unpublished; production has sent Arabic names, hyphens,
  and `-` placeholders without issue.
- **QR string**: opaque encoded value — render it as a QR code verbatim; do not decode/re-encode.
- Only **JOD** documents are covered.
- **Partial returns were never exercised** — production always returns the full original line set.
  A partial-quantity return would presumably reduce the line quantities/amounts while keeping
  `DocumentDescription` = the original's full total, but this is unverified against JoFotara.
- **Return `name` attribute for `022` (credit/receivable) originals**: production always sent the
  configured `return_type_name` (`012`); a `022`-named return was never exercised.
