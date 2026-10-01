import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Preview and browser-print layouts live in two components.
const receipt = readFileSync(resolve(__dirname, '../ReceiptPreviewModal.vue'), 'utf8')
  + readFileSync(resolve(__dirname, '../ReceiptPrintLayout.vue'), 'utf8');
const a4Receipt = readFileSync(resolve(__dirname, '../../../admin/components/A4Receipt.vue'), 'utf8');

describe('split-tender customer receipt', () => {
  it('does not present Split as a third tender on split receipts', () => {
    expect(receipt).toContain("!['split', 'platform', 'receivable'].includes(lastOrder.payment_method)");
    expect(receipt.match(/v-if="Number\(lastOrder\.change_due \|\| 0\) > 0"/g)).toHaveLength(2);
  });

  it('shows both allocations on the printable A4 customer receipt', () => {
    expect(a4Receipt).toContain("order?.payment_method === 'split'");
    expect(a4Receipt).toContain("? 'Cash and card' : order.payment_method");
    expect(a4Receipt.match(/order\.cash_amount/g).length).toBeGreaterThanOrEqual(2);
    expect(a4Receipt.match(/order\.card_amount/g).length).toBeGreaterThanOrEqual(2);
  });
});
