const fs = require('node:fs');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { getTestDatabaseOptions } = require('../../backend/tests/testDatabase.cjs');
const { runPendingMigrations } = require('../../backend/migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../backend/services/schemaValidation');
const { catalog } = require('../../backend/config/permissionCatalog');
const retired = ['stock_suppliers','stock_supplier_items','stock_purchase_orders','stock_purchase_order_lines','stock_receipts','stock_receipt_lines','stock_vendor_returns','stock_vendor_return_lines','stock_price_adjustments','stock_price_adjustment_lines'];
const configurationTables = new Set(['settings', 'schema_migrations', 'users', 'permissions', 'order_types', 'invoice_sequences', 'stock_report_backfill', 'print_templates']);
async function main() {
 const [sqlPath, outputPath, loginPath] = process.argv.slice(2);
 const sql = fs.readFileSync(sqlPath, 'utf8');
 // Only a selected-database import, never account administration or database switching.
 assert(!/^\s*(?:USE\s|(?:CREATE|DROP|ALTER)\s+(?:DATABASE|USER)\b|GRANT\s)/im.test(sql));
 const { database, ...options } = getTestDatabaseOptions();
 const admin = await mysql.createConnection(options);
 let pool, created = false, report;
 try {
  await admin.query(`CREATE DATABASE \`${database}\``); created = true;
  pool = mysql.createPool({...options,database,multipleStatements:true});
  await pool.query(sql);
  const [[before]] = await pool.query('SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM orders) orders,(SELECT COUNT(*) FROM products) products,(SELECT COUNT(*) FROM customers) customers');
  assert.equal(before.users,2);
  for (const table of ['orders', 'products', 'customers']) assert.equal(before[table], 0, `Fresh ${table} must be empty`);
  const columns = ['perm_key','label','label_ar','description','description_ar','category','sort_order','implemented','default_cashier','overridable'];
  const [permissions] = await pool.query(`SELECT ${columns.join(',')} FROM permissions ORDER BY perm_key`);
  const byKey = (a, b) => a.perm_key.localeCompare(b.perm_key);
  permissions.sort(byKey);
  const expected = catalog.map(row => Object.fromEntries(columns.map(column => [column, row[column]]))).sort(byKey);
  assert.deepEqual(permissions, expected, 'Fresh permission catalog differs from the canonical catalog');
  const [users] = await pool.query('SELECT user_number,role,table_access_scope FROM users ORDER BY role');
  assert.deepEqual(users.map(user => user.role).sort(), ['admin','programmer']);
  assert(users.every(user => user.table_access_scope === 'all'));
  if (loginPath) {
   const login = fs.readFileSync(loginPath, 'utf8');
   for (const [label, role] of [['Administrator','admin'], ['Programmer','programmer']]) {
    const number = login.match(new RegExp(`^${label} number:\\s*(\\d+)\\s*$`, 'm'))?.[1];
    assert(number && users.find(user => user.role === role)?.user_number === number, `${label} identity does not match INITIAL-LOGIN.txt`);
   }
  }
  for (let i=0;i<2;i++) { const run=await runPendingMigrations(pool); assert.deepEqual(run.applied,[]); await validateRequiredSchema(pool); }
  const [tables]=await pool.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[database]);
  for (const table of tables) assert(/^[a-z0-9_]+$/.test(table.name));
  const [counts] = await pool.query(tables.map(table => `SELECT '${table.name}' name, COUNT(*) count FROM \`${table.name}\``).join(' UNION ALL '));
  const countByTable = Object.fromEntries(counts.map(row => [row.name, Number(row.count)]));
  for (const row of counts) if (!configurationTables.has(row.name)) assert.equal(Number(row.count), 0, `Fresh business table is not empty: ${row.name}`);
  for(const name of retired) assert(!tables.some(t=>t.name===name),name);
  assert.equal(tables.filter(t=>t.name.startsWith('stock_')).length,18);
  await require('../../backend/routes/admin/helpers').pool.end();
  const [[version]] = await pool.query('SELECT VERSION() AS version');
  report = {
   exactSqlImport:'passed',schemaValidator:'passed',startupPasses:2,pendingMigrations:0,stockTables:18,retiredTables:0,
   counts: { ...before, deleted: countByTable.deleted, user_permissions: countByTable.user_permissions },
   sqlSha256: createHash('sha256').update(fs.readFileSync(sqlPath)).digest('hex'),
   totalFreshTables: tables.length, permissionRows: permissions.length, migrationLedgerRows: countByTable.schema_migrations,
   allBusinessTablesEmpty: true, initialIdentitiesMatch: Boolean(loginPath), databaseVersion: version.version
  };
 } finally {
  try { if(pool)await pool.end(); }
  finally { try { if(created)await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); } }
 }
 report.removed = true;
 if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
 console.log(JSON.stringify(report));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
