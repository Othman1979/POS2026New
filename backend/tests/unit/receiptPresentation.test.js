const cases = require('../fixtures/receiptPresentationCases.json');
const {
  buildReceiptPresentation,
  validateReceiptPresentation,
  normalizeStoredTaxMode,
  receiptTaxMode
} = require('../../services/ReceiptPresentation');
const { buildOrderPresentation, buildHeldPresentations, receiptDisplayInclusive } = require('../../services/ReceiptPresentationSources');

describe('ReceiptPresentation', () => {
  it('prints the full outstanding balance on a historical receivable invoice reprint', () => {
    const model = buildOrderPresentation({
      order: {
        invoice_id: 8, payment_method: 'receivable', invoice_issued_at: '2026-07-30 12:00:00',
        payment_due_on: '2026-08-31', subtotal: 20, tax: 1.6, total: 21.6,
        tax_inclusive_at_sale: 0, discount_type: null, discount_value: 0
      },
      items: [{ id: 1, item_name: 'Monthly Plan', quantity: 1, price_at_sale: 20, tax_rate: 8, tax_amount: 1.6 }]
    });

    expect(model.billing).toEqual({
      terms: 'receivable', issuedOn: '2026-07-30 12:00:00', dueOn: '2026-08-31',
      invoiceTotal: 21.6, collectedAmount: 0, outstandingAmount: 21.6
    });
    expect(validateReceiptPresentation(model)).toBe(true);
  });

  it('does not print an outstanding receivable balance after the invoice is fully refunded', () => {
    const model = buildOrderPresentation({
      order: {
        invoice_id: 9, payment_method: 'receivable', refund_status: 'full',
        invoice_issued_at: '2026-07-30 12:00:00', payment_due_on: '2026-08-31',
        subtotal: 20, tax: 1.6, total: 21.6, tax_inclusive_at_sale: 0,
        discount_type: null, discount_value: 0
      },
      items: [{ id: 1, item_name: 'Monthly Plan', quantity: 1, price_at_sale: 20, tax_rate: 8, tax_amount: 1.6 }]
    });

    expect(model.status).toBe('fully_refunded');
    expect(model).not.toHaveProperty('billing');
  });

  it.each(cases)('$name', ({ input, expected }) => {
    const frozen = structuredClone(input);
    const model = buildReceiptPresentation(input);
    expect(input).toEqual(frozen);
    expect(model.version).toBe(1);
    expect(model.rows.map(row => Math.round(row.netAmount * 100))).toEqual(expected.rowNetCents);
    expect(Math.round(model.summary.orderDiscountAmount * 100)).toBe(expected.discountCents);
    expect(Math.round(model.summary.taxAmount * 100)).toBe(expected.taxCents);
    expect(Math.round(model.summary.roundingAdjustment * 100)).toBe(expected.roundingCents);
    expect(Math.round(model.summary.total * 100)).toBe(expected.totalCents);
    expect(validateReceiptPresentation(model)).toBe(true);
  });

  it('apportions line cents to the authoritative subtotal in stable order', () => {
    const model = buildReceiptPresentation({
      items: [
        { key: 'a', name: 'A', qty: 1, unitPrice: 0.335 },
        { key: 'b', name: 'B', qty: 1, unitPrice: 0.335 },
        { key: 'c', name: 'C', qty: 1, unitPrice: 0.335 }
      ],
      summary: { subtotal: 1.01, tax: 0, total: 1.01 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    });
    expect(model.rows.map(row => row.netAmount)).toEqual([0.33, 0.34, 0.34]);
    expect(model.rows.reduce((sum, row) => sum + Math.round(row.netAmount * 100), 0)).toBe(101);
  });

  it('prints the exact tax-exempt label while keeping the existing tax mode', () => {
    const model = buildReceiptPresentation({
      items: [{ key: 'meal', name: 'Meal', qty: 1, unitPrice: 17 }],
      summary: { subtotal: 17, tax: 0, total: 17 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive',
      taxExempt: true
    });

    expect(model.taxMode).toBe('exclusive');
    expect(model.taxExempt).toBe(true);
    expect(model.summary.taxAmount).toBe(0);
    expect(model.summary.taxLabel).toBe('(معفي من الضريبة)');
    expect(validateReceiptPresentation(model)).toBe(true);
  });

  it('rejects malformed or non-zero tax-exempt summaries', () => {
    const base = {
      items: [{ key: 'meal', name: 'Meal', qty: 1, unitPrice: 17 }],
      summary: { subtotal: 17, tax: 0, total: 17 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    };
    expect(() => buildReceiptPresentation({ ...base, taxExempt: 'true' })).toThrow(/invalid receipt presentation/i);
    expect(() => buildReceiptPresentation({ ...base, taxExempt: true, summary: { ...base.summary, tax: 1.6, total: 18.6 } }))
      .toThrow(/invalid receipt presentation/i);
  });

  it('rejects a header subtotal that cannot come from the supplied rows', () => {
    expect(() => buildReceiptPresentation({
      items: [{ key: 'a', name: 'A', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 8, tax: 0, total: 8 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    })).toThrow(/subtotal does not match receipt rows/i);
  });

  it('apportions one trusted split cent into receipt rows', () => {
    const model = buildReceiptPresentation({
      taxMode: 'exclusive',
      status: 'original',
      summary: { subtotal: 2.04, tax: 0.33, total: 2.37 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      subtotalAllocationToleranceCents: 1,
      items: [{ key: 'half', name: 'Item', qty: 0.5, price: 4.094968 }]
    });

    expect(model.rows[0].netAmount).toBe(2.04);
    expect(model.summary.total).toBe(2.37);
  });

  it('keeps row-to-subtotal validation strict without trusted split allocation', () => {
    expect(() => buildReceiptPresentation({
      taxMode: 'exclusive',
      status: 'original',
      summary: { subtotal: 2.04, tax: 0.33, total: 2.37 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      items: [{ key: 'half', name: 'Item', qty: 0.5, price: 4.094968 }]
    })).toThrow(/subtotal does not match receipt rows/i);
  });

  it('rejects present-but-invalid v1 instead of accepting partial money', () => {
    expect(() => validateReceiptPresentation({ version: 1, rows: [], summary: { total: 1 } }))
      .toThrow(/invalid receipt presentation/i);
  });

  it('uses bit-identical percent-discount arithmetic to PosCalculator', () => {
    const model = buildReceiptPresentation({
      items: [{ key: 'p', name: 'P', qty: 1, unitPrice: 21.15, discountType: 'percent', discountValue: 10 }],
      summary: { subtotal: 19.04, tax: 0, total: 19.04 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    });
    expect(model.rows[0].netAmount).toBe(19.04);
  });

  it.each([
    ['unbounded summary residue', { subtotal: 10, tax: 0, total: 99 }, { type: null, value: 0, amount: 0 }],
    ['negative tax', { subtotal: 10, tax: -1, total: 9 }, { type: null, value: 0, amount: 0 }],
    ['negative discount', { subtotal: 10, tax: 0, total: 10 }, { type: 'fixed', value: -1, amount: -1 }]
  ])('rejects %s', (_name, summary, orderDiscount) => {
    expect(() => buildReceiptPresentation({
      items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 10 }],
      summary, orderDiscount, taxMode: 'exclusive'
    })).toThrow(/invalid receipt presentation/i);
  });

  it('rejects child money and zero-quantity rows during validation', () => {
    const valid = buildReceiptPresentation({
      items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 10, tax: 0, total: 10 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    expect(() => validateReceiptPresentation({
      ...valid, rows: [...valid.rows, { ...valid.rows[0], key: 'child', kind: 'bundle_child', netAmount: 1 }]
    })).toThrow(/invalid receipt presentation/i);
    expect(() => buildReceiptPresentation({
      items: [{ key: 'zero', name: 'Zero', qty: 0, unitPrice: 10 }],
      summary: { subtotal: 0, tax: 0, total: 0 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    })).toThrow(/invalid receipt presentation/i);
  });

  it('rejects numeric-string summary money and non-string row text', () => {
    const valid = buildReceiptPresentation({
      items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 10, tax: 0, total: 10 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    // '10' survives Number.isFinite(Number(v)) but crashes every renderer at
    // subtotal.toFixed — the validator must demand real number types.
    expect(() => validateReceiptPresentation({
      ...valid, summary: { ...valid.summary, subtotal: '10', total: '10' }
    })).toThrow(/invalid receipt presentation/i);
    // A non-string note passes truthiness but crashes at row.note.split.
    expect(() => validateReceiptPresentation({
      ...valid, rows: [{ ...valid.rows[0], note: { a: 1 } }]
    })).toThrow(/invalid receipt presentation/i);
    expect(() => validateReceiptPresentation({
      ...valid, rows: [{ ...valid.rows[0], name: 42 }]
    })).toThrow(/invalid receipt presentation/i);
    expect(() => validateReceiptPresentation({
      ...valid, summary: { ...valid.summary, taxLabel: 7 }
    })).toThrow(/invalid receipt presentation/i);
  });

  it('rejects forged row discount display metadata', () => {
    const valid = buildReceiptPresentation({
      items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 10, tax: 0, total: 10 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    expect(() => validateReceiptPresentation({
      ...valid, rows: [{ ...valid.rows[0], lineDiscountAmount: 11, lineDiscountLabel: '11.00 x 1' }]
    })).toThrow(/invalid receipt presentation/i);
    expect(() => validateReceiptPresentation({
      ...valid, rows: [{ ...valid.rows[0], lineDiscountAmount: 1, lineDiscountLabel: null }]
    })).toThrow(/invalid receipt presentation/i);
    expect(() => validateReceiptPresentation({
      ...valid,
      rows: [...valid.rows, {
        ...valid.rows[0],
        key: 'child',
        kind: 'bundle_child',
        extendedPrice: 0,
        netAmount: 0,
        lineDiscountAmount: 1,
        lineDiscountLabel: '1.00 x 1'
      }]
    })).toThrow(/invalid receipt presentation/i);
  });

  it('does not treat a cart product id as a receipt-row identity', () => {
    const model = buildReceiptPresentation({
      items: [
        { id: 7, name: 'Same product A', qty: 1, unitPrice: 1 },
        { id: 7, name: 'Same product B', qty: 1, unitPrice: 1 }
      ],
      summary: { subtotal: 2, tax: 0, total: 2 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    expect(model.rows.map(row => row.key)).toEqual(['row-0', 'row-1']);
  });
});

describe('receipt tax-mode helpers', () => {
  it('normalizes only explicit stored values', () => {
    expect(normalizeStoredTaxMode(1)).toBe(true);
    expect(normalizeStoredTaxMode('0')).toBe(false);
    expect(normalizeStoredTaxMode(null)).toBeNull();
    expect(normalizeStoredTaxMode(undefined)).toBeNull();
  });

  it('keeps legacy zero-tax history neutral', () => {
    expect(receiptTaxMode({ stored: null, tax: 0 })).toBe('legacy_unknown');
    expect(receiptTaxMode({ stored: null, tax: 1.6 })).toBe('exclusive');
    expect(receiptTaxMode({ stored: 1, tax: 0 })).toBe('inclusive');
    expect(receiptTaxMode({ stored: 0, tax: 0 })).toBe('exclusive');
  });
});

describe('receipt order status mapping', () => {
  it('shows gross item money while preserving the stored exclusive sale total', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 10,
        tax: 1.6,
        total: 11.6,
        tax_inclusive_at_sale: 0,
        receipt_tax_inclusive_at_sale: 1,
        tax_exempt_at_sale: 0,
        discount_type: null,
        discount_value: 0,
        payment_method: 'cash'
      },
      items: [{ id: 1, item_name: 'Meal', quantity: 1, price_at_sale: 10, tax_rate: 16 }]
    });

    expect(presentation.taxMode).toBe('inclusive');
    expect(presentation.rows[0]).toMatchObject({ unitPrice: 11.6, extendedPrice: 11.6, netAmount: 11.6 });
    expect(presentation.summary).toMatchObject({ subtotal: 11.6, taxAmount: 0, total: 11.6 });
  });

  it('resolves the frozen receipt snapshot before historical accounting evidence', () => {
    expect(receiptDisplayInclusive({ receipt_tax_inclusive_at_sale: 1, tax_inclusive_at_sale: 0, tax: 1.6 })).toBe('inclusive');
    expect(receiptDisplayInclusive({ receipt_tax_inclusive_at_sale: 0, tax_inclusive_at_sale: 1, tax: 0 })).toBe('exclusive');
    expect(receiptDisplayInclusive({ tax_inclusive_at_sale: 1, tax: 0 })).toBe('inclusive');
    expect(receiptDisplayInclusive({ tax: 1.6 })).toBe('exclusive');
    expect(receiptDisplayInclusive({ tax: 0 })).toBe('legacy_unknown');
  });

  it('shows a truthful gross order discount for a discounted exclusive sale', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 20,
        tax: 1.6,
        total: 11.6,
        tax_inclusive_at_sale: 0,
        receipt_tax_inclusive_at_sale: 1,
        tax_exempt_at_sale: 0,
        discount_type: 'percent',
        discount_value: 50,
        payment_method: 'cash'
      },
      items: [
        { id: 1, item_name: 'Meal A', quantity: 1, price_at_sale: 10, tax_rate: 16 },
        { id: 2, item_name: 'Meal B', quantity: 1, price_at_sale: 10, tax_rate: 16 }
      ]
    });

    expect(presentation.rows.map(row => row.netAmount)).toEqual([11.6, 11.6]);
    expect(presentation.summary).toMatchObject({ subtotal: 23.2, orderDiscountAmount: 11.6, taxAmount: 0, total: 11.6 });
  });

  it('keeps fractional gross rows precise without inventing an order discount', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 1,
        tax: 0.16,
        total: 1.16,
        tax_inclusive_at_sale: 0,
        receipt_tax_inclusive_at_sale: 1,
        tax_exempt_at_sale: 0,
        discount_type: null,
        discount_value: 0,
        payment_method: 'cash'
      },
      items: [{ id: 1, item_name: 'Fractional item', quantity: 100, price_at_sale: 0.01, tax_rate: 16 }]
    });

    expect(presentation.rows[0]).toMatchObject({ unitPrice: 0.01, extendedPrice: 1.16, netAmount: 1.16 });
    expect(presentation.summary).toMatchObject({
      subtotal: 1.16,
      orderDiscountAmount: 0,
      roundingAdjustment: 0,
      total: 1.16
    });
  });

  it('preserves fractional quantities when converting net prices to customer gross prices', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 0.05,
        tax: 0.01,
        total: 0.06,
        tax_inclusive_at_sale: 0,
        receipt_tax_inclusive_at_sale: 1,
        discount_type: null,
        discount_value: 0,
      },
      items: [{
        id: 1,
        item_name: 'Weighted item',
        quantity: 0.5,
        price_at_sale: 0.1,
        tax_rate: 16,
        discount_type: null,
        discount_value: 0,
      }],
    });

    expect(presentation.rows[0]).toMatchObject({ qty: 0.5, extendedPrice: 0.06, netAmount: 0.06 });
    expect(presentation.summary).toMatchObject({ subtotal: 0.06, orderDiscountAmount: 0, total: 0.06 });
  });

  it('uses the frozen split receipt snapshot instead of the accounting flag', async () => {
    const [entry] = await buildHeldPresentations({
      query: async (sql) => {
        if (sql.includes('FROM order_items')) return [[{ id: 7, tax_rate: 16 }]];
        throw new Error(`Unexpected query: ${sql}`);
      }
    }, [{
      id: 9,
      cart_data: JSON.stringify({
        tax_context_version: 1,
        is_split: true,
        parent_invoice_id: 4,
        tax_inclusive_at_sale: 0,
        receipt_tax_inclusive_at_hold: 1,
        tax_registration_type_at_sale: 'sales_tax',
        split_money_cents: { subtotal: 1000, discount: 0, tax: 160, total: 1160 },
        items: [{ order_item_id: 7, product_id: 1, name: 'Split item', qty: 1, price: 10, tax_rate: 16 }]
      })
    }], { split: true });

    expect(entry.error).toBeNull();
    expect(entry.presentation.taxMode).toBe('inclusive');
    expect(entry.presentation.rows[0]).toMatchObject({ unitPrice: 11.6, netAmount: 11.6 });
    expect(entry.presentation.summary).toMatchObject({ subtotal: 11.6, taxAmount: 0, total: 11.6 });
  });

  it('keeps gross line discounts, mixed tax rates, service charge, and bundle children truthful', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 45.8,
        tax: 4.93,
        total: 50.73,
        tax_inclusive_at_sale: 0,
        receipt_tax_inclusive_at_sale: 1,
        discount_type: null,
        discount_value: 0,
        payment_method: 'cash'
      },
      items: [
        { id: 1, item_name: 'Fixed', quantity: 2, price_at_sale: 10, tax_rate: 16, discount_type: 'fixed', discount_value: 2 },
        { id: 2, item_name: 'Percent', quantity: 1, price_at_sale: 10, tax_rate: 16, discount_type: 'percent', discount_value: 10 },
        { id: 3, item_name: 'Zero rated', quantity: 1, price_at_sale: 10, tax_rate: 8 },
        { id: 4, item_name: 'Outside scope', quantity: 1, price_at_sale: 10, tax_rate: 0 },
        { id: 5, item_name: '10% Service Charge', quantity: 1, price_at_sale: 0.8, tax_rate: 16, note: 'Auto-Gratuity' },
        { id: 6, item_name: 'Bundle child', quantity: 1, price_at_sale: 0, tax_rate: 0, parent_item_id: 1 }
      ]
    });

    expect(presentation.rows.map(row => row.netAmount)).toEqual([18.56, 10.44, 10.8, 10, 0.93, 0]);
    expect(presentation.rows[0]).toMatchObject({ unitPrice: 11.6, lineDiscountAmount: 4.64, lineDiscountLabel: '2.32 x 2' });
    expect(presentation.rows[1]).toMatchObject({ unitPrice: 11.6, lineDiscountAmount: 1.16, lineDiscountLabel: '10%' });
    expect(presentation.rows[4].note).toBe('');
    expect(presentation.rows[5]).toMatchObject({ kind: 'bundle_child', unitPrice: 0, netAmount: 0, lineDiscountAmount: 0 });
    expect(presentation.summary).toMatchObject({ subtotal: 50.73, taxAmount: 0, total: 50.73 });
  });

  it('keeps an old accounting-inclusive order byte-compatible when no receipt snapshot exists', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 11.6,
        tax: 0,
        total: 11.6,
        tax_inclusive_at_sale: 1,
        receipt_tax_inclusive_at_sale: null,
        tax_exempt_at_sale: 0,
        discount_type: null,
        discount_value: 0,
        payment_method: 'cash'
      },
      items: [{ id: 1, item_name: 'Meal', quantity: 1, price_at_sale: 11.6, tax_rate: 16 }]
    });

    expect(presentation.taxMode).toBe('inclusive');
    expect(presentation.rows[0].unitPrice).toBe(11.6);
    expect(presentation.summary).toMatchObject({ subtotal: 11.6, taxAmount: 0, total: 11.6 });
  });

  it('does not invent tax for exempt or income-tax receipts', () => {
    const exempt = buildOrderPresentation({
      order: {
        subtotal: 10, tax: 0, total: 10,
        tax_inclusive_at_sale: 0, receipt_tax_inclusive_at_sale: 1,
        tax_exempt_at_sale: 1, tax_registration_type_at_sale: 'sales_tax',
        discount_type: null, discount_value: 0, payment_method: 'cash'
      },
      items: [{ id: 1, item_name: 'Exempt', quantity: 1, price_at_sale: 10, tax_rate: 16 }]
    });
    const income = buildOrderPresentation({
      order: {
        subtotal: 10, tax: 0, total: 10,
        tax_inclusive_at_sale: 0, receipt_tax_inclusive_at_sale: 1,
        tax_exempt_at_sale: 0, tax_registration_type_at_sale: 'income_tax',
        discount_type: null, discount_value: 0, payment_method: 'cash'
      },
      items: [{ id: 2, item_name: 'Income-tax item', quantity: 1, price_at_sale: 10, tax_rate: 16 }]
    });

    expect(exempt.rows[0].unitPrice).toBe(10);
    expect(exempt.summary).toMatchObject({ subtotal: 10, taxAmount: 0, total: 10 });
    expect(income.rows[0].unitPrice).toBe(10);
    expect(income.summary).toMatchObject({ subtotal: 10, taxAmount: 0, total: 10 });
  });

  it('shows a tiny real order discount on a gross receipt instead of absorbing it as rounding', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 0.15, tax: 0.02, total: 0.16,
        tax_inclusive_at_sale: 0, receipt_tax_inclusive_at_sale: 1, tax_exempt_at_sale: 0,
        discount_type: 'percent', discount_value: 10, payment_method: 'cash'
      },
      items: [{ id: 1, item_name: 'Mint', quantity: 1, price_at_sale: 0.15, tax_rate: 16 }]
    });

    expect(presentation.summary).toMatchObject({ orderDiscountAmount: 0.01, roundingAdjustment: 0, total: 0.16 });
  });

  it('grosses up only the taxed part of a row carrying a legacy untaxed modifier surcharge', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 5.5, tax: 0.8, total: 6.3,
        tax_inclusive_at_sale: 0, receipt_tax_inclusive_at_sale: 1, tax_exempt_at_sale: 0,
        discount_type: null, discount_value: 0, payment_method: 'cash'
      },
      items: [{
        id: 1, item_name: 'Burger', quantity: 1, price_at_sale: 5.5, tax_rate: 16,
        modifier_surcharge: 0.5, modifier_tax_amount: null
      }]
    });

    expect(presentation.rows[0]).toMatchObject({ unitPrice: 6.3, netAmount: 6.3 });
    expect(presentation.summary).toMatchObject({ orderDiscountAmount: 0, roundingAdjustment: 0, total: 6.3 });
  });

  it('restores the original tax on a voided taxed order receipt', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 0, tax: 0, total: 0,
        original_subtotal: 10, original_tax: 1.6, original_total: 11.6,
        tax_inclusive_at_sale: 0, tax_exempt_at_sale: 0,
        discount_type: null, discount_value: 0, payment_method: 'voided'
      },
      items: [{ id: 1, item_name: 'Meal', quantity: 1, price_at_sale: 10, tax_rate: 16 }]
    });

    expect(presentation.status).toBe('voided');
    expect(presentation.summary).toMatchObject({ taxAmount: 1.6, total: 11.6, roundingAdjustment: 0 });
  });

  it('keeps the full row price of a tax-exempt sale whose row has a modifier tax snapshot', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 5.5, tax: 0, total: 5.5,
        tax_inclusive_at_sale: 0, tax_exempt_at_sale: 1,
        discount_type: null, discount_value: 0, payment_method: 'cash'
      },
      items: [{
        id: 1, item_name: 'Burger', quantity: 1, price_at_sale: 5.5, tax_rate: 16,
        modifier_surcharge: 0.5, modifier_tax_amount: 0.08
      }]
    });

    expect(presentation.rows[0].netAmount).toBe(5.5);
    expect(presentation.summary).toMatchObject({ subtotal: 5.5, taxAmount: 0, total: 5.5 });
  });

  it.each([
    ['partial', 'partially_refunded'],
    ['full', 'fully_refunded']
  ])('maps stored refund status %s to %s', (stored, expected) => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 5,
        tax: 0,
        total: 5,
        payment_method: 'cash',
        refund_status: stored,
        discount_type: null,
        discount_value: 0,
        tax_inclusive_at_sale: 0
      },
      items: [{ id: 1, item_name: 'Item', quantity: 1, price_at_sale: 5, tax_rate: 0 }]
    });

    expect(presentation.status).toBe(expected);
  });

  it('uses a finalized split child stored cents instead of re-deriving its discount', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 2.04,
        tax: 0.33,
        total: 2.27,
        parent_invoice_id: 10,
        payment_method: 'cash',
        discount_type: null,
        discount_value: 0,
        tax_inclusive_at_sale: 0
      },
      items: [{ id: 1, item_name: 'Half item', quantity: 0.5, price_at_sale: 4.094968, tax_rate: 16 }]
    });

    expect(presentation.rows[0].netAmount).toBe(2.04);
    expect(presentation.summary.orderDiscountAmount).toBe(0.10);
    expect(presentation.summary.total).toBe(2.27);
  });

  it('does not grant split cent tolerance to an ordinary finalized order', () => {
    expect(() => buildOrderPresentation({
      order: {
        subtotal: 2.04,
        tax: 0.33,
        total: 2.37,
        parent_invoice_id: null,
        payment_method: 'cash',
        discount_type: null,
        discount_value: 0,
        tax_inclusive_at_sale: 0
      },
      items: [{ id: 1, item_name: 'Half item', quantity: 0.5, price_at_sale: 4.094968, tax_rate: 16 }]
    })).toThrow(/subtotal does not match receipt rows/i);
  });

  it('uses persisted charged prices directly for exempt paid orders', () => {
    const presentation = buildOrderPresentation({
      order: {
        subtotal: 17, tax: 0, total: 17, payment_method: 'cash',
        tax_inclusive_at_sale: 1, tax_exempt_at_sale: 1,
        discount_type: null, discount_value: 0
      },
      items: [{ id: 1, item_name: 'Meal', quantity: 1, price_at_sale: 17, tax_rate: 16 }]
    });

    expect(presentation.taxExempt).toBe(true);
    expect(presentation.rows[0].unitPrice).toBe(17);
    expect(presentation.summary).toMatchObject({ subtotal: 17, taxAmount: 0, total: 17 });
  });

  it('derives a raw inclusive held price once before building the exempt receipt', async () => {
    const [entry] = await buildHeldPresentations({ query: async () => { throw new Error('unexpected catalog query'); } }, [{
      id: 1,
      cart_data: JSON.stringify({
        tax_context_version: 1,
        tax_inclusive_at_hold: 1,
        tax_exempt_at_hold: true,
        items: [{ id: 7, name: 'Meal', price: 20, qty: 1, tax_rate: 16 }]
      })
    }]);

    expect(entry.error).toBeNull();
    expect(entry.presentation.taxExempt).toBe(true);
    expect(entry.presentation.summary.taxAmount).toBe(0);
    expect(entry.presentation.rows[0].unitPrice).toBe(17.24);
    expect(entry.presentation.summary.total).toBe(17.24);
  });
  describe('item notes survive into the receipt row', () => {
    const order = {
      invoice_id: 1, subtotal: 2.70, tax: 0, total: 2.70,
      discount_type: null, discount_value: 0, tax_inclusive_at_sale: 0,
      tax_exempt_at_sale: 0, tax_registration_type_at_sale: 'sales_tax',
      payment_method: 'cash', parent_invoice_id: null
    };
    const paidRow = (note) => buildOrderPresentation({
      order,
      items: [{ id: 5, item_name: 'Burger', quantity: 1, price_at_sale: 2.70, tax_rate: 0, note }]
    }).rows[0];

    const heldRow = async (note, split) => {
      const [entry] = await buildHeldPresentations({
        query: async (sql) => {
          // buildHeldPresentations reads the tax-mode setting before the items.
          // Omit this branch and the stub throws before the mapper is reached.
          if (sql.includes('FROM settings')) return [[{ setting_value: '0' }]];
          if (sql.includes('FROM order_items')) return [[{ id: 7, tax_rate: 0 }]];
          throw new Error(`Unexpected query: ${sql}`);
        }
      }, [{
        id: 9,
        reference_name: split ? 'Table 4 / Seat 1' : 'Hold 9',
        cart_data: JSON.stringify({
          items: [{ id: 7, name: 'Burger', qty: 1, price: 2.70, tax_rate: 0, note }],
          subtotal: 2.70, tax: 0, total: 2.70
        })
      }], { split });
      return entry.presentation.rows[0];
    };

    it('copies a typed note onto a paid receipt row', () => {
      expect(paidRow('No onion').note).toBe('No onion');
    });

    it('keeps a multi-line note mixing manual text and a priced note', () => {
      const multiLine = ['No onion', 'Two slices (+0.20)'].join('\n');
      expect(paidRow(multiLine).note).toBe(multiLine);
    });

    it('keeps manual text, formal modifiers, and note-category choices in a stable customer-facing order', () => {
      const row = buildOrderPresentation({
        order,
        items: [{
          id: 5, item_name: 'Burger', quantity: 1, price_at_sale: 2.70, tax_rate: 0,
          note: 'Size: Large (0.50 JD)\nNo onion\nTwo slices (+0.20)',
          selected_modifiers: JSON.stringify([
            { gid: 'size', oid: 'large', group: 'Size', option: 'Large', price: 0.5 },
            { noteProductId: 91, group: 'Two slices', option: 'Two slices', price: 0.2 }
          ])
        }]
      }).rows[0];

      expect(row.note).toBe('No onion\nSize: Large (0.50 JD)\nTwo slices (+0.20)');
    });

    it('does not duplicate a legacy priced-note snapshot on reprint', () => {
      const row = buildOrderPresentation({
        order,
        items: [{
          id: 5, item_name: 'Burger', quantity: 1, price_at_sale: 2.70, tax_rate: 0,
          note: 'No onion\nTwo slices (+0.20)',
          selected_modifiers: JSON.stringify([
            { group: 'Two slices', option: 'Two slices', price: 0.2 }
          ])
        }]
      }).rows[0];

      expect(row.note).toBe('No onion\nTwo slices (+0.20)');
    });

    it('still suppresses the Auto-Gratuity marker', () => {
      expect(paidRow('Auto-Gratuity').note).toBe('');
    });

    it('leaves a row with no note as an empty string', () => {
      expect(paidRow(null).note).toBe('');
    });

    it('copies a typed note onto a held check row', async () => {
      expect((await heldRow('No onion', false)).note).toBe('No onion');
    });

    it('copies a typed note onto a split check row', async () => {
      expect((await heldRow('No onion', true)).note).toBe('No onion');
    });

    it('suppresses Auto-Gratuity on a held check row', async () => {
      expect((await heldRow('Auto-Gratuity', false)).note).toBe('');
    });
  });
});
