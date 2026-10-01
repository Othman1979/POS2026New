# Rollout Runbook — Receipt and Display Consistency

This runbook deploys the tracked receipt-v1 physical spooler. It supersedes the former shared-file and patch procedure.

## 1. Prerequisites

1. Take the normal production database snapshot.
2. Confirm `orders.tax_inclusive_at_sale` exists and stored historical totals are unchanged.
3. Confirm the release contains `pos-spooler-printer/server.js`, `receiptDisplayV1.cjs`, `report-html.js`, `package.json` and `package-lock.json`.

## 2. Upgrade every print machine

1. Stop the `POS Print Spooler` service.
2. Preserve the machine's existing `.env` outside the replacement directory.
3. Deploy the complete tracked `pos-spooler-printer/` directory from the release commit.
4. Restore `.env` and do not copy certificates, keys, caches or `node_modules` from Git.
5. Run:

   ```cmd
   cd /d C:\path\to\pos-spooler-printer
   npm ci
   npm run setup-browser
   npm test
   ```

6. Restart the service and confirm version `1.1.0` plus printer status in Admin -> Settings -> Print queue.

Do not apply `pos-spooler-server-receipt-v1.patch`; it is obsolete and removed. The server and renderer are versioned together.

## 3. Physical verification matrix

| Scenario | Expected result | Status |
|---|---|---|
| V1 exclusive receipt with line discounts | Rows and totals match POS/admin at two decimals | Pending |
| V1 inclusive receipt | Tax is labelled included and is not added twice | Pending |
| Bundle plus service charge | Child rows have no child price and service charge is correct | Pending |
| Old queued payload without v1 | Legacy fallback prints without crashing | Pending |
| Present malformed v1 | Job fails closed; no recomputed receipt is printed | Pending |
| HTML-like names, notes and footer | Characters print literally; no markup executes or loads | Pending |
| Multiline receipt and kitchen notes | Each line remains distinct | Pending |
| Split tender | Cash and Card amounts both print correctly | Pending |

## 4. Web rollout

After every active spooler passes the matrix, deploy the backend and Vue production build. Verify guest checks, held orders, open-table splits, paid checkout, admin reprints, A4 documents and historical receipts.

## 5. Rollback

Restore the previous complete spooler release while preserving the machine's `.env`. Do not drop receipt tax-mode columns during an application rollback. The v1-aware spooler remains compatible with payloads that omit `receipt_display_v1`.
