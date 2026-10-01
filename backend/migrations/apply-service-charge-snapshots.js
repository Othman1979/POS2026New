const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const envFile = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
require('dotenv').config({ path: path.join(__dirname, envFile), override: true });

async function ensureForeignKey(conn, { table, constraint, column }) {
    const [[existing]] = await conn.query(`
        SELECT COUNT(*) AS count
        FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND CONSTRAINT_NAME = ?
          AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    `, [table, constraint]);
    if (Number(existing.count) === 0) {
        await conn.query(`
            ALTER TABLE \`${table}\`
            ADD CONSTRAINT \`${constraint}\`
            FOREIGN KEY (\`${column}\`) REFERENCES service_charge_snapshots(id)
        `);
    }
}

async function run() {
    const database = process.env.DB_NAME || 'posapp';
    if (process.env.SERVICE_CHARGE_MIGRATION_CONFIRM !== database) {
        throw new Error(`Set SERVICE_CHARGE_MIGRATION_CONFIRM=${database} to confirm the migration target.`);
    }
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database,
        charset: 'utf8mb4',
        multipleStatements: true
    });
    try {
        const [[open]] = await conn.query(`
            SELECT COUNT(DISTINCT o.invoice_id) AS count
            FROM orders o
            JOIN order_items oi ON oi.invoice_id = o.invoice_id
            WHERE o.payment_method = 'unpaid_table'
              AND oi.note = 'Auto-Gratuity'
        `);
        const [[held]] = await conn.query(`
            SELECT COUNT(*) AS count
            FROM held_orders
            WHERE cart_data LIKE '%Auto-Gratuity%'
        `);
        if (Number(open.count) > 0 || Number(held.count) > 0) {
            throw new Error(`Operational cutoff failed: ${open.count} open table order(s), ${held.count} held order(s) contain service charges.`);
        }
        const sql = fs.readFileSync(
            path.join(__dirname, '2026-07-11-service-charge-snapshots.sql'),
            'utf8'
        );
        await conn.query(sql);
        await ensureForeignKey(conn, {
            table: 'orders',
            constraint: 'fk_orders_service_charge_snapshot',
            column: 'service_charge_snapshot_id'
        });
        await ensureForeignKey(conn, {
            table: 'held_orders',
            constraint: 'fk_held_service_charge_snapshot',
            column: 'service_charge_snapshot_id'
        });
        console.log('Service-charge snapshot migration applied.');
    } finally {
        await conn.end();
    }
}

run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
