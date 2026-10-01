// Applies 2026-06-26-service-charge-permission.sql through a guaranteed utf8mb4 connection.
// Run: node backend/migrations/apply-service-charge-permission.js
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

(async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'posapp',
        charset: 'utf8mb4',
        multipleStatements: true,
    });
    const sql = fs.readFileSync(path.join(__dirname, '2026-06-26-service-charge-permission.sql'), 'utf8');
    await conn.query(sql);
    const [[row]] = await conn.query("SELECT perm_key, label, label_ar, default_cashier FROM permissions WHERE perm_key = 'pos.service_charge'");
    console.log('Service charge catalog row:', row);
    await conn.end();
    console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
