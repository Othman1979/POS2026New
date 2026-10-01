const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

const AGENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECRET = 'priority-plan-secret';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

beforeAll(async () => {
    process.env.SPOOLER_KEY = 'test-spooler-key';
    await seedDatabase();
});
afterAll(async () => pool.end());

it('measures kitchen claim behind a five-thousand receipt backlog', async () => {
    await request(app).post('/api/spooler/v2/register').set('x-spooler-key', 'test-spooler-key').send({
        protocol_version: 2, agent_id: AGENT, spooler_id: 'priority-load', token_hash: hash(SECRET), name: 'load', agent_version: 'probe'
    }).expect(201);
    const [printer] = await pool.query(
        "INSERT INTO printers (name, role, type, windows_name, spooler_id, is_active) VALUES ('Load', 'kitchen', 'windows', 'Load', 'priority-load', 1)"
    );
    const receiptRows = Array.from({ length: 5000 }, (_, index) => [
        JSON.stringify({ printer_id: printer.insertId, print_type: 'receipt', data: { index } }),
        `load-receipt-${index}`,
        'a'.repeat(64),
        printer.insertId,
        'receipt'
    ]);
    await pool.query(
        "INSERT INTO print_queue (payload,idempotency_key,payload_hash,printer_id,print_type,status) VALUES ?",
        [receiptRows.map(row => [...row, 'pending'])]
    );
    for (let index = 0; index < 5; index += 1) {
        await pool.query(
            "INSERT INTO print_queue (payload,idempotency_key,payload_hash,printer_id,print_type,status) VALUES (?, ?, REPEAT('b',64), ?, 'kitchen','pending')",
            [JSON.stringify({ printer_id: printer.insertId, print_type: 'kitchen', data: { index } }), `load-kitchen-${index}`, printer.insertId]
        );
    }
    const started = performance.now();
    const response = await request(app).post('/api/spooler/v2/sync')
        .set('x-agent-id', AGENT).set('x-agent-token', SECRET)
        .send({ protocol_version: 2, wait_ms: 0, accepted: [], results: [], health: {}, capacity: 45, kitchen_capacity: 50 });
    const elapsedMs = performance.now() - started;
    expect(response.statusCode).toBe(200);
    expect(response.body.jobs.slice(0, 5).map(job => job.print_type)).toEqual(Array(5).fill('kitchen'));
    expect(response.body.jobs).toHaveLength(50);
    expect(elapsedMs).toBeLessThan(1000);
    fs.mkdirSync(path.resolve(__dirname, '../../../scratch'), { recursive: true });
    fs.writeFileSync(
        path.resolve(__dirname, '../../../scratch/spooler-priority-load.json'),
        `${JSON.stringify({ kitchen_claim_ms: elapsedMs, backlog: 5000, claimed: response.body.jobs.length }, null, 2)}\n`
    );
});
