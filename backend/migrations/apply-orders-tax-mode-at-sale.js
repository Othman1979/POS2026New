const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const envFile = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
require('dotenv').config({ path: path.join(__dirname, envFile), override: true });

async function run() {
    if (process.env.RECEIPT_TAX_MODE_MIGRATION_CONFIRM !== 'apply-receipt-tax-mode') {
        throw new Error('Set RECEIPT_TAX_MODE_MIGRATION_CONFIRM=apply-receipt-tax-mode to continue.');
    }
    const database = process.env.DB_NAME || 'posapp';
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database,
        charset: 'utf8mb4',
        multipleStatements: true
    });
    try {
        const [[existing]] = await conn.query(`
            SELECT COUNT(*) AS count
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'orders'
              AND COLUMN_NAME = 'tax_inclusive_at_sale'
        `);
        if (Number(existing.count) > 0) {
            console.log('Column tax_inclusive_at_sale already exists. Idempotent exit.');
            return;
        }
        const sql = fs.readFileSync(
            path.join(__dirname, '2026-07-11-orders-tax-mode-at-sale.sql'),
            'utf8'
        );
        await conn.query(sql);
        console.log('Orders tax mode at sale migration applied.');
    } finally {
        await conn.end();
    }
}

run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
