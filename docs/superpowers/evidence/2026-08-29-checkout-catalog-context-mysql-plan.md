# Checkout catalog-context MySQL plan — Task 2

Date: 2026-08-29
Database: local `posapp_test`
Engine: MariaDB 10.4.32

## Read-only plan evidence

The exact non-locking checkout admission query was inspected with both
`EXPLAIN` and `ANALYZE FORMAT=JSON` for two requested product IDs.

| Join | `EXPLAIN` access/key | `ANALYZE` result |
| --- | --- | --- |
| `products p` | range on `PRIMARY` | The tiny six-row test table chose its `category_id` index instead; the predicate remained bounded to the two requested IDs. |
| direct `categories c` | `eq_ref` on `PRIMARY` | one row per product |
| price-list root category | `eq_ref` on `PRIMARY` | at most one row per direct category |
| `product_price_overrides` | `eq_ref` on its `(price_list_root_id, product_id)` primary key | at most one override |
| `subscription_plans` | `eq_ref` on `uq_subscription_plans_sale_product` | at most one plan |

The MariaDB runtime plan completed the read in roughly 0.02 ms on the local
fixture. Its product access choice is data-size-dependent, so the application
does not assert an optimizer `type`; the important invariant is one result row
per requested product and key-bounded joins after it.

## Semantic checks

Focused integration coverage proves that the combined read:

- reads each repeated base or note product once;
- uses an active category override;
- falls back to the base price when the root is inactive; and
- ignores an override for a note-category product, retaining that note's
  catalog price.

The stock-deduction read remains a separate `FOR UPDATE` query over base
product IDs only and never carries checkout context joins.
