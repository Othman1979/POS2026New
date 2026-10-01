// Applies 2026-06-25-waiter-permissions.sql through a guaranteed utf8mb4 connection.
// Run: node backend/migrations/apply-waiter-permissions.js
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
    const sql = fs.readFileSync(path.join(__dirname, '2026-06-25-waiter-permissions.sql'), 'utf8');
    await conn.query(sql);
    const [rows] = await conn.query("SELECT perm_key, label_ar FROM permissions WHERE category='waiter' ORDER BY sort_order");
    console.log('Waiter catalog rows:');
    for (const r of rows) console.log(`  ${r.perm_key.padEnd(24)} ${r.label_ar}`);
    const [[{ grants }]] = await conn.query("SELECT COUNT(*) grants FROM user_permissions WHERE perm_key LIKE 'waiter.%'");
    console.log(`waiter.* grants backfilled: ${grants}`);
    await conn.end();
    console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
