const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const manifest = require('../../migrations/auto-manifest.json');

describe('Stock sale snapshot migration', () => {
    const target = manifest.migrations.find(entry => entry.name === '2026-09-08-stock-sale-snapshots-v1');
    let directory;
    let manifestPath;
    beforeAll(async () => {
        await seedDatabase();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-stock-snapshot-migration-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));
    });
    afterAll(async () => {
        await pool.end();
        for (const file of ['manifest.json', target.file]) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });
    test('adds unknown historical authority without backfilling current product mappings', async () => {
        // Replay this historical migration against the table it originally owned.
        // Fresh installations intentionally omit all subscription tables.
        await pool.query("CREATE TABLE subscription_redemption_items (id BIGINT UNSIGNED PRIMARY KEY, stock_authority VARCHAR(24) NOT NULL DEFAULT 'legacy', stock_snapshot JSON DEFAULT NULL) ENGINE=InnoDB");
        for (const table of ['order_items', 'subscription_redemption_items']) {
            await pool.query(`ALTER TABLE ${table} DROP COLUMN stock_authority,DROP COLUMN stock_snapshot`);
        }
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        const [order] = await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method) VALUES (1,5,0.8,5.8,'cash')");
        await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale) VALUES (?,1,?,1,5)', [order.insertId, 'Historical meal']);
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([target.name]);
        const [[line]] = await pool.query('SELECT stock_authority,stock_snapshot,CAST(quantity AS CHAR) AS quantity FROM order_items WHERE invoice_id=?', [order.insertId]);
        expect(line).toEqual({ stock_authority: 'legacy', stock_snapshot: null, quantity: '1.000000' });
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([]);
        await pool.query("UPDATE order_items SET stock_authority='none' WHERE invoice_id=?", [order.insertId]);
        await pool.query('ALTER TABLE subscription_redemption_items DROP COLUMN stock_snapshot');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([target.name]);
        expect((await pool.query('SELECT stock_authority FROM order_items WHERE invoice_id=?', [order.insertId]))[0][0].stock_authority).toBe('none');
    });
    test('fails closed on a missing or changed predecessor', async () => {
        await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?,?)', [target.name, target.requires.name]);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)', [target.requires.name, 'wrong']);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
    });
});
