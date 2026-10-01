const CANONICAL_RECEIPT_LAYOUT = ['header', 'meta', 'customer', 'items', 'totals', 'payment', 'jofotara', 'footer'];
const REQUIRED_RECEIPT_BLOCKS = new Set(['header', 'meta', 'items', 'totals', 'payment', 'jofotara']);

const label = (en = '', ar = '') => ({ en, ar, mode: 'auto' });
const text = (id, en, style = {}, visibleWhen = null) => ({ id, type: 'text', text: label(en), style, visibleWhen });
const field = (id, path, en = '', style = {}, visibleWhen = null, format) => ({ id, type: 'field', path, label: label(en), style, visibleWhen, ...(format ? { format } : {}) });
const divider = (id, variant = 'dashed') => ({ id, type: 'divider', variant, style: {} });
const once = (id, nodes, visibleWhen = null) => ({ id, kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen, nodes });
const repeat = (id, source, filter, nodes) => ({ id, kind: 'repeat', layout: 'flow', source, filter, visibleWhen: null, nodes });
// normal and void carry no variant on purpose: with none, the heading falls
// through to meta.ticketTypeLabel, which is the store name.
const kitchenHeadingVariants = () => ({
    subscription: { en: 'SUBSCRIPTION MEAL', ar: 'وجبة اشتراك', mode: 'both' },
    subscription_void: { en: 'SUBSCRIPTION MEAL VOID', ar: 'تم إلغاء وجبة الاشتراك', mode: 'both' },
    follow_up: { en: 'FOLLOW UP', ar: 'إضافة على الطلب', mode: 'both' },
    cancel: { en: 'ORDER CANCELLED', ar: 'إلغاء الطلب', mode: 'both' }
});

function receiptBlocks() {
    return {
        header: [once('header', [
            field('store-name', 'store.name', '', { align: 'center', fontSize: '2xl', fontWeight: 'black', textTransform: 'uppercase', letterSpacing: 3, lineHeight: 1, marginBottom: 12 }),
            field('store-address', 'store.address', '', { align: 'center', fontSize: 'base', fontWeight: 'bold', marginBottom: 12, letterSpacing: 1 }),
            field('store-phone', 'store.phone', '', { align: 'center', fontSize: 'base', fontWeight: 'bold', letterSpacing: 1 }),
            field('store-custom-header', 'store.customHeaderText', '', { align: 'center', fontSize: 'sm', fontWeight: 'bold', marginTop: 8 }, { path: 'store.customHeaderText', op: 'truthy', value: null }),
            divider('header-divider')
        ])],
        meta: [once('meta', [
            field('ticket-display', 'meta.ticketDisplayNo', 'Ticket:', { fontSize: 'xl', fontWeight: 'black', labelLayout: 'inline' }, { path: 'meta.provisional', op: 'eq', value: false }),
            { id: 'invoice-date-row', type: 'row', layout: 'flow', style: { marginBottom: 6 }, nodes: [
                field('invoice-display', 'meta.invoiceDisplayNo', 'Invoice:', { fontSize: 'xl', fontWeight: 'black', labelLayout: 'inline', width: 43 }, { path: 'meta.provisional', op: 'eq', value: false }),
                { ...field('receipt-date', 'meta.date', '', { align: 'right', fontSize: 'base', fontWeight: 'bold', labelLayout: 'inline', width: 57, offsetY: 0 }), label: label('', '') }
            ] },
            { id: 'identity-date-row', type: 'row', layout: 'flow', style: { marginBottom: 6 }, nodes: [
                text('guest-check', 'GUEST CHECK', { fontSize: 'xl', fontWeight: 'black', width: 54 }, { path: 'meta.guestCheck', op: 'eq', value: true }),
                field('order-display', 'meta.orderDisplayNo', 'Order:', { fontSize: 'xl', fontWeight: 'black', labelLayout: 'inline', width: 54 }, { path: 'meta.provisional', op: 'eq', value: false }),
                field('held-order-display', 'meta.orderDisplayNo', 'Order:', { fontSize: 'xl', fontWeight: 'black', labelLayout: 'inline', width: 54 }, { path: 'meta.heldOrderReceipt', op: 'eq', value: true }),
                field('order-type', 'meta.orderTypeName', '', { align: 'right', fontSize: 'base', fontWeight: 'normal', width: 46, offsetY: -8 })
            ] },
            { id: 'cashier-type-row', type: 'row', layout: 'flow', style: { marginBottom: 6 }, nodes: [
                field('cashier', 'meta.cashier', 'Cashier:', { fontWeight: 'normal', labelLayout: 'inline', width: 100 })
            ] },
            { ...field('tax-number', 'meta.taxNumber', 'Tax No.:', { fontWeight: 'normal', labelLayout: 'inline', marginBottom: 6 }, { path: 'meta.taxNumber', op: 'truthy', value: null }), label: label('Tax No.:', 'الرقم الضريبي:') },
            field('table-number', 'meta.tableNumber', 'Table:', { fontSize: 'xl', fontWeight: 'black', labelLayout: 'inline' }),
            field('hash-number', 'meta.hashNumber', '#', { align: 'center', fontSize: '2xl', fontWeight: 'black', labelLayout: 'inline', marginBottom: 8 }),
            field('receipt-note', 'meta.note', 'Note:', { fontSize: 'lg', fontWeight: 'bold', fontStyle: 'italic', labelLayout: 'inline', marginTop: 8, marginBottom: 4 }, { path: 'meta.note', op: 'truthy', value: null })
        ])],
        customer: [once('customer', [
            field('customer-name', 'customer.name', 'Customer:', { fontWeight: 'bold', labelLayout: 'inline' }, { path: 'customer.name', op: 'truthy', value: null }),
            field('customer-phone', 'customer.phone', 'Phone:', { fontWeight: 'bold', labelLayout: 'inline' }, { path: 'customer.phone', op: 'truthy', value: null }),
            field('customer-address', 'customer.address', 'Address:', { fontWeight: 'bold', labelLayout: 'inline' }, { path: 'customer.address', op: 'truthy', value: null }),
            field('delivery-date', 'customer.deliveryDate', 'Delivery:', { fontWeight: 'bold', labelLayout: 'inline' }, { path: 'customer.deliveryDate', op: 'truthy', value: null }),
            divider('customer-divider')
        ])],
        items: [
            once('items-header', [
                { id: 'items-heading', type: 'row', layout: 'flow', style: { fontSize: 'sm', fontWeight: 'black', textTransform: 'uppercase', letterSpacing: 3, marginTop: 8 }, nodes: [
                    text('items-heading-qty', 'Qty', { width: 11.5 }),
                    text('items-heading-name', 'Item', { width: 64.75 }),
                    text('items-heading-total', 'Total', { align: 'right', width: 23.75 })
                ] },
                { ...divider('items-heading-divider', 'solid'), style: { marginTop: 8, marginBottom: 8 } }
            ]),
            repeat('items', 'rows', null, [
                { id: 'receipt-item-row', type: 'row', layout: 'flow', style: { fontSize: 'item', fontWeight: 'bold', marginTop: 4, marginBottom: 4 }, visibleWhen: { path: 'kind', op: 'neq', value: 'bundle_child' }, nodes: [
                    field('receipt-item-qty', 'qty', '', { width: 11.5 }),
                    field('receipt-item-name', 'name', '', { width: 64.75 }),
                    field('receipt-item-total', 'netAmount', '', { align: 'right', width: 23.75 })
                ] },
                field('receipt-item-child', 'name', '', { fontSize: 'note', marginInlineStart: 64, marginBottom: 4 }, { path: 'kind', op: 'eq', value: 'bundle_child' }),
                field('receipt-item-note', 'note', '', { fontSize: 'note', fontWeight: 'bold', marginInlineStart: 65, marginBottom: 6 }, { path: 'note', op: 'truthy', value: null }, 'list'),
                field('receipt-item-discount-label', 'lineDiscountLabel', 'Discount', { fontSize: 'sm', marginInlineStart: 64 }, { path: 'lineDiscountAmount', op: 'gt', value: 0 }),
                field('receipt-item-discount-amount', 'lineDiscountAmount', '', { fontSize: 'sm', marginInlineStart: 64 }, { path: 'lineDiscountAmount', op: 'gt', value: 0 })
            ]),
            once('items-divider', [divider('items-divider')])
        ],
        totals: [once('totals', [
            { ...field('subtotal', 'summary.subtotal', 'Subtotal', { fontWeight: 'bold' }), labelStyle: { fontWeight: 'normal' } },
            { ...field('order-discount-label', 'summary.orderDiscountLabel', 'Discount', { fontWeight: 'bold' }, { path: 'summary.orderDiscountAmount', op: 'gt', value: 0 }), labelStyle: { fontWeight: 'normal' } },
            field('order-discount-amount', 'summary.orderDiscountAmount', '', { fontWeight: 'bold' }, { path: 'summary.orderDiscountAmount', op: 'gt', value: 0 }),
            { ...field('tax-amount', 'summary.taxAmount', 'Tax', { fontWeight: 'bold' }, { path: 'summary.taxLabel', op: 'falsy', value: null }), labelStyle: { fontWeight: 'normal' } },
            { ...field('tax-label', 'summary.taxLabel', 'Tax', { fontWeight: 'bold' }, { path: 'summary.taxLabel', op: 'truthy', value: null }), labelStyle: { fontWeight: 'normal' } },
            { ...field('rounding-adjustment', 'summary.roundingAdjustment', 'Rounding', { fontWeight: 'bold' }, { path: 'summary.roundingAdjustment', op: 'neq', value: 0 }), labelStyle: { fontWeight: 'normal' } },
            { ...field('total', 'summary.total', 'Total', { fontSize: 'total', fontWeight: 'black', marginTop: 12, marginBottom: 12 }), labelStyle: { textTransform: 'uppercase', letterSpacing: 2 }, valueStyle: {} }
        ])],
        payment: [once('payment', [
            { ...field('payment-method', 'payment.method', 'Payment', { fontWeight: 'bold' }, { path: 'payment.method', op: 'neq', value: 'split' }), labelStyle: { fontWeight: 'normal' }, valueStyle: { textTransform: 'uppercase' } },
            field('receivable-issued', 'billing.issuedOn', 'Issued', { fontWeight: 'normal' }, { path: 'payment.method', op: 'eq', value: 'receivable' }),
            field('receivable-due', 'billing.dueOn', 'Due date', { fontWeight: 'normal' }, { path: 'payment.method', op: 'eq', value: 'receivable' }),
            field('receivable-collected', 'billing.collectedAmount', 'Collected', { fontWeight: 'normal' }, { path: 'payment.method', op: 'eq', value: 'receivable' }),
            field('receivable-outstanding', 'billing.outstandingAmount', 'Outstanding', { fontWeight: 'bold' }, { path: 'payment.method', op: 'eq', value: 'receivable' }),
            { ...field('cash-payment', 'payment.cashAmount', 'Cash', { fontWeight: 'bold' }, { path: 'payment.method', op: 'eq', value: 'split' }), labelStyle: { fontWeight: 'normal' } },
            { ...field('card-payment', 'payment.cardAmount', 'Card', { fontWeight: 'bold' }, { path: 'payment.method', op: 'eq', value: 'split' }), labelStyle: { fontWeight: 'normal' } },
            field('amount-tendered', 'payment.amountTendered', 'Tendered', { fontWeight: 'normal' }, { path: 'payment.amountTendered', op: 'gt', value: 0 }),
            field('change-due', 'payment.changeDue', 'Change', { fontWeight: 'normal' }, { path: 'payment.changeDue', op: 'gt', value: 0 }),
            divider('payment-divider')
        ], { path: 'meta.provisional', op: 'eq', value: false })],
        jofotara: [once('jofotara', [{ id: 'jofotara-qr', type: 'jofotara_qr', size: 556, style: { align: 'center' } }])],
        footer: [once('footer', [
            field('custom-footer', 'store.customFooterText', '', { align: 'center', fontSize: 'sm', fontWeight: 'bold', marginTop: 16 }, { path: 'store.customFooterText', op: 'truthy', value: null }),
            text('default-footer', 'Thank you!', { align: 'center', fontSize: 'sm', fontWeight: 'bold', marginTop: 16 }, { path: 'store.customFooterText', op: 'falsy', value: null })
        ])]
    };
}

function kitchenTemplate() {
    return {
        schemaVersion: 1,
        docType: 'kitchen',
        paper: { widthPx: 576 },
        bands: [
            once('kitchen-header', [
                { ...field('kitchen-ticket-type', 'meta.ticketTypeLabel', '', { align: 'center', fontSize: 'display', fontWeight: 'black', padding: 10, marginBottom: 12 }), variants: kitchenHeadingVariants() },
                field('kitchen-order-type', 'meta.orderTypeName', '', { align: 'center', fontSize: '2xl', fontWeight: 'black', textTransform: 'uppercase', marginBottom: 8 }, { path: 'meta.ticketType', op: 'eq', value: 'normal' }),
                field('kitchen-order', 'meta.orderDisplayNo', 'Order:', { align: 'center', fontSize: '2xl', fontWeight: 'black', labelLayout: 'inline', marginBottom: 8 }, { path: 'meta.ticketType', op: 'eq', value: 'normal' }),
                field('kitchen-hash', 'meta.hashNumber', '#', { align: 'center', fontSize: 'xl', fontWeight: 'black' }, { path: 'meta.ticketType', op: 'eq', value: 'normal' }),
                { ...divider('kitchen-identity-divider'), visibleWhen: { path: 'meta.ticketType', op: 'eq', value: 'normal' } },
                field('kitchen-ticket', 'meta.ticketDisplayNo', 'Ticket:', { fontSize: 'xl', fontWeight: 'black', labelLayout: 'inline' }, { path: 'meta.ticketType', op: 'eq', value: 'normal' }),
                field('kitchen-date', 'meta.date', '', { align: 'right', fontSize: 'lg', fontWeight: 'bold' }, { path: 'meta.ticketType', op: 'eq', value: 'normal' }),
                field('kitchen-table', 'meta.tableNumber', 'TABLE:', { align: 'center', fontSize: 'total', fontWeight: 'black', labelLayout: 'inline', padding: 12, marginTop: 8, marginBottom: 12 }, { path: 'meta.ticketType', op: 'eq', value: 'normal' }),
                field('kitchen-follow-up-sequence', 'meta.followUpSequence', 'Sequence:', { align: 'center', fontSize: 'xl', fontWeight: 'black', marginBottom: 8 }, { path: 'meta.ticketType', op: 'eq', value: 'follow_up' }),
                field('kitchen-follow-up-order-type', 'meta.orderTypeName', '', { align: 'center', fontSize: '2xl', fontWeight: 'black', textTransform: 'uppercase', marginBottom: 8 }, { path: 'meta.ticketType', op: 'eq', value: 'follow_up' }),
                field('kitchen-follow-up-order', 'meta.orderDisplayNo', 'Order:', { fontSize: 'xl', fontWeight: 'black', labelLayout: 'inline' }, { path: 'meta.ticketType', op: 'eq', value: 'follow_up' }),
                field('kitchen-follow-up-date', 'meta.date', '', { align: 'right', fontSize: 'lg', fontWeight: 'bold' }, { path: 'meta.ticketType', op: 'eq', value: 'follow_up' }),
                field('kitchen-follow-up-table', 'meta.tableNumber', 'TABLE:', { align: 'center', fontSize: 'total', fontWeight: 'black', labelLayout: 'inline', padding: 12, marginTop: 8, marginBottom: 12 }, { path: 'meta.ticketType', op: 'eq', value: 'follow_up' }),
                { ...divider('void-kitchen-divider'), visibleWhen: { path: 'meta.ticketType', op: 'eq', value: 'void' } },
                field('void-kitchen-table', 'meta.tableNumber', 'TABLE:', { align: 'center', fontSize: 'total', fontWeight: 'black', labelLayout: 'inline', padding: 12, marginTop: 8, marginBottom: 12 }, { path: 'meta.ticketType', op: 'eq', value: 'void' }),
                field('cancel-kitchen-order', 'meta.orderDisplayNo', 'Order:', { fontSize: 'xl', fontWeight: 'black', labelLayout: 'inline' }, { path: 'meta.ticketType', op: 'eq', value: 'cancel' }),
                field('cancel-kitchen-date', 'meta.date', '', { align: 'right', fontSize: 'lg', fontWeight: 'bold' }, { path: 'meta.ticketType', op: 'eq', value: 'cancel' }),
                field('cancel-kitchen-table', 'meta.tableNumber', 'TABLE:', { align: 'center', fontSize: 'total', fontWeight: 'black', labelLayout: 'inline', padding: 12, marginTop: 8, marginBottom: 12 }, { path: 'meta.ticketType', op: 'eq', value: 'cancel' }),
                { ...field('void-print-requested-at', 'meta.printRequestedAt', '', { fontWeight: 'bold' }, { path: 'voidTicket', op: 'truthy', value: null }), label: label('', 'وقت الطباعة') },
                { ...field('void-order-taken-at', 'meta.orderTakenAt', '', { fontWeight: 'bold' }, { path: 'voidTicket', op: 'truthy', value: null }), label: label('', 'وقت الطلب') },
                { ...divider('void-warning-divider', 'solid'), visibleWhen: { path: 'meta.ticketType', op: 'eq', value: 'void' } },
                field('void-warning', 'meta.voidWarning', '', { align: 'center', fontSize: '2xl', fontWeight: 'black', marginBottom: 8 }, { path: 'meta.ticketType', op: 'eq', value: 'void' }),
                field('cancel-warning', 'meta.voidWarning', '', { align: 'center', fontSize: '2xl', fontWeight: 'black', marginBottom: 8 }, { path: 'meta.ticketType', op: 'eq', value: 'cancel' }),
                { ...divider('subscription-header-divider'), visibleWhen: { path: 'subscriptionRedemption.reference', op: 'truthy', value: null } },
                field('subscription-reference', 'subscriptionRedemption.reference', '', { align: 'center', fontSize: 'xl', fontWeight: 'black' }, { path: 'subscriptionRedemption.reference', op: 'truthy', value: null }),
                field('subscription-customer', 'subscriptionRedemption.customerName', '', { align: 'center', fontSize: 'lg', fontWeight: 'bold' }, { path: 'subscriptionRedemption.customerName', op: 'truthy', value: null }),
                field('subscription-phone', 'subscriptionRedemption.customerPhone', '', { align: 'center', fontSize: 'lg', fontWeight: 'bold' }, { path: 'subscriptionRedemption.customerPhone', op: 'truthy', value: null }),
                field('subscription-date', 'meta.date', '', { align: 'center', fontSize: 'lg', fontWeight: 'bold' }, { path: 'subscriptionRedemption.reference', op: 'truthy', value: null }),
                { ...divider('kitchen-header-divider'), visibleWhen: { path: 'subscriptionRedemption.reference', op: 'truthy', value: null } }
            ]),
            repeat('kitchen-items', 'items', { path: 'isOther', op: 'neq', value: true }, [
                field('kitchen-bundle-label', 'bundleLabel', '', { fontSize: 'lg', fontWeight: 'bold', marginBottom: 4, opacity: 0.7 }, { path: 'bundleLabel', op: 'truthy', value: null }, 'brackets'),
                { id: 'kitchen-item-row', type: 'row', layout: 'flow', style: { fontSize: 'xl', fontWeight: 'black', marginBottom: 8 }, nodes: [
                    field('kitchen-item-qty', 'qty', '', { width: 13.5, fontSize: 'xl' }),
                    field('kitchen-item-name', 'name', '', { width: 86.5, fontSize: 'xl' })
                ] },
                field('kitchen-item-note', 'note', '', { fontSize: 'lg', fontWeight: 'black', fontStyle: 'italic', marginInlineStart: 75, marginBottom: 8 }, { path: 'note', op: 'truthy', value: null }, 'modifier')
            ]),
            once('kitchen-other-heading', [
                divider('kitchen-other-divider'),
                text('kitchen-other-heading-text', '-- ALSO ON ORDER --', { align: 'center', fontSize: 'lg', fontWeight: 'bold', letterSpacing: 1, marginBottom: 8 })
            ], { path: 'hasOtherItems', op: 'eq', value: true }),
            repeat('kitchen-other-items', 'items', { path: 'isOther', op: 'eq', value: true }, [
                { id: 'kitchen-other-row', type: 'row', layout: 'flow', style: { fontSize: 'xl', fontWeight: 'bold', marginBottom: 4, opacity: 0.55 }, nodes: [
                    field('kitchen-other-qty', 'qty', '', { width: 13.5, fontSize: 'xl' }),
                    field('kitchen-other-name', 'name', '', { width: 86.5, fontSize: 'xl' })
                ] }
            ])
        ]
    };
}

function parseReceiptConfig(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function addDiagnostic(options, code) {
    if (Array.isArray(options?.diagnostics)) options.diagnostics.push(code);
}

function resolvedReceiptLayout(options) {
    const config = parseReceiptConfig(options?.storeInfo?.receipt_config);
    if (!Array.isArray(config?.layout)) {
        addDiagnostic(options, 'PRINT_TEMPLATE_LAYOUT_DEFAULTED');
        return CANONICAL_RECEIPT_LAYOUT;
    }

    const seen = new Set();
    const layout = [];
    let repaired = false;
    for (const block of config.layout) {
        if (!CANONICAL_RECEIPT_LAYOUT.includes(block) || seen.has(block)) {
            repaired = true;
            continue;
        }
        seen.add(block);
        layout.push(block);
    }
    for (const block of CANONICAL_RECEIPT_LAYOUT) {
        if (!REQUIRED_RECEIPT_BLOCKS.has(block) || seen.has(block)) continue;
        const next = CANONICAL_RECEIPT_LAYOUT.slice(CANONICAL_RECEIPT_LAYOUT.indexOf(block) + 1)
            .map(candidate => layout.indexOf(candidate)).find(index => index >= 0);
        if (next === undefined) layout.push(block);
        else layout.splice(next, 0, block);
        seen.add(block);
        repaired = true;
    }
    if (repaired) addDiagnostic(options, 'PRINT_TEMPLATE_LAYOUT_REPAIRED');
    return layout;
}

function getBuiltinTemplate(docType, options = {}) {
    if (docType === 'kitchen') return kitchenTemplate();
    if (docType !== 'receipt') throw new Error(`Unsupported print template document type: ${docType}`);
    const blocks = receiptBlocks();
    return {
        schemaVersion: 1,
        docType: 'receipt',
        paper: { widthPx: 576 },
        bands: resolvedReceiptLayout(options).flatMap(block => blocks[block])
    };
}

const FIXTURES = {
    receipt: {
        'receipt-basic': {
            label: 'Receipt',
            model: {
                store: { name: 'Template Cafe', address: 'Amman', phone: '0790000000', customHeaderText: '', customFooterText: '' },
                meta: { invoiceDisplayNo: 'INV-100', ticketDisplayNo: '', orderDisplayNo: '100', internalInvoiceId: 100, date: '2026-07-25 02:00 PM', orderTakenAt: '', printRequestedAt: '2026-07-25 05:30:00 PM', cashier: 'Maya', taxNumber: '123456789', orderTypeName: 'Dine In', tableNumber: 'T1', hashNumber: '', provisional: false, note: '' },
                customer: { name: '', phone: '', address: '', deliveryDate: '' },
                payment: { method: 'cash', cashAmount: 15.66, cardAmount: 0, amountTendered: 20, changeDue: 4.34 },
                jofotara: null,
                rows: [
                    { key: 'burger', kind: 'item', name: 'Smash Burger', note: 'No onion · extra cheese', qty: 2, unitPrice: 5, extendedPrice: 10, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 10 },
                    { key: 'coffee', kind: 'item', name: 'Iced Coffee', note: '', qty: 1, unitPrice: 3.5, extendedPrice: 3.5, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 3.5 }
                ],
                summary: { subtotal: 13.5, orderDiscountAmount: 0, orderDiscountLabel: null, taxAmount: 2.16, taxLabel: null, roundingAdjustment: 0, total: 15.66 },
                taxMode: 'exclusive', status: 'original', currency: 'JD', decimals: 2
            }
        },
        'receipt-bundle': {
            label: 'Receipt with bundle',
            model: {
                store: { name: 'Template Cafe', address: 'Amman', phone: '0790000000', customHeaderText: '', customFooterText: '' },
                meta: { invoiceDisplayNo: 'INV-102', ticketDisplayNo: '', orderDisplayNo: '102', internalInvoiceId: 102, date: '2026-07-25 02:00 PM', orderTakenAt: '', printRequestedAt: '2026-07-25 05:30:00 PM', cashier: 'Maya', orderTypeName: 'Dine In', tableNumber: 'T1', hashNumber: '', provisional: false, note: '' },
                customer: { name: '', phone: '', address: '', deliveryDate: '' },
                payment: { method: 'cash', cashAmount: 15.66, cardAmount: 0, amountTendered: 20, changeDue: 4.34 },
                jofotara: null,
                rows: [
                    { key: 'burger', kind: 'item', name: 'Smash Burger', note: 'No onion · extra cheese', qty: 2, unitPrice: 5, extendedPrice: 10, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 10 },
                    { key: 'row-bundle-child', kind: 'bundle_child', name: 'Fries', note: null, qty: 1, unitPrice: 0, extendedPrice: 0, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 0 },
                    { key: 'coffee', kind: 'item', name: 'Iced Coffee', note: '', qty: 1, unitPrice: 3.5, extendedPrice: 3.5, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 3.5 }
                ],
                summary: { subtotal: 13.5, orderDiscountAmount: 0, orderDiscountLabel: null, taxAmount: 2.16, taxLabel: null, roundingAdjustment: 0, total: 15.66 },
                taxMode: 'exclusive', status: 'original', currency: 'JD', decimals: 2
            }
        },
        'receipt-accepted-jofotara': {
            label: 'Receipt with test QR',
            model: {
                store: { name: 'Template Cafe', address: 'Amman', phone: '0790000000', customHeaderText: '', customFooterText: '' },
                meta: { invoiceDisplayNo: 'INV-101', ticketDisplayNo: '', orderDisplayNo: '101', internalInvoiceId: 101, date: '2026-07-25 02:00 PM', orderTakenAt: '', printRequestedAt: '2026-07-25 05:30:00 PM', cashier: 'Maya', orderTypeName: 'Counter', tableNumber: '', hashNumber: '', provisional: false, note: '' },
                customer: { name: '', phone: '', address: '', deliveryDate: '' },
                payment: { method: 'card', cashAmount: 0, cardAmount: 5, amountTendered: 5, changeDue: 0 },
                jofotara: { status: 'accepted', qrText: 'TEMPLATE TEST - NOT A LEGAL DOCUMENT' },
                rows: [{ key: 'tea', kind: 'item', name: 'Tea', note: '', qty: 1, unitPrice: 5, extendedPrice: 5, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 5 }],
                summary: { subtotal: 5, orderDiscountAmount: 0, orderDiscountLabel: null, taxAmount: 0, taxLabel: null, roundingAdjustment: 0, total: 5 },
                taxMode: 'exclusive', status: 'original', currency: 'JD', decimals: 2
            }
        }
    },
    kitchen: {
        'kitchen-normal': { label: 'Kitchen ticket', model: { meta: { ticketType: 'normal', ticketTypeLabel: 'TEMPLATE CAFE', invoiceDisplayNo: '', ticketDisplayNo: '100', orderDisplayNo: '100', date: '2026-07-25 02:00:00 PM', orderTakenAt: '', printRequestedAt: '2026-07-25 05:30:00 PM', orderTypeName: 'Dine In', tableNumber: 'T1', hashNumber: '', voidWarning: '' }, items: [{ name: 'Smash Burger', qty: 2, note: 'NO ONION · EXTRA CHEESE', bundleLabel: '', isOther: false }, { name: 'Fries', qty: 1, note: 'EXTRA CRISPY', bundleLabel: '', isOther: false }, { name: 'Cola', qty: 2, note: '', bundleLabel: '', isOther: true }], voidTicket: false, hasOtherItems: true, subscriptionRedemption: null, printerLabel: '' } },
        'kitchen-void': { label: 'Void kitchen ticket', model: { meta: { ticketType: 'void', ticketTypeLabel: 'TEMPLATE CAFE', invoiceDisplayNo: '', ticketDisplayNo: '', orderDisplayNo: '100', date: '2026-07-25 02:00:00 PM', orderTakenAt: '2026-07-25 01:55:00 PM', printRequestedAt: '2026-07-25 05:30:00 PM', orderTypeName: '', tableNumber: 'T1', hashNumber: '', voidWarning: 'تم إلغاء هذا الصنف' }, items: [{ name: 'Burger', qty: 1, note: '', bundleLabel: '', isOther: false }], voidTicket: true, hasOtherItems: false, subscriptionRedemption: null, printerLabel: '' } }
    }
};

function listTemplateFixtures(docType) {
    const fixtures = FIXTURES[docType];
    if (!fixtures) throw new Error(`Unsupported print template document type: ${docType}`);
    return Object.entries(fixtures).map(([key, fixture]) => ({ key, label: fixture.label }));
}

function getTemplateFixture(docType, fixtureKey) {
    const fixture = FIXTURES[docType]?.[fixtureKey];
    if (!fixture) throw new Error(`Unknown ${docType} print template fixture: ${fixtureKey}`);
    return structuredClone(fixture.model);
}

module.exports = { getBuiltinTemplate, getTemplateFixture, listTemplateFixtures };
