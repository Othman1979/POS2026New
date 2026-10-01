const { createFixedWindowThrottle } = require('../services/requestThrottle');
const logger = require('../config/logger');

function createKeyedRateLimiter({ windowMs, max, message = 'Too many requests.', code, onLimit, keyForRequest, maxEntries } = {}) {
    if (typeof keyForRequest !== 'function') throw new Error('A rate-limit key function is required.');
    const throttle = createFixedWindowThrottle({
        windowMs,
        limit: max,
        ...(maxEntries ? { maxEntries } : {}),
    });

    return (req, res, next) => {
        let key;
        try {
            key = String(keyForRequest(req) || '').trim();
        } catch (error) {
            return next(error);
        }
        if (!key) return next(new Error('Rate-limit identity is unavailable.'));
        if (!throttle.consume(key)) {
            onLimit?.({ key });
            res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
            return res.status(429).json({ success: false, ...(code ? { code } : {}), message });
        }
        return next();
    };
}

const actorKey = req => (req.authCredentialId
    ? `credential:${req.authCredentialId}`
    : (req.user?.id ? `user:${req.user.id}` : null));

const GATE_LEASE_WARN_MS = 15_000;

function createGlobalPreAuthGate({
    windowMs = 60_000,
    max = 600,
    maxConcurrent = 6,
    leaseWarnMs = GATE_LEASE_WARN_MS,
    now = Date.now,
    trackConcurrency = () => true,
} = {}) {
    const requests = createFixedWindowThrottle({ windowMs, limit: max, maxEntries: 1, now });
    let inFlight = 0;
    const rejectBusy = res => {
        res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ success: false, code: 'SERVER_BUSY', message: 'The server is busy. Try again in a moment.' });
    };

    return (req, res, next) => {
        if (!requests.consume('global:preauth')) return rejectBusy(res);
        if (!trackConcurrency(req)) return next();
        if (inFlight >= maxConcurrent) return rejectBusy(res);
        inFlight += 1;
        let released = false;
        let watchdog;
        const release = () => {
            if (released) return;
            released = true;
            inFlight -= 1;
            if (watchdog) clearTimeout(watchdog);
        };
        watchdog = setTimeout(() => {
            logger.warn('Pre-auth gate: dynamic request still running after warning threshold.');
        }, leaseWarnMs);
        watchdog.unref?.();
        const originalEnd = res.end;
        res.end = function patchedEnd(...args) {
            release();
            return originalEnd.apply(this, args);
        };
        res.once('close', release);
        try {
            return next();
        } catch (error) {
            release();
            throw error;
        }
    };
}

module.exports = { createKeyedRateLimiter, createGlobalPreAuthGate, actorKey };
