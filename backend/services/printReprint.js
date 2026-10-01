const { buildPrintJobRecord } = require('./printJobIdentity');

const { isAdminRole, userHas, PERMISSIONS } = require('./PermissionService');
const { appendAuditEvent } = require('./auditEvents');
const { commitAndPublishSpoolerSyncWake } = require('./spoolerSyncWake');

// A job may be reprinted once it has stopped moving on its own. 'failed' is deliberately
// absent: the agent still re-collects those (spoolerSync.js:228), so offering a reprint
// would race the retry and put two tickets on the paper. Exported so the POS failed-print
// list marks rows with the same rule this service enforces, instead of a second copy of it
// drifting in the UI.
const REPRINTABLE_STATES = ['acknowledged', 'dead_letter'];

function assertCanReprint(user) {
    if (isAdminRole(user) || userHas(user, PERMISSIONS.POS_REPRINT_RECEIPT)) return;
    const err = new Error('Forbidden: You do not have permission to reprint this job.');
    err.statusCode = 403;
    throw err;
}

async function nextReprintSequence(conn, originalQueueId) {
    const [[row]] = await conn.query(
        'SELECT COUNT(*) AS count FROM print_queue WHERE reprint_of_queue_id = ?',
        [originalQueueId]
    );
    return Number(row.count || 0) + 1;
}

async function reprintQueueJob(db, { originalQueueId, user, reason = '', confirmUncertain = false, io = null } = {}) {
    assertCanReprint(user);
    const queueId = Number(originalQueueId);
    if (!Number.isInteger(queueId) || queueId <= 0) {
        const err = new Error('Invalid print queue id.');
        err.statusCode = 400;
        throw err;
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [[original]] = await conn.query(
            `SELECT id, payload, printer_id, status, last_failure_class
               FROM print_queue
              WHERE id = ? FOR UPDATE`,
            [queueId]
        );
        if (!original) {
            const err = new Error('Print queue job not found.');
            err.statusCode = 404;
            throw err;
        }
        if (!REPRINTABLE_STATES.includes(original.status)) {
            const err = new Error('Only completed or dead-lettered print jobs can be reprinted.');
            err.statusCode = 409;
            throw err;
        }
        if (original.last_failure_class === 'uncertain' && confirmUncertain !== true) {
            const err = new Error('This ticket may already have printed. Check the paper and printer recovery before confirming a reprint.');
            err.statusCode = 409;
            throw err;
        }

        const sequence = await nextReprintSequence(conn, queueId);
        const payload = typeof original.payload === 'string' ? JSON.parse(original.payload) : original.payload;
        const reprintPayload = {
            ...payload,
            printer_id: payload.printer_id || original.printer_id,
            reprint_of_queue_id: queueId,
            data: {
                ...(payload.data || {}),
                reprint_of_queue_id: queueId,
                reprint_sequence: sequence,
                copy_label: 'REPRINT'
            }
        };
        if (!reprintPayload.printer_id) {
            const err = new Error('This historical job is not linked to a configured printer.');
            err.statusCode = 409;
            throw err;
        }
        const record = buildPrintJobRecord(reprintPayload);

        const [insert] = await conn.query(
            `INSERT INTO print_queue (
                payload, idempotency_key, payload_hash, printer_id, print_type,
                status, reprint_of_queue_id
             ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
            [
                JSON.stringify(record.payload),
                record.idempotencyKey,
                record.payloadHash,
                record.printerId,
                record.printType,
                queueId
            ]
        );

        await appendAuditEvent(conn, {
            eventType: 'print.reprint',
            userId: user?.id || null,
            entityType: 'print_queue',
            entityId: queueId,
            oldValue: { original_queue_id: queueId },
            newValue: {
                    original_queue_id: queueId,
                    new_queue_id: insert.insertId,
                    reason: String(reason || '').slice(0, 500)
            }
        });

        await commitAndPublishSpoolerSyncWake(conn);
        try {
            io?.to('staff').emit('print_queue_updated', {
                source: 'reprint',
                queueId: insert.insertId
            });
        } catch (_) {
            // Browser notification is best-effort after the durable reprint commit.
        }

        return {
            id: insert.insertId,
            reprint_of_queue_id: queueId,
            idempotency_key: record.idempotencyKey
        };
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = {
    REPRINTABLE_STATES,
    assertCanReprint,
    reprintQueueJob
};
