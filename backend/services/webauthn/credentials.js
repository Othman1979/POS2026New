const pool = require('../../config/db');
const { credentialLookup, safeCredentialSummary } = require('./policy');
const { parseStoredPublicJwk, serializePublicJwk } = require('../browserDeviceCrypto');

function eligibleCredentialSql(alias = '') {
    const prefix = alias ? `${alias}.` : '';
    return `${prefix}status = 'active' AND ${prefix}device_type = 'singleDevice' AND ${prefix}backed_up = 0 AND (${prefix}authenticator_attachment IS NULL OR ${prefix}authenticator_attachment = 'platform')`;
}

const ELIGIBLE_CREDENTIAL_SQL = eligibleCredentialSql();

function isEligibleCredential(credential) {
    return credential?.status === 'active'
        && credential.device_type === 'singleDevice'
        && Number(credential.backed_up || 0) === 0
        && (!credential.authenticator_attachment || credential.authenticator_attachment === 'platform');
}

async function countActiveCredentials(userId, executor = pool, forUpdate = false) {
    if (forUpdate) {
        const [rows] = await executor.query(
            `SELECT id FROM webauthn_credentials WHERE user_id = ? AND ${ELIGIBLE_CREDENTIAL_SQL} FOR UPDATE`,
            [userId]
        );
        return rows.length;
    }
    const [rows] = await executor.query(
        `SELECT COUNT(*) AS count
           FROM webauthn_credentials
          WHERE user_id = ? AND ${ELIGIBLE_CREDENTIAL_SQL}${forUpdate ? ' FOR UPDATE' : ''}`,
        [userId]
    );
    return Number(rows[0]?.count || 0);
}

async function listCredentials(userId, executor = pool) {
    const [rows] = await executor.query(
        `SELECT id, user_id, device_label, status, device_type, backed_up,
                authenticator_attachment, transports, registered_at, last_used_at,
                revoked_at, revoke_reason
           FROM webauthn_credentials
          WHERE user_id = ?
          ORDER BY status = 'active' DESC, registered_at ASC, id ASC`,
        [userId]
    );
    return rows.map(safeCredentialSummary);
}

async function findCredentialByNumericId(id, executor = pool, forUpdate = false) {
    const [rows] = await executor.query(
        `SELECT * FROM webauthn_credentials WHERE id = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
        [id]
    );
    return rows[0] || null;
}

async function insertCredential({
    executor = pool,
    userId,
    credentialId,
    publicKey,
    counter = 0,
    deviceType = 'singleDevice',
    backedUp = false,
    authenticatorAttachment = 'platform',
    deviceLabel,
    registeredByUserId = null,
} = {}) {
    const parsed = credentialLookup(credentialId);
    const [result] = await executor.query(
        `INSERT INTO webauthn_credentials
            (user_id, credential_lookup, credential_id, public_key, counter,
             device_type, backed_up, authenticator_attachment, transports,
             aaguid, attestation_format, device_label, registered_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            userId,
            parsed.lookup,
            parsed.value,
            serializePublicJwk(publicKey),
            counter,
            deviceType,
            backedUp ? 1 : 0,
            authenticatorAttachment || null,
            null,
            null,
            'browser-key-v1',
            deviceLabel,
            registeredByUserId,
        ]
    );
    return findCredentialByNumericId(result.insertId, executor, true);
}

async function markCredentialUsed({ executor = pool, credentialId } = {}) {
    const [result] = await executor.query(
        `UPDATE webauthn_credentials
            SET last_used_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'active'`,
        [credentialId]
    );
    return Number(result?.affectedRows || 0) === 1;
}

function credentialPublicJwk(row) {
    return parseStoredPublicJwk(row?.public_key);
}

async function revokeCredential({ executor = pool, credentialId, revokedByUserId = null, reason } = {}) {
    const [result] = await executor.query(
        `UPDATE webauthn_credentials
            SET status = 'revoked', revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                revoked_by_user_id = COALESCE(revoked_by_user_id, ?),
                revoke_reason = COALESCE(revoke_reason, ?)
          WHERE id = ? AND status = 'active'`,
        [revokedByUserId, reason || 'revoked', credentialId]
    );
    return Number(result?.affectedRows || 0) === 1;
}

module.exports = {
    countActiveCredentials,
    listCredentials,
    findCredentialByNumericId,
    credentialPublicJwk,
    insertCredential,
    markCredentialUsed,
    revokeCredential,
    eligibleCredentialSql,
    ELIGIBLE_CREDENTIAL_SQL,
    isEligibleCredential,
};
