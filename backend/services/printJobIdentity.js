const crypto = require('crypto');

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }

    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashPrintPayload(payload) {
    return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableKitchenStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableKitchenStringify).sort().join(',')}]`;
    }
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableKitchenStringify(value[key])}`).join(',')}}`;
}

function hashKitchenIdempotencyPayload(payload) {
    const semanticPayload = { ...payload, data: { ...payload.data } };
    delete semanticPayload.data.compiled_document_v1;

    // A held kitchen round is identified by its server-owned batch, canonical
    // items, and stable printer id.  Human labels and connection metadata can
    // change while a retry is in flight; they must not turn the same round
    // into a second physical job.  `printer_id` remains part of the semantic
    // payload so a route change still gets a distinct job identity.
    for (const key of ['printer_name', 'printer_type', 'network_ip', 'network_port', 'status_capability']) {
        delete semanticPayload[key];
    }
    delete semanticPayload.data.printer_label;

    return crypto.createHash('sha256').update(stableKitchenStringify(semanticPayload)).digest('hex');
}

function resolvePrinterId(payload) {
    return String(
        payload.printer_id ||
        payload.printer_name ||
        payload.network_ip ||
        payload.data?.printer_label ||
        'unknown-printer'
    );
}

// A checkout receipt still in flight across the business-day cutoff may print for this
// long after the sale; the queue purge keeps rows this young so its dedup still holds.
const CHECKOUT_PRINT_GRACE_MS = 15 * 60 * 1000;

function buildPrintIdempotencyKey(payload, payloadHash) {
    const printerId = resolvePrinterId(payload);
    const type = payload.print_type || 'unknown-type';
    const requestId = payload.print_request_id || payload.data?.print_request_id || crypto.randomUUID();

    if (type === 'kitchen') {
        const batchId = payload.data?.print_batch_id;
        if (!batchId) throw new Error('Kitchen print job missing print_batch_id');
        return `kitchen:${batchId}:${printerId}:${payloadHash}`;
    }

    if (payload.reprint_of_queue_id) {
        const sequence = payload.data?.reprint_sequence;
        return `reprint:${payload.reprint_of_queue_id}:${printerId}:${sequence}:${payloadHash}`;
    }

    if (type === 'receipt') {
        // A checkout's own receipt id is one paper, whichever printer it is sent to.
        if (String(requestId).startsWith('checkout-receipt:')) return `receipt:${requestId}`;
        return payload.print_request_id || payload.data?.print_request_id
            ? `receipt:${printerId}:${requestId}`
            : `receipt:${printerId}:${requestId}:${payloadHash}`;
    }

    if (type.endsWith('_report') || type === 'daily_report') {
        const documentId = payload.data?.audit_report_document_id || payload.data?.report_id || payloadHash;
        const copyLabel = payload.data?.copy_label || 'original';
        return `report:${type}:${documentId}:${printerId}:${copyLabel}:${requestId}`;
    }

    return `job:${type}:${printerId}:${requestId}:${payloadHash}`;
}

function buildPrintJobRecord(payload) {
    const persistedPayload = JSON.parse(JSON.stringify(payload));
    const payloadHash = hashPrintPayload(persistedPayload);
    const idempotencyPayloadHash = persistedPayload.print_type === 'kitchen'
        ? hashKitchenIdempotencyPayload(persistedPayload)
        : payloadHash;
    return {
        payload: persistedPayload,
        payloadHash,
        idempotencyKey: buildPrintIdempotencyKey(persistedPayload, idempotencyPayloadHash),
        printerId: resolvePrinterId(persistedPayload),
        printType: persistedPayload.print_type || null
    };
}

module.exports = {
    CHECKOUT_PRINT_GRACE_MS,
    buildPrintJobRecord,
    buildPrintIdempotencyKey,
    hashPrintPayload,
    stableStringify
};
