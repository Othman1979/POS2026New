const pool = require('../../config/db');
const {
    createSession,
    findActiveSession,
    touchSession,
    revokeSessionByToken,
    revokeUserSessions,
    hashSessionToken,
} = require('../../services/staffSessions');

describe('durable staff sessions', () => {
    let query;

    beforeEach(() => {
        query = vi.spyOn(pool, 'query').mockResolvedValue([[]]);
    });

    afterEach(() => query.mockRestore());

    it('creates a random token row and optionally revokes the user’s old sessions first', async () => {
        query
            .mockResolvedValueOnce([{ affectedRows: 1 }])
            .mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }]);

        const session = await createSession({ userId: 7, credentialId: 12, revokeUserSessions: true });

        expect(session.rawToken).toMatch(/^[0-9a-f]{64}$/);
        expect(session.tokenHash).toBe(hashSessionToken(session.rawToken));
        expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('UPDATE auth_sessions'), ['replaced', 7]);
        expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO auth_sessions'), expect.arrayContaining([session.id, session.tokenHash, 7, 12]));
    });

    it('rejects an enforced unbound session only after that user has an eligible browser', async () => {
        query.mockResolvedValueOnce([[{
            session_id: 's1',
            user_id: 7,
            credential_id: null,
            role: 'cashier',
            is_active: 1,
            device_auth_mode: 'enforced',
            has_eligible_credential: 1,
        }]]);

        await expect(findActiveSession('token')).resolves.toBeNull();
    });

    it('keeps an enforced unbound session valid while that user has no eligible browser', async () => {
        query.mockResolvedValueOnce([[
            {
                session_id: 's1',
                user_id: 7,
                credential_id: null,
                role: 'cashier',
                is_active: 1,
                device_auth_mode: 'enforced',
                has_eligible_credential: 0,
            },
        ]]);

        await expect(findActiveSession('token')).resolves.toMatchObject({ session_id: 's1', user_id: 7 });
    });

    it('touches only an active unrevoked session and revokes by token hash', async () => {
        query.mockResolvedValueOnce([{ affectedRows: 1 }]);
        await expect(touchSession('s1')).resolves.toBe(true);
        expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE auth_sessions'), expect.any(Array));
        expect(query.mock.calls[0][0]).toContain("c.device_type = 'singleDevice'");
        expect(query.mock.calls[0][0]).toContain("staff_device_auth_mode");

        query.mockResolvedValueOnce([{ affectedRows: 1 }]);
        await expect(revokeSessionByToken('raw-token', 'logout')).resolves.toBe(true);
        expect(query).toHaveBeenLastCalledWith(expect.stringContaining('WHERE token_hash = ?'), ['logout', hashSessionToken('raw-token')]);
    });

    it('reports zero when there is no user to revoke', async () => {
        await expect(revokeUserSessions(null)).resolves.toBe(0);
        expect(query).not.toHaveBeenCalled();
    });
});
