const {
    validateTemplate,
    compileTemplate,
    getTemplateCatalog
} = require('../../services/printTemplateEngine');
const { getBuiltinTemplate } = require('../../services/printTemplateDefaults');

const profile = Object.freeze({ allowAbsoluteOnce: false, allowStoreLogo: false });
const positionedProfile = Object.freeze({ allowAbsoluteOnce: true, allowStoreLogo: false });
const testContext = (templateRevisionId = 'builtin:receipt-v1') => ({ mode: 'test', templateRevisionId });

function receiptModel(overrides = {}) {
    return {
        store: { name: 'Golden <Cafe>', address: 'Amman', phone: '0790000000', customHeaderText: '', customFooterText: '' },
        meta: { invoiceDisplayNo: 'INV-42', ticketDisplayNo: '42', orderDisplayNo: '42', internalInvoiceId: 42, date: '2026-07-25', orderTakenAt: '', printRequestedAt: '', cashier: 'Maya', orderTypeName: 'Dine In', tableNumber: 'T1', hashNumber: '', provisional: false, note: '' },
        customer: { name: '', phone: '', address: '', deliveryDate: '' },
        payment: { method: 'split', cashAmount: 5, cardAmount: 7.1, amountTendered: 12.1, changeDue: 0 },
        jofotara: null,
        rows: [{ key: 'burger', kind: 'item', name: 'Burger <fresh>', note: 'No onion', qty: 1, unitPrice: 10, extendedPrice: 10, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 10 }],
        summary: { subtotal: 10, orderDiscountAmount: 0, orderDiscountLabel: null, taxAmount: 2.1, taxLabel: null, roundingAdjustment: 0, total: 12.1 },
        taxMode: 'exclusive', status: 'original', currency: 'JD', decimals: 2,
        ...overrides
    };
}

function kitchenModel(overrides = {}) {
    return {
        meta: { ticketType: 'void', ticketTypeLabel: 'KITCHEN TICKET', invoiceDisplayNo: '', ticketDisplayNo: '', orderDisplayNo: 'T-9', date: '2026-07-25', orderTakenAt: '', printRequestedAt: '', orderTypeName: 'Dine In', tableNumber: 'T9', hashNumber: '' },
        items: [{ name: 'Meal <one>', qty: 1, note: 'No onion', bundleLabel: '', isOther: false }, { name: 'Drink', qty: 1, note: '', bundleLabel: '', isOther: true }],
        voidTicket: true,
        subscriptionRedemption: null,
        printerLabel: 'Grill',
        ...overrides
    };
}

const label = (en, ar = '') => ({ en, ar, mode: 'auto' });
const field = (id, path, extra = {}) => ({ id, type: 'field', path, label: label(''), style: {}, ...extra });

function receiptTemplate() {
    return {
        schemaVersion: 1, docType: 'receipt', paper: { widthPx: 576 }, bands: [
            { id: 'header', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: null, nodes: [
                field('store', 'store.name'),
                { id: 'guest-check', type: 'text', text: label('GUEST CHECK'), style: {}, visibleWhen: { path: 'meta.provisional', op: 'eq', value: true } },
                field('invoice', 'meta.invoiceDisplayNo', { visibleWhen: { path: 'meta.provisional', op: 'eq', value: false } }),
                field('date', 'meta.date'), field('table', 'meta.tableNumber')
            ] },
            { id: 'items', kind: 'repeat', layout: 'flow', source: 'rows', filter: null, visibleWhen: null, nodes: [
                { id: 'item-row', type: 'row', nodes: [field('qty', 'qty'), field('name', 'name'), field('net', 'netAmount'), field('note', 'note', { visibleWhen: { path: 'note', op: 'truthy', value: null } })], style: {} }
            ] },
            { id: 'summary', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: null, nodes: [field('subtotal', 'summary.subtotal'), field('discount', 'summary.orderDiscountAmount'), field('tax', 'summary.taxAmount'), field('total', 'summary.total')] },
            { id: 'payment', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: { path: 'meta.provisional', op: 'eq', value: false }, nodes: [field('method', 'payment.method'), field('cash', 'payment.cashAmount'), field('card', 'payment.cardAmount')] },
            { id: 'qr', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: null, nodes: [{ id: 'jofotara', type: 'jofotara_qr', size: 96, style: {} }] }
        ]
    };
}

function kitchenTemplate() {
    return {
        schemaVersion: 1, docType: 'kitchen', paper: { widthPx: 576 }, bands: [
            { id: 'header', kind: 'once', layout: 'flow', source: null, filter: null, visibleWhen: null, nodes: [field('type', 'meta.ticketTypeLabel'), field('order', 'meta.orderDisplayNo'), field('table', 'meta.tableNumber')] },
            { id: 'items', kind: 'repeat', layout: 'flow', source: 'items', filter: { path: 'isOther', op: 'neq', value: true }, visibleWhen: null, nodes: [{ id: 'item-row', type: 'row', nodes: [field('qty', 'qty'), field('name', 'name'), field('note', 'note', { visibleWhen: { path: 'note', op: 'truthy', value: null } })], style: {} }] },
            { id: 'other', kind: 'repeat', layout: 'flow', source: 'items', filter: { path: 'isOther', op: 'eq', value: true }, visibleWhen: null, nodes: [field('other-name', 'name')] }
        ]
    };
}

function expectCode(fn, code) {
    expect(fn).toThrow(expect.objectContaining({ code }));
}

describe('print template engine', () => {
    it('publishes frozen closed catalogs rather than model-shaped arbitrary lookup', () => {
        const receipt = getTemplateCatalog('receipt');
        expect(receipt.docType).toBe('receipt');
        expect(receipt.sources).toEqual(['rows']);
        expect(receipt.fields).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'store.name', type: 'text' }), expect.objectContaining({ path: 'summary.total', type: 'money' })]));
        expect(() => getTemplateCatalog('report')).toThrow(expect.objectContaining({ code: 'TEMPLATE_DOC_TYPE_INVALID' }));
        expect(Object.isFrozen(receipt)).toBe(true);
    });

    it('stamps only validated server-owned template revision provenance', async () => {
        const template = receiptTemplate();
        await expect(compileTemplate(template, receiptModel(), testContext(42))).resolves.toMatchObject({ artifact: { templateRevisionId: 'revision:42', compilerVersion: 1 } });
        await expect(compileTemplate(template, receiptModel(), { mode: 'preview', templateRevisionId: 'preview:unpublished' })).resolves.toMatchObject({ artifact: { templateRevisionId: 'preview:unpublished' } });
        for (const context of [
            testContext('builtin:kitchen-v1'),
            testContext(0),
            { mode: 'test', templateRevisionId: 'preview:unpublished' },
            { mode: 'preview', templateRevisionId: 42 },
            { mode: 'preview', templateRevisionId: 'revision:42' }
        ]) {
            await expect(compileTemplate(template, receiptModel(), context)).rejects.toMatchObject({ code: 'TEMPLATE_CONTEXT_INVALID' });
        }
        const forged = receiptTemplate();
        forged.templateRevisionId = 'revision:999';
        expectCode(() => validateTemplate(forged, profile), 'TEMPLATE_SCHEMA_INVALID');
    });

    it('accepts a structurally complete receipt and compiles escaped trusted values at 576px', async () => {
        const template = receiptTemplate();
        expect(validateTemplate(template, profile)).toEqual(template);
        const { artifact, warnings } = await compileTemplate(template, receiptModel(), testContext());
        expect(warnings).toEqual([]);
        expect(artifact).toMatchObject({ version: 1, compilerVersion: 1, templateRevisionId: 'builtin:receipt-v1', kind: 'compiled_document_v1', docType: 'receipt', widthPx: 576 });
        expect(artifact.css).toContain('576px');
        expect(artifact.html).toContain('Golden &lt;Cafe&gt;');
        expect(artifact.html).toContain('Burger &lt;fresh&gt;');
        expect(artifact.html).toContain('12.10 JD');
        expect(artifact.html).not.toContain('<Cafe>');
        expect(artifact.nativeLayout).toMatchObject({
            version: 1,
            docType: 'receipt',
            widthPx: 576
        });
        expect(artifact.nativeLayout.bands.find(band => band.id === 'header')).toMatchObject({
            id: 'header',
            layout: 'flow'
        });
        expect(artifact.nativeLayout.bands.find(band => band.id === 'header').nodes[0]).toMatchObject({
            id: 'store',
            type: 'field',
            label: [],
            value: [{ text: 'Golden <Cafe>', direction: 'auto' }]
        });
        expect(JSON.stringify(artifact.nativeLayout)).not.toContain('&lt;');
    });

    it('rejects a receipt whose primary row omits the item note', () => {
        const definition = getBuiltinTemplate('receipt');
        const items = definition.bands.find(band => band.kind === 'repeat' && band.source === 'rows');
        items.nodes = items.nodes.filter(node => node.path !== 'note');

        expect(() => validateTemplate(definition, { allowAbsoluteOnce: true, allowStoreLogo: true }))
            .toThrow(/Receipt primary row requires note/);
    });

    it('allows a receipt whose item note is present but conditionally hidden', () => {
        expect(() => validateTemplate(getBuiltinTemplate('receipt'), { allowAbsoluteOnce: true, allowStoreLogo: true })).not.toThrow();
    });

    it('rejects a receipt whose item note is deliberately hidden', () => {
        const definition = getBuiltinTemplate('receipt');
        const items = definition.bands.find(band => band.kind === 'repeat' && band.source === 'rows');
        items.nodes.find(node => node.path === 'note').hidden = true;

        expect(() => validateTemplate(definition, { allowStoreLogo: true }))
            .toThrow(/cannot be hidden/);
    });

    it('rejects a receipt whose money row renders only for bundle children', () => {
        const definition = getBuiltinTemplate('receipt');
        const items = definition.bands.find(band => band.kind === 'repeat' && band.source === 'rows');
        items.nodes.find(node => node.id === 'receipt-item-row').visibleWhen = { path: 'kind', op: 'eq', value: 'bundle_child' };

        expect(() => validateTemplate(definition, { allowStoreLogo: true }))
            .toThrow(/cannot be hidden/);
    });

    it('rejects a manually hidden parent-row price', () => {
        const definition = getBuiltinTemplate('receipt');
        const items = definition.bands.find(band => band.kind === 'repeat' && band.source === 'rows');
        const row = items.nodes.find(node => node.id === 'receipt-item-row');
        row.nodes.find(node => node.path === 'netAmount').hidden = true;

        expect(() => validateTemplate(definition, { allowStoreLogo: true }))
            .toThrow(/cannot be hidden/);
    });

    it('keeps fractional kitchen quantities in an intrinsic non-wrapping column', async () => {
        const { artifact } = await compileTemplate(
            kitchenTemplate(),
            kitchenModel({
                items: [
                    { name: 'Half', qty: 0.5, note: '', bundleLabel: '', isOther: false },
                    { name: 'Three quarters', qty: 0.75, note: '', bundleLabel: '', isOther: false },
                    { name: 'One and a half', qty: 1.5, note: '', bundleLabel: '', isOther: false }
                ]
            }),
            testContext('builtin:kitchen-v1')
        );

        expect(artifact.html).toContain('class="pt-field pt-field-unlabelled pt-kitchen-qty"');
        expect(artifact.html).toContain('class="pt-field pt-field-unlabelled pt-kitchen-name"');
        expect(artifact.html).toContain('0.50x');
        expect(artifact.html).toContain('0.75x');
        expect(artifact.html).toContain('1.50x');
        expect(artifact.css).toContain('.pt-kitchen-qty{width:auto!important;min-width:75px;flex:0 0 auto;padding-inline-end:12px;white-space:nowrap}');
        expect(artifact.css).toContain('.pt-kitchen-name{width:auto!important;flex:1 1 auto;min-width:0}');

        const positioned = kitchenTemplate();
        const row = positioned.bands[1].nodes[0];
        row.layout = 'absolute';
        row.height = 40;
        Object.assign(row.nodes[0], { x: 0, y: 0, widthPx: 80, heightPx: 36 });
        Object.assign(row.nodes[1], { x: 84, y: 0, widthPx: 280, heightPx: 36 });
        Object.assign(row.nodes[2], { x: 368, y: 0, widthPx: 188, heightPx: 36 });
        const positionedResult = await compileTemplate(positioned, kitchenModel(), { ...testContext('builtin:kitchen-v1'), profile: positionedProfile });
        expect(positionedResult.artifact.html).toContain('class="pt-field pt-field-unlabelled" data-node="qty" style="position:absolute');
        expect(positionedResult.artifact.html).toContain('class="pt-field pt-field-unlabelled" data-node="name" style="position:absolute');
    });

    it('hides subtotal and tax bindings for inclusive customer receipts', async () => {
        const template = receiptTemplate();
        const inclusive = receiptModel({
            rows: [{ ...receiptModel().rows[0], unitPrice: 12.1, extendedPrice: 12.1, netAmount: 12.1 }],
            taxMode: 'inclusive',
            summary: { ...receiptModel().summary, subtotal: 12.1, taxAmount: 0, taxLabel: 'Included in prices', total: 12.1 }
        });
        const result = await compileTemplate(template, inclusive, testContext());
        expect(result.artifact.html).not.toContain('data-node="subtotal"');
        expect(result.artifact.html).not.toContain('data-node="tax"');
        expect(result.artifact.html).not.toContain('Included in prices');
        expect(result.artifact.html).toContain('12.10 JD');
        const bad = receiptTemplate();
        bad.bands[1].nodes[0].nodes[2].path = 'price';
        expectCode(() => validateTemplate(bad, profile), 'TEMPLATE_FIELD_NOT_ALLOWED');
    });

    it('lets old summary.taxAmount bindings render the exempt label', async () => {
        const result = await compileTemplate(receiptTemplate(), receiptModel({
            taxExempt: true,
            summary: { ...receiptModel().summary, taxAmount: 0, taxLabel: '(معفي من الضريبة)', total: 10 }
        }), testContext());
        expect(result.artifact.html).toContain('(معفي من الضريبة)');
        expect(result.artifact.html).not.toContain('data-node="tax"><span class="pt-value">0.00 JD');
    });

    it('supports independently styled field labels and values plus legacy receipt note lines', async () => {
        const template = receiptTemplate();
        const method = template.bands.find(band => band.id === 'payment').nodes[0];
        method.label = label('Payment');
        method.style = { fontWeight: 'bold' };
        method.labelStyle = { fontWeight: 'normal' };
        method.valueStyle = { textTransform: 'uppercase' };
        Object.assign(template.bands.find(band => band.id === 'items').nodes[0].nodes.find(node => node.path === 'note'), {
            format: 'list', visibleWhen: { path: 'note', op: 'truthy', value: null }
        });

        const { artifact } = await compileTemplate(template, receiptModel({
            rows: [{ key: 'burger', kind: 'item', name: 'Burger', note: 'No onion\nExtra cheese', qty: 1, unitPrice: 10, extendedPrice: 10, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 10 }]
        }), testContext());

        expect(artifact.html).toContain('<span class="pt-label" style="font-weight:400">Payment</span><span class="pt-value" style="text-transform:uppercase">split</span>');
        expect(artifact.html).toContain('- No onion\n- Extra cheese');
    });

    it('uses boolean fields as labelled switches instead of printing true or false', async () => {
        const render = async voidTicket => {
            const definition = kitchenTemplate();
            definition.bands[0].nodes.push(field('void-ticket-flag', 'voidTicket', { label: label('VOID') }));
            const result = await compileTemplate(definition, kitchenModel({ voidTicket }), {
                mode: 'preview', templateRevisionId: 'preview:unpublished', profile: positionedProfile
            });
            return result.artifact.html;
        };

        expect(await render(true)).toContain('VOID');
        expect(await render(true)).not.toMatch(/>true</);
        expect(await render(false)).not.toContain('data-node="void-ticket-flag"');
    });

    it('renders validated editable headings for each kitchen ticket type', async () => {
        const template = kitchenTemplate();
        const heading = template.bands[0].nodes[0];
        heading.variants = {
            normal: { en: 'GRILL TICKET', ar: '', mode: 'auto' },
            void: { en: 'VOID GRILL TICKET', ar: 'إلغاء المشاوي', mode: 'both' }
        };

        for (const scenario of [
            { type: 'normal', expected: 'GRILL TICKET', voidTicket: false },
            { type: 'void', expected: 'VOID GRILL TICKET<span dir="rtl"> إلغاء المشاوي</span>', voidTicket: true }
        ]) {
            const result = await compileTemplate(template, kitchenModel({
                meta: { ...kitchenModel().meta, ticketType: scenario.type, ticketTypeLabel: 'SERVER DEFAULT' },
                voidTicket: scenario.voidTicket
            }), testContext('builtin:kitchen-v1'));
            expect(result.artifact.html).toContain(scenario.expected);
            expect(result.artifact.html).not.toContain('SERVER DEFAULT');
        }

        // A ticket type with no variant falls through to meta.ticketTypeLabel.
        // The built-in template relies on this to head a plain ticket with the
        // store name, so the fall-through is a contract, not an accident.
        delete heading.variants.normal;
        const fellThrough = await compileTemplate(template, kitchenModel({
            meta: { ...kitchenModel().meta, ticketType: 'normal', ticketTypeLabel: 'BASHAR CAFE' },
            voidTicket: false
        }), testContext('builtin:kitchen-v1'));
        expect(fellThrough.artifact.html).toContain('BASHAR CAFE');
        expect(fellThrough.artifact.html).not.toContain('GRILL TICKET');
    });

    it('restricts heading variants to the trusted kitchen ticket heading field', () => {
        const wrongField = kitchenTemplate();
        wrongField.bands[0].nodes[1].variants = { normal: { en: 'Wrong', ar: '', mode: 'auto' } };
        expectCode(() => validateTemplate(wrongField, profile), 'TEMPLATE_SCHEMA_INVALID');

        const unknownType = kitchenTemplate();
        unknownType.bands[0].nodes[0].variants = { delivery: { en: 'Delivery', ar: '', mode: 'auto' } };
        expectCode(() => validateTemplate(unknownType, profile), 'TEMPLATE_SCHEMA_INVALID');

        const blankHeading = kitchenTemplate();
        blankHeading.bands[0].nodes[0].variants = { normal: { en: '', ar: '', mode: 'auto' } };
        expectCode(() => validateTemplate(blankHeading, profile), 'TEMPLATE_SCHEMA_INVALID');
    });

    it('rejects unknown field substyles instead of leaking arbitrary CSS', () => {
        const template = receiptTemplate();
        template.bands.find(band => band.id === 'payment').nodes[0].labelStyle = { position: 'fixed' };
        expectCode(() => validateTemplate(template, profile), 'TEMPLATE_SCHEMA_INVALID');
    });

    it('supports an inline label layout for legacy receipt metadata', async () => {
        const template = receiptTemplate();
        const table = template.bands[0].nodes.find(node => node.id === 'table');
        table.label = label('Table:');
        table.style.labelLayout = 'inline';

        const result = await compileTemplate(template, receiptModel(), testContext());

        expect(result.artifact.html).toContain('class="pt-field pt-field-inline"');
        expect(result.artifact.html).toContain('<span class="pt-label">Table:</span><span class="pt-value">T1</span>');
    });

    it('marks every rendered node for direct preview selection', async () => {
        const result = await compileTemplate(receiptTemplate(), receiptModel(), testContext());

        expect(result.artifact.html).toContain('data-node="store"');
        expect(result.artifact.html).toContain('data-node="subtotal"');
        expect(result.artifact.html).toContain('data-node="item-row"');
    });

    it('omits empty text fields so optional labels do not leave blank receipt rows', async () => {
        const template = receiptTemplate();
        template.bands[0].nodes.push(field('hash', 'meta.hashNumber', { label: label('#') }));
        const model = receiptModel({ meta: { ...receiptModel().meta, ticketDisplayNo: '', hashNumber: '' } });

        const result = await compileTemplate(template, model, testContext());

        expect(result.artifact.html).not.toContain('<span class="pt-label">#</span>');
    });

    it('rejects unknown schema properties, node types, styles, sources, enums, paths, and conditions', () => {
        for (const [mutate, code] of [
            [t => { t.unexpected = true; }, 'TEMPLATE_SCHEMA_INVALID'],
            [t => { t.bands[0].unexpected = true; }, 'TEMPLATE_SCHEMA_INVALID'],
            [t => { t.bands[0].nodes[0].type = 'html'; }, 'TEMPLATE_SCHEMA_INVALID'],
            [t => { t.bands[0].nodes[0].style.color = 'red'; }, 'TEMPLATE_SCHEMA_INVALID'],
            [t => { t.bands[1].source = 'orders'; }, 'TEMPLATE_SOURCE_INVALID'],
            [t => { t.bands[0].layout = 'grid'; }, 'TEMPLATE_SCHEMA_INVALID'],
            [t => { t.bands[0].nodes[0].path = 'store.secret'; }, 'TEMPLATE_FIELD_NOT_ALLOWED'],
            [t => { t.bands[0].nodes[0].visibleWhen = { path: 'store.name', op: 'contains', value: 'A' }; }, 'TEMPLATE_SCHEMA_INVALID']
        ]) {
            const template = receiptTemplate();
            mutate(template);
            expectCode(() => validateTemplate(template, profile), code);
        }
    });

    it('renders bounded monochrome thermal treatments without accepting arbitrary CSS', async () => {
        const template = receiptTemplate();
        template.bands[0].nodes[0].style.treatment = 'reverse';
        template.bands[0].nodes[2].style.treatment = 'outline';
        const result = await compileTemplate(template, receiptModel(), testContext());
        expect(result.artifact.html).toContain('background:#000;color:#fff');
        expect(result.artifact.html).toContain('border:3px solid #000');

        template.bands[0].nodes[0].style.treatment = 'shadow';
        expectCode(() => validateTemplate(template, profile), 'TEMPLATE_SCHEMA_INVALID');
    });

    it('rejects dangerous parsed or prototype-mutated keys before normalizing', () => {
        const parsed = JSON.parse('{"schemaVersion":1,"docType":"receipt","paper":{"widthPx":576},"bands":[],"__proto__":{"polluted":true}}');
        expectCode(() => validateTemplate(parsed, profile), 'TEMPLATE_DANGEROUS_KEY');
        const template = receiptTemplate();
        Object.setPrototypeOf(template.bands[0].nodes[0], { constructor: Object });
        expectCode(() => validateTemplate(template, profile), 'TEMPLATE_DANGEROUS_KEY');
        const arrayKey = receiptTemplate();
        Object.defineProperty(arrayKey.bands, '__proto__', { value: { polluted: true }, enumerable: true });
        expectCode(() => validateTemplate(arrayKey, profile), 'TEMPLATE_DANGEROUS_KEY');
        for (const key of ['prototype', 'constructor']) {
            const nestedArrayKey = receiptTemplate();
            Object.defineProperty(nestedArrayKey.bands[0].nodes, key, { value: { polluted: true }, enumerable: true });
            expectCode(() => validateTemplate(nestedArrayKey, profile), 'TEMPLATE_DANGEROUS_KEY');
        }
        const arrayPrototype = receiptTemplate();
        Object.setPrototypeOf(arrayPrototype.bands[0].nodes, {});
        expectCode(() => validateTemplate(arrayPrototype, profile), 'TEMPLATE_DANGEROUS_KEY');
    });

    it('allows absolute layout while keeping the store-logo gate', () => {
        const absolute = receiptTemplate();
        absolute.bands[0].layout = 'absolute';
        absolute.bands[0].height = 40;
        absolute.bands[0].nodes.forEach((node, index) => Object.assign(node, { x: index * 100, y: 0, widthPx: 96, heightPx: 32 }));
        expect(() => validateTemplate(absolute, profile)).not.toThrow();
        const logo = receiptTemplate();
        logo.bands[0].nodes.push({ id: 'logo', type: 'store_logo', size: 64, style: {} });
        expectCode(() => validateTemplate(logo, profile), 'TEMPLATE_FEATURE_NOT_ENABLED');
    });

    it('renders only a server-supplied store logo and otherwise keeps the document with a warning', async () => {
        const template = receiptTemplate();
        template.bands[0].nodes.push({ id: 'logo', type: 'store_logo', size: 64, style: {} });
        await expect(compileTemplate(template, receiptModel(), { ...testContext(), profile: { allowAbsoluteOnce: true, allowStoreLogo: true }, storeLogoDataUri: 'data:image/png;base64,AA==' }))
            .resolves.toMatchObject({ artifact: { html: expect.stringContaining('data:image/png;base64,AA==') }, warnings: [] });
        await expect(compileTemplate(template, receiptModel(), { ...testContext(), profile: { allowAbsoluteOnce: true, allowStoreLogo: true } }))
            .resolves.toMatchObject({ artifact: { html: expect.not.stringContaining('Store logo') }, warnings: [expect.stringContaining('Store Brand Icon')] });
        const legacyIco = await compileTemplate(template, receiptModel(), {
            ...testContext(),
            profile: { allowAbsoluteOnce: true, allowStoreLogo: true },
            storeLogoDataUri: 'data:image/x-icon;base64,AA=='
        });
        expect(legacyIco.artifact.html).toContain('data:image/x-icon;base64,AA==');
        expect(JSON.stringify(legacyIco.artifact.nativeLayout)).not.toContain('data:image/x-icon');
        expect(legacyIco.warnings).toEqual([expect.stringContaining('native print output')]);
        const repeated = receiptTemplate();
        repeated.bands[1].nodes.push({ id: 'repeated-logo', type: 'store_logo', size: 64, style: {} });
        expectCode(() => validateTemplate(repeated, { allowAbsoluteOnce: true, allowStoreLogo: true }), 'TEMPLATE_SCHEMA_INVALID');
    });

    it('bounds positioned once bands and emits their fixed clipped boxes without template CSS', async () => {
        const template = receiptTemplate();
        const header = template.bands[0];
        header.layout = 'absolute';
        header.height = 120;
        header.nodes.forEach((node, index) => Object.assign(node, { x: index * 100, y: 0, widthPx: 96, heightPx: 32 }));
        expect(validateTemplate(template, positionedProfile)).toEqual(template);
        const result = await compileTemplate(template, receiptModel(), { ...testContext(), profile: positionedProfile });
        expect(result.artifact.html).toContain('pt-band-positioned');
        expect(result.artifact.html).toContain('height:120px');
        expect(result.artifact.html).toContain('position:absolute;left:0px;top:0px;width:96px;height:32px;overflow:hidden');
        expect(result.artifact.html).not.toContain('transform:');
    });

    it('positions repeat-row columns independently without fixing the repeating band height', async () => {
        const template = receiptTemplate();
        const row = template.bands[1].nodes[0];
        row.layout = 'absolute';
        row.height = 40;
        Object.assign(row.nodes[0], { x: 0, y: 0, widthPx: 64, heightPx: 36 });
        Object.assign(row.nodes[1], { x: 68, y: 0, widthPx: 356, heightPx: 36 });
        Object.assign(row.nodes[2], { x: 428, y: 0, widthPx: 128, heightPx: 36 });
        Object.assign(row.nodes[3], { x: 0, y: 36, widthPx: 556, heightPx: 4 });

        expect(validateTemplate(template, positionedProfile)).toEqual(template);
        const result = await compileTemplate(template, receiptModel(), { ...testContext(), profile: positionedProfile });

        expect(result.artifact.html).toContain('pt-row-positioned');
        expect(result.artifact.html).toContain('height:40px');
        expect(result.artifact.html).toContain('data-node="qty"');
        expect(result.artifact.html).toContain('position:absolute;left:428px;top:0px;width:128px;height:36px;overflow:hidden');
        expect(result.artifact.html).not.toContain('data-band="items" style="height:');
    });

    it('skips hidden positioned rows without reserving height and preserves visible row margins', async () => {
        const template = kitchenTemplate();
        const otherBand = template.bands.find(band => band.id === 'other');
        otherBand.nodes = [{
            id: 'conditional-positioned-row',
            type: 'row',
            layout: 'absolute',
            height: 40,
            visibleWhen: { path: 'name', op: 'eq', value: 'Hidden' },
            style: { marginTop: 8, marginBottom: 12 },
            nodes: [field('conditional-name', 'name', { x: 8, y: 4, widthPx: 540, heightPx: 32 })]
        }];

        expect(validateTemplate(template, positionedProfile)).toEqual(template);
        const hidden = await compileTemplate(template, kitchenModel(), { ...testContext('builtin:kitchen-v1'), profile: positionedProfile });
        expect(hidden.artifact.html).not.toContain('data-node="conditional-positioned-row"');
        expect(hidden.artifact.html).not.toContain('height:40px;position:relative');

        otherBand.nodes[0].visibleWhen.value = 'Drink';
        const visible = await compileTemplate(template, kitchenModel(), { ...testContext('builtin:kitchen-v1'), profile: positionedProfile });
        expect(visible.artifact.html).toContain('class="pt-row pt-row-positioned" data-node="conditional-positioned-row"');
        expect(visible.artifact.html).not.toContain('class="pt-row pt-row-positioned pt-row-single"');
        expect(visible.artifact.html).toContain('margin-top:8px;margin-bottom:12px;height:40px;position:relative');
        expect(visible.artifact.html).toContain('data-node="conditional-name"');
    });

    it('rejects invalid positioned geometry and warns on permitted overlaps', async () => {
        const positioned = () => {
            const template = receiptTemplate();
            const header = template.bands[0];
            header.layout = 'absolute'; header.height = 120;
            header.nodes.forEach((node, index) => Object.assign(node, { x: index * 100, y: 0, widthPx: 96, heightPx: 32 }));
            return template;
        };
        for (const mutate of [
            template => { template.bands[0].kind = 'repeat'; template.bands[0].source = 'rows'; },
            template => { template.bands[0].height = 36; },
            template => { template.bands[0].height = 1204; },
            template => { template.bands[0].height = 121; },
            template => { template.bands[0].nodes[0].x = -4; },
            template => { template.bands[0].nodes[0].y = 2; },
            template => { template.bands[0].nodes[0].widthPx = 0; },
            template => { template.bands[0].nodes[0].widthPx = 580; },
            template => { template.bands[0].nodes[0].heightPx = 124; }
        ]) {
            const template = positioned(); mutate(template);
            expectCode(() => validateTemplate(template, positionedProfile), 'TEMPLATE_POSITION_INVALID');
        }
        const overlap = positioned();
        Object.assign(overlap.bands[0].nodes[2], { x: 0, y: 0, widthPx: 96, heightPx: 32 });
        await expect(compileTemplate(overlap, receiptModel(), { ...testContext(), profile: positionedProfile })).resolves.toMatchObject({ warnings: [expect.stringContaining('overlap')] });
        const rowOverlap = receiptTemplate();
        const itemRow = rowOverlap.bands[1].nodes[0];
        itemRow.layout = 'absolute'; itemRow.height = 40;
        itemRow.nodes.forEach(node => Object.assign(node, { x: 0, y: 0, widthPx: 64, heightPx: 36 }));
        const rowOverlapResult = await compileTemplate(rowOverlap, receiptModel(), { ...testContext(), profile: positionedProfile });
        expect(rowOverlapResult.warnings).toEqual(expect.arrayContaining([expect.stringContaining(`overlap in ${itemRow.id}`)]));
        const total = positioned();
        total.bands.push({ id: 'p2', kind: 'once', layout: 'absolute', source: null, filter: null, visibleWhen: null, height: 1200, nodes: [{ id: 'literal-p2', type: 'text', text: label('x'), style: {}, x: 0, y: 0, widthPx: 4, heightPx: 4 }] });
        total.bands.push({ id: 'p3', kind: 'once', layout: 'absolute', source: null, filter: null, visibleWhen: null, height: 1200, nodes: [{ id: 'literal-p3', type: 'text', text: label('x'), style: {}, x: 0, y: 0, widthPx: 4, heightPx: 4 }] });
        expectCode(() => validateTemplate(total, positionedProfile), 'TEMPLATE_POSITION_INVALID');
    });

    it('rejects control bytes but escapes template literals and field labels', async () => {
        const bad = receiptTemplate();
        bad.bands[0].nodes.push({ id: 'bad', type: 'text', text: label('Hi\x1b'), style: {} });
        expectCode(() => validateTemplate(bad, profile), 'TEMPLATE_TEXT_INVALID');
        const safe = receiptTemplate();
        safe.bands[0].nodes.push({ id: 'literal', type: 'text', text: label('<strong>not html</strong>'), style: {} });
        safe.bands[0].nodes[0].label = label('<label>');
        const result = await compileTemplate(safe, receiptModel(), testContext());
        expect(result.artifact.html).toContain('&lt;strong&gt;not html&lt;/strong&gt;');
        expect(result.artifact.html).toContain('&lt;label&gt;');
    });

    it('hides optional elements without allowing required print bindings to disappear', async () => {
        const optional = receiptTemplate();
        optional.bands[3].nodes.push(field('tendered', 'payment.amountTendered', { hidden: true }));
        const hidden = await compileTemplate(optional, receiptModel(), testContext());
        expect(hidden.artifact.html).not.toContain('data-node="tendered"');

        const required = receiptTemplate();
        required.bands[0].nodes[0].hidden = true;
        expectCode(() => validateTemplate(required, profile), 'TEMPLATE_REQUIRED_STRUCTURE_HIDDEN');

        const invalid = receiptTemplate();
        invalid.bands[0].nodes[4].hidden = 'yes';
        expectCode(() => validateTemplate(invalid, profile), 'TEMPLATE_SCHEMA_INVALID');

        const hiddenPayment = receiptTemplate();
        hiddenPayment.bands[3].nodes.find(node => node.path === 'payment.cashAmount').hidden = true;
        expectCode(() => validateTemplate(hiddenPayment, profile), 'TEMPLATE_REQUIRED_STRUCTURE_HIDDEN');

        const hiddenGuestCheck = receiptTemplate();
        hiddenGuestCheck.bands[0].nodes.find(node => node.id === 'guest-check').hidden = true;
        expectCode(() => validateTemplate(hiddenGuestCheck, profile), 'TEMPLATE_PROVISIONAL_BRANCH_INVALID');

        const hiddenGuestTable = receiptTemplate();
        hiddenGuestTable.bands[0].nodes.find(node => node.path === 'meta.tableNumber').hidden = true;
        expectCode(() => validateTemplate(hiddenGuestTable, profile), 'TEMPLATE_PROVISIONAL_BRANCH_INVALID');
    });

    it('counts static literal limits by characters, not UTF-8 bytes', () => {
        const template = receiptTemplate();
        template.bands[0].nodes.push({ id: 'arabic-limit', type: 'text', text: label('ا'.repeat(300)), style: {} });
        expect(validateTemplate(template, profile)).toEqual(template);
    });

    it('enforces receipt roles structurally rather than trusting author labels', () => {
        const missingTotal = receiptTemplate();
        missingTotal.bands[2].nodes = missingTotal.bands[2].nodes.filter(node => node.path !== 'summary.total');
        missingTotal.bands[2].nodes.push({ id: 'fake-total', type: 'text', text: label('Total'), style: {} });
        expectCode(() => validateTemplate(missingTotal, profile), 'TEMPLATE_REQUIRED_STRUCTURE_MISSING');
        const hiddenRows = receiptTemplate();
        hiddenRows.bands[1].visibleWhen = { path: 'name', op: 'truthy', value: null };
        expectCode(() => validateTemplate(hiddenRows, profile), 'TEMPLATE_REQUIRED_STRUCTURE_HIDDEN');
        const duplicateRows = receiptTemplate();
        duplicateRows.bands.push(structuredClone(duplicateRows.bands[1]));
        duplicateRows.bands.at(-1).id = 'other-rows';
        duplicateRows.bands.at(-1).nodes[0].id = 'other-item-row';
        duplicateRows.bands.at(-1).nodes[0].nodes.forEach(node => { node.id = `other-${node.id}`; });
        expectCode(() => validateTemplate(duplicateRows, profile), 'TEMPLATE_REQUIRED_STRUCTURE_INVALID');
        const hiddenTotal = receiptTemplate();
        hiddenTotal.bands[2].nodes.find(node => node.path === 'summary.total').visibleWhen = { path: 'meta.provisional', op: 'falsy', value: null };
        expectCode(() => validateTemplate(hiddenTotal, profile), 'TEMPLATE_REQUIRED_STRUCTURE_HIDDEN');
    });

    it('allows a conditional tax binding while retaining the structural tax role', () => {
        const template = receiptTemplate();
        template.bands[2].nodes.find(node => node.path === 'summary.taxAmount').visibleWhen = { path: 'taxMode', op: 'eq', value: 'exclusive' };
        expect(validateTemplate(template, profile)).toEqual(template);
    });

    it('enforces kitchen primary partition and primary row bindings exactly once', async () => {
        const template = kitchenTemplate();
        expect(validateTemplate(template, profile)).toEqual(template);
        const output = await compileTemplate(template, kitchenModel(), testContext('builtin:kitchen-v1'));
        expect(output.artifact.html).toContain('Meal &lt;one&gt;');
        expect(output.artifact.html).toContain('Drink');
        const duplicate = kitchenTemplate();
        duplicate.bands.push(structuredClone(duplicate.bands[1]));
        duplicate.bands.at(-1).id = 'duplicate-primary';
        duplicate.bands.at(-1).nodes[0].id = 'duplicate-item-row';
        duplicate.bands.at(-1).nodes[0].nodes.forEach(node => { node.id = `duplicate-${node.id}`; });
        expectCode(() => validateTemplate(duplicate, profile), 'TEMPLATE_REQUIRED_STRUCTURE_INVALID');
        const filtered = kitchenTemplate();
        filtered.bands[1].filter = null;
        expectCode(() => validateTemplate(filtered, profile), 'TEMPLATE_REQUIRED_STRUCTURE_INVALID');
        const missingNote = kitchenTemplate();
        missingNote.bands[1].nodes[0].nodes = missingNote.bands[1].nodes[0].nodes.filter(node => node.path !== 'note');
        expectCode(() => validateTemplate(missingNote, profile), 'TEMPLATE_REQUIRED_STRUCTURE_MISSING');
    });

    it('prints legacy and new QR sizes with a four-module quiet zone outside clipping boxes', async () => {
        const { PNG } = require('pngjs');
        const QRCode = require('qrcode');
        const { resolveCompiledDocument } = require('../../../pos-spooler-printer/renderDocument');
        const text = 'https://example.test/invoice/' + '1234567890abcdef'.repeat(30);
        const matrix = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
        for (const requested of [96, 128, 160, 384, 448, 512, 556]) {
            const template = receiptTemplate();
            const band = template.bands[4];
            band.layout = 'absolute'; band.height = 160;
            Object.assign(band.nodes[0], { size: requested, x: 0, y: 0, widthPx: 96, heightPx: 96 });
            const { artifact } = await compileTemplate(template, receiptModel({ jofotara: { status: 'accepted', qrText: text } }), testContext());
            expect(resolveCompiledDocument({ compiled_document_v1: artifact }, 'receipt')).toBe(artifact);
            expect(artifact.html).toMatch(/<\/section><div class="pt-qr"[^>]*><img/);
            const match = artifact.html.match(/alt="JoFotara QR" width="(\d+)" height="\d+" src="data:image\/png;base64,([^"]+)"/);
            const size = requested <= 160 ? 556 : requested;
            expect(Number(match[1])).toBe(size);
            const png = PNG.sync.read(Buffer.from(match[2], 'base64'));
            expect([png.width, png.height]).toEqual([size, size]);
            const scale = size / (matrix.size + 8);
            // Sample every data module and all four quiet-zone margins in the actual raster.
            for (let y = 0; y < matrix.size + 8; y++) for (let x = 0; x < matrix.size + 8; x++) {
                const px = Math.floor((x + 0.5) * scale), py = Math.floor((y + 0.5) * scale);
                const black = x >= 4 && y >= 4 && x < matrix.size + 4 && y < matrix.size + 4 && matrix.get(y - 4, x - 4);
                expect(png.data[(py * size + px) * 4]).toBe(black ? 0 : 255);
            }
        }
    });

    it('renders only accepted, bounded JoFotara QR data URIs and never takes a template path', async () => {
        const template = receiptTemplate();
        const accepted = receiptModel({ jofotara: { status: 'accepted', qrText: 'official-qr' } });
        const rendered = await compileTemplate(template, accepted, testContext());
        expect(rendered.artifact.html).toMatch(/data:image\/png;base64,/);
        for (const jofotara of [null, { status: 'pending', qrText: 'official-qr' }, { status: 'accepted', qrText: '' }]) {
            const result = await compileTemplate(template, receiptModel({ jofotara }), testContext());
            expect(result.artifact.html).not.toContain('data:image/png');
        }
        await expect(compileTemplate(template, receiptModel({ jofotara: { status: 'accepted', qrText: 'x'.repeat(4097) } }), testContext()))
            .rejects.toMatchObject({ code: 'TEMPLATE_QR_TOO_LARGE' });
        const forged = receiptTemplate();
        forged.bands[4].nodes[0].path = 'jofotara.qrText';
        expectCode(() => validateTemplate(forged, profile), 'TEMPLATE_SCHEMA_INVALID');
        const hidden = receiptTemplate();
        hidden.bands[4].visibleWhen = { path: 'meta.provisional', op: 'eq', value: false };
        expectCode(() => validateTemplate(hidden, profile), 'TEMPLATE_REQUIRED_STRUCTURE_HIDDEN');
    });

    it('bounds repeat expansion and artifact bytes without truncating items', async () => {
        const template = receiptTemplate();
        const rows = Array.from({ length: 2001 }, (_, index) => ({ ...receiptModel().rows[0], key: `row-${index}`, name: `Row ${index}` }));
        await expect(compileTemplate(template, receiptModel({ rows }), testContext())).rejects.toMatchObject({ code: 'TEMPLATE_EXPANSION_LIMIT' });
        const huge = receiptTemplate();
        huge.bands[0].nodes.push({ id: 'huge', type: 'text', text: label('A'.repeat(500)), style: {} });
        const hugeRows = Array.from({ length: 300 }, (_, index) => ({ ...receiptModel().rows[0], key: `huge-${index}`, name: 'N'.repeat(200) }));
        await expect(compileTemplate(huge, receiptModel({ rows: hugeRows }), testContext())).resolves.toMatchObject({ artifact: expect.any(Object) });
        await expect(compileTemplate(template, receiptModel({ rows: [{ ...receiptModel().rows[0], name: 'N'.repeat(300000) }] }), testContext()))
            .rejects.toMatchObject({ code: 'TEMPLATE_ARTIFACT_LIMIT' });
    });

    it('rejects empty bands and repeat floods before output is buffered', async () => {
        const empty = receiptTemplate();
        empty.bands[0].nodes = [];
        expectCode(() => validateTemplate(empty, profile), 'TEMPLATE_EMPTY_BAND');
        const flood = kitchenTemplate();
        const items = Array.from({ length: 20000 }, () => ({ name: 'Other', qty: 1, note: '', bundleLabel: '', isOther: true }));
        await expect(compileTemplate(flood, kitchenModel({ items }), testContext('builtin:kitchen-v1'))).rejects.toMatchObject({ code: 'TEMPLATE_EXPANSION_LIMIT' });
    });

    it('types condition values from their catalog fields and keeps truthiness canonical', () => {
        for (const condition of [
            { path: 'meta.provisional', op: 'eq', value: 'false' },
            { path: 'summary.total', op: 'gt', value: '12.10' },
            { path: 'meta.invoiceDisplayNo', op: 'eq', value: true },
            { path: 'meta.provisional', op: 'truthy', value: true },
            { path: 'summary.total', op: 'gte', value: Infinity }
        ]) {
            const template = receiptTemplate();
            template.bands[0].nodes[0].visibleWhen = condition;
            expectCode(() => validateTemplate(template, profile), 'TEMPLATE_SCHEMA_INVALID');
        }
        const canonical = receiptTemplate();
        canonical.bands[0].nodes.push({ id: 'optional', type: 'text', text: label('optional'), style: {}, visibleWhen: { path: 'meta.provisional', op: 'falsy', value: null } });
        expect(validateTemplate(canonical, profile)).toEqual(canonical);
    });

    it('compiles finite hard receipt and kitchen void trusted models end to end', async () => {
        const hard = receiptModel({
            rows: [{ key: 'bundle', kind: 'item', name: 'وجبة', note: 'بدون بصل\nextra', qty: 1, unitPrice: 10, extendedPrice: 10, lineDiscountAmount: 1, lineDiscountLabel: '10%', netAmount: 9 }, { key: 'child', kind: 'bundle_child', name: 'بطاطا', note: '', qty: 1, unitPrice: 0, extendedPrice: 0, lineDiscountAmount: 0, lineDiscountLabel: null, netAmount: 0 }],
            summary: { subtotal: 9, orderDiscountAmount: 1, orderDiscountLabel: '10%', taxAmount: 1.28, taxLabel: null, roundingAdjustment: 0, total: 9.28 },
            jofotara: { status: 'accepted', qrText: 'official-qr' }
        });
        await expect(compileTemplate(receiptTemplate(), hard, testContext())).resolves.toMatchObject({ artifact: { docType: 'receipt' } });
        await expect(compileTemplate(kitchenTemplate(), kitchenModel(), testContext('builtin:kitchen-v1'))).resolves.toMatchObject({ artifact: { docType: 'kitchen' } });
    });
});
