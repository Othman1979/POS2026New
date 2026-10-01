const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

export function receiptItemNetTotal(item = {}) {
  const qty = toNumber(item.qty ?? item.quantity ?? 0);
  let total = toNumber(item.price ?? item.price_at_sale) * qty;
  const discountValue = toNumber(item.discountValue ?? item.discount_value);
  const discountType = item.discountType ?? item.discount_type;

  if (discountValue > 0) {
    if (discountType === 'fixed') total -= discountValue * qty;
    if (discountType === 'percent') total -= total * (discountValue / 100);
  }

  return Math.max(0, total);
}

function receiptLineSubtotal(item = {}) {
  if (item.modifier_surcharge == null || item.modifier_tax_amount == null) {
    return receiptItemNetTotal(item);
  }
  const price = toNumber(item.price ?? item.price_at_sale);
  return receiptItemNetTotal({
    ...item,
    price: Math.max(0, price - toNumber(item.modifier_tax_amount))
  });
}

function taxableNetTotal(item = {}) {
  if (item.modifier_surcharge != null && item.modifier_tax_amount != null) {
    return receiptLineSubtotal(item);
  }
  const surcharge = toNumber(item.modifier_surcharge);
  if (!(surcharge > 0)) return receiptItemNetTotal(item);
  const price = toNumber(item.price ?? item.price_at_sale);
  return receiptItemNetTotal({ ...item, price: Math.max(0, price - surcharge) });
}

export function receiptItemDisplayTotal(item = {}) {
  const netTotal = receiptLineSubtotal(item);
  const savedTax = item.tax_amount ?? item.taxAmount;
  if (savedTax !== undefined && savedTax !== null && savedTax !== '') {
    return netTotal + toNumber(savedTax);
  }

  const taxRate = toNumber(item.tax_rate ?? item.taxRate);
  return netTotal + taxableNetTotal(item) * (taxRate / 100);
}

const round2 = (n) => Math.round((toNumber(n) + Number.EPSILON) * 100) / 100;

export function orderDetailLineDisplay(item = {}, { taxInclusive = false, taxExempt = false } = {}) {
  const quantity = toNumber(item.quantity ?? item.qty);
  const withoutSavedTax = { ...item, tax_amount: null, taxAmount: null };
  const original = { ...withoutSavedTax, discount_type: null, discountType: null, discount_value: 0, discountValue: 0 };
  const totalOf = line => taxInclusive || taxExempt
    ? receiptItemNetTotal(line)
    : receiptItemDisplayTotal(line);
  const unitPrice = round2(totalOf({ ...original, quantity: 1, qty: 1 }));
  const originalTotal = round2(totalOf(original));
  const finalTotal = round2(totalOf(withoutSavedTax));
  const refundedQuantity = Math.min(quantity, Math.max(0, toNumber(item.refunded_quantity)));

  return {
    unitPrice,
    originalTotal,
    finalTotal,
    discountAmount: round2(Math.max(0, originalTotal - finalTotal)),
    refundedQuantity,
    remainingQuantity: round2(Math.max(0, quantity - refundedQuantity))
  };
}

export function orderDetailSummary(order, lines = [], refunds = []) {
  if (!order) return null;
  const invoiceTotal = round2(order.total);
  const hasOrderDiscount = toNumber(order.discount_value) > 0;
  const lineTotal = round2(lines.reduce((sum, line) => sum + toNumber(line.finalTotal), 0));
  const beforeOrderDiscount = hasOrderDiscount ? lineTotal : invoiceTotal;
  const refundedAmount = round2(refunds.reduce((sum, refund) => sum + toNumber(refund.amount_refunded), 0));

  return {
    beforeOrderDiscount,
    orderDiscountAmount: hasOrderDiscount ? round2(Math.max(0, beforeOrderDiscount - invoiceTotal)) : 0,
    invoiceTotal,
    refundedAmount,
    remainingAmount: round2(Math.max(0, invoiceTotal - refundedAmount))
  };
}

// Totals for a split-check pre-bill: net subtotal (post per-line discount), per-line tax,
// and a footing total. Display only — the charged amount is recomputed server-side at settle.
export function splitCheckTotals(items = []) {
    let subtotal = 0;
    let tax = 0;
    for (const item of items) {
        const net = receiptLineSubtotal(item);
        subtotal += net;
        tax += taxableNetTotal(item) * (toNumber(item.tax_rate ?? item.taxRate) / 100);
    }
    subtotal = round2(subtotal);
    tax = round2(tax);
    return { subtotal, tax, total: round2(subtotal + tax) };
}
