// Local disposable-database probe. Run with the guarded recipe review preload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { seedDatabase } = require('../../backend/tests/fixtures/seed');
const pool = require('../../backend/config/db');
const { getFinancialEventsForPeriod } = require('../../backend/services/financialEventMetrics');

async function main() {
    assert.match(process.env.POSAPP_REVIEW_DB || '', /^posapp_review_recipe_p1_[a-f0-9]{12}$/);
    assert.equal(process.env.DB_NAME, process.env.POSAPP_REVIEW_DB);
    assert.ok(['127.0.0.1', 'localhost'].includes(process.env.DB_HOST || '127.0.0.1'));
    await seedDatabase();
    try {
        for (let batch = 0; batch < 100; batch++) {
            const rows = Array.from({ length: 500 }, () => [2, 1, 9, 0, 9, 'cash', 9, '2026-01-01 08:00:00', '2026-01-01 08:00:00']);
            await pool.query(`INSERT INTO orders (user_id,order_type_id,subtotal,tax,total,payment_method,cash_amount,created_at,invoice_issued_at) VALUES ?`, [rows]);
        }
        await pool.query(`INSERT INTO order_items (invoice_id,product_id,quantity,price_at_sale,tax_amount,discount_type,discount_value)
            SELECT invoice_id,1,1,10,0,'fixed',1 FROM orders`);
        const [today] = await pool.query(`INSERT INTO orders (user_id,order_type_id,subtotal,tax,total,payment_method,cash_amount,created_at,invoice_issued_at)
            VALUES (2,1,9,0,8,'cash',8,'2026-09-06 08:00:00','2026-09-06 08:00:00')`);
        await pool.query(`INSERT INTO order_items (invoice_id,product_id,quantity,price_at_sale,tax_amount,discount_type,discount_value) VALUES (?,1,1,10,0,'fixed',1)`, [today.insertId]);
        await pool.query('ANALYZE TABLE orders, order_items');
        const conn = await pool.getConnection();
        try {
            const runs = [];
            let discountQuery;
            const executor = { query: async (...args) => {
                if (args[0].includes('AS discounts_total') && args[0].includes('discounted_orders')) discountQuery = args;
                return conn.query(...args);
            } };
            for (let i = 0; i < 6; i++) {
                const start = performance.now();
                const metrics = await getFinancialEventsForPeriod(executor, '2026-09-06 00:00:00', '2026-09-07 00:00:00');
                assert.equal(metrics.orders, 1);
                assert.equal(metrics.discounts_total, 1);
                if (i) runs.push(performance.now() - start);
            }
            const [explain] = await conn.query('EXPLAIN ' + discountQuery[0], discountQuery[1]);
            const [[before]] = await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'");
            const start = performance.now();
            await conn.query(...discountQuery);
            const discountMs = performance.now() - start;
            const [[after]] = await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'");
            const [[version]] = await conn.query('SELECT VERSION() version');
            const result = {
                sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
                financialMetricsBlob: execFileSync('git', ['hash-object', 'backend/services/financialEventMetrics.js'], { encoding: 'utf8' }).trim(),
                database: process.env.DB_NAME, version: version.version,
                workload: { historicalOrders: 50000, historicalItems: 50000, dayOrders: 1, dayItems: 1 },
                periodMetricsMedianMs: runs.sort((a, b) => a - b)[2],
                discountMs, discountRowsRead: Number(after.Value) - Number(before.Value), explain,
            };
            assert.ok(process.env.POSAPP_PERFORMANCE_OUTPUT, 'POSAPP_PERFORMANCE_OUTPUT is required');
            fs.writeFileSync(process.env.POSAPP_PERFORMANCE_OUTPUT, JSON.stringify(result, null, 2) + '\n');
            console.log(JSON.stringify(result));
        } finally { conn.release(); }
    } finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
