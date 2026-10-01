const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { conflictingPrinterIds } = require('../../services/printerOwnership');

describe('Printers & Order Types Input Validation', () => {
    let adminCookie;
    beforeAll(async () => {
        await seedDatabase();
        const r = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = r.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    // order_types
    it('order_types POST without name -> 400 not 500', async () => {
        const res = await request(app).post('/api/admin/order_types').set('Cookie', adminCookie).send({ requires_hash: false });
        expect(res.statusCode).toBe(400);
    });
    it('order_types PUT without id -> 400', async () => {
        const res = await request(app).put('/api/admin/order_types').set('Cookie', adminCookie).send({ name: 'X' });
        expect(res.statusCode).toBe(400);
    });
    it('persists deferred platform settlement on an order type', async () => {
        const created = await request(app).post('/api/admin/order_types').set('Cookie', adminCookie).send({
            name: 'Talabat', requires_hash: false, is_deferred_settlement: false
        });
        expect(created.statusCode).toBe(200);

        const listed = await request(app).get('/api/admin/order_types').set('Cookie', adminCookie);
        expect(listed.statusCode).toBe(200);
        const talabat = listed.body.data.find((type) => type.name === 'Talabat');
        expect(talabat).toMatchObject({ is_deferred_settlement: 0 });

        const updated = await request(app).put('/api/admin/order_types').set('Cookie', adminCookie).send({
            id: talabat.id, name: 'Talabat', requires_hash: false, is_deferred_settlement: true
        });
        expect(updated.statusCode).toBe(200);
        expect(global.__mockTo__).toHaveBeenCalledWith('staff');
        expect(global.__mockEmit__).toHaveBeenCalledWith('settings_changed', { keys: ['order_types'] });

        const reloaded = await request(app).get('/api/admin/order_types').set('Cookie', adminCookie);
        expect(reloaded.body.data.find((type) => type.name === 'Talabat')).toMatchObject({
            is_deferred_settlement: 1
        });
    });

    it('blocks deleting an order type referenced by any historical order', async () => {
        const name = `History Type ${Date.now()}`;
        const created = await request(app)
            .post('/api/admin/order_types')
            .set('Cookie', adminCookie)
            .send({ name, requires_hash: false, is_deferred_settlement: false });
        expect(created.statusCode).toBe(200);
        const [[orderType]] = await pool.query('SELECT id FROM order_types WHERE name=? ORDER BY id DESC LIMIT 1', [name]);
        const [orderInsert] = await pool.query(
            `INSERT INTO orders (user_id, order_type_id, subtotal, tax, total, payment_method)
             VALUES (?, ?, 1.00, 0.00, 1.00, 'cash')`,
            [SEED.adminUser.id, orderType.id]
        );

        const deleted = await request(app)
            .delete('/api/admin/order_types')
            .set('Cookie', adminCookie)
            .send({ id: orderType.id });

        expect(deleted.statusCode).toBe(409);
        expect(deleted.body.code).toBe('ORDER_TYPE_HAS_HISTORY');

        await pool.query('DELETE FROM orders WHERE invoice_id=?', [orderInsert.insertId]);
        await pool.query('DELETE FROM order_types WHERE id=?', [orderType.id]);
    });
    // printers
    it('keeps the claim guard on the owner-claim index with a busy queue and a 200-printer catalog', async () => {
        const values = Array.from({ length: 200 }, (_, i) => [`bench-${i}`, 'kitchen', 'network', `198.51.100.${i + 1}`, '9100', i < 4 ? 'bench-a' : 'bench-b']);
        const [insert] = await pool.query('INSERT INTO printers (name,role,type,network_ip,network_port,spooler_id) VALUES ?', [values]);
        const ids = Array.from({ length: 200 }, (_, i) => insert.insertId + i);
        try {
            const jobs = Array.from({ length: 2020 }, (_, i) => ['{}', `bench-${i}`, 'a'.repeat(64), ids[i % 4], 'kitchen', i < 2000 ? 'acknowledged' : 'pending']);
            await pool.query('INSERT INTO print_queue (payload,idempotency_key,payload_hash,printer_id,print_type,status) VALUES ?', [jobs]);
            const query = blocked => `SELECT STRAIGHT_JOIN q.id FROM printers p
                JOIN print_queue q FORCE INDEX (idx_print_queue_owner_claim) ON q.printer_id=p.id
                WHERE p.spooler_id='bench-a' AND p.is_active=1 AND q.agent_id IS NULL
                  ${blocked.length ? 'AND p.id NOT IN (?)' : ''}
                  AND q.print_type='kitchen' AND (q.status='pending' OR (q.status='failed' AND (q.next_retry_at IS NULL OR q.next_retry_at<=UTC_TIMESTAMP())))
                ORDER BY q.id LIMIT 50`;
            const samples = [[], []];
            for (let i = 0; i < 12; i++) for (const guard of i % 2 ? [true, false] : [false, true]) {
                const start = performance.now();
                const blocked = guard ? await conflictingPrinterIds(pool, 'bench-a') : [];
                const [rows] = await pool.query(query(blocked), blocked.length ? [blocked] : []);
                samples[Number(guard)].push(performance.now() - start);
                expect(rows).toHaveLength(20);
            }
            const [plan] = await pool.query('EXPLAIN ' + query([]));
            expect(plan.find(row => row.table === 'q').key).toBe('idx_print_queue_owner_claim');
            // Timing medians are diagnostics only; the assertions above are the contract.
            const median = rows => [...rows].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
            console.log('claim guard measurement', JSON.stringify({ printers: 200, historical_jobs: 2000, returned_jobs: 20, baseline_median_ms: median(samples[0]), guarded_median_ms: median(samples[1]) }));
        } finally {
            await pool.query('DELETE FROM print_queue WHERE printer_id IN (?)', [ids]);
            await pool.query('DELETE FROM printers WHERE id IN (?)', [ids]);
        }
    });
    it('permits two roles at one owning station but rejects competing stations, including concurrent creates', async () => {
        const spec = { name: 'Endpoint kitchen', role: 'kitchen', type: 'network', network_ip: '192.0.2.88', network_port: 9100, spooler_id: 'owner-a' };
        expect((await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send(spec)).status).toBe(200);
        const otherOwner = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({ ...spec, name: 'Endpoint receipt', role: 'receipt', spooler_id: 'owner-b' });
        expect(otherOwner.status).toBe(409);
        expect(otherOwner.body.code).toBe('PRINTER_ENDPOINT_OWNED');
        expect((await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({ ...spec, name: 'Endpoint receipt', role: 'receipt' })).status).toBe(200);
        const [[receipt]] = await pool.query("SELECT id FROM printers WHERE name = 'Endpoint receipt'");
        const moved = await request(app).put('/api/admin/printers').set('Cookie', adminCookie).send({ ...spec, id: receipt.id, role: 'receipt', spooler_id: 'owner-b' });
        expect(moved.status).toBe(409);
        const responses = await Promise.all(['kitchen', 'receipt'].map((role, index) => request(app).post('/api/admin/printers').set('Cookie', adminCookie)
            .send({ ...spec, name: `race-${role}`, role, network_ip: '192.0.2.89', spooler_id: `race-${index}` })));
        expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    });

    it('rejects same-role legacy port aliases and prevents moving queued work', async () => {
        const [created] = await pool.query("INSERT INTO printers (name,role,type,network_ip,network_port,spooler_id) VALUES ('Legacy-port','kitchen','network','192.0.2.90','09100','port-owner')");
        const spec = { name: 'Alias', role: 'kitchen', type: 'network', network_ip: '192.0.2.90', network_port: 9100, spooler_id: 'port-owner' };
        expect((await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send(spec)).status).toBe(409);
        for (const status of ['pending', 'failed']) {
            const [queued] = await pool.query("INSERT INTO print_queue (payload,printer_id,print_type,status) VALUES ('{}',?,'kitchen',?)", [created.insertId, status]);
            try {
                const moved = await request(app).put('/api/admin/printers').set('Cookie', adminCookie).send({ ...spec, id: created.insertId, spooler_id: 'another-owner' });
                expect(moved.status).toBe(409);
                expect(moved.body.code).toBe('PRINTER_HAS_ACTIVE_JOBS');
            } finally { await pool.query('DELETE FROM print_queue WHERE id=?', [queued.insertId]); }
        }
    });

    it('recognizes equivalent IPv6 endpoints across station owners', async () => {
        const spec = { name: 'IPv6 kitchen', role: 'kitchen', type: 'network', network_ip: '2001:0db8:0:0:0:0:0:9', network_port: 9100, spooler_id: 'ipv6-a' };
        expect((await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send(spec)).status).toBe(200);
        const duplicate = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({ ...spec, role: 'receipt', network_ip: '2001:db8::9', spooler_id: 'ipv6-b' });
        expect(duplicate.status).toBe(409);
    });
    it('keeps last printed across a rename and clears it when the printer moves to another device', async () => {
        const spec = { name: 'Stamp kitchen', role: 'kitchen', type: 'network', network_ip: '192.0.2.120', network_port: 9100, spooler_id: 'stamp-owner' };
        expect((await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send(spec)).status).toBe(200);
        const [[printer]] = await pool.query("SELECT id FROM printers WHERE name = 'Stamp kitchen'");
        const stamp = async () => (await pool.query('SELECT last_printed_at FROM printers WHERE id = ?', [printer.id]))[0][0].last_printed_at;
        await pool.query("UPDATE printers SET last_printed_at = '2026-05-01 10:00:00' WHERE id = ?", [printer.id]);
        const renamed = await request(app).put('/api/admin/printers').set('Cookie', adminCookie).send({ ...spec, id: printer.id, name: 'Stamp kitchen 2' });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        expect(await stamp()).not.toBeNull();
        const moved = await request(app).put('/api/admin/printers').set('Cookie', adminCookie).send({ ...spec, id: printer.id, name: 'Stamp kitchen 2', network_ip: '192.0.2.121' });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        expect(await stamp()).toBeNull();
    });

    it('keeps last printed when an IPv6 endpoint is re-saved in an equivalent spelling, and announces the edit', async () => {
        const spec = { name: 'Stamp v6', role: 'kitchen', type: 'network', network_ip: '2001:db8::77', network_port: 9100, spooler_id: 'stamp-v6' };
        expect((await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send(spec)).status).toBe(200);
        const [[printer]] = await pool.query("SELECT id FROM printers WHERE name = 'Stamp v6'");
        const stamp = async () => (await pool.query('SELECT last_printed_at FROM printers WHERE id = ?', [printer.id]))[0][0].last_printed_at;
        await pool.query("UPDATE printers SET last_printed_at = '2026-05-01 10:00:00' WHERE id = ?", [printer.id]);
        global.__mockEmit__.mockClear();
        const respelled = await request(app).put('/api/admin/printers').set('Cookie', adminCookie)
            .send({ ...spec, id: printer.id, network_ip: '2001:0db8:0:0:0:0:0:77' });
        expect(respelled.status, JSON.stringify(respelled.body)).toBe(200);
        expect(await stamp()).not.toBeNull();
        expect(global.__mockTo__).toHaveBeenCalledWith('staff');
        expect(global.__mockEmit__).toHaveBeenCalledWith('print_queue_updated', { source: 'printer_config' });
        const moved = await request(app).put('/api/admin/printers').set('Cookie', adminCookie)
            .send({ ...spec, id: printer.id, network_ip: '2001:db8::78' });
        expect(moved.status).toBe(200);
        expect(await stamp()).toBeNull();
    });

    it('printers POST without name -> 400 not 500', async () => {
        const res = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({ role: 'receipt', type: 'windows' });
        expect(res.statusCode).toBe(400);
    });
    it('printers POST with bad role -> 400', async () => {
        const res = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({ name: 'P', role: 'boss', type: 'windows', windows_name: 'x' });
        expect(res.statusCode).toBe(400);
    });

    it('printers POST rejects an invalid print station id', async () => {
        const res = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({
            name: 'Receipt', role: 'receipt', type: 'windows', windows_name: 'Receipt', spooler_id: 'bad station id'
        });
        expect(res.statusCode).toBe(400);
    });

    it('returns a clear conflict for the same active physical endpoint', async () => {
        const first = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({
            name: 'Front receipt', role: 'receipt', type: 'windows', windows_name: 'POS-80', spooler_id: 'station-a'
        });
        expect(first.statusCode).toBe(200);

        const duplicate = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({
            name: 'Duplicate receipt', role: 'receipt', type: 'windows', windows_name: 'POS-80', spooler_id: 'station-a'
        });
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.body.message).toContain('already configured');
    });

    it('rejects impossible network printer addresses on create and update', async () => {
        const invalidCreate = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({
            name: 'Invalid kitchen', role: 'kitchen', type: 'network',
            network_ip: '192.168.1.300', network_port: 9100, spooler_id: 'primary'
        });
        expect(invalidCreate.statusCode).toBe(400);
        expect(invalidCreate.body.message).toBe('Invalid network printer IP address.');

        const validCreate = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({
            name: 'Valid kitchen', role: 'kitchen', type: 'network',
            network_ip: ' 192.168.1.105 ', network_port: 9100, spooler_id: 'primary'
        });
        expect(validCreate.statusCode).toBe(200);

        const [[printer]] = await pool.query("SELECT id, network_ip FROM printers WHERE name = 'Valid kitchen'");
        expect(printer.network_ip).toBe('192.168.1.105');

        const invalidUpdate = await request(app).put('/api/admin/printers').set('Cookie', adminCookie).send({
            id: printer.id, name: 'Valid kitchen', role: 'kitchen', type: 'network',
            network_ip: '192.168.1.300', network_port: 9100, spooler_id: 'primary'
        });
        expect(invalidUpdate.statusCode).toBe(400);
        expect(invalidUpdate.body.message).toBe('Invalid network printer IP address.');
    });
});
