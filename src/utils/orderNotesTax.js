import { lineNet, orderDiscountAmount, posTotals } from './posTotals.js';

// Held cart_data can contain legacy aliases. Normalize only the calculation fields,
// then delegate all arithmetic to the live-cart totals authority.
const normalizeHeldItem = (item) => {
  const source = item || {};
  return {
    ...source,
    qty: source.qty != null ? source.qty : source.quantity,
    tax_rate: source.tax_rate != null ? source.tax_rate : source.taxRate,
    discountType: source.discountType || source.discount_type,
    discountValue: source.discountValue != null
      ? source.discountValue
      : source.discount_value
  };
};

export function itemLineNet(item) {
  return lineNet(normalizeHeldItem(item));
}

export function applyOrderDiscount(subtotal, orderDiscount) {
  return Math.max(0, subtotal - orderDiscountAmount(subtotal, orderDiscount));
}

export function heldOrderTotal(items, orderDiscount, taxInclusive) {
  const normalizedItems = Array.isArray(items) ? items.map(normalizeHeldItem) : [];
  return posTotals(normalizedItems, orderDiscount, { taxInclusive }).total;
}
