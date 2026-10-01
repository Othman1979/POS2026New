// Applies 2026-06-25-fix-permissions-encoding.sql through a guaranteed utf8mb4 connection.
// Run: node backend/migrations/apply-fix-permissions-encoding.js
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
    const sql = fs.readFileSync(path.join(__dirname, '2026-06-25-fix-permissions-encoding.sql'), 'utf8');
    await conn.query(sql);
    const [rows] = await conn.query("SELECT perm_key, label_ar, description_ar FROM permissions ORDER BY sort_order");
    console.log('Updated permissions:');
    for (const r of rows) console.log(`  ${r.perm_key.padEnd(22)} ${r.label_ar}  |  ${r.description_ar}`);
    await conn.end();
    console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
