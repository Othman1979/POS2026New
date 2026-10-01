const pool = require('../config/db');
const crypto = require('crypto');
const logger = require('../config/logger');
const PermissionService = require('../services/PermissionService');
const {
    findActiveSession,
    touchSession,
    revokeSessionByToken,
    revokeUserSessions: revokeDurableUserSessions,
    SESSION_IDLE_TIMEOUT_MS,
    SESSION_ABSOLUTE_TIMEOUT_MS,
} = require('../services/staffSessions');
const { isReservedOrderIntakeActor } = require('../modules/orderIntake/config');

const tokenCache = new Map();
const pendingVerifications = new Map();
const RETRY_VERIFICATION = Symbol('retry after session invalidation');

// The database could not answer a session check. That is not an invalid
// session: callers answer with a retryable error, because the browser logs the
// user out on 401 SESSION_* and on a socket "Unauthorized:" refusal.
class SessionCheckUnavailableError extends Error {
    constructor(cause) {
        super('Session could not be verified.', { cause });
        this.name = 'SessionCheckUnavailableError';
    }
}
let lastCleanupTime = 0;

const bcrypt = require('bcryptjs');
const BCRYPT_ROUNDS = 12;

const normalizeSessionUser = (user) => {
    if (!user) return user;
    if (isReservedOrderIntakeActor(user.id)) return null;
    const normalized = { ...user };
    if (normalized.role === 'call_center') {
        normalized.permissions = [];
        normalized.allowed_sections = null;
        normalized.table_access_scope = 'none';
    }
    return normalized;
};

// Hash a session token with SHA-256 before DB lookup
function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Hash a PIN with bcrypt. Use ONLY for admin_pin — never for session tokens.
// Session tokens use hashToken() (SHA-256) because they are already 32 random bytes.
const hashPin = (raw) => bcrypt.hash(String(raw), BCRYPT_ROUNDS);

// Verify a raw PIN against a stored hash.
// Supports both bcrypt (new) and SHA-256 (legacy migration).
// Returns: true (bcrypt match) | 'needs_rehash' (legacy SHA-256 match, caller should re-hash) | false (no match)
const verifyPin = async (raw, storedHash) => {
    if (!storedHash || !raw) return false;
    if (storedHash.startsWith('$2b$') || storedHash.startsWith('$2a$')) {
        return (await bcrypt.compare(String(raw), storedHash)) ? true : false;
    }
    // Legacy SHA-256 path — transparent migration
    const legacyHash = hashToken(String(raw));
    return legacyHash === storedHash ? 'needs_rehash' : false;
};

// Parse cookies from a Cookie header string (no external dependency needed)
function parseCookies(cookieHeader) {
    const map = {};
    if (!cookieHeader) return map;
    cookieHeader.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx > 0) map[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
    });
    return map;
}

// Clean expired cache entries — called on a 5-minute interval to prevent memory leaks
function cleanExpiredTokens() {
    const now = Date.now();
    for (const [token, data] of tokenCache.entries()) {
        if (data.expiresAt < now) tokenCache.delete(token);
    }
}

// Periodic cleanup every 5 minutes — prevents unbounded memory growth on long-running server.
// .unref() so this timer never keeps the process (or a jest/vitest worker) alive on its own.
setInterval(cleanExpiredTokens, 5 * 60 * 1000).unref();

const invalidateToken = (rawToken) => {
    if (rawToken) {
        const hash = hashToken(rawToken);
        tokenCache.delete(hash);
        pendingVerifications.delete(hash);
    }
};

/**
 * Called immediately after login to pre-warm the cache.
 * Avoids a cold-start DB hit on the very first authenticated request.
 */
const preWarmToken = (rawToken, user, session = {}) => {
    if (!rawToken || !user) return;
    const normalizedUser = normalizeSessionUser(user);
    if (!normalizedUser) return;
    const tokenHash = hashToken(rawToken);
    pendingVerifications.delete(tokenHash);
    const now = Date.now();
    const absoluteExpiresAt = session.absoluteExpiresAt instanceof Date
        ? session.absoluteExpiresAt.getTime()
        : Number(session.absoluteExpiresAt || now + SESSION_ABSOLUTE_TIMEOUT_MS);
    tokenCache.set(tokenHash, {
        user: normalizedUser,
        sessionId: session.sessionId || null,
        credentialId: session.credentialId || null,
        deviceAuthMode: session.deviceAuthMode || 'disabled',
        lastSeenAt: now,
        shiftId: null, // shiftId is updated when the user opens a shift
        expiresAt: Math.min(now + SESSION_IDLE_TIMEOUT_MS, absoluteExpiresAt),
        absoluteExpiresAt
    });
};

const setTokenShiftId = (userId, shiftId) => {
    if (!userId || !shiftId) return;
    for (const entry of tokenCache.values()) {
        if (entry.user && String(entry.user.id) === String(userId)) {
            entry.shiftId = shiftId;
        }
    }
};

/**
 * Called on shift close — immediately evicts all cache entries for that shift.
 * Ensures tokens are invalidated the moment the Z-report is filed, not up to 30 min later.
 */
const invalidateShiftTokens = (shiftId) => {
    if (!shiftId) return;
    pendingVerifications.clear();
    let evicted = 0;
    for (const [hash, entry] of tokenCache.entries()) {
        if (entry.shiftId && String(entry.shiftId) === String(shiftId)) {
            tokenCache.delete(hash);
            evicted++;
        }
    }
    if (evicted > 0) {
        logger.info({ shiftId, evicted }, 'Session cache: evicted tokens for closed shift');
    }
};

/**
 * Verify a raw session token against the database (with in-memory session cache).
 * - Cache hit: resets the sliding TTL and returns the user immediately (no DB).
 * - Cache miss: queries DB, populates cache with full SESSION_IDLE_TIMEOUT_MS TTL.
 * Shared between HTTP requireAuth middleware and Socket.IO handshake validation.
 */
const verifyTokenOnce = async (rawToken, tokenHash, isCurrent) => {
    const now = Date.now();
    const cached = tokenCache.get(tokenHash);

    if (cached && cached.expiresAt > now) {
        const cachedUser = normalizeSessionUser(cached.user);
        if (!cachedUser) {
            tokenCache.delete(tokenHash);
            return null;
        }
        // Sliding window: every cache hit resets the idle timeout
        cached.expiresAt = Math.min(now + SESSION_IDLE_TIMEOUT_MS, cached.absoluteExpiresAt || now + SESSION_ABSOLUTE_TIMEOUT_MS);
        if (cached.sessionId && now - (cached.lastSeenAt || 0) >= 60 * 1000) {
            try {
                const touched = await touchSession(cached.sessionId);
                if (!isCurrent()) return RETRY_VERIFICATION;
                if (!touched) {
                    tokenCache.delete(tokenHash);
                    return null;
                }
                cached.lastSeenAt = now;
            } catch (error) {
                if (!isCurrent()) return RETRY_VERIFICATION;
                logger.warn({ err: error }, 'verifyToken: failed to refresh durable session activity');
                throw new SessionCheckUnavailableError(error);
            }
        }
        return cachedUser;
    }

    // Cache miss or expired — fall back to DB (also covers post-deployment cold start)
    try {
        const session = await findActiveSession(rawToken);
        if (!isCurrent()) return RETRY_VERIFICATION;
        if (!session) {
            tokenCache.delete(tokenHash);
            return null;
        }

        const user = normalizeSessionUser({
            id: session.user_id,
            user_number: session.user_number,
            name: session.name,
            role: session.role,
            is_active: session.is_active,
            allowed_sections: session.allowed_sections,
            table_access_scope: session.table_access_scope,
        });
        if (!user) {
            tokenCache.delete(tokenHash);
            return null;
        }
        user.permissions = await PermissionService.loadUserPermissions(user.id, user.role);
        if (!isCurrent()) return RETRY_VERIFICATION;
        tokenCache.set(tokenHash, {
            user,
            sessionId: session.session_id,
            credentialId: session.credential_id || null,
            deviceAuthMode: session.device_auth_mode || 'disabled',
            lastSeenAt: now,
            shiftId: null,
            expiresAt: Math.min(new Date(session.idle_expires_at).getTime(), new Date(session.absolute_expires_at).getTime()),
            absoluteExpiresAt: new Date(session.absolute_expires_at).getTime(),
        });

        if (tokenCache.size > 200 && Date.now() - lastCleanupTime > 60000) {
            cleanExpiredTokens();
            lastCleanupTime = Date.now();
        }

        return { ...user };
    } catch (e) {
        if (!isCurrent()) return RETRY_VERIFICATION;
        logger.error({ err: e }, 'verifyToken: database query failed');
        throw new SessionCheckUnavailableError(e);
    }
};

const verifyToken = async (rawToken) => {
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);
    // Cold reads do not yet know their user/device. Security invalidations
    // cancel pending work; affected requests recheck without repopulating stale
    // cache entries. Unrelated warm entries remain available.
    for (let attempt = 0; attempt < 3; attempt++) {
        let operation = pendingVerifications.get(tokenHash);
        if (!operation) {
            operation = {};
            pendingVerifications.set(tokenHash, operation);
            const isCurrent = () => pendingVerifications.get(tokenHash) === operation;
            operation.promise = verifyTokenOnce(rawToken, tokenHash, isCurrent).finally(() => {
                if (isCurrent()) pendingVerifications.delete(tokenHash);
            });
        }
        const user = await operation.promise;
        if (user !== RETRY_VERIFICATION) return normalizeSessionUser(user);
    }
    return null;
};

// Session ids of a live cached session. verifyToken has just validated or
// repopulated this entry, and every revocation path clears it, so the socket
// handshake reads it instead of querying the session again.
const getCachedSessionBinding = (rawToken) => {
    const cached = tokenCache.get(hashToken(rawToken));
    if (!cached || !cached.sessionId || cached.expiresAt <= Date.now()) return null;
    return { session_id: cached.sessionId, credential_id: cached.credentialId || null, expires_at: cached.expiresAt };
};

const requireAuth = async (req, res, next) => {
    // Browser sessions are cookie-only. Do not accept readable bearer tokens.
    const cookies = parseCookies(req.headers['cookie'] || '');
    const rawToken = cookies['pos_token'] || null;

    if (!rawToken) {
        return res.status(401).json({ success: false, code: 'SESSION_REQUIRED', message: "Unauthorized: No session token." });
    }

    let user;
    try {
        user = await verifyToken(rawToken);
    } catch (error) {
        if (!(error instanceof SessionCheckUnavailableError)) throw error;
        res.set('Retry-After', '2');
        return res.status(503).json({ success: false, code: 'SESSION_CHECK_UNAVAILABLE', message: 'Your session could not be verified right now. Please retry.' });
    }
    if (!user) {
        return res.status(401).json({ success: false, code: 'SESSION_INVALID', message: "Unauthorized: Invalid or expired session." });
    }

    req.user = user;
    // Registered-browser credential is the per-device throttle identity.
    // PIN-only staged/disabled sessions intentionally fall back to the user.
    req.authCredentialId = tokenCache.get(hashToken(rawToken))?.credentialId || null;
    next();
};

const requireAdmin = (req, res, next) => {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'programmer')) {
        next();
    } else {
        return res.status(403).json({ success: false, message: "Forbidden: Admin privileges required." });
    }
};

const rejectCallCenterRole = (req, res, next) => {
    if (req.user?.role === 'call_center') {
        return res.status(403).json({ success: false, message: 'Forbidden: Call center users cannot perform this action.' });
    }
    next();
};

const invalidateUserSessions = (userId) => {
    if (!userId) return;
    pendingVerifications.clear();
    let evicted = 0;
    for (const [hash, entry] of tokenCache.entries()) {
        if (entry.user && String(entry.user.id) === String(userId)) {
            tokenCache.delete(hash);
            evicted++;
        }
    }
    if (evicted > 0) {
        logger.info({ userId, evicted }, 'Session cache: evicted tokens for updated/deactivated user');
    }
};

const invalidateCredentialSessions = (credentialId) => {
    if (!credentialId) return;
    pendingVerifications.clear();
    for (const [hash, entry] of tokenCache.entries()) {
        if (String(entry.credentialId || '') === String(credentialId)) tokenCache.delete(hash);
    }
};

const invalidateUnboundSessions = () => {
    pendingVerifications.clear();
    for (const [hash, entry] of tokenCache.entries()) {
        if (!entry.credentialId) tokenCache.delete(hash);
    }
};

const invalidateUserUnboundSessions = (userId) => {
    if (!userId) return;
    pendingVerifications.clear();
    for (const [hash, entry] of tokenCache.entries()) {
        if (!entry.credentialId && String(entry.user?.id || '') === String(userId)) tokenCache.delete(hash);
    }
};

const revokeDurableSessions = async (userId, reason = 'user_security_change', executor) => {
    const count = await revokeDurableUserSessions(userId, reason, executor);
    invalidateUserSessions(userId);
    return count;
};

module.exports = {
    SessionCheckUnavailableError,
    requireAuth,
    requireAdmin,
    rejectCallCenterRole,
    invalidateToken,
    hashToken,
    hashPin,
    verifyPin,
    verifyToken,
    getCachedSessionBinding,
    parseCookies,
    preWarmToken,
    invalidateShiftTokens,
    invalidateUserSessions,
    invalidateCredentialSessions,
    invalidateUnboundSessions,
    invalidateUserUnboundSessions,
    setTokenShiftId
    ,revokeSessionByToken
    ,revokeDurableSessions
};
