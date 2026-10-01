const crypto = require('node:crypto');

function hashThrottlePart(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function createFixedWindowThrottle({ windowMs, limit, maxEntries = 10000, now = Date.now } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('A positive throttle window is required.');
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('A positive throttle limit is required.');
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error('A positive throttle store limit is required.');

    const entries = new Map();
    let lastCleanupAt = now();

    function cleanup(at, force = false) {
        if (!force && at - lastCleanupAt < windowMs && entries.size < maxEntries) return;
        for (const [key, value] of entries) {
            if (at - value.startedAt >= windowMs) entries.delete(key);
        }
        lastCleanupAt = at;
    }

    return {
        consume(rawKey) {
            const key = String(rawKey || 'unknown');
            const at = now();
            cleanup(at);
            let current = entries.get(key);
            if (!current || at - current.startedAt >= windowMs) {
                if (current) entries.delete(key);
                if (entries.size >= maxEntries) {
                    cleanup(at, true);
                    if (entries.size >= maxEntries) return false;
                }
                current = { startedAt: at, count: 0 };
            }
            current.count = Math.min(current.count + 1, limit + 1);
            entries.set(key, current);
            return current.count <= limit;
        }
    };
}

module.exports = { createFixedWindowThrottle, hashThrottlePart };
