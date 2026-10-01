const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { getBusinessDate } = require('../../utils/businessDate');
const L = require('../../services/RecipeLedgerService');

describe('recipe ledger day report', () => {
    let adminCookie;
    let cashierCookie;
    let chicken;
    const businessDate = getBusinessDate();

    beforeAll(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        const [chickenResult] = await pool.query(`
            INSERT INTO ingredients
              (name, measure, display_unit, unit_cost, par_qty, pack_name, pack_size, is_active)
            VALUES ('Chicken', 'weight', 'kg', 0.0045, 5000, 'sack', 10000, 1)
        `);
        chicken = chickenResult.insertId;
        await pool.query(`
            INSERT INTO ingredients
              (name, measure, display_unit, unit_cost, pack_name, pack_size, is_active)
            VALUES ('Pepsi', 'count', 'unit', 0.35, 'carton', 24, 1)
        `);
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const actor = { id: SEED.adminUser.id, name: SEED.adminUser.name };
            await L.recordManualMovement(conn, {
                ingredientId: chicken, kind: 'count', qty: 4.7, unit: 'kg',
                clientKey: 'report-open', actor, businessDate
            });
            await L.recordManualMovement(conn, {
                ingredientId: chicken, kind: 'waste', qty: 0.5, unit: 'kg', reason: 'spoiled',
                clientKey: 'report-waste', actor, businessDate
            });
            await conn.commit();
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    });

    afterAll(async () => pool.end());

    it('returns opening, waste by reason, counts, costs, and sales totals for the day', async () => {
        const res = await request(app)
            .get(`/api/admin/reports/ingredients?date=${businessDate}`)
            .set('Cookie', adminCookie);
        expect(res.statusCode).toBe(200);
        const row = res.body.ingredients.find((item) => item.id === chicken);
        expect(row).toMatchObject({
            opening: 4700,
            received: 0,
            used: 0,
            corrections: 0
        });
        expect(row.waste_by_reason).toMatchObject({ spoiled: 500 });
        expect(row.closing_expected).toBe(4200);
        expect(row.counts).toEqual(expect.arrayContaining([
            // The first Count establishes inventory; it cannot report variance
            // against an unknown earlier balance.
            expect.objectContaining({ qty: 4700, expected_qty: null, variance_qty: null, variance_pct: null })
        ]));
        expect(row.waste_cost).toBeCloseTo(2.25, 6);
        expect(res.body.totals).toEqual(expect.objectContaining({
            sales_total: expect.any(Number),
            used_cost: expect.any(Number),
            waste_cost: expect.any(Number)
        }));
        if (res.body.totals.sales_total && res.body.totals.used_cost) {
            expect(res.body.totals.food_cost_pct).toBeCloseTo(
                res.body.totals.used_cost / res.body.totals.sales_total,
                6
            );
        }
    });

    it('returns empty arrays when the date is missing', async () => {
        const res = await request(app)
            .get('/api/admin/reports/ingredients')
            .set('Cookie', adminCookie);
        expect(res.statusCode).toBe(200);
        expect(res.body.ingredients).toEqual([]);
        expect(res.body.totals).toEqual(expect.objectContaining({
            used_cost: 0,
            waste_cost: 0,
            sales_total: null,
            food_cost_pct: null
        }));
    });

    it('rejects a cashier', async () => {
        const res = await request(app)
            .get(`/api/admin/reports/ingredients?date=${businessDate}`)
            .set('Cookie', cashierCookie);
        expect(res.statusCode).toBe(403);
    });
});
