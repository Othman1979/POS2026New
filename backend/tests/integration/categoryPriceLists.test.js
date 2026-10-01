const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { fetchCartProducts } = require('../../services/InventoryService');
const { attachRegisterPrices } = require('../../services/categoryPriceLists');

describe('admin category price-list API', () => {
    let adminCookie;
    let cashierCookie;

    beforeAll(async () => {
        await seedDatabase();
        const admin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const cashier = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        adminCookie = admin.headers['set-cookie'][0];
        cashierCookie = cashier.headers['set-cookie'][0];
    });

    afterAll(async () => pool.end());

    it('keeps copy/read/save behind the existing admin router guard', async () => {
        expect((await request(app).post(`/api/admin/categories/${SEED.category.id}/copy`).set('Cookie', cashierCookie).send({ target_parent_id: null })).statusCode).toBe(403);
        expect((await request(app).get(`/api/admin/category-price-lists/${SEED.category.id}/products`).set('Cookie', cashierCookie)).statusCode).toBe(403);
        expect((await request(app).put(`/api/admin/category-price-lists/${SEED.category.id}/prices`).set('Cookie', cashierCookie).send({ prices: [] })).statusCode).toBe(403);
    });

    it('reads and atomically saves sparse gross overrides with current membership and tax', async () => {
        const suffix = Date.now();
        const categoryIds = [];
        const productIds = [];
        try {
            const root = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_prices_root_${suffix}`, is_price_list_root: true });
            const branchA = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_branch_a_${suffix}`, parent_id: root.body.id });
            const branchB = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_branch_b_${suffix}`, parent_id: root.body.id });
            const mealsA = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: 'Meals', parent_id: branchA.body.id });
            const mealsB = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: 'Meals', parent_id: branchB.body.id });
            const notes = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_notes_${suffix}`, parent_id: root.body.id, is_notes: true });
            const outside = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_outside_${suffix}` });
            categoryIds.push(root.body.id, branchA.body.id, branchB.body.id, mealsA.body.id, mealsB.body.id, notes.body.id, outside.body.id);

            const [p0] = await pool.query('INSERT INTO products (category_id, name, price, tax_rate) VALUES (?, ?, 2.000000, 0)', [root.body.id, `_tax0_${suffix}`]);
            const [p8] = await pool.query('INSERT INTO products (category_id, name, price, tax_rate) VALUES (?, ?, 0.925926, 8)', [mealsA.body.id, `_tax8_${suffix}`]);
            const [p16] = await pool.query('INSERT INTO products (category_id, name, price, tax_rate) VALUES (?, ?, 10.000000, 16)', [mealsB.body.id, `_tax16_${suffix}`]);
            const [inactive] = await pool.query('INSERT INTO products (category_id, name, price, tax_rate, is_active) VALUES (?, ?, 4.000000, 0, 0)', [mealsA.body.id, `_inactive_${suffix}`]);
            const [noteProduct] = await pool.query('INSERT INTO products (category_id, name, price, tax_rate) VALUES (?, ?, 9.000000, 0)', [notes.body.id, `_note_product_${suffix}`]);
            productIds.push(p0.insertId, p8.insertId, p16.insertId, inactive.insertId, noteProduct.insertId);
            await pool.query('INSERT INTO product_price_overrides (price_list_root_id, product_id, price) VALUES (?, ?, 10.500000)', [root.body.id, p16.insertId]);

            const read = await request(app).get(`/api/admin/category-price-lists/${root.body.id}/products`).set('Cookie', adminCookie);
            expect(read.statusCode).toBe(200);
            expect(read.body.root).toMatchObject({ id: root.body.id, is_active: 1 });
            expect(read.body.products).toHaveLength(4);
            expect(read.body.products.find(row => row.product_id === noteProduct.insertId)).toBeUndefined();
            expect(read.body.products.find(row => row.product_id === inactive.insertId)).toMatchObject({ is_active: 0 });
            const paths = read.body.products.filter(row => [p8.insertId, p16.insertId].includes(row.product_id)).map(row => row.category_path);
            expect(new Set(paths).size).toBe(2);
            expect(read.body.products.find(row => row.product_id === p8.insertId)).toMatchObject({
                base_net_price: 0.925926,
                base_gross_price: 1,
                override_net_price: null,
                effective_gross_price: 1
            });

            const save = await request(app).put(`/api/admin/category-price-lists/${root.body.id}/prices`)
                .set('Cookie', adminCookie)
                .send({ prices: [
                    { product_id: p0.insertId, gross_price: 0 },
                    { product_id: p8.insertId, gross_price: 1.25 },
                    { product_id: p16.insertId, gross_price: null },
                    { product_id: inactive.insertId, gross_price: 5 }
                ] });
            expect(save.statusCode).toBe(200);
            expect(save.body.changed_count).toBe(4);
            const [stored] = await pool.query('SELECT product_id, price FROM product_price_overrides WHERE price_list_root_id = ? ORDER BY product_id', [root.body.id]);
            expect(Number(stored.find(row => Number(row.product_id) === p0.insertId).price)).toBe(0);
            expect(Number(stored.find(row => Number(row.product_id) === p8.insertId).price)).toBeCloseTo(1.157407, 6);
            expect(stored.find(row => Number(row.product_id) === p16.insertId)).toBeUndefined();

            // Checkout's one combined admission read must preserve the old register-price
            // semantics: one row per requested base/note product, active overrides win,
            // and note-category products keep their own catalog price.
            await pool.query(
                'INSERT INTO product_price_overrides (price_list_root_id, product_id, price) VALUES (?, ?, 99.000000)',
                [root.body.id, noteProduct.insertId]
            );
            const checkoutContext = await fetchCartProducts(pool, [{
                product_id: p8.insertId,
                selectedModifiers: [{ noteProductId: noteProduct.insertId }]
            }], { includeCheckoutContext: true });
            expect(checkoutContext.size).toBe(2);
            expect(checkoutContext.get(p8.insertId)).toMatchObject({
                price_list_root_id: root.body.id,
                effective_price: 1.157407
            });
            expect(checkoutContext.get(noteProduct.insertId)).toMatchObject({
                price_list_root_id: null,
                effective_price: 9
            });

            await pool.query('UPDATE categories SET is_active = 0 WHERE id = ?', [root.body.id]);
            const inactiveRootContext = await fetchCartProducts(pool, [{ product_id: p8.insertId }], {
                includeCheckoutContext: true
            });
            expect(inactiveRootContext.get(p8.insertId)).toMatchObject({
                price_list_root_id: null,
                effective_price: 0.925926
            });
            const inactiveRootRegister = await attachRegisterPrices(pool, new Map([[p8.insertId, {}]]));
            expect(inactiveRootRegister.get(p8.insertId)).toMatchObject({
                price_list_root_id: null,
                effective_price: 0.925926,
                has_price_override: 0
            });
            await pool.query('UPDATE categories SET is_active = 1 WHERE id = ?', [root.body.id]);

            const [[auditCount]] = await pool.query("SELECT COUNT(*) AS total FROM audit_events WHERE event_type = 'category_price_overrides_changed' AND entity_id = ?", [root.body.id]);
            expect(Number(auditCount.total)).toBe(1);
            expect(__mockEmit__).toHaveBeenCalledWith('inventory_changed');

            const repeat = await request(app).put(`/api/admin/category-price-lists/${root.body.id}/prices`)
                .set('Cookie', adminCookie)
                .send({ prices: [
                    { product_id: p0.insertId, gross_price: 0 },
                    { product_id: p8.insertId, gross_price: 1.25 },
                    { product_id: p16.insertId, gross_price: null },
                    { product_id: inactive.insertId, gross_price: 5 }
                ] });
            expect(repeat.body.changed_count).toBe(0);
            const [[auditCountAfter]] = await pool.query("SELECT COUNT(*) AS total FROM audit_events WHERE event_type = 'category_price_overrides_changed' AND entity_id = ?", [root.body.id]);
            expect(Number(auditCountAfter.total)).toBe(1);

            expect((await request(app).put(`/api/admin/category-price-lists/${root.body.id}/prices`).set('Cookie', adminCookie)
                .send({ prices: [{ product_id: p8.insertId, gross_price: 1 }, { product_id: p8.insertId, gross_price: 2 }] })).statusCode).toBe(400);
            expect((await request(app).put(`/api/admin/category-price-lists/${root.body.id}/prices`).set('Cookie', adminCookie)
                .send({ prices: [{ product_id: noteProduct.insertId, gross_price: 1 }] })).statusCode).toBe(409);

            await pool.query('UPDATE products SET category_id = ? WHERE id = ?', [outside.body.id, p8.insertId]);
            const [[beforeRollback]] = await pool.query('SELECT price FROM product_price_overrides WHERE price_list_root_id = ? AND product_id = ?', [root.body.id, p0.insertId]);
            const failed = await request(app).put(`/api/admin/category-price-lists/${root.body.id}/prices`).set('Cookie', adminCookie)
                .send({ prices: [{ product_id: p0.insertId, gross_price: 3 }, { product_id: p8.insertId, gross_price: 2 }] });
            expect(failed.statusCode).toBe(409);
            const [[afterRollback]] = await pool.query('SELECT price FROM product_price_overrides WHERE price_list_root_id = ? AND product_id = ?', [root.body.id, p0.insertId]);
            expect(Number(afterRollback.price)).toBe(Number(beforeRollback.price));
        } finally {
            if (productIds.length) {
                await pool.query(`DELETE FROM product_bundle_items WHERE bundle_id IN (${productIds.map(() => '?').join(',')})`, productIds);
                await pool.query(`DELETE FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`, productIds);
            }
            if (categoryIds.length) {
                await pool.query(`DELETE FROM audit_events WHERE entity_type = 'category' AND entity_id IN (${categoryIds.map(() => '?').join(',')})`, categoryIds);
                for (const id of [...categoryIds].reverse()) await pool.query('DELETE FROM categories WHERE id = ?', [id]);
            }
        }
    });

    it('rejects non-root categories and malformed save values', async () => {
        expect((await request(app).get(`/api/admin/category-price-lists/${SEED.category.id}/products`).set('Cookie', adminCookie)).statusCode).toBe(400);
        expect((await request(app).put(`/api/admin/category-price-lists/${SEED.category.id}/prices`).set('Cookie', adminCookie)
            .send({ prices: [{ product_id: SEED.product1.id, gross_price: -1 }] })).statusCode).toBe(400);
    });

});
