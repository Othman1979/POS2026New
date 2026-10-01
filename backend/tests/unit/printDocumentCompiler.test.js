const templateEngine = require('../../services/printTemplateEngine');
const fs = require('fs');
const path = require('path');
const { prepareQueuedPrintPayload, loadStoreLogo } = require('../../services/printDocumentCompiler');
const templateManager = require('../../services/printTemplateManager');
const { getBuiltinTemplate } = require('../../services/printTemplateDefaults');
const logger = require('../../config/logger');

const receiptPresentation = {
    version: 1,
    currency: 'JD',
    decimals: 2,
    taxMode: 'exclusive',
    status: 'original',
    rows: [{
        key: 'coffee', kind: 'item', name: 'Coffee', note: '', qty: 1,
        unitPrice: 10, extendedPrice: 10, lineDiscountAmount: 0,
        lineDiscountLabel: null, netAmount: 10
    }],
    summary: {
        subtotal: 10, orderDiscountAmount: 0, orderDiscountLabel: null,
        taxAmount: 2.1, taxLabel: null, roundingAdjustment: 0, total: 12.1
    }
};

function receiptPayload(overrides = {}) {
    return {
        print_type: 'receipt',
        printer_id: 1,
        data: {
            storeInfo: { store_name: 'Template Cafe', receipt_config: '{}' },
            internal_invoice_id: 42,
            invoice_id: 42,
            invoice_number: 7001,
            invoice_display_no: '7001',
            order_display_no: '42',
            payment_method: 'cash',
            amount_tendered: 12.1,
            change_due: 0,
            date: '2026-07-25 14:00:00',
            cashier: 'Maya',
            order_type_name: 'Counter',
            receipt_display_v1: structuredClone(receiptPresentation),
            ...overrides
        }
    };
}

function kitchenPayload(overrides = {}) {
    return {
        print_type: 'kitchen',
        printer_id: 2,
        data: {
            order_display_no: '42', date: '2026-07-25 14:00:00', order_type_name: 'Counter',
            items: [{ name: 'Coffee', qty: 1, note: '' }],
            ...overrides
        }
    };
}

function executor(row = null) {
    return {
        query: vi.fn(async (sql, values = []) => {
            if (/FROM jofotara_documents/i.test(sql)) return [[row].filter(Boolean)];
            // Shaped like a real settings row: getSettings keys the result by setting_key,
            // so a value-only row would silently reduce to an empty settings map.
            if (/FROM settings/i.test(sql)) return [[{ setting_key: 'store_name', setting_value: 'Corner Cafe' }]];
            if (/FROM printers/i.test(sql)) {
                const docType = values[0];
                return [[{
                    printer_id: 1, printer_role: docType, printer_is_active: 1,
                    active_endpoint_key: `${docType}:windows:primary:counter`, active_revision_id: null,
                    revision_id: null, revision_no: null, definition_json: null, confirmed_at: null
                }]];
            }
            return [[]];
        })
    };
}

function acceptedRow(overrides = {}) {
    return {
        source_key: 'invoice:42', order_invoice_id: 42, document_kind: 'invoice',
        document_number: '7001', status: 'accepted', qr_text: 'official-qr', ...overrides
    };
}

async function compile(payload, db = executor(), options = {}) {
    return prepareQueuedPrintPayload(db, payload, {
        printRequestedAt: '2026-07-25T14:30:00.000Z',
        ...options
    });
}

describe('print document compiler', () => {
    afterEach(() => vi.restoreAllMocks());

    it('compiles trusted accepted receipt data with the authoritative QR and leaves its input untouched', async () => {
        const db = executor(acceptedRow());
        const payload = receiptPayload({
            jofotara: { status: 'accepted', qrText: 'forged-qr' },
            compiled_document_v1: { forged: true }
        });
        payload.compiled_document_v1 = { forged: true };
        const original = structuredClone(payload);

        const result = await compile(payload, db);

        expect(result).not.toBe(payload);
        expect(payload).toEqual(original);
        expect(result.compiled_document_v1).toBeUndefined();
        expect(result.data.jofotara).toBeUndefined();
        expect(result.data.compiled_document_v1).toMatchObject({ docType: 'receipt', templateRevisionId: 'builtin:receipt-v1' });
        expect(result.data.compiled_document_v1.html).toContain('data:image/png;base64,');
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('source_key = ?'),
            ['invoice:42', 42]
        );
    });

    it('loads only the existing bounded store icon with matching bytes', async () => {
        const definition = getBuiltinTemplate('receipt');
        definition.bands[0].nodes.push({ id: 'logo', type: 'store_logo', size: 64, style: {} });
        const db = { query: vi.fn().mockResolvedValue([[{ setting_value: '/uploads/store_icon.png' }]]) };
        const uploads = path.resolve(__dirname, '../../../uploads');
        vi.spyOn(fs.promises, 'realpath').mockResolvedValueOnce(uploads).mockResolvedValueOnce(path.join(uploads, 'store_icon.png'));
        vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]));
        await expect(loadStoreLogo(db, definition)).resolves.toEqual({ dataUri: expect.stringContaining('data:image/png;base64,'), warning: null });
        db.query.mockResolvedValueOnce([[{ setting_value: '/uploads/store_icon.svg' }]]);
        await expect(loadStoreLogo(db, definition)).resolves.toMatchObject({ dataUri: null, warning: expect.any(String) });
    });

    it('logs an unavailable runtime store logo without blocking the print document', async () => {
        const definition = getBuiltinTemplate('receipt');
        definition.bands[0].nodes.push({ id: 'logo', type: 'store_logo', size: 64, style: {} });
        vi.spyOn(templateManager, 'resolveActiveTemplate').mockResolvedValue({
            kind: 'builtin', definition, templateRevisionId: 'builtin:receipt-v1'
        });
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

        const result = await compile(receiptPayload(), executor(acceptedRow()));

        expect(result.data.compiled_document_v1.html).not.toContain('class="pt-logo"');
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ docType: 'receipt', templateRevisionId: 'builtin:receipt-v1', reason: 'Store Brand Icon is not configured.' }),
            'Store Brand Icon was omitted from a compiled print template.'
        );
    });

    it('keeps the ordinary receipt when an accepted invoice has no QR text', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const result = await compile(receiptPayload(), executor(acceptedRow({ qr_text: '' })));

        expect(result.data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'accepted JoFotara document has no valid QR text' }),
            'Malformed accepted JoFotara evidence was ignored for receipt enrichment.'
        );
    });

    it.each([undefined, { version: 1 }])('keeps the ordinary payload when an accepted invoice lacks a trusted receipt model (%j)', async receipt_display_v1 => {
        const result = await compile(receiptPayload({ receipt_display_v1 }), executor(acceptedRow()));

        expect(result.data.jofotara).toBeUndefined();
        expect(result.data.compiled_document_v1).toBeUndefined();
    });

    it('keeps a non-official historical receipt on the legacy path when its payment fields cannot form a trusted model', async () => {
        const payload = receiptPayload({ amount_tendered: null });

        const result = await compile(payload);

        expect(result.data).toEqual({...payload.data,business_config:{business_sql_offset:'+03:00',business_day_start_hour:6}});
        expect(result.data.compiled_document_v1).toBeUndefined();
    });

    it.each(['pending', 'submitting', 'rejected', 'unknown'])('omits the QR for a %s JoFotara document', async status => {
        const result = await compile(receiptPayload(), executor(acceptedRow({ status, qr_text: 'not-official-yet' })));

        expect(result.data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
    });

    it('compiles a normal receipt when there is no JoFotara document', async () => {
        const result = await compile(receiptPayload(), executor());

        expect(result.data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
        expect(result.data.jofotara).toBeUndefined();
    });

    it('keeps the ordinary receipt instead of truncating an accepted QR over 4096 UTF-8 bytes', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const result = await compile(receiptPayload(), executor(acceptedRow({ qr_text: 'x'.repeat(4097) })));

        expect(result.data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'accepted JoFotara QR exceeds the 4096-byte limit' }),
            'Malformed accepted JoFotara evidence was ignored for receipt enrichment.'
        );
    });

    it('keeps the ordinary receipt when the accepted QR cannot be compiled', async () => {
        vi.spyOn(templateEngine, 'compileTemplate').mockRejectedValue(Object.assign(new Error('QR renderer failed'), {
            code: 'TEMPLATE_QR_RENDER_FAILED'
        }));

        const result = await compile(receiptPayload(), executor(acceptedRow()));

        expect(result.data.compiled_document_v1).toBeUndefined();
        expect(result.data.jofotara).toBeUndefined();
    });

    it.each([
        ['guest', { invoice_id: 'GUEST CHECK', provisional: true, jofotara: { status: 'accepted', qrText: 'forged' } }],
        ['held', { payment_method: 'held', jofotara: { status: 'accepted', qrText: 'forged' } }]
    ])('does not query or trust forged JoFotara data for a %s check', async (_name, overrides) => {
        const db = executor(acceptedRow());
        const result = await compile(receiptPayload(overrides), db);

        expect(db.query.mock.calls.some(([sql]) => /FROM jofotara_documents/i.test(sql))).toBe(false);
        expect(result.data.jofotara).toBeUndefined();
        expect(result.data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
    });

    it('treats a mismatched accepted database document as no official QR and logs it', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const result = await compile(receiptPayload(), executor(acceptedRow({ source_key: 'invoice:99', order_invoice_id: 99 })));

        expect(result.data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'accepted JoFotara document identity did not match the receipt' }),
            'Malformed accepted JoFotara evidence was ignored for receipt enrichment.'
        );
    });

    it.each([
        ['internal invoice ids disagree', { invoice_id: 43 }],
        ['public invoice number disagrees with the accepted document', { invoice_number: 7002, invoice_display_no: '7002' }],
        ['public display identity disagrees with the public invoice number', { invoice_display_no: '7002' }]
    ])('does not attach an accepted QR when server payload %s', async (_name, overrides) => {
        const db = executor(acceptedRow());
        const result = await compile(receiptPayload(overrides), db);

        expect(result.data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
        const jofotaraQueries = db.query.mock.calls.filter(([sql]) => /FROM jofotara_documents/i.test(sql));
        expect(jofotaraQueries).toHaveLength(_name === 'public invoice number disagrees with the accepted document' ? 1 : 0);
    });

    it('does not mutate a frozen array payload while stripping its forged fields', async () => {
        const data = Object.freeze(Object.assign([], {
            jofotara: { status: 'accepted', qrText: 'forged' },
            compiled_document_v1: { forged: true }
        }));
        const payload = Object.freeze({ print_type: 'receipt', data });

        const result = await compile(payload);

        expect(payload.data).toBe(data);
        expect(data.jofotara).toEqual({ status: 'accepted', qrText: 'forged' });
        expect(data.compiled_document_v1).toEqual({ forged: true });
        expect(result.data).not.toBe(data);
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.data.jofotara).toBeUndefined();
        expect(result.data.compiled_document_v1).toBeUndefined();
    });

    it('leaves non-receipt and non-kitchen jobs otherwise unchanged after stripping forged artifacts', async () => {
        const payload = {
            print_type: 'z_report', compiled_document_v1: { forged: true },
            data: { report: 'Z', jofotara: { forged: true }, compiled_document_v1: { forged: true } }
        };
        const result = await compile(payload);

        expect(result).toEqual({ print_type: 'z_report', data: { report: 'Z',business_config:{business_sql_offset:'+03:00',business_day_start_hour:6} } });
    });

    it('builds a trusted kitchen artifact without querying JoFotara', async () => {
        const db = executor(acceptedRow());
        const result = await compile(kitchenPayload(), db);

        expect(db.query.mock.calls.some(([sql]) => /FROM jofotara_documents/i.test(sql))).toBe(false);
        expect(result.data.compiled_document_v1).toMatchObject({ docType: 'kitchen', templateRevisionId: 'builtin:kitchen-v1' });
    });

    it('compiles a kitchen ticket whose quantities arrive as DECIMAL strings, headed by the store name', async () => {
        // MySQL returns DECIMAL columns as strings ("2.000000"), but the fixture above
        // uses a JS number. That gap is how a non-finite numeric binding reached
        // production: it failed the whole document, the caller swallowed the failure, and
        // every kitchen ticket silently fell back to the legacy layout instead.
        const db = executor();
        const result = await compile(kitchenPayload({
            items: [{ name: 'Coffee', qty: '2.000000', note: '' }]
        }), db);

        const artifact = result.data.compiled_document_v1;
        expect(artifact).toMatchObject({ docType: 'kitchen', templateRevisionId: 'builtin:kitchen-v1' });
        expect(artifact.html).toContain('Corner Cafe');
        expect(artifact.html).not.toContain('KITCHEN TICKET');
        expect(artifact.html).toContain('data-node="kitchen-order"');
        expect(artifact.html).not.toContain('kitchen-invoice');
    });

    it('keeps an older custom receipt while enforcing numbered unpaid held identity', async () => {
        const custom = getBuiltinTemplate('receipt');
        const identity = custom.bands.find(b=>b.id==='meta').nodes.find(n=>n.id==='identity-date-row');
        identity.nodes = identity.nodes.filter(n=>n.id!=='held-order-display');
        identity.nodes.find(n=>n.id==='guest-check').visibleWhen={path:'meta.provisional',op:'eq',value:true};
        custom.bands[0].nodes[0].label.en = 'Restaurant custom header';
        const fallback=vi.fn().mockResolvedValue({kind:'builtin',definition:getBuiltinTemplate('receipt'),templateRevisionId:'builtin:receipt-v1'});
        vi.spyOn(templateManager,'resolveActiveTemplate').mockResolvedValue({kind:'custom',definition:custom,templateRevisionId:11,fallback});
        const result=await compile(receiptPayload({held_order_receipt:true,provisional:true,payment_method:'held',order_id:17,order_display_no:'17'}));
        expect(fallback).not.toHaveBeenCalled();
        expect(result.data.compiled_document_v1.templateRevisionId).toBe('revision:11');
        expect(result.data.compiled_document_v1.html).toContain('Restaurant custom header');
        expect(result.data.compiled_document_v1.html).toContain('Order:');
        expect(result.data.compiled_document_v1.html).toContain('17');
        expect(result.data.compiled_document_v1.html).not.toMatch(/Invoice:|Ticket:|GUEST CHECK|Payment|Tendered/);
    });

    it('fails a held receipt compiler error without replacing the active restaurant template', async () => {
        const fallback = vi.fn();
        vi.spyOn(templateManager,'resolveActiveTemplate').mockResolvedValue({kind:'custom',definition:getBuiltinTemplate('receipt'),templateRevisionId:11,fallback});
        vi.spyOn(templateEngine,'compileTemplate').mockRejectedValue(Object.assign(new Error('Too large'),{code:'TEMPLATE_ARTIFACT_LIMIT'}));
        await expect(compile(receiptPayload({held_order_receipt:true,provisional:true,payment_method:'held',order_id:17,order_display_no:'17'})))
            .rejects.toMatchObject({statusCode:409,code:'HELD_RECEIPT_TEMPLATE_REQUIRED'});
        expect(fallback).not.toHaveBeenCalled();
    });

    it('uses the active custom template and falls back to builtin after a template compiler failure', async () => {
        const custom = getBuiltinTemplate('receipt');
        custom.bands[0].nodes[0].label.en = 'Custom Store';
        const fallback = vi.fn().mockResolvedValue({
            kind: 'builtin', id: null, definition: getBuiltinTemplate('receipt'), templateRevisionId: 'builtin:receipt-v1'
        });
        vi.spyOn(templateManager, 'resolveActiveTemplate').mockResolvedValue({
            kind: 'custom', id: 11, definition: custom, templateRevisionId: 11, fallback
        });
        vi.spyOn(templateEngine, 'compileTemplate')
            .mockRejectedValueOnce(Object.assign(new Error('custom invalid'), { code: 'TEMPLATE_ARTIFACT_LIMIT' }))
            .mockResolvedValueOnce({ artifact: { kind: 'compiled_document_v1', templateRevisionId: 'builtin:receipt-v1' }, warnings: [] });

        const result = await compile(receiptPayload());

        expect(templateManager.resolveActiveTemplate).toHaveBeenCalledWith(expect.anything(), 'receipt', expect.objectContaining({ printerId: 1 }));
        expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ code: 'TEMPLATE_ARTIFACT_LIMIT' }));
        expect(result.data.compiled_document_v1.templateRevisionId).toBe('builtin:receipt-v1');
    });

    it('compiles a custom receipt containing an editor-promoted positioned row', async () => {
        const custom = getBuiltinTemplate('receipt');
        const header = custom.bands.find(band => band.id === 'header');
        const storeNameIndex = header.nodes.findIndex(node => node.id === 'store-name');
        const storeName = header.nodes[storeNameIndex];
        header.nodes.splice(storeNameIndex, 1, {
            id: 'row-store-name',
            type: 'row',
            layout: 'absolute',
            height: 52,
            visibleWhen: null,
            style: {},
            nodes: [{ ...storeName, style: { ...storeName.style }, x: 8, y: 4, widthPx: 244, heightPx: 44 }]
        });
        vi.spyOn(templateManager, 'resolveActiveTemplate').mockResolvedValue({
            kind: 'custom', id: 27, definition: custom, templateRevisionId: 27,
            fallback: vi.fn()
        });

        const result = await compile(receiptPayload());
        const artifact = result.data.compiled_document_v1;

        expect(artifact.templateRevisionId).toBe('revision:27');
        expect(artifact.html).toContain('data-node="row-store-name"');
        expect(artifact.html).toContain('height:52px;position:relative;overflow:hidden');
        expect(artifact.html).toContain('data-node="store-name"');
        expect(artifact.html).toContain('left:8px;top:4px;width:244px;height:44px');
    });

    it('records and falls back from an unexpected custom-template compiler failure', async () => {
        const fallback = vi.fn().mockResolvedValue({
            kind: 'builtin', id: null, definition: getBuiltinTemplate('receipt'), templateRevisionId: 'builtin:receipt-v1'
        });
        vi.spyOn(templateManager, 'resolveActiveTemplate').mockResolvedValue({
            kind: 'custom', id: 11, definition: getBuiltinTemplate('receipt'), templateRevisionId: 11, fallback
        });
        vi.spyOn(templateEngine, 'compileTemplate')
            .mockRejectedValueOnce(new Error('unexpected custom compiler fault'))
            .mockResolvedValueOnce({ artifact: { kind: 'compiled_document_v1', templateRevisionId: 'builtin:receipt-v1' }, warnings: [] });

        const result = await compile(receiptPayload());

        expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ message: 'unexpected custom compiler fault' }));
        expect(result.data.compiled_document_v1.templateRevisionId).toBe('builtin:receipt-v1');
    });

    it('falls back to the complete legacy payload when no official QR is required and compilation fails', async () => {
        vi.spyOn(templateEngine, 'compileTemplate').mockRejectedValue(Object.assign(new Error('too large'), { code: 'TEMPLATE_ARTIFACT_LIMIT' }));
        const payload = receiptPayload();
        const result = await compile(payload);

        expect(result.data.receipt_display_v1).toEqual(payload.data.receipt_display_v1);
        expect(result.data.compiled_document_v1).toBeUndefined();
    });

    it('does not hide an unclassified compiler failure as a legacy fallback', async () => {
        vi.spyOn(templateEngine, 'compileTemplate').mockRejectedValue(new Error('unexpected compiler fault'));

        await expect(compile(receiptPayload())).rejects.toThrow('unexpected compiler fault');
    });
});
