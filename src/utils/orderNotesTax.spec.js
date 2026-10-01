import { describe, it, expect } from 'vitest';
import { heldOrderTotal, itemLineNet, applyOrderDiscount } from './orderNotesTax.js';

describe('itemLineNet', () => {
  it('multiplies price by qty', () => {
    expect(itemLineNet({ price: 10, qty: 2 })).toBe(20);
  });
  it('accepts quantity as an alias for qty', () => {
    expect(itemLineNet({ price: 5, quantity: 3 })).toBe(15);
  });
  it('normalizes persisted snake_case discount aliases', () => {
    expect(itemLineNet({
      price: 10,
      quantity: 2,
      discount_type: 'fixed',
      discount_value: 4
    })).toBe(12);
  });
  it('applies a percent item discount', () => {
    expect(itemLineNet({ price: 10, qty: 2, discountType: 'percent', discountValue: 10 })).toBe(18);
  });
  it('applies a fixed item discount, clamped at zero', () => {
    expect(itemLineNet({ price: 10, qty: 1, discountType: 'fixed', discountValue: 4 })).toBe(6);
    expect(itemLineNet({ price: 10, qty: 1, discountType: 'fixed', discountValue: 999 })).toBe(0);
  });
  it('treats missing/garbage numbers as zero', () => {
    expect(itemLineNet({ price: 'x', qty: 2 })).toBe(0);
    expect(itemLineNet(null)).toBe(0);
  });
});

describe('applyOrderDiscount', () => {
  it('returns the subtotal unchanged with no discount', () => {
    expect(applyOrderDiscount(100, null)).toBe(100);
    expect(applyOrderDiscount(100, { type: 'percent', value: 0 })).toBe(100);
  });
  it('applies a percent order discount', () => {
    expect(applyOrderDiscount(100, { type: 'percent', value: 10 })).toBe(90);
  });
  it('applies a fixed order discount, clamped at zero', () => {
    expect(applyOrderDiscount(100, { type: 'fixed', value: 30 })).toBe(70);
    expect(applyOrderDiscount(100, { type: 'fixed', value: 999 })).toBe(0);
  });
});

describe('heldOrderTotal', () => {
  const items = [
    { price: 10, qty: 2, tax_rate: 10 }, // net 20
    { price: 5, qty: 1, tax_rate: 0 },   // net 5
  ];

  it('adds per-line tax in exclusive mode', () => {
    // net 25, tax = 20*0.10 + 5*0 = 2 -> 27
    expect(heldOrderTotal(items, null, false)).toBe(27);
  });
  it('adds no tax in inclusive mode (prices already gross)', () => {
    expect(heldOrderTotal(items, null, true)).toBe(25);
  });
  it('spreads an order-level percent discount before tax (exclusive)', () => {
    // discounted subtotal 25*0.9 = 22.5; ratio 0.9; tax = 20*0.9*0.10 = 1.8 -> 24.3
    expect(heldOrderTotal(items, { type: 'percent', value: 10 }, false)).toBe(24.3);
  });
  it('applies an order-level discount in inclusive mode with no tax', () => {
    expect(heldOrderTotal(items, { type: 'fixed', value: 5 }, true)).toBe(20);
  });
  it('returns 0 for an empty or non-array item list', () => {
    expect(heldOrderTotal([], null, false)).toBe(0);
    expect(heldOrderTotal(undefined, null, true)).toBe(0);
  });
  it('uses taxRate as an alias for tax_rate', () => {
    expect(heldOrderTotal([{ price: 100, qty: 1, taxRate: 5 }], null, false)).toBe(105);
  });
  it('applies fixed line discounts per unit on multi-quantity held lines', () => {
    const discountedItems = [{
      price: 10,
      qty: 2,
      tax_rate: 16,
      discountType: 'fixed',
      discountValue: 4
    }];

    expect(heldOrderTotal(discountedItems, null, false)).toBe(13.92);
  });
});
