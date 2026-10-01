# Table Settlement Performance Evidence

## Baseline (18c561ff)

- Checkout: median `7.21 ms`, p95 `14.60 ms`, median `23` queries, maximum `23` queries
- Mark printed: median `2.69 ms`, p95 `4.00 ms`, median `3` queries, maximum `3` queries
- Guest-check browser requests: 3 (print, mark, forced workspace refresh)
- Harness: 15 serial samples per operation against a freshly seeded local `posapp_test`

## Final (62ecf240)

- Checkout: median `4.87 ms`, p95 `14.72 ms`, median `23` queries, maximum `23` queries
- Mark printed: median `2.40 ms`, p95 `3.60 ms`, median `5` queries, maximum `5` queries
- Guest-check browser requests: 2 (print and invoice-bound mark; no forced workspace refresh)
- Harness: 15 serial samples per operation against a freshly seeded local `posapp_test`
- Checkout query count is unchanged from baseline; its median improved by `2.34 ms` in this local run.
- Mark printed adds two queries to lock and validate the full table session atomically; the browser no longer follows it with a workspace request.

## Verification

- Table settlement context integration: `8/8`
- Checkout integration: `82/82`
- Refund integration: `57/57`
- Table workflow integration: `158/158`
- Vue session, terminal, and receipt-print units: `139/139`
- Backend syntax checks: `4/4`
- Schema comparison: zero drift between `posapp` and `posapp_test`
- Spooler report HTML tests: passed
- Admin production build: passed (`241` modules transformed)
