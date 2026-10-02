const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const items = require('../../services/StockDocumentItems');
const posting = require('../../services/StockDocumentPosting');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const migrations = require('../../migrations/auto-manifest.json');

// The shared header/line tables, the item universe every stock document draws from, and the
// simple-stock / never-activated effects of a purchase post.
describe('stock documents', () => {
    let cookie, supplier, drinks, notes;
    const p = {};
    const key = () => randomUUID();
    const api = (method, path) => request(app)[method](`/api/admin/purchases${path}`).set('Cookie', cookie);
    const flags = (stock, recipes) => pool.query(
        "UPDATE settings SET setting_value=? WHERE setting_key='stock_enabled'", [stock]).then(() => pool.query(
        "UPDATE settings SET setting_value=? WHERE setting_key='recipe_ledger_enabled'", [recipes]));
    const product = async (name, { stock = 10, category = drinks, bundle = 0, active = 1 } = {}) => {
        const [row] = await pool.query('INSERT INTO products(name,price,stock,category_id,is_bundle,is_active) VALUES (?,1,?,?,?,?)', [name, stock, category, bundle, active]);
        return row.insertId;
    };
    const stockItem = async (name) => {
        const [row] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES (?,'count','unit','active')", [name]);
        await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) VALUES (?,20,1)', [row.insertId]);
        return row.insertId;
    };
    const link = (productId, itemId, qty = 1) => pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,?)', [productId, itemId, qty]);
    const line = (itemKey, qty = 2, extra = {}) => ({ item_key: itemKey, qty, unit_label: 'box', unit_factor: 6, unit_price: 3, tax_rate: 0, ...extra });
    // An invoice holds one kind; unless a test says otherwise it is the kind of its first line.
    const draft = async (lines, kind = lines[0].item_key.startsWith('ingredient:') ? 'ingredient' : 'product') => {
        const res = await api('post', '/invoices').send({
            client_key: key(), kind, supplier_id: supplier.id, supplier_invoice_no: `SD-${randomUUID().slice(0, 8)}`,
            invoice_date: '2026-09-29', payment_status: 'credit', lines,
        });
        return res;
    };
    const post = (invoice, requestKey = key()) => api('post', `/invoices/${invoice.id}/post`).send({ expected_version: invoice.version, request_key: requestKey });
    const reverse = (id, requestKey = key()) => api('post', `/invoices/${id}/reverse`).send({ request_key: requestKey });
    const simple = async (id) => {
        const [[row]] = await pool.query('SELECT CAST(stock AS CHAR) AS stock, CAST(stock_version AS CHAR) AS version FROM products WHERE id=?', [id]);
        return { stock: Number(row.stock), version: Number(row.version) };
    };
    const keys = (rows) => rows.map((row) => row.item_key);

    beforeAll(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await flags('1', '1');
        drinks = (await pool.query("INSERT INTO categories(name,is_notes) VALUES ('SD drinks',0)"))[0].insertId;
        notes = (await pool.query("INSERT INTO categories(name,is_notes) VALUES ('SD notes',1)"))[0].insertId;
        p.simple = await product('SD simple');
        p.unlimited = await product('SD unlimited', { stock: null });
        p.bundle = await product('SD bundle', { bundle: 1 });
        p.recipe = await product('SD recipe');
        p.composite = await product('SD composite');
        p.sharedA = await product('SD shared A');
        p.sharedB = await product('SD shared B');
        p.linked = await product('SD linked');
        p.note = await product('SD note', { category: notes });
        p.inactive = await product('SD inactive', { active: 0 });
        const ingredient = async (name, active = 1) => (await pool.query(
            "INSERT INTO ingredients(name,measure,display_unit,pack_name,pack_size,is_active) VALUES (?,'weight','g','Sack',25000,?)", [name, active]))[0].insertId;
        p.flour = await ingredient('SD flour');
        p.retired = await ingredient('SD retired', 0);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,5)', [p.recipe, p.flour]);
        await link(p.composite, await stockItem('SD part one'));
        await link(p.composite, await stockItem('SD part two'));
        const shared = await stockItem('SD shared item');
        await link(p.sharedA, shared);
        await link(p.sharedB, shared);
        await link(p.linked, await stockItem('SD linked item'));
        supplier = (await api('post', '/suppliers').send({ name: 'SD supplier' })).body.data;
    });
    afterAll(() => pool.end());

    describe('item universe', () => {
        it('offers simple, linked and never-activated items, and nothing else', async () => {
            const found = await items.searchItems(pool, { q: 'SD ', limit: 50 });
            expect(keys(found).sort()).toEqual([`ingredient:${p.flour}`, `product:${p.linked}`, `product:${p.simple}`].sort());
            const byKey = new Map(found.map((row) => [row.item_key, row]));
            expect(byKey.get(`product:${p.simple}`)).toMatchObject({ kind: 'product', mode: 'simple', base_unit: 'unit', category_id: drinks, category_name: 'SD drinks' });
            expect(byKey.get(`product:${p.linked}`)).toMatchObject({ kind: 'product', mode: 'ledger' });
            expect(byKey.get(`ingredient:${p.flour}`)).toMatchObject({ kind: 'ingredient', mode: 'ledger', base_unit: 'g', pack_name: 'Sack', pack_size: 25000, category_id: null });
        });

        it('finds products by category and barcode only, and respects the result limit', async () => {
            expect(keys(await items.searchItems(pool, { categoryId: drinks, limit: 50 })).sort())
                .toEqual([`product:${p.linked}`, `product:${p.simple}`].sort());
            await pool.query("UPDATE products SET barcode='6281999000011' WHERE id=?", [p.simple]);
            expect(keys(await items.searchItems(pool, { barcode: '6281999000011', limit: 5 }))).toEqual([`product:${p.simple}`]);
            expect(await items.searchItems(pool, { q: 'SD ', limit: 1 })).toHaveLength(1);
        });

        it('follows the stock and recipe-ledger settings', async () => {
            try {
                await flags('0', '1');
                expect(keys(await items.searchItems(pool, { q: 'SD ', limit: 50 }))).toEqual([`ingredient:${p.flour}`]);
                await flags('1', '0');
                expect(keys(await items.searchItems(pool, { q: 'SD ', limit: 50 })).sort()).toEqual([`product:${p.linked}`, `product:${p.simple}`].sort());
                expect(await items.listGroups(pool)).toEqual([expect.objectContaining({ kind: 'category' })]);
            } finally {
                await flags('1', '1');
            }
        });

        it('lists count groups: one per category with eligible products, plus ingredients', async () => {
            const groups = await items.listGroups(pool);
            expect(groups).toContainEqual({ group_key: `category:${drinks}`, kind: 'category', category_id: drinks, label: 'SD drinks', item_count: 2 });
            expect(groups.some((group) => group.category_id === notes)).toBe(false);
            expect(groups.find((group) => group.group_key === 'ingredients')).toMatchObject({ kind: 'ingredients', item_count: expect.any(Number) });
        });

        it('builds and parses item keys strictly', () => {
            expect(items.formatKey('product', 7)).toBe('product:7');
            expect(items.parseKey('ingredient:12')).toEqual({ kind: 'ingredient', id: 12 });
            for (const bad of ['product:0', 'product:01', 'stock:1', '12', 'product:', null, 'product:1 ']) expect(items.parseKey(bad)).toBeNull();
        });

        it('locks and resolves current quantities, and refuses composite, shared and untracked items', async () => {
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const held = await items.resolveForUpdate(conn, [`product:${p.simple}`, `product:${p.linked}`, `ingredient:${p.flour}`]);
                expect(held.items.get(`product:${p.simple}`)).toMatchObject({ mode: 'simple', quantity: '10.000000', quantity_known: true, stock_item_id: null, stock_version: '0' });
                expect(held.items.get(`product:${p.linked}`)).toMatchObject({ mode: 'ledger', quantity: '20.000000', quantity_known: true, stock_item_id: expect.any(String) });
                expect(held.items.get(`ingredient:${p.flour}`)).toMatchObject({ mode: 'ledger', base_unit: 'g', quantity_known: false, stock_item_id: null });
                expect(held.productRows).toHaveLength(2);
                expect(held.links).toHaveLength(1);
                // Tills must hear about simple products too; only linked items name a stock item.
                expect(posting.eventScope(held)).toEqual({
                    productIds: [p.simple, p.linked], ingredientIds: [p.flour], stockItemIds: [held.links[0].stock_item_id],
                    hasProducts: true, hasIngredients: true,
                });
                const refused = async (itemKey) => {
                    try { await items.resolveForUpdate(conn, [itemKey]); } catch (error) { return error.code; }
                    return 'accepted';
                };
                expect(await refused(`product:${p.composite}`)).toBe('PURCHASE_ITEM_UNSUPPORTED');
                expect(await refused(`product:${p.sharedA}`)).toBe('PURCHASE_ITEM_UNSUPPORTED');
                for (const id of [p.unlimited, p.bundle, p.recipe, p.note, p.inactive]) expect(await refused(`product:${id}`)).toBe('PURCHASE_ITEM_INVALID');
                expect(await refused(`ingredient:${p.retired}`)).toBe('PURCHASE_ITEM_INVALID');
                expect(await refused('product:999999')).toBe('PURCHASE_ITEM_INVALID');
            } finally {
                await conn.rollback();
                conn.release();
            }
        });

        it('refuses ineligible items when a draft is saved', async () => {
            for (const id of [p.bundle, p.recipe, p.composite, p.sharedA, p.note, p.inactive]) {
                const res = await draft([line(`product:${id}`)]);
                expect(res.status, String(id)).toBe(400);
                expect(res.body.code).toBe('PURCHASE_ITEM_INVALID');
            }
            expect((await draft([line(`ingredient:${p.retired}`)])).body.code).toBe('PURCHASE_ITEM_INVALID');
        });
    });

    describe('item universe by use', () => {
        const found = (use, query = {}) => items.searchItems(pool, { q: 'SD ', limit: 50, use, ...query });

        it('counts list tracked products and ingredients, and never an unlimited product', async () => {
            // The default is the count rule, so callers that never name a use cannot be widened by accident.
            expect(keys(await items.searchItems(pool, { q: 'SD ', limit: 50 })).sort()).toEqual(keys(await found('count')).sort());
            expect(keys(await found('count'))).not.toContain(`product:${p.unlimited}`);
            expect(await items.eligibleKeys(pool, [`product:${p.unlimited}`, `product:${p.simple}`], { use: 'count' })).toEqual(new Set([`product:${p.simple}`]));
            expect(await items.eligibleKeys(pool, [`product:${p.unlimited}`])).toEqual(new Set());
            const groups = await items.listGroups(pool, { use: 'count' });
            expect(groups).toContainEqual({ group_key: `category:${drinks}`, kind: 'category', category_id: drinks, label: 'SD drinks', item_count: 2 });
        });

        it('product purchases list every product that can carry stock, unlimited ones included, and no ingredient', async () => {
            const list = await found('product_purchase');
            expect(keys(list).sort()).toEqual([`product:${p.linked}`, `product:${p.simple}`, `product:${p.unlimited}`].sort());
            const byKey = new Map(list.map((row) => [row.item_key, row]));
            // Only a simple product whose stock is unlimited starts tracking when received.
            expect(byKey.get(`product:${p.unlimited}`)).toMatchObject({ kind: 'product', mode: 'simple', starts_tracking: true });
            expect(byKey.get(`product:${p.simple}`)).toMatchObject({ mode: 'simple', starts_tracking: false });
            expect(byKey.get(`product:${p.linked}`)).toMatchObject({ mode: 'ledger', starts_tracking: false });
            // The other rules still hold: bundles, recipes, notes, inactive, composite and shared links.
            for (const id of [p.bundle, p.recipe, p.note, p.inactive, p.composite, p.sharedA, p.sharedB]) expect(keys(list)).not.toContain(`product:${id}`);
            expect(keys(await found('product_purchase', { categoryId: drinks })).sort()).toEqual(keys(list).sort());
            const groups = await items.listGroups(pool, { use: 'product_purchase' });
            expect(groups).toContainEqual({ group_key: `category:${drinks}`, kind: 'category', category_id: drinks, label: 'SD drinks', item_count: 3 });
            // A purchase filters by category only: no "other" group and no ingredients group.
            expect(groups.every((group) => group.kind === 'category')).toBe(true);
        });

        it('ingredient purchases list active ingredients only', async () => {
            const list = await found('ingredient_purchase');
            expect(keys(list)).toEqual([`ingredient:${p.flour}`]);
            expect(list[0]).toMatchObject({ kind: 'ingredient', starts_tracking: false });
            expect(await found('ingredient_purchase', { categoryId: drinks })).toEqual([]);
            expect(await items.eligibleKeys(pool, [`ingredient:${p.flour}`, `product:${p.simple}`], { use: 'ingredient_purchase' })).toEqual(new Set([`ingredient:${p.flour}`]));
            expect(await items.eligibleKeys(pool, [`ingredient:${p.flour}`, `product:${p.simple}`], { use: 'product_purchase' })).toEqual(new Set([`product:${p.simple}`]));
            expect((await items.listGroups(pool, { use: 'ingredient_purchase' })).map((group) => group.group_key)).toEqual(['ingredients']);
        });

        it('follows the settings switch of each kind', async () => {
            try {
                await flags('0', '1');
                expect(await found('product_purchase')).toEqual([]);
                expect(keys(await found('ingredient_purchase'))).toEqual([`ingredient:${p.flour}`]);
                await flags('1', '0');
                expect(await found('ingredient_purchase')).toEqual([]);
                expect(keys(await found('product_purchase'))).toContain(`product:${p.unlimited}`);
            } finally {
                await flags('1', '1');
            }
        });

        it('locks an unlimited product for a purchase with an unknown quantity, and refuses it for a count', async () => {
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const held = await items.resolveForUpdate(conn, [`product:${p.unlimited}`], { use: 'product_purchase' });
                expect(held.items.get(`product:${p.unlimited}`)).toMatchObject({ mode: 'simple', quantity: null, quantity_known: false, stock_item_id: null });
                await expect(items.resolveForUpdate(conn, [`product:${p.unlimited}`])).rejects.toMatchObject({ code: 'PURCHASE_ITEM_INVALID' });
                // An item of the other kind is not eligible for the use, even though it is a fine item elsewhere.
                await expect(items.resolveForUpdate(conn, [`ingredient:${p.flour}`], { use: 'product_purchase' })).rejects.toMatchObject({ code: 'PURCHASE_ITEM_INVALID' });
                await expect(items.resolveForUpdate(conn, [`product:${p.simple}`], { use: 'ingredient_purchase' })).rejects.toMatchObject({ code: 'PURCHASE_ITEM_INVALID' });
                await expect(items.resolveForUpdate(conn, [`product:${p.simple}`], { use: 'nonsense' })).rejects.toThrow(/Unknown stock document use/);
            } finally {
                await conn.rollback();
                conn.release();
            }
        });
    });

    describe('posting', () => {
        it('receives a simple-stock product: stock, version and one journal row, and replays by key', async () => {
            const before = await simple(p.simple);
            const created = await draft([line(`product:${p.simple}`, 2, { unit_factor: 6 })]);
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const requestKey = key();
            const first = await post(created.body.data, requestKey);
            expect(first.status, JSON.stringify(first.body)).toBe(200);
            expect(await simple(p.simple)).toEqual({ stock: before.stock + 12, version: before.version + 1 });
            const [operations] = await pool.query("SELECT kind, legacy_product_id, result_json FROM stock_operations WHERE request_key=?", [`sdoc-${requestKey}`]);
            expect(operations).toHaveLength(1);
            expect(operations[0]).toMatchObject({ kind: 'receipt', legacy_product_id: null });
            const saved = typeof operations[0].result_json === 'string' ? JSON.parse(operations[0].result_json) : operations[0].result_json;
            expect(saved.products).toEqual([{ product_id: p.simple, qty: '12.000000', before: '10.000000', after: '22.000000' }]);
            const retry = await post(created.body.data, requestKey);
            expect(retry.status).toBe(200);
            expect(await simple(p.simple)).toEqual({ stock: before.stock + 12, version: before.version + 1 });
            expect((await pool.query("SELECT id FROM stock_operations WHERE request_key=?", [`sdoc-${requestKey}`]))[0]).toHaveLength(1);
        });

        it('reverses a simple-stock receipt, and refuses when it would go below zero', async () => {
            const created = await draft([line(`product:${p.simple}`, 1, { unit_factor: 5 })]);
            const posted = await post(created.body.data);
            expect(posted.status).toBe(200);
            const afterPost = await simple(p.simple);
            await pool.query('UPDATE products SET stock=2 WHERE id=?', [p.simple]);
            const blocked = await reverse(posted.body.data.id);
            expect(blocked.status).toBe(409);
            expect(blocked.body.code).toBe('PURCHASE_INVOICE_REVERSE_BLOCKED');
            expect((await simple(p.simple)).stock).toBe(2);
            expect((await api('get', `/invoices/${posted.body.data.id}`)).body.data.status).toBe('posted');
            await pool.query('UPDATE products SET stock=? WHERE id=?', [afterPost.stock, p.simple]);
            const requestKey = key();
            const back = await reverse(posted.body.data.id, requestKey);
            expect(back.status, JSON.stringify(back.body)).toBe(200);
            expect((await simple(p.simple)).stock).toBe(afterPost.stock - 5);
            expect((await reverse(posted.body.data.id, requestKey)).status).toBe(200);
            expect((await simple(p.simple)).stock).toBe(afterPost.stock - 5);
            const [operations] = await pool.query("SELECT kind FROM stock_operations WHERE request_key=?", [`sdoc-r-${requestKey}`]);
            expect(operations).toEqual([{ kind: 'issue' }]);
        });

        it('refuses to reverse a linked product whose stock record changed after posting, unless the document predates the record', async () => {
            const created = await draft([line(`product:${p.linked}`, 1, { unit_factor: 2 })]);
            const posted = await post(created.body.data);
            expect(posted.status, JSON.stringify(posted.body)).toBe(200);
            const [[saved]] = await pool.query('SELECT stock_result FROM stock_documents WHERE id=?', [posted.body.data.id]);
            const result = typeof saved.stock_result === 'string' ? JSON.parse(saved.stock_result) : saved.stock_result;
            expect(result.linked_items).toEqual([{ product_id: p.linked, stock_item_id: expect.any(String) }]);
            const original = result.linked_items[0].stock_item_id;
            await pool.query('UPDATE product_stock_links SET stock_item_id=? WHERE product_id=?', [await stockItem('SD rewired item'), p.linked]);
            const blocked = await reverse(posted.body.data.id);
            expect(blocked.status).toBe(409);
            expect(blocked.body.code).toBe('PURCHASE_INVOICE_REVERSE_BLOCKED');
            expect(blocked.body.message).toBe("This item's stock record changed after the invoice was posted. Correct it with a stock count instead.");
            expect((await api('get', `/invoices/${posted.body.data.id}`)).body.data.status).toBe('posted');
            // Older documents carry no recorded item and keep the previous behaviour.
            await pool.query("UPDATE stock_documents SET stock_result=JSON_REMOVE(stock_result, '$.linked_items') WHERE id=?", [posted.body.data.id]);
            expect((await reverse(posted.body.data.id)).status).toBe(200);
            await pool.query('UPDATE product_stock_links SET stock_item_id=? WHERE product_id=?', [original, p.linked]);
        });

        // A product whose stock is unlimited (NULL) can be received: that starts tracking it. A reversal puts it back
        // to unlimited only while nothing has touched its stock since the posting (its stock_version is unchanged).
        describe('receiving an unlimited product', () => {
            const unlimited = (name) => product(name, { stock: null });
            const raw = async (id) => {
                const [[row]] = await pool.query('SELECT stock, CAST(stock_version AS CHAR) AS version FROM products WHERE id=?', [id]);
                return { stock: row.stock == null ? null : Number(row.stock), version: Number(row.version) };
            };
            const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
            const savedResult = async (id) => json((await pool.query('SELECT stock_result FROM stock_documents WHERE id=?', [id]))[0][0].stock_result);
            const journal = async (requestKey) => json((await pool.query('SELECT result_json FROM stock_operations WHERE request_key=?', [requestKey]))[0][0].result_json).products;
            // What a sale does to a simple product: less stock, version bumped.
            const touch = (id, stock) => pool.query('UPDATE products SET stock=?, stock_version=stock_version+1 WHERE id=?', [stock, id]);
            const received = async (lines) => {
                const created = await draft(lines);
                expect(created.status, JSON.stringify(created.body)).toBe(200);
                const requestKey = key();
                const result = await post(created.body.data, requestKey);
                expect(result.status, JSON.stringify(result.body)).toBe(200);
                return { id: result.body.data.id, requestKey, invoice: result.body.data };
            };

            it('offers it as starting to track, and receiving it makes stock the received quantity', async () => {
                const id = await unlimited('SD starts tracking');
                const listed = (await api('get', '/items?kind=product&q=SD%20starts%20tracking')).body.data;
                expect(listed).toEqual([expect.objectContaining({ item_key: `product:${id}`, kind: 'product', starts_tracking: true })]);
                const created = await draft([line(`product:${id}`, 2, { unit_factor: 6 })]);
                expect(created.status, JSON.stringify(created.body)).toBe(200);
                expect(created.body.data.lines[0]).toMatchObject({ product_id: id, starts_tracking: true });
                const before = await raw(id);
                expect(before.stock).toBeNull();
                const requestKey = key();
                const posted = await post(created.body.data, requestKey);
                expect(posted.status, JSON.stringify(posted.body)).toBe(200);
                expect(await raw(id)).toEqual({ stock: 12, version: before.version + 1 });
                // Tracked now: the invoice no longer says it would start anything.
                expect(posted.body.data.lines[0].starts_tracking).toBe(false);
                expect(await journal(`sdoc-${requestKey}`)).toEqual([{ product_id: id, qty: '12.000000', before: null, after: '12.000000' }]);
                expect((await savedResult(posted.body.data.id)).simple_products)
                    .toEqual([{ product_id: id, qty: '12.000000', before: null, after: '12.000000', stock_version_after: String(before.version + 1) }]);
                expect((await api('get', '/items?kind=product&q=SD%20starts%20tracking')).body.data[0].starts_tracking).toBe(false);
                expect((await post(created.body.data, requestKey)).status).toBe(200);
                expect(await raw(id)).toEqual({ stock: 12, version: before.version + 1 });
            });

            it('reverses straight back to unlimited when nothing changed its stock since', async () => {
                const id = await unlimited('SD back to unlimited');
                const made = await received([line(`product:${id}`, 3, { unit_factor: 4 })]);
                const afterPost = await raw(id);
                expect(afterPost.stock).toBe(12);
                const requestKey = key();
                const back = await reverse(made.id, requestKey);
                expect(back.status, JSON.stringify(back.body)).toBe(200);
                expect(back.body.data.status).toBe('reversed');
                expect(await raw(id)).toEqual({ stock: null, version: afterPost.version + 1 });
                expect(await journal(`sdoc-r-${requestKey}`)).toEqual([{ product_id: id, qty: '12.000000', before: '12.000000', after: null }]);
                expect((await savedResult(made.id)).reversal.simple_products).toEqual([{ product_id: id, qty: '12.000000', before: '12.000000', after: null }]);
                // A retried request changes nothing more, and a second reversal is refused.
                expect((await reverse(made.id, requestKey)).status).toBe(200);
                expect((await reverse(made.id)).body.code).toBe('PURCHASE_INVOICE_NOT_POSTED');
                expect(await raw(id)).toEqual({ stock: null, version: afterPost.version + 1 });
                expect((await api('get', `/items?kind=product&q=SD%20back%20to`)).body.data[0].starts_tracking).toBe(true);
            });

            it('subtracts instead when something else changed its stock since, and the product stays tracked', async () => {
                const id = await unlimited('SD received twice');
                const first = await received([line(`product:${id}`, 2, { unit_factor: 6 })]);
                const second = await received([line(`product:${id}`, 1, { unit_factor: 5 })]);
                expect((await raw(id)).stock).toBe(17);
                const back = await reverse(first.id);
                expect(back.status, JSON.stringify(back.body)).toBe(200);
                expect((await raw(id)).stock).toBe(5);
                expect((await savedResult(first.id)).reversal.simple_products).toEqual([{ product_id: id, qty: '12.000000', before: '17.000000', after: '5.000000' }]);
                // The second receipt started from 12, so its reversal subtracts too: tracked at zero, not unlimited.
                expect((await reverse(second.id)).status).toBe(200);
                expect((await raw(id)).stock).toBe(0);
            });

            it('subtracts, and still refuses to go below zero, when sales used the stock', async () => {
                const id = await unlimited('SD sold after receipt');
                const made = await received([line(`product:${id}`, 2, { unit_factor: 6 })]);
                await touch(id, 4);
                const blocked = await reverse(made.id);
                expect(blocked.status).toBe(409);
                expect(blocked.body.code).toBe('PURCHASE_INVOICE_REVERSE_BLOCKED');
                expect((await raw(id)).stock).toBe(4);
                expect((await api('get', `/invoices/${made.id}`)).body.data.status).toBe('posted');
                await touch(id, 20);
                expect((await reverse(made.id)).status).toBe(200);
                expect((await raw(id)).stock).toBe(8);
            });

            it('reverses a document that never recorded the version by subtracting, like any older document', async () => {
                const id = await unlimited('SD older document');
                const made = await received([line(`product:${id}`, 2, { unit_factor: 6 })]);
                await pool.query("UPDATE stock_documents SET stock_result=JSON_REMOVE(stock_result, '$.simple_products[0].stock_version_after') WHERE id=?", [made.id]);
                expect((await reverse(made.id)).status).toBe(200);
                expect((await raw(id)).stock).toBe(0);
            });

            it('skips a product that is already unlimited again, even when nothing bumped its version', async () => {
                const id = await unlimited('SD unlimited again');
                const made = await received([line(`product:${id}`, 2, { unit_factor: 6 })]);
                await pool.query('UPDATE products SET stock=NULL WHERE id=?', [id]);
                const back = await reverse(made.id);
                expect(back.status, JSON.stringify(back.body)).toBe(200);
                expect((await savedResult(made.id)).reversal.skipped).toEqual([{ item_key: `product:${id}`, reason: 'untracked' }]);
                expect((await raw(id)).stock).toBeNull();
            });

            it('returns one product to unlimited and subtracts from another in the same reversal, with one journal row', async () => {
                const a = await unlimited('SD mixed unlimited');
                const b = await product('SD mixed tracked', { stock: 10 });
                const made = await received([line(`product:${a}`, 2, { unit_factor: 6 }), line(`product:${b}`, 1, { unit_factor: 4 })]);
                expect([(await raw(a)).stock, (await raw(b)).stock]).toEqual([12, 14]);
                await touch(b, 9);
                const requestKey = key();
                expect((await reverse(made.id, requestKey)).status).toBe(200);
                expect([(await raw(a)).stock, (await raw(b)).stock]).toEqual([null, 5]);
                const rows = await journal(`sdoc-r-${requestKey}`);
                expect(rows).toEqual([
                    { product_id: a, qty: '12.000000', before: '12.000000', after: null },
                    { product_id: b, qty: '4.000000', before: '9.000000', after: '5.000000' },
                ]);
                const [operations] = await pool.query('SELECT id FROM stock_operations WHERE request_key=?', [`sdoc-r-${requestKey}`]);
                expect(operations).toHaveLength(1);
            });
        });

        describe('reversal after the items changed', () => {
            const working = async (id) => Number((await pool.query('SELECT CAST(working_quantity AS CHAR) q FROM ingredients WHERE id=?', [id]))[0][0].q);
            // One invoice for the product and one for the ingredient: an invoice holds a single kind.
            const postTwoInvoices = async () => {
                const cola = await product('SD reversal cola');
                const flour = (await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES (?,'weight','g')", [`SD reversal flour ${cola}`]))[0].insertId;
                const posted = async (lines) => {
                    const created = await draft(lines);
                    expect(created.status, JSON.stringify(created.body)).toBe(200);
                    const result = await post(created.body.data);
                    expect(result.status, JSON.stringify(result.body)).toBe(200);
                    return result.body.data.id;
                };
                const productInvoice = await posted([line(`product:${cola}`, 2, { unit_factor: 6 })]);
                const ingredientInvoice = await posted([line(`ingredient:${flour}`, 3, { unit_label: 'kg', unit_factor: 1000, unit_price: 6 })]);
                expect(await working(flour)).toBe(3000);
                return { cola, flour, productInvoice, ingredientInvoice };
            };
            const savedResult = async (id) => {
                const [[row]] = await pool.query('SELECT stock_result FROM stock_documents WHERE id=?', [id]);
                return typeof row.stock_result === 'string' ? JSON.parse(row.stock_result) : row.stock_result;
            };

            it('reverses after stock tracking was switched off: the simple line is skipped, the ingredient corrected', async () => {
                const made = await postTwoInvoices();
                try {
                    // What Settings does when stock is turned off: the setting flips and every products.stock becomes NULL.
                    await flags('0', '1');
                    await pool.query('UPDATE products SET stock=NULL, stock_version=stock_version+1');
                    const res = await reverse(made.productInvoice);
                    expect(res.status, JSON.stringify(res.body)).toBe(200);
                    expect(res.body.data.status).toBe('reversed');
                    expect((await savedResult(made.productInvoice)).reversal.skipped).toEqual([{ item_key: `product:${made.cola}`, reason: 'untracked' }]);
                    expect((await reverse(made.ingredientInvoice)).status).toBe(200);
                    expect(await working(made.flour)).toBe(0);
                    expect((await simple(made.cola)).stock).toBe(0);
                } finally {
                    await flags('1', '1');
                    await pool.query('UPDATE products SET stock=10 WHERE stock IS NULL AND id<>?', [p.unlimited]);
                }
            });

            it('reverses after the product was archived or made a bundle and the ingredient retired', async () => {
                const made = await postTwoInvoices();
                const before = (await simple(made.cola)).stock;
                try {
                    await pool.query('UPDATE products SET is_active=0, is_bundle=1 WHERE id=?', [made.cola]);
                    await pool.query('UPDATE ingredients SET is_active=0 WHERE id=?', [made.flour]);
                    await flags('1', '0');
                    const res = await reverse(made.productInvoice);
                    expect(res.status, JSON.stringify(res.body)).toBe(200);
                    expect((await simple(made.cola)).stock).toBe(before - 12);
                    expect((await savedResult(made.productInvoice)).reversal.skipped).toBeUndefined();
                    expect((await reverse(made.ingredientInvoice)).status, 'ingredient invoice').toBe(200);
                    expect(await working(made.flour)).toBe(0);
                } finally {
                    await flags('1', '1');
                }
            });

            it('keeps the strict rules for a new document and for posting', async () => {
                const archived = await product('SD archived later');
                await pool.query('UPDATE products SET is_active=0 WHERE id=?', [archived]);
                const res = await draft([line(`product:${archived}`)]);
                expect(res.status).toBe(400);
                expect(res.body.code).toBe('PURCHASE_ITEM_INVALID');
                const conn = await pool.getConnection();
                try {
                    await conn.beginTransaction();
                    await expect(items.resolveForUpdate(conn, [`product:${archived}`])).rejects.toMatchObject({ code: 'PURCHASE_ITEM_INVALID' });
                    await expect(items.resolveForUpdate(conn, [`product:${archived}`], { reversal: true })).resolves.toBeTruthy();
                    await expect(items.resolveForUpdate(conn, [`product:${p.composite}`], { reversal: true })).rejects.toMatchObject({ code: 'PURCHASE_ITEM_UNSUPPORTED' });
                } finally {
                    await conn.rollback();
                    conn.release();
                }
            });
        });

        it('refuses a receipt that would exceed the supported stock quantity', async () => {
            await pool.query('UPDATE products SET stock=9999999999 WHERE id=?', [p.simple]);
            const created = await draft([line(`product:${p.simple}`, 1, { unit_factor: 1 })]);
            const res = await post(created.body.data);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('PURCHASE_STOCK_TOO_LARGE');
            expect((await simple(p.simple)).stock).toBe(9999999999);
            await pool.query('UPDATE products SET stock=10 WHERE id=?', [p.simple]);
        });

        it('receives a never-activated ingredient through the recipe ledger, and reverses it', async () => {
            const created = await draft([line(`ingredient:${p.flour}`, 2, { unit_label: 'kg', unit_factor: 1000, unit_price: 6 })]);
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const posted = await post(created.body.data);
            expect(posted.status, JSON.stringify(posted.body)).toBe(200);
            const working = async () => Number((await pool.query('SELECT CAST(working_quantity AS CHAR) q FROM ingredients WHERE id=?', [p.flour]))[0][0].q);
            expect(await working()).toBe(2000);
            const [[movement]] = await pool.query(
                "SELECT source_label, source_id FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND kind='receipt'", [p.flour]);
            expect(movement).toMatchObject({ source_label: 'Purchase invoice', source_id: posted.body.data.id });
            expect((await reverse(posted.body.data.id)).status).toBe(200);
            expect(await working()).toBe(0);
        });

        it('refuses at post when an item stopped being eligible after the draft was saved', async () => {
            const created = await draft([line(`product:${p.simple}`, 1, { unit_factor: 1 })]);
            await pool.query('UPDATE products SET is_bundle=1 WHERE id=?', [p.simple]);
            try {
                const res = await post(created.body.data);
                expect(res.status).toBe(409);
                expect(res.body.code).toBe('PURCHASE_ITEM_INVALID');
                const [[row]] = await pool.query('SELECT status FROM stock_documents WHERE id=?', [created.body.data.id]);
                expect(row.status).toBe('draft');
            } finally {
                await pool.query('UPDATE products SET is_bundle=0 WHERE id=?', [p.simple]);
            }
            // Becoming unlimited is not a reason to refuse any more: the receipt simply starts tracking it again.
            await pool.query('UPDATE products SET stock=NULL WHERE id=?', [p.simple]);
            try {
                expect((await post(created.body.data)).status).toBe(200);
                expect((await simple(p.simple)).stock).toBe(1);
            } finally {
                await pool.query('UPDATE products SET stock=10 WHERE id=?', [p.simple]);
            }
        });

        it('refuses a composite product at post even when its link changed after the draft', async () => {
            const extra = await product('SD late composite');
            const created = await draft([line(`product:${extra}`, 1, { unit_factor: 1 })]);
            expect(created.status).toBe(200);
            await link(extra, await stockItem('SD late one'));
            await link(extra, await stockItem('SD late two'));
            const res = await post(created.body.data);
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('PURCHASE_ITEM_UNSUPPORTED');
        });
    });

    describe('database shape', () => {
        const header = (overrides = {}) => ({ doc_type: 'count', doc_date: '2026-09-30', ...overrides });
        const insert = async (row) => {
            const columns = Object.keys(row);
            return pool.query(`INSERT INTO stock_documents (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map((name) => row[name]));
        };
        // MariaDB reports a failed CHECK as errno 4025; the driver's name table does not know it.
        const code = async (work) => { try { await work(); } catch (error) { return error.errno === 4025 ? 'CHECK_FAILED' : error.code; } return 'accepted'; };

        it('allows one open count at a time but many posted counts', async () => {
            await pool.query("DELETE FROM stock_documents WHERE doc_type='count'");
            await insert(header());
            expect(await code(() => insert(header()))).toBe('ER_DUP_ENTRY');
            await pool.query("UPDATE stock_documents SET status='posted' WHERE doc_type='count'");
            await insert(header());
            expect(await code(() => insert(header()))).toBe('ER_DUP_ENTRY');
            await pool.query("UPDATE stock_documents SET status='posted' WHERE doc_type='count'");
            await insert(header({ status: 'posted' }));
            const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM stock_documents WHERE doc_type='count' AND status='posted'");
            expect(Number(total)).toBe(3);
            await pool.query("DELETE FROM stock_documents WHERE doc_type='count'");
        });

        it('keeps the header shape per document type', async () => {
            expect(await code(() => insert({ doc_type: 'purchase', doc_date: '2026-09-30' }))).toBe('CHECK_FAILED');
            expect(await code(() => insert(header({ supplier_id: supplier.id })))).toBe('CHECK_FAILED');
            expect(await code(() => insert(header({ status: 'reversed' })))).toBe('CHECK_FAILED');
            // A purchase says which kind of item it holds; a count never does.
            const purchase = (overrides = {}) => ({ doc_type: 'purchase', item_kind: 'product', supplier_id: supplier.id, reference: 'shape-1', doc_date: '2026-09-30', payment_status: 'paid', ...overrides });
            expect(await code(() => insert(purchase({ item_kind: null })))).toBe('CHECK_FAILED');
            expect(await code(() => insert(header({ item_kind: 'product' })))).toBe('CHECK_FAILED');
            expect(await code(() => insert(purchase()))).toBe('accepted');
            expect(await code(() => insert(purchase()))).toBe('ER_DUP_ENTRY');
            // The same supplier invoice number can be entered once on each side.
            expect(await code(() => insert(purchase({ item_kind: 'ingredient' })))).toBe('accepted');
            expect(await code(() => insert(purchase({ item_kind: 'ingredient' })))).toBe('ER_DUP_ENTRY');
        });

        it('requires exactly one of product or ingredient on a line, and one line per item per document', async () => {
            const [doc] = await insert({ doc_type: 'purchase', item_kind: 'product', supplier_id: supplier.id, reference: 'shape-lines', doc_date: '2026-09-30', payment_status: 'paid' });
            const add = ({ line_no: lineNo, ...columns }) => pool.query(
                `INSERT INTO stock_document_lines (document_id, line_no, unit_label, unit_factor${Object.keys(columns).map((name) => `, ${name}`).join('')}) VALUES (?, ?, 'box', 1${Object.keys(columns).map(() => ', ?').join('')})`,
                [doc.insertId, lineNo, ...Object.values(columns)]);
            expect(await code(() => add({ line_no: 1, product_id: p.simple, ingredient_id: p.flour }))).toBe('CHECK_FAILED');
            expect(await code(() => add({ line_no: 1, qty: 1 }))).toBe('CHECK_FAILED');
            expect(await code(() => add({ line_no: 1, product_id: p.simple }))).toBe('accepted');
            expect(await code(() => add({ line_no: 2, product_id: p.simple }))).toBe('ER_DUP_ENTRY');
            expect(await code(() => add({ line_no: 2, ingredient_id: p.flour }))).toBe('accepted');
            expect(await code(() => add({ line_no: 3, ingredient_id: p.flour }))).toBe('ER_DUP_ENTRY');
            expect(await code(() => add({ line_no: 3, ingredient_id: p.flour + 1000 }))).toBe('ER_NO_REFERENCED_ROW_2');
        });
    });

    // Must stay the last block: it drops and recreates the shared tables.
    describe('upgrade from the old invoice tables', () => {
        it('keeps posted invoices reversible with their ids, amounts and stock movements, and gives each its kind', async () => {
            const names = ['2026-10-01-stock-documents-v1', '2026-10-02-purchase-item-kind-v1', '2026-10-04-packaging-units-v1'];
            const chain = names.map((name) => migrations.migrations.find((row) => row.name === name));
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-sd-upgrade-'));
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ migrations: chain }));
            for (const target of chain) fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(dir, target.file));
            try {
                const cola = await product('SD upgrade cola');
                const colaItem = await stockItem('SD upgrade cola item');
                await pool.query('UPDATE stock_items SET legacy_product_id=? WHERE id=?', [cola, colaItem]);
                await link(cola, colaItem);
                const flour = (await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('SD upgrade flour','weight','g')"))[0].insertId;
                await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state,legacy_ingredient_id) VALUES ('SD upgrade flour item','weight','g','draft',?)", [flour]);
                const colaLine = () => line(`product:${cola}`, 2, { unit_factor: 12, unit_price: 30, tax_rate: 16 });
                const flourLine = () => line(`ingredient:${flour}`, 3, { unit_label: 'kg', unit_factor: 1000, unit_price: 6, tax_rate: 16 });
                const received = async (lines) => {
                    const created = await draft(lines);
                    expect(created.status, JSON.stringify(created.body)).toBe(200);
                    const result = await post(created.body.data);
                    expect(result.status, JSON.stringify(result.body)).toBe(200);
                    return result.body.data.id;
                };
                const productOnly = await received([colaLine()]);
                const ingredientOnly = await received([flourLine()]);
                // An invoice from before the split that held both: a product invoice with an ingredient line on it.
                const mixed = await received([colaLine()]);
                const spare = await received([flourLine()]);
                const [[spareResult]] = await pool.query('SELECT stock_result FROM stock_documents WHERE id=?', [spare]);
                const [[mixedResult]] = await pool.query('SELECT stock_result FROM stock_documents WHERE id=?', [mixed]);
                const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
                const merged = { ...parse(mixedResult.stock_result), ingredient_movements: parse(spareResult.stock_result).ingredient_movements };
                await pool.query('UPDATE stock_document_lines SET document_id=?, line_no=2 WHERE document_id=?', [mixed, spare]);
                await pool.query('UPDATE stock_documents SET stock_result=? WHERE id=?', [JSON.stringify(merged), mixed]);
                await pool.query('DELETE FROM stock_documents WHERE id=?', [spare]);
                const ids = [productOnly, ingredientOnly, mixed];
                const read = async () => Promise.all(ids.map(async (id) => (await api('get', `/invoices/${id}`)).body.data));
                const before = await read();
                expect(before.map((invoice) => invoice.item_kind)).toEqual(['product', 'ingredient', 'product']);
                expect(before[2].lines.map((row) => row.kind)).toEqual(['product', 'ingredient']);
                const stockAfterPost = (await pool.query('SELECT CAST(quantity AS CHAR) AS q FROM stock_balances WHERE stock_item_id=?', [colaItem]))[0][0].q;

                // Put the database back to the 2026-09-30 shape: old tables hold the invoices, shared tables are gone.
                const legacy = fs.readFileSync(path.join(__dirname, '../../migrations/2026-09-30-purchase-invoices-v1.sql'), 'utf8')
                    .split('\n').filter((row) => !row.startsWith('--')).join('\n').split(/;\s*\n/).map((row) => row.trim()).filter((row) => row && !row.startsWith('INSERT INTO schema_migrations'));
                for (const statement of legacy) await pool.query(statement);
                await pool.query(`INSERT INTO purchase_invoices (id, supplier_id, supplier_invoice_no, invoice_date, status, payment_status, subtotal, tax_total, total,
                        paper_total, notes, cost_includes_tax, version, create_key, post_key, reverse_key, stock_result, created_by, posted_by, reversed_by, posted_at, reversed_at, created_at, updated_at)
                    SELECT id, supplier_id, reference, doc_date, status, payment_status, subtotal, tax_total, total, paper_total, notes, cost_includes_tax, version, create_key, post_key,
                        reverse_key, stock_result, created_by, posted_by, reversed_by, posted_at, reversed_at, created_at, updated_at FROM stock_documents WHERE id IN (?)`, [ids]);
                await pool.query(`INSERT INTO purchase_invoice_lines (id, invoice_id, line_no, stock_item_id, qty, unit_label, unit_factor, unit_price, tax_rate, line_subtotal, line_tax, line_total)
                    SELECT l.id, l.document_id, l.line_no, s.id, l.qty, l.unit_label, l.unit_factor, l.unit_price, l.tax_rate, l.line_subtotal, l.line_tax, l.line_total
                      FROM stock_document_lines l JOIN stock_items s ON s.legacy_product_id <=> l.product_id AND s.legacy_ingredient_id <=> l.ingredient_id WHERE l.document_id IN (?)`, [ids]);
                await pool.query('DROP TABLE stock_document_lines');
                await pool.query('DROP TABLE stock_documents');
                await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?)', [names]);

                const run = await runPendingMigrations(pool, { manifestPath: path.join(dir, 'manifest.json') });
                expect(run.applied).toEqual(names);
                const [old] = await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('purchase_invoices','purchase_invoice_lines')");
                expect(old).toEqual([]);
                const plain = (invoice) => ({ ...invoice, created_at: undefined, updated_at: undefined, posted_at: undefined });
                // Same header, lines and amounts, and the kind the backfill chose is the one the new code gave them.
                expect((await read()).map(plain)).toEqual(before.map(plain));
                for (const id of ids) {
                    const reversed = await reverse(id);
                    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
                    expect(reversed.body.data.status).toBe('reversed');
                }
                expect(Number((await pool.query('SELECT CAST(quantity AS CHAR) AS q FROM stock_balances WHERE stock_item_id=?', [colaItem]))[0][0].q)).toBe(Number(stockAfterPost) - 48);
                expect(Number((await pool.query('SELECT CAST(working_quantity AS CHAR) AS q FROM ingredients WHERE id=?', [flour]))[0][0].q)).toBe(0);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
