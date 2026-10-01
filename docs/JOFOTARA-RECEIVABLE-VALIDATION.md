# JoFotara Subscription Receivables

Status: subscription pay-later is available whenever subscriptions are enabled. It is not controlled by JoFotara settings.

## Proven locally and by the production reference

- Sales-tax receivable invoice: `InvoiceTypeCode` value `388`, name `022`.
- Sales-tax return: value `381`, configured return name `012`, with the accepted original UUID in `BillingReference`.
- Income-tax cash and return behavior remain `011`; sales-tax cash remains `012`.
- Receivable snapshots require a named buyer and retain the explicit payment terms in the legal snapshot.
- JoFotara has no known public sandbox. Timeout or unknown submission results must not be retried blindly.

## Not production-validated here

- Income-tax receivable name `021` is represented behind the disabled feature gate but is not covered by the production-verified reference.
- The minimum buyer shape accepted by the restaurant's JoFotara account has not been tested live. The implementation uses the existing accepted placeholder identifier plus frozen buyer name, phone, and address.

## Submission policy

Subscription invoices never submit automatically. A receivable subscription appears in JoFotara Operations only after collections and saved refunds reduce its outstanding balance to zero. Each partial collection remains a separate immutable, shift-owned ledger row and does not create another sale or invoice.

Before the first real submission for a tax profile, inspect one sanitized XML document and perform the controlled live verification described below. An unfamiliar or rejected response must remain unresolved in Operations; it must never be treated as accepted.

## Validation record

No production validation recorded yet.
