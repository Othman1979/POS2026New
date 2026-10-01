'use strict';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function boundedInteger(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function isReservedOrderIntakeActor(userId, env = process.env) {
    const actorUserId = Number(env.ORDER_INTAKE_ACTOR_USER_ID);
    return Number.isSafeInteger(actorUserId)
        && actorUserId > 0
        && Number(userId) === actorUserId;
}

function readOrderIntakeConfig(env = process.env) {
    const enabled = env.ORDER_INTAKE_ENABLED === '1' || env.ORDER_INTAKE_ENABLED === 'true';
    const clientId = String(env.ORDER_INTAKE_CLIENT_ID || 'pos-order-intake').trim();
    const apiKeySha256 = String(env.ORDER_INTAKE_API_KEY_SHA256 || '').trim().toLowerCase();
    const quoteSecret = String(env.ORDER_INTAKE_QUOTE_SECRET || '').trim();
    const actorUserId = Number(env.ORDER_INTAKE_ACTOR_USER_ID);
    const errors = [];

    if (!CLIENT_ID_RE.test(clientId)) errors.push('ORDER_INTAKE_CLIENT_ID is invalid.');
    if (!SHA256_RE.test(apiKeySha256)) errors.push('ORDER_INTAKE_API_KEY_SHA256 must be a SHA-256 hex digest.');
    if (quoteSecret.length < 32) errors.push('ORDER_INTAKE_QUOTE_SECRET must contain at least 32 characters.');
    if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) errors.push('ORDER_INTAKE_ACTOR_USER_ID must be a positive user id.');
    if (enabled && env.NODE_ENV === 'production' && env.ENFORCE_HTTPS !== 'true') {
        errors.push('ENFORCE_HTTPS must be true when order intake is enabled in production.');
    }

    return {
        enabled,
        valid: errors.length === 0,
        errors,
        clientId,
        apiKeySha256,
        quoteSecret,
        actorUserId,
        quoteTtlSeconds: boundedInteger(env.ORDER_INTAKE_QUOTE_TTL_SECONDS, 300, 60, 1800),
        requestRateLimit: boundedInteger(env.ORDER_INTAKE_RATE_LIMIT_MAX, 120, 10, 5000),
        createRateLimit: boundedInteger(env.ORDER_INTAKE_CREATE_RATE_LIMIT_MAX, 30, 1, 1000),
        activeHoldLimit: boundedInteger(env.ORDER_INTAKE_ACTIVE_HOLD_LIMIT, 200, 20, 5000),
    };
}

module.exports = { readOrderIntakeConfig, isReservedOrderIntakeActor };
