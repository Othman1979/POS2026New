const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { broadcastTableUpdates } = require('../../services/TableRealtime');

const LEGACY_SUMMARY_SQL = `
    SELECT t.id,
           COALESCE((SELECT SUM(h.subtotal) FROM held_orders h WHERE h.parent_invoice_id=o.invoice_id), o.total) AS active_order_total,
           (SELECT COUNT(*) FROM held_orders h WHERE h.parent_invoice_id=o.invoice_id) AS active_split_count
    FROM restaurant_tables t
    LEFT JOIN orders o ON t.current_order_id = o.invoice_id
    ORDER BY t.id`;

describe('table summary read shape', () => {
    const login = async number => (await request(app).post('/api/auth/login').send({ user_number: number })).headers['set-cookie'][0];
    const floor = async cookie => {
        const response = await request(app).get('/api/pos/get_tables').set('Cookie', cookie);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        return response.body.tables;
    };
    const summaryOf = rows => Object.fromEntries(rows.map(row => [row.id, {
        total: row.active_order_total === null ? null : Number(row.active_order_total),
        count: Number(row.active_split_count)
    }]));
    const openOrder = async (tableId, total) => {
        const [result] = await pool.query(
            "INSERT INTO orders (user_id, table_id, order_type_id, subtotal, tax, total, payment_method) VALUES (?, ?, 1, ?, 0, ?, 'unpaid_table')",
            [SEED.adminUser.id, tableId, total, total]
        );
        await pool.query("UPDATE restaurant_tables SET current_order_id=?, status='occupied' WHERE id=?", [result.insertId, tableId]);
        return result.insertId;
    };
    const split = (invoiceId, tableId, subtotals) => pool.query(
        'INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, parent_invoice_id, table_id) VALUES ?',
        [subtotals.map((subtotal, index) => [SEED.adminUser.id, `Seat ${index + 1}`, '[]', subtotal, invoiceId, tableId])]
    );

    beforeAll(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO restaurant_tables (id, section_id, table_number) VALUES (3,1,'3'),(4,1,'4'),(5,1,'5')");
        await openOrder(2, 12.5);
        await split(await openOrder(3, 9.75), 3, [2.5, 3.25, 4]);
        await split(await openOrder(4, 20), 4, [5, 6]);
        await split(await openOrder(5, 7.25), 5, [null]);
        await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'tables.access')", [SEED.cashierUser.id]);
    });
    afterAll(async () => { await pool.end(); });

    it('matches the correlated-subquery oracle for every seeded table shape', async () => {
        const [oracleRows] = await pool.query(LEGACY_SUMMARY_SQL);
        const oracle = summaryOf(oracleRows);
        expect(oracle).toEqual({
            1: { total: null, count: 0 },
            2: { total: 12.5, count: 0 },
            3: { total: 9.75, count: 3 },
            4: { total: 11, count: 2 },
            5: { total: 7.25, count: 1 }
        });

        const admin = await login(SEED.adminUser.user_number);
        expect(summaryOf(await floor(admin))).toEqual(oracle);

        const emit = vi.fn();
        const io = { to: vi.fn(() => ({ emit })) };
        await broadcastTableUpdates(io, [1, 2, 3, 4, 5]);
        const broadcast = emit.mock.calls.map(([, payload]) => payload.table);
        expect(summaryOf(broadcast)).toEqual(oracle);
        for (const table of broadcast) {
            expect(table).not.toHaveProperty('x_pos');
            expect(table).not.toHaveProperty('y_pos');
            expect(table).not.toHaveProperty('qr_code_token');
        }

        emit.mockClear();
        await broadcastTableUpdates(io, [4]);
        expect(summaryOf(emit.mock.calls.map(([, payload]) => payload.table))).toEqual({ 4: oracle[4] });
    });

    it('omits floor coordinates and exposes the guest token only to admin requesters', async () => {
        const admin = await login(SEED.adminUser.user_number);
        const cashier = await login(SEED.cashierUser.user_number);
        const waiter = await login(SEED.waiterUser.user_number);

        const adminTables = await floor(admin);
        expect(adminTables.length).toBe(5);
        for (const table of adminTables) {
            expect(table).not.toHaveProperty('x_pos');
            expect(table).not.toHaveProperty('y_pos');
            expect(table).toHaveProperty('qr_code_token');
        }
        expect(adminTables.find(table => table.id === 1).qr_code_token).toBe('test_qr_token_abc123');

        for (const cookie of [cashier, waiter]) {
            const tables = await floor(cookie);
            expect(tables.length).toBe(5);
            for (const table of tables) {
                expect(table).not.toHaveProperty('x_pos');
                expect(table).not.toHaveProperty('y_pos');
                expect(table).not.toHaveProperty('qr_code_token');
            }
        }
    });
});
