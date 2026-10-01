const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { createPrintQueuePurge } = require('../../services/printQueuePurge');
const { getFailedPrintJobsCount } = require('../../services/printQueueWatchdog');

const NOW = new Date('2026-08-30T10:00:00.000Z');
const OLD_CREATED = '2026-08-29 01:00:00';
const OLD_ACKNOWLEDGED = '2026-08-29 02:00:00';
const CURRENT = '2026-08-30 04:00:00';

async function insertQueue({ key, status, createdAt, acknowledgedAt = null, reprintOfQueueId = null }) {
    const [result] = await pool.query(
        `INSERT INTO print_queue (
            idempotency_key, payload, print_type, status, created_at, acknowledged_at, reprint_of_queue_id
         ) VALUES (?, '{}', 'receipt', ?, ?, ?, ?)`,
        [key, status, createdAt, acknowledgedAt, reprintOfQueueId]
    );
    return result.insertId;
}

describe('acknowledged print queue purge', () => {
    beforeEach(async () => seedDatabase());
    afterAll(async () => pool.end());

    it('removes only successful rows created and acknowledged before the business day', async () => {
        const statuses = ['pending', 'processing', 'sent', 'failed', 'dead_letter', 'canceled', 'local_accepted', 'cancel_requested'];
        for (const status of statuses) {
            await insertQueue({ key: `keep-status-${status}`, status, createdAt: OLD_CREATED, acknowledgedAt: OLD_ACKNOWLEDGED });
        }
        const eligibleId = await insertQueue({ key: 'purge-old-success', status: 'acknowledged', createdAt: OLD_CREATED, acknowledgedAt: OLD_ACKNOWLEDGED });
        await insertQueue({ key: 'keep-late-ack', status: 'acknowledged', createdAt: OLD_CREATED, acknowledgedAt: CURRENT });
        await insertQueue({ key: 'keep-current-success', status: 'acknowledged', createdAt: CURRENT, acknowledgedAt: CURRENT });
        await insertQueue({ key: 'keep-null-ack', status: 'acknowledged', createdAt: OLD_CREATED, acknowledgedAt: null });

        const purge = createPrintQueuePurge({ db: pool, logger: { info() {}, warn() {} }, now: () => NOW });
        await expect(purge.runBatch()).resolves.toBe(1);

        const [rows] = await pool.query('SELECT id, idempotency_key FROM print_queue ORDER BY id');
        expect(rows.some(row => Number(row.id) === Number(eligibleId))).toBe(false);
        expect(rows.map(row => row.idempotency_key)).toEqual(expect.arrayContaining([
            'keep-late-ack', 'keep-current-success', 'keep-null-ack',
            ...statuses.map(status => `keep-status-${status}`)
        ]));
    });

    it('resolves a legacy dead-letter parent before its acknowledged reprint is purged', async () => {
        const parentId = await insertQueue({
            key: 'legacy-reprint-parent', status: 'dead_letter', createdAt: OLD_CREATED
        });
        const childId = await insertQueue({
            key: 'legacy-reprint-child', status: 'acknowledged', createdAt: OLD_CREATED,
            acknowledgedAt: OLD_ACKNOWLEDGED, reprintOfQueueId: parentId
        });
        const purge = createPrintQueuePurge({ db: pool, logger: { info() {}, warn() {} }, now: () => NOW });

        expect(await getFailedPrintJobsCount(pool)).toBe(0);
        await expect(purge.runBatch()).resolves.toBe(0);
        expect(await getFailedPrintJobsCount(pool)).toBe(0);

        const [[parent]] = await pool.query('SELECT status, acknowledged_at FROM print_queue WHERE id=?', [parentId]);
        expect(parent.status).toBe('acknowledged');
        expect(parent.acknowledged_at).not.toBeNull();
        const [[child]] = await pool.query('SELECT status FROM print_queue WHERE id=?', [childId]);
        expect(child.status).toBe('acknowledged');

        await expect(purge.runBatch()).resolves.toBe(1);
        expect(await getFailedPrintJobsCount(pool)).toBe(0);
    });

    it('resolves every dead-letter ancestor before purging a successful reprint chain', async () => {
        const originalId = await insertQueue({
            key: 'reprint-chain-original', status: 'dead_letter', createdAt: OLD_CREATED
        });
        const failedReprintId = await insertQueue({
            key: 'reprint-chain-failed', status: 'dead_letter', createdAt: OLD_CREATED,
            reprintOfQueueId: originalId
        });
        await insertQueue({
            key: 'reprint-chain-success', status: 'acknowledged', createdAt: OLD_CREATED,
            acknowledgedAt: OLD_ACKNOWLEDGED, reprintOfQueueId: failedReprintId
        });
        const purge = createPrintQueuePurge({ db: pool, logger: { info() {}, warn() {} }, now: () => NOW });

        expect(await getFailedPrintJobsCount(pool)).toBe(0);
        await expect(purge.runBatch()).resolves.toBe(0);
        await expect(purge.runBatch()).resolves.toBe(0);
        expect(await getFailedPrintJobsCount(pool)).toBe(0);

        const [ancestors] = await pool.query(
            'SELECT id, status, acknowledged_at FROM print_queue WHERE id IN (?,?) ORDER BY id',
            [originalId, failedReprintId]
        );
        expect(ancestors).toEqual([
            expect.objectContaining({ id: originalId, status: 'acknowledged' }),
            expect.objectContaining({ id: failedReprintId, status: 'acknowledged' })
        ]);
        expect(ancestors.every(row => row.acknowledged_at != null)).toBe(true);

        await expect(purge.runBatch()).resolves.toBe(1);
        expect(await getFailedPrintJobsCount(pool)).toBe(0);
    });

    it('deletes at most 500 rows per statement and releases old idempotency keys', async () => {
        const values = Array.from({ length: 501 }, (_, index) => [
            `purge-bulk-${index}`, '{}', 'receipt', 'acknowledged', OLD_CREATED, OLD_ACKNOWLEDGED
        ]);
        await pool.query(
            `INSERT INTO print_queue (idempotency_key, payload, print_type, status, created_at, acknowledged_at)
             VALUES ?`,
            [values]
        );
        const currentValues = Array.from({ length: 2000 }, (_, index) => [
            `keep-current-${index}`, '{}', 'receipt', 'pending', CURRENT, null
        ]);
        await pool.query(
            `INSERT INTO print_queue (idempotency_key, payload, print_type, status, created_at, acknowledged_at)
             VALUES ?`,
            [currentValues]
        );
        await pool.query('ANALYZE TABLE print_queue');
        const cutoff = '2026-08-30 03:00:00';
        const [plan] = await pool.query(
            `EXPLAIN SELECT id FROM print_queue FORCE INDEX (idx_print_queue_state_created)
              WHERE status='acknowledged'
                AND created_at < ?
                AND acknowledged_at IS NOT NULL
                AND acknowledged_at < ?
              ORDER BY created_at,id
              LIMIT 500`,
            [cutoff, cutoff]
        );
        expect(plan[0].key).toBe('idx_print_queue_state_created');
        expect(String(plan[0].Extra || '').toLowerCase()).not.toContain('filesort');

        const purge = createPrintQueuePurge({ db: pool, logger: { info() {}, warn() {} }, now: () => NOW });
        await expect(purge.runBatch()).resolves.toBe(500);
        await expect(purge.runBatch()).resolves.toBe(1);
        await expect(purge.runBatch()).resolves.toBe(0);

        await expect(insertQueue({
            key: 'purge-bulk-0',
            status: 'pending',
            createdAt: CURRENT
        })).resolves.toBeTruthy();
    });
});
