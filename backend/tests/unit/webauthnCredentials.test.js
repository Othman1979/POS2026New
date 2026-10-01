import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../config/db', () => pool);

import { credentialLookup } from '../../services/webauthn/policy.js';
import { credentialPublicJwk, markCredentialUsed } from '../../services/webauthn/credentials.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = publicKey.export({ format: 'jwk' });
const privateJwk = privateKey.export({ format: 'jwk' });

describe('registered-browser credential storage boundary', () => {
    it('indexes a raw credential with a fixed hash while preserving the raw bytes', () => {
        const parsed = credentialLookup('AQID');
        expect(parsed.value).toEqual(Buffer.from([1, 2, 3]));
        expect(parsed.lookup).toHaveLength(32);
        expect(parsed.encoded).toBe('AQID');
    });

    it('parses only the stored public browser key', () => {
        expect(credentialPublicJwk({ public_key: Buffer.from(JSON.stringify(publicJwk)) })).toEqual(publicJwk);
        expect(() => credentialPublicJwk({ public_key: Buffer.from(JSON.stringify(privateJwk)) })).toThrow();
    });

    it('marks only an active browser credential as used', async () => {
        const executor = { query: vi.fn().mockResolvedValue([{ affectedRows: 1 }]) };
        await expect(markCredentialUsed({ executor, credentialId: 7 })).resolves.toBe(true);
        expect(executor.query.mock.calls[0][0]).toContain("status = 'active'");

        executor.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
        await expect(markCredentialUsed({ executor, credentialId: 7 })).resolves.toBe(false);
    });
});
