const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const envFile = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
require('dotenv').config({ path: path.join(__dirname, envFile), override: true });

async function run() {
    if (process.env.MODIFIER_SURCHARGE_MIGRATION_CONFIRM !== 'apply-modifier-surcharge') {
        throw new Error('Set MODIFIER_SURCHARGE_MIGRATION_CONFIRM=apply-modifier-surcharge to continue.');
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
            SELECT COUNT(*) AS count FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'modifier_surcharge'
        `);
        if (Number(existing.count) === 0) {
            await conn.query(fs.readFileSync(path.join(__dirname, '2026-07-12-modifier-surcharge-untaxed.sql'), 'utf8'));
            console.log('order_items.modifier_surcharge added.');
        } else {
            console.log('Column modifier_surcharge already exists. Skipping DDL.');
        }
    } finally {
        await conn.end();
    }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
