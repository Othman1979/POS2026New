const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');

describe('deleted table items migration: future cancellations only', () => {
    const manifest = require('../../migrations/auto-manifest.json');
    const target = manifest.migrations.find(row => row.name === '2026-09-14-deleted-table-items-v1');
    const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-deleted-items-'));
    const manifestPath = path.join(directory, 'manifest.json');
    const sql = read(path.join(__dirname, '../../migrations', target.file));
    beforeAll(() => {
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        for (const file of [target.file, target.preflight]) fs.copyFileSync(path.join(__dirname, '../../migrations', file), path.join(directory, file));
    });
    let before;
    const state = async () => ({
        orders: (await pool.query('SELECT * FROM orders ORDER BY invoice_id'))[0],
        items: (await pool.query('SELECT * FROM order_items ORDER BY id'))[0],
        refunds: (await pool.query('SELECT * FROM refunds ORDER BY id'))[0],
        refundItems: (await pool.query('SELECT * FROM refund_items ORDER BY id'))[0],
    });
    beforeEach(async () => {
        await seedDatabase();
        await pool.query('DROP TABLE deleted');
        await pool.query('ALTER TABLE refunds MODIFY COLUMN invoice_id INT NOT NULL');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        const [order] = await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method) VALUES(1,5,0,5,'voided')");
        const [item] = await pool.query("INSERT INTO order_items(invoice_id,item_name,quantity,price_at_sale) VALUES(?,'Existing void',1,5)", [order.insertId]);
        const [refund] = await pool.query("INSERT INTO refunds(kind,invoice_id,user_id,subtotal_refunded) VALUES('void',?,1,5)", [order.insertId]);
        await pool.query(`INSERT INTO refund_items(refund_id,order_item_id,item_name,quantity,unit_price,line_subtotal,line_tax,line_total)
            VALUES(?,?,'Existing void',1,5,5,0,5)`, [refund.insertId, item.insertId]);
        before = await state();
    });
    afterAll(async () => {
        await pool.end();
        for (const file of [target.file, target.preflight, 'manifest.json']) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });
    const migrate = () => runPendingMigrations(pool, { manifestPath });
    const rawSql = async () => {
        const conn = await pool.getConnection();
        try { for (const statement of splitMysqlScript(sql)) await conn.query(statement); }
        finally { conn.release(); }
    };
    it('upgrades the exact predecessor without moving any historical records, and replays safely', async () => {
        const [[previous]] = await pool.query('SELECT checksum FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
        expect(previous.checksum).toBe(target.requires.checksum);
        await expect(validateRequiredSchema(pool)).rejects.toThrow('deleted_columns');
        expect((await migrate()).applied).toEqual([target.name]);
        expect(await validateRequiredSchema(pool)).toBe(true);
        expect(await state()).toEqual(before);
        expect((await pool.query('SELECT * FROM deleted'))[0]).toEqual([]);
        expect((await migrate()).applied).toEqual([]);
        // Null cancellation references must survive raw replay too.
        const [future] = await pool.query("INSERT INTO refunds(kind,user_id) VALUES('void',1)");
        await pool.query(`INSERT INTO deleted(refund_id,source_invoice_id,source_order_item_id,quantity,item_snapshot)
            VALUES(?,123,456,0.25,'{"quantity":1}')`, [future.insertId]);
        await rawSql();
        expect(await validateRequiredSchema(pool)).toBe(true);
        expect((await pool.query('SELECT * FROM deleted'))[0]).toHaveLength(1);
        const [[event]] = await pool.query('SELECT invoice_id FROM refunds WHERE id=?', [future.insertId]);
        expect(event.invoice_id).toBeNull();
    });
    it('resumes a compatible DDL-only partial install', async () => {
        await rawSql();
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        expect((await migrate()).applied).toEqual([target.name]);
        expect(await state()).toEqual(before);
    });
    it('refuses an unrelated table named deleted without changing history', async () => {
        await pool.query('CREATE TABLE deleted(id INT PRIMARY KEY, note TEXT)');
        await expect(migrate()).rejects.toThrow('preflight rejected');
        expect(await state()).toEqual(before);
    });
    it.each(['missing predecessor', 'predecessor checksum', 'target checksum'])('fails closed for %s', async mode => {
        if (mode === 'missing predecessor') await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
        else if (mode === 'predecessor checksum') await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?', ['a'.repeat(64), target.requires.name]);
        else await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)', [target.name, 'b'.repeat(64)]);
        await expect(migrate()).rejects.toThrow(/checksum|requires/);
        expect((await pool.query("SHOW TABLES LIKE 'deleted'"))[0]).toEqual([]);
        expect(await state()).toEqual(before);
    });
    it('ships identical SQL and hash-verified fresh schema', () => {
        const hash = text => createHash('sha256').update(text).digest('hex');
        expect(hash(sql)).toBe(target.sha256);
        expect(hash(read(path.join(directory, target.preflight)))).toBe(target.preflightSha256);
        expect(read(path.join(__dirname, '../../migrations', target.file.replace('.auto.sql', '.sql')))).toBe(sql);
        const fallback = read(path.join(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'));
        expect(fallback.split(`-- BEGIN AUTO MIGRATION: ${target.name} | ${target.checksum}\n`)[1].split(`-- END AUTO MIGRATION: ${target.name}`)[0]).toBe(sql);
        expect(manifest.migrations[manifest.migrations.indexOf(target) - 1]).toMatchObject(target.requires);
        const { baseline } = require('../../../deployment/tools/bootstrap-database').readVerifiedBaseline();
        expect(baseline).not.toMatch(/^\s*(?:INSERT|REPLACE)\s/im);
        expect(baseline).toContain('CREATE TABLE deleted (');
    });
});
