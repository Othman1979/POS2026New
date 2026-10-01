const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { compileTemplate, validateTemplate } = require('../../services/printTemplateEngine');
const { buildReceiptDocumentModel, buildKitchenDocumentModel } = require('../../services/printDocumentModel');
const {
    getBuiltinTemplate,
    getTemplateFixture,
    listTemplateFixtures
} = require('../../services/printTemplateDefaults');

const legacyFixtureDir = resolve(__dirname, '../fixtures/printGoldens');
const sourceCases = JSON.parse(readFileSync(resolve(legacyFixtureDir, 'cases.json'), 'utf8'));
const ARTIFACT_GOLDENS = Object.freeze({
    'receipt-item-discount': '11ed419f8800392d87532f5bb8485c155756efc2af0178b4144c27a57ac967a0',
    'receipt-order-discount': '63063039f70b5314a5a9c2ac84a4308910750dfb959660c020a567fe6b2ab6ac',
    'receipt-bundle-service-charge': '2f0bd25275041021b5b842ed874e922733e9d3c9c60d3103a5bad738fd07fd8b',
    'receipt-layout-safe': 'e03644e04d6f290ca6cbf740ed6cd3106633268d4e19ce01edb90314681745d2',
    'receipt-layout-required-restored': '930bf86ae67f25796184fcdf26e618b35ec4cbb85aea9430b42cc01df8e87d04',
    'receipt-guest-check': 'd0996b70ed9ebcb6b893ccd1761fc64f1cb9bba43709503e13ccda481c1628d8',
    'receipt-jofotara-accepted': 'ce5e21ad3333e9071ef2246b0df90478174da3a79fe9ec7c41dfe74d5713e607',
    'kitchen-normal': '20e99424ea872fd1bd0fa6eaeaffab89dcc87fd42391b2c9308f067bfb3dc3aa',
    'kitchen-void': '683c4503c9e082979dd355d5ca72f0b5b5c12b49bda49a381971df3cf0fa25fe',
    'kitchen-primary-other': 'bcc9ffef459ff33cd6dc2c8dbae21e15571324faabdb9188f1dba7403480ace2'
});

function sourceCase(key) {
    const value = sourceCases.find(entry => entry.id === key);
    if (!value) throw new Error(`Missing Phase 0 source fixture ${key}`);
    const copy = structuredClone(value);
    // These golden labels describe the venue clock. Make fixture instants explicit
    // so host timezone changes do not shift the intended visual comparison.
    for (const key of ['date', 'order_taken_at']) {
        if (typeof copy.input[key] === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(copy.input[key])) {
            copy.input[key] = copy.input[key].replace(' ', 'T') + '+03:00';
        }
    }
    if (copy.now) copy.now = copy.now.replace(' ', 'T').replace(/Z$/, '').replace(/(?:\+03:00)?$/, '+03:00');
    return copy;
}

function receiptModel(key, { receiptConfig, jofotara } = {}) {
    const testCase = sourceCase(key);
    if (receiptConfig !== undefined) testCase.input.storeInfo.receipt_config = receiptConfig;
    return buildReceiptDocumentModel(testCase.input, {
        printRequestedAt: '2026-07-25T14:30:00.000+03:00',
        jofotara
    });
}

function guestReceiptModel() {
    const testCase = sourceCase('receipt-item-discount');
    Object.assign(testCase.input, {
        invoice_id: 'GUEST CHECK',
        provisional: true,
        invoice_display_no: 'FORGED-INV',
        ticket_display_no: 'FORGED-TICKET',
        order_display_no: 'FORGED-ORDER',
        table_number: 'T8',
        payment_method: 'cash',
        amount_tendered: 16,
        change_due: 0
    });
    return buildReceiptDocumentModel(testCase.input, {
        printRequestedAt: '2026-07-25T14:30:00.000+03:00',
        jofotara: { status: 'accepted', qrText: 'FORGED-QR' }
    });
}

function kitchenModel(key) {
    const testCase = sourceCase(key);
    return buildKitchenDocumentModel(testCase.input, { printRequestedAt: testCase.now || '2026-07-25T14:30:00.000+03:00' });
}

async function compileBuiltin(docType, model, options = {}) {
    const diagnostics = [];
    const template = getBuiltinTemplate(docType, { ...options, diagnostics });
    const { artifact, warnings } = await compileTemplate(template, model, {
        mode: 'test', templateRevisionId: `builtin:${docType}-v1`, profile: { allowAbsoluteOnce: true, allowStoreLogo: true }
    });
    return { artifact, compilerWarnings: warnings, diagnostics, template };
}

const artifactDigest = artifact => createHash('sha256').update(JSON.stringify(artifact)).digest('hex');

function templateNode(template, id) {
    for (const band of template.bands) {
        const pending = [...band.nodes];
        while (pending.length) {
            const node = pending.shift();
            if (node.id === id) return node;
            if (node.type === 'row') pending.unshift(...node.nodes);
        }
    }
    return null;
}

const trustedArtifactCases = [
    ['receipt', 'receipt-item-discount', () => receiptModel('receipt-item-discount')],
    ['receipt', 'receipt-order-discount', () => receiptModel('receipt-order-discount')],
    ['receipt', 'receipt-bundle-service-charge', () => receiptModel('receipt-bundle-service-charge')],
    ['receipt', 'receipt-layout-safe', () => receiptModel('receipt-item-discount', {
        receiptConfig: JSON.stringify({ layout: ['header', 'meta', 'items', 'totals', 'payment', 'footer'], customHeaderText: 'Fresh coffee', customFooterText: 'Come again' })
    })],
    ['receipt', 'receipt-layout-required-restored', () => receiptModel('receipt-item-discount', {
        receiptConfig: JSON.stringify({ layout: ['header', 'items', 'footer'], customFooterText: 'Layout controls receipt blocks' })
    })],
    ['receipt', 'receipt-guest-check', guestReceiptModel],
    ['receipt', 'receipt-jofotara-accepted', () => receiptModel('receipt-item-discount', {
        jofotara: { status: 'accepted', qrText: 'TEMPLATE TEST - NOT A LEGAL DOCUMENT' }
    })],
    ['kitchen', 'kitchen-normal', () => kitchenModel('kitchen-normal')],
    ['kitchen', 'kitchen-void', () => kitchenModel('kitchen-void')],
    ['kitchen', 'kitchen-primary-other', () => kitchenModel('kitchen-primary-other')]
];

function storeInfoForArtifact(key) {
    if (key === 'receipt-layout-safe') {
        return { receipt_config: JSON.stringify({ layout: ['header', 'meta', 'items', 'totals', 'payment', 'footer'], customHeaderText: 'Fresh coffee', customFooterText: 'Come again' }) };
    }
    if (key === 'receipt-layout-required-restored') {
        return { receipt_config: JSON.stringify({ layout: ['header', 'items', 'footer'], customFooterText: 'Layout controls receipt blocks' }) };
    }
    return sourceCase(['receipt-jofotara-accepted', 'receipt-guest-check'].includes(key) ? 'receipt-item-discount' : key).input.storeInfo;
}

describe('built-in print-template parity', () => {
    it('renders a bundle child as an indented child line with no money column', async () => {
        const model = getTemplateFixture('receipt', 'receipt-bundle');
        const child = model.rows.find(row => row.kind === 'bundle_child');
        expect(child).toBeTruthy();

        const result = await compileTemplate(getBuiltinTemplate('receipt'), model, {
            mode: 'preview', templateRevisionId: 'preview:unpublished',
            profile: { allowAbsoluteOnce: true, allowStoreLogo: true }
        });

        const html = result.artifact.html;
        const band = html.split('<section').find(section => section.includes('data-node="receipt-item-child"'));
        expect(band).toContain(child.name);
        expect(band).not.toContain('receipt-item-total');
        expect(band).not.toMatch(/0\.00(?:\s+JD)?/);
    });

    it.each(trustedArtifactCases)('%s %s compiles to its frozen Phase 1 artifact', async (docType, key, modelFactory) => {
        const model = modelFactory();
        expect(model).not.toBeNull();
        const compiled = await compileBuiltin(docType, model, { storeInfo: storeInfoForArtifact(key) });

        expect(compiled.compilerWarnings).toEqual([]);
        expect(artifactDigest(compiled.artifact)).toBe(ARTIFACT_GOLDENS[key]);
    });

    it('preserves trusted models, money bindings, and source text without using legacy HTML as the compiled contract', async () => {
        const model = receiptModel('receipt-bundle-service-charge');
        const { artifact } = await compileBuiltin('receipt', model, { storeInfo: sourceCase('receipt-bundle-service-charge').input.storeInfo });

        expect(artifact.html).toContain('Family Combo');
        expect(artifact.html).toContain('Fries');
        expect(artifact.html).toContain('14.85 JD');
        expect(artifact.html).toContain('2.05 JD');
        expect(artifact.html).toContain('12.80 JD');
        expect(artifact.html).not.toContain('<!DOCTYPE html>');
    });

    it('repairs receipt layout safely and emits named diagnostics without rewriting its input', async () => {
        const malformedStoreInfo = { receipt_config: '{broken' };
        const malformed = await compileBuiltin('receipt', receiptModel('receipt-item-discount'), { storeInfo: malformedStoreInfo });
        const repaired = await compileBuiltin('receipt', receiptModel('receipt-item-discount'), {
            storeInfo: { receipt_config: JSON.stringify({ layout: ['header', 'items', 'footer', 'items', 'unknown'] }) }
        });

        expect(malformed.diagnostics).toEqual(['PRINT_TEMPLATE_LAYOUT_DEFAULTED']);
        expect(repaired.diagnostics).toEqual(['PRINT_TEMPLATE_LAYOUT_REPAIRED']);
        expect(repaired.template.bands.map(band => band.id)).toEqual([
            'header', 'meta', 'items-header', 'items', 'items-divider', 'totals', 'payment', 'jofotara', 'footer'
        ]);
        expect(malformedStoreInfo.receipt_config).toBe('{broken');
    });

    it.each([
        undefined,
        'not json',
        JSON.stringify([]),
        JSON.stringify({ layout: 'header' }),
        { layout: {} }
    ])('defaults missing or invalid receipt_config layout safely (%j)', receipt_config => {
        const diagnostics = [];
        const template = getBuiltinTemplate('receipt', { storeInfo: { receipt_config }, diagnostics });

        expect(diagnostics).toEqual(['PRINT_TEMPLATE_LAYOUT_DEFAULTED']);
        expect(template.bands.map(band => band.id)).toEqual([
            'header', 'meta', 'customer', 'items-header', 'items', 'items-divider', 'totals', 'payment', 'jofotara', 'footer'
        ]);
    });

    it('preserves valid known block order and ignores the browser-only invoice-number setting', () => {
        const storeInfo = { receipt_config: JSON.stringify({ layout: ['payment', 'header', 'items', 'totals', 'meta', 'footer'] }) };
        const first = getBuiltinTemplate('receipt', { storeInfo, use_invoice_no_only: true, diagnostics: [] });
        const second = getBuiltinTemplate('receipt', { storeInfo, use_invoice_no_only: false, diagnostics: [] });

        expect(first).toEqual(second);
        expect(first.bands.map(band => band.id)).toEqual([
            'payment', 'header', 'items-header', 'items', 'items-divider', 'totals', 'meta', 'jofotara', 'footer'
        ]);
    });

    it('keeps the QR as the only accepted-JoFotara artifact addition', async () => {
        const baseline = await compileBuiltin('receipt', receiptModel('receipt-item-discount'), { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });
        const accepted = await compileBuiltin('receipt', receiptModel('receipt-item-discount', {
            jofotara: { status: 'accepted', qrText: 'TEMPLATE TEST - NOT A LEGAL DOCUMENT' }
        }), { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });

        expect(accepted.artifact.css).toBe(baseline.artifact.css);
        expect(accepted.artifact.html).toContain('data:image/png;base64,');
        expect(accepted.artifact.html).toContain('Discounted Burger');
        expect(accepted.artifact.html).toContain('16.00 JD');
        expect(baseline.artifact.html).not.toContain('data:image/png;base64,');
    });

    it('prints the seller tax number below receipt metadata only when present', async () => {
        const visibleModel = receiptModel('receipt-item-discount');
        visibleModel.meta.taxNumber = '123456789';
        const visible = await compileBuiltin('receipt', visibleModel, { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });
        const hiddenModel = receiptModel('receipt-item-discount');
        hiddenModel.meta.taxNumber = '';
        const hidden = await compileBuiltin('receipt', hiddenModel, { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });

        expect(visible.artifact.html).toContain('data-node="tax-number"');
        expect(visible.artifact.html).toContain('123456789');
        expect(hidden.artifact.html).not.toContain('data-node="tax-number"');
    });

    it('uses the explicit trusted guest branch without legal identity, payment, or JoFotara values', async () => {
        const model = guestReceiptModel();
        const { artifact } = await compileBuiltin('receipt', model, { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });

        expect(model).toMatchObject({
            meta: { provisional: true, invoiceDisplayNo: null, ticketDisplayNo: null, orderDisplayNo: null, tableNumber: 'T8' },
            payment: { method: null, cashAmount: 0, cardAmount: 0 },
            jofotara: null
        });
        expect(artifact.html).toContain('GUEST CHECK');
        expect(artifact.html).toContain('T8');
        expect(artifact.html).not.toContain('FORGED-INV');
        expect(artifact.html).not.toContain('FORGED-QR');
        expect(artifact.html).not.toContain('Payment');
        expect(artifact.html).not.toContain('data:image/png;base64,');
    });

    it('shows only non-zero paid allocations while preserving cash, card, and split truth', async () => {
        const cash = await compileBuiltin('receipt', receiptModel('receipt-item-discount'), { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });
        const cardInput = sourceCase('receipt-item-discount');
        Object.assign(cardInput.input, { payment_method: 'card', amount_tendered: 16, change_due: 0 });
        const card = await compileBuiltin('receipt', buildReceiptDocumentModel(cardInput.input, { printRequestedAt: '2026-07-25T14:30:00.000+03:00' }), { storeInfo: cardInput.input.storeInfo });
        const splitInput = sourceCase('receipt-item-discount');
        Object.assign(splitInput.input, { payment_method: 'split', cash_amount: 6, card_amount: 10, amount_tendered: 16, change_due: 0 });
        const split = await compileBuiltin('receipt', buildReceiptDocumentModel(splitInput.input, { printRequestedAt: '2026-07-25T14:30:00.000+03:00' }), { storeInfo: splitInput.input.storeInfo });

        expect(cash.artifact.html).toContain('<span class="pt-label" style="font-weight:400">Payment</span>');
        expect(cash.artifact.html).not.toContain('data-node="cash-payment"');
        expect(cash.artifact.html).not.toContain('<span class="pt-label">Card</span>');
        expect(cash.artifact.html).not.toContain('<span class="pt-label">Change</span>');
        expect(card.artifact.html).toContain('<span class="pt-label" style="font-weight:400">Payment</span>');
        expect(card.artifact.html).not.toContain('data-node="cash-payment"');
        expect(split.artifact.html).not.toContain('data-node="payment-method"');
        expect(split.artifact.html).toContain('data-node="cash-payment"');
        expect(split.artifact.html).toContain('data-node="card-payment"');
    });

    it('rejects templates that expose paid receipt roles through the provisional branch', () => {
        const profile = { allowAbsoluteOnce: true, allowStoreLogo: true };
        const identityLeak = getBuiltinTemplate('receipt', { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });
        templateNode(identityLeak, 'invoice-display').visibleWhen = { path: 'meta.provisional', op: 'eq', value: true };
        const paymentLeak = getBuiltinTemplate('receipt', { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });
        paymentLeak.bands.find(band => band.id === 'payment').nodes.find(node => node.id === 'payment-method').visibleWhen = { path: 'meta.provisional', op: 'eq', value: true };
        const methodCashGate = getBuiltinTemplate('receipt', { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });
        methodCashGate.bands.find(band => band.id === 'payment').nodes.find(node => node.id === 'payment-method').visibleWhen = { path: 'payment.cashAmount', op: 'gt', value: 0 };
        const contradictoryAncestor = getBuiltinTemplate('receipt', { storeInfo: sourceCase('receipt-item-discount').input.storeInfo });
        const contradictoryMeta = contradictoryAncestor.bands.find(band => band.id === 'meta');
        const invoiceDateRow = contradictoryMeta.nodes.find(node => node.id === 'invoice-date-row');
        const dateIndex = invoiceDateRow.nodes.findIndex(node => node.id === 'receipt-date');
        const [date] = invoiceDateRow.nodes.splice(dateIndex, 1);
        for (const key of ['x', 'y', 'widthPx', 'heightPx']) delete date[key];
        contradictoryAncestor.bands.find(band => band.id === 'header').nodes.push({ ...date, id: 'contradictory-safe-date' });
        contradictoryMeta.visibleWhen = { path: 'meta.provisional', op: 'eq', value: true };

        expect(() => validateTemplate(identityLeak, profile)).toThrow(expect.objectContaining({ code: 'TEMPLATE_PROVISIONAL_BRANCH_INVALID' }));
        expect(() => validateTemplate(paymentLeak, profile)).toThrow(expect.objectContaining({ code: 'TEMPLATE_PROVISIONAL_BRANCH_INVALID' }));
        expect(() => validateTemplate(methodCashGate, profile)).toThrow(expect.objectContaining({ code: 'TEMPLATE_PROVISIONAL_BRANCH_INVALID' }));
        expect(() => validateTemplate(contradictoryAncestor, profile)).toThrow(expect.objectContaining({ code: 'TEMPLATE_PROVISIONAL_BRANCH_INVALID' }));
    });

    it('publishes copy-safe trusted preview fixtures for both document types', () => {
        expect(listTemplateFixtures('receipt')).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'receipt-basic' })]));
        expect(listTemplateFixtures('kitchen').map(({ key }) => key)).toEqual(['kitchen-normal', 'kitchen-void']);
        expect(() => getTemplateFixture('kitchen', 'kitchen-subscription')).toThrow(/unknown.*fixture/i);
        const fixture = getTemplateFixture('receipt', 'receipt-basic');
        expect(fixture.meta.date).toBe('2026-07-25 02:00 PM');
        expect(fixture.meta.printRequestedAt).toBe('2026-07-25 05:30:00 PM');
        expect(getTemplateFixture('kitchen', 'kitchen-void').meta.orderTakenAt).toBe('2026-07-25 01:55:00 PM');
        fixture.store.name = 'mutated';
        expect(getTemplateFixture('receipt', 'receipt-basic').store.name).not.toBe('mutated');
    });

    it('keeps the built-in receipt and kitchen identity rows aligned with the legacy spooler composition', () => {
        const receiptMeta = getBuiltinTemplate('receipt').bands.find(band => band.id === 'meta');
        const receiptHeader = getBuiltinTemplate('receipt').bands.find(band => band.id === 'header');
        expect(receiptHeader.nodes.find(node => node.id === 'store-name').style.marginBottom).toBe(12);
        expect(receiptHeader.nodes.find(node => node.id === 'store-address').style.marginBottom).toBe(12);
        const invoiceDate = receiptMeta.nodes.find(node => node.id === 'invoice-date-row');
        expect(invoiceDate).toMatchObject({ layout: 'flow', style: { marginBottom: 6 } });
        expect(invoiceDate.nodes.find(node => node.id === 'invoice-display').style.width).toBe(43);
        expect(invoiceDate.nodes.find(node => node.id === 'receipt-date')).toMatchObject({
            label: { en: '', ar: '', mode: 'auto' },
            style: { align: 'right', fontSize: 'base', fontWeight: 'bold', labelLayout: 'inline', width: 57, offsetY: 0 }
        });
        const receiptIdentity = receiptMeta.nodes.find(node => node.id === 'identity-date-row');
        expect(receiptIdentity).toMatchObject({ layout: 'flow', style: { marginBottom: 6 } });
        expect(receiptIdentity).not.toHaveProperty('height');
        expect(receiptIdentity.nodes.find(node => node.id === 'order-display').style.width).toBe(54);
        expect(receiptIdentity.nodes.find(node => node.id === 'order-type').style).toMatchObject({ width: 46, offsetY: -8 });
        const cashierType = receiptMeta.nodes.find(node => node.id === 'cashier-type-row');
        expect(cashierType).toMatchObject({ layout: 'flow' });
        expect(cashierType).not.toHaveProperty('height');
        expect(cashierType.nodes.find(node => node.id === 'cashier').style.width).toBe(100);
        expect(cashierType.style.marginBottom).toBe(6);
        const itemsHeader = getBuiltinTemplate('receipt').bands.find(band => band.id === 'items-header');
        const itemsHeading = itemsHeader.nodes.find(node => node.id === 'items-heading');
        expect(itemsHeading).toMatchObject({ layout: 'flow' });
        expect(itemsHeading).not.toHaveProperty('height');
        expect(itemsHeader.nodes.find(node => node.id === 'items-heading-divider').style).toEqual({ marginTop: 8, marginBottom: 8 });
        const receiptTotals = getBuiltinTemplate('receipt').bands.find(band => band.id === 'totals');
        const total = receiptTotals.nodes.find(node => node.id === 'total');
        expect(total.style).not.toHaveProperty('padding');
        expect(total.style).toMatchObject({ marginTop: 12, marginBottom: 12 });

        const kitchenHeader = getBuiltinTemplate('kitchen').bands.find(band => band.id === 'kitchen-header');
        // Order type and order number share one centred size so the line cook reads
        // both from across the pass.
        for (const id of ['kitchen-order-type', 'kitchen-order']) {
            expect(kitchenHeader.nodes.find(node => node.id === id).style)
                .toMatchObject({ align: 'center', fontSize: '2xl', fontWeight: 'black' });
        }
        // The invoice number is a customer-facing identity and has no business on
        // a kitchen ticket.
        expect(kitchenHeader.nodes.some(node => node.path === 'meta.invoiceDisplayNo')).toBe(false);
        expect(kitchenHeader.nodes.find(node => node.id === 'kitchen-date').style).toMatchObject({ align: 'right', fontSize: 'lg' });
        expect(kitchenHeader.nodes.find(node => node.id === 'kitchen-table').style).toMatchObject({ align: 'center', fontSize: 'total', labelLayout: 'inline' });
        // normal and void carry no variant on purpose: the heading falls through
        // to meta.ticketTypeLabel, which the model fills with the store name.
        expect(kitchenHeader.nodes.find(node => node.id === 'kitchen-ticket-type').variants).toEqual({
            subscription: { en: 'SUBSCRIPTION MEAL', ar: 'وجبة اشتراك', mode: 'both' },
            subscription_void: { en: 'SUBSCRIPTION MEAL VOID', ar: 'تم إلغاء وجبة الاشتراك', mode: 'both' },
            follow_up: { en: 'FOLLOW UP', ar: 'إضافة على الطلب', mode: 'both' },
            cancel: { en: 'ORDER CANCELLED', ar: 'إلغاء الطلب', mode: 'both' }
        });
    });

    it('keeps classic receipt label/value emphasis aligned with the legacy spooler', async () => {
        const template = getBuiltinTemplate('receipt');
        const itemRow = templateNode(template, 'receipt-item-row');
        expect(itemRow).toMatchObject({ type: 'row', layout: 'flow' });
        expect(itemRow).not.toHaveProperty('height');
        expect(templateNode(template, 'receipt-item-qty').style.width).toBe(11.5);
        expect(templateNode(template, 'receipt-item-name').style.width).toBe(64.75);
        expect(templateNode(template, 'receipt-item-total').style.width).toBe(23.75);
        for (const node of itemRow.nodes) {
            for (const property of ['x', 'y', 'widthPx', 'heightPx']) expect(node).not.toHaveProperty(property);
        }
        expect(templateNode(template, 'order-type').style).toMatchObject({ fontSize: 'base', fontWeight: 'normal', offsetY: -8 });
        expect(templateNode(template, 'subtotal').labelStyle.fontWeight).toBe('normal');
        expect(templateNode(template, 'total')).toMatchObject({
            labelStyle: { textTransform: 'uppercase', letterSpacing: 2 },
            valueStyle: {}
        });
        expect(templateNode(template, 'payment-method')).toMatchObject({
            labelStyle: { fontWeight: 'normal' },
            valueStyle: { textTransform: 'uppercase' }
        });
        expect(templateNode(template, 'amount-tendered').style.fontWeight).toBe('normal');
        expect(templateNode(template, 'change-due').style.fontWeight).toBe('normal');
        expect(templateNode(template, 'receipt-item-note')).toMatchObject({
            format: 'list', style: { marginInlineStart: 65, marginBottom: 6 }
        });
        expect(itemRow.style).toMatchObject({ marginTop: 4, marginBottom: 4 });
        expect(templateNode(template, 'receipt-note').style.fontStyle).toBe('italic');

        const { artifact } = await compileBuiltin('receipt', receiptModel('receipt-bundle-service-charge'));
        expect(artifact.html).toContain('<span class="pt-label" style="font-weight:400">Payment</span><span class="pt-value" style="text-transform:uppercase">cash</span>');
        expect(artifact.html).toContain('- No salt');
    });

    it('keeps the classic kitchen item hierarchy faithful to the legacy spooler ticket', async () => {
        const template = getBuiltinTemplate('kitchen');
        const itemRow = templateNode(template, 'kitchen-item-row');
        const note = templateNode(template, 'kitchen-item-note');
        const otherHeadingBand = template.bands.find(band => band.id === 'kitchen-other-heading');

        expect(itemRow).toMatchObject({ type: 'row', layout: 'flow' });
        expect(itemRow).not.toHaveProperty('height');
        expect(templateNode(template, 'kitchen-item-qty').style.width).toBe(13.5);
        expect(templateNode(template, 'kitchen-item-name').style.width).toBe(86.5);
        expect(note).toMatchObject({ format: 'modifier', label: { en: '', ar: '', mode: 'auto' } });
        expect(note.style).toMatchObject({ fontStyle: 'italic', marginInlineStart: 75, marginBottom: 8 });
        expect(templateNode(template, 'kitchen-bundle-label').style.opacity).toBe(.7);
        expect(templateNode(template, 'kitchen-other-row').style.opacity).toBe(.55);
        expect(otherHeadingBand).toMatchObject({
            kind: 'once',
            visibleWhen: { path: 'hasOtherItems', op: 'eq', value: true }
        });

        const normal = await compileBuiltin('kitchen', kitchenModel('kitchen-normal'));
        const voidTicket = await compileBuiltin('kitchen', kitchenModel('kitchen-void'));
        const mixedInput = sourceCase('kitchen-primary-other');
        mixedInput.input.items.push({ name: 'Second secondary item', qty: 1, _isOther: true });
        const mixed = await compileBuiltin('kitchen', buildKitchenDocumentModel(mixedInput.input));

        expect(normal.artifact.css).toContain('html,body{margin:0;padding:0}');
        expect(normal.artifact.html).toContain('<span class="pt-label">Ticket:</span><span class="pt-value">915</span>');
        expect(normal.artifact.html).toContain('*** No onion ***');
        expect(voidTicket.artifact.html).toContain('KITCHEN TICKET');
        expect(voidTicket.artifact.html).toContain('وقت الطباعة');
        expect(voidTicket.artifact.html).toContain('وقت الطلب');
        expect(voidTicket.artifact.html).toContain('تم إلغاء هذا الصنف');
        expect(voidTicket.artifact.html.indexOf('تم إلغاء هذا الصنف')).toBeGreaterThan(voidTicket.artifact.html.indexOf('وقت الطلب'));
        expect(mixed.artifact.html).toContain('[Combo]');
        expect(mixed.artifact.html.match(/-- ALSO ON ORDER --/g)).toHaveLength(1);
    });

    it('leaves Phase 0 legacy fallback goldens in place', () => {
        expect(existsSync(resolve(legacyFixtureDir, 'receipt-exclusive.html'))).toBe(true);
        expect(existsSync(resolve(legacyFixtureDir, 'kitchen-void.html'))).toBe(true);
    });
});
