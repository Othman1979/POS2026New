'use strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME || 'posapp_test';
process.env.LOG_LEVEL = 'silent';

const request = require('supertest');
const { performance } = require('node:perf_hooks');
const { app } = require('../server');
const pool = require('../backend/config/db');
const { seedDatabase, SEED } = require('../backend/tests/fixtures/seed');

const samples = { tableSave: [], checkout: [], markPrinted: [] };
let queryCount = 0;
const wrapped = Symbol('benchmarkWrapped');
const originalPoolQuery = pool.query.bind(pool);
const originalGetConnection = pool.getConnection.bind(pool);

pool.query = async (...args) => {
    queryCount++;
    return originalPoolQuery(...args);
};

pool.getConnection = async () => {
    const conn = await originalGetConnection();
    if (!conn[wrapped]) {
        const query = conn.query.bind(conn);
        const execute = conn.execute.bind(conn);
        conn.query = async (...args) => {
            queryCount++;
            return query(...args);
        };
        conn.execute = async (...args) => {
            queryCount++;
            return execute(...args);
        };
        conn[wrapped] = true;
    }
    return conn;
};

const percentile = (values, fraction) => {
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
};

const summarize = rows => ({
    medianMs: Number(percentile(rows.map(row => row.ms), 0.5).toFixed(2)),
    p95Ms: Number(percentile(rows.map(row => row.ms), 0.95).toFixed(2)),
    medianQueries: percentile(rows.map(row => row.queries), 0.5),
    maxQueries: Math.max(...rows.map(row => row.queries))
});

const measure = async (bucket, action) => {
    queryCount = 0;
    const start = performance.now();
    const response = await action();
    const ms = performance.now() - start;
    if (response.statusCode !== 200) {
        throw new Error(`${bucket} returned ${response.statusCode}: ${response.text}`);
    }
    samples[bucket].push({ ms, queries: queryCount });
};

async function seedLiveOrder() {
    const [result] = await pool.query(
        `INSERT INTO orders
           (order_id, user_id, waiter_id, table_id, subtotal, tax, total, payment_method)
         VALUES (NULL, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table')`,
        [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table.id]
    );
    await pool.query(
        `INSERT INTO order_items
           (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order)
         VALUES (?, ?, ?, 1, 5.00, 16.00, 0.80, 0)`,
        [result.insertId, SEED.product1.id, SEED.product1.name]
    );
    await pool.query(
        `UPDATE restaurant_tables
            SET status='occupied', current_order_id=?, parent_table_id=NULL
          WHERE id=?`,
        [result.insertId, SEED.table.id]
    );
    return result.insertId;
}

async function run() {
    await seedDatabase();
    const adminLogin = await request(app)
        .post('/api/auth/login')
        .send({ user_number: SEED.adminUser.user_number });
    const adminCookie = adminLogin.headers['set-cookie'][0];
    const login = await request(app)
        .post('/api/auth/login')
        .send({ user_number: SEED.cashierUser.user_number });
    const cookie = login.headers['set-cookie'][0];
    await request(app)
        .post('/api/auth/shifts?action=open')
        .set('Cookie', cookie)
        .send({ user_id: SEED.cashierUser.id, starting_cash: 50 });
    const [[shift]] = await pool.query(
        `SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1`,
        [SEED.cashierUser.id]
    );

    for (let i = 0; i < 15; i++) {
        let response;
        await measure('tableSave', async () => {
            response = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table2.id,
                    cart: [{
                        id: SEED.product1.id,
                        product_id: SEED.product1.id,
                        name: SEED.product1.name,
                        qty: 1,
                        price: 5,
                        note: ''
                    }],
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8
                });
            return response;
        });

        const invoiceId = response.body.invoice_id;
        await pool.query(
            "UPDATE restaurant_tables SET status='available', current_order_id=NULL, parent_table_id=NULL WHERE id=?",
            [SEED.table2.id]
        );
        await pool.query('DELETE FROM order_items WHERE invoice_id=?', [invoiceId]);
        await pool.query('DELETE FROM orders WHERE invoice_id=?', [invoiceId]);
    }

    for (let i = 0; i < 15; i++) {
        const invoiceId = await seedLiveOrder();
        await measure('checkout', () => request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cookie)
            .send({
                edit_invoice_id: invoiceId,
                table_id: SEED.table.id,
                shift_id: shift.id,
                cart: [{
                    id: SEED.product1.id,
                    product_id: SEED.product1.id,
                    name: SEED.product1.name,
                    qty: 1,
                    price: 5,
                    order_item_id: null
                }],
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 6,
                change_due: 0.2,
                idempotency_key: `benchmark-checkout-${i}`
            }));
    }

    for (let i = 0; i < 15; i++) {
        const invoiceId = await seedLiveOrder();
        await measure('markPrinted', () => request(app)
            .post('/api/pos/table_order')
            .set('Cookie', cookie)
            .send({
                action: 'mark_printed',
                table_id: SEED.table.id,
                expected_invoice_id: invoiceId
            }));
    }

    process.stdout.write(`${JSON.stringify({
        tableSave: summarize(samples.tableSave),
        checkout: summarize(samples.checkout),
        markPrinted: summarize(samples.markPrinted)
    }, null, 2)}\n`);
}

run()
    .catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
        process.exit(process.exitCode || 0);
    });
