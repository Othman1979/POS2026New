const crypto = require('node:crypto');

const {
    buildDeviceProofMessage,
    newCredentialId,
    normalizePublicJwk,
    parseStoredPublicJwk,
    publicKeyFingerprint,
    serializePublicJwk,
    verifyDeviceProof,
} = require('../../services/browserDeviceCrypto');
const { constantTimeOpaqueHashEquals, hashOpaque } = require('../../services/webauthn/ceremonies');

function createKeyPair() {
    return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

describe('silent browser-device cryptography', () => {
    it('accepts only public P-256 JWKs and stores them canonically', () => {
        const { publicKey, privateKey } = createKeyPair();
        const jwk = publicKey.export({ format: 'jwk' });
        const normalized = normalizePublicJwk(jwk);

        expect(normalized).toEqual({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
        expect(parseStoredPublicJwk(serializePublicJwk(jwk))).toEqual(normalized);
        expect(() => normalizePublicJwk(privateKey.export({ format: 'jwk' }))).toThrow(/private/i);
        expect(() => normalizePublicJwk({ ...jwk, crv: 'P-384' })).toThrow(/P-256/i);
        expect(() => normalizePublicJwk({ ...jwk, x: 'AQ' })).toThrow(/coordinate/i);
    });

    it('binds a proof to its version, action, origin, ceremony, subject, and challenge', () => {
        expect(buildDeviceProofMessage({
            action: 'authentication',
            origin: 'https://pos.example.com',
            ceremonyId: 'ceremony-1',
            subject: 'subject-1',
            challenge: 'challenge-1',
        })).toBe([
            'posapp-browser-device-v1',
            'authentication',
            'https://pos.example.com',
            'ceremony-1',
            'subject-1',
            'challenge-1',
        ].join('\n'));
        expect(() => buildDeviceProofMessage({
            action: 'recovery_registration',
            origin: 'https://pos.example.com',
            ceremonyId: 'ceremony-1',
            subject: 'subject-1',
            challenge: 'challenge-1',
        })).toThrow(/action/i);
    });

    it('compares opaque SHA-256 digests in constant time and rejects malformed values', () => {
        const first = hashOpaque('first secret');
        expect(constantTimeOpaqueHashEquals(first, first)).toBe(true);
        expect(constantTimeOpaqueHashEquals(first, hashOpaque('second secret'))).toBe(false);
        expect(constantTimeOpaqueHashEquals(first, 'short')).toBe(false);
        expect(constantTimeOpaqueHashEquals(first, null)).toBe(false);
    });

    it('verifies IEEE-P1363 ECDSA proof and rejects altered context or malformed signatures', () => {
        const { publicKey, privateKey } = createKeyPair();
        const publicJwk = publicKey.export({ format: 'jwk' });
        const message = buildDeviceProofMessage({ action: 'authentication', origin: 'https://pos.example.com', ceremonyId: 'c1', subject: 'u1', challenge: 'q1' });
        const signature = crypto.sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');

        expect(verifyDeviceProof({ publicJwk, message, signature })).toBe(true);
        expect(verifyDeviceProof({ publicJwk, message: `${message}x`, signature })).toBe(false);
        expect(verifyDeviceProof({ publicJwk, message, signature: 'AQ' })).toBe(false);
    });

    it('mints opaque, collision-resistant credential identifiers', () => {
        const first = newCredentialId();
        const second = newCredentialId();
        expect(first).not.toBe(second);
        expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    });

    it('fingerprints the canonical public key without private material', () => {
        const { publicKey } = createKeyPair();
        const jwk = publicKey.export({ format: 'jwk' });

        expect(typeof publicKeyFingerprint).toBe('function');
        expect(publicKeyFingerprint(jwk)).toMatch(/^[a-f0-9]{64}$/);
        expect(publicKeyFingerprint({ ...jwk, key_ops: ['verify'] })).toBe(publicKeyFingerprint(jwk));
    });
});
