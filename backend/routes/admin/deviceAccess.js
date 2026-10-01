const express = require('express');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const webauthnRouter = require('../auth/webauthn');
const { parseCookies, invalidateCredentialSessions, invalidateUnboundSessions } = require('../../middleware/auth');
const { invalidateAuthModeCache, lockAuthMode, listDeviceAccess, beginEnrollment, revokeRegisteredCredential } = require('../../services/deviceAccess');
const { loadWebAuthnConfig, assertWebAuthnRuntimeReady } = require('../../services/webauthn/config');
const { createCeremony, getCeremonyForUpdate, assertPendingCeremony, finishCeremony } = require('../../services/webauthn/ceremonies');
const { eligibleCredentialSql } = require('../../services/webauthn/credentials');
const { normalizeDeviceLabel } = require('../../services/webauthn/policy');
const { findActiveSession, hasRecentDeviceVerification, revokeUserSessions } = require('../../services/staffSessions');
const { appendSecurityAuditEvent } = require('../../services/auditEvents');
const { emitDeviceAccessChanged } = require('../../services/deviceAccessEvents');

const router = express.Router();
const ENFORCE_HTTPS = process.env.ENFORCE_HTTPS === 'true';
const COOKIE_NAME = 'pos_token';

function sendError(res, error, fallback = 'Device access operation failed.') {
    const status = Number(error?.statusCode) || 500;
    const code = error?.publicCode || 'DEVICE_ACCESS_FAILED';
    const messages = {
        WEBAUTHN_STEP_UP_REQUIRED: 'Verify a registered device before changing device access.',
        WEBAUTHN_DEVICE_LIMIT_REACHED: 'This user has no free registered-device slot.',
        WEBAUTHN_REPLACEMENT_INVALID: 'The selected registered device is invalid.',
        WEBAUTHN_ENROLLMENT_PENDING: 'An enrollment is already waiting for this user.',
        WEBAUTHN_DEVICE_LABEL_INVALID: 'Enter a valid device label.',
        WEBAUTHN_CREDENTIAL_NOT_FOUND: 'Registered device not found.',
        DEVICE_AUTH_MODE_INVALID: 'That authentication mode transition is not allowed.',
        DEVICE_AUTH_PROGRAMMER_REQUIRED: 'Only the programmer can change device access enforcement.',
        DEVICE_AUTH_ORIGIN_INVALID: 'This request origin is not allowed.',
    };
    if (status >= 500) logger.error({ err: error, code }, fallback);
    return res.status(status).json({ success: false, code, message: messages[code] || fallback });
}

function assertJson(req) {
    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
        throw Object.assign(new Error('JSON is required.'), { publicCode: 'WEBAUTHN_JSON_REQUIRED', statusCode: 415 });
    }
}

function configForMode(mode) {
    const config = loadWebAuthnConfig(process.env);
    assertWebAuthnRuntimeReady({ config, mode, enforceHttps: ENFORCE_HTTPS });
    return config;
}

function assertOrigin(req, config) {
    const origin = String(req.headers.origin || '').trim();
    if (!origin || !config.expectedOrigins.includes(origin)) {
        throw Object.assign(new Error('The request origin is not allowed.'), { publicCode: 'DEVICE_AUTH_ORIGIN_INVALID', statusCode: 403 });
    }
}

async function getBoundSession(req) {
    const rawToken = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    const session = await findActiveSession(rawToken);
    if (!session?.credential_id || String(session.user_id) !== String(req.user.id)) return null;
    return { ...session, rawToken };
}

async function requireRecentStepUp(req, res, next) {
    try {
        if (req.user?.role === 'programmer') return next();
        const session = await getBoundSession(req);
        if (!session || !await hasRecentDeviceVerification(session.session_id)) {
            return sendError(res, Object.assign(new Error(), { publicCode: 'WEBAUTHN_STEP_UP_REQUIRED', statusCode: 428 }));
        }
        req.deviceAccessSession = session;
        next();
    } catch (error) {
        return sendError(res, error, 'Verify a registered device before changing device access.');
    }
}

function assertSameHostOrigin(req) {
    const origin = String(req.headers.origin || '').trim();
    const host = String(req.headers.host || '').trim().toLowerCase();
    let parsed;
    try { parsed = new URL(origin); } catch { parsed = null; }
    const allowedProtocol = parsed?.protocol === 'https:' || (!ENFORCE_HTTPS && parsed?.protocol === 'http:');
    const defaultPort = parsed?.protocol === 'https:' ? '443' : '80';
    const normalizedHost = host.endsWith(`:${defaultPort}`) ? host.slice(0, -(defaultPort.length + 1)) : host;
    if (!parsed || !allowedProtocol || parsed.host.toLowerCase() !== normalizedHost) {
        throw Object.assign(new Error('The request origin is not allowed.'), { publicCode: 'DEVICE_AUTH_ORIGIN_INVALID', statusCode: 403 });
    }
}

function requireProgrammer(req, res, next) {
    if (req.user?.role !== 'programmer') {
        return sendError(res, Object.assign(new Error(), { publicCode: 'DEVICE_AUTH_PROGRAMMER_REQUIRED', statusCode: 403 }));
    }
    next();
}

async function lockDeviceMutationMode(req, conn) {
    const mode = await lockAuthMode(conn);
    if (mode === 'disabled' && req.user?.role !== 'programmer') {
        throw Object.assign(new Error('Only the programmer can manage registered browsers while device access is disabled.'), {
            publicCode: 'DEVICE_AUTH_PROGRAMMER_REQUIRED',
            statusCode: 403,
        });
    }
    return mode;
}

router.get('/device-access', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const access = await listDeviceAccess(conn);
        if (access.mode !== 'disabled' && req.user?.role !== 'programmer' && !await getBoundSession(req)) {
            return sendError(res, Object.assign(new Error(), { publicCode: 'WEBAUTHN_STEP_UP_REQUIRED', statusCode: 401 }));
        }
        return res.json({ success: true, ...access });
    } catch (error) {
        return sendError(res, error, 'Unable to load device access.');
    } finally { conn?.release(); }
});

router.post('/device-access/enrollments', requireRecentStepUp, async (req, res) => {
    let conn;
    try {
        assertJson(req);
        const config = configForMode('staged');
        assertOrigin(req, config);
        const userId = Number(req.body?.user_id);
        const action = String(req.body?.action || 'add');
        if (!Number.isInteger(userId) || userId <= 0 || !['add', 'replace'].includes(action)) {
            throw Object.assign(new Error('Invalid enrollment request.'), { publicCode: 'DEVICE_ACCESS_INVALID', statusCode: 400 });
        }
        const label = normalizeDeviceLabel(req.body?.device_label);
        const replacementCredentialId = action === 'replace' ? Number(req.body?.replace_credential_id) : null;
        if (action === 'replace' && (!Number.isInteger(replacementCredentialId) || replacementCredentialId <= 0)) {
            throw Object.assign(new Error('Select the device to replace.'), { publicCode: 'WEBAUTHN_REPLACEMENT_INVALID', statusCode: 409 });
        }
        conn = await pool.getConnection();
        await conn.beginTransaction();
        await lockDeviceMutationMode(req, conn);
        const started = await beginEnrollment({ executor: conn, requestingUserId: req.user.id, userId, deviceLabel: label, replacementCredentialId });
        await conn.commit();
        emitDeviceAccessChanged(req);
        return res.status(201).json({
            success: true,
            enrollment_code: started.enrollmentCode,
            expires_at: started.ceremony.enrollmentExpiresAt,
            enrollment_url: `/device-enrollment#code=${encodeURIComponent(started.enrollmentCode)}`,
        });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error, 'Unable to start enrollment.');
    } finally { conn?.release(); }
});

router.post('/device-access/enrollments/:id/approve', requireRecentStepUp, async (req, res) => {
    let conn;
    try {
        assertJson(req);
        const config = configForMode('staged');
        assertOrigin(req, config);
        conn = await pool.getConnection();
        await conn.beginTransaction();
        await lockDeviceMutationMode(req, conn);
        const ceremony = await getCeremonyForUpdate(req.params.id, conn);
        assertPendingCeremony(ceremony, 'enrollment_registration');
        if (ceremony.enrollment_expires_at != null || ceremony.requesting_user_id != null || !ceremony.enrollment_token_hash) {
            throw Object.assign(new Error('This browser approval request is invalid.'), { publicCode: 'DEVICE_ACCESS_INVALID', statusCode: 409 });
        }
        const [result] = await conn.query(
            `UPDATE webauthn_ceremonies SET requesting_user_id=?
              WHERE id=? AND terminal_state='pending' AND requesting_user_id IS NULL`,
            [req.user.id, ceremony.id]
        );
        if (Number(result?.affectedRows || 0) !== 1) {
            throw Object.assign(new Error('This browser approval request is no longer available.'), { publicCode: 'DEVICE_ACCESS_INVALID', statusCode: 409 });
        }
        await appendSecurityAuditEvent(conn, {
            eventType: 'device_enrollment_approved',
            userId: req.user.id,
            entityType: 'webauthn_ceremony',
            entityId: null,
            newValue: { request_id: ceremony.id, target_user_id: ceremony.user_id, device_label: ceremony.intended_device_label },
            ipAddress: req.ip || null,
        });
        await conn.commit();
        // The waiting register settles its pending approval on this event instead of polling.
        req.io?.to(`user:${ceremony.user_id}`).emit('device_request_changed', { request_id: ceremony.id });
        emitDeviceAccessChanged(req);
        return res.json({ success: true });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error, 'Unable to approve browser.');
    } finally { conn?.release(); }
});

router.delete('/device-access/enrollments/:id', requireRecentStepUp, async (req, res) => {
    let conn;
    try {
        assertJson(req);
        const config = configForMode('staged');
        assertOrigin(req, config);
        conn = await pool.getConnection();
        await conn.beginTransaction();
        await lockDeviceMutationMode(req, conn);
        const ceremony = await getCeremonyForUpdate(req.params.id, conn);
        assertPendingCeremony(ceremony, 'enrollment_registration');
        await finishCeremony(ceremony.id, 'cancelled', conn);
        await appendSecurityAuditEvent(conn, {
            eventType: 'device_enrollment_cancelled',
            userId: req.user.id,
            entityType: 'webauthn_ceremony',
            entityId: null,
            newValue: { target_user_id: ceremony.user_id },
            ipAddress: req.ip || null,
        });
        await conn.commit();
        req.io?.to(`user:${ceremony.user_id}`).emit('device_request_changed', { request_id: ceremony.id });
        emitDeviceAccessChanged(req);
        return res.json({ success: true });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error, 'Unable to cancel enrollment.');
    } finally { conn?.release(); }
});

router.post('/device-access/credentials/:id/revoke', requireRecentStepUp, async (req, res) => {
    let conn;
    try {
        assertJson(req);
        const config = configForMode('staged');
        assertOrigin(req, config);
        const reason = String(req.body?.reason || '').trim();
        if (reason.length < 3 || reason.length > 255) throw Object.assign(new Error('A reason is required.'), { publicCode: 'DEVICE_ACCESS_INVALID', statusCode: 400 });
        conn = await pool.getConnection();
        await conn.beginTransaction();
        await lockDeviceMutationMode(req, conn);
        const [[target]] = await conn.query(
            `SELECT c.id, c.user_id, c.status, c.device_type, c.backed_up,
                    c.authenticator_attachment, u.role, u.is_active
               FROM webauthn_credentials c JOIN users u ON u.id = c.user_id
              WHERE c.id = ? LIMIT 1 FOR UPDATE`,
            [req.params.id]
        );
        if (!target || target.status !== 'active') throw Object.assign(new Error('Registered device not found.'), { publicCode: 'WEBAUTHN_CREDENTIAL_NOT_FOUND', statusCode: 404 });
        const credential = await revokeRegisteredCredential({ executor: conn, actorUserId: req.user.id, credentialId: req.params.id, reason, ipAddress: req.ip || null });
        await conn.commit();
        invalidateCredentialSessions(credential.id);
        if (req.io) req.io.to(`credential:${credential.id}`).disconnectSockets(true);
        emitDeviceAccessChanged(req);
        return res.json({ success: true });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error, 'Unable to revoke registered device.');
    } finally { conn?.release(); }
});

router.post('/device-access/mode', requireProgrammer, async (req, res) => {
    let conn;
    try {
        assertJson(req);
        const nextMode = String(req.body?.mode || '');
        if (!['disabled', 'enforced'].includes(nextMode)) {
            throw Object.assign(new Error('That authentication mode transition is not allowed.'), { publicCode: 'DEVICE_AUTH_MODE_INVALID', statusCode: 409 });
        }
        if (nextMode === 'enforced') {
            const config = configForMode('enforced');
            assertOrigin(req, config);
        } else {
            // The programmer's recovery switch must still work when the
            // WebAuthn origin configuration itself is what needs recovery.
            assertSameHostOrigin(req);
        }
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const previousMode = await lockAuthMode(conn);
        if (previousMode === nextMode) {
            await conn.commit();
            return res.json({ success: true, mode: nextMode });
        }
        if (nextMode === 'disabled') {
            await conn.query(`UPDATE settings SET setting_value='disabled' WHERE setting_key='staff_device_auth_mode'`);
            await appendSecurityAuditEvent(conn, { eventType: 'device_auth_mode_changed', userId: req.user.id, entityType: 'setting', entityId: null, oldValue: { mode: previousMode }, newValue: { mode: 'disabled' }, ipAddress: req.ip || null });
            await conn.commit();
            invalidateAuthModeCache();
            emitDeviceAccessChanged(req);
            return res.json({ success: true, mode: 'disabled' });
        }
        const [unboundSessions] = await conn.query(
            `SELECT s.id FROM auth_sessions s
              JOIN users u ON u.id=s.user_id
             WHERE s.credential_id IS NULL AND s.revoked_at IS NULL AND u.role <> 'programmer'
               AND EXISTS (
                    SELECT 1 FROM webauthn_credentials required_credential
                     WHERE required_credential.user_id = s.user_id
                       AND ${eligibleCredentialSql('required_credential')}
               )
             FOR UPDATE`
        );
        await conn.query(`UPDATE settings SET setting_value='enforced' WHERE setting_key='staff_device_auth_mode'`);
        if (unboundSessions.length > 0) {
            await conn.query(`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP), revoke_reason=COALESCE(revoke_reason,'device_auth_enforced') WHERE id IN (?)`, [unboundSessions.map((session) => session.id)]);
        }
        await appendSecurityAuditEvent(conn, { eventType: 'device_auth_mode_changed', userId: req.user.id, entityType: 'setting', entityId: null, oldValue: { mode: previousMode }, newValue: { mode: 'enforced' }, ipAddress: req.ip || null });
        await conn.commit();
        invalidateAuthModeCache();
        invalidateUnboundSessions();
        if (req.io) for (const session of unboundSessions) req.io.to(`session:${session.id}`).disconnectSockets(true);
        emitDeviceAccessChanged(req);
        return res.json({ success: true, mode: 'enforced' });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error, 'Unable to change device access mode.');
    } finally { conn?.release(); }
});

// The bootstrap exception is still guarded by the parent admin router and by
// the existing admin-session + high-entropy-secret checks in the WebAuthn auth router.
router.use('/device-access', webauthnRouter);

module.exports = router;
