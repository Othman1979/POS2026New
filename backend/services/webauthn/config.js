const net = require('node:net');
const crypto = require('node:crypto');

const ACTIVE_MODES = new Set(['staged', 'enforced']);

function configError(message, publicCode = 'WEBAUTHN_CONFIG_INVALID') {
    return Object.assign(new Error(message), { publicCode, statusCode: 500 });
}

function readString(env, ...keys) {
    for (const key of keys) {
        const value = env?.[key];
        if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
}

function parseOrigin(value) {
    let parsed;
    try { parsed = new URL(value); } catch { throw configError('DEVICE_AUTH_ALLOWED_ORIGINS contains an invalid origin.'); }
    const isLocalHttp = parsed.protocol === 'http:' && parsed.hostname === 'localhost';
    if (parsed.protocol !== 'https:' && !isLocalHttp) throw configError('Registered-device origins must use HTTPS, except http://localhost for isolated local validation.');
    if (net.isIP(parsed.hostname)) throw configError('Registered-device origins cannot use direct IP addresses.');
    if (parsed.hostname.includes('*')) throw configError('Registered-device origins cannot contain wildcard hostnames.');
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) {
        throw configError('DEVICE_AUTH_ALLOWED_ORIGINS must contain canonical origins without paths or credentials.');
    }
    return parsed.origin;
}

function loadWebAuthnConfig(env = process.env) {
    const rawOrigins = readString(env, 'DEVICE_AUTH_ALLOWED_ORIGINS', 'WEBAUTHN_ALLOWED_ORIGINS');
    if (!rawOrigins) throw configError('DEVICE_AUTH_ALLOWED_ORIGINS is required when registered-device access is configured.', 'WEBAUTHN_CONFIG_REQUIRED');
    const expectedOrigins = rawOrigins.split(',').map((value) => parseOrigin(value.trim()));
    if (new Set(expectedOrigins).size !== expectedOrigins.length) throw configError('DEVICE_AUTH_ALLOWED_ORIGINS must not contain duplicates.');
    return Object.freeze({ expectedOrigins: Object.freeze(expectedOrigins) });
}

function validateWebAuthnOrigin(config, origin) {
    return Boolean(config?.expectedOrigins?.includes(String(origin || '').trim()));
}

function assertWebAuthnRuntimeReady({ config, mode, enforceHttps }) {
    if (mode === 'disabled') return;
    if (!ACTIVE_MODES.has(mode)) throw configError(`Unknown registered-device authentication mode: ${mode}.`);
    if (!config?.expectedOrigins?.length) throw configError('Registered-device origin configuration is required.', 'WEBAUTHN_CONFIG_REQUIRED');
    if (!enforceHttps && config.expectedOrigins.some((origin) => !origin.startsWith('http://localhost'))) {
        throw configError('ENFORCE_HTTPS must be enabled before online registered-device mode can start.', 'WEBAUTHN_HTTPS_REQUIRED');
    }
    if (enforceHttps && config.expectedOrigins.some((origin) => origin.startsWith('http://'))) {
        throw configError('Local HTTP origins are invalid while ENFORCE_HTTPS is enabled.', 'WEBAUTHN_HTTPS_REQUIRED');
    }
}

function bootstrapSecret(env = process.env) {
    const secret = readString(env, 'DEVICE_AUTH_BOOTSTRAP_SECRET', 'WEBAUTHN_BOOTSTRAP_SECRET');
    if (secret.length < 32) throw configError('DEVICE_AUTH_BOOTSTRAP_SECRET must contain at least 256 bits of entropy.', 'WEBAUTHN_BOOTSTRAP_SECRET_REQUIRED');
    return secret;
}

function bootstrapSecretHash(rawSecret) {
    return crypto.createHash('sha256').update(String(rawSecret || '')).digest();
}

function assertBootstrapSecretConfigured(env = process.env) {
    return bootstrapSecret(env);
}

function verifyBootstrapSecret(rawSecret, env = process.env) {
    const expected = bootstrapSecretHash(bootstrapSecret(env));
    const actual = bootstrapSecretHash(rawSecret);
    return crypto.timingSafeEqual(actual, expected);
}

module.exports = {
    ACTIVE_MODES,
    loadWebAuthnConfig,
    validateWebAuthnOrigin,
    assertWebAuthnRuntimeReady,
    assertBootstrapSecretConfigured,
    verifyBootstrapSecret,
    bootstrapSecretHash,
};
