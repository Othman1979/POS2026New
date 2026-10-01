// integration/products.test.js — Inventory route correctness: partial PUT + method guard
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { appendAuditEvent, appendSecurityAuditEvent } = require('../../services/auditEvents');
const { insertPaidOrder, insertOrderItem } = require('../helpers/fixtures');
const xlsx = require('xlsx');

describe('Admin products route', () => {
    let adminCookie;

    beforeAll(async () => {
        await seedDatabase();
        const login = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    async function storedPrice(id) {
        const [[row]] = await pool.query('SELECT price FROM products WHERE id = ?', [id]);
        return Number(row.price);
    }

    function replacementWorkbook(suffix) {
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([
            { Name: `_replacement_category_${suffix}` }
        ]), 'Categories');
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([
            { Name: `_replacement_product_${suffix}`, Category: `_replacement_category_${suffix}`, Price: 11.6, 'Tax Rate': 16 }
        ]), 'Products');
        return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    }

    test('PUT without a price never changes the stored price (no compounding)', async () => {
        // Admin submits GROSS 116.00 at 16% -> stored NET 100.00
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: '_idempotency_probe', price: '116.00', tax_rate: 16 });
        expect(create.body.success).toBe(true);
        const id = create.body.id;
        expect(await storedPrice(id)).toBeCloseTo(100.00, 2);

        // Real quick-action shape (Phase 3): only { id, is_active }, no price.
        for (let i = 0; i < 3; i++) {
            const put = await request(app).put('/api/admin/products')
                .set('Cookie', adminCookie)
                .send({ id, is_active: i % 2 });
            expect(put.body.success).toBe(true);
        }
        expect(await storedPrice(id)).toBeCloseTo(100.00, 2);

        await pool.query('DELETE FROM products WHERE id = ?', [id]);
    });

    test('PUT tells staff terminals to reload only the edited product', async () => {
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: '_announce_probe', price: '116.00', tax_rate: 16 });
        const id = create.body.id;
        expect(create.body.success).toBe(true);
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'inventory_changed'))
            .toContainEqual(['inventory_changed', { scope: 'catalog', productIds: [id] }]);
        global.__mockEmit__.mockClear();

        const put = await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, name: '_announce_probe_renamed' });
        expect(put.body.success).toBe(true);
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'inventory_changed'))
            .toEqual([['inventory_changed', { scope: 'catalog', productIds: [id] }]]);

        await pool.query('DELETE FROM products WHERE id = ?', [id]);
    });

    test('PUT with only { id, stock } preserves name and price (no clobber)', async () => {
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: '_clobber_probe', price: '116.00', tax_rate: 16 });
        const id = create.body.id;

        const put = await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, stock: 7, expected_stock_version: 0 });
        expect(put.body.success).toBe(true);

        const [[row]] = await pool.query('SELECT name, price, stock FROM products WHERE id = ?', [id]);
        expect(row.name).toBe('_clobber_probe');
        expect(Number(row.price)).toBeCloseTo(100.00, 2);
        expect(Number(row.stock)).toBe(7);

        await pool.query('DELETE FROM products WHERE id = ?', [id]);
    });

    test('product writes preserve fractional stock to six decimals', async () => {
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: '_fractional_stock_probe', price: '1.00', stock: 7.217391, min_stock_level: 0.125 });
        const id = create.body.id;

        expect(create.statusCode).toBe(200);
        const put = await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, stock: 6.967391, min_stock_level: 0.125, expected_stock_version: 0 });
        expect(put.statusCode).toBe(200);

        const [[row]] = await pool.query('SELECT stock, min_stock_level FROM products WHERE id = ?', [id]);
        expect(Number(row.stock)).toBe(6.967391);
        expect(Number(row.min_stock_level)).toBe(0.125);

        await pool.query('DELETE FROM products WHERE id = ?', [id]);
    });

    test('modal-shaped PUT (no min_stock_level) preserves the stored min_stock_level', async () => {
        // Locks the past data-loss bug: the modal form never sends min_stock_level.
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: '_min_probe', price: '1.00', min_stock_level: 4 });
        const id = create.body.id;

        await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, name: '_min_probe', price: '1.00', tax_rate: 0, stock: '', is_active: 1, expected_stock_version: 0 });

        const [[row]] = await pool.query('SELECT min_stock_level FROM products WHERE id = ?', [id]);
        expect(Number(row.min_stock_level)).toBe(4);

        await pool.query('DELETE FROM products WHERE id = ?', [id]);
    });

    test('PUT with a gross price still strips tax exactly once', async () => {
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: '_strip_probe', price: '116.00', tax_rate: 16 });
        const id = create.body.id;

        // Modal edit: gross 232.00 at 16% -> stored net 200.00
        const put = await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, name: '_strip_probe', price: '232.00', tax_rate: 16 });
        expect(put.body.success).toBe(true);
        expect(await storedPrice(id)).toBeCloseTo(200.00, 2);

        await pool.query('DELETE FROM products WHERE id = ?', [id]);
    });

    test('POS catalog returns exactly the requested product_ids and bounds the list', async () => {
        const [rows] = await pool.query(`
            SELECT p.id FROM products p LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.is_active = 1 AND (p.category_id IS NULL OR c.price_list_root_id IS NULL) ORDER BY p.id LIMIT 2`);
        expect(rows).toHaveLength(2);
        const [a, b] = rows.map(row => Number(row.id));
        const get = (ids) => request(app).get(`/api/pos/products?sales_context=table&product_ids=${ids}`).set('Cookie', adminCookie);

        const res = await get(`${a},${b},${a}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.products.map(p => p.id).sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
        expect(res.body.products[0]).toEqual(expect.objectContaining({ can_sell: expect.any(Number), price: expect.any(Number) }));
        expect(res.body.categories).toEqual([]);

        for (const bad of ['', 'x', '0', '-1', `${a},x`]) expect((await get(bad)).statusCode).toBe(400);
        const many = Array.from({ length: 301 }, (_, i) => i + 1);
        expect((await get(many.join(','))).statusCode).toBe(400);
        expect((await get(many.slice(0, 300).join(','))).statusCode).toBe(200);
        expect((await request(app).get(`/api/pos/products?sales_context=table&product_ids=${a}`)).statusCode).toBe(401);
    });

    test('admin can lock a product price and the POS catalog exposes the current lock', async () => {
        const name = `_price_lock_${Date.now()}`;
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name, price: '5.00', tax_rate: 0, price_override_locked: true });
        expect(create.statusCode).toBe(200);
        const id = create.body.id;

        try {
            const [[created]] = await pool.query('SELECT price_override_locked FROM products WHERE id = ?', [id]);
            expect(Number(created.price_override_locked)).toBe(1);

            const catalog = await request(app)
                .get(`/api/pos/products?search=${encodeURIComponent(name)}&sales_context=register`)
                .set('Cookie', adminCookie);
            expect(catalog.statusCode).toBe(200);
            expect(catalog.body.products).toEqual([
                expect.objectContaining({ id, price_override_locked: 1 })
            ]);

            const resolved = await request(app)
                .post('/api/pos/category-prices/resolve')
                .set('Cookie', adminCookie)
                .send({ product_ids: [id], sales_context: 'register' });
            expect(resolved.statusCode).toBe(200);
            expect(resolved.body.products).toEqual([
                expect.objectContaining({ product_id: id, price_override_locked: 1 })
            ]);

            const unlock = await request(app).put('/api/admin/products')
                .set('Cookie', adminCookie)
                .send({ id, price_override_locked: false });
            expect(unlock.statusCode).toBe(200);
            const [[updated]] = await pool.query('SELECT price_override_locked FROM products WHERE id = ?', [id]);
            expect(Number(updated.price_override_locked)).toBe(0);

            const invalid = await request(app).put('/api/admin/products')
                .set('Cookie', adminCookie)
                .send({ id, price_override_locked: 'sometimes' });
            expect(invalid.statusCode).toBe(400);
        } finally {
            await pool.query('DELETE FROM products WHERE id = ?', [id]);
        }
    });

    test('unsupported method returns 405 on /products (no hang)', async () => {
        const res = await request(app).patch('/api/admin/products')
            .set('Cookie', adminCookie).send({});
        expect(res.statusCode).toBe(405);
    });

    test('unsupported method returns 405 on /categories (no hang)', async () => {
        const res = await request(app).patch('/api/admin/categories')
            .set('Cookie', adminCookie).send({});
        expect(res.statusCode).toBe(405);
    });

    test('POST rejects a blank name with 400', async () => {
        const res = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie).send({ name: '   ', price: '1.00' });
        expect(res.statusCode).toBe(400);
    });

    test('POST rejects a negative price with 400', async () => {
        const res = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie).send({ name: '_neg', price: '-5.00' });
        expect(res.statusCode).toBe(400);
    });

    test('POST persists an explicit exempt zero-rate category and defaults legacy zero-rate products to O', async () => {
        const exemptName = `_exempt_${Date.now()}`;
        const zeroName = `_zero_${Date.now()}`;
        try {
            const exempt = await request(app).post('/api/admin/products')
                .set('Cookie', adminCookie)
                .send({ name: exemptName, price: '3.00', tax_rate: 0, jofotara_tax_category: 'Z' });
            const zero = await request(app).post('/api/admin/products')
                .set('Cookie', adminCookie)
                .send({ name: zeroName, price: '4.00', tax_rate: 0 });
            expect(exempt.statusCode).toBe(200);
            expect(zero.statusCode).toBe(200);
            const [rows] = await pool.query(
                'SELECT name, jofotara_tax_category FROM products WHERE id IN (?, ?)',
                [exempt.body.id, zero.body.id]
            );
            expect(rows.find(row => row.name === exemptName).jofotara_tax_category).toBe('Z');
            expect(rows.find(row => row.name === zeroName).jofotara_tax_category).toBe('O');
        } finally {
            await pool.query('DELETE FROM products WHERE name IN (?, ?)', [exemptName, zeroName]);
        }
    });

    test('POST rejects category/rate combinations that JoFotara cannot represent', async () => {
        const positiveExempt = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: `_bad_positive_${Date.now()}`, price: '10.00', tax_rate: 8, jofotara_tax_category: 'Z' });
        const zeroStandard = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: `_bad_zero_${Date.now()}`, price: '10.00', tax_rate: 0, jofotara_tax_category: 'S' });
        expect(positiveExempt.statusCode).toBe(400);
        expect(zeroStandard.statusCode).toBe(400);
    });

    test('POST rejects an unsupported active sales-tax rate while JoFotara sales-tax mode is enabled', async () => {
        const name = `_jofotara_rate_reject_${Date.now()}`;
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'tax_registration_type' THEN 'sales_tax'
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END
            WHERE setting_key IN ('jofotara_enabled','tax_registration_type','jofotara_sales_tax_client_id',
                'jofotara_sales_tax_secret_key','jofotara_sales_tax_income_source_sequence',
                'jofotara_sales_tax_seller_tax_number','jofotara_sales_tax_seller_registered_name')`);
        try {
            const res = await request(app).post('/api/admin/products').set('Cookie', adminCookie)
                .send({ name, price: '10.00', tax_rate: 6.5 });
            expect(res.statusCode).toBe(409);
            const [[row]] = await pool.query('SELECT id FROM products WHERE name = ?', [name]);
            expect(row).toBeUndefined();
        } finally {
            await pool.query('DELETE FROM products WHERE name = ?', [name]);
            await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='jofotara_enabled'");
        }
    });

    test('batch POST creates one category batch with per-product tax and stock values', async () => {
        const suffix = Date.now();
        const firstName = `_batch_taxed_${suffix}`;
        const secondName = `_batch_plain_${suffix}`;
        const firstBarcode = `batch-taxed-${suffix}`;
        const secondBarcode = `batch-plain-${suffix}`;

        try {
            const res = await request(app).post('/api/admin/products/batch')
                .set('Cookie', adminCookie)
                .send({
                    category_id: SEED.category.id,
                    products: [
                        { name: firstName, price: '11.60', tax_rate: 16, barcode: firstBarcode, cost_price: '4.25', stock: 7.25, background_color: '#dcece9' },
                        { name: secondName, price: '8.00', tax_rate: 0, barcode: secondBarcode, cost_price: '', stock: '' }
                    ]
                });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.created_count).toBe(2);

            const [rows] = await pool.query(
                'SELECT name, category_id, price, tax_rate, cost_price, stock, background_color FROM products WHERE name IN (?, ?) ORDER BY name',
                [firstName, secondName]
            );
            expect(rows).toHaveLength(2);

            const taxed = rows.find(row => row.name === firstName);
            const plain = rows.find(row => row.name === secondName);
            expect(Number(taxed.category_id)).toBe(SEED.category.id);
            expect(Number(taxed.price)).toBeCloseTo(10, 4);
            expect(Number(taxed.tax_rate)).toBe(16);
            expect(Number(taxed.cost_price)).toBeCloseTo(4.25, 2);
            expect(Number(taxed.stock)).toBe(7.25);
            expect(taxed.background_color).toBe('#dcece9');
            expect(Number(plain.price)).toBeCloseTo(8, 4);
            expect(Number(plain.tax_rate)).toBe(0);
            expect(plain.stock).toBeNull();
        } finally {
            await pool.query('DELETE FROM products WHERE name IN (?, ?)', [firstName, secondName]);
        }
    });

    test('xyz=1 suppresses shared and batch audit writes without blocking the work', async () => {
        const suffix = Date.now();
        const batchName = `_batch_no_audit_${suffix}`;

        try {
            await appendSecurityAuditEvent(pool, {
                eventType: 'xyz_security_enabled_probe',
                userId: SEED.adminUser.id,
                newValue: { source: 'security_writer' },
            });
            const [[enabledAudit]] = await pool.query(
                "SELECT COUNT(*) AS total FROM audit_events WHERE user_id = ? AND event_type = 'xyz_security_enabled_probe'",
                [SEED.adminUser.id]
            );
            expect(Number(enabledAudit.total)).toBe(1);

            await pool.query('UPDATE users SET xyz = 1 WHERE id = ?', [SEED.cashierUser.id]);
            await appendAuditEvent(pool, {
                eventType: 'xyz_manager_probe',
                userId: SEED.adminUser.id,
                managerId: SEED.cashierUser.id,
            });
            const [[managerAudit]] = await pool.query(
                "SELECT COUNT(*) AS total FROM audit_events WHERE event_type = 'xyz_manager_probe'"
            );
            expect(Number(managerAudit.total)).toBe(0);
            await pool.query('UPDATE users SET xyz = 0 WHERE id = ?', [SEED.cashierUser.id]);

            await pool.query('UPDATE users SET xyz = 1 WHERE id = ?', [SEED.adminUser.id]);
            await appendAuditEvent(pool, {
                eventType: 'xyz_shared_probe',
                userId: SEED.adminUser.id,
                entityType: 'user',
                entityId: SEED.adminUser.id
            });
            await appendSecurityAuditEvent(pool, {
                eventType: 'xyz_security_probe',
                userId: SEED.adminUser.id,
                newValue: { source: 'security_writer' },
            });

            const res = await request(app).post('/api/admin/products/batch')
                .set('Cookie', adminCookie)
                .send({
                    category_id: SEED.category.id,
                    products: [{ name: batchName, price: '5.00', tax_rate: 0 }]
                });
            expect(res.statusCode).toBe(200);

            const [[product]] = await pool.query('SELECT id FROM products WHERE name = ?', [batchName]);
            const [[auditCount]] = await pool.query(
                `SELECT COUNT(*) AS total
                   FROM audit_events
                  WHERE user_id = ?
                    AND (event_type IN ('xyz_shared_probe', 'xyz_security_probe')
                         OR (event_type = 'product_created' AND entity_id = ?))`,
                [SEED.adminUser.id, product.id]
            );
            expect(Number(auditCount.total)).toBe(0);
        } finally {
            await pool.query('UPDATE users SET xyz = 0 WHERE id IN (?, ?)', [SEED.adminUser.id, SEED.cashierUser.id]);
            await pool.query('DELETE FROM products WHERE name = ?', [batchName]);
            await pool.query(
                "DELETE FROM audit_events WHERE event_type IN ('xyz_shared_probe', 'xyz_security_probe', 'xyz_security_enabled_probe', 'xyz_manager_probe')"
            );
        }
    });

    test('batch POST rejects duplicate rows without creating a partial batch', async () => {
        const suffix = Date.now();
        const firstName = `_batch_atomic_a_${suffix}`;
        const secondName = `_batch_atomic_b_${suffix}`;
        const duplicateBarcode = `batch-duplicate-${suffix}`;

        try {
            const res = await request(app).post('/api/admin/products/batch')
                .set('Cookie', adminCookie)
                .send({
                    category_id: SEED.category.id,
                    products: [
                        { name: firstName, price: '5.00', tax_rate: 0, barcode: duplicateBarcode },
                        { name: secondName, price: '6.00', tax_rate: 8, barcode: duplicateBarcode }
                    ]
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.success).toBe(false);
            const [[count]] = await pool.query(
                'SELECT COUNT(*) AS total FROM products WHERE name IN (?, ?)',
                [firstName, secondName]
            );
            expect(Number(count.total)).toBe(0);
        } finally {
            await pool.query('DELETE FROM products WHERE name IN (?, ?)', [firstName, secondName]);
        }
    });

    test('batch POST rejects invalid opening stock without creating earlier rows', async () => {
        const suffix = Date.now();
        const firstName = `_batch_valid_${suffix}`;
        const secondName = `_batch_bad_stock_${suffix}`;

        try {
            const res = await request(app).post('/api/admin/products/batch')
                .set('Cookie', adminCookie)
                .send({
                    category_id: SEED.category.id,
                    products: [
                        { name: firstName, price: '5.00', stock: 2 },
                        { name: secondName, price: '6.00', stock: -1 }
                    ]
                });

            expect(res.statusCode).toBe(400);
            const [[count]] = await pool.query(
                'SELECT COUNT(*) AS total FROM products WHERE name IN (?, ?)',
                [firstName, secondName]
            );
            expect(Number(count.total)).toBe(0);
        } finally {
            await pool.query('DELETE FROM products WHERE name IN (?, ?)', [firstName, secondName]);
        }
    });

    test('batch POST blocks an existing name only inside the selected category', async () => {
        const suffix = Date.now();
        const existingName = `_batch_existing_${suffix}`;
        const existing = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: existingName, price: '3.00', category_id: SEED.category.id });

        try {
            const res = await request(app).post('/api/admin/products/batch')
                .set('Cookie', adminCookie)
                .send({
                    category_id: SEED.category.id,
                    products: [{ name: existingName.toUpperCase(), price: '4.00' }]
                });

            expect(res.statusCode).toBe(409);
            const [[count]] = await pool.query(
                'SELECT COUNT(*) AS total FROM products WHERE LOWER(name) = LOWER(?) AND category_id = ?',
                [existingName, SEED.category.id]
            );
            expect(Number(count.total)).toBe(1);
        } finally {
            await pool.query('DELETE FROM products WHERE id = ?', [existing.body.id]);
        }
    });

    test('deleting a category uncategorizes its products', async () => {
        const cat = await request(app).post('/api/admin/categories')
            .set('Cookie', adminCookie).send({ name: '_doomed_cat' });
        const catId = cat.body.id;
        const prod = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie).send({ name: '_orphan', price: '1.00', category_id: catId });
        const prodId = prod.body.id;

        const del = await request(app).delete('/api/admin/categories')
            .set('Cookie', adminCookie).send({ id: catId });
        expect(del.body.success).toBe(true);

        const [[row]] = await pool.query('SELECT category_id FROM products WHERE id = ?', [prodId]);
        expect(row.category_id).toBeNull();

        await pool.query('DELETE FROM products WHERE id = ?', [prodId]);
        await pool.query('DELETE FROM categories WHERE id = ?', [catId]);
    });

    test('price-history keeps a row whose changed_by user no longer exists (LEFT JOIN)', async () => {
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie).send({ name: '_ph_orphan', price: '10.00' });
        const productId = create.body.id;
        try {
            // changed_by is NOT NULL, so use a ghost user id. INNER JOIN drops this row;
            // LEFT JOIN must keep it.
            const GHOST_USER = 90000001;
            await pool.query(
                'INSERT INTO price_history (product_id, old_price, new_price, changed_by) VALUES (?, ?, ?, ?)',
                [productId, 10, 12, GHOST_USER]
            );

            const res = await request(app).get(`/api/admin/audit/price-history?product_id=${productId}`)
                .set('Cookie', adminCookie);
            expect(res.body.success).toBe(true);
            expect(res.body.history.some(h => Number(h.product_id) === productId)).toBe(true);
        } finally {
            await pool.query('DELETE FROM price_history WHERE product_id = ?', [productId]);
            await pool.query('DELETE FROM products WHERE id = ?', [productId]);
        }
    });

    test('category PUT rejects an A->B->A cycle and keeps the tree unchanged', async () => {
        const a = await request(app).post('/api/admin/categories')
            .set('Cookie', adminCookie).send({ name: '_cycle_A' });
        const idA = a.body.id;
        const b = await request(app).post('/api/admin/categories')
            .set('Cookie', adminCookie).send({ name: '_cycle_B', parent_id: idA });
        const idB = b.body.id;
        try {
            const put = await request(app).put('/api/admin/categories')
                .set('Cookie', adminCookie).send({ id: idA, name: '_cycle_A', parent_id: idB });
            expect(put.statusCode).toBe(409);

            const [[row]] = await pool.query('SELECT parent_id FROM categories WHERE id = ?', [idA]);
            expect(row.parent_id).toBeNull();
        } finally {
            await pool.query('DELETE FROM categories WHERE id IN (?, ?)', [idB, idA]);
        }
    });

    test('category price-list roots and descendants inherit transactionally across mark, move, and unmark', async () => {
        const suffix = Date.now();
        const ids = [];
        try {
            const root = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_price_root_${suffix}`, is_price_list_root: true });
            expect(root.statusCode).toBe(200);
            ids.push(root.body.id);

            const child = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_price_child_${suffix}`, parent_id: root.body.id });
            const grandchild = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_price_grandchild_${suffix}`, parent_id: child.body.id });
            const ordinary = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_ordinary_${suffix}` });
            ids.push(child.body.id, grandchild.body.id, ordinary.body.id);

            const [initial] = await pool.query(
                'SELECT id, price_list_root_id FROM categories WHERE id IN (?, ?, ?) ORDER BY id',
                [root.body.id, child.body.id, grandchild.body.id]
            );
            expect(initial.every(row => Number(row.price_list_root_id) === Number(root.body.id))).toBe(true);

            const move = await request(app).put('/api/admin/categories').set('Cookie', adminCookie)
                .send({ id: child.body.id, name: `_price_child_${suffix}`, parent_id: ordinary.body.id, is_price_list_root: false });
            expect(move.statusCode).toBe(200);
            const [moved] = await pool.query('SELECT price_list_root_id FROM categories WHERE id IN (?, ?)', [child.body.id, grandchild.body.id]);
            expect(moved.every(row => row.price_list_root_id === null)).toBe(true);

            const unmark = await request(app).put('/api/admin/categories').set('Cookie', adminCookie)
                .send({ id: root.body.id, name: `_price_root_${suffix}`, parent_id: null, is_price_list_root: false });
            expect(unmark.statusCode).toBe(200);
            const [[unmarked]] = await pool.query('SELECT price_list_root_id FROM categories WHERE id = ?', [root.body.id]);
            expect(unmarked.price_list_root_id).toBeNull();

            const get = await request(app).get('/api/admin/categories').set('Cookie', adminCookie);
            expect(get.body.categories.find(row => Number(row.id) === Number(root.body.id))).toMatchObject({
                price_list_root_name: null,
                is_price_list_root: 0
            });
        } finally {
            await pool.query(`DELETE FROM categories WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`, ids.reverse());
        }
    });

    test('category root validation rejects notes roots, child roots, and invalid parents', async () => {
        const suffix = Date.now();
        const parent = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
            .send({ name: `_parent_${suffix}` });
        try {
            expect((await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_notes_root_${suffix}`, is_notes: true, is_price_list_root: true })).statusCode).toBe(400);
            expect((await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_child_root_${suffix}`, parent_id: parent.body.id, is_price_list_root: true })).statusCode).toBe(400);
            expect((await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_bad_parent_${suffix}`, parent_id: 99999999 })).statusCode).toBe(400);
        } finally {
            await pool.query('DELETE FROM categories WHERE id = ?', [parent.body.id]);
        }
    });

    test('catalog import preserves inherited price-list roots for imported descendants', async () => {
        const suffix = Date.now();
        const parentName = `_imported_price_parent_${suffix}`;
        const childName = `_imported_price_child_${suffix}`;
        await pool.query('UPDATE categories SET price_list_root_id = id WHERE id = ?', [SEED.category.id]);

        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([
            { Name: childName, 'Parent Category': parentName },
            { Name: parentName, 'Parent Category': SEED.category.name }
        ]), 'Categories');
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['Name', 'Price']]), 'Products');
        const file = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        try {
            const imported = await request(app)
                .post('/api/admin/import/catalog')
                .set('Cookie', adminCookie)
                .attach('file', file, { filename: 'catalog.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

            expect(imported.statusCode).toBe(200);
            expect(imported.body.success).toBe(true);
            const [importedCategories] = await pool.query(
                'SELECT name, parent_id, price_list_root_id FROM categories WHERE name IN (?, ?)',
                [parentName, childName]
            );
            const byName = new Map(importedCategories.map(category => [category.name, category]));
            expect(Number(byName.get(parentName).parent_id)).toBe(SEED.category.id);
            expect(Number(byName.get(childName).parent_id)).toBeGreaterThan(0);
            expect(importedCategories.every(category => Number(category.price_list_root_id) === SEED.category.id)).toBe(true);
        } finally {
            await pool.query('DELETE FROM categories WHERE name IN (?, ?)', [childName, parentName]);
            await pool.query('UPDATE categories SET price_list_root_id = NULL WHERE id = ?', [SEED.category.id]);
        }
    });

    test('catalog import rejects category parent cycles without leaving rows behind', async () => {
        const suffix = Date.now();
        const firstName = `_import_cycle_a_${suffix}`;
        const secondName = `_import_cycle_b_${suffix}`;
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([
            { Name: firstName, 'Parent Category': secondName },
            { Name: secondName, 'Parent Category': firstName }
        ]), 'Categories');
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['Name', 'Price']]), 'Products');
        const file = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        const imported = await request(app)
            .post('/api/admin/import/catalog')
            .set('Cookie', adminCookie)
            .attach('file', file, { filename: 'catalog.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

        expect(imported.statusCode).toBe(200);
        expect(imported.body.success).toBe(false);
        expect(imported.body.errors.some(error => error.includes('would create a cycle'))).toBe(true);
        const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM categories WHERE name IN (?, ?)', [firstName, secondName]);
        expect(Number(count)).toBe(0);
    });

    test('catalog import identifies a stale service-charge JoFotara category', async () => {
        const [before] = await pool.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('jofotara_enabled','tax_registration_type','service_charge_enabled','service_charge_tax_rate','service_charge_jofotara_tax_category')"
        );
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['Name']]), 'Categories');
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['Name', 'Price', 'Tax Rate']]), 'Products');
        const file = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        try {
            await pool.query(`UPDATE settings SET setting_value = CASE setting_key
                WHEN 'jofotara_enabled' THEN '1'
                WHEN 'tax_registration_type' THEN 'sales_tax'
                WHEN 'service_charge_enabled' THEN '1'
                WHEN 'service_charge_tax_rate' THEN '8'
                WHEN 'service_charge_jofotara_tax_category' THEN 'O'
                ELSE setting_value END
                WHERE setting_key IN ('jofotara_enabled','tax_registration_type','service_charge_enabled','service_charge_tax_rate','service_charge_jofotara_tax_category')`);

            const response = await request(app)
                .post('/api/admin/import/catalog')
                .set('Cookie', adminCookie)
                .attach('file', file, { filename: 'catalog.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

            expect(response.statusCode).toBe(409);
            expect(response.body).toMatchObject({
                success: false,
                code: 'JOFOTARA_INVALID_TAX_CATEGORY'
            });
            expect(response.body.message).toContain('Service charge configuration');
        } finally {
            for (const row of before) {
                await pool.query('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [row.setting_value, row.setting_key]);
            }
        }
    });

    test('catalog import maps a headerless legacy workbook and preserves selling prices', async () => {
        const suffix = Date.now();
        const categoryA = `_legacy_sandwiches_${suffix}`;
        const categoryB = `_legacy_grill_${suffix}`;
        const productNames = [`_legacy_a_${suffix}`, `_legacy_b_${suffix}`, `_legacy_c_${suffix}`];
        const row = (name, price, category, tax) => {
            const values = Array(8).fill('NULL');
            values[1] = category;
            values[2] = name;
            values[4] = price;
            values[5] = tax;
            return values;
        };
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([
            row(productNames[0], 11.6, categoryA, 0.16),
            row(productNames[1], 10.8, categoryA, 0.8),
            row(productNames[2], 10.4, categoryB, 0.04),
            Array(8).fill('NULL')
        ]), 'Legacy Export');
        const file = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        try {
            const invalidMapping = await request(app)
                .post('/api/admin/import/catalog')
                .set('Cookie', adminCookie)
                .field('mapping', JSON.stringify({ name: null, price: 4, category: 1, tax: 5 }))
                .attach('file', Buffer.from(file), { filename: 'legacy.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            expect(invalidMapping.statusCode).toBe(400);

            const imported = await request(app)
                .post('/api/admin/import/catalog')
                .set('Cookie', adminCookie)
                .field('mapping', JSON.stringify({ name: 2, price: 4, category: 1, tax: 5 }))
                .attach('file', file, { filename: 'legacy.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

            expect(imported.statusCode).toBe(200);
            expect(imported.body).toMatchObject({
                success: true,
                summary: { categories_imported: 2, products_imported: 3 }
            });
            const [products] = await pool.query(
                `SELECT p.name,p.price,p.tax_rate,c.name AS category_name
                   FROM products p JOIN categories c ON c.id=p.category_id
                  WHERE p.name IN (?, ?, ?) ORDER BY p.name`,
                productNames
            );
            const byName = new Map(products.map(product => [product.name, product]));
            expect(Number(byName.get(productNames[0]).tax_rate)).toBe(16);
            expect(Number(byName.get(productNames[0]).price)).toBeCloseTo(10, 4);
            expect(Number(byName.get(productNames[1]).tax_rate)).toBe(8);
            expect(Number(byName.get(productNames[1]).price)).toBeCloseTo(10, 4);
            expect(Number(byName.get(productNames[2]).tax_rate)).toBe(4);
            expect(Number(byName.get(productNames[2]).price)).toBeCloseTo(10, 4);
        } finally {
            await pool.query('DELETE FROM products WHERE name IN (?, ?, ?)', productNames);
            await pool.query('DELETE FROM categories WHERE name IN (?, ?)', [categoryA, categoryB]);
        }
    });

    test('catalog import preserves fractional stock', async () => {
        const suffix = Date.now();
        const categoryName = `_fractional_stock_category_${suffix}`;
        const productName = `_fractional_stock_product_${suffix}`;
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{ Name: categoryName }]), 'Categories');
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{
            Name: productName,
            Category: categoryName,
            Price: 10,
            Stock: 4.125
        }]), 'Products');

        try {
            const response = await request(app)
                .post('/api/admin/import/catalog')
                .set('Cookie', adminCookie)
                .attach('file', xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }), {
                    filename: 'fractional-stock.xlsx',
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                });

            expect(response.statusCode).toBe(200);
            const [[product]] = await pool.query('SELECT stock FROM products WHERE name=?', [productName]);
            expect(Number(product.stock)).toBe(4.125);
        } finally {
            await pool.query('DELETE FROM products WHERE name=?', [productName]);
            await pool.query('DELETE FROM categories WHERE name=?', [categoryName]);
        }
    });

    test('clearing the tax field (tax_rate: "") sets tax to 0 without re-stripping price', async () => {
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ name: '_taxclear_probe', price: '116.00', tax_rate: 16 }); // net 100 @ 16%
        const id = create.body.id;

        // Modal clears the Tax input: sends the gross price + an empty tax_rate.
        await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, name: '_taxclear_probe', price: '116.00', tax_rate: '' });

        const [[row]] = await pool.query('SELECT price, tax_rate FROM products WHERE id = ?', [id]);
        expect(Number(row.tax_rate)).toBe(0);
        expect(Number(row.price)).toBeCloseTo(116.00, 2); // tax 0 => price stored as-is, no strip

        await pool.query('DELETE FROM products WHERE id = ?', [id]);
    });

    test('product DELETE without an id returns 400 (not 500)', async () => {
        const res = await request(app).delete('/api/admin/products')
            .set('Cookie', adminCookie).send({});
        expect(res.statusCode).toBe(400);
    });

    test('POST/PUT canonicalize modifiers: ids assigned, preserved across rename, garbage rejected', async () => {
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({
                name: '_mod_ids_probe', price: '11.60', tax_rate: 16,
                modifiers: [{ name: 'Size', options: [{ name: 'Large', price: 2 }] }]
            });
        expect(create.body.success).toBe(true);
        const id = create.body.id;

        const [[row]] = await pool.query('SELECT modifiers FROM products WHERE id = ?', [id]);
        const stored = JSON.parse(row.modifiers);
        expect(stored[0].id).toMatch(/^[a-f0-9]{8}$/);
        expect(stored[0].options[0].id).toMatch(/^[a-f0-9]{8}$/);
        const gid = stored[0].id, oid = stored[0].options[0].id;

        // Rename option, echoing ids back (as ProductModal does) — ids must survive.
        stored[0].options[0].name = 'Extra Large';
        const put = await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, modifiers: stored });
        expect(put.body.success).toBe(true);
        const [[row2]] = await pool.query('SELECT modifiers FROM products WHERE id = ?', [id]);
        const stored2 = JSON.parse(row2.modifiers);
        expect(stored2[0].id).toBe(gid);
        expect(stored2[0].options[0].id).toBe(oid);
        expect(stored2[0].options[0].name).toBe('Extra Large');

        // Garbage shape → 400, stored blob untouched.
        const bad = await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, modifiers: [{ name: 'G', options: [{ name: 'a', price: 'NaN' }] }] });
        expect(bad.statusCode).toBe(400);
        const [[row3]] = await pool.query('SELECT modifiers FROM products WHERE id = ?', [id]);
        expect(JSON.parse(row3.modifiers)[0].options[0].name).toBe('Extra Large');

        await pool.query('DELETE FROM products WHERE id = ?', [id]);
    });

    test('catalog replacement refuses to destroy product recipes', async () => {
        const [ingredient] = await pool.query(`
            INSERT INTO ingredients
              (name, measure, display_unit, unit_cost, is_active)
            VALUES ('_recipe_guard_chicken', 'weight', 'kg', 0.0045, 1)
        `);
        await pool.query(
            'INSERT INTO product_recipe_lines (product_id, ingredient_id, qty_per_unit, sort_order) VALUES (?, ?, 200, 0)',
            [SEED.product1.id, ingredient.insertId]
        );
        try {
            const response = await request(app)
                .post('/api/admin/import/catalog')
                .set('Cookie', adminCookie)
                .field('mode', 'replace')
                .field('confirm_replace', '1')
                .attach('file', replacementWorkbook(Date.now()), { filename: 'replacement.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

            expect(response.statusCode).toBe(409);
            expect(response.body.message).toBe('Catalog replacement is blocked while product recipes exist. Clear recipes first.');
            const [[oldProduct]] = await pool.query('SELECT id FROM products WHERE id = ?', [SEED.product1.id]);
            expect(oldProduct.id).toBe(SEED.product1.id);
            const [[line]] = await pool.query('SELECT product_id FROM product_recipe_lines WHERE product_id = ?', [SEED.product1.id]);
            expect(Number(line.product_id)).toBe(SEED.product1.id);
        } finally {
            await pool.query('DELETE FROM product_recipe_lines WHERE product_id = ?', [SEED.product1.id]);
            await pool.query('DELETE FROM ingredients WHERE id = ?', [ingredient.insertId]);
        }
    });

    test('catalog replacement refuses while a purchase invoice or stock count references a product', async () => {
        const [supplier] = await pool.query("INSERT INTO purchase_suppliers (name) VALUES ('_import_guard_supplier')");
        const [document] = await pool.query(
            "INSERT INTO stock_documents (doc_type, item_kind, supplier_id, reference, doc_date, payment_status) VALUES ('purchase', 'product', ?, '_import_guard', '2026-09-30', 'paid')",
            [supplier.insertId]
        );
        await pool.query(
            "INSERT INTO stock_document_lines (document_id, line_no, product_id, qty, unit_label, unit_factor, unit_price) VALUES (?, 1, ?, 1, 'unit', 1, 1)",
            [document.insertId, SEED.product1.id]
        );
        try {
            const response = await request(app)
                .post('/api/admin/import/catalog')
                .set('Cookie', adminCookie)
                .field('mode', 'replace')
                .field('confirm_replace', '1')
                .attach('file', replacementWorkbook(Date.now()), { filename: 'replacement.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

            expect(response.statusCode).toBe(409);
            expect(response.body.message).toBe('Catalog replacement is blocked while purchase invoices or stock counts reference products.');
            const [[oldProduct]] = await pool.query('SELECT id FROM products WHERE id = ?', [SEED.product1.id]);
            expect(oldProduct.id).toBe(SEED.product1.id);
        } finally {
            await pool.query('DELETE FROM stock_documents WHERE id = ?', [document.insertId]);
            await pool.query('DELETE FROM purchase_suppliers WHERE id = ?', [supplier.insertId]);
        }
    });

    test('catalog replacement requires explicit destructive confirmation', async () => {
        const response = await request(app)
            .post('/api/admin/import/catalog')
            .set('Cookie', adminCookie)
            .field('mode', 'replace')
            .attach('file', replacementWorkbook(Date.now()), { filename: 'replacement.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

        expect(response.statusCode).toBe(400);
        const [[oldProduct]] = await pool.query('SELECT id FROM products WHERE id = ?', [SEED.product1.id]);
        expect(oldProduct.id).toBe(SEED.product1.id);
    });

    test('catalog replacement refuses to detach sales history or discard held carts', async () => {
        const suffix = Date.now();
        const invoiceId = await insertPaidOrder(pool);
        const orderItemId = await insertOrderItem(pool, { invoice_id: invoiceId, product_id: SEED.product1.id });
        const [[originalItem]] = await pool.query('SELECT product_id, item_name FROM order_items WHERE id=?', [orderItemId]);
        await pool.query(
            'INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal) VALUES (?, ?, ?, ?)',
            [SEED.cashierUser.id, `_replacement_hold_${suffix}`, JSON.stringify({ items: [{ product_id: SEED.product1.id }] }), 1]
        );

        const [[before]] = await pool.query(`SELECT
            (SELECT COUNT(*) FROM products) products,
            (SELECT COUNT(*) FROM categories) categories,
            (SELECT COUNT(*) FROM held_orders) held_orders`);
        const response = await request(app)
            .post('/api/admin/import/catalog')
            .set('Cookie', adminCookie)
            .field('mode', 'replace')
            .field('confirm_replace', '1')
            .attach('file', replacementWorkbook(suffix), { filename: 'replacement.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

        expect(response.statusCode, JSON.stringify(response.body)).toBe(409);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain('historical');

        const [[order]] = await pool.query('SELECT invoice_id FROM orders WHERE invoice_id = ?', [invoiceId]);
        const [[item]] = await pool.query('SELECT product_id, item_name FROM order_items WHERE id = ?', [orderItemId]);
        expect(order.invoice_id).toBe(invoiceId);
        expect(item.product_id).toBe(SEED.product1.id);
        expect(item).toEqual(originalItem);

        const [[catalog]] = await pool.query(`
            SELECT
              (SELECT COUNT(*) FROM products) AS products,
              (SELECT COUNT(*) FROM categories) AS categories,
              (SELECT COUNT(*) FROM held_orders) AS held_orders
        `);
        expect(catalog).toEqual(before);
        const [audits] = await pool.query("SELECT id FROM audit_events WHERE event_type='catalog_replaced'");
        expect(audits).toHaveLength(0);
        await pool.query('DELETE FROM orders WHERE invoice_id=?', [invoiceId]);
    });

    test('catalog replacement replaces unused catalog data after explicit confirmation', async () => {
        const response = await request(app).post('/api/admin/import/catalog').set('Cookie', adminCookie)
            .field('mode','replace').field('confirm_replace','1')
            .attach('file',replacementWorkbook(Date.now()),{filename:'replacement.xlsx',contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
        expect(response.statusCode,JSON.stringify(response.body)).toBe(200);
        expect(response.body).toMatchObject({success:true,summary:{products_imported:1,categories_imported:1}});
        expect(Number(response.body.summary.products_removed)).toBeGreaterThan(0);
        expect(Number(response.body.summary.categories_removed)).toBeGreaterThan(0);
        const [[catalog]] = await pool.query(`SELECT
            (SELECT COUNT(*) FROM products) products,
            (SELECT COUNT(*) FROM categories) categories,
            (SELECT COUNT(*) FROM held_orders) held_orders`);
        expect(Number(catalog.products)).toBe(1);
        expect(Number(catalog.categories)).toBe(1);
        expect(Number(catalog.held_orders)).toBe(0);

        const [[audit]] = await pool.query("SELECT id FROM audit_events WHERE event_type='catalog_replaced' ORDER BY id DESC LIMIT 1");
        expect(audit.id).toBeGreaterThan(0);
    });
});
