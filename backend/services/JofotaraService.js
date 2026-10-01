const { parseBackendTimestamp, zonedLocalTimeToDate, formatDbTimestamp, addBusinessDays } = require('../utils/businessDate');
const crypto = require('crypto');
const pool = require('../config/db');
const logger = require('../config/logger');
const { getSettings } = require('../config/settingsHelper');
const {
    TAX_REGISTRATION_TYPES, normalizeTaxRegistrationType, taxRegistrationTypeFromSettings,
    profileSettingKeys, jofotaraConfigFromSettings, requiresJofotaraSalesTaxRates,
    isSupportedJofotaraSalesTaxRate, normalizeJofotaraTaxCategory
} = require('../config/taxRegistration');
const { appendAuditEvent } = require('./auditEvents');
const { submitXml } = require('./JofotaraClient');
const { archiveSubmissionXml } = require('./JofotaraXmlArchive');
const {
    buildInvoiceSnapshot, renderInvoiceXml, buildCreditNoteSnapshot,
    renderCreditNoteXml, previewIdentity, publicError
} = require('./JofotaraXmlBuilder');

const SETTING_KEYS = [
    'tax_registration_type', 'jofotara_enabled', 'jofotara_auto_submit', 'jofotara_auto_submit_since', 'jofotara_archive_xml',
    ...Object.values(TAX_REGISTRATION_TYPES).flatMap(profile => Object.values(profileSettingKeys(profile)))
];

function jofotaraConfigForSelectedProfile(settings) {
    const profile = taxRegistrationTypeFromSettings(settings);
    return { profile, ...jofotaraConfigFromSettings(settings, profile) };
}

function credentialsForProfile(settings, frozenProfile) {
    const profile = normalizeTaxRegistrationType(frozenProfile);
    return { profile, ...jofotaraConfigFromSettings(settings, profile) };
}

function sellerFromSettings(config) {
    return {
        incomeSourceSequence: config.incomeSourceSequence || '',
        taxNumber: config.sellerTaxNumber || '',
        registeredName: config.sellerRegisteredName || ''
    };
}

function validateSeller(seller) {
    if (!seller.incomeSourceSequence || !seller.taxNumber || !seller.registeredName) {
        throw publicError('Complete the JoFotara seller information first.', 'JOFOTARA_SELLER_INCOMPLETE', 409);
    }
    if (!/^\d+$/.test(seller.incomeSourceSequence) || !/^\d+$/.test(seller.taxNumber)) {
        throw publicError('Income-source sequence and tax number must contain digits only.', 'JOFOTARA_SELLER_INVALID', 409);
    }
}

function validateSubmissionSettings(config, { sellerRequired = true } = {}) {
    if (!config.enabled) throw publicError('JoFotara integration is disabled.', 'JOFOTARA_DISABLED', 409);
    if (sellerRequired) validateSeller(sellerFromSettings(config));
    if (!config.clientId || !config.secretKey) {
        throw publicError('Complete the JoFotara API credentials first.', 'JOFOTARA_CREDENTIALS_INCOMPLETE', 409);
    }
}

function settingsMap(rows) {
    return Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
}

async function lockJofotaraPolicy(conn) {
    const keys = [...SETTING_KEYS, 'service_charge_enabled', 'service_charge_tax_rate', 'service_charge_jofotara_tax_category'];
    const [rows] = await conn.query(
        `SELECT setting_key, setting_value FROM settings
         WHERE setting_key IN (${keys.map(() => '?').join(',')})
         ORDER BY setting_key FOR UPDATE`,
        keys
    );
    return settingsMap(rows);
}

function unsupportedRateError(rates) {
    return publicError(
        `JoFotara sales-tax mode does not support these active rates: ${rates.join(', ')}.`,
        'JOFOTARA_UNSUPPORTED_RATE',
        409
    );
}

async function validateJofotaraCatalogRates(conn, settings, additionalRates = []) {
    if (!requiresJofotaraSalesTaxRates(settings)) return;
    const [products] = await conn.query(
        `SELECT DISTINCT p.tax_rate, p.jofotara_tax_category
           FROM products p
          WHERE p.is_active = 1`
    );
    const rates = products.map(row => Number(row.tax_rate));
    try {
        products.forEach(row => normalizeJofotaraTaxCategory(row.jofotara_tax_category, row.tax_rate));
    } catch (error) {
        throw publicError(error.message, 'JOFOTARA_INVALID_TAX_CATEGORY', 409);
    }
    if (String(settings.service_charge_enabled) === '1') {
        try {
            normalizeJofotaraTaxCategory(settings.service_charge_jofotara_tax_category, settings.service_charge_tax_rate);
        } catch (error) {
            throw publicError(`Service charge configuration: ${error.message}`, 'JOFOTARA_INVALID_TAX_CATEGORY', 409);
        }
    }
    if (String(settings.service_charge_enabled) === '1') rates.push(Number(settings.service_charge_tax_rate));
    rates.push(...additionalRates.map(Number));
    const unsupported = [...new Set(rates.filter(rate => !isSupportedJofotaraSalesTaxRate(rate)))].sort((a, b) => a - b);
    if (unsupported.length) throw unsupportedRateError(unsupported);
}

async function validateJofotaraSettingsForSave(conn, settings) {
    const enabled = String(settings.jofotara_enabled || '0') === '1';
    const autoSubmit = String(settings.jofotara_auto_submit || '0') === '1';
    if (autoSubmit && !enabled) throw publicError('Automatic JoFotara submission requires the integration to be enabled.', 'JOFOTARA_AUTO_REQUIRES_ENABLED', 409);
    if (!enabled) return;
    const selected = taxRegistrationTypeFromSettings(settings);
    const config = credentialsForProfile(settings, selected);
    validateSubmissionSettings(config);
    await validateJofotaraCatalogRates(conn, settings);
}

const paymentTermsFor = order => ['receivable', 'platform'].includes(order?.payment_method) ? 'receivable' : 'cash';

async function loadInvoice(executor, invoiceId, lock = false) {
    const [[order]] = await executor.query(
        `SELECT o.*,
                COALESCE(o.buyer_name_at_sale, c.name) AS customer_name,
                COALESCE(o.buyer_phone_at_sale, c.phone) AS customer_phone,
                COALESCE(o.buyer_address_at_sale, c.address) AS customer_address
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
         WHERE o.invoice_id = ? ${lock ? 'FOR UPDATE' : ''}`,
        [invoiceId]
    );
    if (!order || !['cash', 'card', 'split', 'receivable', 'platform'].includes(order.payment_method) || !order.invoice_number) {
        throw publicError('Only finalized invoices can be used.', 'JOFOTARA_INVALID_INVOICE');
    }
    const [items] = await executor.query('SELECT * FROM order_items WHERE invoice_id = ? ORDER BY sort_order, id', [invoiceId]);
    return { order, items, customer: order.customer_name || order.customer_phone || order.customer_address ? { id: order.customer_id || null, name: order.customer_name, phone: order.customer_phone, address: order.customer_address } : null };
}

const AUTOMATIC_PAYMENT_METHODS = Object.freeze(['cash', 'card', 'split', 'receivable']);

async function loadAutomaticInvoicePolicy(executor, invoiceId) {
    const [[order]] = await executor.query(
        `SELECT o.*,
                CASE WHEN o.payment_method='receivable' THEN o.buyer_name_at_sale ELSE c.name END AS customer_name,
                CASE WHEN o.payment_method='receivable' THEN o.buyer_phone_at_sale ELSE c.phone END AS customer_phone,
                CASE WHEN o.payment_method='receivable' THEN o.buyer_address_at_sale ELSE c.address END AS customer_address
           FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
          WHERE o.invoice_id = ?
          LIMIT 1`,
        [invoiceId]
    );
    const settings = await getSettings(executor, SETTING_KEYS);
    const enabled = settings.jofotara_enabled === '1';
    const autoSubmit = settings.jofotara_auto_submit === '1';
    const autoSubmitSince = settings.jofotara_auto_submit_since || null;
    let excludedReason = null;
    if (!order) excludedReason = 'invoice_not_found';
    else if (order.payment_method === 'platform') excludedReason = 'platform';
    else if (!AUTOMATIC_PAYMENT_METHODS.includes(order.payment_method)) excludedReason = 'payment_method';
    else if (!order.invoice_number || !order.invoice_issued_at) excludedReason = 'invoice_not_finalized';
    const eligible = !excludedReason;
    const issuedAt = order?.invoice_issued_at ? parseBackendTimestamp(order.invoice_issued_at).getTime() : NaN;
    const cutoffAt = autoSubmitSince ? parseBackendTimestamp(autoSubmitSince).getTime() : NaN;
    const withinCutoff = eligible && Number.isFinite(issuedAt) && Number.isFinite(cutoffAt) && issuedAt >= cutoffAt;
    return {
        invoiceId: Number(invoiceId), order, settings, enabled, autoSubmit, autoSubmitSince,
        eligible, withinCutoff, excludedReason
    };
}

function automaticRequired(policy) {
    return Boolean(policy.enabled && policy.autoSubmit && policy.eligible && policy.withinCutoff);
}

async function loadCheckoutAutomaticDisposition(invoiceId) {
    const conn = await pool.getConnection();
    try {
        const [[row]] = await conn.query(
            `SELECT o.invoice_id, o.payment_method, o.invoice_number, o.invoice_issued_at,
                    enabled.setting_value AS jofotara_enabled,
                    auto_submit.setting_value AS jofotara_auto_submit,
                    auto_submit_since.setting_value AS jofotara_auto_submit_since,
                    d.id AS document_id, d.document_kind, d.tax_registration_type, d.document_number,
                    d.document_uuid, d.status AS document_status, d.qr_text, d.last_error
               FROM orders o
          LEFT JOIN settings enabled ON enabled.setting_key='jofotara_enabled'
          LEFT JOIN settings auto_submit ON auto_submit.setting_key='jofotara_auto_submit'
          LEFT JOIN settings auto_submit_since ON auto_submit_since.setting_key='jofotara_auto_submit_since'
          LEFT JOIN jofotara_documents d ON d.source_key=CONCAT('invoice:', o.invoice_id)
              WHERE o.invoice_id=?
              LIMIT 1`,
            [invoiceId]
        );
        if (!row) return { required: false, status: 'not_required', code: 'invoice_not_found' };

        let excludedReason = null;
        if (row.payment_method === 'platform') excludedReason = 'platform';
        else if (!AUTOMATIC_PAYMENT_METHODS.includes(row.payment_method)) excludedReason = 'payment_method';
        else if (!row.invoice_number || !row.invoice_issued_at) excludedReason = 'invoice_not_finalized';

        // Platform work belongs to Operations even when an old document exists.
        if (excludedReason === 'platform') {
            return { required: false, status: 'not_required', code: excludedReason };
        }

        const document = row.document_id == null ? null : publicState({
            id: row.document_id,
            document_kind: row.document_kind,
            tax_registration_type: row.tax_registration_type,
            document_number: row.document_number,
            document_uuid: row.document_uuid,
            status: row.document_status,
            qr_text: row.qr_text,
            last_error: row.last_error
        });
        if (document) return { required: true, status: document.status, code: null, document };

        const issuedAt = row.invoice_issued_at ? parseBackendTimestamp(row.invoice_issued_at).getTime() : NaN;
        const cutoffAt = row.jofotara_auto_submit_since ? parseBackendTimestamp(row.jofotara_auto_submit_since).getTime() : NaN;
        const required = !excludedReason &&
            row.jofotara_enabled === '1' &&
            row.jofotara_auto_submit === '1' &&
            Number.isFinite(issuedAt) &&
            Number.isFinite(cutoffAt) &&
            issuedAt >= cutoffAt;
        return {
            required,
            status: required ? 'pending' : 'not_required',
            code: required ? null : excludedReason
        };
    } finally {
        conn.release();
    }
}

async function ensurePendingSalesDocument(conn, { invoiceId, actorUserId, policy, lockedSource = null }) {
    const [[existing]] = await conn.query('SELECT * FROM jofotara_documents WHERE source_key = ? FOR UPDATE', [`invoice:${invoiceId}`]);
    if (existing) return { document: existing, created: false };
    if (!automaticRequired(policy)) return { document: null, created: false };
    const source = lockedSource || await loadInvoice(conn, invoiceId, true);
    const profile = normalizeTaxRegistrationType(source.order.tax_registration_type_at_sale || taxRegistrationTypeFromSettings(policy.settings));
    const config = credentialsForProfile(policy.settings, profile);
    validateSubmissionSettings(config);
    const uuid = crypto.randomUUID();
    const [insert] = await conn.query(
        `INSERT INTO jofotara_documents
         (source_key, order_invoice_id, document_kind, tax_registration_type, document_number, document_uuid, submitted_by_user_id)
         VALUES (?, ?, 'invoice', ?, ?, ?, ?)`,
        [`invoice:${invoiceId}`, invoiceId, profile, String(source.order.invoice_number), uuid, actorUserId]
    );
    const snapshot = buildInvoiceSnapshot({
        profile, ...source,
        seller: sellerFromSettings(config),
        paymentTerms: paymentTermsFor(source.order)
    });
    const xml = renderInvoiceXml(snapshot, { uuid, icv: String(insert.insertId) });
    await conn.query('UPDATE jofotara_documents SET legal_snapshot_json=?, request_xml=? WHERE id=?', [JSON.stringify(snapshot), xml, insert.insertId]);
    return {
        created: true,
        document: {
            id: insert.insertId, document_uuid: uuid, request_xml: xml,
            legal_snapshot_json: JSON.stringify(snapshot), tax_registration_type: profile, status: 'pending',
            order_invoice_id: invoiceId, document_kind: 'invoice', document_number: String(source.order.invoice_number)
        }
    };
}

async function prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId }) {
    const disposition = await loadCheckoutAutomaticDisposition(invoiceId);
    if (!disposition.required || disposition.document) return disposition;

    const conn = await pool.getConnection();
    let transactionStarted = false;
    try {
        await conn.beginTransaction();
        transactionStarted = true;
        const policy = await loadAutomaticInvoicePolicy(conn, invoiceId);
        if (policy.excludedReason === 'platform') {
            await conn.commit();
            return { required: false, status: 'not_required', code: policy.excludedReason };
        }
        if (!automaticRequired(policy)) {
            // A document may have appeared after the preflight. The same source-key owner
            // resolves that race before the current settings are allowed to suppress it.
            const { document } = await ensurePendingSalesDocument(conn, { invoiceId, actorUserId, policy });
            await conn.commit();
            if (document) return { required: true, status: document.status, code: null, document: publicState(document) };
            return { required: false, status: 'not_required', code: policy.excludedReason || null };
        }
        // Lock the source before its unique document key. Parallel preparations now acquire
        // the same locks in the same order instead of racing a document gap against the order.
        const lockedSource = await loadInvoice(conn, invoiceId, true);
        const { document } = await ensurePendingSalesDocument(conn, { invoiceId, actorUserId, policy, lockedSource });
        await conn.commit();
        return { required: true, status: document.status || 'pending', code: null, document: publicState(document) };
    } catch (error) {
        if (transactionStarted) await conn.rollback();
        throw error;
    } finally { conn.release(); }
}

async function previewSalesXml(invoiceId) {
    const source = await loadInvoice(pool, invoiceId);
    const profile = normalizeTaxRegistrationType(source.order.tax_registration_type_at_sale || TAX_REGISTRATION_TYPES.SALES_TAX);
    const settings = await getSettings(pool, SETTING_KEYS);
    const config = credentialsForProfile(settings, profile);
    const seller = sellerFromSettings(config);
    validateSeller(seller);
    const snapshot = buildInvoiceSnapshot({ profile, ...source, seller, paymentTerms: paymentTermsFor(source.order) });
    return { xml: renderInvoiceXml(snapshot, previewIdentity(invoiceId)), documentNumber: snapshot.documentNumber };
}

function publicState(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        kind: row.document_kind,
        tax_registration_type: row.tax_registration_type,
        document_number: row.document_number,
        uuid: row.document_uuid,
        status: row.status,
        has_qr: Boolean(row.qr_text),
        qr_text: row.status === 'accepted' ? row.qr_text : null,
        last_error: row.last_error,
        attempt_count: Number(row.attempt_count || 0),
        accepted_at: row.accepted_at
    };
}

async function getOrderJofotaraState(invoiceId) {
    const [rows] = await pool.query('SELECT * FROM jofotara_documents WHERE order_invoice_id = ? ORDER BY id', [invoiceId]);
    const [refunds] = await pool.query("SELECT id, amount_refunded, reason, created_at FROM refunds WHERE invoice_id = ? AND kind = 'refund' ORDER BY id", [invoiceId]);
    const returnByRefund = new Map(rows.filter(row => row.document_kind === 'credit_note').map(row => [Number(row.refund_id), row]));
    return {
        invoice: publicState(rows.find(row => row.document_kind === 'invoice')),
        returns: refunds.map(refund => ({ ...refund, document: publicState(returnByRefund.get(Number(refund.id))) }))
    };
}

function sourceKindFor(order) {
    return order.payment_method === 'platform' ? 'platform' : 'standard';
}

function assertSubmissionSurface(order, surface) {
    if (!['automatic', 'order', 'operations'].includes(surface)) {
        throw publicError('A valid JoFotara submission surface is required.', 'JOFOTARA_SUBMISSION_SURFACE_REQUIRED', 400);
    }
    const sourceKind = sourceKindFor(order);
    if (sourceKind !== 'standard' && surface !== 'operations') {
        throw publicError('This invoice must be submitted from JoFotara Operations.', 'JOFOTARA_OPERATIONS_REQUIRED', 409);
    }
    return sourceKind;
}

async function prepareSalesDocument(invoiceId, actorUserId, surface) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const source = await loadInvoice(conn, invoiceId, true);
        assertSubmissionSurface(source.order, surface);
        const [[existing]] = await conn.query("SELECT * FROM jofotara_documents WHERE source_key = ? FOR UPDATE", [`invoice:${invoiceId}`]);
        if (existing?.status === 'accepted') { await conn.commit(); return { stored: publicState(existing) }; }
        if (existing?.status === 'submitting') {
            const ageMs = Date.now() - new Date(existing.last_attempt_at || 0).getTime();
            if (ageMs > 2 * 60 * 1000) {
                await conn.query("UPDATE jofotara_documents SET status='unknown', last_error='Submission was interrupted; verify before retrying.' WHERE id=?", [existing.id]);
                await conn.commit();
                throw publicError('The interrupted submission needs review.', 'JOFOTARA_UNKNOWN', 409);
            }
            throw publicError('This invoice is already being sent.', 'JOFOTARA_SUBMITTING', 409);
        }
        if (existing?.status === 'unknown') throw publicError('The previous result is uncertain and needs review.', 'JOFOTARA_UNKNOWN', 409);

        const profile = normalizeTaxRegistrationType(existing?.tax_registration_type || source.order.tax_registration_type_at_sale || TAX_REGISTRATION_TYPES.SALES_TAX);
        const settings = await getSettings(conn, SETTING_KEYS);
        const config = credentialsForProfile(settings, profile);
        validateSubmissionSettings(config, { sellerRequired: !existing });
        let document = existing;
        if (!document) {
            const uuid = crypto.randomUUID();
            const [insert] = await conn.query(
                `INSERT INTO jofotara_documents
                 (source_key, order_invoice_id, document_kind, tax_registration_type, document_number, document_uuid, submitted_by_user_id)
                 VALUES (?, ?, 'invoice', ?, ?, ?, ?)`,
                [`invoice:${invoiceId}`, invoiceId, profile, String(source.order.invoice_number), uuid, actorUserId]
            );
            const snapshot = buildInvoiceSnapshot({
                profile,
                ...source,
                seller: sellerFromSettings(config),
                paymentTerms: paymentTermsFor(source.order)
            });
            const xml = renderInvoiceXml(snapshot, { uuid, icv: String(insert.insertId) });
            await conn.query('UPDATE jofotara_documents SET legal_snapshot_json = ?, request_xml = ? WHERE id = ?', [JSON.stringify(snapshot), xml, insert.insertId]);
            document = {
                id: insert.insertId, document_kind: 'invoice', document_number: String(source.order.invoice_number),
                document_uuid: uuid, request_xml: xml, legal_snapshot_json: JSON.stringify(snapshot),
                tax_registration_type: profile, status: 'pending'
            };
        }
        await conn.query("UPDATE jofotara_documents SET status='submitting', attempt_count=attempt_count+1, submitted_by_user_id=?, last_attempt_at=NOW(), last_error=NULL WHERE id=?", [actorUserId, document.id]);
        await conn.commit();
        return { document: { ...document, tax_registration_type: profile }, config, archiveXml: settings.jofotara_archive_xml !== '0' };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally { conn.release(); }
}

async function finishSubmission(document, result, actorUserId) {
    const status = result.outcome;
    await pool.query(
        `UPDATE jofotara_documents SET status=?, qr_text=?, response_body=?, http_status=?, last_error=?,
         accepted_at=CASE WHEN ?='accepted' THEN NOW() ELSE accepted_at END WHERE id=?`,
        [status, result.qrText, result.responseBody, result.httpStatus, result.error, status, document.id]
    );
    try {
        await appendAuditEvent(pool, {
            eventType: `jofotara_${status}`,
            userId: actorUserId,
            entityType: 'jofotara_document',
            entityId: document.id,
            newValue: { document_id: document.id, result: status, http_status: result.httpStatus, tax_registration_type: document.tax_registration_type }
        });
    } catch (error) {
        logger.error({ err: error, documentId: document.id, status }, 'JoFotara result saved but audit append failed.');
    }
    const [[row]] = await pool.query('SELECT * FROM jofotara_documents WHERE id = ?', [document.id]);
    return publicState(row);
}

async function archiveBeforeSubmission(document, enabled) {
    if (!enabled) return;
    try { await archiveSubmissionXml(document); }
    catch (error) { logger.error({ err: error, documentId: document.id }, 'JoFotara XML archive failed; database copy remains available.'); }
}

async function auditAttempt(document, actorUserId) {
    try {
        await appendAuditEvent(pool, {
            eventType: 'jofotara_submission_started',
            userId: actorUserId,
            entityType: 'jofotara_document',
            entityId: document.id,
            newValue: { document_id: document.id, result: 'started', http_status: null, tax_registration_type: document.tax_registration_type }
        });
    } catch (error) {
        logger.error({ err: error, documentId: document.id }, 'JoFotara submission started but audit append failed.');
    }
}

async function submitSalesInvoice({ invoiceId, actorUserId, fetchImpl, surface }) {
    const prepared = await prepareSalesDocument(invoiceId, actorUserId, surface);
    if (prepared.stored) return prepared.stored;
    await archiveBeforeSubmission(prepared.document, prepared.archiveXml);
    await auditAttempt(prepared.document, actorUserId);
    const result = await submitXml({
        clientId: prepared.config.clientId,
        secretKey: prepared.config.secretKey,
        xml: prepared.document.request_xml,
        fetchImpl
    });
    return finishSubmission(prepared.document, result, actorUserId);
}

async function checkoutDocumentState(invoiceId) {
    const [[row]] = await pool.query('SELECT * FROM jofotara_documents WHERE source_key=?', [`invoice:${invoiceId}`]);
    return row ? publicState(row) : null;
}

async function getCheckoutInvoiceState(invoiceId) {
    const policy = await loadAutomaticInvoicePolicy(pool, invoiceId);
    const document = await checkoutDocumentState(invoiceId);
    if (!document) return { required: false, status: 'not_required', code: policy.excludedReason || null };
    return { required: true, status: document.status, code: null, document };
}

async function submitCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId, fetchImpl }) {
    const prepared = await prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId });
    if (!prepared.required) return prepared;
    if (['accepted', 'rejected', 'unknown', 'submitting'].includes(prepared.status)) return prepared;
    try {
        const document = await submitSalesInvoice({ invoiceId, actorUserId, fetchImpl, surface: 'automatic' });
        return { required: true, status: document.status, code: null, document };
    } catch (error) {
        if (['JOFOTARA_SUBMITTING', 'JOFOTARA_UNKNOWN'].includes(error.publicCode)) {
            const document = await checkoutDocumentState(invoiceId);
            return { required: true, status: document?.status || 'unknown', code: error.publicCode, document };
        }
        throw error;
    }
}

async function prepareCreditNote(refundId, actorUserId, surface) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[refund]] = await conn.query(
            `SELECT r.*,
                    o.payment_method AS source_payment_method
               FROM refunds r
               JOIN orders o ON o.invoice_id=r.invoice_id
              WHERE r.id=? AND r.kind='refund'
              FOR UPDATE`,
            [refundId]
        );
        if (!refund) throw publicError('Saved refund not found.', 'JOFOTARA_INVALID_REFUND', 404);
        assertSubmissionSurface({ payment_method: refund.source_payment_method }, surface);
        const [[original]] = await conn.query("SELECT * FROM jofotara_documents WHERE source_key = ? AND status = 'accepted' FOR UPDATE", [`invoice:${refund.invoice_id}`]);
        if (!original) throw publicError('Send the original invoice first.', 'JOFOTARA_ORIGINAL_REQUIRED', 409);
        const [[existing]] = await conn.query('SELECT * FROM jofotara_documents WHERE source_key = ? FOR UPDATE', [`refund:${refundId}`]);
        if (existing?.status === 'accepted') { await conn.commit(); return { stored: publicState(existing) }; }
        if (existing?.status === 'submitting') {
            const ageMs = Date.now() - new Date(existing.last_attempt_at || 0).getTime();
            if (ageMs > 2 * 60 * 1000) {
                await conn.query("UPDATE jofotara_documents SET status='unknown', last_error='Submission was interrupted; verify before retrying.' WHERE id=?", [existing.id]);
                await conn.commit();
                throw publicError('The interrupted return needs review.', 'JOFOTARA_UNKNOWN', 409);
            }
            throw publicError('This return is already being sent.', 'JOFOTARA_SUBMITTING', 409);
        }
        if (existing?.status === 'unknown') throw publicError('This return needs review before another attempt.', 'JOFOTARA_UNKNOWN', 409);
        const profile = normalizeTaxRegistrationType(existing?.tax_registration_type || original.tax_registration_type || TAX_REGISTRATION_TYPES.SALES_TAX);
        const settings = await getSettings(conn, SETTING_KEYS);
        const config = credentialsForProfile(settings, profile);
        validateSubmissionSettings(config, { sellerRequired: false });
        let document = existing;
        if (!document || document.status === 'rejected') {
            const [refundItems] = await conn.query(
                `SELECT ri.*,
                    COALESCE((SELECT SUM(previous.quantity) FROM refund_items previous
                              WHERE previous.order_item_id = ri.order_item_id AND previous.refund_id <> ri.refund_id), 0)
                    AS previously_returned_quantity
                 FROM refund_items ri WHERE ri.refund_id = ? ORDER BY ri.id`,
                [refundId]
            );
            const originalSnapshot = JSON.parse(original.legal_snapshot_json);
            const snapshot = buildCreditNoteSnapshot({ profile, refund, refundItems, originalSnapshot, originalDocument: original });
            if (!document) {
                const uuid = crypto.randomUUID();
                const [insert] = await conn.query(
                    `INSERT INTO jofotara_documents
                     (source_key, order_invoice_id, refund_id, original_document_id, document_kind, tax_registration_type, document_number, document_uuid, submitted_by_user_id)
                     VALUES (?, ?, ?, ?, 'credit_note', ?, ?, ?, ?)`,
                    [`refund:${refundId}`, refund.invoice_id, refundId, original.id, profile, snapshot.documentNumber, uuid, actorUserId]
                );
                document = {
                    id: insert.insertId, document_kind: 'credit_note', document_number: snapshot.documentNumber,
                    document_uuid: uuid, tax_registration_type: profile
                };
            }
            const xml = renderCreditNoteXml(snapshot, { uuid: document.document_uuid, icv: String(document.id) });
            await conn.query('UPDATE jofotara_documents SET legal_snapshot_json=?, request_xml=? WHERE id=?', [JSON.stringify(snapshot), xml, document.id]);
            document = { ...document, request_xml: xml, tax_registration_type: profile };
        }
        await conn.query("UPDATE jofotara_documents SET status='submitting', attempt_count=attempt_count+1, submitted_by_user_id=?, last_attempt_at=NOW(), last_error=NULL WHERE id=?", [actorUserId, document.id]);
        await conn.commit();
        return { document: { ...document, tax_registration_type: profile }, config, archiveXml: settings.jofotara_archive_xml !== '0' };
    } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
}

async function submitCreditNote({ refundId, actorUserId, fetchImpl, surface }) {
    const prepared = await prepareCreditNote(refundId, actorUserId, surface);
    if (prepared.stored) return prepared.stored;
    await archiveBeforeSubmission(prepared.document, prepared.archiveXml);
    await auditAttempt(prepared.document, actorUserId);
    const result = await submitXml({ clientId: prepared.config.clientId, secretKey: prepared.config.secretKey, xml: prepared.document.request_xml, fetchImpl });
    return finishSubmission(prepared.document, result, actorUserId);
}

const STALE_SUBMISSION_ERROR = 'Submission was interrupted; verify the result in JoFotara before taking any action.';

async function markStaleSubmissionsUnknown() {
    const [result] = await pool.query(
        `UPDATE jofotara_documents
            SET status='unknown', last_error=?
          WHERE status='submitting' AND last_attempt_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`,
        [STALE_SUBMISSION_ERROR]
    );
    return Number(result.affectedRows || 0);
}

function validIsoDate(value, field) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw publicError(`${field} must be a valid ISO date.`, 'JOFOTARA_OPERATIONS_FILTER_INVALID', 400);
    }
    return value;
}

function operationsFilters({ sourceKind, orderTypeId, orderInvoiceId, status, issuedFrom, issuedTo } = {}) {
    const sourceKinds = ['standard', 'platform'];
    const statuses = ['not_submitted', 'pending', 'submitting', 'rejected', 'unknown', 'waiting_for_original'];
    if (sourceKind != null && sourceKind !== '' && !sourceKinds.includes(sourceKind)) throw publicError('source_kind is invalid.', 'JOFOTARA_OPERATIONS_FILTER_INVALID', 400);
    if (status != null && status !== '' && !statuses.includes(status)) throw publicError('status is invalid.', 'JOFOTARA_OPERATIONS_FILTER_INVALID', 400);
    if (orderTypeId != null && orderTypeId !== '' && ((typeof orderTypeId !== 'string' && typeof orderTypeId !== 'number') || !/^[1-9]\d*$/.test(String(orderTypeId)) || !Number.isSafeInteger(Number(orderTypeId)))) {
        throw publicError('order_type_id must be a positive integer.', 'JOFOTARA_OPERATIONS_FILTER_INVALID', 400);
    }
    if (orderInvoiceId != null && orderInvoiceId !== '' && ((typeof orderInvoiceId !== 'string' && typeof orderInvoiceId !== 'number') || !/^[1-9]\d*$/.test(String(orderInvoiceId)) || !Number.isSafeInteger(Number(orderInvoiceId)))) {
        throw publicError('invoice_id must be a positive integer.', 'JOFOTARA_OPERATIONS_FILTER_INVALID', 400);
    }
    const from = validIsoDate(issuedFrom, 'issued_from');
    const to = validIsoDate(issuedTo, 'issued_to');
    if (from && to && from > to) throw publicError('issued_from must not be after issued_to.', 'JOFOTARA_OPERATIONS_FILTER_INVALID', 400);
    return {
        sourceKind: sourceKind || null,
        status: status || null,
        orderTypeId: orderTypeId === '' || orderTypeId == null ? null : Number(orderTypeId),
        orderInvoiceId: orderInvoiceId === '' || orderInvoiceId == null ? null : Number(orderInvoiceId),
        issuedFrom: from,
        issuedTo: to
    };
}

async function unresolvedRows(limit, filters = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const clauses = [];
    const params = [];
    if (filters.sourceKind) { clauses.push('unresolved.source_kind = ?'); params.push(filters.sourceKind); }
    if (filters.status) { clauses.push('unresolved.status = ?'); params.push(filters.status); }
    if (filters.orderTypeId) { clauses.push('unresolved.order_type_id = ?'); params.push(filters.orderTypeId); }
    if (filters.orderInvoiceId) { clauses.push('unresolved.order_invoice_id = ?'); params.push(filters.orderInvoiceId); }
    if (filters.issuedFrom) { clauses.push('unresolved.invoice_issued_at >= ?'); params.push(formatDbTimestamp(zonedLocalTimeToDate(filters.issuedFrom))); }
    if (filters.issuedTo) { clauses.push('unresolved.invoice_issued_at < ?'); params.push(formatDbTimestamp(zonedLocalTimeToDate(addBusinessDays(filters.issuedTo, 1)))); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await pool.query(`
        SELECT unresolved.*,
               COUNT(*) OVER() total_count,
               SUM(status='not_submitted') OVER() not_submitted_count,
               SUM(status='pending') OVER() pending_count,
               SUM(status='submitting') OVER() submitting_count,
               SUM(status='rejected') OVER() rejected_count,
               SUM(status='unknown') OVER() unknown_count,
               SUM(status='waiting_for_original') OVER() waiting_for_original_count
          FROM (
            SELECT CONVERT('invoice' USING utf8mb4) COLLATE utf8mb4_unicode_ci source_type,
                   o.invoice_id source_id, NULL document_id, o.invoice_id order_invoice_id, NULL refund_id,
                   CONVERT(CAST(o.invoice_number AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci document_number,
                   CONVERT(o.tax_registration_type_at_sale USING utf8mb4) COLLATE utf8mb4_unicode_ci tax_registration_type,
                   CONVERT('not_submitted' USING utf8mb4) COLLATE utf8mb4_unicode_ci status,
                   0 attempt_count, NULL last_error, o.created_at source_created_at, NULL last_attempt_at,
                   CONVERT(CASE WHEN o.payment_method='platform' THEN 'platform' ELSE 'standard' END USING utf8mb4) COLLATE utf8mb4_unicode_ci source_kind,
                   o.order_type_id, ot.name order_type_name, o.total gross_total, o.invoice_issued_at
              FROM orders o
              LEFT JOIN order_types ot ON ot.id=o.order_type_id
              LEFT JOIN jofotara_documents d ON d.source_key=CONCAT('invoice:', o.invoice_id)
             WHERE o.payment_method IN ('cash','card','split','receivable','platform') AND o.invoice_number IS NOT NULL AND d.id IS NULL
            UNION ALL
            SELECT CONVERT('credit_note' USING utf8mb4) COLLATE utf8mb4_unicode_ci, r.id, NULL, r.invoice_id, r.id,
                   CONVERT(CONCAT(original.document_number, '-R-', r.id) USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   CONVERT(original.tax_registration_type USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   CONVERT('not_submitted' USING utf8mb4) COLLATE utf8mb4_unicode_ci, 0, NULL, r.created_at, NULL,
                   CONVERT(CASE WHEN o.payment_method='platform' THEN 'platform' ELSE 'standard' END USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   o.order_type_id, ot.name, r.amount_refunded, o.invoice_issued_at
              FROM refunds r
              JOIN orders o ON o.invoice_id=r.invoice_id
              LEFT JOIN order_types ot ON ot.id=o.order_type_id
              JOIN jofotara_documents original ON original.source_key=CONCAT('invoice:', r.invoice_id)
                                               AND original.status='accepted'
              LEFT JOIN jofotara_documents d ON d.source_key=CONCAT('refund:', r.id)
             WHERE r.kind='refund' AND d.id IS NULL
            UNION ALL
            SELECT CONVERT('credit_note' USING utf8mb4) COLLATE utf8mb4_unicode_ci, r.id, NULL, r.invoice_id, r.id,
                   CONVERT(CONCAT(COALESCE(original.document_number, CAST(o.invoice_number AS CHAR)), '-R-', r.id) USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   CONVERT(COALESCE(original.tax_registration_type, o.tax_registration_type_at_sale, 'sales_tax') USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   CONVERT('waiting_for_original' USING utf8mb4) COLLATE utf8mb4_unicode_ci, 0,
                   CONVERT('Waiting for the original invoice to be accepted.' USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   r.created_at, NULL,
                   CONVERT(CASE WHEN o.payment_method='platform' THEN 'platform' ELSE 'standard' END USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   o.order_type_id, ot.name, r.amount_refunded, o.invoice_issued_at
              FROM refunds r
              JOIN orders o ON o.invoice_id=r.invoice_id
              LEFT JOIN order_types ot ON ot.id=o.order_type_id
              LEFT JOIN jofotara_documents original ON original.source_key=CONCAT('invoice:', r.invoice_id)
              LEFT JOIN jofotara_documents d ON d.source_key=CONCAT('refund:', r.id)
             WHERE r.kind='refund' AND d.id IS NULL
               AND (original.id IS NULL OR original.status<>'accepted')
            UNION ALL
            SELECT CONVERT(d.document_kind USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   CASE WHEN d.document_kind='invoice' THEN d.order_invoice_id ELSE d.refund_id END,
                   d.id, d.order_invoice_id, d.refund_id,
                   CONVERT(d.document_number USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   CONVERT(d.tax_registration_type USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   CONVERT(d.status USING utf8mb4) COLLATE utf8mb4_unicode_ci, d.attempt_count,
                   CONVERT(d.last_error USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   COALESCE(r.created_at, o.created_at), d.last_attempt_at,
                   CONVERT(CASE WHEN o.payment_method='platform' THEN 'platform' ELSE 'standard' END USING utf8mb4) COLLATE utf8mb4_unicode_ci,
                   o.order_type_id, ot.name,
                   CASE WHEN d.document_kind='credit_note' THEN r.amount_refunded ELSE o.total END,
                   o.invoice_issued_at
              FROM jofotara_documents d
              LEFT JOIN orders o ON o.invoice_id=d.order_invoice_id
              LEFT JOIN refunds r ON r.id=d.refund_id
              LEFT JOIN order_types ot ON ot.id=o.order_type_id
             WHERE d.status IN ('pending','submitting','rejected','unknown')
        ) unresolved ${where}
        ORDER BY source_created_at DESC, source_type, source_id DESC
        LIMIT ?`, [...params, safeLimit]);
    const items = rows.map(row => ({
        source_type: row.source_type,
        source_id: Number(row.source_id),
        document_id: row.document_id == null ? null : Number(row.document_id),
        order_invoice_id: Number(row.order_invoice_id),
        refund_id: row.refund_id == null ? null : Number(row.refund_id),
        document_number: row.document_number,
        tax_registration_type: row.tax_registration_type,
        status: row.status,
        attempt_count: Number(row.attempt_count || 0),
        last_error: row.last_error,
        source_created_at: row.source_created_at,
        last_attempt_at: row.last_attempt_at,
        source_kind: row.source_kind,
        order_type_id: row.order_type_id == null ? null : Number(row.order_type_id),
        order_type_name: row.order_type_name || null,
        gross_total: Number(row.gross_total),
        invoice_issued_at: row.invoice_issued_at,
        can_submit: ['not_submitted', 'pending', 'rejected'].includes(row.status)
    }));
    const counts = rows[0] || {};
    return {
        items,
        summary: {
            total: Number(counts.total_count || 0),
            not_submitted: Number(counts.not_submitted_count || 0),
            pending: Number(counts.pending_count || 0),
            submitting: Number(counts.submitting_count || 0),
            rejected: Number(counts.rejected_count || 0),
            unknown: Number(counts.unknown_count || 0),
            waiting_for_original: Number(counts.waiting_for_original_count || 0)
        }
    };
}

async function getJofotaraOperations({ limit = 50, sourceKind, orderTypeId, orderInvoiceId, status, issuedFrom, issuedTo } = {}) {
    await markStaleSubmissionsUnknown();
    const { items, summary } = await unresolvedRows(limit, operationsFilters({ sourceKind, orderTypeId, orderInvoiceId, status, issuedFrom, issuedTo }));
    const settings = await getSettings(pool, ['jofotara_enabled', 'jofotara_auto_submit', 'jofotara_auto_submit_since']);
    return {
        enabled: settings.jofotara_enabled === '1',
        auto_submit: settings.jofotara_auto_submit === '1',
        auto_submit_since: settings.jofotara_auto_submit_since || null,
        summary,
        items
    };
}

// The admin badge needs only the unfiltered total. Keep its read separate from
// Operations: that screen also returns rows and reconciles stale submissions.
async function getJofotaraOperationCount() {
    const [[row]] = await pool.query(`
        SELECT
            (SELECT COUNT(*)
               FROM orders o
               LEFT JOIN jofotara_documents d ON d.source_key=CONCAT('invoice:', o.invoice_id)
              WHERE o.payment_method IN ('cash','card','split','receivable','platform')
                AND o.invoice_number IS NOT NULL AND d.id IS NULL)
          + (SELECT COUNT(*)
               FROM refunds r
               JOIN orders o ON o.invoice_id=r.invoice_id
               LEFT JOIN jofotara_documents d ON d.source_key=CONCAT('refund:', r.id)
              WHERE r.kind='refund' AND d.id IS NULL)
          + (SELECT COUNT(*)
               FROM jofotara_documents d
              WHERE d.status IN ('pending','submitting','rejected','unknown')) AS total`);
    return { total: Number(row.total || 0) };
}

async function processOperationsOnce({ fetchImpl } = {}) {
    const stale = await markStaleSubmissionsUnknown();
    const settings = await getSettings(pool, ['jofotara_enabled', 'jofotara_auto_submit', 'jofotara_auto_submit_since']);
    const automaticEnabled = settings.jofotara_enabled === '1'
        && settings.jofotara_auto_submit === '1'
        && Boolean(settings.jofotara_auto_submit_since);
    if (!automaticEnabled) {
        return { automatic_enabled: false, attempted: 0, accepted: 0, rejected: 0, unknown: 0, failed: 0, stale };
    }
    const [candidates] = await pool.query(`
        SELECT source_type, source_id FROM (
            SELECT 'invoice' source_type, d.order_invoice_id source_id, d.created_at work_at
              FROM jofotara_documents d
              JOIN orders o ON o.invoice_id = d.order_invoice_id
             WHERE d.document_kind='invoice' AND d.status='pending'
               AND d.created_at <= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
               AND o.payment_method IN ('cash','card','split','receivable')
               AND o.payment_method <> 'platform'
               AND o.invoice_number IS NOT NULL AND o.invoice_issued_at IS NOT NULL
            UNION ALL
            SELECT 'invoice' source_type, o.invoice_id source_id, o.invoice_issued_at work_at
              FROM orders o
              LEFT JOIN jofotara_documents d ON d.source_key=CONCAT('invoice:', o.invoice_id)
             WHERE d.id IS NULL
               AND o.payment_method IN ('cash','card','split','receivable')
               AND o.payment_method <> 'platform'
               AND o.invoice_number IS NOT NULL AND o.invoice_issued_at IS NOT NULL
               AND o.invoice_issued_at >= ?
               AND o.invoice_issued_at <= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
        ) recovery_work ORDER BY work_at, source_type, source_id LIMIT 5`,
        [settings.jofotara_auto_submit_since]
    );
    const result = { automatic_enabled: true, attempted: 0, accepted: 0, rejected: 0, unknown: 0, failed: 0, stale };
    for (const candidate of candidates) {
        try {
            result.attempted += 1;
            const state = await submitCheckoutInvoiceIfAutomatic({
                invoiceId: Number(candidate.source_id), actorUserId: null, fetchImpl
            });
            const status = state.document?.status || state.status;
            if (Object.prototype.hasOwnProperty.call(result, status)) result[status] += 1;
            else result.failed += 1;
        } catch (error) {
            result.failed += 1;
            logger.error({ err: error, sourceType: candidate.source_type, sourceId: candidate.source_id }, 'Automatic JoFotara submission failed.');
        }
    }
    return result;
}

let operationsRun = null;
function processJofotaraOperations(options = {}) {
    if (operationsRun) return operationsRun;
    operationsRun = processOperationsOnce(options).finally(() => { operationsRun = null; });
    return operationsRun;
}

module.exports = {
    SETTING_KEYS, credentialsForProfile, jofotaraConfigForSelectedProfile, sellerFromSettings, validateSeller,
    lockJofotaraPolicy, validateJofotaraSettingsForSave, validateJofotaraCatalogRates,
    loadAutomaticInvoicePolicy, prepareCheckoutInvoiceIfAutomatic, submitCheckoutInvoiceIfAutomatic,
    getCheckoutInvoiceState, getJofotaraOperationCount,
    previewSalesXml, getOrderJofotaraState, prepareInvoiceDocument: prepareSalesDocument, prepareCreditNote,
    submitSalesInvoice, submitCreditNote, markStaleSubmissionsUnknown, getJofotaraOperations, processJofotaraOperations
};
