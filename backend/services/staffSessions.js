const crypto = require('crypto');
const pool = require('../config/db');
const { eligibleCredentialSql } = require('./webauthn/credentials');

const REQUIRED_CREDENTIAL_SQL = eligibleCredentialSql('required_credential');

const SESSION_IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS || 30 * 60 * 1000);
const SESSION_ABSOLUTE_TIMEOUT_MS = Number(process.env.SESSION_ABSOLUTE_TIMEOUT_MS || 12 * 60 * 60 * 1000);

function hashSessionToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function createExpiryDates(now = Date.now()) {
    const createdAt = new Date(now);
    const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_TIMEOUT_MS);
    const idleExpiresAt = new Date(Math.min(now + SESSION_IDLE_TIMEOUT_MS, absoluteExpiresAt.getTime()));
    return { createdAt, idleExpiresAt, absoluteExpiresAt };
}

async function createSession({
    executor = pool,
    userId,
    credentialId = null,
    revokeCredentialId = null,
    webauthnVerifiedAt = null,
    revokeUserSessions = false,
    revokeReason = 'replaced',
    rawToken = null,
} = {}) {
    if (!userId) throw new Error('A user is required to create a staff session.');
    const token = rawToken || crypto.randomBytes(32).toString('hex');
    const tokenHash = hashSessionToken(token);
    const id = crypto.randomUUID();
    const { createdAt, idleExpiresAt, absoluteExpiresAt } = createExpiryDates();

    if (revokeUserSessions) {
        await executor.query(
            `UPDATE auth_sessions
                SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                    revoke_reason = COALESCE(revoke_reason, ?)
              WHERE user_id = ? AND revoked_at IS NULL`,
            [revokeReason, userId]
        );
    }
    if (revokeCredentialId) {
        await executor.query(
            `UPDATE auth_sessions
                SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                    revoke_reason = COALESCE(revoke_reason, ?)
              WHERE credential_id = ? AND revoked_at IS NULL`,
            [revokeReason, revokeCredentialId]
        );
    }

    await executor.query(
        `INSERT INTO auth_sessions
            (id, token_hash, user_id, credential_id, created_at, last_seen_at,
             idle_expires_at, absolute_expires_at, webauthn_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, tokenHash, userId, credentialId, createdAt, createdAt, idleExpiresAt, absoluteExpiresAt, webauthnVerifiedAt]
    );

    return {
        id,
        rawToken: token,
        tokenHash,
        credentialId,
        createdAt,
        idleExpiresAt,
        absoluteExpiresAt,
    };
}

async function findActiveSession(rawToken, executor = pool, { forUpdate = false } = {}) {
    if (!rawToken) return null;
    const tokenHash = hashSessionToken(rawToken);
    const [rows] = await executor.query(
        `SELECT s.id AS session_id, s.user_id, s.credential_id,
                s.created_at, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
                s.webauthn_verified_at,
                u.id, u.user_number, u.name, u.role, u.is_active, u.allowed_sections, u.table_access_scope,
                c.user_id AS credential_user_id,
                c.status AS credential_status,
                c.device_type AS credential_device_type,
                c.backed_up AS credential_backed_up,
                c.authenticator_attachment AS credential_attachment,
                EXISTS(
                    SELECT 1 FROM webauthn_credentials AS required_credential
                     WHERE required_credential.user_id = s.user_id
                       AND ${REQUIRED_CREDENTIAL_SQL}
                ) AS has_eligible_credential,
                COALESCE((SELECT setting_value FROM settings WHERE setting_key = 'staff_device_auth_mode' LIMIT 1), 'disabled') AS device_auth_mode
           FROM auth_sessions AS s
           JOIN users AS u ON u.id = s.user_id
           LEFT JOIN webauthn_credentials AS c ON c.id = s.credential_id
          WHERE s.token_hash = ?
            AND s.revoked_at IS NULL
            AND s.idle_expires_at > CURRENT_TIMESTAMP
            AND s.absolute_expires_at > CURRENT_TIMESTAMP
            AND u.is_active = 1
            AND (u.role <> 'programmer' OR s.credential_id IS NULL)
            AND (
                s.credential_id IS NULL
                OR (
                    c.status = 'active'
                    AND c.device_type = 'singleDevice'
                    AND c.backed_up = 0
                    AND (c.authenticator_attachment IS NULL OR c.authenticator_attachment = 'platform')
                )
            )
          LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
        [tokenHash]
    );
    const row = rows[0];
    if (!row) return null;
    if (row.role === 'programmer' && row.credential_id) return null;
    if (row.credential_id && (row.credential_status !== 'active' || String(row.credential_user_id || row.user_id) !== String(row.user_id))) {
        return null;
    }
    if (row.device_auth_mode === 'enforced' && !row.credential_id && row.role !== 'programmer' && Number(row.has_eligible_credential) === 1) return null;
    return { ...row, tokenHash };
}

async function touchSession(sessionId, executor = pool) {
    if (!sessionId) return false;
    const now = Date.now();
    const idleExpiresAt = new Date(Math.min(now + SESSION_IDLE_TIMEOUT_MS, now + SESSION_ABSOLUTE_TIMEOUT_MS));
    const [result] = await executor.query(
        `UPDATE auth_sessions AS s
            JOIN users AS u ON u.id = s.user_id
            LEFT JOIN webauthn_credentials AS c ON c.id = s.credential_id
            LEFT JOIN settings AS mode ON mode.setting_key = 'staff_device_auth_mode'
            SET s.last_seen_at = CURRENT_TIMESTAMP,
                s.idle_expires_at = LEAST(?, s.absolute_expires_at)
          WHERE s.id = ?
            AND s.revoked_at IS NULL
            AND s.idle_expires_at > CURRENT_TIMESTAMP
            AND s.absolute_expires_at > CURRENT_TIMESTAMP
            AND u.is_active = 1
            AND (u.role <> 'programmer' OR s.credential_id IS NULL)
            AND (
                s.credential_id IS NULL
                OR (
                    c.user_id = s.user_id
                    AND c.status = 'active'
                    AND c.device_type = 'singleDevice'
                    AND c.backed_up = 0
                    AND (c.authenticator_attachment IS NULL OR c.authenticator_attachment = 'platform')
                )
            )
            AND (
                COALESCE(mode.setting_value, 'disabled') <> 'enforced'
                OR s.credential_id IS NOT NULL
                OR u.role = 'programmer'
                OR NOT EXISTS (
                    SELECT 1 FROM webauthn_credentials AS required_credential
                     WHERE required_credential.user_id = s.user_id
                       AND ${REQUIRED_CREDENTIAL_SQL}
                )
            )`,
        [idleExpiresAt, sessionId]
    );
    return Number(result?.affectedRows || 0) === 1;
}

async function markDeviceVerified(sessionId, executor = pool) {
    if (!sessionId) return false;
    const [result] = await executor.query(
        `UPDATE auth_sessions
            SET webauthn_verified_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND revoked_at IS NULL
            AND idle_expires_at > CURRENT_TIMESTAMP
            AND absolute_expires_at > CURRENT_TIMESTAMP`,
        [sessionId]
    );
    return Number(result?.affectedRows || 0) === 1;
}

async function hasRecentDeviceVerification(sessionId, maxAgeMs = 5 * 60 * 1000, executor = pool) {
    if (!sessionId) return false;
    const ageMs = Math.max(1, Number(maxAgeMs) || 5 * 60 * 1000);
    const [[row]] = await executor.query(
        `SELECT 1 AS verified
           FROM auth_sessions
          WHERE id = ?
            AND credential_id IS NOT NULL
            AND revoked_at IS NULL
            AND idle_expires_at > CURRENT_TIMESTAMP
            AND absolute_expires_at > CURRENT_TIMESTAMP
            AND webauthn_verified_at >= ?
          LIMIT 1`,
        [sessionId, new Date(Date.now() - ageMs)]
    );
    return Boolean(row);
}

async function revokeSessionByToken(rawToken, reason = 'logout', executor = pool) {
    if (!rawToken) return false;
    const [result] = await executor.query(
        `UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                revoke_reason = COALESCE(revoke_reason, ?)
          WHERE token_hash = ? AND revoked_at IS NULL`,
        [reason, hashSessionToken(rawToken)]
    );
    return Number(result?.affectedRows || 0) === 1;
}

async function revokeUserSessions(userId, reason = 'user_security_change', executor = pool) {
    if (!userId) return 0;
    const [result] = await executor.query(
        `UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                revoke_reason = COALESCE(revoke_reason, ?)
          WHERE user_id = ? AND revoked_at IS NULL`,
        [reason, userId]
    );
    return Number(result?.affectedRows || 0);
}

async function revokeCredentialSessions(credentialId, reason = 'credential_revoked', executor = pool) {
    if (!credentialId) return 0;
    const [result] = await executor.query(
        `UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                revoke_reason = COALESCE(revoke_reason, ?)
          WHERE credential_id = ? AND revoked_at IS NULL`,
        [reason, credentialId]
    );
    return Number(result?.affectedRows || 0);
}

module.exports = {
    SESSION_IDLE_TIMEOUT_MS,
    SESSION_ABSOLUTE_TIMEOUT_MS,
    hashSessionToken,
    createExpiryDates,
    createSession,
    findActiveSession,
    touchSession,
    markDeviceVerified,
    hasRecentDeviceVerification,
    revokeSessionByToken,
    revokeUserSessions,
    revokeCredentialSessions,
};
