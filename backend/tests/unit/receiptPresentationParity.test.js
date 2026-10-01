import { createRequire } from 'node:module';
import {
  buildReceiptPresentation as frontendBuild,
  resolveReceiptPresentation
} from '../../../src/utils/receiptPresentation.js';
import { posTotals, lineNet, roundMoney } from '../../../src/utils/posTotals.js';
import cases from '../fixtures/receiptPresentationCases.json';
const require = createRequire(import.meta.url);
const { buildReceiptPresentation: backendBuild } = require('../../services/ReceiptPresentation');
const { calculateExpectedTotals } = require('../../services/PosCalculator');

const lcg = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

describe('receipt presentation parity', () => {
  it('hides the internal service-charge marker without changing the source item', () => {
    const input = {
      items: [
        { key: 'fee', name: '10% Service Charge', note: 'Auto-Gratuity', qty: 1, unitPrice: 0.79 },
        { key: 'item', name: 'Coffee', note: 'No sugar', qty: 1, unitPrice: 2 }
      ],
      summary: { subtotal: 2.79, tax: 0, total: 2.79 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    };

    expect(frontendBuild(input).rows.map(row => row.note)).toEqual(['', 'No sugar']);
    expect(backendBuild(input).rows.map(row => row.note)).toEqual(['', 'No sugar']);
    expect(input.items[0].note).toBe('Auto-Gratuity');
  });

  it('keeps backend and frontend exempt presentations JSON-identical', () => {
    const input = {
      items: [{ key: 'meal', name: 'Meal', qty: 1, unitPrice: 17 }],
      summary: { subtotal: 17, tax: 0, total: 17 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive',
      taxExempt: true
    };
    expect(frontendBuild(structuredClone(input))).toEqual(backendBuild(structuredClone(input)));
    expect(frontendBuild(input).summary.taxLabel).toBe('(معفي من الضريبة)');
  });

  it('resolves idle, legacy, valid-v1, and invalid-v1 states without an SFC harness', () => {
    expect(resolveReceiptPresentation({})).toEqual({ presentation: null, error: null, idle: true });
    const legacy = {
      items: [{ key: 'legacy', name: 'Legacy', qty: 1, price: 1 }],
      subtotal: 1, tax: 0, total: 1, discount: 0
    };
    expect(resolveReceiptPresentation(legacy)).toMatchObject({ error: null, idle: false });
    const v1 = frontendBuild({
      items: [{ key: 'v1', name: 'V1', qty: 1, unitPrice: 1 }],
      summary: { subtotal: 1, tax: 0, total: 1 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    expect(resolveReceiptPresentation({ receipt_display_v1: v1 })).toEqual({
      presentation: v1, error: null, idle: false
    });
    const receivable = backendBuild({
      items: [{ key: 'credit', name: 'Credit plan', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 10, tax: 0, total: 10 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive',
      billing: {
        terms: 'receivable', issuedOn: '2026-07-30', dueOn: '2026-08-31',
        invoiceTotal: 10, collectedAmount: 0, outstandingAmount: 10
      }
    });
    expect(resolveReceiptPresentation({ receipt_display_v1: receivable })).toEqual({
      presentation: receivable, error: null, idle: false
    });
    const forgedBilling = structuredClone(receivable);
    forgedBilling.billing.outstandingAmount = 1;
    expect(resolveReceiptPresentation({ receipt_display_v1: forgedBilling })).toMatchObject({
      presentation: null, idle: false,
      error: { code: 'RECEIPT_PRESENTATION_INVALID' }
    });
    const invalid = resolveReceiptPresentation({ receipt_display_v1: { version: 1 } });
    expect(invalid).toMatchObject({ presentation: null, idle: false });
    expect(invalid.error.code).toBe('RECEIPT_PRESENTATION_INVALID');
  });

  it.each(cases)('matches shared vector: $name', ({ input }) => {
    expect(frontendBuild(structuredClone(input))).toEqual(backendBuild(structuredClone(input)));
  });

  it('matches 10k seeded cases and exercises every special path', () => {
    const random = lcg(0x5eedc0de);
    const seen = { fixedLine: 0, percentLine: 0, fixedOrder: 0, percentOrder: 0, inclusive: 0, zeroTax: 0, fractionalQty: 0, serviceCharge: 0, bundle: 0 };
    for (let i = 0; i < 10000; i += 1) {
      const taxInclusive = i % 2 === 0;
      if (taxInclusive) seen.inclusive += 1;
      const count = 1 + Math.floor(random() * 6);
      const financial = [];
      const productMap = new Map();
      for (let j = 0; j < count; j += 1) {
        const discountType = (i + j) % 4 === 0 ? 'fixed' : ((i + j) % 4 === 1 ? 'percent' : null);
        const discountValue = discountType === 'fixed' ? 0.5 : (discountType === 'percent' ? 10 : 0);
        if (discountType === 'fixed') seen.fixedLine += 1;
        if (discountType === 'percent') seen.percentLine += 1;
        const qty = (i + j) % 5 === 0 ? 1.5 : 1 + Math.floor(random() * 3);
        if (!Number.isInteger(qty)) seen.fractionalQty += 1;
        const taxRate = (i + j) % 5 === 0 ? 0 : ((i + j) % 2 === 0 ? 16 : 8);
        if (taxRate === 0) seen.zeroTax += 1;
        const productId = j + 1;
        financial.push({
          key: `p-${i}-${j}`, product_id: productId, name: `P${j}`,
          qty, price: roundMoney(1 + random() * 30), tax_rate: taxRate,
          discountType, discountValue
        });
        productMap.set(productId, { id: productId, tax_rate: taxRate });
      }
      if (i % 3 === 0) {
        const base = financial.reduce((sum, item) => sum + lineNet(item), 0);
        const fee = {
          key: `fee-${i}`, name: '10% Service Charge', note: 'Auto-Gratuity',
          qty: 1, price: roundMoney(base * 0.1), tax_rate: i % 2 ? 8 : 0,
          discountType: null, discountValue: 0
        };
        financial.splice(Math.floor(random() * (financial.length + 1)), 0, fee);
        seen.serviceCharge += 1;
      }
      const orderDiscount = i % 4 === 0
        ? { type: 'fixed', value: 1 }
        : (i % 4 === 1 ? { type: 'percent', value: 15 } : { type: null, value: 0 });
      if (orderDiscount.type === 'fixed') seen.fixedOrder += 1;
      if (orderDiscount.type === 'percent') seen.percentOrder += 1;
      const frontendTotals = posTotals(financial, orderDiscount, { taxInclusive });
      const backendTotals = calculateExpectedTotals({
        order_discount_type: orderDiscount.type,
        order_discount_value: orderDiscount.value
      }, financial, productMap, taxInclusive);
      expect(frontendTotals).toMatchObject({
        subtotal: backendTotals.subtotal,
        tax: backendTotals.tax,
        total: backendTotals.total
      });
      const displayItems = [...financial];
      if (i % 4 === 2) {
        displayItems.splice(1, 0, {
          key: `child-${i}`, kind: 'bundle_child', name: 'Bundle child', qty: 1, unitPrice: 0
        });
        seen.bundle += 1;
      }
      const input = {
        items: displayItems,
        summary: backendTotals,
        orderDiscount: { ...orderDiscount, amount: backendTotals.discount },
        taxMode: taxInclusive ? 'inclusive' : 'exclusive',
        status: 'original'
      };
      expect(frontendBuild(structuredClone(input))).toEqual(backendBuild(structuredClone(input)));
    }
    expect(Object.values(seen).every(count => count > 100)).toBe(true);
  });
});
