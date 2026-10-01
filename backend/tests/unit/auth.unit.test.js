// unit/auth.unit.test.js — Unit tests for auth middleware helper functions and cache behavior
// We mock database query layer to make tests pure and isolated.

const pool = require('../../config/db');
const {
    hashToken,
    parseCookies,
    preWarmToken,
    verifyToken,
    invalidateToken,
    invalidateShiftTokens,
    invalidateUserSessions,
    setTokenShiftId,
    requireAuth,
} = require('../../middleware/auth');
const { actorKey } = require('../../middleware/rateLimit');

const PermissionService = require('../../services/PermissionService');

describe('Auth Helpers & Session Cache Unit Tests', () => {
    let mockQuery;
    let mockLoadPerms;

    beforeEach(() => {
        // Reset and create a new mock query on pool
        mockQuery = vi.spyOn(pool, 'query').mockImplementation(async () => {
            return [[]]; // Default empty result
        });
        mockLoadPerms = vi.spyOn(PermissionService, 'loadUserPermissions').mockImplementation(async () => {
            return [];
        });
    });

    afterEach(() => {
        mockQuery.mockRestore();
        mockLoadPerms.mockRestore();
    });

    // ─── 1. hashToken ─────────────────────────────────────────────────────────

    it('attaches a bound credential identity and falls back to the user for PIN sessions', async () => {
        const user = { id: 88, name: 'Rate Actor', role: 'cashier', is_active: 1 };
        preWarmToken('bound-rate-token', user, { credentialId: 501 });
        preWarmToken('pin-rate-token', user, { credentialId: null });
        const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        const bound = { headers: { cookie: 'pos_token=bound-rate-token' } };
        const pinOnly = { headers: { cookie: 'pos_token=pin-rate-token' } };

        await requireAuth(bound, response, vi.fn());
        await requireAuth(pinOnly, response, vi.fn());

        expect(bound.authCredentialId).toBe(501);
        expect(pinOnly.authCredentialId).toBeNull();
        expect(actorKey(bound)).toBe('credential:501');
        expect(actorKey(pinOnly)).toBe('user:88');
        expect(actorKey({ user, authCredentialId: 502 })).toBe('credential:502');
    });

    describe('hashToken', () => {
        it('hashes raw token using SHA-256 to a 64-character hex string', () => {
            const rawToken = 'my_raw_session_token_123';
            const hash = hashToken(rawToken);
            expect(hash).toHaveLength(64);
            expect(hash).toMatch(/^[0-9a-f]{64}$/);
            // SHA-256 of 'my_raw_session_token_123'
            expect(hash).toBe(require('crypto').createHash('sha256').update(rawToken).digest('hex'));
        });

        it('produces the same hash for the same input', () => {
            expect(hashToken('token')).toBe(hashToken('token'));
        });

        it('produces different hashes for different inputs', () => {
            expect(hashToken('token1')).not.toBe(hashToken('token2'));
        });

        it('handles non-string inputs by converting to string', () => {
            expect(hashToken(12345)).toBe(hashToken('12345'));
        });
    });

    // ─── 2. parseCookies ──────────────────────────────────────────────────────
    describe('parseCookies', () => {
        it('returns empty object when cookie header is undefined or null', () => {
            expect(parseCookies(undefined)).toEqual({});
            expect(parseCookies(null)).toEqual({});
            expect(parseCookies('')).toEqual({});
        });

        it('parses a single cookie key-value pair', () => {
            expect(parseCookies('pos_token=abc')).toEqual({ pos_token: 'abc' });
        });

        it('parses multiple cookies separated by semicolon', () => {
            const header = 'pos_token=token123; other_cookie=xyz; user_id=5';
            expect(parseCookies(header)).toEqual({
                pos_token: 'token123',
                other_cookie: 'xyz',
                user_id: '5'
            });
        });

        it('trims leading/trailing whitespace from keys and values', () => {
            const header = '  pos_token  =  token123  ;   other  =  val  ';
            expect(parseCookies(header)).toEqual({
                pos_token: 'token123',
                other: 'val'
            });
        });

        it('handles malformed key-value pairs gracefully', () => {
            const header = 'malformed; pos_token=abc;=val; key=';
            // 'malformed' has no '=' so it is ignored. '=val' has index 0 for '=', so idx > 0 is false, ignored.
            // 'key=' has idx > 0, so it parses to { key: '' }
            expect(parseCookies(header)).toEqual({
                pos_token: 'abc',
                key: ''
            });
        });
    });

    // ─── 3. preWarmToken & Cache Hit/Miss ─────────────────────────────────────
    describe('preWarmToken and verifyToken (Cache Hit / Miss)', () => {
        const testUser = { id: 10, name: 'Cashier John', role: 'cashier', is_active: 1 };

        it('preWarmToken populates cache, allowing verifyToken to hit cache (no DB query)', async () => {
            const rawToken = 'prewarmed_token_xyz';
            
            // Warm the cache
            preWarmToken(rawToken, testUser);

            // Verify the token
            const result = await verifyToken(rawToken);

            // Assertions
            expect(result).toEqual(testUser);
            expect(mockQuery).not.toHaveBeenCalled(); // No DB call!
        });

        it('rejects reserved order-intake actor sessions from cache and database', async () => {
            const previousActorId = process.env.ORDER_INTAKE_ACTOR_USER_ID;
            const actor = { id: 10, name: 'Machine Actor', role: 'call_center', is_active: 1 };
            try {
                delete process.env.ORDER_INTAKE_ACTOR_USER_ID;
                preWarmToken('reserved-cached-token', actor);
                process.env.ORDER_INTAKE_ACTOR_USER_ID = '10';
                expect(await verifyToken('reserved-cached-token')).toBeNull();
                expect(mockQuery).not.toHaveBeenCalled();

                mockQuery.mockResolvedValueOnce([[
                    {
                        session_id: 'reserved-session',
                        user_id: 10,
                        user_number: '9070',
                        name: 'Machine Actor',
                        role: 'call_center',
                        is_active: 1,
                        allowed_sections: null,
                        credential_id: 99,
                        device_auth_mode: 'enforced',
                        idle_expires_at: new Date(Date.now() + 60_000),
                        absolute_expires_at: new Date(Date.now() + 120_000),
                    },
                ]]);
                expect(await verifyToken('reserved-database-token')).toBeNull();
                expect(mockLoadPerms).not.toHaveBeenCalled();
            } finally {
                if (previousActorId == null) delete process.env.ORDER_INTAKE_ACTOR_USER_ID;
                else process.env.ORDER_INTAKE_ACTOR_USER_ID = previousActorId;
            }
        });

        it('verifyToken queries database on cache miss, and caches the user for subsequent hits', async () => {
            const rawToken = 'db_token_123';
            const tokenHash = hashToken(rawToken);
            const userFromDb = {
                session_id: 'session-12',
                user_id: 12,
                user_number: '9012',
                name: 'Admin Jane',
                role: 'admin',
                is_active: 1,
                allowed_sections: null,
                credential_id: null,
                device_auth_mode: 'disabled',
                idle_expires_at: new Date(Date.now() + 20 * 60 * 1000),
                absolute_expires_at: new Date(Date.now() + 60 * 60 * 1000),
            };

            // Mock DB to return user
            mockQuery.mockResolvedValue([[userFromDb]]);

            // First call (Cache Miss)
            const result1 = await verifyToken(rawToken);
            expect(result1).toEqual({ id: 12, user_number: '9012', name: 'Admin Jane', role: 'admin', is_active: 1, allowed_sections: null, permissions: [] });
            expect(mockQuery).toHaveBeenCalledTimes(1);
            expect(mockLoadPerms).toHaveBeenCalledWith(userFromDb.user_id, userFromDb.role);
            expect(mockQuery).toHaveBeenLastCalledWith(expect.stringContaining('FROM auth_sessions AS s'), [tokenHash]);

            // Second call (Cache Hit)
            mockQuery.mockClear();
            const result2 = await verifyToken(rawToken);
            expect(result2).toEqual({ id: 12, user_number: '9012', name: 'Admin Jane', role: 'admin', is_active: 1, allowed_sections: null, permissions: [] });
            expect(mockQuery).not.toHaveBeenCalled(); // Hit in-memory cache!
        });

        it('verifyToken returns null and deletes cache entry on database miss (e.g. if user deactivated)', async () => {
            const rawToken = 'deactivated_token';
            
            // First pre-warm to get it in cache
            preWarmToken(rawToken, testUser);

            // Mock DB to return empty (user deactivated or deleted)
            mockQuery.mockResolvedValue([[]]);

            // Set expiresAt to past to force cache miss / DB refresh
            // Wait, we cannot easily change expiresAt from outside, but we can mock Date.now()!
            const realNow = Date.now;
            Date.now = () => realNow() + 1000 * 60 * 60 * 24; // 1 day in the future (expires cache)

            try {
                const result = await verifyToken(rawToken);
                expect(result).toBeNull();
                expect(mockQuery).toHaveBeenCalledTimes(1);
            } finally {
                Date.now = realNow; // Restore
            }
        });

        it('verifyToken reports a failed database check as unavailable, not as an invalid session', async () => {
            const rawToken = 'error_token';
            mockQuery.mockRejectedValue(new Error('DB connection lost'));

            await expect(verifyToken(rawToken)).rejects.toMatchObject({ name: 'SessionCheckUnavailableError' });
            expect(mockQuery).toHaveBeenCalledTimes(1);
        });

        it('verifyToken returns null when rawToken is empty/null/undefined without hitting DB', async () => {
            expect(await verifyToken(null)).toBeNull();
            expect(await verifyToken(undefined)).toBeNull();
            expect(await verifyToken('')).toBeNull();
            expect(mockQuery).not.toHaveBeenCalled();
        });
    });

    // ─── 4. Invalidation ──────────────────────────────────────────────────────
    describe('Session Cache Invalidation', () => {
        const user1 = { id: 101, name: 'User 1', role: 'waiter', is_active: 1 };
        const user2 = { id: 102, name: 'User 2', role: 'cashier', is_active: 1 };

        it('invalidateToken evicts specific token from cache', async () => {
            const token = 'token_to_invalidate';
            preWarmToken(token, user1);

            // Verify it's cached
            expect(await verifyToken(token)).toEqual(user1);

            // Invalidate it
            invalidateToken(token);

            // DB mock returns empty so verifyToken returns null
            mockQuery.mockResolvedValue([[]]);
            expect(await verifyToken(token)).toBeNull();
            expect(mockQuery).toHaveBeenCalledTimes(1); // Hits DB due to cache miss
        });

        it('invalidateUserSessions evicts all tokens belonging to a specific user id', async () => {
            const token1 = 'token_u1_a';
            const token2 = 'token_u1_b';
            const token3 = 'token_u2';

            // Cache tokens
            preWarmToken(token1, user1);
            preWarmToken(token2, user1);
            preWarmToken(token3, user2);

            // Invalidate user1 sessions
            invalidateUserSessions(user1.id);

            // Setup DB mock to return empty
            mockQuery.mockResolvedValue([[]]);

            // User 1 tokens should be cache misses
            expect(await verifyToken(token1)).toBeNull();
            expect(await verifyToken(token2)).toBeNull();
            expect(mockQuery).toHaveBeenCalledTimes(2);

            // User 2 token should still be a cache hit
            mockQuery.mockClear();
            expect(await verifyToken(token3)).toEqual(user2);
            expect(mockQuery).not.toHaveBeenCalled();
        });

        it('setTokenShiftId updates shiftId, and invalidateShiftTokens evicts tokens for that shift', async () => {
            const token1 = 'token_s1';
            const token2 = 'token_s2';
            const token3 = 'token_other';

            preWarmToken(token1, user1);
            preWarmToken(token2, user2);

            setTokenShiftId(user1.id, 42);
            setTokenShiftId(user2.id, 43);

            // Add token3 after shift open, so it doesn't get shiftId 42
            preWarmToken(token3, user1);

            invalidateShiftTokens(42);

            mockQuery.mockResolvedValue([[]]);

            // Token 1 (User 1, shift 42) should be evicted
            expect(await verifyToken(token1)).toBeNull();
            expect(mockQuery).toHaveBeenCalledTimes(1);

            // Token 2 (User 2, shift 43) should still be cached
            mockQuery.mockClear();
            expect(await verifyToken(token2)).toEqual(user2);
            expect(mockQuery).not.toHaveBeenCalled();

            // Token 3 (User 1, null shift) should still be cached
            mockQuery.mockClear();
            expect(await verifyToken(token3)).toEqual(user1);
            expect(mockQuery).not.toHaveBeenCalled();
        });

        it('invalidateShiftTokens handles early returns and runs without errors', () => {
            expect(() => invalidateShiftTokens(null)).not.toThrow();
            expect(() => invalidateShiftTokens(undefined)).not.toThrow();
        });
    });
});
