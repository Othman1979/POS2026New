# Manual JoFotara for Subscriptions and Platforms - Design

## Decision

Subscription purchases and finalized platform orders are eligible JoFotara sales, but they are never submitted automatically. They may be submitted only by an administrator acting in JoFotara Operations.

The automatic checkout allowlist remains ordinary register checkout and completed table checkout. Subscription activation, subscription collection, subscription redemption, platform held-order close, platform remittance, remittance allocation, commission, adjustment, reversal, and background recovery must never initiate a subscription or platform submission.

## Subscription fiscal model

- A paid subscription purchase is a cash invoice candidate when the purchase invoice is finalized.
- A pay-later subscription purchase is a receivable invoice candidate when the subscription is activated, not when it is collected.
- A collection changes only the receivable balance.
- A redemption changes only subscription credits.
- A cancellation/refund creates a saved refund against the purchase invoice.
- JoFotara Operations requires the original invoice to be accepted before its return can be submitted.
- An admin-granted subscription without `purchase_invoice_id` is non-financial and never becomes a JoFotara candidate.

## Platform fiscal model

- Each platform held order becomes one receivable invoice candidate when it is finalized with `payment_method='platform'`.
- Platform fiscal classification is based only on the finalized `orders.payment_method`, never on `order_type_id` or `order_types.is_deferred_settlement` by itself.
- If a cashier restores an individual Talabat/Careem hold and completes ordinary cash/card/split checkout, it is a standard register invoice and follows the existing automatic JoFotara policy.
- Only the bulk provider “close and print” settlement path finalizes those held orders with `payment_method='platform'`, making them Operations-only candidates.
- The diner is the buyer represented by the frozen order customer fields; the provider remains the order channel.
- A monthly remittance settles platform receivables and creates no JoFotara document.
- Commission, fees, penalties, incentives, reimbursements, corrections, allocations, and remittance reversals create no JoFotara sales document.
- A genuine saved customer refund creates a return candidate against its specific accepted platform invoice.

## Operations-only enforcement

The backend classifies source kind from authoritative database relationships:

- `subscription`: `customer_subscriptions.purchase_invoice_id = orders.invoice_id`
- `platform`: `orders.payment_method = 'platform'` (not merely a deferred-settlement order type)
- `standard`: every other supported finalized sale

The Operations submission routes pass an explicit trusted submission surface. Order and subscription pages cannot submit special-source invoices or returns. Client-supplied source labels are never trusted.

Because submission may occur days later, every invoiced subscription purchase and finalized platform order freezes buyer name, phone, and address on `orders` at finalization. JoFotara prefers that frozen snapshot and uses the joined customer row only for legacy rows that predate the migration. The migration backfills existing special-source orders from their currently linked customer once, so later customer edits cannot change their fiscal XML.

The background recovery query retains explicit subscription and platform exclusions for both missing-document and pending-document branches. Manual rejected/pending work stays visible, but only a new administrator action may retry it.

## Operations interface

Operations shows source kind, provider, invoice date, gross total, status, and error. Administrators can filter and select eligible rows. A batch action is a client-side sequence over the existing idempotent one-document Operations endpoint; it is not a scheduler or a new queue. Each result remains independent.

Accepted and unknown documents cannot be selected. A batch never retries an accepted or unknown document. Later acceptance never automatically reprints a receipt.

## Partial subscription cancellation dependency

An activated receivable subscription may be cancelled with a reduced amount still owed. The financial workflow must first persist an exact partial refund and recompute the outstanding balance as:

`max(0, original invoice total - saved refunds - net collections)`

That work is isolated in a preceding plan. JoFotara reads the resulting original invoice and refund; it does not calculate cancellation values.

## Explicit non-goals

- No automatic subscription or platform submission.
- No JoFotara document for collections, redemptions, remittances, or provider adjustments.
- No monthly aggregate platform invoice.
- No commission deduction from customer invoice totals.
- No automatic receipt reprint after later acceptance.
- No generic integration framework, fiscal queue, or new JoFotara document table.
