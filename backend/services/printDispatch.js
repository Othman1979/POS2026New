const pool = require('../config/db');
const { buildPrintJobRecord } = require('./printJobIdentity');
const { sanitizePrintString } = require('./printText');
const { prepareQueuedPrintPayload } = require('./printDocumentCompiler');
const { safePublishSpoolerSyncWake } = require('./spoolerSyncWake');

async function enqueuePrintJobs(executor, payloads, options = {}) {
    const revisionOverrideId = options.revisionOverrideId;
    if (revisionOverrideId !== undefined && revisionOverrideId !== 'builtin' &&
        (!Number.isSafeInteger(revisionOverrideId) || revisionOverrideId < 1)) {
        const error = new Error('Invalid internal template revision override.');
        error.code = 'PRINT_TEMPLATE_REVISION_NOT_FOUND';
        error.statusCode = 404;
        throw error;
    }
    const queued = [];
    for (const payload of payloads) {
        const preparedPayload = await prepareQueuedPrintPayload(executor, payload, {
            revisionOverrideId,
            templateTest: options.templateTest
        });
        const record = buildPrintJobRecord(preparedPayload);
        const [result] = await executor.query(
            `INSERT INTO print_queue (
                payload, idempotency_key, payload_hash, printer_id, print_type, status
             ) VALUES (?, ?, ?, ?, ?, 'pending')
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
            [
                JSON.stringify(record.payload),
                record.idempotencyKey,
                record.payloadHash,
                record.printerId,
                record.printType
            ]
        );
        let status = 'pending';
        if (options.returnStatus === true) {
            const [existingRows] = await executor.query(
                'SELECT id, status, payload_hash FROM print_queue WHERE id = ? FOR UPDATE',
                [result.insertId]
            );
            const existing = existingRows?.[0];
            if (existing?.status) status = String(existing.status);
        }
        queued.push({ id: result.insertId, idempotency_key: record.idempotencyKey, ...(options.returnStatus === true ? { status } : {}) });
    }
    return queued;
}

async function enqueueCommittedPrintJobs(payloads, options = {}) {
    const queued = await enqueuePrintJobs(pool, payloads, options);
    if (queued.length > 0) safePublishSpoolerSyncWake();
    return queued;
}

function selectReceiptPrinter(printers, { printerId = null } = {}) {
    if (printerId !== null && printerId !== undefined && printerId !== '') {
        const selected = printers.find(printer => String(printer.id) === String(printerId));
        if (selected) return selected;

        const err = new Error('The selected receipt printer is unavailable.');
        err.statusCode = 409;
        throw err;
    }

    if (printers.length === 1) return printers[0];
    if (printers.length === 0) return null;

    const err = new Error('Select a receipt printer for this terminal.');
    err.statusCode = 409;
    throw err;
}

async function resolveReceiptPrinter({ printerId = null } = {}) {
    const [printers] = await pool.query("SELECT * FROM printers WHERE role = 'receipt' AND is_active = 1");
    return selectReceiptPrinter(printers, { printerId });
}

async function dispatchReceiptPrint({ io, printerId, printType, data }) {
    const printerConfig = await resolveReceiptPrinter({ printerId });
    if (!printerConfig) {
        const err = new Error('No receipt printer found.');
        err.statusCode = 400;
        throw err;
    }

    await enqueueCommittedPrintJobs([{
        printer_id: printerConfig.id,
        printer_name: sanitizePrintString(printerConfig.windows_name, 200),
        printer_type: printerConfig.type,
        network_ip: printerConfig.network_ip,
        network_port: printerConfig.network_port,
        status_capability: printerConfig.status_capability || 'write_only',
        print_type: printType,
        data
    }]);

    return { printer_id: printerConfig.id };
}

module.exports = {
    enqueuePrintJobs,
    enqueueCommittedPrintJobs,
    dispatchReceiptPrint,
    resolveReceiptPrinter,
    selectReceiptPrinter,
};
