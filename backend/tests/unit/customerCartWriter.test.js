const { createCustomerCartWriter } = require('../../services/customerCartWriter');

// A database whose writes finish only when the test says so.
function controlledDb() {
    const writes = [];
    return {
        writes,
        query: vi.fn((sql, params) => new Promise(resolve => {
            writes.push({ cart: params[1], done: () => resolve([{}]) });
        })),
    };
}

function subject() {
    const db = controlledDb();
    const writer = createCustomerCartWriter({
        db,
        io: {},
        logger: { error: vi.fn() },
        broadcastTableDraftChanged: vi.fn(async () => {}),
    });
    return { db, writer };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('customer cart writer', () => {
    it('cancel during a running write keeps the table serialized until that write lands', async () => {
        const { db, writer } = subject();
        writer.queue(1, [{ n: 1 }]);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(db.writes).toHaveLength(1);

        writer.cancel(1); // token regenerated while the old cart is still being written
        writer.queue(1, [{ n: 2 }]); // the new party's cart
        const flushed = writer.flush(1); // a staff read right after
        await settle();
        // No second, overlapping write while the first is still running.
        expect(db.writes).toHaveLength(1);

        db.writes[0].done();
        await settle();
        expect(db.writes).toHaveLength(2);
        expect(JSON.parse(db.writes[1].cart)).toEqual([{ n: 2 }]);
        db.writes[1].done();
        await flushed;
        writer.shutdown();
    });

    it('cancel with nothing running frees the table at once', () => {
        const { writer } = subject();
        writer.queue(1, [{ n: 1 }]);
        writer.cancel(1);
        expect(writer.size()).toBe(0);
        writer.shutdown();
    });
    it('shutdown writes carts still pending, including one waiting behind a running write', async () => {
        const { db, writer } = subject();
        writer.queue(1, [{ n: 1 }]);
        writer.queue(2, [{ n: 9 }]);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(db.writes).toHaveLength(2); // both first writes are running
        writer.queue(1, [{ n: 2 }]); // waits for the cooldown

        const drained = writer.shutdown();
        writer.queue(1, [{ n: 3 }]); // a late cart after shutdown is refused
        db.writes[0].done();
        db.writes[1].done();
        await settle();
        expect(db.writes).toHaveLength(3);
        expect(JSON.parse(db.writes[2].cart)).toEqual([{ n: 2 }]);
        db.writes[2].done();
        await drained;
        expect(db.writes).toHaveLength(3);
        expect(writer.size()).toBe(0);
    });

    it('shutdown gives up at its timeout when the database never answers', async () => {
        const { db, writer } = subject();
        writer.queue(1, [{ n: 1 }]);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(db.writes).toHaveLength(1); // never completes
        const started = Date.now();
        await writer.shutdown(60);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(writer.size()).toBe(0);
    });
});
