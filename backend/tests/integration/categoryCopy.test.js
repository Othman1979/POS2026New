const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('admin category tree copy', () => {
    let adminCookie;

    beforeAll(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];
    });

    afterAll(async () => pool.end());

    it('copies a complete tree into a destination root with independent products and bundle links', async () => {
        const suffix = Date.now();
        const categoryIds = [];
        const productIds = [];
        let printerId;
        try {
            const source = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_copy_source_${suffix}` });
            const child = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_copy_child_${suffix}`, parent_id: source.body.id });
            const target = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_copy_target_${suffix}`, is_price_list_root: true });
            categoryIds.push(source.body.id, child.body.id, target.body.id);

            const [printer] = await pool.query(
                "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES (?, 'kitchen', 'windows', ?, ?)",
                [`_copy_printer_${suffix}`, `_copy_printer_${suffix}`, `_copy_spooler_${suffix}`]
            );
            printerId = printer.insertId;
            await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)', [printerId, child.body.id]);

            const [bundle] = await pool.query(
                `INSERT INTO products
                 (category_id, barcode, sku, name, price, cost_price, modifiers, tax_rate, image, color, stock,
                  min_stock_level, max_stock_level, show_in_grid, is_bundle, background_color, is_active, is_available, price_override_locked)
                 VALUES (?, ?, ?, ?, 2.500000, 1.25, ?, 8, 'copy.png', 'bg-red-500', NULL, 3, 50, 0, 1, '#112233', 0, 0, 1)`,
                [source.body.id, `_copy_barcode_${suffix}`, `_copy_sku_${suffix}`, `_copy_bundle_${suffix}`, JSON.stringify([{ name: 'Size', options: [{ name: 'L', price: 1 }] }])]
            );
            const [internal] = await pool.query(
                'INSERT INTO products (category_id, barcode, sku, name, price, stock, is_bundle) VALUES (?, ?, ?, ?, 1.000000, 7, 0)',
                [child.body.id, `_copy_child_barcode_${suffix}`, `_copy_child_sku_${suffix}`, `_copy_internal_${suffix}`]
            );
            const [external] = await pool.query(
                'INSERT INTO products (category_id, name, price, stock, is_bundle) VALUES (?, ?, 3.000000, 4, 0)',
                [SEED.category.id, `_copy_external_${suffix}`]
            );
            productIds.push(bundle.insertId, internal.insertId, external.insertId);
            await pool.query('INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)', [internal.insertId, `_copy_extra_${suffix}`]);
            await pool.query(
                'INSERT INTO product_bundle_items (bundle_id, product_id, qty, sort_order) VALUES (?, ?, 2, 1), (?, ?, 1, 2)',
                [bundle.insertId, internal.insertId, bundle.insertId, external.insertId]
            );

            const response = await request(app).post(`/api/admin/categories/${source.body.id}/copy`)
                .set('Cookie', adminCookie)
                .send({ target_parent_id: target.body.id, name: `_copy_renamed_${suffix}` });

            expect(response.statusCode).toBe(200);
            expect(response.body).toMatchObject({ success: true, categories_copied: 2, products_copied: 2 });
            categoryIds.push(response.body.root_category_id);

            const [copiedCategories] = await pool.query(
                `SELECT id, parent_id, name, price_list_root_id FROM categories
                  WHERE id = ? OR parent_id = ? ORDER BY parent_id, id`,
                [response.body.root_category_id, response.body.root_category_id]
            );
            categoryIds.push(...copiedCategories.slice(1).map(row => Number(row.id)));
            expect(copiedCategories.map(row => row.name)).toEqual([`_copy_renamed_${suffix}`, `_copy_child_${suffix}`]);
            expect(copiedCategories.every(row => Number(row.price_list_root_id) === Number(target.body.id))).toBe(true);

            const [copiedProducts] = await pool.query(
                `SELECT * FROM products WHERE category_id IN (?, ?) ORDER BY name`,
                [copiedCategories[0].id, copiedCategories[1].id]
            );
            productIds.push(...copiedProducts.map(row => Number(row.id)));
            expect(copiedProducts).toHaveLength(2);
            expect(copiedProducts.every(row => row.barcode === null && row.sku === null)).toBe(true);
            // Extra barcodes stay with their product: the copy has none, so no code is ever held twice.
            const [extras] = await pool.query('SELECT product_id FROM product_barcodes WHERE barcode = ?', [`_copy_extra_${suffix}`]);
            expect(extras.map(row => Number(row.product_id))).toEqual([internal.insertId]);
            expect((await pool.query('SELECT 1 FROM product_barcodes WHERE product_id IN (?, ?)', copiedProducts.map(row => row.id)))[0]).toHaveLength(0);
            expect(copiedProducts.find(row => row.name === `_copy_bundle_${suffix}`).stock).toBeNull();
            expect(Number(copiedProducts.find(row => row.name === `_copy_internal_${suffix}`).stock)).toBe(0);
            expect(copiedProducts.find(row => row.name === `_copy_bundle_${suffix}`)).toMatchObject({
                image: 'copy.png', color: 'bg-red-500', background_color: '#112233'
            });
            expect(Number(copiedProducts.find(row => row.name === `_copy_bundle_${suffix}`).price_override_locked)).toBe(1);
            expect(Number(copiedProducts.find(row => row.name === `_copy_internal_${suffix}`).price_override_locked)).toBe(0);

            const copiedBundle = copiedProducts.find(row => row.name === `_copy_bundle_${suffix}`);
            const copiedInternal = copiedProducts.find(row => row.name === `_copy_internal_${suffix}`);
            const [links] = await pool.query('SELECT product_id, qty, sort_order FROM product_bundle_items WHERE bundle_id = ? ORDER BY sort_order', [copiedBundle.id]);
            expect(links.map(row => Number(row.product_id))).toEqual([Number(copiedInternal.id), Number(external.insertId)]);

            const [[mapping]] = await pool.query('SELECT COUNT(*) AS total FROM printer_categories WHERE printer_id = ? AND category_id = ?', [printerId, copiedCategories[1].id]);
            expect(Number(mapping.total)).toBe(1);
            const [[overrideCount]] = await pool.query('SELECT COUNT(*) AS total FROM product_price_overrides WHERE product_id IN (?, ?)', [copiedBundle.id, copiedInternal.id]);
            expect(Number(overrideCount.total)).toBe(0);
            const [[audit]] = await pool.query("SELECT new_value FROM audit_events WHERE event_type = 'category_tree_copied' AND entity_id = ?", [response.body.root_category_id]);
            expect(JSON.parse(audit.new_value)).toMatchObject({ source_category_id: source.body.id, target_parent_id: target.body.id, categories_copied: 2, products_copied: 2 });
        } finally {
            if (productIds.length) {
                await pool.query(`DELETE FROM product_bundle_items WHERE bundle_id IN (${productIds.map(() => '?').join(',')})`, productIds);
                await pool.query(`DELETE FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`, productIds);
            }
            if (printerId) await pool.query('DELETE FROM printers WHERE id = ?', [printerId]);
            if (categoryIds.length) {
                await pool.query(`DELETE FROM audit_events WHERE entity_type = 'category' AND entity_id IN (${categoryIds.map(() => '?').join(',')})`, categoryIds);
                for (const id of [...new Set(categoryIds)].reverse()) await pool.query('DELETE FROM categories WHERE id = ?', [id]);
            }
        }
    });

    it('copies product recipe lines onto the new product ids', async () => {
        const suffix = Date.now();
        const categoryIds = [];
        const productIds = [];
        let ingredientId;
        try {
            const source = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_recipe_source_${suffix}` });
            const target = await request(app).post('/api/admin/categories').set('Cookie', adminCookie)
                .send({ name: `_recipe_target_${suffix}`, is_price_list_root: true });
            categoryIds.push(source.body.id, target.body.id);

            const [product] = await pool.query(
                'INSERT INTO products (category_id, name, price, stock, is_bundle) VALUES (?, ?, 5.000000, NULL, 0)',
                [source.body.id, `_recipe_burger_${suffix}`]
            );
            productIds.push(product.insertId);
            const [ingredient] = await pool.query(`
                INSERT INTO ingredients
                  (name, measure, display_unit, unit_cost, par_qty, pack_name, pack_size, is_active)
                VALUES (?, 'weight', 'kg', 0.0045, 5000, 'sack', 10000, 1)
            `, [`_recipe_chicken_${suffix}`]);
            ingredientId = ingredient.insertId;
            await pool.query(
                'INSERT INTO product_recipe_lines (product_id, ingredient_id, qty_per_unit, yield_pct, sort_order) VALUES (?, ?, 200, 80, 3)',
                [product.insertId, ingredientId]
            );

            const response = await request(app).post(`/api/admin/categories/${source.body.id}/copy`)
                .set('Cookie', adminCookie)
                .send({ target_parent_id: target.body.id, name: `_recipe_copied_${suffix}` });

            expect(response.statusCode).toBe(200);
            categoryIds.push(response.body.root_category_id);
            const [copiedProducts] = await pool.query(
                'SELECT id FROM products WHERE category_id = ? AND name = ?',
                [response.body.root_category_id, `_recipe_burger_${suffix}`]
            );
            expect(copiedProducts).toHaveLength(1);
            const copiedId = Number(copiedProducts[0].id);
            productIds.push(copiedId);
            expect(copiedId).not.toBe(Number(product.insertId));

            const [copiedLines] = await pool.query(
                'SELECT product_id, ingredient_id, qty_per_unit, yield_pct, sort_order FROM product_recipe_lines WHERE product_id = ?',
                [copiedId]
            );
            expect(copiedLines).toHaveLength(1);
            expect(Number(copiedLines[0].ingredient_id)).toBe(ingredientId);
            expect(Number(copiedLines[0].qty_per_unit)).toBe(200);
            expect(Number(copiedLines[0].yield_pct)).toBe(80);
            expect(Number(copiedLines[0].sort_order)).toBe(3);
        } finally {
            if (productIds.length) {
                await pool.query(
                    `DELETE FROM product_recipe_lines WHERE product_id IN (${productIds.map(() => '?').join(',')})`,
                    productIds
                );
                await pool.query(`DELETE FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`, productIds);
            }
            if (ingredientId) await pool.query('DELETE FROM ingredients WHERE id = ?', [ingredientId]);
            if (categoryIds.length) {
                await pool.query(`DELETE FROM audit_events WHERE entity_type = 'category' AND entity_id IN (${categoryIds.map(() => '?').join(',')})`, categoryIds);
                for (const id of [...new Set(categoryIds)].reverse()) await pool.query('DELETE FROM categories WHERE id = ?', [id]);
            }
        }
    });

    it('rejects a destination inside the source subtree without copying rows', async () => {
        const suffix = Date.now();
        const source = await request(app).post('/api/admin/categories').set('Cookie', adminCookie).send({ name: `_copy_cycle_${suffix}` });
        const child = await request(app).post('/api/admin/categories').set('Cookie', adminCookie).send({ name: `_copy_cycle_child_${suffix}`, parent_id: source.body.id });
        try {
            const [[before]] = await pool.query('SELECT COUNT(*) AS total FROM categories');
            const response = await request(app).post(`/api/admin/categories/${source.body.id}/copy`)
                .set('Cookie', adminCookie).send({ target_parent_id: child.body.id });
            expect(response.statusCode).toBe(409);
            const [[after]] = await pool.query('SELECT COUNT(*) AS total FROM categories');
            expect(Number(after.total)).toBe(Number(before.total));
        } finally {
            await pool.query('DELETE FROM categories WHERE id IN (?, ?)', [child.body.id, source.body.id]);
        }
    });
});
