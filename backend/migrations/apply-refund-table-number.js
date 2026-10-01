const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const envFile = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
require('dotenv').config({ path: path.join(__dirname, envFile), override: true });

async function run() {
    if (process.env.REFUND_TABLE_NUMBER_MIGRATION_CONFIRM !== 'apply-refund-table-number') {
        throw new Error('Set REFUND_TABLE_NUMBER_MIGRATION_CONFIRM=apply-refund-table-number to continue.');
    }

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'posapp',
        charset: 'utf8mb4',
        multipleStatements: true
    });

    try {
        const [[existing]] = await conn.query(`
            SELECT COUNT(*) AS count
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'refunds'
               AND COLUMN_NAME = 'table_number'
        `);
        if (Number(existing.count) > 0) {
            console.log('Column refunds.table_number already exists. Idempotent exit.');
            return;
        }

        const sql = fs.readFileSync(
            path.join(__dirname, '2026-07-14-refund-table-number.sql'),
            'utf8'
        );
        await conn.query(sql);
        console.log('Refund table-number migration applied.');
    } finally {
        await conn.end();
    }
}

run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
