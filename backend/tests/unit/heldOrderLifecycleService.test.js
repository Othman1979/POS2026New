const crypto = require('crypto');

const service = require('../../services/HeldOrderLifecycleService');

const TOKEN = 'a'.repeat(64);
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');

function executor(...results) {
    const query = jestLike();
    results.forEach((result) => query.mockResolvedValueOnce(result));
    return { query };
}

function jestLike() {
    const calls = [];
    const queue = [];
    const fn = (...args) => {
        calls.push(args);
        return queue.length ? queue.shift() : Promise.resolve([[], {}]);
    };
    fn.mockResolvedValueOnce = (value) => {
        queue.push(Promise.resolve(value));
        return fn;
    };
    fn.mock = { calls };
    fn.mockResolvedValue = (value) => {
        queue.push(Promise.resolve(value));
        return fn;
    };
    return fn;
}

function held(overrides = {}) {
    return {
        id: 7,
        user_id: 3,
        reference_name: 'Phone order',
        cart_data: '{"items":[]}',
        version: 4,
        claimed_by_user_id: null,
        claim_token_hash: null,
        claim_expires_at: null,
        kitchen_fired: 0,
        kitchen_snapshot: null,
        kitchen_dispatch_version: 0,
        call_center_user_id: null,
        last_operation_id: null,
        last_operation_kind: null,
        last_operation_result: null,
        ...overrides
    };
}

describe('HeldOrderLifecycleService', () => {
    it('creates opaque tokens and verifies hashes in constant time', () => {
        const token = service.createClaimToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(service.verifyClaimToken(token, service.hashClaimToken(token))).toBe(true);
        const differentToken = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
        expect(service.verifyClaimToken(differentToken, service.hashClaimToken(token))).toBe(false);
    });

    it('claims an available row without deleting it and returns only safe metadata', async () => {
        const conn = executor(
            [[held()]],
            [{ affectedRows: 1 }]
        );
        const claimed = await service.claimHeldOrder(conn, {
            id: 7,
            userId: 12,
            claimToken: TOKEN,
            expectedVersion: 4,
            now: new Date('2026-08-10T10:00:00.000Z')
        });

        expect(claimed).toMatchObject({ id: 7, version: 5, claimOwnerUserId: 12, replay: false });
        expect(conn.query.mock.calls[0][0]).toContain('FOR UPDATE');
        expect(conn.query.mock.calls[1][0]).toContain('claim_token_hash');
        expect(conn.query.mock.calls[1][1]).toContain(TOKEN_HASH);
        expect(conn.query.mock.calls[1][1]).not.toContain(TOKEN);
        expect(conn.query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/DELETE\s+FROM\s+held_orders/i);
        const projected = service.safeProjection(held({
            call_center_user_id: 70,
            claim_token_hash: TOKEN_HASH,
            last_operation_result: '{"token":"bad"}'
        }));
        expect(projected.call_center_user_id).toBe(70);
        expect(projected).not.toHaveProperty('claimTokenHash');
        expect(projected).not.toHaveProperty('claim_token_hash');
    });

    it('replays the same claimant and token without changing version', async () => {
        const row = held({ claimed_by_user_id: 12, claim_token_hash: TOKEN_HASH, claim_expires_at: new Date('2026-08-10T10:10:00.000Z') });
        const conn = executor([[row]]);
        const result = await service.claimHeldOrder(conn, {
            id: 7, userId: 12, claimToken: TOKEN, expectedVersion: 4,
            now: new Date('2026-08-10T10:05:00.000Z')
        });
        expect(result).toMatchObject({ id: 7, version: 4, replay: true });
        expect(conn.query.mock.calls).toHaveLength(1);
    });

    it('rejects a competing unexpired claimant and permits takeover after database-time expiry', async () => {
        const competing = executor([[
            held({ claimed_by_user_id: 99, claim_token_hash: TOKEN_HASH, claim_expires_at: new Date('2026-08-10T10:10:00.000Z') })
        ]]);
        await expect(service.claimHeldOrder(competing, {
            id: 7, userId: 12, claimToken: 'b'.repeat(64), expectedVersion: 4,
            now: new Date('2026-08-10T10:05:00.000Z')
        })).rejects.toMatchObject({ statusCode: 409, publicCode: 'HELD_IN_USE' });

        const expired = executor(
            [[held({ claimed_by_user_id: 99, claim_token_hash: TOKEN_HASH, claim_expires_at: new Date('2026-08-10T10:00:00.000Z') })]],
            [{ affectedRows: 1 }]
        );
        await expect(service.claimHeldOrder(expired, {
            id: 7, userId: 12, claimToken: 'b'.repeat(64), expectedVersion: 4,
            now: new Date('2026-08-10T10:05:00.000Z')
        })).resolves.toMatchObject({ replay: false, claimOwnerUserId: 12, version: 5 });
    });

    it('rejects a mutation against a stale version', async () => {
        const conn = executor([[held({ claimed_by_user_id: 12, claim_token_hash: TOKEN_HASH, claim_expires_at: new Date('2026-08-10T10:10:00.000Z') })]]);
        await expect(service.lockClaimedHeldOrder(conn, {
            id: 7, userId: 12, claimToken: TOKEN, expectedVersion: 3,
            now: new Date('2026-08-10T10:05:00.000Z')
        })).rejects.toMatchObject({ statusCode: 409, publicCode: 'HELD_VERSION_CONFLICT' });
    });

    it('rejects a mutation from the same user holding a different terminal claim token', async () => {
        const conn = executor([[held({ claimed_by_user_id: 12, claim_token_hash: TOKEN_HASH, claim_expires_at: new Date('2026-08-10T10:10:00.000Z') })]]);
        await expect(service.lockClaimedHeldOrder(conn, {
            id: 7, userId: 12, claimToken: 'b'.repeat(64), expectedVersion: 4,
            now: new Date('2026-08-10T10:05:00.000Z')
        })).rejects.toMatchObject({ statusCode: 409, publicCode: 'HELD_CLAIM_REQUIRED' });
    });

    it('rejects a fresh claim made against a stale version without taking the lease', async () => {
        const conn = executor([[held()]], [{ affectedRows: 1 }]);
        await expect(service.claimHeldOrder(conn, {
            id: 7, userId: 12, claimToken: TOKEN, expectedVersion: 3,
            now: new Date('2026-08-10T10:05:00.000Z')
        })).rejects.toMatchObject({ statusCode: 409, publicCode: 'HELD_VERSION_CONFLICT' });
        const updates = conn.query.mock.calls.map(([sql]) => sql).filter(sql => /^\s*UPDATE\b/i.test(sql));
        expect(updates).toEqual([]);
    });

    it('replays the last operation safely and omits secrets from the stored envelope', () => {
        const row = held({
            last_operation_id: 'op-1',
            last_operation_kind: 'save',
            last_operation_result: JSON.stringify({ version: 6, claim_token: TOKEN, cart_data: '{"phone":"secret"}' })
        });
        expect(service.readOperationReplay(row, 'op-1', 'save')).toEqual({ version: 6 });
        expect(service.readOperationReplay(row, 'op-2', 'save')).toBeNull();
        expect(service.safeOperationResult({ version: 6, claimToken: TOKEN, cartData: 'secret', warning: 'ok' }))
            .toEqual({ version: 6, warning: 'ok' });
    });
});
