const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool, sendError, sendSuccess, logAdminRouteError } = require('./helpers');
const { createKeyedRateLimiter, actorKey } = require('../../middleware/rateLimit');
const {
    getTemplateWorkspace,
    getTemplateRevision,
    saveTemplateRevision,
    confirmTemplateTest,
    activateTemplateRevision
} = require('../../services/printTemplateManager');
const { getTemplateCatalog, compileTemplate, validateTemplate } = require('../../services/printTemplateEngine');
const { getTemplateFixture, listTemplateFixtures } = require('../../services/printTemplateDefaults');
const { enqueueCommittedPrintJobs } = require('../../services/printDispatch');
const { loadStoreLogo } = require('../../services/printDocumentCompiler');

function directPeerIp(req) {
    const value = String(req.socket?.remoteAddress || '').trim().toLowerCase();
    return value.replace(/^::ffff:/, '') || 'unknown';
}

const previewRateLimit = createKeyedRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    message: 'Too many template preview requests. Please try again in a minute.',
    keyForRequest: actorKey
});

const testPrintRateLimit = createKeyedRateLimiter({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many template test prints. Please try again in a minute.',
    keyForRequest: actorKey
});

function fail(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    throw error;
}

function assertDocType(docType) {
    if (!['receipt', 'kitchen'].includes(docType)) {
        fail('TEMPLATE_DOC_TYPE_INVALID', 'Unsupported print template document type');
    }
    return docType;
}

function assertBody(body, keys) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) {
        fail('PRINT_TEMPLATE_REQUEST_INVALID', 'Invalid print template request body');
    }
    const actual = Object.keys(body);
    if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
        fail('PRINT_TEMPLATE_REQUEST_INVALID', 'Unexpected print template request field');
    }
}

function assertSaveBody(body) {
    assertBody(body, ['definition', 'expectedLockVersion']);
    if (!body.definition || typeof body.definition !== 'object' || Array.isArray(body.definition) ||
        Object.getPrototypeOf(body.definition) !== Object.prototype) {
        fail('PRINT_TEMPLATE_REQUEST_INVALID', 'Template definition must be an object');
    }
    if (typeof body.expectedLockVersion !== 'number' || !Number.isSafeInteger(body.expectedLockVersion) || body.expectedLockVersion < 0) {
        fail('PRINT_TEMPLATE_REQUEST_INVALID', 'Template lock version must be a non-negative integer');
    }
}

function assertTestPrintBody(body) {
    assertBody(body, ['revisionId', 'printerId', 'fixtureKey']);
    if (body.revisionId !== null && (!Number.isSafeInteger(body.revisionId) || body.revisionId < 1)) {
        fail('PRINT_TEMPLATE_REQUEST_INVALID', 'Template revision must be null or a positive integer');
    }
    if (!Number.isSafeInteger(body.printerId) || body.printerId < 1 || typeof body.fixtureKey !== 'string') {
        fail('PRINT_TEMPLATE_REQUEST_INVALID', 'A printer and fixture are required');
    }
}

function assertConfirmBody(body) {
    assertBody(body, ['queueId']);
    if (!Number.isSafeInteger(body.queueId) || body.queueId < 1) fail('PRINT_TEMPLATE_REQUEST_INVALID', 'A queue id is required');
}

function assertActivateBody(body) {
    assertBody(body, ['revisionId', 'expectedLockVersion', 'reason']);
    if (body.revisionId !== null && (!Number.isSafeInteger(body.revisionId) || body.revisionId < 1) ||
        !Number.isSafeInteger(body.expectedLockVersion) || body.expectedLockVersion < 0 ||
        typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) {
        fail('PRINT_TEMPLATE_REQUEST_INVALID', 'Invalid template activation request');
    }
}

function workspaceResponse(workspace, includeEditorData, docType) {
    const { printers, builtin, ...template } = workspace;
    const response = { success: true, template, printers };
    if (includeEditorData) {
        response.builtin = builtin;
        response.catalog = getTemplateCatalog(docType);
        response.fixtures = listTemplateFixtures(docType);
    }
    return response;
}

function previewArtifact(artifact) {
    return {
        ...artifact,
        html: `<div data-template-preview-shell="true"><div data-template-preview-notice="true" style="width:576px;box-sizing:border-box;padding:8px 12px;background:#111;color:#fff;font:700 14px/1.25 sans-serif;text-align:center">TEMPLATE PREVIEW — NOT A SALE</div>${artifact.html}</div>`
    };
}

function routeError(req, res, error) {
    if (error.statusCode && error.statusCode < 500) {
        return sendError(res, error.statusCode, error.message, error.code || null);
    }
    if (String(error.code || '').startsWith('TEMPLATE_') || error.code === 'PRINT_TEMPLATE_DEFINITION_INVALID') {
        return sendError(res, 422, error.message, error.code || null);
    }
    logAdminRouteError(req, error);
    return sendError(res, 500, 'Unable to process the print template request.');
}

router.get('/print-templates/:docType', async (req, res) => {
    try {
        const docType = assertDocType(req.params.docType);
        const workspace = await getTemplateWorkspace(pool, docType);
        return res.json(workspaceResponse(workspace, true, docType));
    } catch (error) {
        return routeError(req, res, error);
    }
});

router.get('/print-templates/:docType/revisions/:revisionId', async (req, res) => {
    try {
        const docType = assertDocType(req.params.docType);
        const revision = await getTemplateRevision(pool, docType, req.params.revisionId);
        return sendSuccess(res, { revision });
    } catch (error) {
        return routeError(req, res, error);
    }
});

router.post('/print-templates/:docType/revisions', async (req, res) => {
    try {
        const docType = assertDocType(req.params.docType);
        assertSaveBody(req.body);
        const connection = await pool.getConnection();
        try {
            await saveTemplateRevision(connection, {
                docType,
                definition: req.body.definition,
                expectedLockVersion: req.body.expectedLockVersion,
                userId: req.user.id,
                ipAddress: directPeerIp(req)
            });
        } finally {
            connection.release();
        }
        const workspace = await getTemplateWorkspace(pool, docType);
        return res.json(workspaceResponse(workspace, false, docType));
    } catch (error) {
        return routeError(req, res, error);
    }
});

router.post('/print-templates/:docType/preview', previewRateLimit, async (req, res) => {
    try {
        const docType = assertDocType(req.params.docType);
        assertBody(req.body, ['definition', 'fixtureKey']);
        if (!listTemplateFixtures(docType).some(fixture => fixture.key === req.body.fixtureKey)) {
            fail('PRINT_TEMPLATE_FIXTURE_NOT_FOUND', 'Unknown print template fixture');
        }
        const model = getTemplateFixture(docType, req.body.fixtureKey);
        validateTemplate(req.body.definition, { allowStoreLogo: true });
        const logo = await loadStoreLogo(pool, req.body.definition);
        const result = await compileTemplate(req.body.definition, model, {
            mode: 'preview',
            templateRevisionId: 'preview:unpublished',
            profile: { allowStoreLogo: true }, storeLogoDataUri: logo.dataUri
        });
        return sendSuccess(res, { artifact: previewArtifact(result.artifact), warnings: [...(result.warnings || []), ...(logo.warning ? [logo.warning] : [])] });
    } catch (error) {
        return routeError(req, res, error);
    }
});

router.post('/print-templates/:docType/test-print', testPrintRateLimit, async (req, res) => {
    try {
        const docType = assertDocType(req.params.docType);
        assertTestPrintBody(req.body);
        if (!listTemplateFixtures(docType).some(fixture => fixture.key === req.body.fixtureKey)) {
            fail('PRINT_TEMPLATE_FIXTURE_NOT_FOUND', 'Unknown print template fixture');
        }
        const [printerRows] = await pool.query(
            `SELECT id, name, role, type, windows_name, network_ip, network_port, status_capability, active_endpoint_key
               FROM printers
              WHERE id = ? AND role = ? AND is_active = 1 AND active_endpoint_key IS NOT NULL
              LIMIT 1`,
            [req.body.printerId, docType]
        );
        const printer = printerRows[0];
        if (!printer) fail('PRINT_PRINTER_UNAVAILABLE', 'The selected printer is not available for this document type', 409);
        let storeInfo = null;
        if (docType === 'receipt') {
            const [settingsRows] = await pool.query(
                "SELECT setting_value FROM settings WHERE setting_key = 'receipt_config' LIMIT 1"
            );
            storeInfo = { receipt_config: settingsRows[0]?.setting_value ?? null };
        }
        const requestId = `template-test:${crypto.randomUUID()}`;
        const payload = {
            printer_id: Number(printer.id),
            printer_name: String(printer.windows_name || printer.name).slice(0, 200),
            printer_type: printer.type,
            network_ip: printer.network_ip,
            network_port: printer.network_port,
            status_capability: printer.status_capability || 'write_only',
            print_type: docType,
            print_request_id: requestId,
            data: {
                print_request_id: requestId,
                ...(docType === 'kitchen' ? { print_batch_id: requestId } : {})
            }
        };
        const queued = await enqueueCommittedPrintJobs([payload], {
            revisionOverrideId: req.body.revisionId === null ? 'builtin' : req.body.revisionId,
            templateTest: {
                docType, revisionId: req.body.revisionId, printerId: Number(printer.id),
                printerEndpointKey: printer.active_endpoint_key, fixtureKey: req.body.fixtureKey, storeInfo
            }
        });
        return sendSuccess(res, { queueId: queued[0].id });
    } catch (error) {
        return routeError(req, res, error);
    }
});

router.get('/print-templates/test-jobs/:queueId', async (req, res) => {
    try {
        const queueId = Number(req.params.queueId);
        if (!Number.isSafeInteger(queueId) || queueId < 1) fail('PRINT_TEMPLATE_REQUEST_INVALID', 'A queue id is required');
        const [rows] = await pool.query(
            `SELECT id, payload, status, device_status, attempts, acknowledged_at, spooler_version, last_error
               FROM print_queue WHERE id = ? LIMIT 1`, [queueId]
        );
        const job = rows[0];
        let payload;
        try { payload = job && (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload); } catch { payload = null; }
        const marker = payload?.data?.template_test;
        const artifact = payload?.data?.compiled_document_v1;
        if (!job || !marker || typeof marker !== 'object' || Array.isArray(marker) ||
            !['receipt', 'kitchen'].includes(marker.docType) || marker.docType !== payload.print_type ||
            Number(marker.printerId) !== Number(payload.printer_id) ||
            typeof marker.printerEndpointKey !== 'string' || !marker.printerEndpointKey ||
            !(marker.revisionId === null || (Number.isSafeInteger(marker.revisionId) && marker.revisionId > 0)) ||
            typeof marker.fixtureKey !== 'string' || artifact?.docType !== marker.docType ||
            artifact?.templateRevisionId !== (marker.revisionId === null ? `builtin:${marker.docType}-v1` : `revision:${marker.revisionId}`)) {
            fail('PRINT_TEMPLATE_TEST_INVALID', 'The selected queue job is not a template test print', 409);
        }
        return sendSuccess(res, {
            job: {
                id: Number(job.id), status: job.status, deviceStatus: job.device_status,
                attempts: Number(job.attempts || 0), acknowledgedAt: job.acknowledged_at || null,
                spoolerVersion: job.spooler_version || null,
                error: job.last_error ? 'The test print did not complete. Review the spooler status.' : null
            }
        });
    } catch (error) {
        return routeError(req, res, error);
    }
});

router.post('/print-templates/:docType/revisions/:revisionId/confirm-test', async (req, res) => {
    try {
        const docType = assertDocType(req.params.docType);
        assertConfirmBody(req.body);
        const connection = await pool.getConnection();
        try {
            const result = await confirmTemplateTest(connection, {
                docType, revisionId: req.params.revisionId, queueId: req.body.queueId,
                userId: req.user.id, ipAddress: directPeerIp(req)
            });
            return sendSuccess(res, result);
        } finally {
            connection.release();
        }
    } catch (error) {
        return routeError(req, res, error);
    }
});

router.post('/print-templates/:docType/activate', async (req, res) => {
    try {
        const docType = assertDocType(req.params.docType);
        assertActivateBody(req.body);
        const connection = await pool.getConnection();
        try {
            await activateTemplateRevision(connection, {
                docType, revisionId: req.body.revisionId, expectedLockVersion: req.body.expectedLockVersion,
                reason: req.body.reason, userId: req.user.id, ipAddress: directPeerIp(req)
            });
        } finally {
            connection.release();
        }
        const workspace = await getTemplateWorkspace(pool, docType);
        return res.json(workspaceResponse(workspace, false, docType));
    } catch (error) {
        return routeError(req, res, error);
    }
});

module.exports = router;
