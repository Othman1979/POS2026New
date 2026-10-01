const crypto = require('node:crypto');
const { hashThrottlePart } = require('./requestThrottle');

const LOGIN_BROWSER_COOKIE = 'pos_login_browser';
const FAILURE_THRESHOLD = 3;
const FIRST_BLOCK_MS = 60 * 1000;
const REPEAT_BLOCK_MS = 5 * 60 * 1000;
const RESET_WINDOW_MS = 30 * 60 * 1000;
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_MAX_ENTRIES = 4096;

function createLoginThrottle({ now = () => Date.now(), maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    const entries = new Map();

    function activeState(key, at) {
        const state = entries.get(key);
        if (state && at - state.lastFailureAt >= RESET_WINDOW_MS) {
            entries.delete(key);
            return null;
        }
        return state || null;
    }

    function makeRoom() {
        if (entries.size < maxEntries) return;
        let oldestKey;
        let oldestAt = Infinity;
        for (const [key, state] of entries) {
            if (state.lastFailureAt < oldestAt) {
                oldestAt = state.lastFailureAt;
                oldestKey = key;
            }
        }
        if (oldestKey) entries.delete(oldestKey);
    }

    function browserIdFor(req, res, { enforceHttps = process.env.ENFORCE_HTTPS === 'true' } = {}) {
        const match = String(req.headers?.cookie || '').match(new RegExp(`(?:^|;\\s*)${LOGIN_BROWSER_COOKIE}=([a-f0-9]{32})(?:;|$)`, 'i'));
        if (match) return match[1].toLowerCase();

        const browserId = crypto.randomBytes(16).toString('hex');
        const parts = [
            `${LOGIN_BROWSER_COOKIE}=${browserId}`,
            'HttpOnly',
            'SameSite=Strict',
            'Path=/',
            `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
        ];
        if (enforceHttps) parts.push('Secure');
        const existing = res.getHeader('Set-Cookie') || [];
        res.setHeader('Set-Cookie', [].concat(existing, parts.join('; ')));
        return browserId;
    }

    return {
        keyFor(browserId, userNumber) {
            return hashThrottlePart(`${String(browserId || '').trim()}\0${String(userNumber || '').trim()}`);
        },
        browserIdFor,
        retryAfterMs(key) {
            const at = now();
            const state = activeState(key, at);
            return state ? Math.max(0, state.blockedUntil - at) : 0;
        },
        recordFailure(key) {
            const at = now();
            let state = activeState(key, at);
            if (!state) {
                makeRoom();
                state = { failures: 0, level: 0, blockedUntil: 0, lastFailureAt: at };
                entries.set(key, state);
            }
            const remaining = Math.max(0, state.blockedUntil - at);
            if (remaining) return remaining;

            state.failures += 1;
            state.lastFailureAt = at;
            if (state.failures < FAILURE_THRESHOLD) return 0;

            state.failures = 0;
            state.level = Math.min(state.level + 1, 2);
            const blockMs = state.level === 1 ? FIRST_BLOCK_MS : REPEAT_BLOCK_MS;
            state.blockedUntil = at + blockMs;
            return blockMs;
        },
        clear(key) {
            entries.delete(key);
        },
        get size() {
            return entries.size;
        },
    };
}

module.exports = {
    createLoginThrottle,
    LOGIN_BROWSER_COOKIE,
    FAILURE_THRESHOLD,
    FIRST_BLOCK_MS,
    REPEAT_BLOCK_MS,
    RESET_WINDOW_MS,
};
