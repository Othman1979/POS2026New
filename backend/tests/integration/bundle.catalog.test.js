// integration/bundle.catalog.test.js — POS catalog exposes bundle sub-items
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { invalidateCatalogCache } = require('../../config/cache');

describe('Bundle Catalog', () => {
    let cashierCookie;
    let adminCookie;
    let callCenterCookie;

    beforeEach(async () => {
        await seedDatabase();
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = loginRes.headers['set-cookie'][0];
        const adminLogin = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLogin.headers['set-cookie'][0];
        await pool.query("INSERT INTO users (id, user_number, name, role, is_active) VALUES (70, '9070', 'Phone Desk', 'call_center', 1)");
        const callCenterLogin = await request(app).post('/api/auth/login').send({ user_number: '9070' });
        callCenterCookie = callCenterLogin.headers['set-cookie'][0];
    });

    async function seedCategoryPrices() {
        invalidateCatalogCache();
        await pool.query(`
            INSERT INTO categories (id, parent_id, name, is_active, is_notes, price_list_root_id)
            VALUES
                (20, NULL, 'Talabat', 1, 0, NULL),
                (21, 20, 'Meals', 1, 0, 20),
                (22, NULL, 'Careem', 1, 0, NULL),
                (23, 22, 'Meals', 1, 0, 22)
        `);
        await pool.query('UPDATE categories SET price_list_root_id = id WHERE id IN (20, 22)');
        await pool.query(`
            INSERT INTO products (id, category_id, barcode, name, price, tax_rate, is_active, is_bundle)
            VALUES
                (20, 21, 'PL-20', 'Chicken Meal', 5.000000, 8, 1, 0),
                (21, 21, 'PL-21', 'Talabat Fallback', 6.000000, 8, 1, 0),
                (22, 23, 'PL-22', 'Chicken Meal', 5.000000, 8, 1, 0)
        `);
        await pool.query(`
            INSERT INTO product_price_overrides (price_list_root_id, product_id, price)
            VALUES (20, 20, 0.925926), (22, 22, 1.851852)
        `);
    }

    afterAll(async () => {
        await pool.end();
    });

    it('filters deferred and Y order types only for call center', async () => {
        await pool.query(`
            INSERT INTO order_types (id, name, is_active, is_deferred_settlement)
            VALUES (20, 'Platform', 1, 1), (21, 'Delivery', 1, 0)
        `);
        await pool.query("UPDATE settings SET setting_value='2' WHERE setting_key='y_order_type_id'");

        const phoneTypes = await request(app).get('/api/pos/order_types').set('Cookie', callCenterCookie);
        expect(phoneTypes.statusCode).toBe(200);
        expect(phoneTypes.body.data.map(row => Number(row.id))).toEqual([1, 21]);

        const cashierTypes = await request(app).get('/api/pos/order_types').set('Cookie', cashierCookie);
        expect(cashierTypes.body.data.map(row => Number(row.id))).toEqual([1, 2, 20, 21]);
    });

    it('uses POST and canonical legacy-phone matching without guessing ambiguous customers', async () => {
        await pool.query(`
            INSERT INTO customers (name, phone, address)
            VALUES ('Phone Customer', '079-123 4567', 'Amman')
        `);
        const found = await request(app)
            .post('/api/pos/customer_lookup')
            .set('Cookie', callCenterCookie)
            .send({ phone: '0791234567' });
        expect(found.statusCode).toBe(200);
        expect(found.headers['cache-control']).toContain('no-store');
        expect(found.body.customer).toMatchObject({ name: 'Phone Customer', address: 'Amman' });

        const urlLookup = await request(app)
            .get('/api/pos/customer_lookup?phone=0791234567')
            .set('Cookie', callCenterCookie);
        expect(urlLookup.statusCode).toBe(405);

        await pool.query("INSERT INTO customers (name, phone, address) VALUES ('Duplicate', '079 123-4567', 'Zarqa')");
        const ambiguous = await request(app)
            .post('/api/pos/customer_lookup')
            .set('Cookie', callCenterCookie)
            .send({ phone: '079-123-4567' });
        expect(ambiguous.statusCode).toBe(409);
        expect(ambiguous.body.code).toBe('CUSTOMER_PHONE_AMBIGUOUS');
    });

    it('bundle product carries is_bundle=1 and a bundleItems array', async () => {
        const res = await request(app)
            .get('/api/pos/products?search=Family')
            .set('Cookie', cashierCookie);

        expect(res.statusCode).toBe(200);
        const bundle = res.body.products.find(p => p.id === SEED.bundleProduct.id);
        expect(bundle).toBeDefined();
        expect(Number(bundle.is_bundle)).toBe(1);
        expect(Array.isArray(bundle.bundleItems)).toBe(true);
        expect(bundle.bundleItems).toHaveLength(2);

        const burger = bundle.bundleItems.find(i => i.product_id === SEED.product1.id);
        expect(burger).toBeDefined();
        expect(burger.name).toBe(SEED.product1.name);
        expect(Number(burger.qty)).toBe(1);
        expect(burger).toHaveProperty('category_id');
        expect(burger).toHaveProperty('tax_rate');
    });

    it('non-bundle product has no bundleItems', async () => {
        const res = await request(app)
            .get('/api/pos/products?search=Burger')
            .set('Cookie', cashierCookie);

        expect(res.statusCode).toBe(200);
        const burger = res.body.products.find(p => p.id === SEED.product1.id);
        expect(burger).toBeDefined();
        expect(burger.bundleItems == null).toBe(true);
    });

    it('defaults legacy catalog requests to register context and marks full category payloads', async () => {
        const res = await request(app)
            .get('/api/pos/products')
            .set('Cookie', cashierCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body.categories_included).toBe(true);
        expect(res.body.products.find(p => p.id === SEED.product1.id)).toMatchObject({
            price: SEED.product1.price,
            base_price: SEED.product1.price,
            category_is_notes: 0,
            category_is_active: 1
        });
    });

    it('returns category-owned note metadata through both global search and barcode lookup', async () => {
        await pool.query(`
            INSERT INTO categories (id, name, is_active, is_notes)
            VALUES (91, 'Priced notes', 1, 1)
        `);
        await pool.query(`
            INSERT INTO products (id, category_id, barcode, name, price, tax_rate, is_active, is_bundle)
            VALUES (91, 91, 'NOTE-91', 'Global Extra', 0.2, 0, 1, 0)
        `);

        const search = await request(app)
            .get('/api/pos/products?search=Global%20Extra')
            .set('Cookie', cashierCookie);
        const lookup = await request(app)
            .get('/api/pos/product_lookup?barcode=NOTE-91')
            .set('Cookie', cashierCookie);

        expect(search.statusCode).toBe(200);
        expect(search.body.products.find(product => product.id === 91)).toMatchObject({
            category_is_notes: 1,
            category_is_active: 1
        });
        expect(lookup.statusCode).toBe(200);
        expect(lookup.body.product).toMatchObject({ category_is_notes: 1, category_is_active: 1 });

        const resolution = await request(app)
            .post('/api/pos/category-prices/resolve')
            .set('Cookie', cashierCookie)
            .send({ sales_context: 'register', product_ids: [91] });
        expect(resolution.statusCode).toBe(200);
        expect(resolution.body.products[0]).toMatchObject({
            product_id: 91,
            name: 'Global Extra',
            product_is_active: 1,
            category_is_active: 1,
            category_is_notes: 1
        });
    });

    it.each(['0100000040591', '100000040591'])('resolves scale label %s through its six-digit product barcode', async (barcode) => {
        await pool.query(`
            INSERT INTO products (category_id, barcode, name, price, tax_rate, is_active, is_available, is_bundle)
            VALUES (NULL, '100000', 'Scale beef', 11.000000, 0, 1, 1, 0)
        `);

        const lookup = await request(app)
            .get(`/api/pos/product_lookup?barcode=${barcode}&sales_context=register`)
            .set('Cookie', cashierCookie);

        expect(lookup.statusCode).toBe(200);
        expect(lookup.body.product).toMatchObject({ barcode: '100000', name: 'Scale beef', price: 11 });
        expect(lookup.body.scale_total_cents).toBe(4059);
    });

    it.each(['0100000040591', '100000040591'])('keeps exact barcode %s authoritative over scale fallback', async (barcode) => {
        await pool.query(`
            INSERT INTO products (category_id, barcode, name, price, tax_rate, is_active, is_available, is_bundle)
            VALUES
                (NULL, '100000', 'Scale beef', 11.000000, 0, 1, 1, 0),
                (NULL, '${barcode}', 'Ordinary exact item', 3.000000, 0, 1, 1, 0)
        `);

        const exact = await request(app)
            .get(`/api/pos/product_lookup?barcode=${barcode}&sales_context=register`)
            .set('Cookie', cashierCookie);

        expect(exact.statusCode).toBe(200);
        expect(exact.body.product).toMatchObject({ barcode, name: 'Ordinary exact item' });
        expect(exact.body.scale_total_cents).toBeNull();

        await pool.query('UPDATE products SET is_active = 0 WHERE barcode = ?', [barcode]);
        const blocked = await request(app)
            .get(`/api/pos/product_lookup?barcode=${barcode}&sales_context=register`)
            .set('Cookie', cashierCookie);

        expect(blocked.statusCode).toBe(200);
        expect(blocked.body.product).toBeNull();
        expect(blocked.body.scale_total_cents).toBeNull();
    });

    it('resolves a 2-leading scale label through a prefix-included six-digit product barcode', async () => {
        await pool.query(`
            INSERT INTO products (category_id, barcode, name, price, tax_rate, is_active, is_available, is_bundle)
            VALUES (NULL, '200001', 'Store 2 beef', 11.000000, 0, 1, 1, 0)
        `);

        const lookup = await request(app)
            .get('/api/pos/product_lookup?barcode=2000010040599&sales_context=register')
            .set('Cookie', cashierCookie);

        expect(lookup.statusCode).toBe(200);
        expect(lookup.body.product).toMatchObject({ barcode: '200001', name: 'Store 2 beef' });
        expect(lookup.body.scale_total_cents).toBe(4059);
    });

    it('does not fall through to another reading when a 2-leading label owner is inactive', async () => {
        await pool.query(`
            INSERT INTO products (category_id, barcode, name, price, tax_rate, is_active, is_available, is_bundle)
            VALUES (NULL, '000010', 'Retired item', 5.000000, 0, 0, 1, 0),
                   (NULL, '200001', 'Store 2 beef', 11.000000, 0, 1, 1, 0)
        `);

        const lookup = await request(app)
            .get('/api/pos/product_lookup?barcode=2000010040599&sales_context=register')
            .set('Cookie', cashierCookie);

        expect(lookup.statusCode).toBe(200);
        expect(lookup.body.product).toBeNull();
    });

    it('does not guess between two active products owning different readings of a 2-leading label', async () => {
        await pool.query(`
            INSERT INTO products (category_id, barcode, name, price, tax_rate, is_active, is_available, is_bundle)
            VALUES (NULL, '000010', 'Item ten', 5.000000, 0, 1, 1, 0),
                   (NULL, '200001', 'Store 2 beef', 11.000000, 0, 1, 1, 0)
        `);

        const lookup = await request(app)
            .get('/api/pos/product_lookup?barcode=2000010040599&sales_context=register')
            .set('Cookie', cashierCookie);

        expect(lookup.statusCode).toBe(200);
        expect(lookup.body.product).toBeNull();
    });

    it('does not guess scale products from invalid or unknown labels', async () => {
        await pool.query(`
            INSERT INTO products (category_id, barcode, name, price, tax_rate, is_active, is_available, is_bundle)
            VALUES (NULL, '100000', 'Scale beef', 11.000000, 0, 1, 1, 0)
        `);
        await pool.query("UPDATE products SET barcode = 'ORD-1' WHERE id = ?", [SEED.product1.id]);

        const badChecksum = await request(app)
            .get('/api/pos/product_lookup?barcode=0100000040592&sales_context=register')
            .set('Cookie', cashierCookie);
        const missingProduct = await request(app)
            .get('/api/pos/product_lookup?barcode=0999999040596&sales_context=register')
            .set('Cookie', cashierCookie);
        const ordinary = await request(app)
            .get('/api/pos/product_lookup?barcode=ORD-1&sales_context=register')
            .set('Cookie', cashierCookie);

        expect(badChecksum.body).toMatchObject({ product: null });
        expect(missingProduct.body).toMatchObject({ product: null });
        expect(ordinary.body.product).toMatchObject({ id: SEED.product1.id });
        expect(ordinary.body.scale_total_cents).toBeNull();
    });

    it('uses the effective register price for a scale-resolved product', async () => {
        await seedCategoryPrices();
        await pool.query("UPDATE products SET barcode = '100000' WHERE id = 20");

        const lookup = await request(app)
            .get('/api/pos/product_lookup?barcode=0100000040591&sales_context=register')
            .set('Cookie', cashierCookie);

        expect(lookup.statusCode).toBe(200);
        expect(lookup.body.product).toMatchObject({ id: 20, barcode: '100000', price: 0.925926, has_price_override: 1 });
        expect(lookup.body.scale_total_cents).toBe(4059);
    });

    it('does not add database commands beyond an ordinary uncached barcode lookup', async () => {
        await pool.query(`
            INSERT INTO products (category_id, barcode, name, price, tax_rate, is_active, is_available, is_bundle)
            VALUES (NULL, '100000', 'Scale beef', 11.000000, 0, 1, 1, 0)
        `);
        await pool.query("UPDATE products SET barcode = 'ORD-1' WHERE id = ?", [SEED.product1.id]);

        const originalQuery = pool.query.bind(pool);
        const productQueries = [];
        const querySpy = vi.spyOn(pool, 'query').mockImplementation((sql, params) => {
            if (/FROM\s+products\s+p\b/i.test(String(sql))) productQueries.push(String(sql));
            return originalQuery(sql, params);
        });

        try {
            await request(app)
                .get('/api/pos/product_lookup?barcode=ORD-1&sales_context=register')
                .set('Cookie', cashierCookie);
            const ordinaryCount = productQueries.length;
            productQueries.length = 0;

            await request(app)
                .get('/api/pos/product_lookup?barcode=0100000040591&sales_context=register')
                .set('Cookie', cashierCookie);

            expect(productQueries).toHaveLength(ordinaryCount);
            expect(ordinaryCount).toBe(2);
        } finally {
            querySpy.mockRestore();
        }
    });

    it('exposes only the POS catalog settings that the catalog workspace consumes', async () => {
        invalidateCatalogCache();
        await pool.query(`
            INSERT INTO settings (setting_key, setting_value) VALUES
                ('catalog_contract_secret', 'must-not-leak'),
                ('spooler_key', 'must-not-leak'),
                ('stock_enabled', '1'),
                ('service_charge_enabled', '1'),
                ('service_charge_percentage', '7.5'),
                ('tables_enabled', '1'),
                ('auto_apply_service_charge', '1')
            ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
        `);

        const res = await request(app)
            .get('/api/pos/products')
            .set('Cookie', cashierCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body.settings).toEqual({
            stock_enabled: '1',
            service_charge_enabled: '1',
            service_charge_percentage: '7.5',
            tables_enabled: '1',
            auto_apply_service_charge: '1'
        });
    });

    it('rejects invalid catalog and barcode sales contexts', async () => {
        const catalog = await request(app)
            .get('/api/pos/products?sales_context=delivery')
            .set('Cookie', cashierCookie);
        const lookup = await request(app)
            .get('/api/pos/product_lookup?barcode=missing&sales_context=delivery')
            .set('Cookie', cashierCookie);

        expect(catalog.statusCode).toBe(400);
        expect(lookup.statusCode).toBe(400);
    });

    it('does not replace categories for lightweight searches', async () => {
        await request(app).get('/api/pos/products').set('Cookie', cashierCookie);
        const res = await request(app)
            .get('/api/pos/products?lightweight=1&search=Burger')
            .set('Cookie', cashierCookie);
        const rootLightweight = await request(app)
            .get('/api/pos/products?lightweight=1')
            .set('Cookie', cashierCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body.categories_included).toBe(false);
        expect(rootLightweight.body.categories_included).toBe(false);
    });

    it('resolves each register search result from its own category root', async () => {
        await seedCategoryPrices();

        const res = await request(app)
            .get('/api/pos/products?search=Chicken&sales_context=register')
            .set('Cookie', cashierCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body.products.find(p => p.id === 20)).toMatchObject({
            price: 0.925926,
            base_price: 5,
            category_name: 'Meals',
            price_list_root_id: 20,
            price_list_root_name: 'Talabat',
            has_price_override: 1
        });
        expect(res.body.products.find(p => p.id === 22)).toMatchObject({
            price: 1.851852,
            base_price: 5,
            category_name: 'Meals',
            price_list_root_id: 22,
            price_list_root_name: 'Careem',
            has_price_override: 1
        });
    });

    it('uses base fallback in register context and hides price-list products from table search and barcode', async () => {
        await seedCategoryPrices();

        const fallback = await request(app)
            .get('/api/pos/product_lookup?barcode=PL-21&sales_context=register')
            .set('Cookie', cashierCookie);
        const tableSearch = await request(app)
            .get('/api/pos/products?search=Chicken&sales_context=table')
            .set('Cookie', cashierCookie);
        const talabatTableLookup = await request(app)
            .get('/api/pos/product_lookup?barcode=PL-20&sales_context=table')
            .set('Cookie', cashierCookie);
        const careemTableLookup = await request(app)
            .get('/api/pos/product_lookup?barcode=PL-22&sales_context=table')
            .set('Cookie', cashierCookie);

        expect(fallback.body.product).toMatchObject({
            id: 21,
            price: 6,
            base_price: 6,
            price_list_root_id: 20,
            has_price_override: 0
        });
        expect(tableSearch.body.products).toEqual([]);
        expect(talabatTableLookup.body.product).toBeNull();
        expect(careemTableLookup.body.product).toBeNull();
    });

    it('keeps cached register categories out of a full table catalog', async () => {
        await seedCategoryPrices();

        const register = await request(app)
            .get('/api/pos/products?sales_context=register')
            .set('Cookie', cashierCookie);
        const table = await request(app)
            .get('/api/pos/products?sales_context=table')
            .set('Cookie', cashierCookie);

        expect(register.body.categories.map(c => c.id)).toEqual(expect.arrayContaining([20, 21, 22]));
        expect(table.body.categories.map(c => c.id)).not.toEqual(expect.arrayContaining([20, 21, 22]));
        expect(table.body.categories_included).toBe(true);
    });

    it('hides an inactive price-list tree but safely falls back for a malformed root', async () => {
        await seedCategoryPrices();
        await pool.query('UPDATE categories SET is_active = 0 WHERE id = 20');

        const inactive = await request(app)
            .get('/api/pos/products?search=Talabat&sales_context=register')
            .set('Cookie', cashierCookie);
        expect(inactive.body.products).toEqual([]);

        await pool.query('UPDATE categories SET is_active = 1, price_list_root_id = NULL WHERE id = 20');
        const malformed = await request(app)
            .get('/api/pos/product_lookup?barcode=PL-21&sales_context=register')
            .set('Cookie', cashierCookie);
        expect(malformed.body.product).toMatchObject({
            id: 21,
            price: 6,
            base_price: 6,
            price_list_root_id: null,
            has_price_override: 0
        });
    });

    it('resolves unique product ids authoritatively and reports missing ids', async () => {
        await seedCategoryPrices();

        const register = await request(app)
            .post('/api/pos/category-prices/resolve')
            .set('Cookie', cashierCookie)
            .send({ sales_context: 'register', product_ids: [20, 20, 21, 999999] });
        const table = await request(app)
            .post('/api/pos/category-prices/resolve')
            .set('Cookie', cashierCookie)
            .send({ sales_context: 'table', product_ids: [20] });

        expect(register.statusCode).toBe(200);
        expect(register.body.products).toHaveLength(2);
        expect(register.body.products.find(p => p.product_id === 20)).toMatchObject({
            price: 0.925926,
            base_price: 5,
            tax_rate: 8,
            price_list_root_id: 20,
            has_price_override: 1
        });
        expect(register.body.missing_product_ids).toEqual([999999]);
        expect(table.body.products[0]).toMatchObject({
            product_id: 20,
            price: 5,
            base_price: 5,
            price_list_root_id: null,
            has_price_override: 0
        });
    });

    it('blocks availability changes without permission', async () => {
        const res = await request(app)
            .patch(`/api/pos/products/${SEED.product1.id}/availability`)
            .set('Cookie', cashierCookie)
            .send({ is_available: false });

        expect(res.statusCode).toBe(403);
        const [[product]] = await pool.query('SELECT is_available FROM products WHERE id = ?', [SEED.product1.id]);
        expect(Number(product.is_available)).toBe(1);
    });

    it('lets an admin mark a product sold out, audits it, and makes its bundle unsellable', async () => {
        const res = await request(app)
            .patch(`/api/pos/products/${SEED.product1.id}/availability`)
            .set('Cookie', adminCookie)
            .send({ is_available: false });

        expect(res.statusCode).toBe(200);
        expect(res.body.product).toMatchObject({
            id: SEED.product1.id,
            is_available: 0,
            can_sell: 0
        });

        const catalog = await request(app)
            .get('/api/pos/products?search=')
            .set('Cookie', cashierCookie);
        const burger = catalog.body.products.find(p => p.id === SEED.product1.id);
        const bundle = catalog.body.products.find(p => p.id === SEED.bundleProduct.id);
        expect(Number(burger.can_sell)).toBe(0);
        expect(Number(bundle.is_available)).toBe(1);
        expect(Number(bundle.can_sell)).toBe(0);

        const [[audit]] = await pool.query(
            "SELECT old_value, new_value FROM audit_events WHERE event_type = 'product_availability_changed' AND entity_id = ? ORDER BY id DESC LIMIT 1",
            [SEED.product1.id]
        );
        expect(JSON.parse(audit.old_value)).toEqual({ is_available: 1 });
        expect(JSON.parse(audit.new_value)).toEqual({ is_available: 0 });
        expect(global.__mockEmit__).toHaveBeenCalledWith('inventory_changed', { scope: 'availability' });
        expect(global.__mockEmit__).toHaveBeenCalledWith('product_availability_changed', expect.objectContaining({
            product_id: SEED.product1.id,
            is_available: 0
        }));
        expect(global.__mockTo__).toHaveBeenCalledWith('staff');
        expect(global.__mockTo__.mock.calls.filter(call => call[0] === 'staff')).toHaveLength(1);
    });

    it('lets a cashier with the explicit permission restore a product to sale', async () => {
        await pool.query('UPDATE products SET is_available = 0 WHERE id = ?', [SEED.product2.id]);
        await pool.query(
            'INSERT INTO user_permissions (user_id, perm_key) VALUES (?, ?)',
            [SEED.cashierUser.id, 'pos.product_availability']
        );
        const { invalidateUserSessions } = require('../../middleware/auth');
        invalidateUserSessions(SEED.cashierUser.id);
        const relogin = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });

        const res = await request(app)
            .patch(`/api/pos/products/${SEED.product2.id}/availability`)
            .set('Cookie', relogin.headers['set-cookie'][0])
            .send({ is_available: true });

        expect(res.statusCode).toBe(200);
        expect(res.body.product).toMatchObject({ is_available: 1, can_sell: 1 });
    });

    it('ignores a non-numeric category_id instead of erroring', async () => {
        const res = await request(app).get('/api/pos/products?category_id=abc').set('Cookie', cashierCookie);
        expect(res.statusCode).toBe(200);
    });

    it('customer_lookup returns {success:true, customer:null} on a miss', async () => {
        const res = await request(app).get('/api/pos/customer_lookup?phone=00000000000').set('Cookie', cashierCookie);
        expect(res.body.success).toBe(true);
        expect(res.body.customer).toBeNull();
    });
});
