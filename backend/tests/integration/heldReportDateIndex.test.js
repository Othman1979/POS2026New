const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');

describe('held report date index upgrade', () => {
  const target = require('../../migrations/auto-manifest.json').migrations
    .find(row => row.name === '2026-09-12-held-report-date-index-v1');
  let directory, manifestPath, before;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-held-date-index-'));
    manifestPath = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
    for (const file of [target.file, target.preflight]) {
      fs.copyFileSync(path.join(__dirname, '../../migrations', file), path.join(directory, file));
    }
  });
  beforeEach(async () => {
    await seedDatabase();
    await pool.query('ALTER TABLE held_orders DROP INDEX idx_held_orders_created_id');
    await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
    await pool.query(`INSERT INTO held_orders (user_id,reference_name,cart_data,created_at,updated_at)
      VALUES (2,'Preserve this hold','{"items":[]}','2026-07-01 03:00:00','2026-07-02 04:00:00')`);
    before = (await pool.query('SELECT * FROM held_orders ORDER BY id'))[0];
  });
  afterAll(async () => {
    await pool.end();
    // Only files in this test's newly created temporary directory.
    for (const file of [target.file, target.preflight, 'manifest.json']) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  const migrate = () => runPendingMigrations(pool, { manifestPath });
  async function verify() {
    expect((await pool.query('SELECT * FROM held_orders ORDER BY id'))[0]).toEqual(before);
    const [index] = await pool.query(`SELECT COLUMN_NAME,NON_UNIQUE,SUB_PART FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND INDEX_NAME='idx_held_orders_created_id'
      ORDER BY SEQ_IN_INDEX`);
    expect(index).toEqual([
      { COLUMN_NAME: 'created_at', NON_UNIQUE: 1, SUB_PART: null },
      { COLUMN_NAME: 'id', NON_UNIQUE: 1, SUB_PART: null },
    ]);
  }
  it('upgrades the exact predecessor and safely repeats automatic and raw SQL execution', async () => {
    expect((await migrate()).applied).toEqual([target.name]);
    await verify();
    expect((await migrate()).applied).toEqual([]);
    const conn = await pool.getConnection();
    try {
      for (const statement of splitMysqlScript(fs.readFileSync(path.join(directory, target.file), 'utf8'))) {
        await conn.query(statement);
      }
    } finally { conn.release(); }
    await verify();
  });
  it('resumes after index creation without a target ledger row', async () => {
    await pool.query('ALTER TABLE held_orders ADD INDEX idx_held_orders_created_id (created_at,id)');
    expect((await migrate()).applied).toEqual([target.name]);
    await verify();
  });
  it('rejects a same-name index with the wrong column order', async () => {
    await pool.query('ALTER TABLE held_orders ADD INDEX idx_held_orders_created_id (id,created_at)');
    await expect(migrate()).rejects.toThrow('preflight rejected');
    expect((await pool.query('SELECT * FROM schema_migrations WHERE migration_name=?', [target.name]))[0]).toEqual([]);
    expect((await pool.query('SELECT * FROM held_orders ORDER BY id'))[0]).toEqual(before);
  });
  it.each(['missing', 'conflicting'])('rejects a %s predecessor', async mode => {
    if (mode === 'missing') await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
    else await pool.query('UPDATE schema_migrations SET checksum=REPEAT(?,64) WHERE migration_name=?', ['a', target.requires.name]);
    await expect(migrate()).rejects.toThrow('exact checksum');
    expect((await pool.query('SELECT * FROM held_orders ORDER BY id'))[0]).toEqual(before);
  });
  it('rejects a conflicting target ledger checksum', async () => {
    await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,REPEAT(?,64))', [target.name, 'b']);
    await expect(migrate()).rejects.toThrow(/checksum/i);
    expect((await pool.query('SELECT * FROM held_orders ORDER BY id'))[0]).toEqual(before);
  });
});
