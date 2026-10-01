import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.test'), override: true });

const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const DATABASE = 'posapp_expense_zero_migration_test';
const NAME = '2026-09-02-expense-zero-amount-v1';
const FLOOR_NAME = '2026-07-29-subscription-receivables-v1';
const FLOOR_CHECKSUM = 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da';

describe('zero-valued expense automatic migration', () => {
    it('changes only the amount constraint and remains idempotent', async () => {
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            port: Number(process.env.DB_PORT || 3306),
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(`
                CREATE TABLE schema_migrations (
                    migration_name VARCHAR(191) NOT NULL PRIMARY KEY,
                    checksum CHAR(64) NOT NULL,
                    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE expenses (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    amount DECIMAL(10,2) NOT NULL,
                    CONSTRAINT chk_expenses_amount CHECK (amount > 0)
                );
                INSERT INTO expenses (amount) VALUES (5.00);
            `);

            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            const targetIndex = manifest.migrations.findIndex(({ name }) => name === NAME);
            const prior = manifest.migrations.slice(0, targetIndex);
            const successors = manifest.migrations.slice(targetIndex + 1);
            await admin.query(
                'INSERT INTO schema_migrations (migration_name,checksum) VALUES (?,?)',
                [FLOOR_NAME, FLOOR_CHECKSUM]
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name,checksum) VALUES ${[...prior, ...successors].map(() => '(?,?)').join(',')}`,
                [...prior, ...successors].flatMap(({ name, checksum }) => [name, checksum])
            );

            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                port: Number(process.env.DB_PORT || 3306),
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [NAME],
                skipped: [...prior, ...successors].map(({ name }) => name),
            });
            await expect(pool.query('INSERT INTO expenses (amount) VALUES (0)')).resolves.toBeTruthy();
            await expect(pool.query('INSERT INTO expenses (amount) VALUES (-0.01)')).rejects.toThrow();
            const [[negative]] = await pool.query('SELECT COUNT(*) AS count FROM expenses WHERE amount < 0');
            expect(Number(negative.count)).toBe(0);
            const [[preserved]] = await pool.query('SELECT amount FROM expenses WHERE id=1');
            expect(Number(preserved.amount)).toBe(5);
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name),
            });
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });
});
