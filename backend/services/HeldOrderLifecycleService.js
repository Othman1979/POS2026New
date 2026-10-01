const crypto = require('crypto');
const { kitchenBaselineKnown } = require('./HeldOrderKitchenDispatch');

const LEASE_MINUTES = 10;
const SAFE_PROJECTION_FIELDS = [
    'id', 'user_id', 'order_id', 'order_seq_scope', 'reference_name', 'cart_data', 'subtotal', 'kitchen_fired',
    'service_charge_snapshot_id', 'parent_invoice_id', 'table_id', 'created_at',
    'version', 'claimed_by_user_id', 'claim_expires_at', 'updated_at',
    'kitchen_dispatch_version', 'call_center_user_id'
];
const SAFE_RESULT_FIELDS = [
    'id', 'version', 'status', 'warning', 'followUpSequence', 'batchId',
    'queueIds', 'invoiceId', 'deltaCount', 'kitchenDispatchVersion', 'order_display_no', 'customerReceiptRequested'
];

function lifecycleError(message, statusCode = 409, publicCode = 'HELD_OPERATION_CONFLICT') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.publicCode = publicCode;
    return error;
}

function createClaimToken() {
    return crypto.randomBytes(32).toString('hex');
}

function hashClaimToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function verifyClaimToken(token, expectedHash) {
    if (typeof token !== 'string' || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        return false;
    }
    const actual = Buffer.from(hashClaimToken(token), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isLeaseActive(row, now) {
    return row?.claimed_by_user_id != null
        && row?.claim_token_hash
        && row?.claim_expires_at
        && new Date(row.claim_expires_at).getTime() > new Date(now).getTime();
}

function safeProjection(row = {}) {
    const projection = {};
    for (const field of SAFE_PROJECTION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(row, field)) projection[field] = row[field];
    }
    projection.claimOwnerUserId = row.claimed_by_user_id == null ? null : Number(row.claimed_by_user_id);
    projection.claimExpiresAt = row.claim_expires_at ?? null;
    projection.kitchenDispatchVersion = Number(row.kitchen_dispatch_version || 0);
    // The browser only needs to know whether a trusted kitchen baseline exists, not the snapshot itself.
    projection.kitchen_baseline_known = kitchenBaselineKnown(row.kitchen_snapshot);
    projection.version = Number(row.version || 0);
    return projection;
}

function safeOperationResult(result = {}) {
    return SAFE_RESULT_FIELDS.reduce((safe, field) => {
        if (Object.prototype.hasOwnProperty.call(result, field) && result[field] != null) safe[field] = result[field];
        return safe;
    }, {});
}

function readOperationReplay(row, operationId, operationKind) {
    if (!row || row.last_operation_id !== operationId || row.last_operation_kind !== operationKind) return null;
    try {
        return safeOperationResult(JSON.parse(row.last_operation_result || '{}'));
    } catch (_) {
        return null;
    }
}

async function selectHeldForUpdate(conn, id) {
    const [rows] = await conn.query('SELECT * FROM held_orders WHERE id=? FOR UPDATE', [id]);
    if (!rows?.length) throw lifecycleError('Held order was not found.', 404, 'HELD_ORDER_NOT_FOUND');
    return rows[0];
}

function assertExpectedVersion(row, expectedVersion) {
    if (expectedVersion != null && Number(row.version) !== Number(expectedVersion)) {
        throw lifecycleError('Held order changed. Refresh and try again.', 409, 'HELD_VERSION_CONFLICT');
    }
}

async function claimHeldOrder(conn, { id, userId, claimToken, expectedVersion, now = new Date() }) {
    if (!claimToken) throw lifecycleError('A claim token is required.', 400, 'HELD_CLAIM_TOKEN_REQUIRED');
    const row = await selectHeldForUpdate(conn, id);

    if (isLeaseActive(row, now)) {
        if (Number(row.claimed_by_user_id) === Number(userId) && verifyClaimToken(claimToken, row.claim_token_hash)) {
            return { ...safeProjection(row), replay: true };
        }
        throw lifecycleError('Held order is being edited on another terminal.', 409, 'HELD_IN_USE');
    }
    assertExpectedVersion(row, expectedVersion);

    const claimExpiresAt = new Date(new Date(now).getTime() + (LEASE_MINUTES * 60 * 1000));
    const nextVersion = Number(row.version || 0) + 1;
    const [result] = await conn.query(`
        UPDATE held_orders
           SET claimed_by_user_id=?, claim_token_hash=?, claim_expires_at=?, version=?, updated_at=?
         WHERE id=? AND version=?
    `, [userId, hashClaimToken(claimToken), claimExpiresAt, nextVersion, now, id, row.version]);
    if (Number(result?.affectedRows) !== 1) {
        throw lifecycleError('Held order changed. Refresh and try again.', 409, 'HELD_VERSION_CONFLICT');
    }

    return {
        ...safeProjection({ ...row, version: nextVersion, claimed_by_user_id: userId, claim_expires_at: claimExpiresAt, updated_at: now }),
        replay: false
    };
}

// Call only with the current row already locked by this transaction.
function assertClaimedHeldOrder(row, { userId, claimToken, expectedVersion, now = new Date() }) {
    if (!claimToken) throw lifecycleError('A claim token is required.', 400, 'HELD_CLAIM_TOKEN_REQUIRED');
    assertExpectedVersion(row, expectedVersion);
    if (!isLeaseActive(row, now)
        || Number(row.claimed_by_user_id) !== Number(userId)
        || !verifyClaimToken(claimToken, row.claim_token_hash)) {
        throw lifecycleError('Held order claim is missing or expired.', 409, 'HELD_CLAIM_REQUIRED');
    }
}

async function lockClaimedHeldOrder(conn, { id, userId, claimToken, expectedVersion, now = new Date() }) {
    if (!claimToken) throw lifecycleError('A claim token is required.', 400, 'HELD_CLAIM_TOKEN_REQUIRED');
    const row = await selectHeldForUpdate(conn, id);
    assertClaimedHeldOrder(row, { userId, claimToken, expectedVersion, now });
    return row;
}

async function releaseClaimedHeldOrder(conn, {
    id, userId, claimToken, expectedVersion, operationId, operationKind = 'release', result = {}, now = new Date()
}) {
    const row = await selectHeldForUpdate(conn, id);
    const replay = readOperationReplay(row, operationId, operationKind);
    if (replay) return { ...safeProjection(row), result: replay, replay: true };
    assertExpectedVersion(row, expectedVersion);
    if (!isLeaseActive(row, now)
        || Number(row.claimed_by_user_id) !== Number(userId)
        || !verifyClaimToken(claimToken, row.claim_token_hash)) {
        throw lifecycleError('Held order claim is missing or expired.', 409, 'HELD_CLAIM_REQUIRED');
    }
    const nextVersion = Number(row.version || 0) + 1;
    const safeResult = safeOperationResult({ ...result, version: nextVersion });
    const [update] = await conn.query(`
        UPDATE held_orders
           SET claimed_by_user_id=NULL, claim_token_hash=NULL, claim_expires_at=NULL,
               version=?, last_operation_id=?, last_operation_kind=?, last_operation_result=?, updated_at=?
         WHERE id=? AND version=?
    `, [nextVersion, operationId, operationKind, JSON.stringify(safeResult), now, id, row.version]);
    if (Number(update?.affectedRows) !== 1) {
        throw lifecycleError('Held order changed. Refresh and try again.', 409, 'HELD_VERSION_CONFLICT');
    }
    return { ...safeProjection({ ...row, version: nextVersion, claimed_by_user_id: null, claim_token_hash: null, claim_expires_at: null }), result: safeResult, replay: false };
}

async function appendHeldOrderAudit(conn, { actor = {}, eventType, heldOrderId, oldVersion = null, newVersion = null, operationId = null, ...safeValues }) {
    const role = String(actor.role || '').toLowerCase();
    if (role === 'admin' || role === 'programmer') return;
    const { appendAuditEvent } = require('./auditEvents');
    return appendAuditEvent(conn, {
        eventType,
        userId: actor.id ?? null,
        entityType: 'held_order',
        entityId: heldOrderId,
        oldValue: oldVersion == null ? null : { version: oldVersion },
        newValue: { ...(newVersion == null ? {} : { version: newVersion }), ...(operationId == null ? {} : { operation_id: operationId }), ...safeValues }
    });
}

module.exports = {
    LEASE_MINUTES,
    createClaimToken,
    hashClaimToken,
    verifyClaimToken,
    safeProjection,
    safeOperationResult,
    readOperationReplay,
    selectHeldForUpdate,
    claimHeldOrder,
    lockClaimedHeldOrder,
    assertClaimedHeldOrder,
    releaseClaimedHeldOrder,
    appendHeldOrderAudit
};
