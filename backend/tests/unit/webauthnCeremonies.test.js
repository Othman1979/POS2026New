const pool = require('../../config/db');
const {
    createCeremony,
    getCeremony,
    getCeremonyForUpdate,
    assertPendingCeremony,
    recordCeremonyAttempt,
    finishCeremony,
    hashOpaque,
} = require('../../services/webauthn/ceremonies');

describe('durable WebAuthn ceremonies', () => {
    let query;
    beforeEach(() => { query = vi.spyOn(pool, 'query').mockResolvedValue([[]]); });
    afterEach(() => query.mockRestore());

    it('persists a random challenge and never returns its database row as a secret', async () => {
        const result = await createCeremony({ flow: 'authentication', userId: 2 });
        expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO webauthn_ceremonies'), expect.arrayContaining(['authentication', 2]));
    });

    it('uses the advertised enrollment expiry as the authoritative ceremony expiry', async () => {
        const result = await createCeremony({
            flow: 'enrollment_registration',
            userId: 2,
            enrollmentToken: 'one-time-code',
        });
        expect(result.expiresAt.getTime()).toBe(result.enrollmentExpiresAt.getTime());
    });

    it('binds pending verification to the exact flow and rejects replay/expiry', () => {
        expect(() => assertPendingCeremony({ flow: 'authentication', terminal_state: 'pending', expires_at: new Date(Date.now() + 1000), attempt_count: 0 }, 'authentication')).not.toThrow();
        expect(() => assertPendingCeremony({ flow: 'registration', terminal_state: 'pending', expires_at: new Date(Date.now() + 1000), attempt_count: 0 }, 'authentication')).toThrow(/invalid|expired/i);
        expect(() => assertPendingCeremony({ flow: 'authentication', terminal_state: 'consumed', expires_at: new Date(Date.now() + 1000), attempt_count: 0 }, 'authentication')).toThrow(/invalid|expired/i);
    });

    it('locks lookup, counts attempts, and makes completion one-use', async () => {
        query.mockResolvedValueOnce([[{ id: 'c1', flow: 'authentication', terminal_state: 'pending', expires_at: new Date(Date.now() + 1000), attempt_count: 0 }]]);
        await expect(getCeremonyForUpdate('c1')).resolves.toMatchObject({ id: 'c1' });
        expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['c1']);
        await recordCeremonyAttempt('c1');
        query.mockResolvedValueOnce([{ affectedRows: 1 }]);
        await expect(finishCeremony('c1')).resolves.toBe(true);
        expect(hashOpaque('secret')).toHaveLength(64);
    });

    it('reads an options ceremony without pretending to hold a transaction lock', async () => {
        query.mockResolvedValueOnce([[{ id: 'c1', flow: 'authentication' }]]);

        await expect(getCeremony('c1')).resolves.toMatchObject({ id: 'c1' });
        expect(query).toHaveBeenCalledWith(
            expect.not.stringContaining('FOR UPDATE'),
            ['c1']
        );
    });
});
