// Ordinary paid checkout timing with the constant dirty-scope write. Own guarded DB.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const os = require('node:os');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const request = require('supertest');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const { app } = require('../../server');
const pool = require('../../backend/config/db');
const { seedDatabase, SEED } = require('../../backend/tests/fixtures/seed');
let created = false;

async function run() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await seedDatabase();
    const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
    const cookie = login.headers['set-cookie'][0];
    const opened = await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie)
        .send({ user_id: SEED.cashierUser.id, starting_cash: 0 });
    assert.equal(opened.statusCode, 200);
    const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.cashierUser.id]);
    const checkout = (key) => request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
        cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
        shift_id: shift.id, subtotal: 5, tax: 0.8, total: 5.8,
        payment_method: 'cash', amount_tendered: 10, change_due: 4.2, idempotency_key: key
    });
    for (let n = 0; n < 25; n++) {
        const response = await checkout(`warmup-${n}`);
        assert.equal(response.statusCode, 200);
    }
    const times = [];
    const cpu = process.cpuUsage();
    for (let n = 0; n < 100; n++) {
        const start = performance.now();
        const response = await checkout(`timed-${n}`);
        times.push(performance.now() - start);
        assert.equal(response.statusCode, 200);
    }
    const used = process.cpuUsage(cpu);
    times.sort((a, b) => a - b);
    const [[dirty]] = await pool.query("SELECT COUNT(*) c FROM stock_report_dirty WHERE pending=1");
    const evidence = {
        at: new Date().toISOString(),
        runtime: process.version,
        cpu: os.cpus()[0].model,
        samples: 100,
        p50_ms: times[49],
        p95_ms: times[94],
        p99_ms: times[98],
        node_cpu_ms_per_call: (used.user + used.system) / 100 / 1000,
        pending_dirty_scopes: Number(dirty.c),
        limitations: [
            'Loopback HTTP checkout on this workstation, including auth cookie and JSON parsing.',
            'Not a before/after comparison against c17fbfb3; command-count contract records the constant dirty INSERT.',
            'No report rebuild runs inside checkout. Pending dirty scopes are left for the worker.',
            'Not 2-CPU/4-GiB or mixed-load certification.'
        ]
    };
    fs.mkdirSync('scratch', { recursive: true });
    fs.writeFileSync('scratch/stock-report-checkout-performance.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ p50_ms: evidence.p50_ms, p95_ms: evidence.p95_ms, pending_dirty_scopes: evidence.pending_dirty_scopes }));
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await pool.end();
    if (created) {
        const admin = await mysql.createConnection(options);
        try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
    }
});
