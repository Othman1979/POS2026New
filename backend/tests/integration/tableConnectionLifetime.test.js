const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const { tableActionIntent } = require('../fixtures/tableActionIntent');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

// A pooled read after commit must not depend on a second lease: all other
// connections may be completing equivalent requests at the same time.
async function observeCompletedLeases(operation, { includeAuthorization = false } = {}) {
    const completed = new Set();
    const leased = new Set();
    const nestedReads = [];
    const originalGetConnection = pool.getConnection;
    const originalQuery = pool.query;
    pool.getConnection = async function (...args) {
        const conn = await originalGetConnection.apply(this, args);
        leased.add(conn);
        const commit = conn.commit;
        const release = conn.release;
        conn.commit = async function (...values) {
            const result = await commit.apply(this, values);
            completed.add(conn);
            return result;
        };
        conn.release = function (...values) {
            completed.delete(conn);
            leased.delete(conn);
            conn.commit = commit;
            conn.release = release;
            return release.apply(this, values);
        };
        return conn;
    };
    pool.query = function (...args) {
        const sql = String(args[0]);
        // Authorization reads are awaited; its independent, asynchronous audit
        // writes may overlap a later transaction without making it wait for them.
        const authorizationRead = sql.includes('role, admin_pin FROM users')
            || sql.includes('FROM permissions WHERE overridable = 1');
        if (completed.size || (includeAuthorization && authorizationRead && leased.size)) {
            nestedReads.push(sql.trim().split('\n')[0]);
        }
        return originalQuery.apply(this, args);
    };
    try {
        const response = await operation();
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(completed.size).toBe(0);
        expect(nestedReads).toEqual([]);
        return response;
    } finally {
        pool.getConnection = originalGetConnection;
        pool.query = originalQuery;
    }
}

describe('table operations return completed leases before pooled follow-up reads', () => {
    let cookie;
    const cart = [{ id: SEED.product1.id, qty: 1, price: 5 }];
    const post = (path, body) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const save = (tableId = SEED.table.id) => post('table_order', { table_id: tableId, cart, subtotal: 5, tax: 0.8, total: 5.8 });

    beforeEach(async () => {
        if (process.env.POSAPP_REVIEW_CONNECTION_LIMIT) {
            expect(pool.pool.config.connectionLimit).toBe(Number(process.env.POSAPP_REVIEW_CONNECTION_LIMIT));
        }
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        cookie = login.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    it('saves and announces a table with its kitchen follow-up complete', async () => {
        const result = await observeCompletedLeases(() => save());
        expect(global.__mockEmit__).toHaveBeenCalledWith('table_update', expect.objectContaining({
            table: expect.objectContaining({ current_order_id: result.body.invoice_id })
        }));
    });

    it('clears an empty table', async () => {
        await observeCompletedLeases(() => post('table_order', { table_id: SEED.table.id, cart: [] }));
    });

    it('marks a saved table printed', async () => {
        const saved = await save();
        await observeCompletedLeases(() => post('table_order', {
            action: 'mark_printed', table_id: SEED.table.id, expected_invoice_id: saved.body.invoice_id
        }));
    });

    it('voids saved food and announces the freed table', async () => {
        const saved = await save();
        await observeCompletedLeases(async () => post('refunds', { invoice_id: saved.body.invoice_id, expected_version: await currentTableRevision(saved.body.invoice_id), intent: 'void', reason: 'Cancelled' }));
    });

    it('settles a saved table and releases its live floor-plan row', async () => {
        const saved = await save();
        await observeCompletedLeases(() => post('checkout', {
            cart, table_id: SEED.table.id, edit_invoice_id: saved.body.invoice_id,
            subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 10, change_due: 4.2,
            idempotency_key: 'connection-lifetime-table'
        }));
        const [[table]] = await pool.query('SELECT current_order_id,status FROM restaurant_tables WHERE id=?', [SEED.table.id]);
        expect(table).toMatchObject({ current_order_id: null, status: 'available' });
    });

    it('joins then disjoins a table group', async () => {
        await observeCompletedLeases(() => post('tables/join', { parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] }));
        await observeCompletedLeases(() => post('tables/disjoin', { tableIds: [SEED.table2.id] }));
    });

    it('authorizes join and disjoin manager PINs before borrowing the transaction connection', async () => {
        await pool.query('DELETE FROM user_permissions WHERE user_id=?', [SEED.waiterUser.id]);
        const loginWaiter = async () => {
            const login = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
            cookie = login.headers['set-cookie'][0];
        };
        await loginWaiter();
        await observeCompletedLeases(() => post('tables/join', {
            parentTableId: SEED.table.id, childTableIds: [SEED.table2.id], managerPin: SEED.adminUser.pin
        }), { includeAuthorization: true });
        await loginWaiter();
        await observeCompletedLeases(() => post('tables/disjoin', { tableIds: [SEED.table2.id], managerPin: SEED.adminUser.pin }), { includeAuthorization: true });
        const [[table]] = await pool.query('SELECT parent_table_id FROM restaurant_tables WHERE id=?', [SEED.table2.id]);
        expect(table.parent_table_id).toBeNull();
    });

    it.each(['transfer', 'merge'])('%s returns its table lease', async (action) => {
        await save();
        if (action === 'merge') await save(SEED.table2.id);
        await observeCompletedLeases(async () => post('tables/transfer', await tableActionIntent(pool, {
            sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action
        })));
    });

    it('creates, rewrites and cancels unpaid splits', async () => {
        const saved = await save();
        await observeCompletedLeases(() => post('table_splits/split', {
            tableId: SEED.table.id, currentOrderId: saved.body.invoice_id,
            splits: [{ referenceName: 'Seat 1', subtotal: 5.8, items: [{ ...cart[0], tax_rate: 16 }] }]
        }));
        const [[split]] = await pool.query('SELECT id,cart_data FROM held_orders WHERE parent_invoice_id=?', [saved.body.invoice_id]);
        const payload = JSON.parse(split.cart_data);
        await observeCompletedLeases(() => request(app).put('/api/pos/table_splits').set('Cookie', cookie).send({
            splitId: split.id,
            expectedChecks: [{ id: split.id, revision: payload.split_revision }],
            splits: [{ id: split.id, referenceName: 'Renamed seat', items: payload.items }]
        }));
        await observeCompletedLeases(() => request(app).delete(`/api/pos/table_splits?id=${split.id}`).set('Cookie', cookie));
    });
});
