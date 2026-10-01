const { spawnSync } = require('node:child_process');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

describe('receipt reconciliation rollout gate', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('exits nonzero when a blocking stored-money anomaly exists', async () => {
        await pool.query(
            `INSERT INTO orders (user_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at)
             VALUES (1, -1.00, 0.00, -1.00, 'cash', 0, NOW())`
        );

        const result = spawnSync(process.execPath, ['scripts/reconciliation-scan.js'], {
            cwd: path.resolve(__dirname, '../../..'),
            env: { ...process.env, NODE_ENV: 'test' },
            encoding: 'utf8'
        });

        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/Negative Money Fields: 1/);
    });
});
