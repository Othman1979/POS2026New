import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const manifest = require('../../migrations/auto-manifest.json');
const name = '2026-10-01-retire-purchasing-tables-v1';
const target = manifest.migrations.find(row => row.name === name);
const tables = [
  'stock_price_adjustment_lines', 'stock_price_adjustments', 'stock_vendor_return_lines', 'stock_vendor_returns',
  'stock_receipt_lines', 'stock_receipts', 'stock_purchase_order_lines', 'stock_purchase_orders',
  'stock_supplier_items', 'stock_suppliers'
];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-retire-purchasing-'));
const manifestPath = path.join(directory, 'manifest.json');
const database = `posapp_retire_purchasing_${crypto.randomBytes(6).toString('hex')}`;
let admin;
let pool;
let created = false;
fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));

async function existing() {
  const [rows] = await pool.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME', [tables]);
  return rows.map(row => row.name);
}
async function resetLedger() {
  await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [name]);
}

describe('retire purchasing tables migration', () => {
  beforeAll(async () => {
    const host = process.env.DB_HOST || '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Retirement test requires loopback MySQL.');
    const options = { host, user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', port: Number(process.env.DB_PORT || 3306) };
    admin = await mysql.createConnection(options);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ ...options, database, connectionLimit: 2 });
    await pool.query('CREATE TABLE schema_migrations (migration_name varchar(191) PRIMARY KEY, checksum char(64) NOT NULL) ENGINE=InnoDB');
    await pool.query('INSERT INTO schema_migrations VALUES (?, ?)', [target.requires.name, target.requires.checksum]);
  });
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

  it('passes on a fresh schema where the tables do not exist', async () => {
    expect(await existing()).toEqual([]);
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    expect(await existing()).toEqual([]);
  });

  it('drops empty tables, keeps a table that holds history, and re-running is a no-op', async () => {
    await resetLedger();
    // Real FK chains so child-before-parent order is exercised.
    await pool.query('CREATE TABLE stock_suppliers (id int PRIMARY KEY) ENGINE=InnoDB');
    await pool.query('CREATE TABLE stock_supplier_items (id int PRIMARY KEY, supplier_id int, FOREIGN KEY (supplier_id) REFERENCES stock_suppliers(id)) ENGINE=InnoDB');
    await pool.query('CREATE TABLE stock_receipts (id int PRIMARY KEY) ENGINE=InnoDB');
    await pool.query('CREATE TABLE stock_receipt_lines (id int PRIMARY KEY, receipt_id int, FOREIGN KEY (receipt_id) REFERENCES stock_receipts(id)) ENGINE=InnoDB');
    const chained = ['stock_suppliers', 'stock_supplier_items', 'stock_receipts', 'stock_receipt_lines'];
    for (const table of tables.filter(t => !chained.includes(t))) {
      await pool.query(`CREATE TABLE \`${table}\` (id int PRIMARY KEY) ENGINE=InnoDB`);
    }
    await pool.query('INSERT INTO stock_receipts VALUES (41)');
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    expect(await existing()).toEqual(['stock_receipts']);
    expect((await pool.query('SELECT id FROM stock_receipts'))[0]).toEqual([{ id: 41 }]);
    await resetLedger();
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    expect(await existing()).toEqual(['stock_receipts']);
    expect((await pool.query('SELECT id FROM stock_receipts'))[0]).toEqual([{ id: 41 }]);
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([]);
  });

  it('keeps an empty parent that a retained row still references instead of failing the upgrade', async () => {
    await pool.query('DROP TABLE stock_receipts');
    await resetLedger();
    await pool.query('CREATE TABLE stock_purchase_orders (id int PRIMARY KEY) ENGINE=InnoDB');
    await pool.query('CREATE TABLE stock_receipts (id int PRIMARY KEY, purchase_order_id int NULL, FOREIGN KEY (purchase_order_id) REFERENCES stock_purchase_orders(id)) ENGINE=InnoDB');
    await pool.query('INSERT INTO stock_receipts (id, purchase_order_id) VALUES (7, NULL)');
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    expect(await existing()).toEqual(['stock_purchase_orders', 'stock_receipts']);
    expect((await pool.query('SELECT id FROM stock_receipts'))[0]).toEqual([{ id: 7 }]);
  });
});
