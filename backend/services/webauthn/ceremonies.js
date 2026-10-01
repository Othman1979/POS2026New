const crypto = require('crypto');
const pool = require('../../config/db');

const CEREMONY_TTL_MS = 2 * 60 * 1000;
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function hashOpaque(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function constantTimeOpaqueHashEquals(left, right) {
    if (!/^[a-f0-9]{64}$/.test(String(left || '')) || !/^[a-f0-9]{64}$/.test(String(right || ''))) return false;
    return crypto.timingSafeEqual(Buffer.from(String(left), 'hex'), Buffer.from(String(right), 'hex'));
}

function randomOpaque(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function toDate(ms) {
    return new Date(Date.now() + ms);
}

async function createCeremony({
    executor = pool,
    flow,
    userId = null,
    requestingUserId = null,
    replacementCredentialId = null,
    recoveryCodeId = null,
    isDecoy = false,
    enrollmentToken = null,
    intendedDeviceLabel = null,
    challenge = crypto.randomBytes(32),
    ttlMs = CEREMONY_TTL_MS,
} = {}) {
    if (!flow) throw new Error('WebAuthn ceremony flow is required.');
    await pruneExpiredCeremonies(executor, 100);
    const id = crypto.randomUUID();
    const expiresAt = toDate(enrollmentToken ? ENROLLMENT_TTL_MS : ttlMs);
    const enrollmentExpiresAt = enrollmentToken ? expiresAt : null;
    await executor.query(
        `INSERT INTO webauthn_ceremonies
            (id, flow, user_id, requesting_user_id, replacement_credential_id,
             recovery_code_id, is_decoy, challenge, enrollment_token_hash,
             enrollment_expires_at, intended_device_label, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            flow,
            userId,
            requestingUserId,
            replacementCredentialId,
            recoveryCodeId,
            isDecoy ? 1 : 0,
            Buffer.from(challenge),
            enrollmentToken ? hashOpaque(enrollmentToken) : null,
            enrollmentExpiresAt,
            intendedDeviceLabel || null,
            expiresAt,
        ]
    );
    return {
        id,
        challenge: Buffer.from(challenge).toString('base64url'),
        enrollmentToken,
        expiresAt,
        enrollmentExpiresAt,
    };
}

async function getCeremonyForUpdate(id, executor = pool) {
    const [rows] = await executor.query(
        `SELECT * FROM webauthn_ceremonies WHERE id = ? LIMIT 1 FOR UPDATE`,
        [id]
    );
    return rows[0] || null;
}

async function getCeremony(id, executor = pool) {
    const [rows] = await executor.query(
        `SELECT * FROM webauthn_ceremonies WHERE id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

function assertPendingCeremony(ceremony, expectedFlow) {
    if (!ceremony || ceremony.flow !== expectedFlow) {
        const error = new Error('The WebAuthn ceremony is invalid or expired.');
        error.publicCode = 'WEBAUTHN_CEREMONY_INVALID';
        error.statusCode = 400;
        throw error;
    }
    if (ceremony.terminal_state !== 'pending' || new Date(ceremony.expires_at).getTime() <= Date.now()) {
        const error = new Error('The WebAuthn ceremony is invalid or expired.');
        error.publicCode = 'WEBAUTHN_CEREMONY_EXPIRED';
        error.statusCode = 400;
        throw error;
    }
    if (Number(ceremony.attempt_count) >= MAX_ATTEMPTS) {
        const error = new Error('Too many WebAuthn attempts. Start again.');
        error.publicCode = 'WEBAUTHN_CEREMONY_THROTTLED';
        error.statusCode = 429;
        throw error;
    }
    return true;
}

async function recordCeremonyAttempt(ceremonyId, executor = pool) {
    await executor.query(
        `UPDATE webauthn_ceremonies SET attempt_count = attempt_count + 1 WHERE id = ? AND terminal_state = 'pending'`,
        [ceremonyId]
    );
}

async function finishCeremony(ceremonyId, terminalState = 'consumed', executor = pool) {
    const [result] = await executor.query(
        `UPDATE webauthn_ceremonies
            SET terminal_state = ?, consumed_at = CURRENT_TIMESTAMP
          WHERE id = ? AND terminal_state = 'pending'`,
        [terminalState, ceremonyId]
    );
    if (Number(result?.affectedRows || 0) !== 1) {
        const error = new Error('The WebAuthn ceremony is no longer available.');
        error.publicCode = 'WEBAUTHN_CEREMONY_REPLAYED';
        error.statusCode = 409;
        throw error;
    }
    return true;
}

async function pruneExpiredCeremonies(executor = pool, limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const [result] = await executor.query(
        `DELETE FROM webauthn_ceremonies
          WHERE (terminal_state = 'pending' AND expires_at <= CURRENT_TIMESTAMP)
             OR (terminal_state <> 'pending' AND consumed_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 DAY))
          LIMIT ${safeLimit}`
    );
    return Number(result?.affectedRows || 0);
}

module.exports = {
    CEREMONY_TTL_MS,
    ENROLLMENT_TTL_MS,
    MAX_ATTEMPTS,
    hashOpaque,
    constantTimeOpaqueHashEquals,
    randomOpaque,
    createCeremony,
    getCeremony,
    getCeremonyForUpdate,
    assertPendingCeremony,
    recordCeremonyAttempt,
    finishCeremony,
    pruneExpiredCeremonies,
};
