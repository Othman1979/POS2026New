# Receipt and Display Consistency Design

**Date:** 2026-07-11
**Status:** Owner-approved design; implementation is not authorized by this document alone

## Goal

Make every POS money presentation tell the same truthful story without changing any
charged or persisted amount. Live cart rows, guest checks, held orders, split checks,
checkout receipts, duplicate customer copies, Order Notes, admin previews, A4 and
delivery documents, database reprints, and physical spooler output must use one explicit
presentation contract.

## Non-Goals

- Do not change ordinary checkout, table-save, split-settle, refund, service-charge, or
  tax formulas. The approved lifecycle corrections freeze both tax mode and each
  durable line's tax rate: an order that spans a settings or catalog change keeps the
  mode and rates captured when its financial state first became durable.
- Do not change catalog base prices or the service-charge snapshot lifecycle.
- Do not implement the deferred tax-exempt sale contract.
- Do not repair corrupt bundle parents; bundle corruption recovery remains separate.
- Do not rewrite historical sale money after refunds or voids.
- Do not remove legacy receipt payload fields during the compatibility window.

## Owner-Approved Presentation Policy

### Net financial rows

Receipt and ordered-cart financial rows display net line amounts after item-level
discounts but before order-level discount and tax. Financial row amounts sum to the
displayed Subtotal. Tax is stated once in the summary.

The `Unit Price` column remains the frozen pre-item-discount unit price. The `Amount`
column is the line net. A discounted line gets an explanatory subline:

- fixed per-unit: `Item discount: -4.00 JD (2.00 x 2)`;
- percentage: `Item discount: -5.00 JD (25%)`.

### Order discount

Always show the actual money deducted. Preserve the rule as supporting context:

- percentage: `Discount: -3.20 JD (20%)`;
- fixed: `Discount: -3.00 JD`.

No renderer may interpret an ambiguous `discount` field on its own.

### Tax modes

- Exclusive pricing shows the frozen/stored tax amount.
- Inclusive pricing shows `Tax: Included in prices` and does not invent an embedded tax
  amount. The current calculator deliberately persists order tax as zero in this mode.
- A legacy order whose tax mode is unknown and whose stored tax is zero shows
  `Tax: 0.00 JD`; it must not be labelled tax-inclusive based on today's setting.

### Product cards

Catalog product cards remain customer-facing, tax-inclusive menu prices. In
exclusive-tax mode they receive an explicit `incl. tax` label. Ordered-cart rows and
receipts use the net accounting presentation above. This design does not change catalog
price authority.

### Precision and rounding

Every surface in this scope displays JD amounts to two decimals, matching charged and
persisted order headers.

Displayed financial-row cents are deterministically apportioned so their exact sum
equals the displayed Subtotal. A residual between authoritative header fields is never
hidden by altering stored tax or discount. When non-zero, show an explicit
`Rounding: +0.01 JD` or `Rounding: -0.01 JD` row so:

```text
Subtotal - Order Discount + Tax + Rounding = Total
```

### Bundles, service charges, refunds, and voids

- A bundle parent is the financial row. Bundle children are indented descriptive rows
  with no price or contribution to row-cent allocation.
- A service charge remains a normal financial row and follows the same item rules.
- A receipt reprint reproduces the original sale money. Later refund/void state is
  metadata such as `VOIDED` or `PARTIALLY REFUNDED`; it does not rewrite line money into
  remaining values.

## Canonical Presentation Model

Every new renderer consumes the versioned model below. Numeric fields are finite
numbers, not preformatted strings. Renderers apply the model's `decimals` value and do
no financial arithmetic.

```javascript
{
  version: 1,
  currency: 'JD',
  decimals: 2,
  taxMode: 'exclusive' | 'inclusive' | 'legacy_unknown',
  status: 'original' | 'voided' | 'partially_refunded' | 'fully_refunded',
  rows: [{
    key: 'stable-display-key',
    kind: 'item' | 'bundle_child',
    name: 'Burger',
    note: 'No onion',
    qty: 2,
    unitPrice: 10,
    extendedPrice: 20,
    lineDiscountAmount: 4,
    lineDiscountLabel: '2.00 x 2',
    netAmount: 16
  }],
  summary: {
    subtotal: 16,
    orderDiscountAmount: 3.2,
    orderDiscountLabel: '20%',
    taxAmount: 2.05,
    taxLabel: null,
    roundingAdjustment: 0,
    total: 14.85
  }
}
```

For inclusive pricing, `summary.taxAmount` is zero and `summary.taxLabel` is
`Included in prices`. For legacy-unknown pricing, `summary.taxLabel` is null.

### Row-cent apportionment

1. Compute each financial row's raw net from its frozen unit price, quantity, and line
   discount.
2. Convert raw nets to exact decimal cents without using display strings as inputs.
3. Round each financial row to cents.
4. Compare the row-cent sum with the authoritative Subtotal cents.
5. Distribute the difference deterministically by descending fractional remainder;
   ties use stable input order.
6. Exclude bundle-child rows from the allocation.
7. Reject a target that cannot be reconciled without making a row negative or changing
   the row sum by more than the mathematically possible rounding residue.

Raw line-net arithmetic must use the same operation order as production
`calculateLineTotal`/frontend `lineNet`, especially percentage discounts. Algebraic
equivalence is insufficient at binary floating-point half-cent boundaries.

The apportionment is presentation-only. It cannot write to orders, order items, held
orders, refunds, or snapshots.

## Authority and Data Flow

### Frontend-authoritative provisional flows

The live cart and browser guest check build the model from a frozen cart snapshot and
the existing `posTotals` result. A new direct cart uses the current global mode. A cart
restored from an open table or split uses that financial lifecycle's frozen mode. An
ordinary register hold is a provisional cart: its parked preview retains the hold-time
mode, but restoration adopts the current mode and visibly recomputes before payment.
These flows are explicitly provisional. The guest-check payload carries both raw
compatibility fields and the presentation model.

### Backend-authoritative finalized flows

A successful checkout response includes a backend-built presentation model derived
from server-pinned prices, authoritative current or lifecycle-frozen tax rates,
normalized discounts, and finalized totals. The POS browser receipt must consume this
model rather than recalculating from the client cart snapshot.

Numeric invoice prints, duplicate customer copies, and database reprints reload
`orders` and `order_items`. Any client-supplied presentation model is discarded.

If a pre-v1 historical order cannot reconcile to exact cents, its read/reprint response
omits v1, carries an explicit legacy-reconciliation reason, and uses the existing
server-built legacy payload. This exception is limited to historical rows with no
frozen v1-era tax-context marker. The same mismatch on a new-version order fails closed
with `422 RECEIPT_PRESENTATION_INVALID`; client-supplied present-invalid v1 never enters
the historical fallback.

### Held and split flows

Held and split presentation is rebuilt server-side from persisted `cart_data`, the
frozen order discount, and server-authoritative tax-rate evidence. A split inherits
each parent `order_items.tax_rate`; an ordinary hold preview uses the rate normalized
by the server when it was parked. On ordinary-hold claim, the server reloads current
catalog rates, returns the recalculated cart, and reports whether mode, rates, or totals
changed. The ambiguous `held_orders.subtotal` field is not a display authority.
Unvalidated client-carried tax rates are never trusted.

The held/split list APIs return the presentation model for Order Notes and Table Splits.
The print endpoint independently rebuilds it under its authorization boundary.

### UI consumers

The following consumers render the model instead of owning money formulas:

- live ordered-cart rows in `PosTerminal.vue`;
- POS receipt preview and browser thermal print;
- standalone browser receipt app;
- Order Notes history and held previews;
- Table Splits cards, preview, and print request;
- admin invoice drawer;
- A4 receipt and delivery invoice;
- physical receipt spooler.

## Freezing Tax Mode and Durable Line Rates

Add nullable `orders.tax_inclusive_at_sale` with values `0`, `1`, or `NULL` for legacy
unknown. Freeze and consume it across the full durable lifecycle:

- a direct sale freezes the current system mode at checkout;
- an open table freezes the current system mode at first save;
- a register hold records the current mode for its parked preview only;
- split checks inherit the parent table order's frozen mode;
- open-table and split restore, edit, guest-check print, preview, and settle use the
  frozen mode for both calculation and presentation;
- ordinary register-hold restoration adopts the current system mode, visibly
  recalculates the cart, and warns the cashier when the mode or total changed;
- an existing durable order never silently switches modes after a settings change.

Per-line rates follow the same lifecycle boundary:

- an existing open-table line keeps its persisted `order_items.tax_rate` on later
  saves, previews, splits, and settlement even if the catalog rate changes;
- a line newly added to that table takes the current catalog rate when it first becomes
  durable, then keeps it;
- every split line inherits the matched parent line's persisted tax rate by
  `order_item_id`; allocation never re-resolves that rate from the catalog;
- a direct sale and a restored ordinary hold use current server-loaded catalog rates;
- an ordinary hold's parked preview uses server-normalized hold-time rates, but claim
  deliberately adopts current rates and visibly warns/recomputes when they differ.

New held and split `cart_data` carry their presentation flag. The split flag is
authoritative because it descends from the parent order; the ordinary-hold flag is
display metadata and is never accepted as checkout authority after the claim route has
deleted the hold. A legacy durable order with no flag uses the current mode once when it
is next saved/finalized, then persists that choice. The correction changes charged
money only in the previously unsafe open-table/split edge case where a durable order
spans a tax-mode setting change.

New held and split payloads also carry `tax_context_version: 1`. In that version every
financial row has a finite server-authored rate; absence or invalidity fails closed. A
payload without the version is legacy, so its client-carried catalog rate is not trusted
even when present. A legacy split first recovers rates from its referenced parent
`order_items`; only an unavailable parent falls back to current catalog data. A legacy
ordinary hold uses current catalog data. These narrow fallbacks are removed with the
legacy payload path later.

Historical inference is deliberately narrow:

- positive stored tax with a null flag is exclusive;
- zero stored tax with a null flag is `legacy_unknown`;
- never infer a historical order's mode from the current system setting.

This is an additive schema migration and does not alter any money column. Tax exemption
will receive a separate persisted contract later.

## Frontend/Backend Builder Boundary

The frontend and backend have separate runtime/module boundaries, so each gets a small
pure builder with the same input/output contract. They must share fixture vectors and a
seeded parity suite. Neither builder may import Vue, Express, the database pool, or DOM
APIs.

Adapters are responsible only for field-shape normalization:

- cart: `qty`, `price`, `discountType`, `discountValue`;
- DB: `quantity`, `price_at_sale`, `discount_type`, `discount_value`, frozen
  `tax_amount`;
- held/split: accept legacy aliases but receive authoritative totals and tax mode from
  the owning flow.

Renderers consume only the normalized model.

## Compatibility and Failure Semantics

New print payloads carry both the legacy receipt fields and `receipt_display_v1` during
one compatibility window.

- If v1 is absent, a renderer may use the legacy path. This preserves already-queued
  jobs and older stored payloads.
- If v1 is present but invalid, fail explicitly with a presentation-contract error. Do
  not fall back and silently print different money.
- An authoritative backend route rebuilds v1 and never trusts a submitted v1 object.
- A receipt rendering/printing failure after commit never converts a successful payment
  into a checkout failure.

The local physical-spooler source is intentionally git-ignored. Its v1-aware change must
be recorded in `docs/SPOOLER-CHANGES.md`, tested locally, and deployed to every print
machine. The legacy renderer remains available for pre-v1 jobs.

All user-provided strings interpolated into physical receipt HTML must be escaped,
including item names, notes, customer data, store data, and receipt configuration.

## Rollout

1. Back up the database and apply the additive `tax_inclusive_at_sale` migration.
2. Update every physical spooler to accept v1 and retain the absent-v1 legacy fallback.
3. Deploy the backend that emits authoritative v1 plus legacy fields.
4. Deploy frontend renderers that prefer v1 and retain the absent-v1 adapter.
5. Smoke-test live guest, held, split, paid, duplicate, and database-reprint receipts in
   both tax modes.
6. Submit an old queued payload and confirm it still prints through the legacy path.

Rollback is additive: older code ignores the new column and v1 field. Do not remove the
column or legacy renderer during this plan.

## Verification

### Seeded parity and coverage

Run at least 10,000 deterministic generated cases through both builders. Coverage
counters must prove—not assume—that the generator exercised:

- fixed and percentage item discounts;
- fixed and percentage order discounts;
- exclusive, inclusive, and legacy-unknown modes;
- mixed and zero tax rates;
- fractional prices and quantities;
- service-charge lines at random positions;
- bundle parents and children;
- cart, held, split, and DB aliases.

### Required invariants

- Financial `rows[].netAmount` sum exactly to `summary.subtotal` in cents.
- `subtotal - orderDiscountAmount + taxAmount + roundingAdjustment == total` in cents.
- `roundingAdjustment` equals the exact residual of authoritative fields.
- `roundingAdjustment` is at most `0.02` in absolute value; a larger residual is
  inconsistent money, not a display adjustment.
- Subtotal, tax, discount, and total are non-negative; order discount cannot exceed
  subtotal; zero-quantity rows are invalid and bundle children cannot carry money.
- No presentation builder mutates its input.
- No display operation updates a financial table or changes charged/persisted values.

### Required regressions and experiments

- Live and guest-check order discounts no longer produce gross-row footing errors.
- Inclusive guest checks never gross tax up a second time.
- Multi-quantity fixed item discounts survive held adapters.
- Split previews include the seat order discount and parent-frozen tax mode/rates.
- Numeric invoice, held, and split print routes ignore forged client presentation data.
- A settings change after sale cannot change a reprint's frozen tax-mode label.
- A settings change after table save or split cannot change that financial lifecycle's
  calculated tax or eventual receipt mode.
- A catalog tax-rate change after table save or split cannot change an existing line's
  calculated tax or eventual receipt; a line added afterward adopts the new rate once.
- A register hold created under a different mode retains an accurate parked preview,
  then warns and visibly recomputes under the current mode and rates when restored.
- Legacy zero-tax rows remain neutral.
- Original and duplicate customer receipts have identical presentation money.
- Old queued payloads render through the absent-v1 fallback.
- A present but malformed v1 payload fails closed.
- Bundle children remain descriptive and contribute zero money.
- Service-charge placement does not affect row or summary conservation.
- HTML special characters are escaped in the physical renderer.
- Browser thermal, standalone browser, Order Notes, Table Splits, admin drawer, A4,
  delivery, and physical receipt output are visually checked in English and Arabic.

Run focused tests for each task, the full Vitest suite once at the final gate, the admin
build after Vue changes, schema-drift verification after applying the test migration,
and a physical print smoke matrix.

## Risks and Defenses

- **Hidden payload ambiguity:** replace ambiguous discount interpretation with explicit
  amount and label fields in v1.
- **Historical setting drift:** freeze tax-inclusive mode at sale; legacy unknown stays
  neutral. Durable open-table/split lifecycles freeze the mode and reuse it for
  settlement. Ordinary holds remain provisional so the backend never trusts a tax mode
  that survived only in client state after claim deletion.
- **Catalog tax-rate drift:** reuse persisted `order_items.tax_rate` for existing table
  and split lines. Server-stamp that rate after identity matching; never honor a frozen
  rate supplied by an untrusted request. Ordinary holds intentionally refresh current
  rates at claim and disclose any resulting recalculation.
- **One-cent cosmetic lies:** preserve stored tax and discount; show an explicit rounding
  row, bounded to the mathematically possible two-cent summary residue.
- **Split tax tampering:** inherit the matched parent's persisted tax rate, not a client
  rate or the mutable current catalog row.
- **Old queue breakage:** absent-v1 legacy fallback remains for this plan.
- **Malformed new data being masked:** present-but-invalid v1 fails closed.
- **Renderer drift:** renderers perform formatting only; seeded builders share fixtures
  and parity checks.
- **Physical-spooler drift:** document and verify every print-machine update before web
  rollout completion. The deployed renderer is self-contained and copied beside the
  machine's `server.js`; it never imports the absent web-repository `backend/` or
  `spooler-shared/` paths.

## Acceptance Criteria

1. All named surfaces consume `receipt_display_v1` for new flows.
2. Every displayed financial row and summary foots exactly under the approved policy.
3. Paid and historical money remains byte-identical in the database.
4. Inclusive tax is labelled only when frozen evidence exists.
5. Existing open-table/split lines retain persisted rates across catalog changes; new
   lines and restored ordinary holds use current server rates at their defined boundary.
6. Duplicate and database reprints reproduce original sale presentation money.
7. Legacy queued receipts still print; malformed v1 does not silently downgrade.
8. Physical and browser receipts agree for the same order.
9. The seeded parity suite, focused suites, full suite, build, migration checks, and
   physical smoke matrix all pass.
10. Exact-cent mismatches remain readable only through the explicit pre-v1 historical
    fallback; the same mismatch on a new-version order fails closed.
