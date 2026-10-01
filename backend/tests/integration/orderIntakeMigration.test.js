const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations } = require('../../migrations/runPendingMigrations');

const NAME = '2026-09-20-order-intake-requests-v1';

describe('order-intake durable request upgrade', () => {
    const target = require('../../migrations/auto-manifest.json').migrations.find(row => row.name === NAME);
    let directory;
    let manifestPath;

    beforeAll(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-order-intake-migration-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        for (const file of [target.file, target.preflight]) {
            fs.copyFileSync(path.join(__dirname, '../../migrations', file), path.join(directory, file));
        }
    });

    beforeEach(async () => {
        await seedDatabase();
        await pool.query('DROP TABLE order_intake_requests');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [NAME]);
    });

    afterAll(async () => {
        await pool.end();
        for (const file of [target.file, target.preflight, 'manifest.json']) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });

    const migrate = () => runPendingMigrations(pool, { manifestPath });

    it('upgrades the exact predecessor, enforces one durable request identity, and safely repeats', async () => {
        expect((await migrate()).applied).toEqual([NAME]);
        const [columns] = await pool.query(`
            SELECT COLUMN_NAME,DATA_TYPE,IS_NULLABLE,COLLATION_NAME
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
             ORDER BY ORDINAL_POSITION
        `);
        expect(columns.map(row => row.COLUMN_NAME)).toEqual([
            'client_id', 'external_request_id', 'request_hash', 'held_order_id', 'result_json', 'created_at',
        ]);
        const [indexes] = await pool.query(`
            SELECT INDEX_NAME,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_in_order
              FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
             GROUP BY INDEX_NAME ORDER BY INDEX_NAME
        `);
        expect(indexes).toEqual([
            { INDEX_NAME: 'idx_order_intake_created_at', columns_in_order: 'created_at' },
            { INDEX_NAME: 'idx_order_intake_held_order', columns_in_order: 'held_order_id' },
            { INDEX_NAME: 'PRIMARY', columns_in_order: 'client_id,external_request_id' },
        ]);
        await pool.query(`
            INSERT INTO order_intake_requests
                (client_id,external_request_id,request_hash,held_order_id,result_json)
            VALUES ('test-client','call-12345678',REPEAT('a',64),1,'{"id":1}')
        `);
        await expect(pool.query(`
            INSERT INTO order_intake_requests
                (client_id,external_request_id,request_hash,held_order_id,result_json)
            VALUES ('test-client','call-12345678',REPEAT('b',64),2,'{"id":2}')
        `)).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
        await expect(pool.query(`
            INSERT INTO order_intake_requests
                (client_id,external_request_id,request_hash,held_order_id,result_json)
            VALUES ('test-client','call-invalid-json',REPEAT('c',64),2,'not-json')
        `)).rejects.toBeTruthy();
        expect((await migrate()).applied).toEqual([]);
    });

    it('rejects a same-name table with the wrong shape before writing the ledger', async () => {
        await pool.query('CREATE TABLE order_intake_requests (client_id VARCHAR(40) PRIMARY KEY) ENGINE=InnoDB');
        await expect(migrate()).rejects.toThrow('preflight rejected');
        const [ledger] = await pool.query('SELECT * FROM schema_migrations WHERE migration_name=?', [NAME]);
        expect(ledger).toEqual([]);
    });

    it('rejects a named secondary index with an extra column', async () => {
        await pool.query(`
            CREATE TABLE order_intake_requests (
              client_id VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
              external_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
              request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
              held_order_id INT NOT NULL,
              result_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (client_id, external_request_id),
              KEY idx_order_intake_held_order (held_order_id, created_at),
              KEY idx_order_intake_created_at (created_at),
              CONSTRAINT chk_order_intake_result_json CHECK (JSON_VALID(result_json))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await expect(migrate()).rejects.toThrow('preflight rejected');
        const [ledger] = await pool.query('SELECT * FROM schema_migrations WHERE migration_name=?', [NAME]);
        expect(ledger).toEqual([]);
    });
});
