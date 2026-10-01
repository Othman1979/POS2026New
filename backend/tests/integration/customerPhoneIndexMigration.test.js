const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');

const EXPRESSION = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), '')";
const NAME = '2026-09-19-customer-phone-index-v1';

describe('customer phone index upgrade', () => {
    const target = require('../../migrations/auto-manifest.json').migrations.find(row => row.name === NAME);
    let directory;
    let manifestPath;

    beforeAll(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-customer-phone-index-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        for (const file of [target.file, target.preflight]) {
            fs.copyFileSync(path.join(__dirname, '../../migrations', file), path.join(directory, file));
        }
    });

    beforeEach(async () => {
        await seedDatabase();
        await pool.query('ALTER TABLE customers DROP INDEX idx_customers_phone_normalized, DROP COLUMN phone_normalized');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [NAME]);
        await pool.query(`INSERT INTO customers (name, phone, address) VALUES
            ('Formatted first', '079-123 4567', 'Amman'),
            ('Formatted duplicate', '079 123-4567', 'Zarqa'),
            ('Invalid legacy', '079race0001', 'Legacy')`);
    });

    afterAll(async () => {
        await pool.end();
        for (const file of [target.file, target.preflight, 'manifest.json']) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });

    const migrate = () => runPendingMigrations(pool, { manifestPath });
    const addExactColumn = () => pool.query(`ALTER TABLE customers ADD COLUMN phone_normalized VARCHAR(20)
        GENERATED ALWAYS AS (${EXPRESSION}) STORED AFTER phone`);

    async function verifyShape() {
        const [[column]] = await pool.query(`SELECT DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,EXTRA,GENERATION_EXPRESSION
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND COLUMN_NAME='phone_normalized'`);
        expect(column).toMatchObject({ DATA_TYPE: 'varchar', CHARACTER_MAXIMUM_LENGTH: 20 });
        expect(column.EXTRA).toContain('STORED GENERATED');
        const [index] = await pool.query(`SELECT COLUMN_NAME,NON_UNIQUE,SUB_PART FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND INDEX_NAME='idx_customers_phone_normalized'
            ORDER BY SEQ_IN_INDEX`);
        expect(index).toEqual([
            { COLUMN_NAME: 'phone_normalized', NON_UNIQUE: 1, SUB_PART: null },
            { COLUMN_NAME: 'id', NON_UNIQUE: 1, SUB_PART: null },
        ]);
        return column;
    }

    it('upgrades the exact predecessor, preserves ambiguous legacy data, updates generated values, and safely repeats', async () => {
        const before = (await pool.query('SELECT id,name,phone,address FROM customers ORDER BY id'))[0];
        expect((await migrate()).applied).toEqual([NAME]);
        await verifyShape();
        expect((await pool.query('SELECT id,name,phone,address FROM customers ORDER BY id'))[0]).toEqual(before);
        const [matches] = await pool.query("SELECT name FROM customers WHERE phone_normalized='0791234567' ORDER BY id");
        expect(matches.map(row => row.name)).toEqual(['Formatted first', 'Formatted duplicate']);
        const [[legacy]] = await pool.query("SELECT phone_normalized FROM customers WHERE name='Invalid legacy'");
        expect(legacy.phone_normalized).toBe('079race0001');
        await pool.query("UPDATE customers SET phone='+962 (79) 555.0000' WHERE name='Invalid legacy'");
        const [[updated]] = await pool.query("SELECT phone_normalized FROM customers WHERE name='Invalid legacy'");
        expect(updated.phone_normalized).toBe('962795550000');
        expect((await migrate()).applied).toEqual([]);

        const conn = await pool.getConnection();
        try {
            for (const statement of splitMysqlScript(fs.readFileSync(path.join(directory, target.file), 'utf8'))) {
                await conn.query(statement);
            }
        } finally {
            conn.release();
        }
        await verifyShape();
    });

    it('resumes from an exact generated column without its index or ledger row', async () => {
        await addExactColumn();
        expect((await migrate()).applied).toEqual([NAME]);
        await verifyShape();
    });

    it('rejects a same-name ordinary column before any migration statement runs', async () => {
        await pool.query('ALTER TABLE customers ADD COLUMN phone_normalized VARCHAR(20)');
        await expect(migrate()).rejects.toThrow('preflight rejected');
        expect((await pool.query('SELECT * FROM schema_migrations WHERE migration_name=?', [NAME]))[0]).toEqual([]);
    });

    it('rejects a same-name generated column with a different expression', async () => {
        await pool.query("ALTER TABLE customers ADD COLUMN phone_normalized VARCHAR(20) GENERATED ALWAYS AS (REPLACE(phone, ' ', '')) STORED");
        await expect(migrate()).rejects.toThrow('preflight rejected');
        expect((await pool.query('SELECT * FROM schema_migrations WHERE migration_name=?', [NAME]))[0]).toEqual([]);
    });

    it('rejects a same-name index with the wrong column order', async () => {
        await addExactColumn();
        await pool.query('ALTER TABLE customers ADD INDEX idx_customers_phone_normalized (id,phone_normalized)');
        await expect(migrate()).rejects.toThrow('preflight rejected');
        expect((await pool.query('SELECT * FROM schema_migrations WHERE migration_name=?', [NAME]))[0]).toEqual([]);
    });

    it.each(['missing', 'conflicting'])('rejects a %s predecessor without altering customer data', async mode => {
        const before = (await pool.query('SELECT id,name,phone,address FROM customers ORDER BY id'))[0];
        if (mode === 'missing') await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
        else await pool.query('UPDATE schema_migrations SET checksum=REPEAT(?,64) WHERE migration_name=?', ['a', target.requires.name]);
        await expect(migrate()).rejects.toThrow('exact checksum');
        expect((await pool.query('SELECT id,name,phone,address FROM customers ORDER BY id'))[0]).toEqual(before);
    });

    it('rejects a conflicting target ledger checksum', async () => {
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,REPEAT(?,64))', [NAME, 'b']);
        await expect(migrate()).rejects.toThrow(/checksum/i);
        expect((await pool.query("SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND COLUMN_NAME='phone_normalized'"))[0][0].count).toBe(0);
    });

    it('changes a representative lookup from a scan to a two-row indexed read', async () => {
        const rows = Array.from({ length: 10_000 }, (_, index) => [
            `Perf ${index}`,
            `06${String(index).padStart(8, '0')}`,
        ]);
        for (let offset = 0; offset < rows.length; offset += 500) {
            await pool.query('INSERT INTO customers (name,phone) VALUES ?', [rows.slice(offset, offset + 500)]);
        }
        const targetPhone = rows.at(-1)[1];
        const legacySql = `SELECT id FROM customers c WHERE ${EXPRESSION}=? ORDER BY id ASC LIMIT 2`;
        const indexedSql = 'SELECT id FROM customers WHERE phone_normalized=? ORDER BY id ASC LIMIT 2';
        const conn = await pool.getConnection();
        const measure = async sql => {
            await conn.query('FLUSH STATUS');
            const samples = [];
            for (let round = 0; round < 25; round += 1) {
                const started = performance.now();
                await conn.query(sql, [targetPhone]);
                samples.push(performance.now() - started);
            }
            const [[status]] = await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'");
            samples.sort((a, b) => a - b);
            return {
                rowsRead: Number(status.Value),
                medianMs: samples[Math.floor(samples.length / 2)],
                p95Ms: samples[Math.floor(samples.length * 0.95)],
            };
        };
        try {
            const before = await measure(legacySql);
            expect((await migrate()).applied).toEqual([NAME]);
            const after = await measure(indexedSql);
            const [[explain]] = await conn.query(`EXPLAIN FORMAT=JSON ${indexedSql}`, [targetPhone]);
            const plan = JSON.parse(explain.EXPLAIN);
            expect(JSON.stringify(plan)).toContain('idx_customers_phone_normalized');
            expect(after.rowsRead).toBeLessThanOrEqual(50);
            expect(before.rowsRead).toBeGreaterThan(after.rowsRead * 100);
            const evidence = { customers: rows.length, before, after };
            if (process.env.POSAPP_WRITE_PHONE_INDEX_EVIDENCE === '1') {
                const output = path.resolve(__dirname, '../../../scratch/customer-phone-index-evidence.json');
                fs.mkdirSync(path.dirname(output), { recursive: true });
                fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
            }
            console.log('customer phone lookup evidence', JSON.stringify(evidence));
        } finally {
            conn.release();
        }
    });
});
