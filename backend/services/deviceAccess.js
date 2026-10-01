const pool = require('../config/db');
const { createCeremony, randomOpaque, hashOpaque, getCeremonyForUpdate, assertPendingCeremony, finishCeremony } = require('./webauthn/ceremonies');
const { countActiveCredentials, listCredentials, findCredentialByNumericId, insertCredential, revokeCredential, ELIGIBLE_CREDENTIAL_SQL, isEligibleCredential } = require('./webauthn/credentials');
const { assertRoleCapacity, normalizeDeviceLabel, isPrivilegedRole, maxCredentialsForRole, safeCredentialSummary } = require('./webauthn/policy');
const { newCredentialId, normalizePublicJwk, serializePublicJwk } = require('./browserDeviceCrypto');
const { revokeCredentialSessions, revokeUserSessions } = require('./staffSessions');
const { appendSecurityAuditEvent } = require('./auditEvents');

const MODE_VALUES = new Set(['disabled', 'staged', 'enforced']);
const AUTH_MODE_CACHE_TTL_MS = 5000;
let authModeGeneration = 0;
let cachedAuthMode = null;
let cachedAuthModeUntil = 0;
let authModeReadInFlight = null;

async function queryAuthMode(executor) {
    const [[row]] = await executor.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode' LIMIT 1");
    return MODE_VALUES.has(row?.setting_value) ? row.setting_value : 'disabled';
}

async function lockAuthMode(executor) {
    const [[row]] = await executor.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode' LIMIT 1 FOR UPDATE");
    return MODE_VALUES.has(row?.setting_value) ? row.setting_value : 'disabled';
}

async function readAuthMode(executor = pool) {
    if (executor !== pool) return queryAuthMode(executor);
    if (cachedAuthMode && Date.now() < cachedAuthModeUntil) return cachedAuthMode;
    if (authModeReadInFlight) return authModeReadInFlight;
    const generation = authModeGeneration;
    const pending = queryAuthMode(pool)
        .then(mode => {
            if (generation === authModeGeneration) {
                cachedAuthMode = mode;
                cachedAuthModeUntil = Date.now() + AUTH_MODE_CACHE_TTL_MS;
            }
            return mode;
        })
        .finally(() => {
            if (authModeReadInFlight === pending) authModeReadInFlight = null;
        });
    authModeReadInFlight = pending;
    return pending;
}

function invalidateAuthModeCache() {
    authModeGeneration += 1;
    cachedAuthMode = null;
    cachedAuthModeUntil = 0;
    authModeReadInFlight = null;
}

async function readBootstrapConsumed(executor = pool) {
    const [[row]] = await executor.query("SELECT setting_value FROM settings WHERE setting_key='webauthn_bootstrap_consumed' LIMIT 1");
    return row?.setting_value === '1';
}

async function getActiveUser(userId, executor = pool, forUpdate = false) {
    const [rows] = await executor.query(
        `SELECT id, user_number, name, role, is_active, allowed_sections, table_access_scope, webauthn_user_handle
           FROM users WHERE id = ? AND is_active = 1 AND role <> 'programmer' LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
        [userId]
    );
    return rows[0] || null;
}

async function getUserByNumber(userNumber, executor = pool) {
    const [rows] = await executor.query(
        `SELECT id, user_number, name, role, is_active, allowed_sections, table_access_scope, webauthn_user_handle
           FROM users WHERE user_number = ? AND is_active = 1 AND role <> 'programmer' LIMIT 1`,
        [String(userNumber || '').trim()]
    );
    return rows[0] || null;
}

async function listDeviceAccess(executor = pool) {
    const mode = await readAuthMode(executor);
    const bootstrapConsumed = await readBootstrapConsumed(executor);
    const [users] = await executor.query(
        `SELECT id, name, role, user_number, is_active
           FROM users WHERE is_active = 1 AND role <> 'programmer' ORDER BY role, name, id`
    );
    const result = [];
    for (const user of users) {
        const [credentials] = await executor.query(
            `SELECT id, device_label, status, device_type, backed_up,
                    authenticator_attachment, transports, registered_at, last_used_at,
                    revoked_at, revoke_reason
               FROM webauthn_credentials WHERE user_id = ?
              ORDER BY status = 'active' DESC, registered_at ASC, id ASC`,
            [user.id]
        );
        const [pending] = await executor.query(
            `SELECT id, intended_device_label, requesting_user_id, enrollment_expires_at,
                    COALESCE(enrollment_expires_at, expires_at) AS expires_at
               FROM webauthn_ceremonies
              WHERE user_id = ? AND flow IN ('enrollment_registration','bootstrap_registration')
                AND terminal_state = 'pending' AND expires_at > CURRENT_TIMESTAMP
                AND (enrollment_expires_at IS NOT NULL OR enrollment_token_hash IS NOT NULL)
              ORDER BY issued_at DESC LIMIT 1`,
            [user.id]
        );
        const activeCount = credentials.filter(isEligibleCredential).length;
        const [[sessionCount]] = await executor.query(
            `SELECT COUNT(*) AS count
               FROM auth_sessions
              WHERE user_id = ? AND revoked_at IS NULL
                AND idle_expires_at > CURRENT_TIMESTAMP
                AND absolute_expires_at > CURRENT_TIMESTAMP`,
            [user.id]
        );
        result.push({
            ...user,
            device_limit: maxCredentialsForRole(user.role),
            active_device_count: activeCount,
            credentials: credentials.map(safeCredentialSummary),
            pending_enrollment: pending[0] ? {
                id: pending[0].id,
                device_label: pending[0].intended_device_label,
                expires_at: pending[0].expires_at,
                browser_requested: pending[0].enrollment_expires_at == null,
                approved: pending[0].requesting_user_id != null,
            } : null,
            active_session_count: Number(sessionCount?.count || 0),
        });
    }
    return { mode, bootstrap_consumed: bootstrapConsumed, users: result };
}

async function beginEnrollment({ executor = pool, requestingUserId, userId, deviceLabel, replacementCredentialId = null } = {}) {
    const label = normalizeDeviceLabel(deviceLabel);
    const user = await getActiveUser(userId, executor, true);
    if (!user) throw Object.assign(new Error('User not found.'), { publicCode: 'WEBAUTHN_USER_NOT_FOUND', statusCode: 404 });
    const activeCount = await countActiveCredentials(user.id, executor, true);
    assertRoleCapacity(user.role, activeCount, replacementCredentialId != null);
    if (replacementCredentialId != null) {
        const old = await findCredentialByNumericId(replacementCredentialId, executor, true);
        if (!old || old.user_id !== user.id || !isEligibleCredential(old)) {
            throw Object.assign(new Error('The selected registered device is invalid.'), { publicCode: 'WEBAUTHN_REPLACEMENT_INVALID', statusCode: 409 });
        }
    }
    const [[pendingCount]] = await executor.query(
        `SELECT COUNT(*) AS count
           FROM webauthn_ceremonies
          WHERE user_id = ?
            AND flow = 'enrollment_registration'
            AND terminal_state = 'pending'
            AND expires_at > CURRENT_TIMESTAMP`,
        [user.id]
    );
    if (Number(pendingCount?.count || 0) >= 1) {
        throw Object.assign(new Error('An enrollment is already waiting for this user.'), { publicCode: 'WEBAUTHN_ENROLLMENT_PENDING', statusCode: 409 });
    }
    const token = randomOpaque(20);
    const ceremony = await createCeremony({
        executor,
        flow: 'enrollment_registration',
        userId: user.id,
        requestingUserId,
        replacementCredentialId,
        enrollmentToken: token,
        intendedDeviceLabel: label,
    });
    return { user, ceremony, enrollmentCode: token };
}

async function beginBootstrap({ executor = pool, userId, deviceLabel, bootstrapSecret } = {}) {
    const label = normalizeDeviceLabel(deviceLabel);
    if (await lockAuthMode(executor) !== 'disabled') {
        throw Object.assign(new Error('Bootstrap is unavailable.'), { publicCode: 'WEBAUTHN_BOOTSTRAP_UNAVAILABLE', statusCode: 409 });
    }
    const user = await getActiveUser(userId, executor, true);
    if (!user || !isPrivilegedRole(user.role)) {
        throw Object.assign(new Error('Bootstrap is unavailable.'), { publicCode: 'WEBAUTHN_BOOTSTRAP_UNAVAILABLE', statusCode: 400 });
    }
    // The options route runs this inside a transaction. Lock the singleton
    // setting so two simultaneous bootstrap starts cannot both pass the
    // one-time check and create competing ceremonies.
    const [[bootstrapSetting]] = await executor.query(
        "SELECT setting_value FROM settings WHERE setting_key='webauthn_bootstrap_consumed' LIMIT 1 FOR UPDATE"
    );
    if (bootstrapSetting?.setting_value === '1') {
        throw Object.assign(new Error('Bootstrap is unavailable.'), { publicCode: 'WEBAUTHN_BOOTSTRAP_CONSUMED', statusCode: 409 });
    }
    const [[pending]] = await executor.query(
        `SELECT COUNT(*) AS count
           FROM webauthn_ceremonies
          WHERE flow = 'bootstrap_registration'
            AND terminal_state = 'pending'
            AND expires_at > CURRENT_TIMESTAMP`
    );
    if (Number(pending?.count || 0) > 0) {
        throw Object.assign(new Error('Bootstrap is already waiting for verification.'), { publicCode: 'WEBAUTHN_BOOTSTRAP_PENDING', statusCode: 409 });
    }
    const token = String(bootstrapSecret || '');
    if (!token) throw Object.assign(new Error('Bootstrap is unavailable.'), { publicCode: 'WEBAUTHN_BOOTSTRAP_INVALID', statusCode: 400 });
    const ceremony = await createCeremony({
        executor,
        flow: 'bootstrap_registration',
        userId: user.id,
        requestingUserId: user.id,
        enrollmentToken: token,
        intendedDeviceLabel: label,
    });
    return { user, ceremony };
}

async function completeRegistration({
    executor,
    ceremony,
    publicKey,
    actorUserId = null,
    ipAddress = null,
} = {}) {
    const normalizedPublicKey = normalizePublicJwk(publicKey);
    const deviceAuthMode = await lockAuthMode(executor);
    if (ceremony.flow === 'bootstrap_registration') {
        if (deviceAuthMode !== 'disabled') {
            throw Object.assign(new Error('Bootstrap is unavailable.'), { publicCode: 'WEBAUTHN_BOOTSTRAP_UNAVAILABLE', statusCode: 409 });
        }
    } else if (deviceAuthMode === 'disabled') {
        const [[requestingUser]] = await executor.query(
            'SELECT role, is_active FROM users WHERE id=? LIMIT 1',
            [ceremony.requesting_user_id]
        );
        if (requestingUser?.role !== 'programmer' || Number(requestingUser.is_active) !== 1) {
            throw Object.assign(new Error('Only the programmer can manage registered browsers while device access is disabled.'), {
                publicCode: 'DEVICE_AUTH_PROGRAMMER_REQUIRED',
                statusCode: 403,
            });
        }
    }
    const user = await getActiveUser(ceremony.user_id, executor, true);
    if (!user) throw Object.assign(new Error('The enrollment target is no longer active.'), { publicCode: 'WEBAUTHN_USER_NOT_FOUND', statusCode: 409 });
    const replacing = ceremony.replacement_credential_id != null;
    let revokedCredentialIds = [];
    const [activeCredentials] = await executor.query(
        `SELECT id, public_key FROM webauthn_credentials WHERE user_id=? AND ${ELIGIBLE_CREDENTIAL_SQL} FOR UPDATE`,
        [user.id]
    );
    const activeCount = activeCredentials.length;
    let revokedUnboundSessionIds = [];
    assertRoleCapacity(user.role, activeCount, replacing);
    const canonicalPublicKey = serializePublicJwk(normalizedPublicKey);
    const duplicate = activeCredentials.find((credential) => Buffer.from(credential.public_key).equals(canonicalPublicKey));
    const replacesDuplicate = replacing && Number(duplicate?.id) === Number(ceremony.replacement_credential_id);
    if (duplicate && !replacesDuplicate) {
        throw Object.assign(new Error('This browser is already registered for this user.'), {
            publicCode: 'BROWSER_DEVICE_ALREADY_REGISTERED',
            statusCode: 409,
        });
    }

    if (ceremony.flow === 'bootstrap_registration') {
        const [[bootstrapSetting]] = await executor.query(
            "SELECT setting_value FROM settings WHERE setting_key='webauthn_bootstrap_consumed' LIMIT 1 FOR UPDATE"
        );
        if (bootstrapSetting?.setting_value === '1') {
            throw Object.assign(new Error('Bootstrap is unavailable.'), { publicCode: 'WEBAUTHN_BOOTSTRAP_CONSUMED', statusCode: 409 });
        }
    }
    if (replacing) {
        const old = await findCredentialByNumericId(ceremony.replacement_credential_id, executor, true);
        if (!old || old.user_id !== user.id || !isEligibleCredential(old)) {
            throw Object.assign(new Error('The selected registered device is invalid.'), { publicCode: 'WEBAUTHN_REPLACEMENT_INVALID', statusCode: 409 });
        }
    }

    const credential = await insertCredential({
        executor,
        userId: user.id,
        credentialId: newCredentialId(),
        publicKey: normalizedPublicKey,
        deviceLabel: ceremony.intended_device_label,
        registeredByUserId: actorUserId || ceremony.requesting_user_id || user.id,
    });
    if (activeCount === 0 && deviceAuthMode !== 'disabled' && user.role !== 'programmer') {
        const [unboundSessions] = await executor.query(
            `SELECT id FROM auth_sessions
              WHERE user_id = ? AND credential_id IS NULL AND revoked_at IS NULL
              FOR UPDATE`,
            [user.id]
        );
        revokedUnboundSessionIds = unboundSessions.map(({ id }) => id);
        if (revokedUnboundSessionIds.length > 0) {
            await executor.query(
                `UPDATE auth_sessions
                    SET revoked_at = CURRENT_TIMESTAMP,
                        revoke_reason = COALESCE(revoke_reason, 'device_registered')
                  WHERE id IN (?) AND revoked_at IS NULL`,
                [revokedUnboundSessionIds]
            );
        }
    }
    if (replacing) {
        await revokeCredential({ executor, credentialId: ceremony.replacement_credential_id, revokedByUserId: actorUserId, reason: 'replaced' });
        await revokeCredentialSessions(ceremony.replacement_credential_id, 'credential_replaced', executor);
        revokedCredentialIds.push(Number(ceremony.replacement_credential_id));
    }
    await finishCeremony(ceremony.id, 'consumed', executor);
    if (ceremony.flow === 'bootstrap_registration') {
        await executor.query("UPDATE settings SET setting_value='1' WHERE setting_key='webauthn_bootstrap_consumed'");
    }
    const eventType = replacing ? 'device_credential_replaced' : 'device_credential_registered';
    await appendSecurityAuditEvent(executor, {
        eventType,
        userId: actorUserId || user.id,
        entityType: 'webauthn_credential',
        entityId: credential.id,
        newValue: { user_id: user.id, device_label: ceremony.intended_device_label, replacement: replacing },
        ipAddress,
    });
    return { user, credential, replacedCredentialId: replacing ? ceremony.replacement_credential_id : null, revokedCredentialIds, revokedUnboundSessionIds, deviceAuthMode };
}

async function revokeRegisteredCredential({ executor = pool, actorUserId, credentialId, reason, ipAddress = null } = {}) {
    const credential = await findCredentialByNumericId(credentialId, executor, true);
    if (!credential || credential.status !== 'active') {
        throw Object.assign(new Error('Registered device not found.'), { publicCode: 'WEBAUTHN_CREDENTIAL_NOT_FOUND', statusCode: 404 });
    }
    await revokeCredential({ executor, credentialId, revokedByUserId: actorUserId, reason });
    await revokeCredentialSessions(credentialId, 'credential_revoked', executor);
    await appendSecurityAuditEvent(executor, {
        eventType: 'device_credential_revoked',
        userId: actorUserId,
        entityType: 'webauthn_credential',
        entityId: credentialId,
        newValue: { reason: String(reason || 'revoked').slice(0, 255), target_user_id: credential.user_id },
        ipAddress,
    });
    return credential;
}

module.exports = {
    MODE_VALUES,
    AUTH_MODE_CACHE_TTL_MS,
    readAuthMode,
    lockAuthMode,
    invalidateAuthModeCache,
    readBootstrapConsumed,
    getActiveUser,
    getUserByNumber,
    listDeviceAccess,
    beginEnrollment,
    beginBootstrap,
    completeRegistration,
    revokeRegisteredCredential,
};
