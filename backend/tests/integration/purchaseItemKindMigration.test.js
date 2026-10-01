import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const manifest = require('../../migrations/auto-manifest.json');
const name = '2026-10-02-purchase-item-kind-v1';
const target = manifest.migrations.find(row => row.name === name);
const predecessor = manifest.migrations.find(row => row.name === target.requires.name);
const retire = manifest.migrations.find(row => row.name === predecessor.requires.name);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-purchase-kind-'));
const stockDocumentsManifest = path.join(directory, 'stock-documents.json');
const kindManifest = path.join(directory, 'purchase-kind.json');
const suffix = crypto.randomBytes(6).toString('hex');
const database = `posapp_purchase_kind_${suffix}`;
const baselineDatabase = `posapp_purchase_kind_base_${suffix}`;
let admin;
let pool;
const created = [];
fs.writeFileSync(stockDocumentsManifest, JSON.stringify({ migrations: [predecessor] }));
fs.writeFileSync(kindManifest, JSON.stringify({ migrations: [target] }));
for (const row of [predecessor, target]) fs.copyFileSync(path.join(__dirname, '../../migrations', row.file), path.join(directory, row.file));

// MariaDB reports a failed CHECK as errno 4025; the driver's name table does not know it.
const outcome = async (work) => { try { await work(); } catch (error) { return error.errno === 4025 ? 'CHECK_FAILED' : error.code; } return 'accepted'; };
const kinds = async () => (await pool.query('SELECT id, item_kind FROM stock_documents ORDER BY id'))[0].map(row => [row.id, row.item_kind]);
const insertPurchase = (reference, itemKind, supplier = 3) => pool.query(
  "INSERT INTO stock_documents (doc_type, item_kind, supplier_id, reference, doc_date, payment_status) VALUES ('purchase', ?, ?, ?, '2026-10-02', 'paid')",
  [itemKind, supplier, reference]);

// The schema as 2026-10-01-stock-documents-v1 left it (the real migration applied to the tables it points at),
// holding one document of every shape the backfill has to classify.
async function predecessorSchema() {
  await pool.query('SET FOREIGN_KEY_CHECKS=0');
  for (const table of ['stock_document_lines', 'stock_documents', 'purchase_suppliers', 'products', 'ingredients', 'schema_migrations']) {
    await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS=1');
  await pool.query('CREATE TABLE schema_migrations (migration_name varchar(191) PRIMARY KEY, checksum char(64) NOT NULL) ENGINE=InnoDB');
  await pool.query('CREATE TABLE products (id int PRIMARY KEY) ENGINE=InnoDB');
  await pool.query('CREATE TABLE ingredients (id int PRIMARY KEY) ENGINE=InnoDB');
  await pool.query('CREATE TABLE purchase_suppliers (id int PRIMARY KEY, name varchar(120) NOT NULL) ENGINE=InnoDB');
  await pool.query('INSERT INTO schema_migrations VALUES (?, ?)', [retire.name, retire.checksum]);
  expect((await runPendingMigrations(pool, { manifestPath: stockDocumentsManifest })).applied).toEqual([predecessor.name]);
  await pool.query('INSERT INTO products VALUES (5), (6)');
  await pool.query('INSERT INTO ingredients VALUES (9), (10)');
  await pool.query("INSERT INTO purchase_suppliers VALUES (3, 'Supplier three'), (4, 'Supplier four')");
  await pool.query(
    `INSERT INTO stock_documents (id, doc_type, status, supplier_id, reference, doc_date, payment_status) VALUES
       (1, 'purchase', 'posted', 3, 'P-ONLY', '2026-10-01', 'paid'),
       (2, 'purchase', 'draft', 3, 'I-ONLY', '2026-10-01', 'credit'),
       (3, 'purchase', 'draft', 3, 'MIXED', '2026-10-01', 'credit'),
       (4, 'purchase', 'draft', 4, 'EMPTY', '2026-10-01', 'credit')`);
  await pool.query("INSERT INTO stock_documents (id, doc_type, status, reference, doc_date) VALUES (5, 'count', 'posted', 'Count sheet', '2026-10-01')");
  await pool.query(
    `INSERT INTO stock_document_lines (document_id, line_no, product_id, ingredient_id, unit_label, unit_factor) VALUES
       (1, 1, 5, NULL, 'box', 1),
       (2, 1, NULL, 9, 'kg', 1000), (2, 2, NULL, 10, 'kg', 1000),
       (3, 1, 6, NULL, 'box', 1), (3, 2, NULL, 9, 'kg', 1000),
       (5, 1, 5, NULL, 'box', 1), (5, 2, NULL, 9, 'kg', 1000)`);
}

// What the shared header table looks like to a reader of information_schema.
async function headerShape(db) {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_documents' ORDER BY ORDINAL_POSITION`);
  const [keys] = await db.query(
    `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, MAX(NON_UNIQUE) AS non_unique FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_documents' GROUP BY INDEX_NAME ORDER BY INDEX_NAME`);
  const [[check]] = await db.query(
    `SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='stock_documents' AND CONSTRAINT_NAME='ck_stock_document_shape'`);
  return { columns: columns.map(row => ({ ...row })), keys: keys.map(row => ({ ...row })), check: check.CHECK_CLAUSE.replace(/\s+/g, ' ') };
}

describe('purchase item kind migration', () => {
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
    for (const file of [predecessor.file, target.file, 'stock-documents.json', 'purchase-kind.json']) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });

  it('puts every existing purchase document on one side: all-ingredient documents are ingredient, the rest are product', async () => {
    expect((await runPendingMigrations(pool, { manifestPath: kindManifest })).applied).toEqual([name]);
    // product-only, ingredient-only, mixed, no lines; the count sheet stays untyped even though it mixes both
    expect(await kinds()).toEqual([[1, 'product'], [2, 'ingredient'], [3, 'product'], [4, 'product'], [5, null]]);
    const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM stock_document_lines');
    expect(row.n).toBe(7);
    const [[position]] = await pool.query(
      `SELECT c.ORDINAL_POSITION - d.ORDINAL_POSITION AS gap FROM information_schema.COLUMNS c JOIN information_schema.COLUMNS d
        ON d.TABLE_SCHEMA=c.TABLE_SCHEMA AND d.TABLE_NAME=c.TABLE_NAME AND d.COLUMN_NAME='doc_type'
        WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME='stock_documents' AND c.COLUMN_NAME='item_kind'`);
    expect(Number(position.gap)).toBe(1);
  });

  it('requires a kind on a purchase and forbids one on a count', async () => {
    await runPendingMigrations(pool, { manifestPath: kindManifest });
    expect(await outcome(() => insertPurchase('NO-KIND', null))).toBe('CHECK_FAILED');
    expect(await outcome(() => pool.query("INSERT INTO stock_documents (doc_type, item_kind, doc_date) VALUES ('count', 'product', '2026-10-02')"))).toBe('CHECK_FAILED');
    expect(await outcome(() => pool.query("INSERT INTO stock_documents (doc_type, doc_date) VALUES ('count', '2026-10-02')"))).toBe('accepted');
    expect(await outcome(() => insertPurchase('WITH-KIND', 'ingredient'))).toBe('accepted');
    // A purchase that was typed by the backfill cannot lose its kind afterwards either.
    expect(await outcome(() => pool.query('UPDATE stock_documents SET item_kind = NULL WHERE id = 1'))).toBe('CHECK_FAILED');
  });

  it('allows a supplier invoice number once per kind and still refuses it twice on one side', async () => {
    await runPendingMigrations(pool, { manifestPath: kindManifest });
    // 'P-ONLY' is already a product invoice of supplier 3
    expect(await outcome(() => insertPurchase('P-ONLY', 'product'))).toBe('ER_DUP_ENTRY');
    expect(await outcome(() => insertPurchase('P-ONLY', 'ingredient'))).toBe('accepted');
    expect(await outcome(() => insertPurchase('P-ONLY', 'ingredient'))).toBe('ER_DUP_ENTRY');
    expect(await outcome(() => insertPurchase('P-ONLY', 'product', 4))).toBe('accepted');
    // the supplier foreign key still has an index to stand on
    expect(await outcome(() => insertPurchase('NO-SUCH-SUPPLIER', 'product', 99))).toBe('ER_NO_REFERENCED_ROW_2');
  });

  it('is a no-op when run again, and a re-run without its ledger row leaves the data as it was', async () => {
    expect((await runPendingMigrations(pool, { manifestPath: kindManifest })).applied).toEqual([name]);
    expect((await runPendingMigrations(pool, { manifestPath: kindManifest })).applied).toEqual([]);
    await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [name]);
    expect((await runPendingMigrations(pool, { manifestPath: kindManifest })).applied).toEqual([name]);
    expect(await kinds()).toEqual([[1, 'product'], [2, 'ingredient'], [3, 'product'], [4, 'product'], [5, null]]);
    expect(await outcome(() => insertPurchase('P-ONLY', 'product'))).toBe('ER_DUP_ENTRY');
  });

  it('fails closed before changing anything without its predecessor, or with a conflicting ledger row', async () => {
    const columnExists = async () => (await pool.query(
      "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_documents' AND COLUMN_NAME='item_kind'"))[0].length === 1;
    await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [predecessor.name]);
    await expect(runPendingMigrations(pool, { manifestPath: kindManifest })).rejects.toThrow(/requires/);
    // The manual Hostinger path runs the SQL itself: its own guard has to stop it before the first change.
    const sql = fs.readFileSync(path.join(directory, target.file), 'utf8');
    await expect(pool.query(sql)).rejects.toThrow(/posapp_purchase_item_kind_requires_review/);
    expect(await columnExists()).toBe(false);
    await pool.query('INSERT INTO schema_migrations VALUES (?, ?)', [predecessor.name, predecessor.checksum]);
    await pool.query('INSERT INTO schema_migrations VALUES (?, ?)', [name, 'f'.repeat(64)]);
    await expect(runPendingMigrations(pool, { manifestPath: kindManifest })).rejects.toThrow(/checksum conflict/);
    await expect(pool.query(sql)).rejects.toThrow(/posapp_purchase_item_kind_requires_review/);
    expect(await columnExists()).toBe(false);
  });

  it('leaves the same header table a fresh install gets from the baseline', async () => {
    await runPendingMigrations(pool, { manifestPath: kindManifest });
    const fresh = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
      port: Number(process.env.DB_PORT || 3306), database: baselineDatabase, multipleStatements: true,
    });
    try {
      await fresh.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
      expect(await headerShape(pool)).toEqual(await headerShape(fresh));
    } finally {
      await fresh.end();
    }
  });
});
