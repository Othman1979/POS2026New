const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const manifest = require('../../migrations/auto-manifest.json');

describe('Stock ledger schema upgrade', () => {
    const target = manifest.migrations.find(entry => entry.name === '2026-09-08-stock-ledger-core-v1');
    let directory;
    let manifestPath;
    beforeAll(async () => {
        await seedDatabase({ legacyStockSchema: true });
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-stock-core-migration-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));
    });
    afterAll(async () => {
        await pool.end();
        for (const file of ['manifest.json', target.file]) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });
    test('upgrades the exact predecessor without mapping or changing legacy stock', async () => {
        // Retained purchasing history has FKs into the core tables. Remove it
        // before reconstructing this earlier schema, with FK checks still on.
        const successors = [
            'stock_price_adjustment_lines', 'stock_price_adjustments', 'stock_vendor_return_lines', 'stock_vendor_returns',
            'stock_receipt_lines', 'stock_receipts', 'stock_purchase_order_lines', 'stock_purchase_orders',
            'stock_supplier_items', 'stock_suppliers',
            'stock_report_count_corrections', 'stock_report_counts', 'stock_operation_sources', 'stock_ingredient_links',
            'stock_movements', 'stock_balances', 'product_stock_links', 'stock_lots', 'stock_items', 'stock_locations'
        ];
        for (const table of successors) await pool.query(`DROP TABLE ${table}`);
        await pool.query('ALTER TABLE stock_operations DROP COLUMN state,DROP COLUMN business_date,DROP COLUMN original_operation_id');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        await pool.query('UPDATE products SET stock=12.345678 WHERE id=1');
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([target.name]);
        const [[product]] = await pool.query('SELECT CAST(stock AS CHAR) AS stock FROM products WHERE id=1');
        expect(product.stock).toBe('12.345678');
        expect((await pool.query('SELECT * FROM product_stock_links'))[0]).toHaveLength(0);
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([]);
    });
    test('recovers additive partial state without replacing an existing location', async () => {
        await pool.query("UPDATE stock_locations SET name='Local name' WHERE code='default'");
        await pool.query('DROP TABLE stock_movements');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([target.name]);
        const [[location]] = await pool.query("SELECT name FROM stock_locations WHERE code='default'");
        expect(location.name).toBe('Local name');
    });
    test('fails closed for a missing or altered predecessor', async () => {
        await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?,?)', [target.name, target.requires.name]);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)', [target.requires.name, 'wrong']);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
    });
});
