const pool = require('../../config/db');
const { enqueuePrintJobs, enqueueCommittedPrintJobs } = require('../../services/printDispatch');
const {
    spoolerSyncWakeHub,
    commitAndPublishSpoolerSyncWake,
    safePublishSpoolerSyncWake
} = require('../../services/spoolerSyncWake');
const fs = require('fs');
const path = require('path');

function payload(invoiceId = 1) {
    return {
        printer_id: 1,
        printer_name: 'Receipt',
        print_type: 'receipt',
        data: { invoice_id: invoiceId }
    };
}

describe('spooler wake commit boundaries', () => {
    afterEach(() => vi.restoreAllMocks());

    it('keeps caller-owned transaction enqueue free of publication', async () => {
        const executor = { query: vi.fn().mockResolvedValue([{ insertId: 10 }]) };
        const before = spoolerSyncWakeHub.generation();

        await enqueuePrintJobs(executor, [payload()]);

        expect(spoolerSyncWakeHub.generation()).toBe(before);
    });

    it('publishes once after a successful non-empty autocommit batch', async () => {
        const query = vi.spyOn(pool, 'query').mockResolvedValue([{ insertId: 11 }]);
        const before = spoolerSyncWakeHub.generation();

        const queued = await enqueueCommittedPrintJobs([payload(1), payload(2)]);

        expect(queued).toHaveLength(2);
        expect(query).toHaveBeenCalled();
        expect(spoolerSyncWakeHub.generation()).toBe(before + 1);
    });

    it('does not publish an empty or failed autocommit batch', async () => {
        const before = spoolerSyncWakeHub.generation();
        await expect(enqueueCommittedPrintJobs([])).resolves.toEqual([]);
        expect(spoolerSyncWakeHub.generation()).toBe(before);

        vi.spyOn(pool, 'query').mockRejectedValue(new Error('insert failed'));
        await expect(enqueueCommittedPrintJobs([payload()])).rejects.toThrow('insert failed');
        expect(spoolerSyncWakeHub.generation()).toBe(before);
    });

    it('leaves a partially committed autocommit batch to cadence recovery without publishing', async () => {
        let inserts = 0;
        vi.spyOn(pool, 'query').mockImplementation(async (sql) => {
            if (/INSERT INTO print_queue/i.test(String(sql))) {
                inserts += 1;
                if (inserts === 2) throw new Error('second insert failed');
                return [{ insertId: 21 }];
            }
            return [[]];
        });
        const before = spoolerSyncWakeHub.generation();

        await expect(enqueueCommittedPrintJobs([payload(1), payload(2)]))
            .rejects.toThrow('second insert failed');

        expect(inserts).toBe(2);
        expect(spoolerSyncWakeHub.generation()).toBe(before);
    });

    it('may wake again for an idempotent duplicate without changing the returned row identity', async () => {
        vi.spyOn(pool, 'query').mockResolvedValue([{ insertId: 31 }]);
        const before = spoolerSyncWakeHub.generation();

        const first = await enqueueCommittedPrintJobs([payload(1)]);
        const duplicate = await enqueueCommittedPrintJobs([payload(1)]);

        expect(first[0].id).toBe(31);
        expect(duplicate[0].id).toBe(31);
        expect(spoolerSyncWakeHub.generation()).toBe(before + 2);
    });

    it('publishes only after commit succeeds and never on commit rejection', async () => {
        const order = [];
        const publish = vi.fn(() => order.push('publish'));
        const conn = { commit: vi.fn(async () => order.push('commit')) };

        await commitAndPublishSpoolerSyncWake(conn, publish);
        expect(order).toEqual(['commit', 'publish']);

        publish.mockClear();
        const failing = { commit: vi.fn().mockRejectedValue(new Error('commit failed')) };
        await expect(commitAndPublishSpoolerSyncWake(failing, publish)).rejects.toThrow('commit failed');
        expect(publish).not.toHaveBeenCalled();
    });

    it('contains publisher failure after durable work', () => {
        vi.spyOn(spoolerSyncWakeHub, 'publish').mockImplementation(() => {
            throw new Error('wake unavailable');
        });
        expect(() => safePublishSpoolerSyncWake()).not.toThrow();
    });

    it('places publication at each transaction owner rather than inside enqueue', () => {
        const read = relative => fs.readFileSync(path.join(__dirname, '../..', relative), 'utf8');
        const dispatch = read('services/printDispatch.js');
        const genericEnqueue = dispatch.slice(
            dispatch.indexOf('async function enqueuePrintJobs'),
            dispatch.indexOf('async function enqueueCommittedPrintJobs')
        );
        expect(genericEnqueue).not.toContain('safePublishSpoolerSyncWake');

        const seams = [
            ['services/printReprint.js', "eventType: 'print.reprint'"],
            ['services/spoolerAgents.js', "'spooler_agent_drain_requested'"],
            ['services/spoolerAgents.js', "'spooler_agent_replaced'"],
            ['routes/pos/orders.js', "eventType: 'held_order_follow_up_queued'"],
            ['routes/pos/orders.js', "eventType: 'held_order_canceled'"],
            ['routes/pos/orders.js', "eventType: 'held_order_kitchen_fired'"]
        ];
        for (const [file, durableAnchor] of seams) {
            const source = read(file);
            const durableAt = source.indexOf(durableAnchor);
            const publishAt = source.indexOf('commitAndPublishSpoolerSyncWake(conn)', durableAt);
            expect(durableAt, `${file}: missing durable anchor`).toBeGreaterThanOrEqual(0);
            expect(publishAt, `${file}: wake must follow durable work`).toBeGreaterThan(durableAt);
        }
    });
});
