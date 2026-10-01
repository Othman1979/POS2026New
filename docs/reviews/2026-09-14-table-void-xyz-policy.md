# xyz policy for unpaid table voids

The user clarified that this exception applies **only to unpaid saved/printed table voids**, including item removal, partial quantity removal, last-item removal and Clear. Paid refunds keep their financial records. No historical data is removed.

## Implementation

- The void transaction resolves the existing `users.xyz` policy for the **acting user** from the database after validating table identity, permissions and requested quantities. Browser flags and the order creator's identity do not control it.
- With `xyz=1`, the operation inserts nothing into `deleted`, `refunds`, `refund_items` or `audit_events`. The response has `refund_id: null`. With `xyz=0`, the existing recording behavior continues.
- Live items, totals, table release and removal of eligible never-issued orders retain the previous rules. Existing void history from earlier ordinary actions remains intact when a trusted actor clears the remainder.
- Product stock and recipe balances still reverse inside the transaction. Those operational inventory entries are retained to keep quantities correct; this feature suppresses the four requested history tables, not the inventory ledger.
- Kitchen cancellation jobs also remain. A UUID gives an unrecorded cancellation its own stock-operation/print identity without inventing a refund row or introducing another table. Ingredient reversals use their existing locked recipe-line identity and a null refund source ID/label.
- `appendAuditEvent` can reuse a policy already resolved by the same transaction. Other callers continue reading the existing policy normally. This keeps the table void at one policy query and does not grant permissions.
- Paid-refund financial writes, refunded-quantity guards and cash calculations are unchanged. The global xyz audit-event policy already applied to paid refunds and continues doing so.

No schema migration, user-flag changes in customer data, push or deployment was performed.

## Verification

The baseline confirmed that xyz already suppressed `audit_events`, but still wrote cancellation history. A RED regression reproduced the unwanted void history before the implementation. The final isolated run passed **123 checks**: 9 policy cases, 17 cancellation/archive cases, 73 paid/unpaid refund cases, 9 report cases, 10 connection-lifetime cases and 5 shared audit cases.

The focused policy cases cover both flag values after login, saved and printed tables, fractional and final item removal, Clear, empty history tables, product/recipe restoration, two distinct kitchen cancellation jobs, stale retries, preserved prior ordinary history, ignored forged browser flags, retained permission checks, paid-refund records/duplicate protection/shift cash and rollback before retry.

Run the browser harness with `TABLE_VOID_XYZ=1` for the trusted-actor scenario; its default continues testing ordinary actors. It uses the built POS, real API and a newly generated loopback database, then removes only that database. The scenario covers English/Arabic desktop/mobile Save → Remove → Clear, Cancel, a deliberately lost response after commit, history/report checks, a separate real paid refund and shift closing. No customer DB, physical printer or installed spooler is used.

All four xyz browser combinations passed at 1440/390 px in English/Arabic. Each ended with zero cancellation rows in the four requested history tables, zero void events/value in the report, one visible actual paid refund, restored stock and expected cash of 50. There were no page errors. Arabic runs use the real printed-state API; physical printing is not claimed. Frontend source was unchanged, so acceptance used the existing verified production build with the current backend.

## Local measurements

The writer at `02236798` and the new writer ran on identical generated schemas, alternating order over three samples for each size and flag. These simple saved-item fixtures isolate history work; they are not customer or whole-device benchmarks. Rows returned stayed at 10/29/210 for 1/20/201 saved items, respectively. Both writers read the policy once and released the transaction connection before kitchen dispatch.

| xyz | Saved items | Before / after queries | Before / after median time |
| --- | --- | --- | --- |
| 0 | 1 | 19 / 19 | 13.94 / 13.44 ms |
| 0 | 20 | 38 / 38 | 19.98 / 19.97 ms |
| 0 | 201 | 220 / 220 | 63.74 / 61.15 ms |
| 1 | 1 | 18 / 14 | 13.51 / 10.08 ms |
| 1 | 20 | 37 / 14 | 15.81 / 8.41 ms |
| 1 | 201 | 219 / 14 | 58.65 / 12.56 ms |

Ordinary-user query work is unchanged. The trusted-user path skips the history inserts and associated status update. No schema change or additional policy query was needed. Syntax, whitespace and architecture checks passed.

Evidence: `scratch/table-refund-xyz-{baseline,red,green,hostile,regressions}.json`, `scratch/deleted-table-items-browser-xyz/` and `scratch/table-void-xyz-{0,1}-performance.json`.
