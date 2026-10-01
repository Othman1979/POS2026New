import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const manifest = require('../../migrations/auto-manifest.json');
const name = '2026-10-03-product-barcodes-v1';
const target = manifest.migrations.find(row => row.name === name);
const predecessor = manifest.migrations.find(row => row.name === target.requires.name);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-product-barcodes-'));
const barcodesManifest = path.join(directory, 'product-barcodes.json');
const suffix = crypto.randomBytes(6).toString('hex');
const database = `posapp_product_barcodes_${suffix}`;
const baselineDatabase = `posapp_product_barcodes_base_${suffix}`;
let admin;
let pool;
const created = [];
fs.writeFileSync(barcodesManifest, JSON.stringify({ migrations: [target] }));
fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));

const outcome = async (work) => { try { await work(); } catch (error) { return error.code; } return 'accepted'; };
const insertExtra = (productId, barcode) => pool.query('INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)', [productId, barcode]);

// The schema this migration builds on: a products table (utf8mb4_general_ci with the unique main barcode, as in
// production) and the ledger row of its predecessor.
async function predecessorSchema() {
  await pool.query('SET FOREIGN_KEY_CHECKS=0');
  for (const table of ['product_barcodes', 'products', 'schema_migrations']) await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
  await pool.query('SET FOREIGN_KEY_CHECKS=1');
  await pool.query('CREATE TABLE schema_migrations (migration_name varchar(191) PRIMARY KEY, checksum char(64) NOT NULL) ENGINE=InnoDB');
  await pool.query(
    `CREATE TABLE products (id int(11) NOT NULL AUTO_INCREMENT, barcode varchar(50) DEFAULT NULL, name varchar(100) NOT NULL,
       PRIMARY KEY (id), UNIQUE KEY idx_barcode (barcode)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  await pool.query("INSERT INTO products (id, barcode, name) VALUES (1, 'MAIN-1', 'One'), (2, 'MAIN-2', 'Two')");
  await pool.query('INSERT INTO schema_migrations VALUES (?, ?)', [predecessor.name, predecessor.checksum]);
}

async function tableShape(db) {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_barcodes' ORDER BY ORDINAL_POSITION`);
  const [keys] = await db.query(
    `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, MAX(NON_UNIQUE) AS non_unique FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_barcodes' GROUP BY INDEX_NAME ORDER BY INDEX_NAME`);
  const [foreignKeys] = await db.query(
    `SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='product_barcodes'`);
  const [[table]] = await db.query(
    "SELECT TABLE_COLLATION, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_barcodes'");
  return {
    columns: columns.map(row => ({ ...row })), keys: keys.map(row => ({ ...row })),
    foreignKeys: foreignKeys.map(row => ({ ...row })), table: { ...table },
  };
}

describe('product barcodes migration', () => {
  beforeAll(async () => {
    const host = process.env.DB_HOST || '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Migration test requires loopback MySQL.');
    const options = { host, user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', port: Number(process.env.DB_PORT || 3306) };
    admin = await mysql.createConnection({ ...options, multipleStatements: true });
    for (const db of [database, baselineDatabase]) {
      await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      created.push(db);
    }
    pool = mysql.createPool({ ...options, database, connectionLimit: 2, multipleStatements: true });
  });
  beforeEach(predecessorSchema);
  afterAll(async () => {
    await pool?.end();
    try {
      for (const db of created) await admin.query(`DROP DATABASE \`${db}\``);
    } finally {
      await admin?.end();
    }
    for (const file of [target.file, 'product-barcodes.json']) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });

  it('adds the extra barcode table with a unique code, a product index and the products collation', async () => {
    expect((await runPendingMigrations(pool, { manifestPath: barcodesManifest })).applied).toEqual([name]);
    const shape = await tableShape(pool);
    expect(shape.columns.map(row => row.COLUMN_NAME)).toEqual(['id', 'product_id', 'barcode', 'created_at']);
    expect(shape.columns.find(row => row.COLUMN_NAME === 'barcode')).toMatchObject({ COLUMN_TYPE: 'varchar(50)', IS_NULLABLE: 'NO', COLLATION_NAME: 'utf8mb4_general_ci' });
    expect(shape.keys.map(row => [row.INDEX_NAME, row.cols, Number(row.non_unique)]).sort((a, b) => (a[0] < b[0] ? -1 : 1))).toEqual([
      ['PRIMARY', 'id', 0],
      ['idx_product_barcodes_product', 'product_id,id', 1],
      ['uq_product_barcode', 'barcode', 0],
    ]);
    expect(shape.foreignKeys).toEqual([{ CONSTRAINT_NAME: 'fk_product_barcodes_product', REFERENCED_TABLE_NAME: 'products', DELETE_RULE: 'CASCADE' }]);
    expect(shape.table).toMatchObject({ TABLE_COLLATION: 'utf8mb4_general_ci', ENGINE: 'InnoDB' });
  });

  it('keeps a code unique whatever its case, and follows its product when the product is deleted', async () => {
    await runPendingMigrations(pool, { manifestPath: barcodesManifest });
    expect(await outcome(() => insertExtra(1, 'Extra-A'))).toBe('accepted');
    expect(await outcome(() => insertExtra(2, 'extra-a'))).toBe('ER_DUP_ENTRY');
    expect(await outcome(() => insertExtra(1, 'Extra-B'))).toBe('accepted');
    expect(await outcome(() => insertExtra(99, 'ORPHAN'))).toBe('ER_NO_REFERENCED_ROW_2');
    await pool.query('DELETE FROM products WHERE id = 1');
    const [rows] = await pool.query('SELECT * FROM product_barcodes');
    expect(rows).toEqual([]);
    // A deleted product's codes are free again.
    expect(await outcome(() => insertExtra(2, 'Extra-A'))).toBe('accepted');
  });

  it('is a no-op when run again, and a re-run without its ledger row keeps the extras', async () => {
    expect((await runPendingMigrations(pool, { manifestPath: barcodesManifest })).applied).toEqual([name]);
    await insertExtra(1, 'KEEP-ME');
    expect((await runPendingMigrations(pool, { manifestPath: barcodesManifest })).applied).toEqual([]);
    await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [name]);
    expect((await runPendingMigrations(pool, { manifestPath: barcodesManifest })).applied).toEqual([name]);
    const [rows] = await pool.query('SELECT product_id, barcode FROM product_barcodes');
    expect(rows.map(row => [row.product_id, row.barcode])).toEqual([[1, 'KEEP-ME']]);
  });

  it('fails closed before changing anything without its predecessor, or with a conflicting ledger row', async () => {
    const tableExists = async () => (await pool.query(
      "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_barcodes'"))[0].length === 1;
    await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [predecessor.name]);
    await expect(runPendingMigrations(pool, { manifestPath: barcodesManifest })).rejects.toThrow(/requires/);
    // The manual Hostinger path runs the SQL itself: its own guard has to stop it before the first change.
    const sql = fs.readFileSync(path.join(directory, target.file), 'utf8');
    await expect(pool.query(sql)).rejects.toThrow(/posapp_product_barcodes_requires_review/);
    expect(await tableExists()).toBe(false);
    await pool.query('INSERT INTO schema_migrations VALUES (?, ?)', [predecessor.name, predecessor.checksum]);
    await pool.query('INSERT INTO schema_migrations VALUES (?, ?)', [name, 'f'.repeat(64)]);
    await expect(runPendingMigrations(pool, { manifestPath: barcodesManifest })).rejects.toThrow(/checksum conflict/);
    await expect(pool.query(sql)).rejects.toThrow(/posapp_product_barcodes_requires_review/);
    expect(await tableExists()).toBe(false);
  });

  it('leaves the same table a fresh install gets from the baseline', async () => {
    await runPendingMigrations(pool, { manifestPath: barcodesManifest });
    const fresh = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
      port: Number(process.env.DB_PORT || 3306), database: baselineDatabase, multipleStatements: true,
    });
    try {
      await fresh.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
      expect(await tableShape(pool)).toEqual(await tableShape(fresh));
    } finally {
      await fresh.end();
    }
  });
});
