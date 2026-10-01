import { describe, expect, it } from 'vitest';
import { buildReceiptPresentation } from '../../../src/utils/receiptPresentation.js';

const loadCheckoutFlow = () => import('@/pos/stores/orderSession/checkoutFlow.js');

const input = () => ({
  user: { id: 4, name: 'Cashier', role: 'cashier' }, shiftId: 8,
  cart: [{ id: 3, name: 'Coffee', qty: 2, price: 5, tax_rate: 16, cartId: 'cart-1' }],
  table: { id: 2, current_order_id: 9, order_id: 10, table_number: 'A1', is_split: true, parent_invoice_id: 1, parent_order_id: 2, split_check_id: 3 },
  editingInvoiceId: 11, editingOrderId: 12, orderTypeId: 6, orderTypeName: 'Dine in', orderTypeDeferred: false, requiresHash: true,
  hashNumber: 'hash', customer: { phone: '079', name: 'Ada', address: 'Amman', deliveryDate: '2026-07-23', note: 'hot' },
  totals: { subtotal: 10, tax: 1.6, total: 11.6, discount: 0 }, orderDiscount: { type: 'percent', value: 0 },
  payment: { method: 'split', amountTendered: 20, splitCardAmount: 4, splitCashTendered: 10, changeDue: 2.4 },
  serviceChargeSnapshot: { id: 7, version: 2, claimToken: 'claim' }, idempotencyKey: 'key-1',
  tableOwner: { seq: 3, tableId: 2 }, taxInclusive: false, taxExempt: true,
});

describe('checkoutFlow', () => {
  it('offers only held-order commands to call-center workers', async () => {
    const { buildCallCenterCommandPolicy } = await loadCheckoutFlow();
    expect(buildCallCenterCommandPolicy({ editing: false, kitchenFired: false })).toEqual(['send_as_held']);
    expect(buildCallCenterCommandPolicy({ editing: true, kitchenFired: false })).toEqual([
      'save_changes', 'cancel_edits', 'cancel_order',
    ]);
    expect(buildCallCenterCommandPolicy({ editing: true, kitchenFired: true })).toEqual([
      'save_changes', 'send_follow_up', 'cancel_edits', 'cancel_order',
    ]);
    expect(buildCallCenterCommandPolicy({ editing: true, kitchenFired: true })).not.toContain('process_checkout');
  });

  it('builds a stable fingerprint source without copying raw customer cart data into cache storage', async () => {
    const { buildCheckoutFingerprintSource } = await loadCheckoutFlow();
    const fingerprint = buildCheckoutFingerprintSource(input());

    expect(fingerprint).toMatchObject({ actorId: 4, shiftId: 8, activeTableId: 2, activeTableOrderId: 9, total: 11.6, taxExempt: true });
    expect(fingerprint.cart).toEqual([expect.objectContaining({ id: 3, qty: 2, price: 5, bundleItems: [] })]);
    expect(fingerprint.serviceChargeSnapshot).toEqual({ id: 7, version: 2, claimToken: 'claim' });
    expect(fingerprint.payment).toEqual({ method: 'split', amountTendered: 20, splitCardAmount: 4, splitCashTendered: 10 });
  });

  it('freezes request data and constructs the split checkout payload', async () => {
    const { buildCheckoutRequest } = await loadCheckoutFlow();
    const source = input();
    const { payload, frozen } = buildCheckoutRequest(source);
    source.cart[0].qty = 99;
    source.customer.name = 'Changed';

    expect(payload).toMatchObject({
      user_id: 4, shift_id: 8, table_id: 2, edit_invoice_id: 9, edit_order_id: 10,
      amount_tendered: 14, cash_amount: 7.6, card_amount: 4, is_split: true,
      parent_invoice_id: 1, parent_order_id: 2, split_check_id: 3,
      service_charge_snapshot: { id: 7, version: 2, claim_token: 'claim' },
      tax_exempt: true, order_type_is_deferred_settlement: false,
    });
    expect(frozen.cartSnapshot[0].qty).toBe(2);
    expect(frozen.customer.name).toBe('Ada');
    expect(frozen.tableOwner).toEqual({ seq: 3, tableId: 2 });
    expect(frozen.taxExempt).toBe(true);
  });

  it('passes a held identity and lease envelope without trusting a reference name', async () => {
    const { buildCheckoutRequest } = await loadCheckoutFlow();
    const source = input();
    source.table = null;
    source.heldOrderContext = { id: 31, version: 7, claimToken: 'b'.repeat(64) };
    const { payload } = buildCheckoutRequest(source);
    expect(payload.held_order_context).toEqual({
      id: 31,
      claim_token: 'b'.repeat(64),
      expected_version: 7,
      operation_id: 'key-1',
    });
  });

  it('includes a temporary manager PIN only when one is active', async () => {
    const { buildCheckoutRequest } = await loadCheckoutFlow();
    const source = input();
    expect(buildCheckoutRequest(source).payload).not.toHaveProperty('manager_pin');

    source.managerPin = '2468';
    const request = buildCheckoutRequest(source);
    expect(request.payload.manager_pin).toBe('2468');
    expect(request.frozen.payload).not.toHaveProperty('manager_pin');
  });

  it('conserves cents when the split contains fractional binary values', async () => {
    const { buildCheckoutRequest } = await loadCheckoutFlow();
    const source = input();
    source.totals = { subtotal: 4.75, tax: 0, total: 4.75, discount: 0 };
    source.payment = { method: 'split', splitCardAmount: 2.38, splitCashTendered: 2.37, changeDue: 0 };

    expect(buildCheckoutRequest(source).payload).toMatchObject({
      amount_tendered: 4.75,
      cash_amount: 2.37,
      card_amount: 2.38,
      change_due: 0,
    });
  });

  it('sends no tender for a platform checkout', async () => {
    const { buildCheckoutRequest } = await loadCheckoutFlow();
    const source = input();
    source.table = null;
    source.payment = { method: 'platform', amountTendered: 11.6, splitCardAmount: 0, splitCashTendered: 0, changeDue: 4 };

    expect(buildCheckoutRequest(source).payload).toMatchObject({
      payment_method: 'platform',
      amount_tendered: 0,
      cash_amount: 0,
      card_amount: 0,
      change_due: 0,
    });
  });

  it('uses server receipt data and totals when present', async () => {
    const { buildCheckoutRequest, buildSuccessfulCheckoutResult } = await loadCheckoutFlow();
    const { frozen } = buildCheckoutRequest(input());
    const receipt = buildReceiptPresentation({
      items: [{ id: 1, name: 'Receipt item', qty: 1, price: 1, tax_rate: 0 }], summary: { subtotal: 1, tax: 0, total: 1 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive', status: 'original',
    });

    const result = buildSuccessfulCheckoutResult({
      response: { success: true, invoice_id: 44, order_id: 45, subtotal: 12, tax: 2, total: 14, cash_amount: 8, card_amount: 6, receipt_display_v1: receipt },
      frozen,
      now: new Date('2026-07-23T10:00:00Z'),
    });

    expect(result.wasTableOrder).toBe(true);
    expect(result.lastOrder).toMatchObject({ invoice_id: 44, order_id: 45, subtotal: 12, tax: 2, total: 14, cash_amount: 8, card_amount: 6, receipt_display_v1: receipt });
  });

  it('builds a receipt from frozen data when the server omits it', async () => {
    const { buildCheckoutRequest, buildSuccessfulCheckoutResult } = await loadCheckoutFlow();
    const { frozen } = buildCheckoutRequest(input());

    const result = buildSuccessfulCheckoutResult({
      response: { success: true, invoice_id: 44, order_id: 45, subtotal: 10, tax: 0, total: 10 },
      frozen,
      now: new Date('2026-07-23T10:00:00Z')
    });

    expect(result.lastOrder.receipt_display_v1.summary).toMatchObject({ subtotal: 10, taxAmount: 0, total: 10, taxLabel: '(معفي من الضريبة)' });
    expect(result.lastOrder.items).toEqual([expect.objectContaining({ qty: 2, cartId: 'cart-1' })]);
    expect(result.lastOrder).toMatchObject({ cash_amount: 7.6, card_amount: 4, tax_exempt: true });
  });
});

describe('split checkout attempt identity', () => {
  it('distinguishes sibling checks and revisions with identical items and tender', async () => {
    const { buildCheckoutFingerprintSource } = await loadCheckoutFlow();
    const a = input(), b = input(); b.table.split_check_id += 1;
    expect(buildCheckoutFingerprintSource(a)).not.toEqual(buildCheckoutFingerprintSource(b));
    b.table.split_check_id = a.table.split_check_id; b.table.split_revision = 2;
    expect(buildCheckoutFingerprintSource(a)).not.toEqual(buildCheckoutFingerprintSource(b));
  });
});
