const pool = require('../config/db');
const logger = require('../config/logger');
const { hashPin, verifyPin } = require('../middleware/auth');
const { appendAuditEvent } = require('./auditEvents');
const { getOverridableKeys } = require('./PermissionService');
const { CHECKOUT_APPROVAL_ACTIONS, TABLE_APPROVAL_ACTIONS } = require('../config/permissionPolicy.cjs');
const supportedActions = new Set([...CHECKOUT_APPROVAL_ACTIONS, ...TABLE_APPROVAL_ACTIONS]);

const overrideAttempts = new Map();
const OVERRIDE_LOCKOUT_MS = 5 * 60 * 1000;
const OVERRIDE_MAX_FAILED = 5;
let lastOverrideAttemptsCleanup = 0;

function cleanExpiredOverrideAttempts() {
    const now = Date.now();
    for (const [key, state] of overrideAttempts.entries()) {
        // Never evict an entry whose verification is still running — dropping it would
        // release the serialization guard and admit a second concurrent PIN check.
        if (!state.inFlight && now - state.firstAttemptAt > OVERRIDE_LOCKOUT_MS && now > state.lockedUntil) {
            overrideAttempts.delete(key);
        }
    }
}

setInterval(cleanExpiredOverrideAttempts, 10 * 60 * 1000).unref();

function maybeCleanExpiredOverrideAttempts() {
    const now = Date.now();
    if (now - lastOverrideAttemptsCleanup < 60 * 1000) return;
    lastOverrideAttemptsCleanup = now;
    cleanExpiredOverrideAttempts();
}

function getOverrideAttemptState(key) {
    maybeCleanExpiredOverrideAttempts();
    const now = Date.now();
    const state = overrideAttempts.get(key);
    if (!state) return { count: 0, firstAttemptAt: now, lockedUntil: 0, inFlight: false };
    // Expire on the same condition the cleanup timer uses: the window must have passed AND
    // any lockout must have elapsed. Ignoring lockedUntil shed a lockout up to five minutes
    // early, because firstAttemptAt is preserved across failures. Carry inFlight through, or
    // a verification straddling the window boundary loses its serialization guard.
    if (now - state.firstAttemptAt > OVERRIDE_LOCKOUT_MS && now > state.lockedUntil) {
        return { count: 0, firstAttemptAt: now, lockedUntil: 0, inFlight: state.inFlight };
    }
    return state;
}

function recordFailedOverride(key) {
    const state = getOverrideAttemptState(key);
    const nextCount = state.count + 1;
    overrideAttempts.set(key, {
        count: nextCount,
        firstAttemptAt: state.firstAttemptAt,
        lockedUntil: nextCount >= OVERRIDE_MAX_FAILED ? Date.now() + OVERRIDE_LOCKOUT_MS : 0,
        inFlight: false,
    });
}

function overrideBlockedError() {
    const error = new Error('Too many failed manager PIN attempts. Locked out for 5 minutes.');
    error.statusCode = 429;
    return error;
}

async function beginOverrideAttempt(key) {
    const state = getOverrideAttemptState(key);
    if ((state.lockedUntil && Date.now() < state.lockedUntil) || state.inFlight) {
        throw overrideBlockedError();
    }
    overrideAttempts.set(key, { ...state, inFlight: true });
    // Deliberately no delay here. Checkout (executeCheckout.js) can call this while
    // holding a transaction connection and row locks, so sleeping would also occupy
    // the pool. Table join/separate authorize before borrowing their connection.
    // OVERRIDE_MAX_FAILED and the 5-minute lockout already bound failed attempts.
    // Login uses a browser-plus-candidate cooldown before opening a connection; it does
    // not share this transaction-held manager-override path.
}

function finishOverrideAttempt(key, action) {
    const state = overrideAttempts.get(key);
    if (!state) return;
    if (action === 'success') {
        overrideAttempts.delete(key);
        return;
    }
    if (action === 'failed') {
        recordFailedOverride(key);
        return;
    }
    overrideAttempts.set(key, { ...state, inFlight: false });
}

async function recordManagerOverrideAudit({
    eventType,
    userId,
    managerId = null,
    route,
    ipAddress = null,
}) {
    try {
        const routePath = String(route || '').split('?', 1)[0];
        await appendAuditEvent(pool, {
            eventType,
            userId: userId || null,
            managerId,
            newValue: { route: routePath },
            ipAddress,
        });
    } catch (auditErr) {
        logger.error(
            { err: auditErr, eventType, userId: userId || null, managerId },
            `audit_events: failed to log ${eventType}`
        );
    }
}

async function authorizeManagerOverride({ user, managerPin, actions, ipAddress, route, executor = pool }) {
    if (user?.role === 'call_center') {
        const err = new Error('Forbidden: Call center users cannot use manager override.');
        err.statusCode = 403;
        throw err;
    }
    if (!Array.isArray(actions) || !actions.length || actions.length > supportedActions.size || actions.some(action => !supportedActions.has(action))) {
        throw Object.assign(new Error('Forbidden: This action does not support manager approval.'), { statusCode: 403, publicCode: 'MANAGER_APPROVAL_UNSUPPORTED' });
    }
    const requestedActions = [...new Set(actions)];
    if (!managerPin) return { managerId: null, approvedActions: [] };

    const attemptKey = `permission_override:user:${user?.id || 'anon'}`;
    try {
        await beginOverrideAttempt(attemptKey);
    } catch (error) {
        void recordManagerOverrideAudit({
            eventType: 'pin_override_locked',
            userId: user?.id,
            route,
            ipAddress
        });

        throw error;
    }

    let action = 'server-error';
    try {
        // Checkout already owns a connection. Reuse it without accepting credentials
        // from its earlier repeatable-read snapshot; these must be current reads.
        // Audits and opportunistic rehashes stay independent and are never awaited here.
        const [candidates] = await executor.query(
            "SELECT id, role, admin_pin FROM users WHERE is_active = 1 AND admin_pin IS NOT NULL AND role IN ('admin','programmer','table_manager')" +
            (executor === pool ? '' : ' LOCK IN SHARE MODE')
        );

        let matchedManager = null;
        for (const candidate of candidates) {
            const result = await verifyPin(managerPin, candidate.admin_pin);
            if (result) {
                matchedManager = candidate;
                if (result === 'needs_rehash') {
                    const newHash = await hashPin(managerPin);
                    pool.query('UPDATE users SET admin_pin = ? WHERE id = ?', [newHash, candidate.id])
                        .catch(err => logger.error({ err }, 'authorizeManagerOverride: failed to re-hash PIN'));
                }
                break;
            }
        }

        if (!matchedManager) {
            action = 'failed';
            void recordManagerOverrideAudit({
                eventType: 'pin_override_failed',
                userId: user?.id,
                route,
                ipAddress
            });
            const error = new Error('Invalid manager override PIN.');
            error.statusCode = 401;
            throw error;
        }

        const permissionActions = requestedActions.filter(key => CHECKOUT_APPROVAL_ACTIONS.includes(key));
        const enabledKeys = new Set(await getOverridableKeys(executor, permissionActions));
        const approvedActions = requestedActions.filter(key => TABLE_APPROVAL_ACTIONS.includes(key) || enabledKeys.has(key));
        action = 'success';
        void recordManagerOverrideAudit({
            eventType: 'pin_override_success',
            userId: user?.id,
            managerId: matchedManager.id,
            route,
            ipAddress
        });
        return { managerId: matchedManager.id, approvedActions };
    } finally {
        finishOverrideAttempt(attemptKey, action);
    }
}

module.exports = {
    authorizeManagerOverride,
    overrideAttempts,
    recordFailedOverride,
    beginOverrideAttempt,
    finishOverrideAttempt,
    recordManagerOverrideAudit,
};
