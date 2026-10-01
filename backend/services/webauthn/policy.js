const crypto = require('crypto');

const PRIVILEGED_ROLES = new Set(['admin', 'programmer']);
const ROLE_LIMITS = Object.freeze({
    admin: 2,
    programmer: 0,
    cashier: 1,
    waiter: 1,
    table_manager: 1,
    call_center: 1,
});

function maxCredentialsForRole(role) {
    return ROLE_LIMITS[role] || 0;
}

function isPrivilegedRole(role) {
    return PRIVILEGED_ROLES.has(String(role || ''));
}

function credentialLookup(rawCredentialId) {
    const value = Buffer.isBuffer(rawCredentialId)
        ? rawCredentialId
        : Buffer.from(String(rawCredentialId || ''), 'base64url');
    if (value.length === 0 || value.length > 1024) {
        const error = new Error('Invalid WebAuthn credential ID.');
        error.publicCode = 'WEBAUTHN_CREDENTIAL_INVALID';
        error.statusCode = 400;
        throw error;
    }
    return {
        value,
        lookup: crypto.createHash('sha256').update(value).digest(),
        encoded: value.toString('base64url'),
    };
}

function normalizeDeviceLabel(value) {
    const label = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
    if (!label || label.length > 100) {
        const error = new Error('A device label is required.');
        error.publicCode = 'WEBAUTHN_DEVICE_LABEL_INVALID';
        error.statusCode = 400;
        throw error;
    }
    return label;
}

function assertRoleCapacity(role, activeCount, replacing = false) {
    const limit = maxCredentialsForRole(role);
    if (!limit) {
        const error = new Error('Unsupported user role for registered-device access.');
        error.publicCode = 'WEBAUTHN_ROLE_UNSUPPORTED';
        error.statusCode = 409;
        throw error;
    }
    if (!replacing && Number(activeCount) >= limit) {
        const error = new Error('This user has no free registered-device slot.');
        error.publicCode = 'WEBAUTHN_DEVICE_LIMIT_REACHED';
        error.statusCode = 409;
        throw error;
    }
    return limit;
}

function safeCredentialSummary(row) {
    if (!row) return null;
    let transports = null;
    try { transports = row.transports ? JSON.parse(row.transports) : null; } catch { transports = null; }
    return {
        id: row.id,
        device_label: row.device_label,
        status: row.status,
        device_type: row.device_type,
        backed_up: Number(row.backed_up) === 1,
        authenticator_attachment: row.authenticator_attachment || null,
        transports,
        registered_at: row.registered_at,
        last_used_at: row.last_used_at,
        revoked_at: row.revoked_at,
        revoke_reason: row.revoke_reason || null,
    };
}

module.exports = {
    PRIVILEGED_ROLES,
    ROLE_LIMITS,
    maxCredentialsForRole,
    isPrivilegedRole,
    credentialLookup,
    normalizeDeviceLabel,
    assertRoleCapacity,
    safeCredentialSummary,
};
