const crypto = require('crypto');
const {
    buildInvoiceSnapshot, buildSalesSnapshot, renderInvoiceXml, renderSalesInvoiceXml,
    buildCreditNoteSnapshot, renderCreditNoteXml, previewIdentity
} = require('../../services/JofotaraXmlBuilder');

const seller = { incomeSourceSequence: '123', taxNumber: '987654321', registeredName: 'مطعم الاختبار' };
const order = overrides => ({
    invoice_id: 41, invoice_number: 501, created_at: '2026-07-21T09:00:00.000Z',
    subtotal: 5.14, tax: 0.41, total: 5.55, payment_method: 'cash',
    tax_inclusive_at_sale: 0, discount_type: null, discount_value: 0, note: '', ...overrides
});
const item = overrides => ({
    id: 1, parent_item_id: null, item_name: 'برغر & جبنة', quantity: 1,
    price_at_sale: 5.15, tax_rate: 8, tax_amount: 0.411111,
    modifier_surcharge: 0.15, modifier_tax_amount: 0.011111,
    discount_type: null, discount_value: 0, ...overrides
});

describe('JoFotara sales XML', () => {
    it('uses the local calendar issue date, not the UTC date or business-day cutoff', () => {
        const snapshot = buildSalesSnapshot({ order: order({invoice_issued_at:'2026-07-21 23:30:00'}), items:[item()], seller });
        expect(snapshot.issueDate).toBe('2026-07-22');
    });
    it.each([
        [2.05, 0.33, 2.38],
        [2.04, 0.33, 2.37]
    ])('renders an allocated split child payable at %s + %s tax = %s', (subtotal, tax, total) => {
        const snapshot = buildSalesSnapshot({
            order: order({ subtotal, tax, total, parent_invoice_id: 40 }),
            items: [item({
                quantity: 0.5,
                price_at_sale: 4.092,
                tax_rate: 16,
                tax_amount: tax,
                modifier_surcharge: null,
                modifier_tax_amount: null
            })],
            seller
        });
        const xml = renderSalesInvoiceXml(snapshot, previewIdentity(Math.round(total * 100)));
        expect(snapshot.totals.payable).toBe(total);
        expect(snapshot.totals.tax).toBe(tax);
        expect(snapshot.lines.reduce((sum, line) => sum + line.tax, 0)).toBeCloseTo(tax, 9);
        expect(snapshot.lines[0].extension + snapshot.lines[0].tax).toBe(snapshot.lines[0].payable);
        expect(Math.abs(
            snapshot.lines[0].quantity * snapshot.lines[0].unitPrice -
            snapshot.lines[0].allowance - snapshot.lines[0].extension
        )).toBeLessThanOrEqual(0.001);
        expect(xml).toContain('<cbc:InvoicedQuantity unitCode="PCE">0.500000</cbc:InvoicedQuantity>');
        expect(xml).toContain(`<cbc:PayableAmount currencyID="JO">${total.toFixed(6)}</cbc:PayableAmount>`);
    });

    it('folds an inclusive-tax modifier into the parent legal line', () => {
        const snapshot = buildSalesSnapshot({ order: order(), items: [item()], seller, customer: null });
        expect(snapshot.documentNumber).toBe('501');
        expect(snapshot.lines).toHaveLength(1);
        expect(snapshot.lines[0].gross).toBeCloseTo(5.138889, 6);
        expect(snapshot.lines[0].tax).toBeCloseTo(0.411111, 6);
        expect(snapshot.lines[0].payable).toBeCloseTo(5.55, 6);
    });

    it('excludes bundle child rows and prorates order discounts', () => {
        const items = [
            item({ price_at_sale: 5, modifier_surcharge: null, modifier_tax_amount: null, tax_rate: 0, tax_amount: 0 }),
            item({ id: 2, item_name: 'Drink', price_at_sale: 5, modifier_surcharge: null, modifier_tax_amount: null, tax_rate: 0, tax_amount: 0 }),
            item({ id: 3, parent_item_id: 1, item_name: 'Bundle child', price_at_sale: 99 })
        ];
        const snapshot = buildSalesSnapshot({ order: order({ subtotal: 10, tax: 0, total: 9, discount_type: 'percent', discount_value: 10 }), items, seller });
        expect(snapshot.lines).toHaveLength(2);
        expect(snapshot.lines.map(line => line.allowance)).toEqual([0.5, 0.5]);
        expect(snapshot.totals.payable).toBe(9);
    });

    it('reconstructs tax for tax-inclusive prices', () => {
        const snapshot = buildSalesSnapshot({
            order: order({ subtotal: 5.4, tax: 0, total: 5.4, tax_inclusive_at_sale: 1 }),
            items: [item({ price_at_sale: 5.4, tax_rate: 8, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })], seller
        });
        expect(snapshot.lines[0].extension).toBeCloseTo(5, 8);
        expect(snapshot.lines[0].tax).toBeCloseTo(0.4, 8);
    });

    it('keeps exempt sales net and classifies every exempt line as Z', () => {
        const snapshot = buildSalesSnapshot({
            order: order({
                subtotal: 20, tax: 0, total: 20, tax_inclusive_at_sale: 1, tax_exempt_at_sale: 1
            }),
            items: [
                item({ id: 1, price_at_sale: 17, quantity: 1, tax_rate: 16, jofotara_tax_category: 'Z', tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 2, item_name: 'Zero rated', price_at_sale: 3, quantity: 1, tax_rate: 0, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })
            ],
            seller
        });

        expect(snapshot.lines.map(line => line.taxCategory)).toEqual(['Z', 'Z']);
        expect(snapshot.lines.map(line => line.taxRate)).toEqual([0, 0]);
        expect(snapshot.totals).toMatchObject({ taxExclusive: 20, tax: 0, taxInclusive: 20, payable: 20 });
        const xml = renderSalesInvoiceXml(snapshot, previewIdentity(41));
        expect(xml).toContain('<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">Z</cbc:ID>');
        expect(xml).toContain('<cbc:TaxAmount currencyID="JO">0.000000</cbc:TaxAmount>');
    });

    it('reconciles exempt receipt rounding without inventing negative tax', () => {
        const snapshot = buildSalesSnapshot({
            order: order({
                subtotal: 19.13, tax: 0, total: 19.13, tax_inclusive_at_sale: 1, tax_exempt_at_sale: 1
            }),
            items: [
                item({ id: 1, price_at_sale: 17.391379, quantity: 1, tax_rate: 16, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 2, item_name: '10% Service Charge', price_at_sale: 1.74, quantity: 1, tax_rate: 0, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })
            ],
            seller
        });

        expect(snapshot.totals).toMatchObject({ tax: 0, taxInclusive: 19.13, payable: 19.13 });
        expect(snapshot.lines.every(line => line.tax === 0)).toBe(true);
        expect(snapshot.lines.reduce((sum, line) => sum + line.payable, 0)).toBeCloseTo(19.13, 8);
        expect(renderSalesInvoiceXml(snapshot, previewIdentity(42))).not.toContain('<cbc:TaxAmount currencyID="JO">-');
    });

    it('classifies a configured zero-rated sales line as O', () => {
        const snapshot = buildSalesSnapshot({
            order: order({ subtotal: 3, tax: 0, total: 3 }),
            items: [item({ price_at_sale: 3, tax_rate: 0, jofotara_tax_category: 'O', tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })],
            seller
        });
        expect(snapshot.lines[0]).toMatchObject({ taxCategory: 'O', taxRate: 0 });
    });

    it('classifies mixed standard, exempt, and zero-rated lines independently', () => {
        const snapshot = buildSalesSnapshot({
            order: order({ subtotal: 15, tax: 0.8, total: 15.8 }),
            items: [
                item({ id: 1, price_at_sale: 10, tax_rate: 8, tax_amount: 0.8, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 2, item_name: 'Zero rate', price_at_sale: 3, tax_rate: 0, jofotara_tax_category: 'O', tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 3, item_name: 'Exempt', price_at_sale: 2, tax_rate: 0, jofotara_tax_category: 'Z', tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })
            ],
            seller
        });

        expect(snapshot.lines.map(line => line.taxCategory)).toEqual(['S', 'O', 'Z']);
    });

    it('preserves positive configured sales rates and uses S after reconciliation', () => {
        const snapshot = buildSalesSnapshot({
            order: order({ subtotal: 10, tax: 0.8, total: 10.8, parent_invoice_id: 40 }),
            items: [item({ price_at_sale: 10, tax_rate: 8, tax_amount: 0.8, modifier_surcharge: null, modifier_tax_amount: null })],
            seller
        });
        expect(snapshot.lines[0]).toMatchObject({ taxCategory: 'S', taxRate: 8 });
        expect(renderSalesInvoiceXml(snapshot, previewIdentity(42))).toContain('<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>');
        expect(renderSalesInvoiceXml(snapshot, previewIdentity(42))).toContain('<cbc:Percent>8.00</cbc:Percent>');
    });

    it('keeps the configured service-charge tax rate when receipt rounding is reconciled', () => {
        const snapshot = buildSalesSnapshot({
            order: order({
                subtotal: 1.89,
                tax: 0.14,
                total: 1.09,
                tax_inclusive_at_sale: 0,
                discount_type: 'percent',
                discount_value: 50
            }),
            items: [
                item({ id: 1, price_at_sale: 0.862069, quantity: 1, tax_rate: 16, tax_amount: 0.068966, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 2, price_at_sale: 0.862069, quantity: 1, tax_rate: 16, tax_amount: 0.068966, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 3, item_name: '10% Service Charge', price_at_sale: 0.17, quantity: 1, tax_rate: 8, tax_amount: 0.0068, note: 'Auto-Gratuity', modifier_surcharge: null, modifier_tax_amount: null })
            ],
            seller
        });

        const serviceCharge = snapshot.lines[2];
        expect(serviceCharge.itemName).toBe('رسوم خدمة');
        expect(serviceCharge.taxRate).toBe(8);
        expect(serviceCharge.tax).toBeCloseTo(serviceCharge.extension * 0.08, 8);
        expect(snapshot.totals.payable).toBe(1.09);
        const xml = renderSalesInvoiceXml(snapshot, previewIdentity(43));
        expect(xml).toContain('<cbc:Name>رسوم خدمة</cbc:Name>');
        expect(xml).toContain('<cbc:Percent>8.00</cbc:Percent>');
    });

    it('applies a fixed line discount once per unit on a multi-quantity line', () => {
        const snapshot = buildSalesSnapshot({
            order: order({ subtotal: 4.5, tax: 0.72, total: 5.22 }),
            items: [item({ quantity: 3, price_at_sale: 2, tax_rate: 16, tax_amount: 0.72, discount_type: 'fixed', discount_value: 0.5, modifier_surcharge: null, modifier_tax_amount: null })],
            seller
        });
        expect(snapshot.lines[0]).toMatchObject({ gross: 6, allowance: 1.5, extension: 4.5, tax: 0.72, payable: 5.22 });
        expect(snapshot.totals.payable).toBe(5.22);
    });

    it('prorates a fixed order discount across lines by their net value', () => {
        const snapshot = buildSalesSnapshot({
            order: order({ subtotal: 4, tax: 0.48, total: 3.48, discount_type: 'fixed', discount_value: 1 }),
            items: [
                item({ id: 1, price_at_sale: 3, tax_rate: 16, tax_amount: 0.36, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 2, item_name: 'Drink', price_at_sale: 1, tax_rate: 16, tax_amount: 0.12, modifier_surcharge: null, modifier_tax_amount: null })
            ],
            seller
        });
        expect(snapshot.lines.map(line => line.allowance)).toEqual([0.75, 0.25]);
        expect(snapshot.totals.payable).toBe(3.48);
    });

    it('refuses an invoice whose lines are more than the last-line reconcile away from the saved total', () => {
        expect(() => buildSalesSnapshot({
            order: order({ subtotal: 10, tax: 0.8, total: 10.77 }),
            items: [item({ price_at_sale: 10, tax_rate: 8, tax_amount: 0.8, modifier_surcharge: null, modifier_tax_amount: null })],
            seller
        })).toThrowError(expect.objectContaining({ publicCode: 'JOFOTARA_TOTAL_MISMATCH' }));
    });

    it('requires a named buyer only for anonymous invoices above JOD 10,000', () => {
        const invoiceOf = total => buildInvoiceSnapshot({
            profile: 'sales_tax', order: order({ subtotal: total, tax: 0, total }),
            items: [item({ price_at_sale: total, tax_rate: 0, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })],
            seller, customer: null
        });
        expect(invoiceOf(10000).totals.payable).toBe(10000);
        expect(() => invoiceOf(10000.01)).toThrowError(expect.objectContaining({ publicCode: 'JOFOTARA_CUSTOMER_REQUIRED' }));
    });

    it('uses numeric TN/0 and the cash-customer name for anonymous buyers in both profiles', () => {
        for (const profile of ['sales_tax', 'income_tax']) {
            const snapshot = buildInvoiceSnapshot({
                profile, order: order({ tax: profile === 'sales_tax' ? 0.8 : 0, total: profile === 'sales_tax' ? 10.8 : 10 }),
                items: [item({ price_at_sale: 10, tax_rate: profile === 'sales_tax' ? 8 : 0, tax_amount: profile === 'sales_tax' ? 0.8 : 0 })],
                seller, customer: { name: '   ' }
            });
            expect(snapshot.customer.id).toBe('0');
            const xml = renderInvoiceXml(snapshot, previewIdentity(43));
            expect(xml).toContain('<cbc:ID schemeID="TN">0</cbc:ID>');
            expect(xml).toContain('<cac:PartyTaxScheme><cbc:CompanyID>0</cbc:CompanyID>');
            expect(xml).toContain('<cbc:IdentificationCode>JO</cbc:IdentificationCode>');
            expect(xml).toContain('<cbc:RegistrationName>Cash customer</cbc:RegistrationName>');
        }
    });

    it('rejects unsupported positive sales rates before building a legal snapshot', () => {
        expect(() => buildSalesSnapshot({
            order: order({ subtotal: 10, tax: 0.65, total: 10.65 }),
            items: [item({ price_at_sale: 10, tax_rate: 6.5, tax_amount: 0.65 })],
            seller
        })).toThrowError(expect.objectContaining({ publicCode: 'JOFOTARA_UNSUPPORTED_RATE' }));
    });

    it('renders production UBL codes, escaped Arabic content, and deterministic preview identity', () => {
        const snapshot = buildSalesSnapshot({ order: order(), items: [item()], seller });
        const identity = previewIdentity(41);
        const xml = renderSalesInvoiceXml(snapshot, identity);
        expect(xml).toContain('<cbc:InvoiceTypeCode name="012">388</cbc:InvoiceTypeCode>');
        expect(xml).toContain('<cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>');
        expect(xml).toContain('برغر &amp; جبنة');
        expect(xml).toContain(`<cbc:UUID>${identity.uuid}</cbc:UUID>`);
    });

    it('renders an explicit sales-tax receivable as 022 and requires a named frozen buyer', () => {
        const snapshot = buildInvoiceSnapshot({
            profile: 'sales_tax',
            paymentTerms: 'receivable',
            order: order({ payment_method: 'receivable' }),
            items: [item()],
            seller,
            customer: { name: 'Frozen Buyer', phone: '0790000000', address: 'Amman' }
        });
        const xml = renderInvoiceXml(snapshot, previewIdentity(41));

        expect(snapshot.invoiceTypeName).toBe('022');
        expect(snapshot.paymentTerms).toBe('receivable');
        expect(snapshot.customer).toMatchObject({ name: 'Frozen Buyer', phone: '0790000000', address: 'Amman' });
        expect(xml).toContain('<cbc:InvoiceTypeCode name="022">388</cbc:InvoiceTypeCode>');
        expect(() => buildInvoiceSnapshot({
            profile: 'sales_tax', paymentTerms: 'receivable', order: order(), items: [item()], seller, customer: null
        })).toThrowError(expect.objectContaining({ publicCode: 'JOFOTARA_RECEIVABLE_BUYER_REQUIRED' }));
    });

    it('renders saved refunds as credit notes referencing the accepted original', () => {
        const originalSnapshot = buildSalesSnapshot({
            order: order({ payment_method: 'receivable' }), items: [item()], seller,
            paymentTerms: 'receivable', customer: { name: 'Frozen Buyer' }
        });
        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 9, kind: 'refund', reason: 'خطأ في الطلب', amount_refunded: 5.55, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 1, item_name: 'برغر', quantity: 1, unit_price: 5.15, line_subtotal: 5.14, line_tax: 0.41, line_total: 5.55 }],
            originalSnapshot, originalDocument: { document_uuid: crypto.randomUUID() }, seller
        });
        const xml = renderCreditNoteXml(snapshot, { uuid: crypto.randomUUID(), icv: '99' });
        expect(xml).toContain('<cbc:InvoiceTypeCode name="022">381</cbc:InvoiceTypeCode>');
        expect(xml).toContain('<cac:BillingReference>');
        expect(xml).toContain('<cbc:TaxableAmount currencyID="JO">5.138889</cbc:TaxableAmount>');
        expect(xml).toContain('<cbc:PrepaidAmount currencyID="JO">0.000000</cbc:PrepaidAmount>');
        expect(xml).toContain('<cbc:InstructionNote>خطأ في الطلب</cbc:InstructionNote>');
    });

    it('uses a legal fallback reason when an older saved refund has no reason', () => {
        const originalSnapshot = buildSalesSnapshot({ order: order(), items: [item()], seller });
        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 15, kind: 'refund', reason: null, amount_refunded: 5.55, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 1, item_name: 'برغر', quantity: 1, unit_price: 5.15, line_subtotal: 5.14, line_tax: 0.41, line_total: 5.55 }],
            originalSnapshot,
            originalDocument: { document_uuid: crypto.randomUUID() },
            seller
        });

        expect(snapshot.reason).toBe('إرجاع فاتورة');
        expect(renderCreditNoteXml(snapshot, { uuid: crypto.randomUUID(), icv: '103' }))
            .toContain('<cbc:InstructionNote>إرجاع فاتورة</cbc:InstructionNote>');
    });

    it('copies the accepted legal amounts for a full return instead of rounded refund amounts', () => {
        const originalSnapshot = buildSalesSnapshot({
            order: order({ subtotal: 0.862069, tax: 0.137931, total: 1 }),
            items: [item({ price_at_sale: 0.862069, tax_rate: 16, tax_amount: 0.137931, modifier_surcharge: null, modifier_tax_amount: null })],
            seller
        });
        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 16, kind: 'refund', reason: 'Return', amount_refunded: 1, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 1, quantity: 1, line_subtotal: 0.86, line_tax: 0.14, line_total: 1 }],
            originalSnapshot,
            originalDocument: { document_uuid: crypto.randomUUID() },
            seller
        });

        expect(snapshot.lines[0]).toMatchObject({ extension: 0.862069, tax: 0.137931, payable: 1, allowance: 0 });
    });

    it('uses original payment terms and frozen categories/rates for mixed-rate returns', () => {
        const originalSnapshot = buildSalesSnapshot({
            order: order({ subtotal: 18, tax: 0.8, total: 18.8, payment_method: 'receivable' }),
            items: [
                item({ id: 41, price_at_sale: 10, tax_rate: 8, tax_amount: 0.8, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 42, item_name: 'Zero', price_at_sale: 8, tax_rate: 0, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })
            ], seller, paymentTerms: 'receivable', customer: { name: 'Frozen Buyer' }
        });
        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 11, kind: 'refund', reason: 'Mixed return', amount_refunded: 10.8, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [
                { order_item_id: 41, item_name: 'Burger', quantity: 1, unit_price: 10, line_subtotal: 10, line_tax: 0.8, line_total: 10.8 },
            ],
            originalSnapshot, originalDocument: { document_uuid: crypto.randomUUID(), tax_registration_type: 'sales_tax' }, seller
        });
        expect(snapshot.invoiceTypeName).toBe('022');
        expect(snapshot.lines[0]).toMatchObject({ taxCategory: 'S', taxRate: 8 });
        expect(renderCreditNoteXml(snapshot, { uuid: crypto.randomUUID(), icv: '101' })).toContain('<cbc:Percent>8.00</cbc:Percent>');
    });

    it('uses the accepted original line number, name, and unit price on returns', () => {
        const originalSnapshot = buildSalesSnapshot({
            order: order({ subtotal: 18, tax: 0, total: 18 }),
            items: [
                item({ id: 41, item_name: 'First', price_at_sale: 10, tax_rate: 0, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 42, item_name: 'Frozen original name', price_at_sale: 8, tax_rate: 0, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })
            ], seller
        });
        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 13, kind: 'refund', reason: 'Return second line', amount_refunded: 8, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 42, item_name: 'Changed refund name', quantity: 1, unit_price: 99, line_subtotal: 8, line_tax: 0, line_total: 8 }],
            originalSnapshot, originalDocument: { document_uuid: crypto.randomUUID() }, seller
        });

        expect(snapshot.lines[0]).toMatchObject({ id: 2, itemName: 'Frozen original name', unitPrice: 8 });
    });

    it('renders BaseQuantity on general-sales-tax returns', () => {
        const originalSnapshot = buildSalesSnapshot({ order: order(), items: [item()], seller });
        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 14, kind: 'refund', reason: 'Return', amount_refunded: 5.55, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 1, item_name: 'برغر', quantity: 1, unit_price: 5.15, line_subtotal: 5.14, line_tax: 0.41, line_total: 5.55 }],
            originalSnapshot, originalDocument: { document_uuid: crypto.randomUUID() }, seller
        });

        expect(renderCreditNoteXml(snapshot, { uuid: crypto.randomUUID(), icv: '102' }))
            .toContain('<cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>');
    });

    it('reconciles a six-decimal managed partial-refund quantity', () => {
        const originalSnapshot = buildSalesSnapshot({
            order: order({ subtotal: 23, tax: 0, total: 23 }),
            items: [item({
                id: 51,
                quantity: 1,
                price_at_sale: 23,
                tax_rate: 0,
                tax_amount: 0,
                modifier_surcharge: null,
                modifier_tax_amount: null
            })],
            seller
        });

        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 15, kind: 'refund', reason: 'Partial refund', amount_refunded: 5, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 51, item_name: 'Changed name', quantity: 0.217391, unit_price: 23, line_subtotal: 5, line_tax: 0, line_total: 5 }],
            originalSnapshot,
            originalDocument: { document_uuid: crypto.randomUUID() },
            seller
        });

        expect(snapshot.totals.payable).toBe(4.999993);
        expect(Math.abs(snapshot.totals.payable - 5)).toBeLessThan(0.00001);
    });

    it('fails closed when a refund line is not present in the accepted original snapshot', () => {
        const originalSnapshot = buildSalesSnapshot({ order: order(), items: [item({ id: 41 })], seller });
        expect(() => buildCreditNoteSnapshot({
            refund: { id: 12, kind: 'refund', reason: 'Missing line', amount_refunded: 1, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 999, item_name: 'Unknown', quantity: 1, unit_price: 1, line_subtotal: 1, line_tax: 0, line_total: 1 }],
            originalSnapshot, originalDocument: { document_uuid: crypto.randomUUID() }, seller
        })).toThrowError(expect.objectContaining({ publicCode: 'JOFOTARA_ORIGINAL_LINE_REQUIRED' }));
    });

    it('renders one document-level tax subtotal per standard rate on a mixed-rate return', () => {
        const originalSnapshot = buildSalesSnapshot({
            order: order({ subtotal: 15, tax: 1.8, total: 16.8 }),
            items: [
                item({ id: 41, price_at_sale: 10, tax_rate: 16, tax_amount: 1.6, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 42, item_name: 'Water', price_at_sale: 5, tax_rate: 4, tax_amount: 0.2, modifier_surcharge: null, modifier_tax_amount: null })
            ],
            seller
        });
        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 17, kind: 'refund', reason: 'Return', amount_refunded: 16.8, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 41, quantity: 1 }, { order_item_id: 42, quantity: 1 }],
            originalSnapshot, originalDocument: { document_uuid: crypto.randomUUID() }, seller
        });
        const documentXml = renderCreditNoteXml(snapshot, { uuid: crypto.randomUUID(), icv: '104' }).split('<cac:InvoiceLine>')[0];
        const subtotals = [...documentXml.matchAll(/<cac:TaxSubtotal><cbc:TaxableAmount currencyID="JO">([\d.]+)<\/cbc:TaxableAmount><cbc:TaxAmount currencyID="JO">([\d.]+)<\/cbc:TaxAmount>.*?<cbc:Percent>([\d.]+)<\/cbc:Percent>/g)]
            .map(([, taxable, tax, percent]) => ({ taxable, tax, percent }));
        expect(subtotals).toEqual([
            { taxable: '10.000000', tax: '1.600000', percent: '16.00' },
            { taxable: '5.000000', tax: '0.200000', percent: '4.00' }
        ]);
    });

    it('refuses a return that together with earlier returns exceeds the invoiced quantity', () => {
        const originalSnapshot = buildSalesSnapshot({
            order: order({ subtotal: 10, tax: 1.6, total: 11.6 }),
            items: [item({ id: 41, quantity: 2, price_at_sale: 5, tax_rate: 16, tax_amount: 1.6, modifier_surcharge: null, modifier_tax_amount: null })],
            seller
        });
        expect(() => buildCreditNoteSnapshot({
            refund: { id: 18, kind: 'refund', reason: 'Return', amount_refunded: 5.8, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 41, quantity: 1, previously_returned_quantity: 2 }],
            originalSnapshot, originalDocument: { document_uuid: crypto.randomUUID() }, seller
        })).toThrowError(expect.objectContaining({ publicCode: 'JOFOTARA_INVALID_REFUND' }));
    });

    it('prorates the accepted tax on a partial-quantity standard-rated return', () => {
        const originalSnapshot = buildSalesSnapshot({
            order: order({ subtotal: 10, tax: 1.6, total: 11.6 }),
            items: [item({ id: 41, quantity: 2, price_at_sale: 5, tax_rate: 16, tax_amount: 1.6, modifier_surcharge: null, modifier_tax_amount: null })],
            seller
        });
        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 19, kind: 'refund', reason: 'Return', amount_refunded: 5.8, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 41, quantity: 1 }],
            originalSnapshot, originalDocument: { document_uuid: crypto.randomUUID() }, seller
        });
        expect(snapshot.lines[0]).toMatchObject({ quantity: 1, extension: 5, tax: 0.8, payable: 5.8 });
        expect(snapshot.totals.payable).toBe(5.8);
    });

    it('copies E/Z fiscal categories from the accepted exempt invoice to credit notes', () => {
        const originalSnapshot = buildSalesSnapshot({
            order: order({ subtotal: 17, tax: 0, total: 17, tax_inclusive_at_sale: 1, tax_exempt_at_sale: 1 }),
            items: [item({ id: 41, price_at_sale: 17, tax_rate: 16, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })],
            seller
        });
        originalSnapshot.lines[0].taxCategory = 'E';
        const snapshot = buildCreditNoteSnapshot({
            refund: { id: 10, kind: 'refund', reason: 'إرجاع', amount_refunded: 17, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 41, item_name: 'برغر', quantity: 1, unit_price: 17, line_subtotal: 17, line_tax: 0, line_total: 17 }],
            originalSnapshot,
            originalDocument: { document_uuid: crypto.randomUUID() },
            seller
        });

        expect(snapshot.lines[0].taxCategory).toBe('Z');
        expect(snapshot.lines[0].taxRate).toBe(0);
        expect(renderCreditNoteXml(snapshot, { uuid: crypto.randomUUID(), icv: '100' }))
            .toContain('<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">Z</cbc:ID>');
    });
});

describe('JoFotara income-tax XML', () => {
    it.each([[2.38, 0.5], [2.37, 0.5], [1.59, 0.3333]])('renders an income-tax allocated split child payable at %s', (total, quantity) => {
        const snapshot = buildInvoiceSnapshot({
            profile: 'income_tax',
            order: order({
                subtotal: total,
                tax: 0,
                total,
                parent_invoice_id: 40,
                tax_registration_type_at_sale: 'income_tax'
            }),
            items: [item({
                quantity,
                price_at_sale: 4.75,
                tax_rate: 0,
                tax_amount: 0,
                modifier_surcharge: null,
                modifier_tax_amount: null
            })],
            seller
        });
        const xml = renderInvoiceXml(snapshot, previewIdentity(Math.round(total * 100)));
        expect(snapshot.totals.payable).toBe(total);
        expect(snapshot.lines[0].extension).toBe(total);
        expect(Math.abs(
            snapshot.lines[0].quantity * snapshot.lines[0].unitPrice -
            snapshot.lines[0].allowance - snapshot.lines[0].extension
        )).toBeLessThanOrEqual(0.001);
        expect(xml).toContain(`<cbc:InvoicedQuantity unitCode="PCE">${quantity.toFixed(6)}</cbc:InvoicedQuantity>`);
        expect(xml).toContain(`<cbc:PayableAmount currencyID="JO">${total.toFixed(6)}</cbc:PayableAmount>`);
    });

    it('uses saved customer-facing prices and allocates line and order discounts', () => {
        const snapshot = buildInvoiceSnapshot({
            profile: 'income_tax',
            order: order({
                subtotal: 13.75, tax: 0, total: 11.475,
                tax_registration_type_at_sale: 'income_tax',
                discount_type: 'percent', discount_value: 10
            }),
            items: [
                item({ id: 1, price_at_sale: 10, quantity: 1, tax_rate: 16, tax_amount: 0, modifier_surcharge: 2, modifier_tax_amount: 1.2, discount_type: 'percent', discount_value: 10 }),
                item({ id: 2, item_name: 'رسم الخدمة', price_at_sale: 3.75, quantity: 1, tax_rate: 16, tax_amount: 0, modifier_tax_amount: 0 })
            ],
            seller,
            customer: null
        });

        expect(snapshot.taxRegistrationType).toBe('income_tax');
        expect(snapshot.lines.map(line => line.gross)).toEqual([10, 3.75]);
        expect(snapshot.lines.map(line => line.allowance)).toEqual([1.9, 0.375]);
        expect(snapshot.totals).toEqual({ taxExclusive: 13.75, allowance: 2.275, tax: 0, taxInclusive: 11.475, payable: 11.475 });
    });

    it('caps an over-sized fixed order discount at each line\'s gross on a fully comped sale', () => {
        const snapshot = buildInvoiceSnapshot({
            profile: 'income_tax',
            order: order({
                subtotal: 5, tax: 0, total: 0,
                tax_registration_type_at_sale: 'income_tax',
                discount_type: 'fixed', discount_value: 6
            }),
            items: [
                item({ id: 1, price_at_sale: 3, tax_rate: 0, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null }),
                item({ id: 2, item_name: 'Drink', price_at_sale: 2, tax_rate: 0, tax_amount: 0, modifier_surcharge: null, modifier_tax_amount: null })
            ],
            seller
        });

        expect(snapshot.lines.map(line => line.allowance)).toEqual([3, 2]);
        expect(snapshot.totals.allowance).toBe(5);
        expect(snapshot.totals.payable).toBe(0);
    });

    it('reconciles a monetary rounding residue into the income-tax unit price without inventing a discount', () => {
        const source = {
            profile: 'income_tax', seller,
            order: order({ total: 1.29, tax: 0, tax_registration_type_at_sale: 'income_tax' }),
            items: [item({ price_at_sale: 1.293103, tax_rate: 0, tax_amount: 0 })]
        };
        const snapshot = buildInvoiceSnapshot(source);
        expect(snapshot.lines[0]).toMatchObject({
            unitPrice: 1.29,
            gross: 1.29,
            allowance: 0,
            extension: 1.29
        });
        expect(snapshot.totals.allowance).toBe(0);
        expect(snapshot.totals.payable).toBe(1.29);
        const roundedUp = buildInvoiceSnapshot({
            ...source,
            order: { ...source.order, total: 1.30 },
            items: [item({ price_at_sale: 1.295, tax_rate: 0, tax_amount: 0 })]
        });
        expect(roundedUp.lines[0]).toMatchObject({ unitPrice: 1.30, gross: 1.30, allowance: 0, extension: 1.30 });
        const tinyLastLine = buildInvoiceSnapshot({
            ...source,
            order: { ...source.order, total: 1 },
            items: [
                item({ id: 1, price_at_sale: 1.003, tax_rate: 0, tax_amount: 0 }),
                item({ id: 2, price_at_sale: 0.001, tax_rate: 0, tax_amount: 0 })
            ]
        });
        expect(tinyLastLine.lines).toMatchObject([
            { gross: 0.999, allowance: 0, extension: 0.999 },
            { gross: 0.001, allowance: 0, extension: 0.001 }
        ]);
        expect(() => buildInvoiceSnapshot({ ...source, order: { ...source.order, total: 1.31 } })).toThrowError(expect.objectContaining({ publicCode: 'JOFOTARA_TOTAL_MISMATCH' }));
        expect(() => buildInvoiceSnapshot({ ...source, order: { ...source.order, total: 1 } })).toThrowError(expect.objectContaining({ publicCode: 'JOFOTARA_TOTAL_MISMATCH' }));
    });

    it('renders 011 invoices with the anonymous cash-customer name and no TaxTotal', () => {
        const snapshot = buildInvoiceSnapshot({
            profile: 'income_tax', seller,
            order: order({ total: 10, tax: 0, tax_registration_type_at_sale: 'income_tax' }),
            items: [item({ price_at_sale: 10, tax_rate: 16, tax_amount: 0 })],
            customer: { name: '   ' }
        });
        const xml = renderInvoiceXml(snapshot, { uuid: crypto.randomUUID(), icv: '41' });
        expect(xml).toContain('<cbc:InvoiceTypeCode name="011">388</cbc:InvoiceTypeCode>');
        expect(xml).not.toContain('<cac:TaxTotal>');
        expect(xml).toContain('schemeID="TN">0');
        expect(xml).toContain('<cac:PartyTaxScheme><cbc:CompanyID>0</cbc:CompanyID>');
        expect(xml).toContain('<cbc:RegistrationName>Cash customer</cbc:RegistrationName>');
        expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="JO">10.000000</cbc:TaxExclusiveAmount>');
        expect(xml).toContain('<cbc:AllowanceTotalAmount currencyID="JO">0.000000</cbc:AllowanceTotalAmount>');
    });

    it('renders an explicit income-tax receivable as gated 021 without changing cash invoices', () => {
        const snapshot = buildInvoiceSnapshot({
            profile: 'income_tax', paymentTerms: 'receivable', seller,
            order: order({ total: 10, tax: 0, payment_method: 'receivable', tax_registration_type_at_sale: 'income_tax' }),
            items: [item({ price_at_sale: 10, tax_rate: 0, tax_amount: 0 })],
            customer: { name: 'Frozen Buyer', phone: '0790000000', address: 'Amman' }
        });
        const xml = renderInvoiceXml(snapshot, { uuid: crypto.randomUUID(), icv: '41' });

        expect(snapshot.invoiceTypeName).toBe('021');
        expect(xml).toContain('<cbc:InvoiceTypeCode name="021">388</cbc:InvoiceTypeCode>');
        expect(xml).not.toContain('<cac:TaxTotal>');
    });

    it('renders 011 returns with the accepted original reference and no TaxTotal', () => {
        const originalSnapshot = buildInvoiceSnapshot({
            profile: 'income_tax', seller,
            order: order({ total: 10, tax: 0, tax_registration_type_at_sale: 'income_tax' }),
            items: [item({ id: 88, price_at_sale: 10, tax_rate: 0, tax_amount: 0 })],
            customer: { name: 'زبون' }
        });
        const snapshot = buildCreditNoteSnapshot({
            profile: 'income_tax',
            refund: { id: 9, kind: 'refund', reason: 'إرجاع', amount_refunded: 5, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 88, item_name: 'برغر', quantity: 0.5, unit_price: 10, line_subtotal: 5, line_tax: 0, line_total: 5 }],
            originalSnapshot,
            originalDocument: { document_uuid: crypto.randomUUID(), tax_registration_type: 'income_tax' }
        });
        const xml = renderCreditNoteXml(snapshot, { uuid: crypto.randomUUID(), icv: '99' });
        expect(xml).toContain('<cbc:InvoiceTypeCode name="011">381</cbc:InvoiceTypeCode>');
        expect(xml).toContain('<cac:BillingReference>');
        expect(xml).toContain('<cbc:InstructionNote>إرجاع</cbc:InstructionNote>');
        expect(xml).not.toContain('<cac:TaxTotal>');
        expect(xml).not.toContain('<cbc:PrepaidAmount');
    });

    it('adds the anonymous cash-customer name to returns built from an older income-tax snapshot', () => {
        const originalSnapshot = buildInvoiceSnapshot({
            profile: 'income_tax', seller,
            order: order({ total: 10, tax: 0, tax_registration_type_at_sale: 'income_tax' }),
            items: [item({ id: 88, price_at_sale: 10, tax_rate: 0, tax_amount: 0 })]
        });
        originalSnapshot.customer.name = '';
        const snapshot = buildCreditNoteSnapshot({
            profile: 'income_tax',
            refund: { id: 10, kind: 'refund', reason: 'إرجاع', amount_refunded: 10, created_at: '2026-07-21T10:00:00.000Z' },
            refundItems: [{ order_item_id: 88, quantity: 1 }],
            originalSnapshot,
            originalDocument: { document_uuid: crypto.randomUUID(), tax_registration_type: 'income_tax' }
        });

        expect(renderCreditNoteXml(snapshot, { uuid: crypto.randomUUID(), icv: '100' }))
            .toContain('<cbc:RegistrationName>Cash customer</cbc:RegistrationName>');
    });
});
