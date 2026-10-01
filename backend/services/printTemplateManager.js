const crypto = require('crypto');
const { appendAuditEvent } = require('./auditEvents');
const { stableStringify } = require('./printJobIdentity');
const { validateTemplate } = require('./printTemplateEngine');
const { getBuiltinTemplate } = require('./printTemplateDefaults');

function fail(code, message, statusCode = 400) {
    const error = new Error(message || code);
    error.code = code;
    error.statusCode = statusCode;
    throw error;
}

function documentType(docType) {
    if (!['receipt', 'kitchen'].includes(docType)) fail('TEMPLATE_DOC_TYPE_INVALID', 'Unsupported print template document type');
    return docType;
}

function positiveId(value, code = 'PRINT_TEMPLATE_INVALID') {
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) fail(code, 'A positive numeric id is required');
    return Number(value);
}

function lockVersion(value) {
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) fail('PRINT_TEMPLATE_CONFLICT', 'The template lock version is invalid', 409);
    return Number(value);
}

function parsedDefinition(value) {
    let definition;
    try {
        definition = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
    } catch {
        fail('PRINT_TEMPLATE_DEFINITION_INVALID', 'The stored template definition is invalid');
    }
    return validateTemplate(definition, { allowStoreLogo: true });
}

function normalizedDefinition(docType, definition) {
    const normalized = parsedDefinition(definition);
    if (normalized.docType !== docType) fail('TEMPLATE_DOC_TYPE_INVALID', 'Template document type does not match');
    return normalized;
}

function definitionHash(definition) {
    return crypto.createHash('sha256').update(stableStringify(definition)).digest('hex');
}

function builtinResolution(docType, storeInfo, warning = null) {
    const resolution = {
        kind: 'builtin',
        id: null,
        revisionNo: null,
        definition: getBuiltinTemplate(docType, { storeInfo }),
        templateRevisionId: `builtin:${docType}-v1`
    };
    if (warning) resolution.warning = warning;
    return resolution;
}

function revisionView(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        revisionNo: Number(row.revision_no),
        definitionHash: row.definition_hash,
        definition: parsedDefinition(row.definition_json),
        schemaVersion: Number(row.schema_version),
        createdAt: row.created_at,
        createdByName: row.created_by_name || null,
        lastCompileErrorCode: row.last_compile_error_code || null,
        lastCompileErrorMessage: row.last_compile_error_message || null,
        lastCompileFailedAt: row.last_compile_failed_at || null
    };
}

async function getTemplateRevision(executor, docType, revisionId) {
    documentType(docType);
    const id = positiveId(revisionId, 'PRINT_TEMPLATE_REVISION_NOT_FOUND');
    const [rows] = await executor.query(
        `SELECT r.id, r.template_id, r.revision_no, r.schema_version, r.definition_json, r.definition_hash,
                r.created_at, r.last_compile_error_code, r.last_compile_error_message, r.last_compile_failed_at,
                u.name AS created_by_name
           FROM print_template_revisions r
           JOIN print_templates t ON t.id = r.template_id
      LEFT JOIN users u ON u.id = r.created_by
          WHERE t.document_type = ? AND r.id = ?
          LIMIT 1`,
        [docType, id]
    );
    if (!rows[0]) fail('PRINT_TEMPLATE_REVISION_NOT_FOUND', 'Template revision was not found', 404);
    return revisionView(rows[0]);
}

async function getTemplateWorkspace(executor, docType) {
    documentType(docType);
    const [templateRows] = await executor.query(
        `SELECT id, document_type, active_revision_id, draft_revision_id, lock_version
           FROM print_templates
          WHERE document_type = ?
          LIMIT 1`,
        [docType]
    );
    const template = templateRows[0];
    if (!template) fail('PRINT_TEMPLATE_NOT_FOUND', 'Template record was not found', 404);

    const [historyRows] = await executor.query(
        `SELECT r.id, r.template_id, r.revision_no, r.schema_version, r.definition_json, r.definition_hash,
                r.created_at, r.last_compile_error_code, r.last_compile_error_message, r.last_compile_failed_at,
                u.name AS created_by_name
           FROM print_template_revisions r
      LEFT JOIN users u ON u.id = r.created_by
          WHERE r.template_id = ?
          ORDER BY r.revision_no DESC, r.id DESC
          LIMIT 50`,
        [template.id]
    );
    const historyIds = new Set(historyRows.map(row => Number(row.id)));
    const selectedIds = [...new Set([template.active_revision_id, template.draft_revision_id]
        .map(Number)
        .filter(id => Number.isSafeInteger(id) && id > 0 && !historyIds.has(id)))];
    let selectedRows = [];
    if (selectedIds.length) {
        const [rows] = await executor.query(
            `SELECT r.id, r.template_id, r.revision_no, r.schema_version, r.definition_json, r.definition_hash,
                    r.created_at, r.last_compile_error_code, r.last_compile_error_message, r.last_compile_failed_at,
                    u.name AS created_by_name
               FROM print_template_revisions r
          LEFT JOIN users u ON u.id = r.created_by
              WHERE r.template_id = ? AND r.id IN (${selectedIds.map(() => '?').join(',')})`,
            [template.id, ...selectedIds]
        );
        selectedRows = rows;
    }
    const revisionRows = [...historyRows, ...selectedRows];
    const revisionIds = revisionRows.map(row => Number(row.id));
    let coverageRows = [];
    if (revisionIds.length) {
        const [rows] = await executor.query(
            `SELECT r.id AS revision_id, p.id, p.name, p.role, p.active_endpoint_key,
                    tst.printer_endpoint_key, tst.confirmed_at, tst.spooler_version
               FROM print_template_revisions r
               JOIN printers p ON p.role = ? AND p.is_active = 1 AND p.active_endpoint_key IS NOT NULL
          LEFT JOIN print_template_revision_tests tst
                 ON tst.revision_id = r.id
                AND tst.printer_id = p.id
                AND tst.printer_endpoint_key = p.active_endpoint_key
                AND NOT EXISTS (
                    SELECT 1 FROM print_template_revision_tests newer
                     WHERE newer.revision_id = tst.revision_id
                       AND newer.printer_id = tst.printer_id
                       AND newer.printer_endpoint_key = tst.printer_endpoint_key
                       AND (newer.confirmed_at > tst.confirmed_at
                            OR (newer.confirmed_at = tst.confirmed_at AND newer.id > tst.id))
                )
              WHERE r.id IN (${revisionIds.map(() => '?').join(',')})
              ORDER BY r.revision_no DESC, p.name, p.id`,
            [docType, ...revisionIds]
        );
        coverageRows = rows;
    }
    const [printers] = await executor.query(
        `SELECT id, name, role, active_endpoint_key
           FROM printers
          WHERE role = ? AND is_active = 1 AND active_endpoint_key IS NOT NULL
          ORDER BY name, id`,
        [docType]
    );
    let storeInfo = null;
    if (docType === 'receipt') {
        const [settings] = await executor.query(
            "SELECT setting_value FROM settings WHERE setting_key = 'receipt_config' LIMIT 1"
        );
        storeInfo = { receipt_config: settings[0]?.setting_value ?? null };
    }

    const coverageByRevision = new Map();
    for (const row of coverageRows) {
        const revisionId = Number(row.revision_id);
        const printerId = Number(row.id);
        const coverage = coverageByRevision.get(revisionId) || new Map();
        const candidate = {
            id: printerId,
            name: row.name,
            tested: Boolean(row.confirmed_at && row.printer_endpoint_key === row.active_endpoint_key),
            confirmedAt: row.confirmed_at || null,
            spoolerVersion: row.spooler_version || null
        };
        const existing = coverage.get(printerId);
        if (!existing || (!existing.tested && candidate.tested)) coverage.set(printerId, candidate);
        coverageByRevision.set(revisionId, coverage);
    }
    const revisions = revisionRows.map(row => ({
        ...revisionView(row),
        printerCoverage: [...(coverageByRevision.get(Number(row.id))?.values() || [])],
        isActive: Number(template.active_revision_id) === Number(row.id),
        isDraft: Number(template.draft_revision_id) === Number(row.id)
    }));
    const byId = new Map(revisions.map(revision => [revision.id, revision]));
    const active = byId.get(Number(template.active_revision_id)) || builtinResolution(docType, storeInfo);
    const draft = byId.get(Number(template.draft_revision_id)) || builtinResolution(docType, storeInfo);
    return {
        id: Number(template.id),
        docType,
        lockVersion: Number(template.lock_version),
        active: active.kind === 'builtin' ? active : { kind: 'custom', ...active },
        draft: draft.kind === 'builtin' ? draft : { kind: 'custom', ...draft },
        builtin: builtinResolution(docType, storeInfo),
        revisions,
        printers: printers.map(printer => ({ id: Number(printer.id), name: printer.name, role: printer.role, endpointLabel: printer.active_endpoint_key }))
    };
}

async function saveTemplateRevision(executor, input = {}) {
    const docType = documentType(input.docType);
    const expectedLockVersion = lockVersion(input.expectedLockVersion);
    const definition = normalizedDefinition(docType, input.definition);
    const hash = definitionHash(definition);
    await executor.beginTransaction();
    try {
        const [templateRows] = await executor.query(
            'SELECT id, lock_version FROM print_templates WHERE document_type = ? FOR UPDATE', [docType]
        );
        const template = templateRows[0];
        if (!template) fail('PRINT_TEMPLATE_NOT_FOUND', 'Template record was not found', 404);
        if (Number(template.lock_version) !== expectedLockVersion) fail('PRINT_TEMPLATE_CONFLICT', 'This template changed in another admin session', 409);

        const [sameHashRows] = await executor.query(
            `SELECT id, revision_no FROM print_template_revisions
              WHERE template_id = ? AND definition_hash = ?
              LIMIT 1`,
            [template.id, hash]
        );
        let revision = sameHashRows[0];
        let reused = Boolean(revision);
        if (!revision) {
            const [revisionNoRows] = await executor.query(
                'SELECT COALESCE(MAX(revision_no), 0) + 1 AS revision_no FROM print_template_revisions WHERE template_id = ?',
                [template.id]
            );
            const revisionNo = Number(revisionNoRows[0]?.revision_no || 1);
            const [insert] = await executor.query(
                `INSERT INTO print_template_revisions
                    (template_id, revision_no, schema_version, definition_json, definition_hash, created_by)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [template.id, revisionNo, definition.schemaVersion, stableStringify(definition), hash, input.userId || null]
            );
            revision = { id: Number(insert.insertId), revision_no: revisionNo };
            reused = false;
        }
        await executor.query(
            'UPDATE print_templates SET draft_revision_id = ?, lock_version = lock_version + 1 WHERE id = ?',
            [revision.id, template.id]
        );
        await appendAuditEvent(executor, {
            eventType: 'print_template_revision_saved', userId: input.userId || null,
            entityType: 'print_template', entityId: template.id,
            newValue: { documentType: docType, revisionId: Number(revision.id), revisionNo: Number(revision.revision_no), reused },
            ipAddress: input.ipAddress || null
        });
        await executor.commit();
        return { id: Number(revision.id), revisionNo: Number(revision.revision_no), definitionHash: hash, definition, lockVersion: expectedLockVersion + 1, reused };
    } catch (error) {
        await executor.rollback();
        throw error;
    }
}

async function resolveActiveTemplate(executor, docType, options = {}) {
    documentType(docType);
    const printerId = options.browser === true ? null : positiveId(options.printerId, 'PRINT_PRINTER_UNAVAILABLE');
    const [rows] = options.browser === true ? await executor.query(
        `SELECT t.active_revision_id, r.id AS revision_id, r.revision_no, r.definition_json
           FROM print_templates t LEFT JOIN print_template_revisions r ON r.id=t.active_revision_id
          WHERE t.document_type=? LIMIT 1`, [docType]
    ) : await executor.query(
        `SELECT p.id AS printer_id, p.role AS printer_role, p.is_active AS printer_is_active, p.active_endpoint_key,
                t.active_revision_id, r.id AS revision_id, r.revision_no, r.definition_json
           FROM printers p
           JOIN print_templates t ON t.document_type = ?
      LEFT JOIN print_template_revisions r ON r.id = t.active_revision_id
          WHERE p.id = ?
          LIMIT 1`,
        [docType, printerId]
    );
    const row = rows[0];
    if (options.browser !== true && (!row || row.printer_role !== docType || Number(row.printer_is_active) !== 1 || !row.active_endpoint_key)) {
        fail('PRINT_PRINTER_UNAVAILABLE', 'The selected printer is not available for this document type', 409);
    }
    if (options.revisionOverrideId === 'builtin') return builtinResolution(docType, options.storeInfo);
    if (options.revisionOverrideId !== undefined) {
        const revisionId = positiveId(options.revisionOverrideId, 'PRINT_TEMPLATE_REVISION_NOT_FOUND');
        const [revisionRows] = await executor.query(
            `SELECT r.id, r.revision_no, r.definition_json
               FROM print_template_revisions r
               JOIN print_templates t ON t.id = r.template_id
              WHERE t.document_type = ? AND r.id = ?
              LIMIT 1`,
            [docType, revisionId]
        );
        const revision = revisionRows[0];
        if (!revision) fail('PRINT_TEMPLATE_REVISION_NOT_FOUND', 'Template revision was not found', 404);
        return {
            kind: 'custom', id: Number(revision.id), revisionNo: Number(revision.revision_no),
            definition: normalizedDefinition(docType, revision.definition_json),
            templateRevisionId: Number(revision.id)
        };
    }
    if (!row?.active_revision_id) return builtinResolution(docType, options.storeInfo);
    if (!row.revision_id) {
        if (options.strict) fail('PRINT_TEMPLATE_REVISION_NOT_FOUND', 'The active template revision is unavailable', 409);
        return builtinResolution(docType, options.storeInfo, 'PRINT_TEMPLATE_REVISION_NOT_FOUND');
    }
    try {
        const definition = normalizedDefinition(docType, row.definition_json);
        return {
            kind: 'custom', id: Number(row.revision_id), revisionNo: Number(row.revision_no), definition,
            templateRevisionId: Number(row.revision_id),
            fallback: async error => {
                const message = String(error?.message || error?.code || 'Template compilation failed').slice(0, 500);
                await executor.query(
                    `UPDATE print_template_revisions
                        SET last_compile_error_code = ?, last_compile_error_message = ?, last_compile_failed_at = NOW()
                      WHERE id = ?`,
                    [String(error?.code || 'TEMPLATE_COMPILE_FAILED').slice(0, 64), message, Number(row.revision_id)]
                );
                return builtinResolution(docType, options.storeInfo);
            }
        };
    } catch (error) {
        if (options.strict) throw error;
        await executor.query(
            `UPDATE print_template_revisions
                SET last_compile_error_code = ?, last_compile_error_message = ?, last_compile_failed_at = NOW()
              WHERE id = ?`,
            [String(error?.code || 'TEMPLATE_COMPILE_FAILED').slice(0, 64), String(error.message || error.code).slice(0, 500), Number(row.revision_id)]
        );
        return builtinResolution(docType, options.storeInfo, 'PRINT_TEMPLATE_COMPILE_FAILED');
    }
}

function queuedPayload(row) {
    try {
        return typeof row.payload === 'string' ? JSON.parse(row.payload) : structuredClone(row.payload);
    } catch {
        fail('PRINT_TEMPLATE_TEST_INVALID', 'The test print payload is invalid', 409);
    }
}

function supportedSpoolerVersion(value) {
    const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    return major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch >= 0)));
}

function testMarker(payload) {
    const marker = payload?.data?.template_test;
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
        fail('PRINT_TEMPLATE_TEST_INVALID', 'The selected queue job is not a template test print', 409);
    }
    return marker;
}

async function confirmTemplateTest(executor, input = {}) {
    const docType = documentType(input.docType);
    const revisionId = positiveId(input.revisionId, 'PRINT_TEMPLATE_REVISION_NOT_FOUND');
    const queueId = positiveId(input.queueId, 'PRINT_TEMPLATE_TEST_INVALID');
    await executor.beginTransaction();
    try {
        const [revisionRows] = await executor.query(
            `SELECT r.id, r.template_id
               FROM print_template_revisions r
               JOIN print_templates t ON t.id = r.template_id
              WHERE t.document_type = ? AND r.id = ? FOR UPDATE`,
            [docType, revisionId]
        );
        if (!revisionRows[0]) fail('PRINT_TEMPLATE_REVISION_NOT_FOUND', 'Template revision was not found', 404);
        const [queueRows] = await executor.query(
            `SELECT id, payload, printer_id, status, acknowledged_at, spooler_version
               FROM print_queue WHERE id = ? FOR UPDATE`, [queueId]
        );
        const queue = queueRows[0];
        if (!queue) fail('PRINT_TEMPLATE_TEST_INVALID', 'The selected queue job is not a template test print', 409);
        const payload = queuedPayload(queue);
        const marker = testMarker(payload);
        const artifact = payload?.data?.compiled_document_v1;
        if (marker.docType !== docType || Number(marker.revisionId) !== revisionId ||
            Number(marker.printerId) !== Number(queue.printer_id) || artifact?.docType !== docType ||
            artifact?.templateRevisionId !== `revision:${revisionId}`) {
            fail('PRINT_TEMPLATE_TEST_INVALID', 'The selected queue job does not match this template revision', 409);
        }
        if (queue.status !== 'acknowledged' || !queue.acknowledged_at || !supportedSpoolerVersion(queue.spooler_version)) {
            fail('PRINT_TEMPLATE_TEST_UNCONFIRMED', 'The test print must be acknowledged by spooler version 1.2.0 or newer', 409);
        }
        const [printerRows] = await executor.query(
            `SELECT id, name, role, is_active, active_endpoint_key
               FROM printers WHERE id = ? FOR UPDATE`, [queue.printer_id]
        );
        const printer = printerRows[0];
        if (!printer || printer.role !== docType || Number(printer.is_active) !== 1 || !printer.active_endpoint_key) {
            fail('PRINT_PRINTER_UNAVAILABLE', 'The tested printer is no longer available for this document type', 409);
        }
        if (marker.printerEndpointKey !== printer.active_endpoint_key) {
            fail('PRINT_TEMPLATE_TEST_ENDPOINT_CHANGED', 'The tested printer endpoint changed after the test print', 409);
        }
        const [existingRows] = await executor.query(
            'SELECT revision_id FROM print_template_revision_tests WHERE queue_id = ? FOR UPDATE', [queueId]
        );
        if (existingRows[0]) {
            if (Number(existingRows[0].revision_id) !== revisionId) {
                fail('PRINT_TEMPLATE_TEST_INVALID', 'This queue job was already confirmed for another revision', 409);
            }
            await executor.commit();
            return { confirmed: true, repeated: true };
        }
        await executor.query(
            `INSERT INTO print_template_revision_tests
                (revision_id, printer_id, printer_name, printer_endpoint_key, queue_id, spooler_version, acknowledged_at, confirmed_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [revisionId, printer.id, String(printer.name).slice(0, 200), printer.active_endpoint_key, queueId,
                String(queue.spooler_version).slice(0, 64), queue.acknowledged_at, input.userId || null]
        );
        await appendAuditEvent(executor, {
            eventType: 'print_template_test_confirmed', userId: input.userId || null,
            entityType: 'print_template_revision', entityId: revisionId,
            newValue: { documentType: docType, revisionId, queueId, printerId: Number(printer.id), printerEndpointKey: printer.active_endpoint_key, spoolerVersion: queue.spooler_version },
            ipAddress: input.ipAddress || null
        });
        await executor.commit();
        return { confirmed: true, repeated: false };
    } catch (error) {
        await executor.rollback();
        throw error;
    }
}

async function activateTemplateRevision(executor, input = {}) {
    const docType = documentType(input.docType);
    const expectedLockVersion = lockVersion(input.expectedLockVersion);
    const revisionId = input.revisionId === null ? null : positiveId(input.revisionId, 'PRINT_TEMPLATE_REVISION_NOT_FOUND');
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    if (!reason) fail('PRINT_TEMPLATE_REQUEST_INVALID', 'An activation reason is required');
    await executor.beginTransaction();
    try {
        const [templateRows] = await executor.query(
            'SELECT id, active_revision_id, lock_version FROM print_templates WHERE document_type = ? FOR UPDATE', [docType]
        );
        const template = templateRows[0];
        if (!template) fail('PRINT_TEMPLATE_NOT_FOUND', 'Template record was not found', 404);
        if (Number(template.lock_version) !== expectedLockVersion) fail('PRINT_TEMPLATE_CONFLICT', 'This template changed in another admin session', 409);
        if (revisionId !== null) {
            const [revisionRows] = await executor.query(
                'SELECT id, definition_json FROM print_template_revisions WHERE id = ? AND template_id = ? FOR UPDATE', [revisionId, template.id]
            );
            if (!revisionRows[0]) fail('PRINT_TEMPLATE_REVISION_NOT_FOUND', 'Template revision was not found', 404);
            normalizedDefinition(docType, revisionRows[0].definition_json);
        }
        await executor.query(
            'UPDATE print_templates SET active_revision_id = ?, draft_revision_id = ?, lock_version = lock_version + 1 WHERE id = ?',
            [revisionId, revisionId, template.id]
        );
        await appendAuditEvent(executor, {
            eventType: revisionId === null ? 'print_template_rollback' : 'print_template_activated',
            userId: input.userId || null, entityType: 'print_template', entityId: template.id,
            oldValue: { revisionId: template.active_revision_id === null ? null : Number(template.active_revision_id) },
            newValue: { documentType: docType, revisionId, reason },
            ipAddress: input.ipAddress || null
        });
        await executor.commit();
        return { revisionId, lockVersion: expectedLockVersion + 1 };
    } catch (error) {
        await executor.rollback();
        throw error;
    }
}

module.exports = {
    getTemplateWorkspace,
    getTemplateRevision,
    saveTemplateRevision,
    confirmTemplateTest,
    activateTemplateRevision,
    resolveActiveTemplate
};
