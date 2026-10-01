// Candidate index measurements, only against the dedicated performance scratch DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const file = 'scripts/reviews/recipe-ledger-performance-after.json';
const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.match(process.env.DB_NAME || '', /^posapp_review_recipe_p1_[a-f0-9]{12}$/);
assert.equal(process.env.DB_NAME, previous.database);
const pool = require('../../backend/config/db');
const L = require('../../backend/services/RecipeLedgerService');
const results = { database: process.env.DB_NAME, measurements: [] };
const sql = [
    'ALTER TABLE ingredient_movements ADD KEY idx_im_balance (ingredient_id,id,kind,qty,corrects_movement_id,business_date), ALGORITHM=INPLACE, LOCK=NONE',
    'ALTER TABLE ingredient_movements ADD KEY idx_im_day (business_date,kind,ingredient_id,id,qty,unit_cost,reason), ALGORITHM=INPLACE, LOCK=NONE',
];
async function measure(label, fn) {
    const trace = [], conn = await pool.getConnection();
    let value;
    try {
        value = await fn({ query: async (...args) => {
            const start = performance.now(), out = await conn.query(...args);
            const [explain] = await conn.query('EXPLAIN ' + args[0], args[1]);
            trace.push({ sql: args[0].replace(/\s+/g, ' ').trim(), ms: performance.now() - start, rows: out[0].length, explain });
            return out;
        } });
        const times = [];
        for (let i=0; i<5; i++) {
            const start = performance.now(); await fn(conn); times.push(performance.now() - start);
        }
        const result = { label, medianMs: times.sort((a,b)=>a-b)[2], queries: trace };
        results.measurements.push(result);
        console.log(JSON.stringify({ label, medianMs: result.medianMs }));
    } finally { conn.release(); }
    return value;
}
(async () => {
    try {
        const [masters] = await pool.query("SELECT id FROM ingredients WHERE name LIKE 'Scale %'");
        assert.equal(masters.length, 100);
        const ids = masters.map(row => row.id);
        await pool.query('ALTER TABLE ingredient_movements ADD KEY IF NOT EXISTS idx_im_ingredient_id (ingredient_id,id), ADD KEY IF NOT EXISTS idx_im_date_ingredient (business_date,ingredient_id)');
        await pool.query('ALTER TABLE ingredient_movements DROP KEY IF EXISTS idx_im_balance, DROP KEY IF EXISTS idx_im_day');
        await pool.query("DELETE FROM ingredient_movements WHERE ingredient_id IN (?) AND kind='count' AND business_date='2026-09-06'", [ids]);
        await pool.query("UPDATE ingredient_movements SET business_date='2026-09-06' WHERE ingredient_id IN (?) AND kind='usage'", [ids]);
        await pool.query('ANALYZE TABLE ingredient_movements');
        const operations = {
            summary: conn => L.getIngredientSummaries(conn, { businessDate: '2026-09-06' }),
            report: conn => L.getDaySummary(conn, { businessDate: '2026-09-06' }),
        };
        const before = {};
        for (const [name, operation] of Object.entries(operations)) before[name] = await measure('before / ' + name, operation);
        for (const query of sql) await pool.query(query);
        await pool.query('ANALYZE TABLE ingredient_movements');
        for (const [name, operation] of Object.entries(operations)) {
            const after = await measure('covering indexes / ' + name, operation);
            assert.deepEqual(after, before[name]);
        }
        results.resultParity = 'exact';
        await pool.query('ALTER TABLE ingredient_movements DROP KEY idx_im_day, ADD KEY idx_im_day (business_date,ingredient_id,kind,reason,id,qty,unit_cost), ALGORITHM=INPLACE, LOCK=NONE');
        await pool.query('ANALYZE TABLE ingredient_movements');
        for (const [name, operation] of Object.entries(operations)) {
            const after = await measure('ordered day index / ' + name, operation);
            assert.deepEqual(after, before[name]);
        }
        await pool.query('ALTER TABLE ingredient_movements DROP KEY idx_im_ingredient_id, DROP KEY idx_im_date_ingredient, ALGORITHM=INPLACE, LOCK=NONE');
        await pool.query('ANALYZE TABLE ingredient_movements');
        for (const [name, operation] of Object.entries(operations)) {
            const after = await measure('replace old indexes / ' + name, operation);
            assert.deepEqual(after, before[name]);
        }
    } finally { await pool.end(); }
    fs.writeFileSync('scripts/reviews/recipe-ledger-performance-indexes.json', JSON.stringify(results, null, 2)+'\n');
})().catch(error => { console.error(error); process.exitCode=1; });
