const pool = require('../../config/db');
const PermissionService = require('../../services/PermissionService');
const auth = require('../../middleware/auth');

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const session = (id = 42) => ({ session_id: `session-${id}`, user_id: id,
    user_number: String(id), name: `Staff ${id}`, role: 'cashier', is_active: 1,
    allowed_sections: null, credential_id: null, device_auth_mode: 'disabled',
    idle_expires_at: new Date(Date.now() + 20 * 60000), absolute_expires_at: new Date(Date.now() + 3600000) });

describe('concurrent session verification', () => {
    let query, permissions;
    beforeEach(() => {
        for (const token of ['concurrency-a', 'concurrency-b']) auth.invalidateToken(token);
        query = vi.spyOn(pool, 'query').mockResolvedValue([[session()]]);
        permissions = vi.spyOn(PermissionService, 'loadUserPermissions').mockResolvedValue(['orders.view']);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('shares cold work for one token and gives each request its own user object', async () => {
        const users = await Promise.all(Array.from({ length: 20 }, () => auth.verifyToken('concurrency-a')));
        expect(users.every(user => user.id === 42 && user.permissions.includes('orders.view'))).toBe(true);
        users[0].name = 'Request-local change';
        expect(users[1].name).toBe('Staff 42');
        expect(query).toHaveBeenCalledTimes(1);
        expect(permissions).toHaveBeenCalledTimes(1);
        query.mockClear();
        await Promise.all(Array.from({ length: 20 }, () => auth.verifyToken('concurrency-a')));
        expect(query).not.toHaveBeenCalled();
    });

    it('does not share results between different tokens', async () => {
        query.mockImplementation(async (_sql, [hash]) => [[session(hash === auth.hashToken('concurrency-a') ? 42 : 43)]]);
        const users = await Promise.all([auth.verifyToken('concurrency-a'), auth.verifyToken('concurrency-b')]);
        expect(users.map(user => user.id)).toEqual([42, 43]);
        expect(query).toHaveBeenCalledTimes(2);
    });

    it('shares a due durable activity refresh and denies a failed refresh', async () => {
        const now = Date.now();
        auth.preWarmToken('concurrency-a', { id: 42 }, { sessionId: 'session-42' });
        vi.spyOn(Date, 'now').mockReturnValue(now + 61000);
        query.mockResolvedValue([{ affectedRows: 1 }]);
        expect((await Promise.all(Array.from({ length: 20 }, () => auth.verifyToken('concurrency-a'))))
            .every(user => user.id === 42)).toBe(true);
        expect(query).toHaveBeenCalledTimes(1);
        Date.now.mockReturnValue(now + 122000);
        query.mockClear().mockResolvedValue([{ affectedRows: 0 }]);
        expect(await Promise.all(Array.from({ length: 20 }, () => auth.verifyToken('concurrency-a'))))
            .toEqual(Array(20).fill(null));
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('releases failed pending work so a later request can recover', async () => {
        query.mockRejectedValueOnce(new Error('Fixture connection failure'));
        const failed = await Promise.allSettled(Array.from({ length: 20 }, () => auth.verifyToken('concurrency-a')));
        expect(failed.map(result => result.reason?.name)).toEqual(Array(20).fill('SessionCheckUnavailableError'));
        expect(query).toHaveBeenCalledTimes(1);
        query.mockResolvedValue([[session()]]);
        expect((await auth.verifyToken('concurrency-a')).id).toBe(42);
    });

    it.each([
        ['token', () => auth.invalidateToken('concurrency-a')],
        ['user', () => auth.invalidateUserSessions(42)],
        ['shift', () => auth.invalidateShiftTokens(7)],
        ['credential', () => auth.invalidateCredentialSessions(8)],
        ['unbound', () => auth.invalidateUnboundSessions()],
        ['user unbound', () => auth.invalidateUserUnboundSessions(42)],
    ])('cannot resurrect a stale cold result after %s invalidation', async (_name, invalidate) => {
        const started = deferred(), release = deferred();
        query.mockImplementationOnce(async () => { started.resolve(); await release.promise; return [[session()]]; })
            .mockResolvedValue([[]]);
        const oldRequest = auth.verifyToken('concurrency-a');
        await started.promise;
        invalidate();
        expect(await auth.verifyToken('concurrency-a')).toBeNull();
        release.resolve();
        expect(await oldRequest).toBeNull();
        expect(await auth.verifyToken('concurrency-a')).toBeNull();
    });

    it('reloads permissions if invalidation occurs during the permission lookup', async () => {
        const started = deferred(), release = deferred();
        permissions.mockImplementationOnce(async () => { started.resolve(); await release.promise; return ['old.permission']; })
            .mockResolvedValue(['new.permission']);
        const pending = auth.verifyToken('concurrency-a');
        await started.promise;
        auth.invalidateUserSessions(42);
        release.resolve();
        expect((await pending).permissions).toEqual(['new.permission']);
        expect((await auth.verifyToken('concurrency-a')).permissions).toEqual(['new.permission']);
    });

    it('does not let an old failed refresh evict a newly prewarmed session', async () => {
        const now = Date.now(), started = deferred(), release = deferred();
        auth.preWarmToken('concurrency-a', { id: 42, name: 'Old' }, { sessionId: 'session-42' });
        vi.spyOn(Date, 'now').mockReturnValue(now + 61000);
        query.mockImplementationOnce(async () => { started.resolve(); await release.promise; return [{ affectedRows: 0 }]; });
        const pending = auth.verifyToken('concurrency-a');
        await started.promise;
        auth.preWarmToken('concurrency-a', { id: 42, name: 'Fresh' }, { sessionId: 'fresh-session' });
        release.resolve();
        expect((await pending).name).toBe('Fresh');
        expect((await auth.verifyToken('concurrency-a')).name).toBe('Fresh');
    });

    it('rechecks unrelated pending users without incorrectly logging them out', async () => {
        const started = deferred(), release = deferred(), counts = new Map();
        let firstReads = 0;
        query.mockImplementation(async (_sql, [hash]) => {
            const count = (counts.get(hash) || 0) + 1;
            counts.set(hash, count);
            const id = hash === auth.hashToken('concurrency-a') ? 42 : 43;
            if (count === 1) {
                if (++firstReads === 2) started.resolve();
                await release.promise;
                return [[session(id)]];
            }
            return [id === 42 ? [] : [session(id)]];
        });
        const pending = Promise.all([auth.verifyToken('concurrency-a'), auth.verifyToken('concurrency-b')]);
        await started.promise;
        auth.invalidateUserSessions(42);
        release.resolve();
        const users = await pending;
        expect(users[0]).toBeNull();
        expect(users[1].id).toBe(43);
    });

    it('bounds retries during continuous security invalidation and later recovers', async () => {
        query.mockImplementation(async () => { auth.invalidateUserSessions(42); return [[session()]]; });
        expect(await auth.verifyToken('concurrency-a')).toBeNull();
        expect(query).toHaveBeenCalledTimes(3);
        query.mockResolvedValue([[session()]]);
        expect((await auth.verifyToken('concurrency-a')).id).toBe(42);
    });
});
