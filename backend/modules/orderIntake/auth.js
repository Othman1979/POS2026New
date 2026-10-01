'use strict';

const crypto = require('crypto');
const { readOrderIntakeConfig } = require('./config');

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function constantTimeHexEquals(left, right) {
    if (!/^[a-f0-9]{64}$/i.test(String(left || '')) || !/^[a-f0-9]{64}$/i.test(String(right || ''))) return false;
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function bearerToken(req) {
    const header = String(req.get('authorization') || '');
    const match = /^Bearer ([^\s]+)$/i.exec(header);
    return match ? match[1] : null;
}

function requireOrderIntakeAuth(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const config = readOrderIntakeConfig();
    if (!config.enabled) {
        return res.status(404).json({ success: false, code: 'ORDER_INTAKE_DISABLED', message: 'Order intake is disabled.' });
    }
    if (!config.valid) {
        return res.status(503).json({ success: false, code: 'ORDER_INTAKE_CONFIG_INVALID', message: 'Order intake is unavailable.' });
    }
    const token = bearerToken(req);
    if (!token || token.length < 32 || !constantTimeHexEquals(sha256(token), config.apiKeySha256)) {
        res.set('WWW-Authenticate', 'Bearer realm="order-intake"');
        return res.status(401).json({ success: false, code: 'ORDER_INTAKE_AUTH_REQUIRED', message: 'Authentication required.' });
    }
    req.orderIntake = { clientId: config.clientId, config };
    return next();
}

module.exports = { requireOrderIntakeAuth, sha256, constantTimeHexEquals };
