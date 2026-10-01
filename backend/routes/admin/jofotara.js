const express = require('express');
const router = express.Router();
const { pool, sendSuccess, sendError, logAdminRouteError } = require('./helpers');
const { getSettings } = require('../../config/settingsHelper');
const {
    TAX_REGISTRATION_TYPES, normalizeTaxRegistrationType, taxRegistrationTypeFromSettings,
    profileSettingKeys, jofotaraConfigFromSettings
} = require('../../config/taxRegistration');
const {
    SETTING_KEYS, previewSalesXml, getOrderJofotaraState,
    submitSalesInvoice, submitCreditNote, getJofotaraOperations, getJofotaraOperationCount, processJofotaraOperations,
    lockJofotaraPolicy, validateJofotaraSettingsForSave
} = require('../../services/JofotaraService');

function routeError(req, res, error) {
    if (error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({ success: false, message: error.message, publicCode: error.publicCode });
    }
    logAdminRouteError(req, error);
    return sendError(res, 500, error.message);
}

function publicProfile(config) {
    return {
        client_id: config.clientId,
        secret_configured: Boolean(config.secretKey),
        income_source_sequence: config.incomeSourceSequence,
        seller_tax_number: config.sellerTaxNumber,
        seller_registered_name: config.sellerRegisteredName
    };
}

function validProfile(value) {
    try { return normalizeTaxRegistrationType(value); }
    catch { return null; }
}

router.get('/jofotara/settings', async (req, res) => {
    try {
        const settings = await getSettings(pool, SETTING_KEYS);
        const profile = taxRegistrationTypeFromSettings(settings);
        const profiles = Object.fromEntries(Object.values(TAX_REGISTRATION_TYPES).map(type => [
            type, publicProfile(jofotaraConfigFromSettings(settings, type))
        ]));
        const active = profiles[profile];
        return sendSuccess(res, {
            settings: {
                enabled: settings.jofotara_enabled === '1',
                auto_submit: settings.jofotara_auto_submit === '1',
                archive_xml: settings.jofotara_archive_xml !== '0',
                auto_submit_since: settings.jofotara_auto_submit_since || null,
                tax_registration_type: profile,
                profiles,
                // Legacy active-profile fields remain read-only compatible.
                ...active
            }
        });
    } catch (error) { routeError(req, res, error); }
});

router.put('/jofotara/settings', async (req, res) => {
    let conn;
    try {
        const body = req.body || {};
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const currentSettings = await lockJofotaraPolicy(conn);
        const currentProfile = taxRegistrationTypeFromSettings(currentSettings);
        const selectedProfile = body.tax_registration_type === undefined ? currentProfile : validProfile(body.tax_registration_type);
        if (!selectedProfile) { await conn.rollback(); return sendError(res, 400, 'Invalid tax registration type.'); }
        if (body.profile !== undefined && !validProfile(body.profile)) {
            await conn.rollback();
            return sendError(res, 400, 'Invalid tax registration type.');
        }
        if (body.profiles && (typeof body.profiles !== 'object' || Array.isArray(body.profiles) ||
            Object.keys(body.profiles).some(profile => !validProfile(profile)))) {
            await conn.rollback();
            return sendError(res, 400, 'Invalid JoFotara profile.');
        }

        const values = {};
        if (body.enabled !== undefined) values.jofotara_enabled = body.enabled === true || body.enabled === '1' ? '1' : '0';
        if (body.auto_submit !== undefined) values.jofotara_auto_submit = body.auto_submit === true || body.auto_submit === '1' ? '1' : '0';
        if (body.archive_xml !== undefined) values.jofotara_archive_xml = body.archive_xml === true || body.archive_xml === '1' ? '1' : '0';
        if (body.tax_registration_type !== undefined) values.tax_registration_type = selectedProfile;
        const fieldMap = {
            client_id: 'clientId',
            income_source_sequence: 'incomeSourceSequence',
            seller_tax_number: 'sellerTaxNumber',
            seller_registered_name: 'sellerRegisteredName'
        };
        const applyProfile = (profile, form) => {
            if (!form || typeof form !== 'object' || Array.isArray(form)) return;
            const keys = profileSettingKeys(profile);
            for (const [field, keyName] of Object.entries(fieldMap)) {
                if (Object.prototype.hasOwnProperty.call(form, field)) values[keys[keyName]] = String(form[field] ?? '').trim();
            }
            if (form.clear_secret === true) values[keys.secretKey] = '';
            else if (String(form.secret_key || '').trim()) values[keys.secretKey] = String(form.secret_key).trim();
        };
        for (const profile of Object.values(TAX_REGISTRATION_TYPES)) applyProfile(profile, body.profiles?.[profile]);
        const hasLegacyFields = [...Object.keys(fieldMap), 'secret_key', 'clear_secret'].some(key => Object.prototype.hasOwnProperty.call(body, key));
        if (hasLegacyFields) applyProfile(validProfile(body.profile) || selectedProfile, body);

        if (Object.entries(values).some(([key, value]) => String(value).length > (key.endsWith('_secret_key') ? 8192 : 255))) {
            await conn.rollback();
            return sendError(res, 400, 'A JoFotara setting value is too long.');
        }
        const nextSettings = { ...currentSettings, ...values };
        await validateJofotaraSettingsForSave(conn, nextSettings);

        const entries = Object.entries(values);
        if (entries.length) {
            await conn.query(
                `INSERT INTO settings (setting_key, setting_value) VALUES ${entries.map(() => '(?, ?)').join(',')}
                 ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
                entries.flat()
            );
        }
        const wasAutomatic = currentSettings.jofotara_enabled === '1' && currentSettings.jofotara_auto_submit === '1';
        const isAutomatic = nextSettings.jofotara_enabled === '1' && nextSettings.jofotara_auto_submit === '1';
        const enablingAutomation = isAutomatic && !wasAutomatic;
        if (enablingAutomation) {
            await conn.query(
                `INSERT INTO settings (setting_key, setting_value) VALUES ('jofotara_auto_submit_since', DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
                 ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`
            );
        }
        await conn.commit();
        try {
            req.app.get('io')?.to('staff').emit('jofotara_operations_changed', {
                configuration_changed: true,
                automatic_enabled: isAutomatic
            });
        } catch (error) {
            logAdminRouteError(req, error);
        }
        try {
            const configured = req.app.get('jofotaraOperationsRunner')?.configure(isAutomatic);
            void Promise.resolve(configured).catch(error => logAdminRouteError(req, error));
        } catch (error) {
            logAdminRouteError(req, error);
        }
        return sendSuccess(res, { message: 'JoFotara settings saved.' });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        routeError(req, res, error);
    } finally { conn?.release(); }
});

router.get('/jofotara/invoices/:invoiceId/xml', async (req, res) => {
    try {
        const result = await previewSalesXml(Number(req.params.invoiceId));
        const safeNumber = result.documentNumber.replace(/[^A-Za-z0-9_-]/g, '_');
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="jofotara-${safeNumber}.xml"`);
        return res.send(result.xml);
    } catch (error) { routeError(req, res, error); }
});

router.get('/jofotara/operations', async (req, res) => {
    try { return sendSuccess(res, await getJofotaraOperations({ limit: req.query.limit, sourceKind: req.query.source_kind, orderTypeId: req.query.order_type_id, orderInvoiceId: req.query.invoice_id, status: req.query.status, issuedFrom: req.query.issued_from, issuedTo: req.query.issued_to })); }
    catch (error) { routeError(req, res, error); }
});

router.get('/jofotara/operations/count', async (req, res) => {
    try { return sendSuccess(res, await getJofotaraOperationCount()); }
    catch (error) { routeError(req, res, error); }
});

router.get('/jofotara/operations/documents/:documentId/response', async (req, res) => {
    try {
        if (!/^[1-9]\d*$/.test(req.params.documentId)) return sendError(res, 400, 'Invalid JoFotara document.');
        const [[document]] = await pool.query(
            'SELECT id, status, http_status, response_body, last_error FROM jofotara_documents WHERE id=?',
            [Number(req.params.documentId)]
        );
        if (!document) return sendError(res, 404, 'JoFotara document not found.');
        let response = document.response_body;
        try { response = JSON.parse(response); } catch {}
        return sendSuccess(res, {
            document_id: Number(document.id), status: document.status, http_status: document.http_status,
            last_error: document.last_error, response
        });
    } catch (error) { routeError(req, res, error); }
});

router.post('/jofotara/operations/process', async (req, res) => {
    try {
        const result = await processJofotaraOperations();
        req.app.get('io')?.to('staff').emit('jofotara_operations_changed', result);
        return sendSuccess(res, { result });
    } catch (error) { routeError(req, res, error); }
});

router.post('/jofotara/operations/invoices/:invoiceId/submit', async (req, res) => {
    try {
        const document = await submitSalesInvoice({ invoiceId: Number(req.params.invoiceId), actorUserId: req.user.id, surface: 'operations' });
        req.app.get('io')?.to('staff').emit('jofotara_operations_changed', { source_type: 'invoice', source_id: Number(req.params.invoiceId) });
        return sendSuccess(res, { document });
    }
    catch (error) { routeError(req, res, error); }
});

router.post('/jofotara/operations/refunds/:refundId/submit', async (req, res) => {
    try {
        const document = await submitCreditNote({ refundId: Number(req.params.refundId), actorUserId: req.user.id, surface: 'operations' });
        req.app.get('io')?.to('staff').emit('jofotara_operations_changed', { source_type: 'credit_note', source_id: Number(req.params.refundId) });
        return sendSuccess(res, { document });
    }
    catch (error) { routeError(req, res, error); }
});

router.get('/jofotara/invoices/:invoiceId', async (req, res) => {
    try { return sendSuccess(res, await getOrderJofotaraState(Number(req.params.invoiceId))); }
    catch (error) { routeError(req, res, error); }
});

router.post('/jofotara/invoices/:invoiceId/submit', async (req, res) => {
    try {
        const document = await submitSalesInvoice({ invoiceId: Number(req.params.invoiceId), actorUserId: req.user.id, surface: 'order' });
        req.app.get('io')?.to('staff').emit('jofotara_operations_changed', { source_type: 'invoice', source_id: Number(req.params.invoiceId) });
        return sendSuccess(res, { document });
    }
    catch (error) { routeError(req, res, error); }
});

router.post('/jofotara/refunds/:refundId/submit', async (req, res) => {
    try {
        const document = await submitCreditNote({ refundId: Number(req.params.refundId), actorUserId: req.user.id, surface: 'order' });
        req.app.get('io')?.to('staff').emit('jofotara_operations_changed', { source_type: 'credit_note', source_id: Number(req.params.refundId) });
        return sendSuccess(res, { document });
    }
    catch (error) { routeError(req, res, error); }
});

module.exports = router;
