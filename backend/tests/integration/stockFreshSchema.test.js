const pool = require('../../config/db');
const { getTestDatabaseOptions } = require('../testDatabase.cjs');
const { bootstrapDatabase, readVerifiedBaseline } = require('../../../deployment/tools/bootstrap-database');
const { splitMysqlScript, runPendingMigrations } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');

describe('Fresh stock schema through the real installer', () => {
    afterAll(() => pool.end());
    test('imports the baseline, seeds it, validates it and skips covered migrations twice', async () => {
        const { database } = getTestDatabaseOptions();
        const conn = await pool.getConnection();
        try {
            const [[selected]] = await conn.query('SELECT DATABASE() name');
            expect(selected.name).toBe(database);
            const [tables] = await conn.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
            await conn.query('SET FOREIGN_KEY_CHECKS=0');
            try {
                for (const { name } of tables) {
                    if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected fixture table');
                    await conn.query(`DROP TABLE \`${name}\``);
                }
            } finally { await conn.query('SET FOREIGN_KEY_CHECKS=1'); }
            const { baseline } = readVerifiedBaseline();
            const executor = { async query(sql, params) {
                // Real schema/data statements; account administration is outside
                // this generated database fixture and is never executed.
                if (/^(?:CREATE DATABASE|USE |CREATE USER|GRANT |FLUSH PRIVILEGES|ALTER USER)/.test(sql)) return [[]];
                if (sql === baseline) {
                    for (const statement of splitMysqlScript(sql)) await conn.query(statement);
                    return [[]];
                }
                return conn.query(sql,params);
            }};
            await bootstrapDatabase({ database, executor, appPassword:'fixture-only', maintenancePassword:'fixture-only', adminPassword:'fixture-only', programmerUserNumber:'876543219876' });
            const [[counts]] = await conn.query("SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()) tables_count,(SELECT COUNT(*) FROM orders) orders_count,(SELECT COUNT(*) FROM users) users_count");
            expect(counts).toEqual({ tables_count:74,orders_count:0,users_count:2 });
        } finally { conn.release(); }
        for (let attempt=0;attempt<2;attempt++) {
            expect((await runPendingMigrations(pool)).applied).toEqual([]);
            await validateRequiredSchema(pool);
        }
        await pool.query('ALTER TABLE stock_movements DROP FOREIGN KEY fk_stock_movement_balance');
        await expect(validateRequiredSchema(pool)).rejects.toThrow();
    });
});
