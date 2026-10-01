# Progressive Split-Check Owner Prompt

Act as the financial-state owner of this POS. Build the smallest MICROS-inspired progressive split lifecycle that fits the existing application; do not clone enterprise configuration. Read the split creation, table locking, table mutations, checkout, inventory, service-charge snapshots, receipts, JoFotara, reporting, socket events, migrations, and tests end to end before editing.

Non-negotiable invariants:

- A split never changes the sum of quantity, subtotal, discount, tax, service charge, or payable cents.
- The table and joined-table group stay occupied until the final unpaid split bucket is paid.
- The parent remains the live `unpaid_table` lifecycle row during progressive settlement.
- Parent stock remains deducted; paid split children must not deduct it again.
- Every paid bucket creates exactly one normal finalized child order and preserves `parent_invoice_id` for receipt, refund, reporting, and JoFotara lineage.
- The final bucket atomically closes the parent lifecycle and releases the table group.
- Concurrent payment, cancellation, save, and table-structure actions cannot orphan, duplicate, or double-charge a bucket.
- Cancellation is all-or-nothing and allowed only before any child payment.
- Never trust client totals, prices, tax, ownership, table ID, or parent ID.
- Reuse the existing allocator, calculator, snapshot, checkout, receipt, audit, and table-locking modules. Do not create duplicate calculators or speculative abstractions.

Use TDD. For each state transition, first write an integration test and observe the expected failure. Keep the schema addition limited to relational ownership columns on `held_orders`. Preserve legacy split rows through read fallback where safe, but never weaken authentication. Run focused tests after each change, then the complete table/checkout/unit suites, schema validation, and production build. If an invariant cannot be proved, stop instead of guessing.
