import { describe, expect, it } from 'vitest';
import { orderDetailLineDisplay, orderDetailSummary } from './receiptLineTotals.js';

describe('order detail money display', () => {
  it('has no invoice summary before an order has loaded', () => {
    expect(orderDetailSummary(null)).toBeNull();
    expect(orderDetailSummary(undefined)).toBeNull();
  });

  it('shows tax-inclusive original and discounted values for an exclusive-tax line', () => {
    const display = orderDetailLineDisplay({
      quantity: 2,
      price_at_sale: 10,
      tax_rate: 16,
      discount_type: 'percent',
      discount_value: 50,
      refunded_quantity: 1
    }, { taxInclusive: false });

    expect(display).toEqual({
      unitPrice: 11.6,
      originalTotal: 23.2,
      finalTotal: 11.6,
      discountAmount: 11.6,
      refundedQuantity: 1,
      remainingQuantity: 1
    });
  });

  it('does not add tax a second time to inclusive or tax-exempt prices', () => {
    expect(orderDetailLineDisplay({
      quantity: 1,
      price_at_sale: 11.6,
      tax_rate: 16
    }, { taxInclusive: true }).finalTotal).toBe(11.6);

    expect(orderDetailLineDisplay({
      quantity: 1,
      price_at_sale: 10,
      tax_rate: 16
    }, { taxInclusive: false, taxExempt: true }).finalTotal).toBe(10);
  });

  it('reconciles order discount and partial refunds to the stored invoice total', () => {
    const summary = orderDetailSummary({ total: 11.6, discount_value: 50 }, [
      { finalTotal: 11.6 },
      { finalTotal: 11.6 }
    ], [
      { amount_refunded: 4.64 }
    ]);

    expect(summary).toEqual({
      beforeOrderDiscount: 23.2,
      orderDiscountAmount: 11.6,
      invoiceTotal: 11.6,
      refundedAmount: 4.64,
      remainingAmount: 6.96
    });
  });
});
