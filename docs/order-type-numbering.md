# Daily order numbers by type

In **Settings → General**, enable **Separate order numbers by order type**. It is off by default, preserving the shared daily number sequence.

When enabled, the first configured order type uses `A-1`, `A-2`, etc.; the second uses `B-1`, and so on. The designated Y type participates in that same list and receives its list-position letter. Prefixes continue as `AA`, `AB` after `Z`.

Each counter starts at one for each configured business date. The cutoff comes from the existing business-day configuration, rather than midnight or a cashier's shift. All cashiers share each type's counter.

The current order-type list is ordered by database ID. Its letter mapping freezes when that business day's first typed number is allocated. Renaming/deleting a type does not relabel issued tickets; a type added later that day gets the next unused letter. The next business date uses the current list afresh. Legacy orders without a type use a final, separate letter when needed.

Immediate held orders receive a number when sent; scheduled holds receive one on their first explicit send/print or checkout. An issued held number stays the same through edits, checkout and retries, even across business dates or a later type change. Open tables continue receiving their number at settlement. Cancellation consumes only its own type's issued number and never renumbers printed tickets or advances another type's counter.

Turning the setting off resumes the shared counter. Turning it back on resumes each type's counter for that day. Existing order numbers and invoice numbers remain unchanged. The separate **Receipt layout: show invoice line only** setting still controls whether the customer copy shows its order number.

Table saves retain the selected order type. Settlement uses that saved type if the request omits it; each split seat inherits its parent table's type. Opening or splitting the table still consumes no order number. Each seat receives its own number when paid.

The numeric `order_id` remains numeric. `order_seq_scope` freezes the issued prefix, and `order_display_no` exposes the complete printable reference. `daily_order_type_sequences` owns the counters and daily letter map. The migration is additive and defaults the setting to off; fresh installers include the same table and ledger entry.

See the [workflow audit and measured results](reviews/2026-09-12-order-type-numbering-audit.md) for table fixes, payment-dialog recovery, printing and test coverage.

## Focused verification

```text
npm run test:isolated -- orderTypeNumbering sharedDailySequence heldOrderNumber openTableNumbers
npm run test:isolated -- automaticMigrations schemaAuthority installerBaseline maintenanceReset printTemplateParity invoiceSequence
npm run test:frontend -- src/components/pos/__tests__/receiptPreviewRender.spec.js
node scripts/reviews/order-type-numbering-browser.cjs
npm run build
npm run architecture:check
```

Run backend suites sequentially using the guarded loopback fixtures. The browser script exercises the real settings component against generated HTTP responses in English desktop and Arabic mobile layouts; artifacts go under `scratch/order-type-numbering-browser`. Compiled-print checks inspect queued HTML without sending to physical printers. These checks do not deploy or modify a customer database.

For the real checkout/browser/spooler audit, build first and run `node scripts/reviews/order-type-workflow-audit.cjs` separately from other test workloads. It creates/removes its own guarded loopback database, exercises four cashier sessions, five types, cash/card/split payments, held/platform workflows and the built POS in English/Arabic, then delivers receipts and kitchen tickets through the actual V2 spooler to a local TCP simulator. Set `PUPPETEER_CACHE_DIR` to the installed spooler browser cache when needed, as described in [verification](agents/verification.md). Results and journals stay under ignored `scratch/order-type-workflow-audit/`. This does not test a physical printer or Hostinger.
