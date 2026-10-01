import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

vi.spyOn(crypto, 'randomUUID')
    .mockReturnValue('00000000-0000-4000-8000-000000000001');
vi.spyOn(crypto, 'randomBytes')
    .mockReturnValue(Buffer.alloc(32, 0x2a));

let service;

beforeAll(async () => {
    service = (await import('../../services/ServiceChargeSnapshotService.js')).default;
});
afterEach(() => vi.clearAllMocks());
afterAll(() => vi.restoreAllMocks());

const connection = (...results) => {
    const query = vi.fn();
    for (const result of results) query.mockResolvedValueOnce(result);
    return { query };
};

const snapshot = (overrides = {}) => ({
    id: 'snapshot-1',
    percentage: '10.0000',
    tax_rate: '5.00',
    state: 'draft',
    holder_type: 'none',
    holder_id: null,
    claim_token_hash: null,
    created_by: 1,
    version: 1,
    expires_at: new Date(Date.now() + 60_000),
    ...overrides
});

describe('ServiceChargeSnapshotService', () => {
    it('creates a 24-hour draft using generated UUID', async () => {
        const now = new Date('2026-07-11T10:00:00.000Z');
        const conn = connection([{}], [{ affectedRows: 1 }]);

        const created = await service.createDraft(conn, {
            userId: 1,
            percentage: 10,
            taxRate: 5,
            now
        });

        expect(created).toMatchObject({
            id: '00000000-0000-4000-8000-000000000001',
            percentage: 10,
            taxRate: 5,
            version: 1,
            state: 'draft'
        });
        expect(created.expiresAt.toISOString()).toBe('2026-07-12T10:00:00.000Z');
        expect(conn.query.mock.calls[1][1]).toContain(now);
    });

    it('rejects an expired draft before issuing an update', async () => {
        const conn = connection([[snapshot({ expires_at: new Date(Date.now() - 1) })]]);

        await expect(service.bindDraft(conn, {
            snapshotId: 'snapshot-1', version: 1, userId: 1,
            state: 'finalized', holderType: 'order', holderId: '10'
        })).rejects.toMatchObject({
            statusCode: 409,
            publicCode: 'SERVICE_CHARGE_SNAPSHOT_EXPIRED'
        });
        expect(conn.query).toHaveBeenCalledTimes(1);
    });

    it('rejects a draft owned by another creator before update', async () => {
        const conn = connection([[snapshot({ created_by: 2 })]]);

        await expect(service.bindDraft(conn, {
            snapshotId: 'snapshot-1', version: 1, userId: 1,
            state: 'finalized', holderType: 'order', holderId: '10'
        })).rejects.toMatchObject({ statusCode: 409 });
        expect(conn.query).toHaveBeenCalledTimes(1);
    });

    it('reports a compare-and-swap version conflict', async () => {
        const conn = connection([[snapshot()]], [{ affectedRows: 0 }]);

        await expect(service.bindDraft(conn, {
            snapshotId: 'snapshot-1', version: 1, userId: 1,
            state: 'finalized', holderType: 'order', holderId: '10'
        })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('stores only the SHA-256 claim-token hash', async () => {
        const held = snapshot({ state: 'held', holder_type: 'held_order', holder_id: '7', version: 2 });
        const conn = connection([[held]], [{ affectedRows: 1 }]);

        const claimed = await service.claimHeld(conn, {
            snapshotId: held.id,
            version: 2,
            heldOrderId: 7,
            userId: 9
        });

        const token = Buffer.alloc(32, 0x2a).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        expect(claimed.claimToken).toBe(token);
        expect(conn.query.mock.calls[1][1]).toContain(tokenHash);
        expect(conn.query.mock.calls[1][1]).not.toContain(token);
        expect(conn.query.mock.calls[1][1][2]).toBe('9');
    });

    it('consumes a matching claim once and clears its hash', async () => {
        const token = Buffer.alloc(32, 0x2a).toString('hex');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        const claimed = snapshot({ state: 'claimed', holder_type: 'claim', holder_id: '1', claim_token_hash: hash, version: 3 });
        const conn = connection([[claimed]], [{ affectedRows: 1 }]);

        await service.consumeClaim(conn, {
            snapshotId: claimed.id,
            version: 3,
            claimToken: token,
            userId: 1,
            to: 'finalized',
            holderType: 'order',
            holderId: '99'
        });

        expect(conn.query.mock.calls[1][1][3]).toBeNull();
    });

    it('rejects replay when state or token hash is already consumed', async () => {
        const conn = connection([[snapshot({ state: 'finalized', claim_token_hash: null, version: 4 })]]);

        await expect(service.consumeClaim(conn, {
            snapshotId: 'snapshot-1', version: 4, claimToken: 'used',
            userId: 1,
            to: 'finalized', holderType: 'order', holderId: '99'
        })).rejects.toMatchObject({ statusCode: 409 });
        expect(conn.query).toHaveBeenCalledTimes(1);
    });

    it('rejects illegal transitions without update', async () => {
        const conn = connection();

        await expect(service.transition(conn, {
            snapshotId: 'snapshot-1', version: 1,
            from: 'finalized', to: 'held', holderType: 'held_order', holderId: '7'
        })).rejects.toMatchObject({ statusCode: 409 });
        expect(conn.query).not.toHaveBeenCalled();
    });

    it('touches an open order once and rejects a stale duplicate', async () => {
        const conn = connection([{ affectedRows: 1 }], [{ affectedRows: 0 }]);

        await expect(service.touchOpenOrder(conn, {
            snapshotId: 'snapshot-1', version: 4, orderId: 9
        })).resolves.toBe(5);
        await expect(service.touchOpenOrder(conn, {
            snapshotId: 'snapshot-1', version: 4, orderId: 9
        })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('allows direct split settlement from held to finalized', async () => {
        const conn = connection([{ affectedRows: 1 }]);

        await expect(service.transition(conn, {
            snapshotId: 'snapshot-1', version: 2,
            from: 'held', to: 'finalized', holderType: 'order', holderId: '12'
        })).resolves.toBe(3);
    });

    it('abandons a claimed snapshot and clears its token hash', async () => {
        const token = Buffer.alloc(32, 0x2a).toString('hex');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        const claimed = snapshot({ state: 'claimed', holder_type: 'claim', holder_id: '1', claim_token_hash: hash, version: 3 });
        const conn = connection([[claimed]], [{ affectedRows: 1 }]);

        await service.consumeClaim(conn, {
            snapshotId: claimed.id, version: 3, claimToken: token,
            userId: 1,
            to: 'abandoned', holderType: 'none', holderId: null
        });

        expect(conn.query.mock.calls[1][1]).toEqual([
            'abandoned', 'none', null, null, claimed.id, 'claimed', 3
        ]);
    });

    it('rejects a valid claim token presented by another user', async () => {
        const token = Buffer.alloc(32, 0x2a).toString('hex');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        const claimed = snapshot({
            state: 'claimed', holder_type: 'claim', holder_id: '9',
            claim_token_hash: hash, version: 3
        });
        const conn = connection([[claimed]]);

        await expect(service.consumeClaim(conn, {
            snapshotId: claimed.id, version: 3, claimToken: token, userId: 10,
            to: 'finalized', holderType: 'order', holderId: '99'
        })).rejects.toMatchObject({ statusCode: 409 });
        expect(conn.query).toHaveBeenCalledTimes(1);
    });

    it('cleanup targets only expired drafts, old abandoned, and old orphaned claimed rows', async () => {
        const conn = connection([{ affectedRows: 2 }]);
        const now = new Date('2026-07-11T12:00:00.000Z');

        await service.cleanupExpiredDrafts(conn, now);

        const [sql, params] = conn.query.mock.calls[0];
        expect(sql).toContain("state='draft'");
        expect(sql).toContain("state='abandoned'");
        expect(sql).toContain("state='claimed'");
        // Never reap a snapshot bound to a live order or parked hold.
        expect(sql).not.toMatch(/state='(?:held|open_order|split_parent|finalized)'/);
        expect(params).toEqual([now, now, now]);
    });

    it('rehomes an open-order snapshot to a new order under version CAS', async () => {
        const conn = connection([{ affectedRows: 1 }]);

        const next = await service.rehomeOpenOrder(conn, {
            snapshotId: 'snap-1', version: 4, fromOrderId: 101, toOrderId: 202
        });

        expect(next).toBe(5);
        const [sql, params] = conn.query.mock.calls[0];
        expect(sql).toContain("state='open_order'");
        expect(sql).toContain('version=version+1');
        expect(params).toEqual(['202', 'snap-1', '101', 4]);
    });

    it('rejects a rehome when version or holder does not match', async () => {
        const conn = connection([{ affectedRows: 0 }]);

        await expect(service.rehomeOpenOrder(conn, {
            snapshotId: 'snap-1', version: 3, fromOrderId: 101, toOrderId: 202
        })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('abandons an open-order snapshot only for its owning order', async () => {
        const conn = connection([{ affectedRows: 1 }]);

        const next = await service.abandonOpenOrder(conn, {
            snapshotId: 'snap-1', version: 4, orderId: 101
        });

        expect(next).toBe(5);
        const [sql, params] = conn.query.mock.calls[0];
        expect(sql).toContain("state='open_order'");
        expect(sql).toContain("holder_type='order'");
        expect(sql).toContain('holder_id=?');
        expect(params).toEqual(['snap-1', '101', 4]);
    });

    it('rejects open-order abandonment for a stale version or wrong holder', async () => {
        const conn = connection([{ affectedRows: 0 }]);

        await expect(service.abandonOpenOrder(conn, {
            snapshotId: 'snap-1', version: 3, orderId: 999
        })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('allows the open_order -> abandoned transition', async () => {
        const conn = connection([{ affectedRows: 1 }]);

        const next = await service.transition(conn, {
            snapshotId: 'snap-1', version: 2, from: 'open_order', to: 'abandoned',
            holderType: 'none', holderId: null
        });

        expect(next).toBe(3);
    });

    it('still rejects finalized -> abandoned without touching the database', async () => {
        const conn = connection([]);

        await expect(service.transition(conn, {
            snapshotId: 'snap-1', version: 2, from: 'finalized', to: 'abandoned',
            holderType: 'none', holderId: null
        })).rejects.toMatchObject({ statusCode: 409 });
        expect(conn.query).not.toHaveBeenCalled();
    });

    it('cleanup preserves abandoned snapshots referenced by financial records', async () => {
        const conn = connection([{ affectedRows: 0 }]);
        const now = new Date('2026-07-11T12:00:00.000Z');

        await service.cleanupExpiredDrafts(conn, now);

        const [sql, params] = conn.query.mock.calls[0];
        expect(sql).toContain('LEFT JOIN orders');
        expect(sql).toContain('LEFT JOIN held_orders');
        expect(sql).toContain('LEFT JOIN service_charge_snapshots child');
        expect(sql).toContain('parent_snapshot_id');
        expect(params).toEqual([now, now, now]);
    });
});
