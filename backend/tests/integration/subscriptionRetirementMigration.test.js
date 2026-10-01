import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');
const manifest = require('../../migrations/auto-manifest.json');
const name = '2026-09-23-subscriptions-retirement-v1';
const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8');
const fallbackHeader = fallback.slice(0, fallback.indexOf('-- BEGIN AUTO MIGRATION: 2026-08-01-additive-schema-reconciliation-v1'));
const target = manifest.migrations.find(row => row.name === name);
const tables = [
  'subscription_plans', 'subscription_plan_products', 'customer_subscriptions',
  'customer_subscription_products', 'subscription_extensions',
  'subscription_collections', 'subscription_redemptions', 'subscription_redemption_items'
];
const historyTables = tables.slice(2);
async function runSql(executor, sql) {
  for (const statement of splitMysqlScript(sql)) await executor.query(statement);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-subscription-retirement-'));
const manifestPath = path.join(directory, 'manifest.json');
const database = `posapp_retirement_test_${crypto.randomBytes(6).toString('hex')}`;
let admin;
let pool;
let created = false;
fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
for (const file of [target.file, target.preflight]) {
  fs.copyFileSync(path.join(__dirname, '../../migrations', file), path.join(directory, file));
}

describe('subscription retirement migration', () => {
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
    for (const table of tables) await pool.query(`CREATE TABLE \`${table}\` (id int PRIMARY KEY) ENGINE=InnoDB`);
    await pool.query('CREATE TABLE permissions (perm_key varchar(100) PRIMARY KEY) ENGINE=InnoDB');
    await pool.query('CREATE TABLE user_permissions (user_id int, perm_key varchar(100)) ENGINE=InnoDB');
    await pool.query('CREATE TABLE settings (setting_key varchar(100) PRIMARY KEY) ENGINE=InnoDB');
    await pool.query('CREATE TABLE unrelated_order (id int PRIMARY KEY) ENGINE=InnoDB');
    await pool.query('INSERT INTO unrelated_order VALUES (7)');
    await pool.query("INSERT INTO permissions VALUES ('pos.subscriptions'),('pos.subscription_credit'),('pos.checkout')");
    await pool.query("INSERT INTO user_permissions VALUES (2,'pos.subscriptions'),(2,'pos.checkout')");
    await pool.query("INSERT INTO settings VALUES ('subscription_receivables_enabled'),('tables_enabled')");
  });
  afterAll(async () => {
    await pool?.end();
    try {
      if (created) await admin.query(`DROP DATABASE \`${database}\``);
    } finally {
      await admin?.end();
    }
    for (const file of [target.file, target.preflight, 'manifest.json']) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });

  it('preserves customer history and unrelated state, while removing unused plan configuration', async () => {
    await expect(runSql(pool, fallbackHeader)).resolves.toBeUndefined();
    for (const table of historyTables) {
      await pool.query(`INSERT INTO \`${table}\` VALUES (1)`);
      await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow('preflight rejected');
      const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
      expect(row.count).toBe(1);
      const [[ledger]] = await pool.query('SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_name=?', [name]);
      expect(ledger.count).toBe(0);
      await pool.query(`DELETE FROM \`${table}\``);
    }
    await pool.query('INSERT INTO subscription_plans VALUES (1)');
    await pool.query('INSERT INTO subscription_plan_products VALUES (1)');
    const [[before]] = await pool.query("SELECT COUNT(*) AS count FROM permissions WHERE perm_key='pos.subscriptions'");
    expect(before.count).toBe(1);
    expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([name]);
    const [remaining] = await pool.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)', [tables]);
    expect(remaining).toHaveLength(0);
    const [[order]] = await pool.query('SELECT id FROM unrelated_order');
    expect(order.id).toBe(7);
    const [permissions] = await pool.query('SELECT perm_key FROM permissions ORDER BY perm_key');
    expect(permissions).toEqual([{ perm_key: 'pos.checkout' }]);
    const [grants] = await pool.query('SELECT perm_key FROM user_permissions');
    expect(grants).toEqual([{ perm_key: 'pos.checkout' }]);
    const [settings] = await pool.query('SELECT setting_key FROM settings');
    expect(settings).toEqual([{ setting_key: 'tables_enabled' }]);
    expect((await runPendingMigrations(pool, { manifestPath })).skipped).toEqual([name]);
  });

  it('stops a full cumulative fallback replay before it can recreate retired tables', async () => {
    await expect(runSql(pool, fallbackHeader)).rejects.toThrow(/POSAPP_CUMULATIVE_FALLBACK_BLOCKED_AFTER_SUBSCRIPTION_RETIREMENT/);
    const [remaining] = await pool.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)', [tables]);
    expect(remaining).toHaveLength(0);
    const [[ledger]] = await pool.query('SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_name=?', [name]);
    expect(ledger.count).toBe(1);
  });
});
