const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

// A stalled stock-scope lookup must never delay the answer to the till.
describe('stock event scope stays off the response path', () => {
    let cookie, stall;
    const post = (path, body) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const stockEvents = () => global.__mockEmit__.mock.calls.filter(([event]) => event === 'inventory_changed');
    const line = { id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: 5 };

    // Stalls only the scope lookup; every other pool query runs normally.
    const stallLookups = () => {
        const original = pool.query.bind(pool);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const spy = vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
            String(sql?.sql ?? sql).includes('max_statement_time') ? gate : original(sql, ...rest));
        return { release: () => release([[]]), restore: () => spy.mockRestore() };
    };
    const answersWhileStalled = async (send) => {
        stall = stallLookups();
        global.__mockEmit__.mockClear();
        const res = await send();
        expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
        // The lookup is still stalled, so the response did not wait for it.
        expect(stockEvents()).toEqual([]);
        stall.release();
        await vi.waitFor(() => expect(stockEvents()).toEqual([['inventory_changed', { scope: 'stock', productIds: [SEED.product1.id] }]]));
        stall.restore();
        return res;
    };

    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    });
    afterEach(() => { stall?.restore(); });
    afterAll(() => pool.end());

    it('checkout, table save, paid refund and table void answer without waiting for the lookup', async () => {
        const sale = await answersWhileStalled(() => post('checkout', {
            cart: [{ id: SEED.product1.id, qty: 1, price: 5 }], subtotal: 5, tax: 0.8, total: 5.8,
            payment_method: 'cash', amount_tendered: 10, change_due: 4.2, idempotency_key: 'stock-scope-response-path'
        }));
        await answersWhileStalled(() => post('refunds', { invoice_id: sale.body.invoice_id, intent: 'refund', refund_method: 'cash' }));

        const saved = await answersWhileStalled(() => post('table_order', { table_id: SEED.table.id, cart: [line], subtotal: 5, tax: 0, total: 5 }));
        const bill = (await request(app).get(`/api/pos/table_order?order_id=${saved.body.invoice_id}`).set('Cookie', cookie)).body;
        await answersWhileStalled(() => post('refunds', { invoice_id: bill.invoice_id, intent: 'void', expected_version: bill.version }));
    });
});
