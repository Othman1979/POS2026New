const { isPaidPaymentMethod } = require('../utils/orderIdentity');
const { buildReceiptDocumentModel, buildKitchenDocumentModel } = require('./printDocumentModel');
const templateEngine = require('./printTemplateEngine');
const templateManager = require('./printTemplateManager');
const { getTemplateFixture, getBuiltinTemplate } = require('./printTemplateDefaults');
const { getSettings } = require('../config/settingsHelper');
const logger = require('../config/logger');
const fs = require('fs');
const path = require('path');

const MAX_QR_BYTES = 4096;
const MAX_LOGO_BYTES = 96 * 1024;
const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', ico: 'image/x-icon', webp: 'image/webp' };
const uploadDir = process.env.POSAPP_UPLOAD_DIR || path.join(__dirname, '../../uploads');

function conflict(code, message) {
    return Object.assign(new Error(message), { code, statusCode: 409 });
}

function isCompilerFailure(error) {
    return typeof error?.code === 'string' && error.code.startsWith('TEMPLATE_');
}

function templateHasLogo(template) {
    const visit = nodes => (nodes || []).some(node => node?.type === 'store_logo' || (node?.type === 'row' && visit(node.nodes)));
    return Boolean(template?.bands?.some(band => visit(band.nodes)));
}

function sniffLogoExtension(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
    if (buffer.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'ico';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
}

async function loadStoreLogo(executor, definition) {
    if (!templateHasLogo(definition)) return { dataUri: null, warning: null };
    const [settings] = await executor.query("SELECT setting_value FROM settings WHERE setting_key = 'store_icon' LIMIT 1");
    const value = settings[0]?.setting_value;
    const match = typeof value === 'string' && value.match(/^\/uploads\/store_icon\.(png|jpg|ico|webp)$/);
    if (!match) return { dataUri: null, warning: 'Store Brand Icon is not configured.' };
    const uploads = path.resolve(uploadDir);
    const candidate = path.resolve(uploads, path.basename(value));
    if (!candidate.startsWith(`${uploads}${path.sep}`)) return { dataUri: null, warning: 'Store Brand Icon path was rejected.' };
    try {
        const [realUploads, realFile] = await Promise.all([fs.promises.realpath(uploads), fs.promises.realpath(candidate)]);
        if (!realFile.startsWith(`${realUploads}${path.sep}`)) return { dataUri: null, warning: 'Store Brand Icon path was rejected.' };
        const image = await fs.promises.readFile(realFile);
        const ext = sniffLogoExtension(image);
        if (image.length > MAX_LOGO_BYTES || ext !== match[1]) return { dataUri: null, warning: 'Store Brand Icon file is invalid or too large.' };
        return { dataUri: `data:${LOGO_TYPES[ext]};base64,${image.toString('base64')}`, warning: null };
    } catch {
        return { dataUri: null, warning: 'Store Brand Icon is unavailable.' };
    }
}

function warnUnavailableStoreLogo(logo, docType, templateRevisionId) {
    if (!logo.warning) return;
    logger.warn({ docType, templateRevisionId, reason: logo.warning }, 'Store Brand Icon was omitted from a compiled print template.');
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function clonedData(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Object.assign([], value);
    if (isPlainObject(value)) return { ...value };
    try {
        return structuredClone(value);
    } catch {
        return null;
    }
}

function cleanPayload(payload = {}) {
    const data = clonedData(payload.data);
    const cleaned = { ...payload, ...(Object.prototype.hasOwnProperty.call(payload, 'data') ? { data } : {}) };
    delete cleaned.compiled_document_v1;
    delete cleaned.jofotara;
    delete cleaned.revisionOverrideId;
    delete cleaned.template_test;
    if (data && typeof data === 'object') {
        delete data.compiled_document_v1;
        delete data.jofotara;
        delete data.revisionOverrideId;
        delete data.template_test;
    }
    return cleaned;
}

function canonicalPositiveInteger(value) {
    const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) :
        (typeof value === 'string' ? value.trim() : '');
    if (!/^[1-9]\d*$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) ? String(number) : null;
}

function stablePaidInvoice(data = {}) {
    const internalInvoiceId = canonicalPositiveInteger(data.internal_invoice_id);
    const invoiceId = canonicalPositiveInteger(data.invoice_id);
    const publicInvoiceNumber = canonicalPositiveInteger(data.invoice_number);
    const displayInvoiceNumber = canonicalPositiveInteger(data.invoice_display_no);
    if (data.provisional || data.invoice_id === 'GUEST CHECK' || !isPaidPaymentMethod(data.payment_method) ||
        !internalInvoiceId || internalInvoiceId !== invoiceId || !publicInvoiceNumber || displayInvoiceNumber !== publicInvoiceNumber) {
        return null;
    }
    return { internalInvoiceId: Number(internalInvoiceId), publicInvoiceNumber };
}

async function acceptedJofotara(executor, data) {
    const invoice = stablePaidInvoice(data);
    if (!invoice) return null;

    const sourceKey = `invoice:${invoice.internalInvoiceId}`;
    const [rows] = await executor.query(
        `SELECT source_key, order_invoice_id, document_kind, document_number, status, qr_text
           FROM jofotara_documents
          WHERE source_key = ? AND order_invoice_id = ? AND document_kind = 'invoice'
          LIMIT 1`,
        [sourceKey, invoice.internalInvoiceId]
    );
    const row = rows[0];
    if (!row) return null;
    if (row.source_key !== sourceKey || Number(row.order_invoice_id) !== invoice.internalInvoiceId ||
        row.document_kind !== 'invoice' || canonicalPositiveInteger(row.document_number) !== invoice.publicInvoiceNumber) {
        if (row.status === 'accepted') {
            logger.warn(
                { invoiceId: invoice.internalInvoiceId, reason: 'accepted JoFotara document identity did not match the receipt' },
                'Malformed accepted JoFotara evidence was ignored for receipt enrichment.'
            );
        }
        return null;
    }
    if (row.status !== 'accepted') return null;
    if (typeof row.qr_text !== 'string' || row.qr_text.length === 0) {
        logger.warn(
            { invoiceId: invoice.internalInvoiceId, reason: 'accepted JoFotara document has no valid QR text' },
            'Malformed accepted JoFotara evidence was ignored for receipt enrichment.'
        );
        return null;
    }
    if (Buffer.byteLength(row.qr_text, 'utf8') > MAX_QR_BYTES) {
        logger.warn(
            { invoiceId: invoice.internalInvoiceId, reason: 'accepted JoFotara QR exceeds the 4096-byte limit' },
            'Malformed accepted JoFotara evidence was ignored for receipt enrichment.'
        );
        return null;
    }
    return { status: 'accepted', qrText: row.qr_text };
}

// Only the store name. The full settings row set includes JoFotara secrets, and this
// value is passed into the document model rather than persisted onto the payload.
// A settings read that fails must not take the ticket down with it - the heading falls
// back to the constant and the food still reaches the kitchen.
async function loadKitchenStoreInfo(executor) {
    try {
        return await getSettings(executor, ['store_name']);
    } catch {
        return null;
    }
}

async function compileBuiltin(executor, docType, model, payload, data, options) {
    let resolved = await templateManager.resolveActiveTemplate(executor, docType, {
        printerId: payload.printer_id,
        storeInfo: options.storeInfo || data.storeInfo,
        revisionOverrideId: options.revisionOverrideId,
        browser: options.browser === true,
        strict: model.meta?.heldOrderReceipt === true || data.held_order === true
    });
    if (model.meta?.heldOrderReceipt && resolved.kind !== 'custom') {
        resolved = {...resolved,definition:getBuiltinTemplate('receipt', {storeInfo:options.storeInfo || data.storeInfo,heldOrderReceipt:true})};
    }
    const logo = await loadStoreLogo(executor, resolved.definition);
    warnUnavailableStoreLogo(logo, docType, resolved.templateRevisionId);
    try {
        const result = await templateEngine.compileTemplate(resolved.definition, model, {
            mode: 'runtime',
            templateRevisionId: resolved.templateRevisionId,
            printRequestedAt: options.printRequestedAt,
            profile: { allowStoreLogo: true }, storeLogoDataUri: logo.dataUri
        });
        return result.artifact;
    } catch (error) {
        if (model.meta?.heldOrderReceipt || data.held_order === true) throw error;
        if (resolved.kind !== 'custom' || typeof resolved.fallback !== 'function') throw error;
        const fallback = await resolved.fallback(error);
        const fallbackLogo = await loadStoreLogo(executor, fallback.definition);
        warnUnavailableStoreLogo(fallbackLogo, docType, fallback.templateRevisionId);
        const result = await templateEngine.compileTemplate(fallback.definition, model, {
            mode: 'runtime',
            templateRevisionId: fallback.templateRevisionId,
            printRequestedAt: options.printRequestedAt,
            profile: { allowStoreLogo: true }, storeLogoDataUri: fallbackLogo.dataUri
        });
        return result.artifact;
    }
}

function templateTest(docType, payload, options) {
    const test = options?.templateTest;
    if (!test) return null;
    if (typeof test !== 'object' || Array.isArray(test) || test.docType !== docType ||
        !Number.isSafeInteger(test.printerId) || test.printerId < 1 || Number(payload.printer_id) !== test.printerId ||
        typeof test.printerEndpointKey !== 'string' || !test.printerEndpointKey || typeof test.fixtureKey !== 'string' ||
        !(test.revisionId === null || (Number.isSafeInteger(test.revisionId) && test.revisionId > 0))) {
        throw conflict('PRINT_TEMPLATE_TEST_INVALID', 'Invalid private template test request.');
    }
    try {
        return {
            model: getTemplateFixture(docType, test.fixtureKey),
            marker: {
                docType, revisionId: test.revisionId, printerId: test.printerId,
                printerEndpointKey: test.printerEndpointKey, fixtureKey: test.fixtureKey
            },
            storeInfo: test.storeInfo || null
        };
    } catch {
        throw conflict('PRINT_TEMPLATE_FIXTURE_NOT_FOUND', 'Unknown print template fixture.');
    }
}

function addTemplateTestNotice(artifact) {
    const marker = '<div class="pt-template-test" style="margin:0 0 10px;padding:8px;border:3px solid #000;text-align:center;font-size:18px;font-weight:900">TEMPLATE TEST — NOT A SALE</div>';
    const nativeLayout = artifact.nativeLayout ? {
        ...artifact.nativeLayout,
        bands: [...artifact.nativeLayout.bands, {
            id: 'template-test-notice', layout: 'flow', nodes: [{
                id: 'template-test-notice', type: 'text',
                value: [{ text: 'TEMPLATE TEST — NOT A SALE', direction: 'ltr' }],
                style: { fontSize: 'xs', fontWeight: 'black', align: 'center', padding: 8, treatment: 'outline', marginBottom: 10 }
            }]
        }]
    } : undefined;
    return { ...artifact, html: artifact.html.replace('</main>', `${marker}</main>`), ...(nativeLayout ? { nativeLayout } : {}) };
}

async function prepareQueuedPrintPayload(executor, payload, options = {}) {
    const prepared = cleanPayload(payload);
    if (isPlainObject(prepared.data)) {
        const { getBusinessSqlOffset, getBusinessDayStartHour } = require('../utils/businessDate');
        prepared.data.business_config = { business_sql_offset: getBusinessSqlOffset(), business_day_start_hour: getBusinessDayStartHour() };
    }
    if (!['receipt', 'kitchen'].includes(prepared.print_type) || !isPlainObject(prepared.data)) return prepared;

    const { data } = prepared;
    const test = templateTest(prepared.print_type, prepared, options);
    if (test) {
        try {
            data.compiled_document_v1 = addTemplateTestNotice(await compileBuiltin(
                executor, prepared.print_type, test.model, prepared, data, { ...options, storeInfo: test.storeInfo }
            ));
            data.template_test = test.marker;
        } catch (error) {
            if (!isCompilerFailure(error)) throw error;
            throw conflict('PRINT_TEMPLATE_TEST_COMPILE_FAILED', 'The template test could not be compiled.');
        }
        return prepared;
    }
    if (prepared.print_type === 'receipt') {
        const jofotara = await acceptedJofotara(executor, data);
        let model;
        try {
            model = buildReceiptDocumentModel(data, { jofotara, printRequestedAt: options.printRequestedAt });
        } catch (error) {
            return prepared;
        }
        if (!model) return prepared;
        try {
            data.compiled_document_v1 = await compileBuiltin(executor, 'receipt', model, prepared, data, options);
        } catch (error) {
            if (!isCompilerFailure(error)) throw error;
            if (data.held_order_receipt === true) throw conflict('HELD_RECEIPT_TEMPLATE_REQUIRED', 'The held-order receipt template could not be compiled.');
            if (!jofotara) return prepared;
            // JoFotara enrichment is optional. If the QR-specific model cannot be
            // compiled, retry the ordinary receipt once, then preserve the raw
            // payload if the normal template is unavailable too.
            let fallbackModel;
            try {
                fallbackModel = buildReceiptDocumentModel(data, { jofotara: null, printRequestedAt: options.printRequestedAt });
                if (!fallbackModel) return prepared;
                data.compiled_document_v1 = await compileBuiltin(executor, 'receipt', fallbackModel, prepared, data, options);
            } catch (fallbackError) {
                if (!isCompilerFailure(fallbackError)) throw fallbackError;
            }
        }
        return prepared;
    }

    // The kitchen payload does not carry storeInfo the way the receipt payload does, and
    // the ticket heading is the store name. Read just that one setting instead of
    // attaching the whole settings blob, which would persist API secrets into every
    // kitchen print job.
    const storeInfo = isPlainObject(data.storeInfo) ? data.storeInfo : await loadKitchenStoreInfo(executor);
    const model = buildKitchenDocumentModel(data, { printRequestedAt: options.printRequestedAt, storeInfo });
    try {
        data.compiled_document_v1 = await compileBuiltin(executor, 'kitchen', model, prepared, data, { ...options, storeInfo });
    } catch (error) {
        if (!isCompilerFailure(error)) throw error;
        if (data.held_order === true) throw conflict('HELD_KITCHEN_TEMPLATE_REQUIRED', 'The held-order kitchen template could not be compiled.');
        if (data.follow_up === true || data.cancel_ticket === true) {
            throw conflict(
                data.follow_up === true ? 'HELD_FOLLOW_UP_TEMPLATE_REQUIRED' : 'HELD_CANCEL_TEMPLATE_REQUIRED',
                data.follow_up === true
                    ? 'The FOLLOW UP kitchen template could not be compiled safely.'
                    : 'The order-cancellation kitchen template could not be compiled safely.'
            );
        }
        // Keep the legacy kitchen payload when the compiler cannot produce an artifact -
        // but never silently. This degradation hid a single non-finite quantity binding
        // that disabled the kitchen template on every ticket for as long as it existed.
        logger.warn(
            { code: error.code, reason: error.message, printerId: prepared.printer_id },
            'Kitchen template compile failed; falling back to the legacy kitchen layout.'
        );
    }
    return prepared;
}

module.exports = { prepareQueuedPrintPayload, loadStoreLogo };
