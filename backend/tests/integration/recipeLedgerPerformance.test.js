const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const L = require('../../services/RecipeLedgerService');
const request = require('supertest');
const { app } = require('../../../server');
const { getBusinessDate } = require('../../utils/businessDate');
const { buildDailySummary } = require('../../services/dailyReportBuilder');
const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');

describe('recipe ledger contention boundaries', () => {
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
    });
    afterAll(async () => pool.end());

    it('edits a frozen empty line while an unrelated ingredient is locked', async () => {
        const [created] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Unrelated','count','unit')");
        const line = { key: L.newLineKey(), product_id: SEED.product1.id, qty: 1, isNew: true };
        const writer = await pool.getConnection(), blocker = await pool.getConnection();
        try {
            await writer.beginTransaction();
            await L.syncOrderLines(writer, { lines: [line], businessDate: '2026-09-06' });
            await writer.commit();
            await blocker.beginTransaction();
            await blocker.query('SELECT id FROM ingredients WHERE id=? FOR UPDATE', [created.insertId]);
            await writer.query('SET SESSION innodb_lock_wait_timeout=1');
            await writer.beginTransaction();
            const result = await L.syncOrderLines(writer, { lines: [{ ...line, isNew: false, qty: 2 }], businessDate: '2026-09-06' });
            expect(result.written).toBe(0);
        } finally {
            await writer.rollback();
            await blocker.rollback();
            await writer.query('SET SESSION innodb_lock_wait_timeout=50');
            writer.release(); blocker.release();
        }
    });

    it('keeps report costs consistent with ingredient summaries for fractional usage', async () => {
        const [created] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Fractional','weight','g',0.005)");
        const values = Array.from({ length: 4 }, () => [created.insertId, 'usage', -0.000001, 0.005, 'order', '2026-09-06']);
        await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,unit_cost,source_type,business_date) VALUES ?", [(values).map(row => ['ingredient', ...row])]);
        const summary = await L.getIngredientSummaries(pool, { businessDate: '2026-09-06' });
        const report = await L.getDaySummary(pool, { businessDate: '2026-09-06' });
        expect(summary[0].today.used_cost).toBe(0.00000002);
        expect(report.ingredients[0].used_cost).toBe(summary[0].today.used_cost);
        await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,unit_cost,source_type,business_date) VALUES ?", [
            (values.map(row => [row[0], 'reversal', -row[2], ...row.slice(3)])).map(row => ['ingredient', ...row])
        ]);
        const reversed = await L.getDaySummary(pool, { businessDate: '2026-09-06' });
        expect(reversed.ingredients[0].used_cost).toBeCloseTo(0, 8);
    });

    it('rejects an unknown saved key without manufacturing an empty composition', async () => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await expect(L.syncOrderLines(conn, {
                lines: [{ key: L.newLineKey(), product_id: SEED.product1.id, qty: 2, isNew: false }],
                businessDate: '2026-09-06'
            })).rejects.toMatchObject({ statusCode: 409 });
            const [[registry]] = await conn.query('SELECT COUNT(*) n FROM recipe_ledger_lines');
            expect(Number(registry.n)).toBe(0);
        } finally { await conn.rollback(); conn.release(); }
    });

    it('preserves report money, Count details, waste reasons and stock after a real partial refund', async () => {
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const cookie = login.headers['set-cookie'][0];
        const api = async (method, url, body) => {
            const response = await request(app)[method](url).set('Cookie', cookie).send(body);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return response.body;
        };
        const item = (await api('post', '/api/admin/ingredients', {
            name: 'Report parity', measure: 'weight', display_unit: 'g', unit_cost: 0.0045
        })).ingredient;
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,200)', [SEED.product1.id, item.id]);
        const movement = (kind, qty, reason) => api('post', `/api/admin/ingredients/${item.id}/movements`, {
            kind, qty, reason, unit: 'g', client_key: L.newLineKey()
        });
        await movement('count', 1000);
        const sale = await api('post', '/api/pos/checkout', {
            cart: [{ id: SEED.product1.id, qty: 3, price: 5 }],
            subtotal: 15, tax: 2.4, total: 17.4, payment_method: 'cash', amount_tendered: 17.4,
            change_due: 0, idempotency_key: L.newLineKey()
        });
        await pool.query('UPDATE ingredients SET unit_cost=0.009 WHERE id=?', [item.id]);
        const [[line]] = await pool.query('SELECT id FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL', [sale.invoice_id]);
        await api('post', '/api/pos/refunds', {
            invoice_id: sale.invoice_id, intent: 'refund', refund_method: 'cash', items: [{ order_item_id: line.id, qty: 1 }]
        });
        await movement('waste', 50, 'spoiled');
        await movement('count', 545);
        await movement('waste', 20, 'other');
        const day = getBusinessDate();
        const report = await api('get', '/api/admin/reports/ingredients?date=' + day);
        const row = report.ingredients.find(row => row.id === item.id);
        expect(row).toMatchObject({ opening: 1000, used: 400, received: 0, waste: 70,
            closing_expected: 525, used_cost: 1.8, waste_cost: 0.63,
            waste_by_reason: { spoiled: 50, other: 20 } });
        expect(row.counts).toHaveLength(2);
        expect(row.counts[1]).toMatchObject({ qty: 545, expected_qty: 550, variance_qty: -5, variance_pct: -0.0125 });
        const daily = await buildDailySummary(pool, parseDailyReportPeriod({ startDate: day, endDate: day }));
        expect(report.totals.sales_total).toBe(11.6);
        expect(report.totals.sales_total).toBe(daily.summary.sales_collected);
    });

    it('loads portions for only the requested product and keeps picker data admin-only', async () => {
        const [created] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Recipe A','weight','g'),('Recipe B','weight','g'),('Archived','count','unit')");
        await pool.query('UPDATE ingredients SET is_active=0 WHERE id=?', [created.insertId + 2]);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES ?', [[
            [SEED.product1.id, created.insertId, 100], [SEED.product2.id, created.insertId + 1, 200]
        ]]);
        await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,source_type,business_date) VALUES ('ingredient',?,'count',300,'manual','2026-09-06')", [created.insertId]);
        let backfill={after_id:0,complete:false};
        while(!backfill.complete)backfill=await L.backfillWorkingBalances(pool,{afterId:backfill.after_id});
        let rowsRead = 0;
        const portions = await L.getPortionsReport({ query: async (...args) => {
            const result = await pool.query(...args); rowsRead += result[0].length; return result;
        } }, { productId: SEED.product1.id });
        expect(portions).toHaveLength(1);
        expect(portions[0]).toMatchObject({ product_id: SEED.product1.id, portions_possible: 3 });
        expect(rowsRead).toBe(2);
        const admin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const cashier = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        const options = await request(app).get('/api/admin/ingredients/options').set('Cookie', admin.headers['set-cookie'][0]);
        expect(options.status).toBe(200);
        expect(options.body.ingredients.map(row => row.name)).toEqual(['Recipe A', 'Recipe B']);
        const forbidden = await request(app).get('/api/admin/ingredients/options').set('Cookie', cashier.headers['set-cookie'][0]);
        expect(forbidden.status).toBe(403);
        const invalid = await request(app).get('/api/admin/ingredients/portions?product_id=bad').set('Cookie', admin.headers['set-cookie'][0]);
        expect(invalid.status).toBe(400);
    });

    it('records 100-ingredient openings with the same query count as one and rolls back every projection', async () => {
        await pool.query('INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ?', [
            Array.from({ length: 100 }, (_, i) => ['Opening budget ' + i, 'weight', 'g', 0.0045])
        ]);
        const [ingredients] = await pool.query('SELECT id FROM ingredients ORDER BY id');
        const counts=[];
        for(const size of [1,100]){
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();let queries=0;
                const result=await L.recordOpeningCounts({query:(...args)=>{queries++;return conn.query(...args);}}, {
                    entries:ingredients.slice(0,size).map(row=>({ingredientId:row.id,qty:500,unit:'g'})),
                    clientKey:L.newLineKey(),businessDate:'2026-09-06'
                });
                counts.push(queries);
                expect(result.movements).toHaveLength(size);
                expect(result.movements.every(row=>Number(row.qty)===500&&Number(row.unit_cost)===0.0045)).toBe(true);
            }finally{await conn.rollback();conn.release();}
        }
        expect(counts[1]).toBe(counts[0]);
        expect(counts[1]).toBeLessThanOrEqual(11);
        const [[stored]]=await pool.query("SELECT (SELECT COUNT(*) FROM stock_movements WHERE movement_type='ingredient' ) movements,(SELECT COUNT(*) FROM ingredients WHERE working_initialized=1) projections");
        expect(stored).toEqual({movements:0,projections:0});
    });
});
