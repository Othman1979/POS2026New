const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');

describe('paid split parent index migration', () => {
    const manifest = require('../../migrations/auto-manifest.json');
    const target = manifest.migrations.find(row => row.name === '2026-09-13-paid-split-parent-index-v1');
    const read = file => fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'posapp-paid-split-index-'));
    const manifestPath = path.join(directory,'manifest.json');
    const sql = read(path.join(__dirname,'../../migrations',target.file));
    beforeAll(() => {
        fs.writeFileSync(manifestPath,JSON.stringify({migrations:[target]}));
        for (const file of [target.file,target.preflight]) fs.copyFileSync(path.join(__dirname,'../../migrations',file),path.join(directory,file));
    });
    let before;
    beforeEach(async () => {
        await seedDatabase();
        await pool.query('ALTER TABLE orders DROP INDEX idx_orders_parent_payment');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[target.name]);
        await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,parent_invoice_id,note) VALUES(1,2,0,2,'cash',17,'Keep saved bill'),(1,3,0,3,'card',17,'Keep sibling')");
        before=(await pool.query('SELECT * FROM orders ORDER BY invoice_id'))[0];
    });
    afterAll(async () => {
        await pool.end();
        for (const file of [target.file,target.preflight,'manifest.json']) fs.unlinkSync(path.join(directory,file));
        fs.rmdirSync(directory);
    });
    const migrate = () => runPendingMigrations(pool,{manifestPath});
    const preserved = async () => expect((await pool.query('SELECT * FROM orders ORDER BY invoice_id'))[0]).toEqual(before);
    const rawSql = async () => {
        const conn=await pool.getConnection();
        try { for (const statement of splitMysqlScript(sql)) await conn.query(statement); }
        finally { conn.release(); }
    };
    it('upgrades the exact predecessor, preserves bills and repeats automatic/raw execution', async () => {
        const [[previous]]=await pool.query('SELECT checksum FROM schema_migrations WHERE migration_name=?',[target.requires.name]);
        expect(previous.checksum).toBe(target.requires.checksum);
        await expect(validateRequiredSchema(pool)).rejects.toThrow('paid_split_parent_index');
        expect((await migrate()).applied).toEqual([target.name]);
        expect(await validateRequiredSchema(pool)).toBe(true);
        await preserved();
        expect((await migrate()).applied).toEqual([]);
        await rawSql();
        expect(await validateRequiredSchema(pool)).toBe(true);
        await preserved();
    });
    it('resumes after index DDL committed before the target ledger', async () => {
        await pool.query('ALTER TABLE orders ADD INDEX idx_orders_parent_payment (parent_invoice_id,payment_method)');
        expect((await migrate()).applied).toEqual([target.name]);
        expect(await validateRequiredSchema(pool)).toBe(true);
        await preserved();
    });
    it.each(['payment_method,parent_invoice_id','parent_invoice_id','parent_invoice_id,payment_method,invoice_id'])('fails preflight for a same-name wrong shape: %s', async columns => {
        await pool.query(`ALTER TABLE orders ADD INDEX idx_orders_parent_payment (${columns})`);
        await expect(migrate()).rejects.toThrow('preflight rejected');
        expect((await pool.query('SELECT * FROM schema_migrations WHERE migration_name=?',[target.name]))[0]).toEqual([]);
        await preserved();
    });
    it('rejects a unique replacement index', async () => {
        await pool.query('ALTER TABLE orders ADD UNIQUE INDEX idx_orders_parent_payment (parent_invoice_id,payment_method)');
        await expect(migrate()).rejects.toThrow('preflight rejected');
        await expect(validateRequiredSchema(pool)).rejects.toThrow('paid_split_parent_index');
        await preserved();
    });
    it.each(['missing predecessor','predecessor checksum','target checksum'])('fails closed for %s', async mode => {
        if (mode==='missing predecessor') await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[target.requires.name]);
        else if (mode==='predecessor checksum') await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?',['a'.repeat(64),target.requires.name]);
        else await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)',[target.name,'b'.repeat(64)]);
        await expect(migrate()).rejects.toThrow(/checksum|requires/);
        expect((await pool.query("SHOW INDEX FROM orders WHERE Key_name='idx_orders_parent_payment'"))[0]).toEqual([]);
        await preserved();
    });
    it('requires the current startup ledger even with the correct schema', async () => {
        const current = manifest.migrations.at(-1);
        await pool.query('ALTER TABLE orders ADD INDEX idx_orders_parent_payment (parent_invoice_id,payment_method)');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [current.name]);
        await expect(validateRequiredSchema(pool)).rejects.toThrow('ledger entry is missing');
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)',[current.name,'a'.repeat(64)]);
        await expect(validateRequiredSchema(pool)).rejects.toThrow('checksum does not match');
    });
    it('ships identical execution SQL and a schema-only, hash-verified baseline', () => {
        const hash = text => createHash('sha256').update(text).digest('hex');
        expect(hash(sql)).toBe(target.sha256);
        expect(hash(read(path.join(directory,target.preflight)))).toBe(target.preflightSha256);
        expect(read(path.join(__dirname,'../../migrations',target.file.replace('.auto.sql','.sql')))).toBe(sql);
        const fallback=read(path.join(__dirname,'../../../deployment/database/hostinger-manual-migrations.sql'));
        expect(fallback.split(`-- BEGIN AUTO MIGRATION: ${target.name} | ${target.checksum}\n`)[1].split(`-- END AUTO MIGRATION: ${target.name}`)[0]).toBe(sql);
        expect(manifest.migrations[manifest.migrations.indexOf(target)-1]).toMatchObject(target.requires);
        const { baseline }=require('../../../deployment/tools/bootstrap-database').readVerifiedBaseline();
        expect(baseline).not.toMatch(/^\s*(?:INSERT|REPLACE)\s/im);
        expect(baseline).toContain('KEY idx_orders_parent_payment (parent_invoice_id,payment_method)');
    });
});
