import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.test'), override: true });

const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const DATABASE = 'posapp_fractional_stock_migration_test';
const NAME = '2026-09-01-fractional-stock-precision-v1';
const FLOOR_NAME = '2026-07-29-subscription-receivables-v1';
const FLOOR_CHECKSUM = 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da';

describe('fractional stock precision automatic migration', () => {
    it('upgrades the exact legacy columns once without losing values', async () => {
        if (DATABASE !== 'posapp_fractional_stock_migration_test') {
            throw new Error('Refusing to use an unexpected scratch database.');
        }
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            port: Number(process.env.DB_PORT || 3306),
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            multipleStatements: true
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
                CREATE TABLE products (
                    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    stock INT DEFAULT NULL,
                    min_stock_level INT DEFAULT 10,
                    max_stock_level INT DEFAULT 100,
                    price_override_locked TINYINT(1) NOT NULL DEFAULT 0
                );
                INSERT INTO products (stock,min_stock_level,max_stock_level)
                VALUES (2147483647,10,100),(NULL,4,500);
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
                connectionLimit: 2
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [NAME],
                skipped: [...prior, ...successors].map(({ name }) => name)
            });
            const [columns] = await pool.query(`
                SELECT COLUMN_NAME, COLUMN_TYPE
                  FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA=? AND TABLE_NAME='products'
                   AND COLUMN_NAME IN ('stock','min_stock_level','max_stock_level')
                 ORDER BY ORDINAL_POSITION
            `, [DATABASE]);
            expect(columns).toEqual([
                { COLUMN_NAME: 'stock', COLUMN_TYPE: 'decimal(16,6)' },
                { COLUMN_NAME: 'min_stock_level', COLUMN_TYPE: 'decimal(16,6)' },
                { COLUMN_NAME: 'max_stock_level', COLUMN_TYPE: 'decimal(16,6)' }
            ]);
            const [products] = await pool.query('SELECT stock,min_stock_level,max_stock_level FROM products ORDER BY id');
            expect(products).toEqual([
                { stock: '2147483647.000000', min_stock_level: '10.000000', max_stock_level: '100.000000' },
                { stock: null, min_stock_level: '4.000000', max_stock_level: '500.000000' }
            ]);

            await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [NAME]);
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [NAME],
                skipped: [...prior, ...successors].map(({ name }) => name)
            });
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name)
            });

            await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [NAME]);
            await pool.query('ALTER TABLE products MODIFY COLUMN stock INT DEFAULT NULL, ALGORITHM=COPY, LOCK=SHARED');
            await expect(runPendingMigrations(pool)).rejects.toThrow(
                `Migration ${NAME} preflight rejected the current schema.`
            );
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });
});
