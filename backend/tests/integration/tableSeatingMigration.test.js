const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');

describe('independent seating migration', () => {
    const manifest = require('../../migrations/auto-manifest.json');
    const target = manifest.migrations.find(row => row.name === '2026-09-13-table-seating-v1');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-table-seating-'));
    const manifestPath = path.join(directory, 'manifest.json');
    const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const sql = read(path.join(__dirname, '../../migrations', target.file));
    let before;
    const snapshot = async () => {
        const out = {};
        for (const table of ['orders', 'order_items', 'held_orders', 'products', 'stock_movements']) out[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`))[0];
        out.tables = (await pool.query('SELECT id,current_order_id,parent_table_id,status FROM restaurant_tables ORDER BY id'))[0];
        return out;
    };
    const migrate = () => runPendingMigrations(pool, { manifestPath });
    const raw = async () => {
        const conn = await pool.getConnection();
        try { for (const statement of splitMysqlScript(sql)) await conn.query(statement); } finally { conn.release(); }
    };
    beforeAll(() => {
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        for (const file of [target.file, target.preflight]) fs.copyFileSync(path.join(__dirname, '../../migrations', file), path.join(directory, file));
    });
    beforeEach(async () => {
        await seedDatabase();
        await pool.query('ALTER TABLE restaurant_tables DROP FOREIGN KEY fk_tables_seating_parent, DROP COLUMN seating_parent_id');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        const [order] = await pool.query("INSERT INTO orders(user_id,waiter_id,table_id,subtotal,tax,total,payment_method) VALUES(1,3,1,4,0,4,'unpaid_table')");
        await pool.query("UPDATE restaurant_tables SET current_order_id=?,status='printed' WHERE id IN (1,2)", [order.insertId]);
        await pool.query('UPDATE restaurant_tables SET parent_table_id=1 WHERE id=2');
        await pool.query("INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,note) VALUES(?,2,'Saved Drink',2,2,'Keep me')", [order.insertId]);
        before = await snapshot();
    });
    afterAll(async () => {
        await pool.end();
        for (const file of [target.file, target.preflight, 'manifest.json']) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });

    it('backfills existing shared seats once without modifying issued bills or restoring later separation', async () => {
        await expect(validateRequiredSchema(pool)).rejects.toThrow('seating_parent');
        expect((await migrate()).applied).toEqual([target.name]);
        expect(await snapshot()).toEqual(before);
        expect((await pool.query('SELECT seating_parent_id FROM restaurant_tables WHERE id=2'))[0][0].seating_parent_id).toBe(1);
        expect(await validateRequiredSchema(pool)).toBe(true);
        expect((await migrate()).applied).toEqual([]);
        await pool.query('UPDATE restaurant_tables SET seating_parent_id=NULL WHERE id=2');
        await raw();
        expect((await pool.query('SELECT seating_parent_id FROM restaurant_tables WHERE id=2'))[0][0].seating_parent_id).toBeNull();
        expect(await snapshot()).toEqual(before);
    });
    it('recovers when column DDL completed before the backfill and ledger', async () => {
        await pool.query('ALTER TABLE restaurant_tables ADD COLUMN seating_parent_id INT DEFAULT NULL');
        expect((await migrate()).applied).toEqual([target.name]);
        expect(await validateRequiredSchema(pool)).toBe(true);
        expect(await snapshot()).toEqual(before);
    });
    it('keeps preexisting empty seating without making the next bills shared', async () => {
        await pool.query("INSERT INTO restaurant_tables(id,section_id,table_number,parent_table_id) VALUES(3,1,'3',NULL),(4,1,'4',3)");
        expect((await migrate()).applied).toEqual([target.name]);
        expect((await pool.query('SELECT id,current_order_id,parent_table_id,seating_parent_id FROM restaurant_tables WHERE id IN (3,4) ORDER BY id'))[0]).toEqual([
            { id: 3, current_order_id: null, parent_table_id: null, seating_parent_id: null },
            { id: 4, current_order_id: null, parent_table_id: null, seating_parent_id: 3 }
        ]);
        // The active shared bill from beforeEach retains its owner and alias.
        expect((await pool.query('SELECT parent_table_id FROM restaurant_tables WHERE id=2'))[0][0].parent_table_id).toBe(1);
    });
    it.each(['VARCHAR(10)', 'INT UNSIGNED', 'INT NOT NULL DEFAULT 0'])('rejects a wrong partial column (%s) without changing business data', async type => {
        await pool.query(`ALTER TABLE restaurant_tables ADD COLUMN seating_parent_id ${type}`);
        await expect(migrate()).rejects.toThrow('preflight rejected');
        expect(await snapshot()).toEqual(before);
    });
    it('rejects cyclic legacy seating instead of inventing an owner during backfill', async () => {
        await pool.query('UPDATE restaurant_tables SET parent_table_id=2 WHERE id=1');
        before = await snapshot();
        await expect(migrate()).rejects.toThrow('preflight rejected');
        expect(await snapshot()).toEqual(before);
    });
    it.each(['missing predecessor', 'predecessor checksum', 'target checksum'])('fails closed for %s', async mode => {
        if (mode === 'missing predecessor') await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
        else if (mode === 'predecessor checksum') await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?', ['a'.repeat(64), target.requires.name]);
        else await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES(?,?)', [target.name, 'b'.repeat(64)]);
        await expect(migrate()).rejects.toThrow(/checksum|requires/);
        expect(await snapshot()).toEqual(before);
    });
    it('ships exact SQL in the fallback and a verified schema-only baseline', () => {
        const hash = s => createHash('sha256').update(s).digest('hex');
        expect(hash(sql)).toBe(target.sha256);
        expect(hash(read(path.join(directory, target.preflight)))).toBe(target.preflightSha256);
        expect(read(path.join(__dirname, '../../migrations', target.file.replace('.auto.sql', '.sql')))).toBe(sql);
        const fallback = read(path.join(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'));
        expect(fallback.split(`-- BEGIN AUTO MIGRATION: ${target.name} | ${target.checksum}\n`)[1].split(`-- END AUTO MIGRATION: ${target.name}`)[0]).toBe(sql);
        expect(manifest.migrations[manifest.migrations.indexOf(target) - 1]).toMatchObject(target.requires);
        const { baseline } = require('../../../deployment/tools/bootstrap-database').readVerifiedBaseline();
        expect(baseline).not.toMatch(/^\s*(?:INSERT|REPLACE)\s/im);
        expect(baseline).toContain('FOREIGN KEY (seating_parent_id) REFERENCES restaurant_tables (id) ON DELETE SET NULL');
    });
});
