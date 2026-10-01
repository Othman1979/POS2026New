const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('recipe ledger admin API', () => {
    let adminCookie;
    let cashierCookie;

    beforeAll(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
    });

    afterAll(async () => pool.end());

    const asAdmin = (method, url) => request(app)[method](url).set('Cookie', adminCookie);

    it('creates ingredients, recipes, movements, opening, and reports through the admin API', async () => {
        const created = await asAdmin('post', '/api/admin/ingredients').send({
            name: 'Chicken',
            measure: 'weight',
            display_unit: 'kg',
            unit_cost: 4.5,
            cost_unit: 'kg',
            par_qty: 5,
            par_unit: 'kg',
            pack_name: 'sack',
            pack_size: 10,
            pack_unit: 'kg'
        });
        expect(created.statusCode).toBe(200);
        const chicken = created.body.ingredient;
        expect(Number(chicken.unit_cost)).toBe(0.0045);
        expect(Number(chicken.par_qty)).toBe(5000);
        expect(Number(chicken.pack_size)).toBe(10000);

        expect((await asAdmin('post', '/api/admin/ingredients').send({
            name: 'Water',
            measure: 'weight',
            display_unit: 'ml'
        })).statusCode).toBe(400);

        expect((await asAdmin('post', '/api/admin/ingredients').send({
            name: 'Flour',
            measure: 'weight',
            display_unit: 'kg',
            pack_name: 'sack'
        })).statusCode).toBe(400);

        const duplicate = await asAdmin('post', '/api/admin/ingredients').send({
            name: 'Chicken',
            measure: 'weight',
            display_unit: 'kg'
        });
        expect(duplicate.statusCode).toBe(409);

        const pepsi = (await asAdmin('post', '/api/admin/ingredients').send({
            name: 'Pepsi',
            measure: 'count',
            display_unit: 'unit',
            unit_cost: 0.35,
            pack_name: 'carton',
            pack_size: 24,
            pack_unit: 'unit'
        })).body.ingredient;

        const recipePut = await asAdmin('put', `/api/admin/products/${SEED.product1.id}/recipe`).send({
            lines: [{ ingredient_id: chicken.id, qty: 0.2, unit: 'kg' }]
        });
        expect(recipePut.statusCode).toBe(200);
        const [[storedRecipe]] = await pool.query(
            'SELECT qty_per_unit FROM product_recipe_lines WHERE product_id=? AND ingredient_id=?',
            [SEED.product1.id, chicken.id]
        );
        expect(Number(storedRecipe.qty_per_unit)).toBe(200);

        const recipeGet = await asAdmin('get', `/api/admin/products/${SEED.product1.id}/recipe`);
        expect(recipeGet.statusCode).toBe(200);
        expect(recipeGet.body.lines[0].qty).toBe(0.2);
        expect(recipeGet.body.plate_cost).toBeCloseTo(0.9, 6);
        expect(recipeGet.body.margin_pct).toBeCloseTo(0.82, 6);

        const renamedDisplay = await asAdmin('put', `/api/admin/ingredients/${chicken.id}`).send({
            name: 'Chicken',
            display_unit: 'g',
            is_active: 1
        });
        expect(renamedDisplay.statusCode).toBe(200);
        expect(renamedDisplay.body.ingredient.display_unit).toBe('g');

        const receiptKg = await asAdmin('post', `/api/admin/ingredients/${chicken.id}/movements`).send({
            kind: 'receipt', qty: 2, unit: 'kg', client_key: 'receipt-2kg'
        });
        expect(receiptKg.statusCode).toBe(200);
        expect(Number(receiptKg.body.movement.qty)).toBe(2000);

        const receiptPacks = await asAdmin('post', `/api/admin/ingredients/${chicken.id}/movements`).send({
            kind: 'receipt', packs: 1, qty: 0.5, unit: 'kg', client_key: 'receipt-pack'
        });
        expect(receiptPacks.statusCode).toBe(200);
        expect(Number(receiptPacks.body.movement.qty)).toBe(10500);

        expect((await asAdmin('post', `/api/admin/ingredients/${chicken.id}/movements`).send({
            kind: 'waste', qty: 0.5, unit: 'kg', client_key: 'waste-none'
        })).statusCode).toBe(400);

        const waste = await asAdmin('post', `/api/admin/ingredients/${chicken.id}/movements`).send({
            kind: 'waste', qty: 0.5, unit: 'kg', reason: 'spoiled', client_key: 'waste-spoiled'
        });
        expect(waste.statusCode).toBe(200);

        const countZero = await asAdmin('post', `/api/admin/ingredients/${chicken.id}/movements`).send({
            kind: 'count', qty: 0, unit: 'kg', client_key: 'count-zero'
        });
        expect(countZero.statusCode).toBe(200);
        // Receipts before the first Count do not establish an opening balance.
        expect(countZero.body.movement.expected_qty).toBeNull();

        const replay = await asAdmin('post', `/api/admin/ingredients/${chicken.id}/movements`).send({
            kind: 'count', qty: 0, unit: 'kg', client_key: 'count-zero'
        });
        expect(replay.statusCode).toBe(200);
        expect(replay.body.replay).toBe(true);

        expect((await asAdmin('post', `/api/admin/ingredients/${chicken.id}/movements`).send({
            kind: 'count', qty: 1, unit: 'kg', client_key: 'count-zero'
        })).statusCode).toBe(409);

        const archived = await asAdmin('put', `/api/admin/ingredients/${chicken.id}`).send({
            name: 'Chicken',
            display_unit: 'g',
            is_active: 0
        });
        expect(archived.statusCode).toBe(409);
        expect(archived.body.dependents).toEqual(expect.arrayContaining([
            expect.objectContaining({ product_id: SEED.product1.id })
        ]));

        const firstCorrect = await asAdmin('post', `/api/admin/ingredient-movements/${receiptKg.body.movement.id}/amend`)
            .send({ qty: 0, unit: 'kg', note: 'typo', client_key: 'correct-1' });
        expect(firstCorrect.statusCode).toBe(200);
        expect((await asAdmin('post', `/api/admin/ingredient-movements/${receiptKg.body.movement.id}/amend`)
            .send({ qty: 0, unit: 'kg', note: 'again', client_key: 'correct-2' })).statusCode).toBe(409);

        const counted = await asAdmin('post', `/api/admin/ingredients/${chicken.id}/movements`).send({
            kind: 'count', qty: 4.7, unit: 'kg', client_key: 'count-4.7'
        });
        expect(counted.statusCode).toBe(200);

        const portions = await asAdmin('get', '/api/admin/ingredients/portions');
        expect(portions.statusCode).toBe(200);
        expect(portions.body.portions.find((row) => row.product_id === SEED.product1.id)).toMatchObject({
            portions_possible: 23
        });
    });

    it('rejects a cashier', async () => {
        const res = await request(app)
            .get('/api/admin/ingredients')
            .set('Cookie', cashierCookie);
        expect(res.statusCode).toBe(403);
        expect((await request(app).get('/api/admin/ingredients/analysis').set('Cookie',cashierCookie)).statusCode).toBe(403);
        expect((await request(app).post('/api/admin/ingredient-movements/1/amend').set('Cookie', cashierCookie).send({ qty: 1 })).statusCode).toBe(403);
    });
    it('stores preparation yield as stock demand and returns the entered serving quantity', async () => {
        const created=await asAdmin('post','/api/admin/ingredients').send({name:'Yield chicken',measure:'weight',display_unit:'kg',unit_cost:4,cost_unit:'kg'});
        const id=created.body.ingredient.id;
        const url=`/api/admin/products/${SEED.product2.id}/recipe`;
        expect((await asAdmin('put',url).send({lines:[{ingredient_id:id,qty:100,unit:'g',yield_pct:0}]})).statusCode).toBe(400);
        expect((await asAdmin('put',url).send({lines:[{ingredient_id:id,qty:100,unit:'g',yield_pct:80}]})).statusCode).toBe(200);
        const saved=await asAdmin('get',url);
        expect(saved.body.lines[0]).toMatchObject({qty:0.1,stock_qty:0.125,yield_pct:80,qty_per_unit:125});
        expect(saved.body.plate_cost).toBe(0.5);
        expect((await asAdmin('get','/api/admin/ingredients/analysis?from=2026-09-08&to=2026-09-07')).statusCode).toBe(400);
        const report=await asAdmin('get','/api/admin/ingredients/analysis?from=2026-09-07&to=2026-09-07');
        expect(report.statusCode).toBe(200);expect(report.body.period.start_date).toBe('2026-09-07');
    });
    it('amends a waste quantity once, validates the reason and exposes correction history', async () => {
        const created = await asAdmin('post', '/api/admin/ingredients').send({ name: 'Amend API ingredient', measure: 'weight', display_unit: 'kg' });
        const id = created.body.ingredient.id;
        const waste = await asAdmin('post', `/api/admin/ingredients/${id}/movements`).send({ kind: 'waste', qty: 2, unit: 'kg', reason: 'spoiled', client_key: 'amend-api-waste' });
        expect(waste.statusCode).toBe(200);
        const movementId = waste.body.movement.id;
        const url = `/api/admin/ingredient-movements/${movementId}/amend`;
        const payload = { qty: 0, unit: 'kg', note: 'Recorded by mistake', client_key: 'amend-api-correction' };
        expect((await asAdmin('post', url).send({ ...payload, note: '' })).statusCode).toBe(400);
        expect((await asAdmin('post', url).send({ ...payload, qty: 2 })).statusCode).toBe(400);
        expect((await asAdmin('post', url).send({ ...payload, unit: 'ml' })).statusCode).toBe(400);
        const corrected = await asAdmin('post', url).send(payload);
        expect(corrected.statusCode).toBe(200);
        expect(Number(corrected.body.movement.qty)).toBe(2000);
        expect((await asAdmin('post', url).send(payload)).body.replay).toBe(true);
        expect((await asAdmin('post', url).send({ ...payload, note: 'Different reason' })).statusCode).toBe(409);
        const history = await asAdmin('get', `/api/admin/ingredients/${id}/movements`);
        expect(history.statusCode).toBe(200);
        expect(Number(history.body.rows.find(row => Number(row.id) === Number(movementId)).corrected_by_id)).toBe(Number(corrected.body.movement.id));
        expect(Number(history.body.rows.find(row => Number(row.id) === Number(corrected.body.movement.id)).original_qty)).toBe(-2000);
        const [[audit]] = await pool.query("SELECT COUNT(*) AS n FROM audit_events WHERE new_value LIKE '%amend-api-correction%'");
        expect(Number(audit.n)).toBe(1);
    });
});
