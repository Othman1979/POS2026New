import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';
import ReceiptPreviewModal from '../ReceiptPreviewModal.vue';
import ReceiptPrintLayout from '../ReceiptPrintLayout.vue';
import { initBusinessConfig } from '../../../utils/businessDate.js';

const shared = vi.hoisted(() => ({ terminal: null }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => shared.terminal }));

beforeEach(() => {
  initBusinessConfig({ business_sql_offset: '+03:00', business_day_start_hour: 6 });
  shared.terminal = {
    showReceiptModal: ref(true), lastOrder: ref(null), receiptConfig: ref({}),
    storeName: ref('Test POS'), storeAddress: ref(''), storePhone: ref(''),
    salesTaxNumber: ref(''), incomeTaxNumber: ref(''),
    useInvoiceNoOnly: ref(false), isPrintingBackend: ref(false),
    closeReceiptModal: vi.fn(), printReceipt: vi.fn(),
  };
});

async function renderReceipt() {
  // The terminal mounts the print layout always and the preview on demand; render both.
  const app = createSSRApp({ render: () => [h(ReceiptPreviewModal), h(ReceiptPrintLayout)] });
  app.config.globalProperties.$t = text => text;
  const warnings = [];
  app.config.warnHandler = message => warnings.push(message);
  const context = {};
  const html = await renderToString(app, context);
  expect(warnings).toEqual([]);
  return { html, thermal: context.teleports?.body || '' };
}

describe('checkout receipt rendering', () => {
  it('keeps the same prefixed order reference in preview and thermal output', async () => {
    shared.terminal.lastOrder.value = {
      order_id: 12, order_display_no: 'C-12', invoice_display_no: '71', date: '2026-09-12 10:00:00',
      items: [{ name: 'Coffee', qty: 1, price: 3 }], subtotal: 3, tax: 0, total: 3,
      payment_method: 'cash', amount_tendered: 3,
    };
    const { html, thermal } = await renderReceipt();
    expect(html).toContain('C-12');
    expect(thermal).toContain('C-12');
    expect(thermal).toContain('71');
  });
  it.each([
    [true, 'cash', 'order_taken_at'],
    [false, 'card', 'date'],
    [true, 'split', 'order_taken_at'],
    [true, 'platform', 'order_taken_at'],
    [true, 'receivable', 'order_taken_at'],
  ])('renders the receipt and print-only timestamp with preview=%s, payment=%s, timestamp=%s', async (visible, payment, field) => {
    shared.terminal.showReceiptModal.value = visible;
    shared.terminal.lastOrder.value = {
      order_id: 42, invoice_display_no: 'INV-42', [field]: '2026-09-09 18:30:00',
      items: [{ name: 'Coffee', qty: 1, price: 3 }], subtotal: 3, tax: 0, total: 3,
      payment_method: payment, cash_amount: 1, card_amount: 2, amount_tendered: 3,
    };
    const { html, thermal } = await renderReceipt();
    expect(thermal).toContain('2026-09-09 09:30:00 PM');
    expect(thermal).toContain('Coffee');
    expect(thermal).toContain('INV-42');
    if (['platform', 'receivable'].includes(payment)) {
      expect(thermal).toContain('No payment was collected.');
      expect(thermal).not.toContain('Tendered');
      expect(html).not.toContain('Tendered');
    }
    if (visible) expect(html).toContain('Coffee');
    expect(shared.terminal.printReceipt).not.toHaveBeenCalled();
  });

  it('prints the cash and card allocations of a split tender on both preview and thermal paper', async () => {
    shared.terminal.lastOrder.value = {
      order_id: 51, invoice_display_no: 'INV-51', date: '2026-09-12 10:00:00',
      items: [{ name: 'Coffee', qty: 1, price: 12 }], subtotal: 12, tax: 0, total: 12,
      payment_method: 'split', cash_amount: 4.25, card_amount: 7.75, amount_tendered: 12,
    };
    const { html, thermal } = await renderReceipt();
    for (const paper of [html, thermal]) {
      expect(paper).toMatch(/Cash<\/span>\s*<span>4\.25 JD/);
      expect(paper).toMatch(/Card<\/span>\s*<span>7\.75 JD/);
    }
  });

  it('renders safely before checkout and suppresses invalid financial receipts', async () => {
    expect((await renderReceipt()).thermal).not.toContain('receipt-print-wrapper');
    shared.terminal.lastOrder.value = { receipt_display_error: 'Invalid totals' };
    const { html, thermal } = await renderReceipt();
    expect(html).toContain('Receipt layout is invalid');
    expect(thermal).not.toContain('receipt-print-wrapper');
  });
  it('labels an unpaid guest check on both preview and thermal paper', async () => {
    shared.terminal.lastOrder.value = {
      guest_check: true, invoice_id: 'GUEST CHECK', order_id: 42,
      items: [{ name: 'Coffee', qty: 1, price: 3 }], subtotal: 3, tax: 0, total: 3,
    };
    const { html, thermal } = await renderReceipt();
    expect(html).toContain('Guest check');
    expect(thermal).toContain('Guest check');
  });

  it('shows the saved-profile tax number on a paid invoice and hides it when blank or provisional', async () => {
    shared.terminal.salesTaxNumber.value = 'SALES-123';
    shared.terminal.incomeTaxNumber.value = 'INCOME-456';
    shared.terminal.lastOrder.value = {
      invoice_id: 72, invoice_display_no: '72', tax_registration_type_at_sale: 'income_tax',
      items: [{ name: 'Coffee', qty: 1, price: 3 }], subtotal: 3, tax: 0, total: 3,
      payment_method: 'cash', amount_tendered: 3,
    };
    const paid = await renderReceipt();
    expect(paid.html).toContain('INCOME-456');
    expect(paid.thermal).toContain('INCOME-456');
    expect(paid.html).not.toContain('SALES-123');

    shared.terminal.incomeTaxNumber.value = '   ';
    expect((await renderReceipt()).html).not.toContain('Seller tax number');

    shared.terminal.incomeTaxNumber.value = 'INCOME-456';
    shared.terminal.lastOrder.value = { ...shared.terminal.lastOrder.value, provisional: true };
    expect((await renderReceipt()).html).not.toContain('INCOME-456');
  });

  const taxedOrder = taxMode => ({
    invoice_id: 73, invoice_display_no: '73', tax_mode: taxMode,
    items: [{ name: 'Coffee', qty: 1, price: 10 }], subtotal: 10, tax: 1.6, total: 11.6,
    payment_method: 'cash', amount_tendered: 11.6,
  });

  it('omits the subtotal and tax rows from a tax-inclusive receipt', async () => {
    shared.terminal.lastOrder.value = taxedOrder('inclusive');
    const { html, thermal } = await renderReceipt();
    for (const output of [html, thermal]) {
      expect(output).toContain('11.60');
      expect(output).not.toContain('Subtotal');
      expect(output).not.toContain('Tax');
    }
  });

  it('shows the subtotal and tax rows on a tax-exclusive receipt', async () => {
    shared.terminal.lastOrder.value = taxedOrder('exclusive');
    const { html, thermal } = await renderReceipt();
    for (const output of [html, thermal]) {
      expect(output).toContain('Subtotal');
      expect(output).toContain('Tax');
      expect(output).toMatch(/\b1\.60 JD/);
    }
  });
});
