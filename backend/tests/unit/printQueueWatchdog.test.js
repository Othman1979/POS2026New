const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const {
    createPrintQueueHealthLogger,
    createStalePrintStationsBroadcaster,
    getFailedPrintJobsCount,
    getLatestFailedPrintJobsCount,
    getPrintQueueHealth,
    refreshFailedPrintJobsCount,
    resetLatestFailedPrintJobsCount,
    getStalePrintStations,
    normalizePrintQueueHealthRows
} = require('../../services/printQueueWatchdog');

describe('print queue watchdog helpers', () => {
    it('normalizes queue health rows without payload fields', () => {
        const rows = normalizePrintQueueHealthRows([
            { status: 'failed', count: '2', oldest_created_at: '2026-07-05 10:00:00' },
            { status: 'dead_letter', count: 1, oldest_created_at: null }
        ]);

        expect(rows).toEqual([
            { status: 'failed', count: 2, oldest_created_at: '2026-07-05 10:00:00' },
            { status: 'dead_letter', count: 1, oldest_created_at: null }
        ]);
        expect(JSON.stringify(rows)).not.toContain('payload');
    });

    it('logs only when health summary changes', () => {
        const logger = { warn: vi.fn() };
        const logHealthChange = createPrintQueueHealthLogger(logger);
        const rows = [{ status: 'failed', count: 1, oldest_created_at: '2026-07-05 10:00:00' }];

        expect(logHealthChange(rows)).toBe(true);
        expect(logHealthChange(rows)).toBe(false);
        expect(logHealthChange([{ status: 'failed', count: 2, oldest_created_at: '2026-07-05 10:00:00' }])).toBe(true);
        expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    describe('refreshFailedPrintJobsCount', () => {
        function gatedDb() {
            const gates = [];
            return {
                gates,
                query: vi.fn(() => new Promise(resolve => gates.push(count => resolve([[{ count }]]))))
            };
        }
        beforeEach(() => resetLatestFailedPrintJobsCount());

        it('lets the latest-started read win when an older read finishes last', async () => {
            const db = gatedDb();
            const publish = vi.fn();
            const older = refreshFailedPrintJobsCount(db, publish);
            const newer = refreshFailedPrintJobsCount(db, publish);
            db.gates[1](0); // newer read lands first
            await newer;
            db.gates[0](5); // stale read lands afterwards
            await older;
            expect(getLatestFailedPrintJobsCount()).toBe(0);
            expect(publish.mock.calls).toEqual([[0]]);
        });

        it('publishes only when the cached count changes', async () => {
            const publish = vi.fn();
            const db = { query: vi.fn().mockResolvedValue([[{ count: 2 }]]) };
            await refreshFailedPrintJobsCount(db, publish);
            await refreshFailedPrintJobsCount(db, publish);
            expect(publish.mock.calls).toEqual([[2]]);
        });

        it('retries the publish on the next refresh when an emit failed', async () => {
            const db = { query: vi.fn().mockResolvedValue([[{ count: 4 }]]) };
            const publish = vi.fn().mockImplementationOnce(() => { throw new Error('emit failed'); });
            await expect(refreshFailedPrintJobsCount(db, publish)).rejects.toThrow('emit failed');
            expect(getLatestFailedPrintJobsCount()).toBe(4); // observed: connecting sockets still get it
            await refreshFailedPrintJobsCount(db, publish);
            await refreshFailedPrintJobsCount(db, publish);
            expect(publish.mock.calls).toEqual([[4], [4]]); // retried once, then delivered
        });

        it('discards reads still in flight when the cache is reset', async () => {
            const db = gatedDb();
            const publish = vi.fn();
            const inFlight = refreshFailedPrintJobsCount(db, publish);
            resetLatestFailedPrintJobsCount();
            db.gates[0](9);
            await inFlight;
            expect(getLatestFailedPrintJobsCount()).toBeNull();
            expect(publish).not.toHaveBeenCalled();
        });
    });

    it('counts failed and dead_letter rows for the staff badge', async () => {
        const db = { query: vi.fn().mockResolvedValue([[{ count: 4 }]]) };
        await expect(getFailedPrintJobsCount(db)).resolves.toBe(4);
        expect(db.query.mock.calls[0][1][0]).toEqual(['failed', 'dead_letter']);
    });

    it('treats missing print_queue as not ready instead of noisy failure', async () => {
        const db = {
            query: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' }))
        };

        await expect(getPrintQueueHealth(db)).resolves.toEqual([]);
    });

    it('returns stations with queued work whose agent is missing or stale', async () => {
        await seedDatabase();
        await pool.query("INSERT INTO spooler_stations (spooler_id, delivery_protocol) VALUES ('stale-a', 'v2'), ('fresh-b', 'v2'), ('stale-c', 'v2'), ('no-agent-d', 'v2')");
        // 'unregistered-e' deliberately has NO spooler_stations row: that row is only
        // created by registerAgent (spoolerAgents.js:32) and no FK forces it to exist,
        // so a station whose agent never came up must still surface.
        const [printers] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('A', 'kitchen', 'windows', 'A', 'stale-a'), ('B', 'kitchen', 'windows', 'B', 'fresh-b'), ('C', 'kitchen', 'windows', 'C', 'stale-c'), ('D', 'kitchen', 'windows', 'D', 'no-agent-d'), ('E', 'kitchen', 'windows', 'E', 'unregistered-e')"
        );
        const firstId = printers.insertId;
        await pool.query(
            `INSERT INTO spooler_agents (agent_id, spooler_id, token_hash, name, status, last_sync_at) VALUES
                ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'stale-a', REPEAT('a', 64), 'A', 'active', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 MINUTE)),
                ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'fresh-b', REPEAT('b', 64), 'B', 'active', UTC_TIMESTAMP()),
                ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'stale-c', REPEAT('c', 64), 'C', 'active', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 MINUTE))`
        );
        await pool.query(
            "INSERT INTO print_queue (payload, printer_id, print_type, status) VALUES ('{}', ?, 'kitchen', 'pending'), ('{}', ?, 'kitchen', 'pending'), ('{}', ?, 'kitchen', 'pending'), ('{}', ?, 'kitchen', 'pending')",
            [firstId, firstId + 1, firstId + 3, firstId + 4]
        );

        const stations = await getStalePrintStations(pool, { staleMs: 120000 });
        const byId = Object.fromEntries(stations.map(row => [row.spooler_id, row]));

        expect(byId['stale-a'].queued).toBeGreaterThanOrEqual(1);
        expect(byId['fresh-b']).toBeUndefined();
        expect(byId['stale-c']).toBeUndefined();
        expect(byId['no-agent-d'].queued).toBeGreaterThanOrEqual(1);
        expect(byId['unregistered-e'].queued).toBeGreaterThanOrEqual(1);
        expect(stations.map(row => row.spooler_id).sort()).toEqual(['no-agent-d', 'stale-a', 'unregistered-e']);
    });

    it('emits { stations: [] } when the stale set becomes empty and ignores last_sync_at motion', () => {
        const emitted = [];
        const broadcast = createStalePrintStationsBroadcaster(payload => emitted.push(payload));
        const stale = [{ spooler_id: 'stale-a', last_sync_at: 't1', queued: 1 }];

        expect(broadcast(stale)).toBe(true);
        expect(broadcast([{ ...stale[0], last_sync_at: 't2' }])).toBe(false);
        expect(broadcast([])).toBe(true);
        expect(emitted).toEqual([
            { stations: stale },
            { stations: [] }
        ]);
    });
});

afterAll(async () => {
    await pool.end();
});
