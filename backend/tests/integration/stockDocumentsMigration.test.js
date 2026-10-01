import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const manifest = require('../../migrations/auto-manifest.json');
const name = '2026-10-01-stock-documents-v1';
const target = manifest.migrations.find(row => row.name === name);
const purchaseSql = fs.readFileSync(path.join(__dirname, '../../migrations/2026-09-30-purchase-invoices-v1.sql'), 'utf8');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-stock-documents-'));
const manifestPath = path.join(directory, 'manifest.json');
const database = `posapp_stock_documents_${crypto.randomBytes(6).toString('hex')}`;
let admin;
let pool;
let created = false;
fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));

const tableNames = async () => (await pool.query(
  "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('purchase_invoices','purchase_invoice_lines','stock_documents','stock_document_lines') ORDER BY TABLE_NAME"))[0].map(row => row.name).sort();

// The schema as the 2026-09-30 purchase migration left it, with the tables it points at.
async function legacySchema() {
  await pool.query('SET FOREIGN_KEY_CHECKS=0');
  for (const table of ['stock_document_lines', 'stock_documents', 'purchase_invoice_lines', 'purchase_invoices', 'purchase_suppliers', 'stock_items', 'products', 'ingredients', 'schema_migrations']) {
    await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS=1');
  await pool.query('CREATE TABLE schema_migrations (migration_name varchar(191) PRIMARY KEY, checksum char(64) NOT NULL) ENGINE=InnoDB');
  await pool.query('CREATE TABLE products (id int PRIMARY KEY) ENGINE=InnoDB');
  await pool.query('CREATE TABLE ingredients (id int PRIMARY KEY) ENGINE=InnoDB');
  await pool.query('CREATE TABLE stock_items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, legacy_product_id INT NULL, legacy_ingredient_id INT NULL) ENGINE=InnoDB');
  await pool.query(purchaseSql);
  await pool.query('INSERT INTO schema_migrations VALUES (?, ?)', [target.requires.name, target.requires.checksum]);
  await pool.query('INSERT INTO products VALUES (5), (6)');
  await pool.query('INSERT INTO ingredients VALUES (9)');
  // stock item 1 is product 5, stock item 2 is ingredient 9
  await pool.query('INSERT INTO stock_items (legacy_product_id, legacy_ingredient_id) VALUES (5, NULL), (NULL, 9)');
  await pool.query("INSERT INTO purchase_suppliers (id, name) VALUES (3, 'Supplier')");
}

async function seedInvoices() {
  await pool.query(
    `INSERT INTO purchase_invoices (id, supplier_id, supplier_invoice_no, invoice_date, status, payment_status, subtotal, tax_total, total, paper_total, notes,
        cost_includes_tax, version, create_key, post_key, reverse_key, stock_result, created_by, posted_by, posted_at)
     VALUES (41, 3, 'INV-41', '2026-09-29', 'posted', 'paid', 78.000, 12.480, 90.480, 90.480, 'posted one', 0, 2, 'create-key-41', 'post-key-41', NULL,
        '{"ingredient_movements":[{"ingredient_id":9,"movement_id":7}]}', 1, 1, '2026-09-29 10:00:00'),
            (42, 3, 'INV-42', '2026-09-30', 'draft', 'credit', 18.000, 2.880, 20.880, NULL, NULL, NULL, 1, 'create-key-42', NULL, NULL, NULL, 1, NULL, NULL)`);
  await pool.query(
    `INSERT INTO purchase_invoice_lines (id, invoice_id, line_no, stock_item_id, qty, unit_label, unit_factor, unit_price, tax_rate, line_subtotal, line_tax, line_total)
     VALUES (101, 41, 1, 1, 2.000, 'Carton', 12.000000, 30.0000, 16.00, 60.000, 9.600, 69.600),
            (102, 41, 2, 2, 3.000, 'kg', 1000.000000, 6.0000, 16.00, 18.000, 2.880, 20.880),
            (103, 42, 1, 2, 3.000, 'kg', 1000.000000, 6.0000, 16.00, 18.000, 2.880, 20.880)`);
}

describe('stock documents migration', () => {
  beforeAll(async () => {
    const host = process.env.DB_HOST || '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Migration test requires loopback MySQL.');
    const options = { host, user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', port: Number(process.env.DB_PORT || 3306) };
    admin = await mysql.createConnection(options);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ ...options, database, connectionLimit: 2, multipleStatements: true });
  });
  beforeEach(legacySchema);
  afterAll(async () => {
    await pool?.end();
    try {
      if (created) await admin.query(`DROP DATABASE \`${database}\``);
    } finally {
      await admin?.end();
    }
    for (const file of [target.file, 'manifest.json']) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });

  it('moves invoices and lines with identical ids, amounts and references, then drops the old tables', async () => {
    await seedInvoices();
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    expect(await tableNames()).toEqual(['stock_document_lines', 'stock_documents']);
    const [docs] = await pool.query(
      `SELECT id, doc_type, status, supplier_id, reference, DATE_FORMAT(doc_date,'%Y-%m-%d') AS doc_date, payment_status, CAST(subtotal AS CHAR) AS subtotal,
              CAST(tax_total AS CHAR) AS tax_total, CAST(total AS CHAR) AS total, CAST(paper_total AS CHAR) AS paper_total, notes, cost_includes_tax, version,
              create_key, post_key, reverse_key, created_by, posted_by, posted_at, JSON_EXTRACT(stock_result, '$.ingredient_movements[0].movement_id') AS movement
         FROM stock_documents ORDER BY id`);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      id: 41, doc_type: 'purchase', status: 'posted', supplier_id: 3, reference: 'INV-41', doc_date: '2026-09-29', payment_status: 'paid',
      subtotal: '78.000', tax_total: '12.480', total: '90.480', paper_total: '90.480', notes: 'posted one', cost_includes_tax: 0, version: 2,
      create_key: 'create-key-41', post_key: 'post-key-41', reverse_key: null, created_by: 1, posted_by: 1, movement: '7',
    });
    expect(docs[1]).toMatchObject({ id: 42, status: 'draft', reference: 'INV-42', payment_status: 'credit', paper_total: null, post_key: null });
    const [lines] = await pool.query(
      `SELECT id, document_id, line_no, product_id, ingredient_id, CAST(qty AS CHAR) AS qty, unit_label, CAST(unit_factor AS CHAR) AS unit_factor,
              CAST(unit_price AS CHAR) AS unit_price, tax_rate, CAST(line_total AS CHAR) AS line_total FROM stock_document_lines ORDER BY id`);
    expect(lines.map(line => [line.id, line.document_id, line.line_no, line.product_id, line.ingredient_id, line.qty, line.unit_label, line.line_total])).toEqual([
      [101, 41, 1, 5, null, '2.000', 'Carton', '69.600'],
      [102, 41, 2, null, 9, '3.000', 'kg', '20.880'],
      [103, 42, 1, null, 9, '3.000', 'kg', '20.880'],
    ]);
    expect(lines[0]).toMatchObject({ unit_factor: '12.000000', unit_price: '30.0000', tax_rate: '16.00' });
    // New documents continue after the copied ids.
    const [next] = await pool.query("INSERT INTO stock_documents (doc_type, doc_date) VALUES ('count', '2026-10-01')");
    expect(next.insertId).toBe(43);
    // Copied rows obey the new header rules and keys.
    await expect(pool.query("INSERT INTO stock_documents (doc_type, supplier_id, reference, doc_date, payment_status) VALUES ('purchase', 3, 'INV-41', '2026-10-01', 'paid')"))
      .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('fails closed before changing anything when a line maps to no product or ingredient', async () => {
    await pool.query('INSERT INTO stock_items (legacy_product_id, legacy_ingredient_id) VALUES (NULL, NULL)');
    await seedInvoices();
    await pool.query('UPDATE purchase_invoice_lines SET stock_item_id=3 WHERE id=103');
    await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
    expect(await tableNames()).toEqual(['purchase_invoice_lines', 'purchase_invoices']);
    expect((await pool.query('SELECT COUNT(*) AS n FROM purchase_invoice_lines'))[0][0].n).toBe(3);
    expect((await pool.query('SELECT migration_name FROM schema_migrations WHERE migration_name=?', [name]))[0]).toHaveLength(0);
  });

  it('fails closed for a line whose stock item is both, or points at a missing stock item', async () => {
    await seedInvoices();
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    await pool.query('UPDATE purchase_invoice_lines SET stock_item_id=99 WHERE id=103');
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
    await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
    expect(await tableNames()).toEqual(['purchase_invoice_lines', 'purchase_invoices']);
    await pool.query('UPDATE purchase_invoice_lines SET stock_item_id=2 WHERE id=103');
    await pool.query('UPDATE stock_items SET legacy_product_id=6 WHERE id=2');
    await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
    expect(await tableNames()).toEqual(['purchase_invoice_lines', 'purchase_invoices']);
  });

  it('is a no-op when run again, and finishes an interrupted copy without duplicating rows', async () => {
    await seedInvoices();
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([]);
    await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [name]);
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    expect((await pool.query('SELECT COUNT(*) AS n FROM stock_documents'))[0][0].n).toBe(2);
    expect((await pool.query('SELECT COUNT(*) AS n FROM stock_document_lines'))[0][0].n).toBe(3);
    expect(await tableNames()).toEqual(['stock_document_lines', 'stock_documents']);
  });

  it('completes when an earlier attempt already copied the rows but did not drop the old tables', async () => {
    await seedInvoices();
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    // Put the legacy tables back next to the copied rows, as after an interrupted run.
    await pool.query(purchaseSql);
    await seedInvoices();
    await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [name]);
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    expect(await tableNames()).toEqual(['stock_document_lines', 'stock_documents']);
    expect((await pool.query('SELECT COUNT(*) AS n FROM stock_documents'))[0][0].n).toBe(2);
  });
});
