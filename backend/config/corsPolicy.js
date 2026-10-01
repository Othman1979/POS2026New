function normalizeOrigin(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        throw new Error('CORS_ORIGIN entries must be explicit HTTP(S) origins.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin === 'null') {
        throw new Error('CORS_ORIGIN entries must be explicit HTTP(S) origins.');
    }
    return parsed.origin;
}

function createCorsPolicy(raw = '') {
    const origins = [...new Set(String(raw).split(',').map(value => value.trim()).filter(Boolean).map(normalizeOrigin))];
    const configured = new Set(origins);
    const httpOptions = { origin: origins.length ? origins : false };

    const allowSocketRequest = (req, done) => {
        const rawOrigin = String(req.headers.origin || '').trim();
        if (!rawOrigin) return done(null, true);

        let origin;
        try {
            origin = normalizeOrigin(rawOrigin);
        } catch (_) {
            return done('Origin not allowed.', false);
        }

        const requestHost = String(req.headers.host || '').trim().toLowerCase();
        const sameHost = requestHost && new URL(origin).host.toLowerCase() === requestHost;
        const allowed = sameHost || configured.has(origin);
        return done(allowed ? null : 'Origin not allowed.', allowed);
    };

    return { origins, httpOptions, allowSocketRequest };
}

module.exports = { createCorsPolicy };
