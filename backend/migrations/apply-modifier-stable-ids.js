// backend/migrations/apply-modifier-stable-ids.js
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { normalizeModifierDefinition } = require('../services/modifierDefs');

const envFile = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
require('dotenv').config({ path: path.join(__dirname, envFile), override: true });

async function run() {
    if (process.env.MODIFIER_IDS_MIGRATION_CONFIRM !== 'apply-modifier-ids') {
        throw new Error('Set MODIFIER_IDS_MIGRATION_CONFIRM=apply-modifier-ids to continue.');
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
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'selected_modifiers'
        `);
        if (Number(existing.count) === 0) {
            await conn.query(fs.readFileSync(path.join(__dirname, '2026-07-12-modifier-stable-ids.sql'), 'utf8'));
            console.log('order_items.selected_modifiers added.');
        } else {
            console.log('Column selected_modifiers already exists. Skipping DDL.');
        }

        // Backfill stable ids into every product's modifier definition (idempotent:
        // a second run finds all ids present and rewrites nothing).
        const [products] = await conn.query("SELECT id, modifiers FROM products WHERE modifiers IS NOT NULL AND modifiers != ''");
        let updated = 0;
        const skipped = [];
        for (const p of products) {
            let canonical;
            try { canonical = normalizeModifierDefinition(p.modifiers); }
            catch (e) { skipped.push({ productId: p.id, reason: e.message }); continue; }
            const json = canonical ? JSON.stringify(canonical) : null;
            if (json !== p.modifiers) {
                await conn.query('UPDATE products SET modifiers = ? WHERE id = ?', [json, p.id]);
                updated++;
            }
        }
        if (skipped.length > 0) {
            console.error('Modifier-id backfill found invalid modifier JSON after updating all valid products:');
            for (const row of skipped) console.error(`  product ${row.productId}: ${row.reason}`);
            console.error('Do not deploy or restart the new application code yet. Fix those products in admin or SQL, then rerun this migration. No historical order_items backfill is required.');
            process.exitCode = 1;
            return;
        }
        console.log(`Backfill done: ${updated} products updated, 0 skipped.`);
    } finally {
        await conn.end();
    }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
