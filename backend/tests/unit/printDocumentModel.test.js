const {
    buildReceiptDocumentModel,
    buildKitchenDocumentModel
} = require('../../services/printDocumentModel');

const receiptPresentation = {
    version: 1,
    currency: 'JD',
    decimals: 2,
    taxMode: 'exclusive',
    status: 'original',
    rows: [{
        key: 'coffee', kind: 'item', name: 'Coffee', note: 'No sugar', qty: 1,
        unitPrice: 10, extendedPrice: 10, lineDiscountAmount: 0,
        lineDiscountLabel: null, netAmount: 10
    }],
    summary: {
        subtotal: 10, orderDiscountAmount: 0, orderDiscountLabel: null,
        taxAmount: 2.1, taxLabel: null, roundingAdjustment: 0, total: 12.1
    }
};

function paidReceipt(overrides = {}) {
    return {
        storeInfo: {
            store_name: 'Main\x1b Cafe',
            store_address: 'Amman\nJordan',
            store_phone: '0790000000',
            receipt_config: JSON.stringify({ customHeaderText: 'Welcome\tback', customFooterText: 'Thank you' })
        },
        internal_invoice_id: 42,
        invoice_id: 42,
        invoice_display_no: 'INV-42',
        ticket_display_no: '42',
        order_display_no: '42',
        order_id: 42,
        date: '2026-07-25 14:00:00',
        order_taken_at: '2026-07-25 13:55:00',
        cashier: 'Maya',
        order_type_name: 'Dine In',
        table_number: 'T1',
        hash_number: 'HASH-42',
        order_note: 'Call\nbefore delivery',
        customer_name: 'Rana',
        customer_phone: '0791111111',
        customer_address: 'Amman\n7th circle',
        delivery_date: '2026-07-26',
        payment_method: 'split',
        cash_amount: 5.05,
        card_amount: 7.05,
        amount_tendered: 15.1,
        change_due: 3,
        receipt_display_v1: structuredClone(receiptPresentation),
        ...overrides
    };
}

describe('print document models', () => {
    it('returns null when receipt v1 is absent or invalid', () => {
        expect(buildReceiptDocumentModel(paidReceipt({ receipt_display_v1: undefined }))).toBeNull();
        expect(buildReceiptDocumentModel(paidReceipt({ receipt_display_v1: { version: 1 } }))).toBeNull();
    });

    it('returns null for valid-v1 receipts in unsupported stored payment states', () => {
        expect(buildReceiptDocumentModel(paidReceipt({ payment_method: 'unpaid_table' }))).toBeNull();
        expect(buildReceiptDocumentModel(paidReceipt({ payment_method: 'voided' }))).toBeNull();
    });

    it('builds a receivable payment model from validated server billing facts', () => {
        const presentation = structuredClone(receiptPresentation);
        presentation.billing = {
            terms: 'receivable', issuedOn: '2026-07-30 12:00:00', dueOn: '2026-08-31',
            invoiceTotal: 12.1, collectedAmount: 2.1, outstandingAmount: 10
        };
        const model = buildReceiptDocumentModel(paidReceipt({
            payment_method: 'receivable', amount_tendered: 0, cash_amount: 0, card_amount: 0, change_due: 0,
            receipt_display_v1: presentation
        }));

        expect(model.payment).toEqual({ method: 'receivable', cashAmount: 0, cardAmount: 0, amountTendered: 0, changeDue: 0 });
        expect(model.billing).toEqual({
            ...presentation.billing,
            issuedOn: '2026-07-30 03:00:00 PM'
        });
    });

    it('builds a zero-tender platform payment model without receivable billing', () => {
        const model = buildReceiptDocumentModel(paidReceipt({
            payment_method: 'platform', amount_tendered: 0, cash_amount: 0, card_amount: 0, change_due: 0
        }));

        expect(model.payment).toEqual({ method: 'platform', cashAmount: 0, cardAmount: 0, amountTendered: 0, changeDue: 0 });
        expect(model.billing).toBeNull();
        expect(model.jofotara).toBeNull();
    });

    it('copies validated v1 finance, validates split tender in cents, and sanitizes printable fields', () => {
        const model = buildReceiptDocumentModel(paidReceipt({ delivery_date: '2026-07-26 18:30:00' }), {
            printRequestedAt: '2026-07-25T14:01:00.000Z',
            jofotara: { status: 'accepted', qrText: 'official-qr' }
        });

        expect(model.rows).toEqual(receiptPresentation.rows);
        expect(model.summary).toEqual(receiptPresentation.summary);
        expect(model.taxMode).toBe('exclusive');
        expect(model.currency).toBe('JD');
        expect(model.decimals).toBe(2);
        expect(model.payment).toEqual({
            method: 'split', cashAmount: 5.05, cardAmount: 7.05,
            amountTendered: 15.1, changeDue: 3
        });
        expect(Math.round(model.payment.cashAmount * 100)).toBeGreaterThan(0);
        expect(Math.round(model.payment.cardAmount * 100)).toBeGreaterThan(0);
        expect(Math.round((model.payment.cashAmount + model.payment.cardAmount) * 100)).toBe(1210);
        expect(Math.round((model.payment.amountTendered - model.summary.total) * 100)).toBe(
            Math.round(model.payment.changeDue * 100)
        );
        expect(model.store).toEqual({
            name: 'Main Cafe', address: 'Amman\nJordan', phone: '0790000000',
            customHeaderText: 'Welcome\tback', customFooterText: 'Thank you'
        });
        expect(model.meta).toMatchObject({
            internalInvoiceId: 42, invoiceDisplayNo: 'INV-42', date: '2026-07-25 05:00 PM',
            orderTakenAt: '2026-07-25 04:55:00 PM', printRequestedAt: '2026-07-25 05:01:00 PM',
            note: 'Call\nbefore delivery', provisional: false
        });
        expect(model.customer.deliveryDate).toBe('2026-07-26 06:30:00 PM');
        expect(model.jofotara).toEqual({ status: 'accepted', qrText: 'official-qr' });
    });

    it('carries the validated tax-exempt fact into the print model', () => {
        const presentation = structuredClone(receiptPresentation);
        presentation.taxExempt = true;
        presentation.summary = { ...presentation.summary, taxAmount: 0, taxLabel: '(معفي من الضريبة)', total: 10 };
        const model = buildReceiptDocumentModel(paidReceipt({
            payment_method: 'cash', cash_amount: 10, amount_tendered: 10, change_due: 0,
            receipt_display_v1: presentation
        }));

        expect(model.taxExempt).toBe(true);
        expect(model.summary.taxLabel).toBe('(معفي من الضريبة)');
        expect(model.summary.taxAmount).toBe(0);
    });

    it('uses the invoice tax profile for its optional seller tax number', () => {
        const storeInfo = {
            ...paidReceipt().storeInfo,
            tax_registration_type: 'sales_tax',
            jofotara_sales_tax_seller_tax_number: ' SALES-123 ',
            jofotara_income_tax_seller_tax_number: 'INCOME-456'
        };
        const income = buildReceiptDocumentModel(paidReceipt({ storeInfo, tax_registration_type_at_sale: 'income_tax' }));
        const sales = buildReceiptDocumentModel(paidReceipt({ storeInfo, tax_registration_type_at_sale: 'sales_tax' }));
        const blank = buildReceiptDocumentModel(paidReceipt({
            storeInfo: { ...storeInfo, jofotara_sales_tax_seller_tax_number: '   ' },
            tax_registration_type_at_sale: 'sales_tax'
        }));
        const guest = buildReceiptDocumentModel(paidReceipt({
            storeInfo,
            provisional: true,
            invoice_id: 'GUEST CHECK',
            payment_method: 'held'
        }));

        expect(income.meta.taxNumber).toBe('INCOME-456');
        expect(sales.meta.taxNumber).toBe('SALES-123');
        expect(blank.meta.taxNumber).toBe('');
        expect(guest.meta.taxNumber).toBe('');
    });

    it('sanitizes and caps validated v1 printable text without losing tabs or newlines', () => {
        const presentation = structuredClone(receiptPresentation);
        const longNote = `${'A'.repeat(300)}\n${'B'.repeat(300)}\x1b`;
        presentation.rows[0] = {
            ...presentation.rows[0],
            name: `${'N'.repeat(205)}\x1b`,
            note: longNote,
            lineDiscountAmount: 1,
            lineDiscountLabel: `${'D'.repeat(205)}\x1b`,
            netAmount: 9
        };
        presentation.summary = {
            ...presentation.summary,
            subtotal: 9,
            taxAmount: 3.1,
            orderDiscountLabel: `${'O'.repeat(205)}\x1b`,
            taxLabel: 'Tax\tincluded\ntext\x1b'
        };

        const model = buildReceiptDocumentModel(paidReceipt({ receipt_display_v1: presentation }));

        expect(model.rows[0].name).toHaveLength(200);
        expect(model.rows[0].lineDiscountLabel).toHaveLength(200);
        expect(model.summary.orderDiscountLabel).toHaveLength(200);
        expect(model.rows[0].note).toHaveLength(500);
        expect(model.rows[0].note).toContain('\n');
        expect(model.rows[0].note).not.toContain('\x1b');
        expect(model.summary.taxLabel).toBe('Tax\tincluded\ntext');
    });

    it('keeps guest and held checks provisional even when legal invoice and jofotara fields are forged', () => {
        const guest = buildReceiptDocumentModel(paidReceipt({
            invoice_id: 'GUEST CHECK', internal_invoice_id: 42, invoice_display_no: 'FORGED',
            payment_method: 'cash', amount_tendered: 99, change_due: 0, provisional: true
        }), {
            printRequestedAt: '2026-07-25T14:01:00.000Z',
            jofotara: { status: 'accepted', qrText: 'official-qr' }
        });
        const held = buildReceiptDocumentModel(paidReceipt({ payment_method: 'held' }));

        expect(guest.meta).toMatchObject({ provisional: true, internalInvoiceId: null, invoiceDisplayNo: null });
        expect(guest.payment).toEqual({ method: null, cashAmount: 0, cardAmount: 0, amountTendered: 0, changeDue: 0 });
        expect(guest.jofotara).toBeNull();
        expect(held.meta).toMatchObject({ provisional: true, internalInvoiceId: null });
        expect(held.payment.method).toBeNull();
        expect(held.jofotara).toBeNull();
    });

    it('builds the trusted kitchen states without receipt v1 or money paths', () => {
        const states = [
            [{}, 'normal', 'KITCHEN TICKET'],
            [{ void_ticket: true }, 'void', 'KITCHEN TICKET']
        ];

        for (const [overrides, ticketType, ticketTypeLabel] of states) {
            const model = buildKitchenDocumentModel({
                order_display_no: 'T-5', order_id: 5, date: '2026-07-25 14:00:00',
                table_number: 'A\x1b1', order_type_name: 'Dine In', printer_label: 'Grill',
                ticketTypeLabel: 'forged label', receipt_display_v1: { forged: true },
                items: [{ name: 'Burger\x1b', qty: 1, note: 'No onion\nplease', price: 9 }, { name: 'Other', qty: 1, _isOther: true, total: 9 }],
                ...overrides
            }, { printRequestedAt: '2026-07-25T14:01:00.000Z' });

            expect(model.meta).toMatchObject({ ticketType, ticketTypeLabel, date: '2026-07-25 05:00:00 PM', printRequestedAt: '2026-07-25 05:01:00 PM', tableNumber: 'A1' });
            expect(model.meta.ticketDisplayNo).toBe('T-5');
            expect(model.hasOtherItems).toBe(true);
            expect(model.items).toEqual([
                { name: 'Burger', qty: 1, note: 'No onion\nplease', bundleLabel: '', isOther: false },
                { name: 'Other', qty: 1, note: '', bundleLabel: '', isOther: true }
            ]);
            expect(JSON.stringify(model)).not.toMatch(/"(?:price|total|subtotal|tax|amount|money)"/i);
        }
    });

    it('heads a plain kitchen ticket with the store name and leaves functional headings alone', () => {
        const build = overrides => buildKitchenDocumentModel({
            order_display_no: 'T-5', order_id: 5, date: '2026-07-25 14:00:00',
            order_type_name: 'Dine In', items: [{ name: 'Tea', qty: 1 }],
            storeInfo: { store_name: 'BASHAR CAFE' },
            ...overrides
        }, { printRequestedAt: '2026-07-25T14:01:00.000Z' });

        // Control characters in a settings value must never reach the printer.
        expect(build({}).meta.ticketTypeLabel).toBe('BASHAR CAFE');
        expect(build({ void_ticket: true }).meta.ticketTypeLabel).toBe('BASHAR CAFE');

        // A ticket type that means something to the kitchen keeps its own heading
        // even when a store name is configured.
        expect(build({ follow_up: true }).meta.ticketTypeLabel).toBe('إضافة على الطلب / FOLLOW UP');
        expect(build({ cancel_ticket: true }).meta.ticketTypeLabel).toBe('إلغاء الطلب / ORDER CANCELLED');

        // No store name configured, or a blank one, falls back to the old heading
        // rather than printing a headless ticket.
        expect(build({ storeInfo: undefined }).meta.ticketTypeLabel).toBe('KITCHEN TICKET');
        expect(build({ storeInfo: { store_name: '   ' } }).meta.ticketTypeLabel).toBe('KITCHEN TICKET');
    });

    it('builds trusted follow-up and cancellation identities without customer data', () => {
        const followUp = buildKitchenDocumentModel({
            follow_up: true,
            follow_up_sequence: 2,
            order_id: 42,
            order_display_no: 42,
            order_type_name: 'Phone order',
            date: '2026-07-25 14:00:00',
            items: [{ name: 'Tea', qty: 2 }],
            customer_name: 'Should not print',
            customer_phone: '0790000000'
        });
        expect(followUp.meta).toMatchObject({
            ticketType: 'follow_up',
            ticketTypeLabel: 'إضافة على الطلب / FOLLOW UP',
            followUpSequence: 2
        });
        expect(JSON.stringify(followUp)).not.toContain('Should not print');

        const cancel = buildKitchenDocumentModel({
            cancel_ticket: true,
            order_id: 42,
            date: '2026-07-25 14:00:00',
            items: [{ name: 'Tea', qty: 1 }]
        });
        expect(cancel.meta).toMatchObject({
            ticketType: 'cancel',
            ticketTypeLabel: 'إلغاء الطلب / ORDER CANCELLED'
        });
    });

    it('keeps the legacy kitchen identity precedence when an invoice number exists', () => {
        const model = buildKitchenDocumentModel({
            invoice_display_no: '7001', ticket_display_no: '17', order_display_no: '17', items: []
        });

        expect(model.meta).toMatchObject({ invoiceDisplayNo: '7001', ticketDisplayNo: '', orderDisplayNo: '17' });
    });
});

// Exercise the real formatter in fresh processes; TZ must not affect the document.
describe('print timezone contract', () => {
    it.each(['Asia/Amman', 'UTC', 'America/New_York'])('separates schedules from event instants on %s', (TZ) => {
        const { execFileSync } = require('node:child_process');
        const input = paidReceipt({ delivery_date: '2026-09-09T18:30', date: '2026-09-09 23:30:00', order_taken_at: '2026-09-09T23:29:00Z' });
        const script = 'const {buildReceiptDocumentModel}=require(' + JSON.stringify(require.resolve('../../services/printDocumentModel')) + ');const data=' + JSON.stringify(input) + ';console.log(JSON.stringify(buildReceiptDocumentModel(data)));';
        const model = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding:'utf8', env:{...process.env,TZ,POS_BUSINESS_SQL_OFFSET:'+03:00'} }));
        expect(model.customer.deliveryDate).toBe('2026-09-09 06:30:00 PM');
        expect(model.meta.date).toBe('2026-09-10 02:30 AM');
        expect(model.meta.orderTakenAt).toBe('2026-09-10 02:29:00 AM');
    });
});

 it('exposes only the held daily number while suppressing invoice, payment and fiscal QR', () => {
    const model = buildReceiptDocumentModel(paidReceipt({held_order_receipt:true,provisional:true,payment_method:'held',order_id:17,order_display_no:'17'}), {jofotara:{status:'accepted',qrText:'FORGED'}});
    expect(model.meta).toMatchObject({provisional:true,heldOrderReceipt:true,guestCheck:false,orderDisplayNo:'17',invoiceDisplayNo:null,ticketDisplayNo:null,internalInvoiceId:null});
    expect(model.payment).toEqual({method:null,cashAmount:0,cardAmount:0,amountTendered:0,changeDue:0});
    expect(model.jofotara).toBeNull();
 });
