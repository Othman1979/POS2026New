# Backend Test Conventions

## Isolation

- Integration tests share one MySQL test database.
- Keep `fileParallelism: false` and `maxWorkers: 1`.
- Vitest holds a MySQL advisory lock for the whole run; a second run fails before it can reset `posapp_test`.
- Use `await seedDatabase()` in `beforeEach` for tests that mutate global state or depend on exact row counts.
- Use `beforeAll` only for scenario-style files where tests intentionally build on a shared fixture.
- Close `pool` in `afterAll` when the file imports `backend/config/db`.

## Helpers

- Use `backend/tests/helpers/auth.js` for seeded-user login.
- Use `backend/tests/helpers/fixtures.js` for common printers, shifts, orders, items, refunds, and print queue payloads.
- Use `backend/tests/helpers/assertions.js` for money assertions.
- Keep SQL fixture helpers small and explicit. Do not build a generic factory system.

## Current Domain Rules

- Business date is fixed offset `+03:00` with a 06:00 start.
- Paid reports bucket paid orders by `COALESCE(invoice_issued_at, created_at)`.
- Shift drawer refund math is based on `refunds.shift_id`.
- Discount totals include both line discounts and order discounts.
- Official Z audit reports are one stored snapshot per business date; reprints reuse that snapshot and serial.
- X and Z audit reports use independent serial counters.

## Commands

```bash
npx vitest run backend/tests/integration/auditReports.test.js
npx vitest run backend/tests/integration/businessDayReconciliation.test.js
npx vitest run
npm run build
```
