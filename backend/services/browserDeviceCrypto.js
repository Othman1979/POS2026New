const crypto = require('node:crypto');

const PROOF_VERSION = 'posapp-browser-device-v1';
const ALLOWED_ACTIONS = new Set([
    'authentication',
    'bootstrap_registration',
    'enrollment_registration',
    'step_up',
]);

function invalidPublicKey(message = 'Invalid browser public key.') {
    return Object.assign(new Error(message), { publicCode: 'BROWSER_DEVICE_PUBLIC_KEY_INVALID', statusCode: 400 });
}

function decodeCoordinate(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidPublicKey('Invalid browser public-key coordinate.');
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== value) throw invalidPublicKey('Invalid browser public-key coordinate.');
    return value;
}

function normalizePublicJwk(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPublicKey();
    if (Object.prototype.hasOwnProperty.call(value, 'd')) throw invalidPublicKey('A private browser key must never leave the browser.');
    if (value.kty !== 'EC' || value.crv !== 'P-256') throw invalidPublicKey('The browser key must use P-256.');
    const jwk = { kty: 'EC', crv: 'P-256', x: decodeCoordinate(value.x), y: decodeCoordinate(value.y) };
    try { crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw invalidPublicKey(); }
    return jwk;
}

function serializePublicJwk(value) {
    return Buffer.from(JSON.stringify(normalizePublicJwk(value)), 'utf8');
}

function publicKeyFingerprint(value) {
    return crypto.createHash('sha256').update(serializePublicJwk(value)).digest('hex');
}

function parseStoredPublicJwk(value) {
    try { return normalizePublicJwk(JSON.parse(Buffer.from(value).toString('utf8'))); } catch (error) {
        if (error?.publicCode) throw error;
        throw invalidPublicKey();
    }
}

function cleanProofField(name, value, maxLength) {
    const text = String(value || '');
    if (!text || text.length > maxLength || /[\r\n\u0000-\u001f\u007f]/.test(text)) {
        throw Object.assign(new Error(`Invalid browser-device ${name}.`), { publicCode: 'BROWSER_DEVICE_PROOF_INVALID', statusCode: 400 });
    }
    return text;
}

function buildDeviceProofMessage({ action, origin, ceremonyId, subject, challenge } = {}) {
    const normalizedAction = cleanProofField('action', action, 64);
    if (!ALLOWED_ACTIONS.has(normalizedAction)) throw Object.assign(new Error('Invalid browser-device action.'), { publicCode: 'BROWSER_DEVICE_PROOF_INVALID', statusCode: 400 });
    return [
        PROOF_VERSION,
        normalizedAction,
        cleanProofField('origin', origin, 2048),
        cleanProofField('ceremony', ceremonyId, 64),
        cleanProofField('subject', subject, 128),
        cleanProofField('challenge', challenge, 256),
    ].join('\n');
}

function verifyDeviceProof({ publicJwk, message, signature } = {}) {
    try {
        const decoded = Buffer.from(String(signature || ''), 'base64url');
        if (decoded.length !== 64 || decoded.toString('base64url') !== signature) return false;
        const key = crypto.createPublicKey({ key: normalizePublicJwk(publicJwk), format: 'jwk' });
        return crypto.verify('sha256', Buffer.from(String(message || ''), 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, decoded);
    } catch {
        return false;
    }
}

function newCredentialId() {
    return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
    PROOF_VERSION,
    buildDeviceProofMessage,
    newCredentialId,
    normalizePublicJwk,
    parseStoredPublicJwk,
    publicKeyFingerprint,
    serializePublicJwk,
    verifyDeviceProof,
};
