'use strict';

const crypto = require('crypto');
const { intakeError } = require('./contract');

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
    }, {});
}

function digest(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex');
}

function requestHash(draft) {
    return digest(draft);
}

function quoteHash({ clientId, actorUserId, cart, totals }) {
    return digest({ clientId, actorUserId, cart, totals });
}

function signature(encoded, secret) {
    return crypto.createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
}

function createQuoteToken({ config, actorUserId, requestDigest, quoteDigest, now = Date.now() }) {
    const claims = {
        v: 1,
        client: config.clientId,
        actor: Number(actorUserId),
        request_hash: requestDigest,
        quote_hash: quoteDigest,
        exp: Math.floor(now / 1000) + config.quoteTtlSeconds,
    };
    const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return { token: `${encoded}.${signature(encoded, config.quoteSecret)}`, claims };
}

function verifyQuoteToken(token, { config, actorUserId, requestDigest, now = Date.now() }) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw intakeError('Quote token is invalid.', 409, 'ORDER_INTAKE_QUOTE_INVALID');
    }
    const expected = Buffer.from(signature(parts[0], config.quoteSecret));
    const supplied = Buffer.from(parts[1]);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
        throw intakeError('Quote token is invalid.', 409, 'ORDER_INTAKE_QUOTE_INVALID');
    }
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_) {
        throw intakeError('Quote token is invalid.', 409, 'ORDER_INTAKE_QUOTE_INVALID');
    }
    if (claims.v !== 1 || claims.client !== config.clientId || Number(claims.actor) !== Number(actorUserId)
        || claims.request_hash !== requestDigest || !/^[a-f0-9]{64}$/.test(String(claims.quote_hash || ''))) {
        throw intakeError('Quote token does not match this order.', 409, 'ORDER_INTAKE_QUOTE_MISMATCH');
    }
    if (!Number.isSafeInteger(claims.exp) || claims.exp < Math.floor(now / 1000)) {
        throw intakeError('Quote expired. Request a new quote.', 409, 'ORDER_INTAKE_QUOTE_EXPIRED');
    }
    return claims;
}

module.exports = { stableValue, digest, requestHash, quoteHash, createQuoteToken, verifyQuoteToken };
