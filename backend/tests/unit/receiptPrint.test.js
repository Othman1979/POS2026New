import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildReceiptPayload, printJob } from '@/shared/receiptPrint.js';
import { buildReceiptPresentation } from '../../../src/utils/receiptPresentation.js';

describe('buildReceiptPayload', () => {
  const order = {
    order_id: 5, invoice_id: 900, invoice_display_no: '12007',
    order_display_no: '5', ticket_display_no: null,
    created_at: '2026-07-02T08:00:00Z', cashier_name: 'Sam',
    order_type_name: 'Dine-In', customer_name: 'Ann', customer_phone: '079',
    customer_address: 'Amman', subtotal: 10, tax: 1.6, discount_value: 2,
    total: 9.6, payment_method: 'cash', amount_tendered: 10, change_due: 0.4,
  };
  const items = [
    { quantity: 2, product_name: 'Burger', price_at_sale: 5, tax_rate: 16, tax_amount: 1.6, discount_type: 'fixed', discount_value: 1, note: 'no onion' },
  ];

  it('carries the public display-number fields (fixes admin Ticket->Invoice bug)', () => {
    const p = buildReceiptPayload(order, items, { storeInfo: { store_name: 'X' }, receiptPrinterId: '7' });
    expect(p.invoice_display_no).toBe('12007');
    expect(p.order_display_no).toBe('5');
    expect(p.ticket_display_no).toBeNull();
  });

  it('nulls the display-number fields when the source lacks them', () => {
    const p = buildReceiptPayload({ order_id: 1, invoice_id: 2 }, [], {});
    expect(p.invoice_display_no).toBeNull();
    expect(p.order_display_no).toBeNull();
    expect(p.ticket_display_no).toBeNull();
  });

  it('maps items with the full tax/discount superset (fixes missing line discounts)', () => {
    const p = buildReceiptPayload(order, items, {});
    expect(p.items[0]).toMatchObject({
      qty: 2, name: 'Burger', price: 5, tax_rate: 16, tax_amount: 1.6,
      discountType: 'fixed', discountValue: 1, note: 'no onion',
    });
  });

  it('threads print_type, storeInfo and receiptPrinterId', () => {
    const store = { store_name: 'X' };
    const p = buildReceiptPayload(order, items, { storeInfo: store, receiptPrinterId: 'P1' });
    expect(p.print_type).toBe('receipt');
    expect(p.receipt_printer_id).toBe('P1');
    expect(p.storeInfo).toBe(store);
  });

  it('carries the persisted cash and card allocations for split receipts', () => {
    const payload = buildReceiptPayload({
      ...order,
      payment_method: 'split',
      cash_amount: 4,
      card_amount: 5.6,
    }, items, {});
    expect(payload).toMatchObject({ payment_method: 'split', cash_amount: 4, card_amount: 5.6 });
  });

  it('defaults receiptPrinterId to empty string when omitted', () => {
    const p = buildReceiptPayload(order, items, { storeInfo: {} });
    expect(p.receipt_printer_id).toBe('');
  });

  it('threads validated v1 unchanged into browser and spooler reprints', () => {
    const v1 = buildReceiptPresentation({
      items: [{ key: 'a', name: 'Burger', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 10, tax: 1.6, total: 11.6 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    });
    const payload = buildReceiptPayload(
      { ...order, receipt_display_v1: v1 },
      items,
      { storeInfo: {} }
    );
    expect(payload.receipt_display_v1).toEqual(v1);
  });

  it('throws when a present admin v1 is malformed', () => {
    expect(() => buildReceiptPayload({ ...order, receipt_display_v1: { version: 1 } }, items, {}))
      .toThrow(/invalid receipt presentation/i);
  });

  it('keeps the explicit pre-v1 mismatch on the absent-v1 legacy path', () => {
    const payload = buildReceiptPayload({
      ...order,
      receipt_display_legacy_reason: 'PRE_V1_CENT_MISMATCH'
    }, items, {});
    expect(payload.receipt_display_v1).toBeUndefined();
    expect(payload.receipt_display_legacy_reason).toBe('PRE_V1_CENT_MISMATCH');
    expect(payload.items).toHaveLength(items.length);
    expect(payload.items[0]).toMatchObject({ qty: 2, name: 'Burger', price: 5 });
  });

  it('carries only an accepted JoFotara QR into the thermal payload', () => {
    const accepted = buildReceiptPayload({
      ...order,
      jofotara: { status: 'accepted', uuid: 'doc-uuid', qrText: 'government-qr' }
    }, items, {});
    expect(accepted.jofotara).toEqual({ status: 'accepted', uuid: 'doc-uuid', qrText: 'government-qr' });
    const rejected = buildReceiptPayload({
      ...order,
      jofotara: { status: 'rejected', uuid: 'doc-uuid', qrText: 'must-not-print' }
    }, items, {});
    expect(rejected.jofotara).toBeUndefined();
  });
});

describe('printJob', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('posts to the print bridge and alerts success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const alert = vi.fn();
    const res = await printJob({ print_type: 'receipt' }, { alert, t: (s) => s });
    expect(fetchMock).toHaveBeenCalledWith('api/print/print', expect.objectContaining({ method: 'POST' }));
    expect(alert).toHaveBeenCalledWith('Receipt reprinted successfully!');
    expect(res.success).toBe(true);
  });

  it('honors a custom successKey', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true }) }));
    const alert = vi.fn();
    await printJob({}, { alert, t: (s) => s, successKey: 'Z-Report reprinted successfully!' });
    expect(alert).toHaveBeenCalledWith('Z-Report reprinted successfully!');
  });

  it('alerts the bridge error message on a failed job', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: false, message: 'no printer' }) }));
    const alert = vi.fn();
    await printJob({}, { alert, t: (s) => s });
    expect(alert).toHaveBeenCalledWith('Print Bridge Error: no printer');
  });

  it('alerts the spooler-down message and returns failure on a network throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const alert = vi.fn();
    const res = await printJob({}, { alert, t: (s) => s });
    expect(alert).toHaveBeenCalledWith('Failed to print. Is your Node.js Spooler running?');
    expect(res.success).toBe(false);
  });
});
