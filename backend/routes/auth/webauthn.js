const express = require('express');
const crypto = require('crypto');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { requireAuth, requireAdmin, invalidateToken, invalidateCredentialSessions, invalidateUserUnboundSessions, parseCookies, preWarmToken } = require('../../middleware/auth');
const { loadWebAuthnConfig, assertWebAuthnRuntimeReady, verifyBootstrapSecret } = require('../../services/webauthn/config');
const { readAuthMode, lockAuthMode, invalidateAuthModeCache, getUserByNumber, getActiveUser, beginBootstrap, completeRegistration } = require('../../services/deviceAccess');
const { createCeremony, getCeremony, getCeremonyForUpdate, assertPendingCeremony, recordCeremonyAttempt, finishCeremony, hashOpaque, constantTimeOpaqueHashEquals, ENROLLMENT_TTL_MS } = require('../../services/webauthn/ceremonies');
const { countActiveCredentials, findCredentialByNumericId, credentialPublicJwk, markCredentialUsed, ELIGIBLE_CREDENTIAL_SQL } = require('../../services/webauthn/credentials');
const { assertRoleCapacity, normalizeDeviceLabel } = require('../../services/webauthn/policy');
const { buildDeviceProofMessage, normalizePublicJwk, publicKeyFingerprint, verifyDeviceProof } = require('../../services/browserDeviceCrypto');
const { createSession, findActiveSession, markDeviceVerified, revokeSessionByToken } = require('../../services/staffSessions');
const { loadUserPermissions } = require('../../services/PermissionService');
const { emitDeviceAccessChanged } = require('../../services/deviceAccessEvents');
const { appendSecurityAuditEvent } = require('../../services/auditEvents');
const { COOKIE_NAME, setSessionCookie } = require('../../services/sessionCookies');
const { isReservedOrderIntakeActor } = require('../../modules/orderIntake/config');

const router = express.Router();
const ENFORCE_HTTPS = process.env.ENFORCE_HTTPS === 'true';

function publicError(code, statusCode, message) {
    return Object.assign(new Error(message || code), { publicCode: code, statusCode });
}

const loginAuthenticationFailed = () => publicError(
    'WEBAUTHN_AUTHENTICATION_FAILED', 401, 'This browser is not registered for this user.'
);

const usableAuthenticationCeremony = ceremony => ceremony &&
    ceremony.flow === 'authentication' &&
    ceremony.terminal_state === 'pending' &&
    new Date(ceremony.expires_at).getTime() > Date.now() &&
    Number(ceremony.attempt_count) === 0;

function requestOrigin(req) {
    return String(req.headers.origin || '').trim();
}

function assertExactOrigin(req, config) {
    const origin = requestOrigin(req);
    if (!origin || !config.expectedOrigins.includes(origin)) throw publicError('WEBAUTHN_ORIGIN_INVALID', 403, 'The request origin is not allowed.');
    return origin;
}

function assertJsonRequest(req) {
    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) throw publicError('WEBAUTHN_JSON_REQUIRED', 415, 'JSON is required.');
}

function runtimeConfig(mode) {
    const config = loadWebAuthnConfig(process.env);
    assertWebAuthnRuntimeReady({ config, mode, enforceHttps: ENFORCE_HTTPS });
    return config;
}

function clearSensitiveBody(body = {}) {
    return {
        ceremony_id: String(body.ceremony_id || '').trim(),
        code: String(body.code || body.enrollment_code || '').trim(),
        secret: String(body.secret || body.bootstrap_secret || ''),
        signature: String(body.signature || '').trim(),
        public_key: body.public_key,
        user_number: String(body.user_number || '').trim(),
        device_label: String(body.device_label || '').trim(),
        request_id: String(body.request_id || '').trim(),
    };
}

function proofSubject(ceremony) {
    const challenge = Buffer.from(ceremony.challenge).toString('base64url');
    return hashOpaque(`posapp-device-subject-v2:${ceremony.id}:${challenge}`);
}

function proofMessage(ceremony, origin) {
    return buildDeviceProofMessage({
        action: ceremony.flow,
        origin,
        ceremonyId: ceremony.id,
        subject: proofSubject(ceremony),
        challenge: Buffer.from(ceremony.challenge).toString('base64url'),
    });
}

async function currentBoundSession(req) {
    const rawToken = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    const session = await findActiveSession(rawToken);
    return session?.credential_id ? { ...session, rawToken } : null;
}

async function currentSession(req, executor = pool, { forUpdate = false } = {}) {
    const rawToken = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    const session = await findActiveSession(rawToken, executor, { forUpdate });
    return session ? { ...session, rawToken } : null;
}

async function requireUnboundEnrollmentSession(req, executor = pool, { forUpdate = false } = {}) {
    let mode;
    if (forUpdate) {
        mode = await lockAuthMode(executor);
    } else {
        mode = await readAuthMode();
    }
    if (mode !== 'staged' && mode !== 'enforced') throw publicError('BROWSER_DEVICE_REQUEST_UNAVAILABLE', 409, 'Browser approval requests are unavailable while device access is disabled.');
    const session = await currentSession(req, executor, { forUpdate });
    if (!session || session.credential_id || String(session.user_id) !== String(req.user.id)) {
        throw publicError('BROWSER_DEVICE_REQUEST_INVALID', 401, 'This browser approval request is no longer available.');
    }
    return session;
}

async function findMatchingCredential({ userId, signature, message, executor, exactCredentialId = null }) {
    const params = [userId];
    let exactSql = '';
    if (exactCredentialId != null) {
        exactSql = ' AND id = ?';
        params.push(exactCredentialId);
    }
    const [credentials] = await executor.query(
        `SELECT * FROM webauthn_credentials
          WHERE user_id = ? AND ${ELIGIBLE_CREDENTIAL_SQL}${exactSql}
          ORDER BY id FOR UPDATE`,
        params
    );
    for (const credential of credentials) {
        let publicJwk;
        try { publicJwk = credentialPublicJwk(credential); } catch { continue; }
        if (verifyDeviceProof({ publicJwk, message, signature })) return credential;
    }
    return null;
}

function verifyRegistrationProof(body, ceremony, origin) {
    const publicJwk = normalizePublicJwk(body.public_key);
    if (!verifyDeviceProof({ publicJwk, message: proofMessage(ceremony, origin), signature: body.signature })) {
        throw publicError('WEBAUTHN_REGISTRATION_INVALID', 401, 'The browser-device proof was rejected.');
    }
    return publicJwk;
}

function evictRevokedCredentialAccess(req, credentialIds = []) {
    for (const credentialId of [...new Set(credentialIds.filter(Boolean).map(Number))]) {
        invalidateCredentialSessions(credentialId);
        if (req.io) req.io.to(`credential:${credentialId}`).disconnectSockets(true);
    }
}

function evictRevokedUnboundAccess(req, userId, sessionIds = []) {
    invalidateUserUnboundSessions(userId);
    if (req.io) {
        for (const sessionId of [...new Set(sessionIds.filter(Boolean))]) {
            req.io.to(`session:${sessionId}`).disconnectSockets(true);
        }
    }
}

async function findEnrollmentCeremony(code, executor = pool) {
    const [rows] = await executor.query(
        `SELECT * FROM webauthn_ceremonies
          WHERE enrollment_token_hash = ? AND flow = 'enrollment_registration'
            AND terminal_state = 'pending' AND enrollment_expires_at > CURRENT_TIMESTAMP
          ORDER BY issued_at DESC LIMIT 1`,
        [hashOpaque(code)]
    );
    return rows[0] || null;
}

async function finishFailedAttempt(conn, ceremony) {
    if (!conn) return;
    try {
        if (ceremony?.id) await finishCeremony(ceremony.id, 'failed', conn);
        await conn.commit();
    } catch { await conn.rollback().catch(() => {}); }
}

function sendError(res, error, fallback = 'Device verification failed.') {
    const status = Number(error?.statusCode) || 500;
    const code = error?.publicCode || 'WEBAUTHN_FAILED';
    const messages = {
        WEBAUTHN_CEREMONY_INVALID: 'The verification request is invalid or expired.',
        WEBAUTHN_CEREMONY_EXPIRED: 'The verification request is invalid or expired.',
        WEBAUTHN_CEREMONY_REPLAYED: 'The verification request is no longer available.',
        WEBAUTHN_CONFIG_REQUIRED: 'Registered-device access is not configured on this server.',
        WEBAUTHN_CONFIG_INVALID: 'Registered-device access is not configured correctly.',
        WEBAUTHN_HTTPS_REQUIRED: 'Registered-device access requires a stable HTTPS origin.',
        WEBAUTHN_DEVICE_LIMIT_REACHED: 'This user has no free registered-device slot.',
        WEBAUTHN_BOOTSTRAP_UNAVAILABLE: 'Bootstrap is unavailable.',
        WEBAUTHN_BOOTSTRAP_CONSUMED: 'Bootstrap is unavailable.',
        WEBAUTHN_BOOTSTRAP_INVALID: 'Bootstrap is unavailable.',
        WEBAUTHN_BOOTSTRAP_PENDING: 'Bootstrap is already waiting for verification.',
        WEBAUTHN_DEVICE_LABEL_INVALID: 'Enter a valid device label.',
        BROWSER_DEVICE_PUBLIC_KEY_INVALID: 'This browser could not create a valid device key.',
        BROWSER_DEVICE_PROOF_INVALID: 'The browser-device proof is invalid.',
        BROWSER_DEVICE_ALREADY_REGISTERED: 'This browser is already registered for this user.',
        WEBAUTHN_DISABLED: 'Registered-device access is disabled.',
        WEBAUTHN_JSON_REQUIRED: 'This action requires a JSON request.',
        WEBAUTHN_ORIGIN_INVALID: 'This request origin is not allowed.',
        WEBAUTHN_AUTHENTICATION_FAILED: 'This browser is not registered for this user.',
        WEBAUTHN_REGISTRATION_INVALID: 'This browser could not be registered.',
        WEBAUTHN_ENROLLMENT_INVALID: 'Enrollment code is invalid or expired.',
        WEBAUTHN_STEP_UP_REQUIRED: 'Verify the registered browser before changing device access.',
        WEBAUTHN_STEP_UP_INVALID: 'Browser verification failed.',
        BROWSER_DEVICE_REQUEST_UNAVAILABLE: 'Browser approval requests are unavailable while device access is disabled.',
        BROWSER_DEVICE_REQUEST_INVALID: 'This browser approval request is no longer available.',
        BROWSER_DEVICE_REQUEST_PENDING: 'This browser is waiting for administrator approval.',
    };
    if (status >= 500) logger.error({ err: error, code }, fallback);
    return res.status(status).json({ success: false, code, message: messages[code] || fallback });
}

router.get('/status', async (_req, res) => {
    try {
        const mode = await readAuthMode();
        if (mode === 'disabled') return res.json({ success: true, mode, supported: false });
        runtimeConfig(mode);
        return res.json({ success: true, mode, supported: true, method: 'browser-key-v1' });
    } catch (error) { return sendError(res, error, 'Registered-device access is not ready.'); }
});

router.post('/device-request/options', requireAuth, async (req, res) => {
    let conn;
    try {
        assertJsonRequest(req);
        const origin = assertExactOrigin(req, runtimeConfig('staged'));
        const label = normalizeDeviceLabel(req.body?.device_label);
        const publicKeyHash = publicKeyFingerprint(req.body?.public_key);
        conn = await pool.getConnection();
        await conn.beginTransaction();
        await requireUnboundEnrollmentSession(req, conn, { forUpdate: true });
        const user = await getActiveUser(req.user.id, conn, true);
        if (!user) throw publicError('BROWSER_DEVICE_REQUEST_INVALID', 401);
        const activeCount = await countActiveCredentials(user.id, conn, true);
        assertRoleCapacity(user.role, activeCount);
        const [pending] = await conn.query(
            `SELECT * FROM webauthn_ceremonies
              WHERE user_id=? AND flow='enrollment_registration'
                AND terminal_state='pending' AND expires_at > CURRENT_TIMESTAMP
              ORDER BY issued_at DESC FOR UPDATE`,
            [user.id]
        );
        for (const ceremony of pending) {
            if (ceremony.enrollment_expires_at != null) {
                throw publicError('WEBAUTHN_ENROLLMENT_PENDING', 409, 'An enrollment is already waiting for this user.');
            }
            if (ceremony.enrollment_token_hash === publicKeyHash) {
                await conn.query('UPDATE webauthn_ceremonies SET challenge=?, intended_device_label=?, attempt_count=0, expires_at=? WHERE id=?', [crypto.randomBytes(32), label, new Date(Date.now() + ENROLLMENT_TTL_MS), ceremony.id]);
                const resumed = await getCeremonyForUpdate(ceremony.id, conn);
                await conn.commit();
                emitDeviceAccessChanged(req);
                return res.json({ success: true, request_id: resumed.id, expires_at: resumed.expires_at, message: proofMessage(resumed, origin) });
            }
            if (ceremony.enrollment_token_hash || ceremony.requesting_user_id != null) {
                throw publicError('WEBAUTHN_ENROLLMENT_PENDING', 409, 'An enrollment is already waiting for this user.');
            }
            await finishCeremony(ceremony.id, 'cancelled', conn);
        }
        const created = await createCeremony({
            executor: conn,
            flow: 'enrollment_registration',
            userId: user.id,
            intendedDeviceLabel: label,
            ttlMs: ENROLLMENT_TTL_MS,
        });
        const ceremony = await getCeremonyForUpdate(created.id, conn);
        await conn.commit();
        return res.json({ success: true, request_id: ceremony.id, expires_at: ceremony.expires_at, message: proofMessage(ceremony, origin) });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error, 'Unable to request browser approval.');
    } finally { conn?.release(); }
});

router.post('/device-request/submit', requireAuth, async (req, res) => {
    const body = clearSensitiveBody(req.body);
    let conn;
    try {
        assertJsonRequest(req);
        const origin = assertExactOrigin(req, runtimeConfig('staged'));
        conn = await pool.getConnection();
        await conn.beginTransaction();
        await requireUnboundEnrollmentSession(req, conn, { forUpdate: true });
        const ceremony = await getCeremonyForUpdate(body.request_id, conn);
        assertPendingCeremony(ceremony, 'enrollment_registration');
        if (String(ceremony.user_id) !== String(req.user.id) || ceremony.enrollment_expires_at != null) {
            throw publicError('BROWSER_DEVICE_REQUEST_INVALID', 409);
        }
        if (ceremony.enrollment_token_hash) {
            const publicKey = verifyRegistrationProof(body, ceremony, origin);
            if (publicKeyFingerprint(publicKey) !== ceremony.enrollment_token_hash) throw publicError('BROWSER_DEVICE_REQUEST_INVALID', 409);
            await conn.commit();
            return res.json({ success: true, request_id: ceremony.id, state: ceremony.requesting_user_id == null ? 'pending' : 'approved' });
        }
        await recordCeremonyAttempt(ceremony.id, conn);
        const publicKey = verifyRegistrationProof(body, ceremony, origin);
        await conn.query('UPDATE webauthn_ceremonies SET enrollment_token_hash=? WHERE id=? AND terminal_state=\'pending\'', [publicKeyFingerprint(publicKey), ceremony.id]);
        await appendSecurityAuditEvent(conn, {
            eventType: 'device_enrollment_requested',
            userId: req.user.id,
            entityType: 'webauthn_ceremony',
            entityId: null,
            newValue: { request_id: ceremony.id, device_label: ceremony.intended_device_label },
            ipAddress: req.ip || null,
        });
        await conn.commit();
        emitDeviceAccessChanged(req);
        return res.json({ success: true, request_id: ceremony.id, state: 'pending' });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error, 'Unable to request browser approval.');
    } finally { conn?.release(); }
});

router.post('/device-request/cancel', requireAuth, async (req, res) => {
    let conn;
    try {
        assertJsonRequest(req);
        assertExactOrigin(req, runtimeConfig('staged'));
        conn = await pool.getConnection();
        await conn.beginTransaction();
        await requireUnboundEnrollmentSession(req, conn, { forUpdate: true });
        const ceremony = await getCeremonyForUpdate(String(req.body?.request_id || '').trim(), conn);
        assertPendingCeremony(ceremony, 'enrollment_registration');
        if (String(ceremony.user_id) !== String(req.user.id) || ceremony.enrollment_expires_at != null) throw publicError('BROWSER_DEVICE_REQUEST_INVALID', 409);
        await finishCeremony(ceremony.id, 'cancelled', conn);
        await appendSecurityAuditEvent(conn, { eventType: 'device_enrollment_cancelled', userId: req.user.id, entityType: 'webauthn_ceremony', entityId: null, newValue: { request_id: ceremony.id, source: 'requesting_browser' }, ipAddress: req.ip || null });
        await conn.commit();
        emitDeviceAccessChanged(req);
        return res.json({ success: true });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error, 'Unable to cancel browser approval.');
    } finally { conn?.release(); }
});

router.post('/device-request/status', requireAuth, async (req, res) => {
    try {
        assertJsonRequest(req);
        const origin = assertExactOrigin(req, runtimeConfig('staged'));
        await requireUnboundEnrollmentSession(req);
        const ceremony = await getCeremony(String(req.body?.request_id || '').trim());
        assertPendingCeremony(ceremony, 'enrollment_registration');
        if (String(ceremony.user_id) !== String(req.user.id) || ceremony.enrollment_expires_at != null || !ceremony.enrollment_token_hash) {
            throw publicError('BROWSER_DEVICE_REQUEST_INVALID', 409);
        }
        if (ceremony.requesting_user_id == null) return res.json({ success: true, state: 'pending' });
        return res.json({ success: true, state: 'approved', message: proofMessage(ceremony, origin) });
    } catch (error) {
        return sendError(res, error, 'Unable to check browser approval.');
    }
});

router.post('/device-request/complete', requireAuth, async (req, res) => {
    const body = clearSensitiveBody(req.body);
    let conn;
    let ceremony;
    let mutated = false;
    let committed = false;
    try {
        assertJsonRequest(req);
        const origin = assertExactOrigin(req, runtimeConfig('staged'));
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const oldSession = await requireUnboundEnrollmentSession(req, conn, { forUpdate: true });
        ceremony = await getCeremonyForUpdate(body.request_id, conn);
        assertPendingCeremony(ceremony, 'enrollment_registration');
        if (String(ceremony.user_id) !== String(req.user.id) || ceremony.enrollment_expires_at != null || ceremony.requesting_user_id == null || !ceremony.enrollment_token_hash) {
            throw publicError('BROWSER_DEVICE_REQUEST_INVALID', 409);
        }
        const publicKey = normalizePublicJwk(body.public_key);
        if (publicKeyFingerprint(publicKey) !== ceremony.enrollment_token_hash || !verifyDeviceProof({ publicJwk: publicKey, message: proofMessage(ceremony, origin), signature: body.signature })) {
            throw publicError('WEBAUTHN_REGISTRATION_INVALID', 401);
        }
        await recordCeremonyAttempt(ceremony.id, conn);
        mutated = true;
        const registered = await completeRegistration({ executor: conn, ceremony, publicKey, actorUserId: ceremony.requesting_user_id, ipAddress: req.ip || null });
        const session = await createSession({ executor: conn, userId: registered.user.id, credentialId: registered.credential.id, revokeCredentialId: registered.credential.id, revokeReason: 'credential_relogin', webauthnVerifiedAt: new Date() });
        registered.user.permissions = await loadUserPermissions(registered.user.id, registered.user.role, conn);
        if (registered.user.role === 'call_center') { registered.user.allowed_sections = null; registered.user.table_access_scope = 'none'; }
        await conn.commit();
        committed = true;
        const user = registered.user;
        invalidateToken(oldSession.rawToken);
        evictRevokedCredentialAccess(req, registered.revokedCredentialIds);
        evictRevokedUnboundAccess(req, registered.user.id, registered.revokedUnboundSessionIds);
        emitDeviceAccessChanged(req);
        preWarmToken(session.rawToken, user, { sessionId: session.id, credentialId: registered.credential.id, deviceAuthMode: registered.deviceAuthMode, absoluteExpiresAt: session.absoluteExpiresAt });
        setSessionCookie(res, session.rawToken, req);
        return res.json({ success: true, user: { id: user.id, name: user.name, role: user.role, permissions: user.permissions, allowed_sections: user.allowed_sections, table_access_scope: user.table_access_scope, device_auth_mode: registered.deviceAuthMode } });
    } catch (error) {
        if (conn && !committed) {
            if (mutated || !ceremony?.id) await conn.rollback().catch(() => {});
            else await finishFailedAttempt(conn, ceremony);
        }
        return sendError(res, error, 'Unable to complete browser approval.');
    } finally { conn?.release(); }
});

router.post('/login/options', async (req, res) => {
    try {
        assertJsonRequest(req);
        const mode = await readAuthMode();
        if (mode === 'disabled') throw publicError('WEBAUTHN_DISABLED', 409);
        const origin = assertExactOrigin(req, runtimeConfig(mode));
        const userNumber = String(req.body?.user_number || '').trim();
        const candidate = await getUserByNumber(userNumber);
        const user = isReservedOrderIntakeActor(candidate?.id) ? null : candidate;
        let ceremony;
        if (user) {
            // Only eligible users create rows. Two-minute expiry plus Task 5's 600/minute
            // admission gate bounds abandoned pending rows to roughly 1,200.
            const created = await createCeremony({ flow: 'authentication', userId: user.id });
            ceremony = await getCeremony(created.id, pool);
        } else {
            ceremony = { id: crypto.randomUUID(), flow: 'authentication', challenge: crypto.randomBytes(32) };
        }
        return res.json({ success: true, ceremony_id: ceremony.id, message: proofMessage(ceremony, origin) });
    } catch (error) {
        logger.warn({ code: error?.publicCode || 'DEVICE_OPTIONS_FAILED' }, 'Registered-browser authentication options failed');
        return sendError(res, error, 'Unable to start device verification.');
    }
});

router.post('/login/verify', async (req, res) => {
    const body = clearSensitiveBody(req.body);
    let conn;
    let ceremony;
    let authenticatedUser;
    let committed = false;
    try {
        assertJsonRequest(req);
        const mode = await readAuthMode();
        if (mode === 'disabled') throw publicError('WEBAUTHN_DISABLED', 409);
        const origin = assertExactOrigin(req, runtimeConfig(mode));
        conn = await pool.getConnection();
        await conn.beginTransaction();
        ceremony = await getCeremonyForUpdate(body.ceremony_id, conn);
        if (!usableAuthenticationCeremony(ceremony)) {
            await conn.rollback();
            return sendError(res, loginAuthenticationFailed());
        }
        await recordCeremonyAttempt(ceremony.id, conn);
        authenticatedUser = await getActiveUser(ceremony.user_id, conn, true);
        if (isReservedOrderIntakeActor(authenticatedUser?.id)) authenticatedUser = null;
        const credential = authenticatedUser ? await findMatchingCredential({ userId: ceremony.user_id, signature: body.signature, message: proofMessage(ceremony, origin), executor: conn }) : null;
        if (!authenticatedUser || !credential || !await markCredentialUsed({ executor: conn, credentialId: credential.id })) {
            await conn.query("DELETE FROM webauthn_ceremonies WHERE id=? AND flow='authentication'", [ceremony.id]);
            await conn.commit();
            committed = true;
            return sendError(res, loginAuthenticationFailed());
        }
        await finishCeremony(ceremony.id, 'consumed', conn);
        const session = await createSession({ executor: conn, userId: ceremony.user_id, credentialId: credential.id, revokeCredentialId: credential.id, revokeReason: 'credential_relogin', webauthnVerifiedAt: new Date() });
        authenticatedUser.permissions = await loadUserPermissions(authenticatedUser.id, authenticatedUser.role, conn);
        if (authenticatedUser.role === 'call_center') { authenticatedUser.allowed_sections = null; authenticatedUser.table_access_scope = 'none'; }
        await conn.commit();
        committed = true;
        const user = authenticatedUser;
        evictRevokedCredentialAccess(req, [credential.id]);
        preWarmToken(session.rawToken, user, { sessionId: session.id, credentialId: credential.id, deviceAuthMode: mode, absoluteExpiresAt: session.absoluteExpiresAt });
        setSessionCookie(res, session.rawToken, req);
        return res.json({ success: true, message: 'Authentication successful.', user: { id: user.id, name: user.name, role: user.role, permissions: user.permissions, allowed_sections: user.allowed_sections, table_access_scope: user.table_access_scope, device_auth_mode: mode } });
    } catch (error) {
        if (conn && !committed) await conn.rollback().catch(() => {});
        return sendError(res, error);
    } finally { conn?.release(); }
});

router.post('/bootstrap/options', requireAuth, requireAdmin, async (req, res) => {
    let conn;
    try {
        assertJsonRequest(req);
        const mode = await readAuthMode();
        const origin = assertExactOrigin(req, runtimeConfig(mode === 'disabled' ? 'staged' : mode));
        const secret = req.body?.bootstrap_secret || req.body?.secret;
        if (!verifyBootstrapSecret(secret, process.env)) throw publicError('WEBAUTHN_BOOTSTRAP_INVALID', 400);
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const started = await beginBootstrap({ executor: conn, userId: req.user.id, deviceLabel: req.body?.device_label, bootstrapSecret: secret });
        const ceremony = await getCeremonyForUpdate(started.ceremony.id, conn);
        await conn.commit();
        return res.json({ success: true, ceremony_id: ceremony.id, message: proofMessage(ceremony, origin) });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error, 'Bootstrap is unavailable.');
    } finally { conn?.release(); }
});

router.post('/bootstrap/verify', requireAuth, requireAdmin, async (req, res) => {
    const body = clearSensitiveBody(req.body);
    let conn;
    let ceremony;
    let mutated = false;
    let committed = false;
    try {
        assertJsonRequest(req);
        const origin = assertExactOrigin(req, runtimeConfig('staged'));
        if (!verifyBootstrapSecret(body.secret, process.env)) throw publicError('WEBAUTHN_BOOTSTRAP_INVALID', 400);
        conn = await pool.getConnection();
        await conn.beginTransaction();
        ceremony = await getCeremonyForUpdate(body.ceremony_id, conn);
        assertPendingCeremony(ceremony, 'bootstrap_registration');
        if (String(ceremony.requesting_user_id || '') !== String(req.user.id) || !constantTimeOpaqueHashEquals(ceremony.enrollment_token_hash, hashOpaque(body.secret))) throw publicError('WEBAUTHN_BOOTSTRAP_INVALID', 400);
        await recordCeremonyAttempt(ceremony.id, conn);
        const publicKey = verifyRegistrationProof(body, ceremony, origin);
        const currentToken = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
        const oldSession = await findActiveSession(currentToken, conn, { forUpdate: true });
        if (!oldSession) throw publicError('WEBAUTHN_BOOTSTRAP_INVALID', 401);
        mutated = true;
        const registered = await completeRegistration({ executor: conn, ceremony, publicKey, actorUserId: ceremony.user_id, ipAddress: req.ip || null });
        if (!await revokeSessionByToken(currentToken, 'bootstrap_upgrade', conn)) throw publicError('WEBAUTHN_BOOTSTRAP_INVALID', 401);
        const session = await createSession({ executor: conn, userId: ceremony.user_id, credentialId: registered.credential.id, revokeCredentialId: registered.credential.id, revokeReason: 'bootstrap_upgrade', webauthnVerifiedAt: new Date() });
        registered.user.permissions = await loadUserPermissions(registered.user.id, registered.user.role, conn);
        await conn.commit();
        committed = true;
        invalidateAuthModeCache();
        const user = registered.user;
        invalidateToken(currentToken);
        evictRevokedCredentialAccess(req, registered.revokedCredentialIds);
        evictRevokedUnboundAccess(req, registered.user.id, registered.revokedUnboundSessionIds);
        emitDeviceAccessChanged(req);
        preWarmToken(session.rawToken, user, { sessionId: session.id, credentialId: registered.credential.id, deviceAuthMode: registered.deviceAuthMode, absoluteExpiresAt: session.absoluteExpiresAt });
        setSessionCookie(res, session.rawToken, req);
        // After the response, so the admin client's one-shot reconnect already carries the new
        // cookie. 'close' also fires when the client drops the request early.
        if (req.io) res.once('close', () => req.io.to(`session:${oldSession.session_id}`).disconnectSockets(true));
        return res.json({ success: true, user: { id: user.id, name: user.name, role: user.role, permissions: user.permissions, allowed_sections: user.allowed_sections, table_access_scope: user.table_access_scope } });
    } catch (error) {
        if (conn && !committed) {
            if (mutated) await conn.rollback().catch(() => {});
            else await finishFailedAttempt(conn, ceremony);
        }
        return sendError(res, error, 'Bootstrap is unavailable.');
    } finally { conn?.release(); }
});

router.post('/enroll/options', async (req, res) => {
    try {
        assertJsonRequest(req);
        const mode = await readAuthMode();
        const origin = assertExactOrigin(req, runtimeConfig(mode === 'disabled' ? 'staged' : mode));
        const body = clearSensitiveBody(req.body);
        const ceremony = await findEnrollmentCeremony(body.code);
        if (!ceremony) throw publicError('WEBAUTHN_ENROLLMENT_INVALID', 400);
        const user = await getActiveUser(ceremony.user_id);
        if (!user) throw publicError('WEBAUTHN_ENROLLMENT_INVALID', 400);
        return res.json({ success: true, ceremony_id: ceremony.id, user: { name: user.name, role: user.role }, device_label: ceremony.intended_device_label, message: proofMessage(ceremony, origin) });
    } catch (error) { return sendError(res, error, 'Enrollment code is invalid or expired.'); }
});

router.post('/enroll/verify', async (req, res) => {
    const body = clearSensitiveBody(req.body);
    let conn;
    let ceremony;
    let mutated = false;
    let committed = false;
    try {
        assertJsonRequest(req);
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const mode = await lockAuthMode(conn);
        const origin = assertExactOrigin(req, runtimeConfig(mode === 'disabled' ? 'staged' : mode));
        ceremony = await getCeremonyForUpdate(body.ceremony_id, conn);
        assertPendingCeremony(ceremony, 'enrollment_registration');
        if (!constantTimeOpaqueHashEquals(ceremony.enrollment_token_hash, hashOpaque(body.code))) throw publicError('WEBAUTHN_ENROLLMENT_INVALID', 400);
        await recordCeremonyAttempt(ceremony.id, conn);
        const publicKey = verifyRegistrationProof(body, ceremony, origin);
        mutated = true;
        const registered = await completeRegistration({ executor: conn, ceremony, publicKey, actorUserId: ceremony.requesting_user_id, ipAddress: req.ip || null });
        await conn.commit();
        committed = true;
        evictRevokedCredentialAccess(req, registered.revokedCredentialIds);
        evictRevokedUnboundAccess(req, registered.user.id, registered.revokedUnboundSessionIds);
        emitDeviceAccessChanged(req);
        return res.json({ success: true, message: 'This browser is now registered. Return to the login screen.' });
    } catch (error) {
        if (conn && !committed) {
            if (mutated) await conn.rollback().catch(() => {});
            else await finishFailedAttempt(conn, ceremony);
        }
        return sendError(res, error, 'Enrollment failed.');
    } finally { conn?.release(); }
});

router.post('/step-up/options', requireAuth, async (req, res) => {
    try {
        assertJsonRequest(req);
        const mode = await readAuthMode();
        if (mode === 'disabled') throw publicError('WEBAUTHN_DISABLED', 409);
        const origin = assertExactOrigin(req, runtimeConfig(mode));
        const session = await currentBoundSession(req);
        if (!session || String(session.user_id) !== String(req.user.id)) throw publicError('WEBAUTHN_STEP_UP_REQUIRED', 401);
        const created = await createCeremony({ flow: 'step_up', userId: req.user.id, requestingUserId: req.user.id });
        const ceremony = await getCeremony(created.id, pool);
        return res.json({ success: true, ceremony_id: ceremony.id, message: proofMessage(ceremony, origin) });
    } catch (error) { return sendError(res, error, 'Unable to start device verification.'); }
});

router.post('/step-up/verify', requireAuth, async (req, res) => {
    const body = clearSensitiveBody(req.body);
    let conn;
    let ceremony;
    let mutated = false;
    let committed = false;
    try {
        assertJsonRequest(req);
        const mode = await readAuthMode();
        if (mode === 'disabled') throw publicError('WEBAUTHN_DISABLED', 409);
        const origin = assertExactOrigin(req, runtimeConfig(mode));
        const session = await currentBoundSession(req);
        if (!session || String(session.user_id) !== String(req.user.id)) throw publicError('WEBAUTHN_STEP_UP_REQUIRED', 401);
        conn = await pool.getConnection();
        await conn.beginTransaction();
        ceremony = await getCeremonyForUpdate(body.ceremony_id, conn);
        assertPendingCeremony(ceremony, 'step_up');
        if (String(ceremony.user_id) !== String(session.user_id)) throw publicError('WEBAUTHN_STEP_UP_INVALID', 401);
        await recordCeremonyAttempt(ceremony.id, conn);
        const credential = await findMatchingCredential({ userId: session.user_id, signature: body.signature, message: proofMessage(ceremony, origin), executor: conn, exactCredentialId: session.credential_id });
        if (!credential) throw publicError('WEBAUTHN_STEP_UP_INVALID', 401);
        mutated = true;
        await markCredentialUsed({ executor: conn, credentialId: credential.id });
        if (!await markDeviceVerified(session.session_id, conn)) throw publicError('WEBAUTHN_STEP_UP_INVALID', 401);
        await finishCeremony(ceremony.id, 'consumed', conn);
        await appendSecurityAuditEvent(conn, { eventType: 'device_step_up_verified', userId: session.user_id, entityType: 'auth_session', entityId: null, newValue: { verified: true }, ipAddress: req.ip || null });
        await conn.commit();
        committed = true;
        return res.json({ success: true, message: 'Browser verification successful.' });
    } catch (error) {
        if (conn && !committed) {
            if (mutated) await conn.rollback().catch(() => {});
            else await finishFailedAttempt(conn, ceremony);
        }
        return sendError(res, error);
    } finally { conn?.release(); }
});

module.exports = router;
module.exports.proofMessage = proofMessage;
