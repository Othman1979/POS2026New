const request = require('supertest');
const crypto = require('crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const L = require('../../services/RecipeLedgerService');

describe('recipe ledger Phase 3 API and report regressions', () => {
    let cookie, ingredient;
    const key = () => crypto.randomUUID();
    const http = (method, url, body) => request(app)[method](url).set('Cookie', cookie).send(body);
    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        const result = await http('post', '/api/admin/ingredients', {
            name: 'Phase 3 chicken', measure: 'weight', display_unit: 'kg',
            unit_cost: 4.5, par_qty: 5, pack_name: 'sack', pack_size: 10
        });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        ingredient = result.body.ingredient;
    });
    afterAll(async () => pool.end());

    it.each([
        ['cost', { unit_cost: 4.5, cost_unit: 'l' }],
        ['par', { par_qty: 5, par_unit: 'l' }],
        ['pack', { pack_name: 'bag', pack_size: 10, pack_unit: 'l' }]
    ])('rejects a different measure for %s on create and update', async (_, extra) => {
        const create = await http('post', '/api/admin/ingredients', {
            name: 'Invalid dimension', measure: 'weight', display_unit: 'kg', ...extra
        });
        const update = await http('put', `/api/admin/ingredients/${ingredient.id}`, extra);
        expect([create.status, update.status]).toEqual([400, 400]);
        const [[stored]] = await pool.query('SELECT unit_cost,par_qty,pack_size FROM ingredients WHERE id=?', [ingredient.id]);
        expect(Object.values(stored).map(Number)).toEqual([0.0045, 5000, 10000]);
    });

    it('rejects a receipt cost expressed in an incompatible measure', async () => {
        const result = await http('post', `/api/admin/ingredients/${ingredient.id}/movements`, {
            kind: 'receipt', qty: 1, unit: 'kg', unit_cost: 4.5, cost_unit: 'l', client_key: key()
        });
        expect(result.status).toBe(400);
        const [[rows]] = await pool.query("SELECT COUNT(*) n FROM stock_movements WHERE movement_type='ingredient' ");
        expect(Number(rows.n)).toBe(0);
    });

    it('preserves the stored pack size when only its name changes', async () => {
        const result = await http('put', `/api/admin/ingredients/${ingredient.id}`, { pack_name: 'renamed sack' });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(result.body.ingredient).toMatchObject({ pack_name: 'renamed sack', pack_size: 10000 });
        const receipt = await http('post', `/api/admin/ingredients/${ingredient.id}/movements`, {
            kind: 'receipt', packs: 1, qty: 0, unit: 'kg', client_key: key()
        });
        expect(Number(receipt.body.movement.qty)).toBe(10000);
    });

    it.each(['unit_cost', 'par_qty'])('rejects negative %s without changing the ingredient', async field => {
        const result = await http('put', `/api/admin/ingredients/${ingredient.id}`, { [field]: -1 });
        expect(result.status).toBe(400);
    });

    it('rejects a negative receipt cost', async () => {
        const result = await http('post', `/api/admin/ingredients/${ingredient.id}/movements`, {
            kind: 'receipt', qty: 1, unit: 'kg', unit_cost: -4.5, client_key: key()
        });
        expect(result.status).toBe(400);
    });

    async function movement(kind, qty, businessDate, extra = {}) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await L.recordManualMovement(conn, {
                ingredientId: ingredient.id, kind, qty, unit: 'g', businessDate,
                clientKey: key(), actor: { id: SEED.adminUser.id }, ...extra
            });
            await conn.commit();
            return result.movement;
        } finally { await conn.rollback(); conn.release(); }
    }

    it('reads the closing balance and daily movements from one report snapshot', async () => {
        await movement('count', 10000, '2026-08-04');
        const original = L.getDaySummary;
        let inserted = false;
        const spy = vi.spyOn(L, 'getDaySummary').mockImplementation((conn, options) => original({
            query: async (...args) => {
                const result = await conn.query(...args);
                if (!inserted && String(args[0]).includes('AS closing_expected')) {
                    inserted = true;
                    await movement('receipt', 1000, '2026-08-04');
                }
                return result;
            }
        }, options));
        try {
            const result = await http('get', '/api/admin/reports/ingredients?date=2026-08-04');
            expect(result.status, JSON.stringify(result.body)).toBe(200);
            const row = result.body.ingredients.find(row => row.id === ingredient.id);
            expect(inserted).toBe(true);
            expect(row.closing_expected).toBe(row.opening + row.received);
        } finally { spy.mockRestore(); }
    });

    it('includes every intervening day after the prior Count in the report closing balance', async () => {
        await movement('count', 10000, '2026-08-01');
        await movement('receipt', 2000, '2026-08-02');
        await movement('waste', 500, '2026-08-03', { reason: 'spoiled' });
        await movement('receipt', 1000, '2026-08-04');
        const result = await http('get', '/api/admin/reports/ingredients?date=2026-08-04');
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(result.body.ingredients.find(row => row.id === ingredient.id)).toMatchObject({
            opening: null, received: 1000, waste: 0, closing_expected: 12500
        });
    });

    it('carries the actual balance through a day with no new movements', async () => {
        await movement('count', 10000, '2026-08-01');
        await movement('waste', 6000, '2026-08-02', { reason: 'spoiled' });
        const result = await http('get', '/api/admin/reports/ingredients?date=2026-08-04');
        expect(result.body.ingredients.find(row => row.id === ingredient.id)).toMatchObject({
            closing_expected: 4000, below_par: true
        });
        expect(result.body.totals.below_par_count).toBe(1);
    });

    it('ignores a correction of a pre-Count receipt but includes later movements across days', async () => {
        const receipt = await movement('receipt', 2000, '2026-08-01');
        await movement('count', 10000, '2026-08-02');
        await movement('waste', 500, '2026-08-03', { reason: 'spoiled' });
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await L.correctManualMovement(conn, { movementId: receipt.id, note: 'Wrong receipt', clientKey: key(), businessDate: '2026-08-04' });
            await conn.commit();
        } finally { await conn.rollback(); conn.release(); }
        const result = await http('get', '/api/admin/reports/ingredients?date=2026-08-04');
        expect(result.body.ingredients.find(row => row.id === ingredient.id)).toMatchObject({
            corrections: -2000, closing_expected: 9500
        });
    });
});
