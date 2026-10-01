const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const manifest = require('../../migrations/auto-manifest.json');

describe('Stock adjustment migration', () => {
    let directory;
    let manifestPath;
    const target = manifest.migrations.find(migration => migration.name === '2026-09-08-stock-adjustments-v1');
    beforeAll(async () => {
        await seedDatabase({ legacyStockSchema: true });
        // Remove later dependent tables before reconstructing this predecessor.
        // Keep foreign-key checks enabled so the upgrade starts from a valid schema.
        const successors = [
            'stock_price_adjustment_lines', 'stock_price_adjustments', 'stock_vendor_return_lines', 'stock_vendor_returns',
            'stock_receipt_lines', 'stock_receipts', 'stock_purchase_order_lines', 'stock_purchase_orders',
            'stock_supplier_items', 'stock_suppliers',
            'stock_report_count_corrections', 'stock_report_counts', 'stock_operation_sources', 'stock_ingredient_links',
            'stock_movements', 'stock_balances', 'product_stock_links', 'stock_lots', 'stock_items', 'stock_locations'
        ];
        for (const table of successors) await pool.query(`DROP TABLE IF EXISTS ${table}`);
        await pool.query("DELETE FROM schema_migrations WHERE migration_name='2026-09-08-stock-ledger-core-v1'");
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-stock-migration-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, migrations: [target] }));
        fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));
    });
    afterAll(async () => {
        await pool.end();
        if (!directory) return;
        for (const file of ['manifest.json', target.file]) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });
    test('upgrades exact predecessor, resumes additive partial state, and is a no-op thereafter', async () => {
        // Only the generated loopback fixture is changed here.
        await pool.query('DROP TABLE stock_operations');
        await pool.query('ALTER TABLE products DROP COLUMN stock_version');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        await pool.query('UPDATE products SET stock=12.345678 WHERE id=1');
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([target.name]);
        const [[row]] = await pool.query('SELECT stock,stock_version FROM products WHERE id=1');
        expect(Number(row.stock)).toBe(12.345678);
        expect(Number(row.stock_version)).toBe(0);
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([]);
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        await pool.query('DROP TABLE stock_operations');
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([target.name]);
    });
    test('refuses missing predecessor and checksum conflict', async () => {
        await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?,?)', [target.name, target.requires.name]);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)', [target.requires.name, 'wrong']);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
    });
});
