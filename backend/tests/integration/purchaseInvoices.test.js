const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('purchase invoices', () => {
    let cookie, supplier, product, ingredient, plain;
    const key = () => randomUUID();
    const api = (method, path) => request(app)[method](`/api/admin/purchases${path}`).set('Cookie', cookie);
    // 2 cartons of 12 at 30.000 (16%): 24 units, JD 60.000 + 9.600 tax
    const cola = () => ({ item_key: `product:${product.id}`, qty: 2, unit_label: 'Carton', unit_factor: 12, unit_price: 30, tax_rate: 16 });
    // 2 cases of 6 at 3.000 (0%): 12 units, JD 6.000
    const box = () => ({ item_key: plain.key, qty: 2, unit_label: 'case', unit_factor: 6, unit_price: 3, tax_rate: 0 });
    // 3 kg at 6.000 (16%): 3000 g, JD 18.000 + 2.880 tax
    const flour = () => ({ item_key: `ingredient:${ingredient.id}`, qty: 3, unit_label: 'kg', unit_factor: 1000, unit_price: 6, tax_rate: 16 });
    const draftBody = (overrides = {}) => ({
        client_key: key(), kind: 'product', supplier_id: supplier.id, supplier_invoice_no: `INV-${randomUUID().slice(0, 8)}`,
        invoice_date: '2026-09-29', payment_status: 'credit', lines: [cola()], ...overrides,
    });
    const ingredientBody = (overrides = {}) => draftBody({ kind: 'ingredient', lines: [flour()], ...overrides });
    const createDraft = async (overrides) => {
        const res = await api('post', '/invoices').send(draftBody(overrides));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body.data;
    };
    const post = (invoice, requestKey = key()) => api('post', `/invoices/${invoice.id}/post`).send({ expected_version: invoice.version, request_key: requestKey });
    const reverse = (id, requestKey = key()) => api('post', `/invoices/${id}/reverse`).send({ request_key: requestKey });
    const balance = async (itemId) => {
        const [[row]] = await pool.query('SELECT CAST(quantity AS CHAR) AS quantity FROM stock_balances WHERE stock_item_id=?', [itemId]);
        return Number(row.quantity);
    };
    const plainStock = async () => Number((await pool.query('SELECT stock FROM products WHERE id=?', [plain.id]))[0][0].stock);
    const productStock = async () => Number((await pool.query('SELECT stock FROM products WHERE id=?', [product.id]))[0][0].stock);
    const receiptCost = async () => {
        const [[row]] = await pool.query(
            "SELECT unit_cost, purchase_priced, cost_source FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND kind='receipt' ORDER BY id DESC LIMIT 1", [ingredient.id]);
        return { cost: Number(row.unit_cost), priced: Number(row.purchase_priced), source: row.cost_source };
    };

    beforeAll(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('stock_enabled','recipe_ledger_enabled')");
        const [p] = await pool.query("INSERT INTO products(name,price,stock,barcode) VALUES ('Purchased cola',1,10,'6281000000017')");
        product = { id: p.insertId };
        const activated = await request(app).post(`/api/admin/stock/products/${product.id}/activate`).set('Cookie', cookie)
            .send({ expected_stock_version: '0', request_key: key() });
        expect(activated.status, JSON.stringify(activated.body)).toBe(200);
        product.itemId = activated.body.stock_item_id;
        const [i] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,pack_name,pack_size) VALUES ('Purchased flour','weight','g','Sack',25000)");
        ingredient = { id: i.insertId };
        const preview = await request(app).get(`/api/admin/stock/ingredients/${ingredient.id}/activation`).set('Cookie', cookie);
        const onIngredient = await request(app).post(`/api/admin/stock/ingredients/${ingredient.id}/activate`).set('Cookie', cookie)
            .send({ observation_token: preview.body.observation_token, request_key: key() });
        expect(onIngredient.status, JSON.stringify(onIngredient.body)).toBe(200);
        ingredient.itemId = onIngredient.body.stock_item_id;
        const [s] = await pool.query("INSERT INTO products(name,price,stock) VALUES ('Purchased plain box',1,5)");
        plain = { id: s.insertId, key: `product:${s.insertId}` };
        const created = await api('post', '/suppliers').send({ name: 'Al Noor Trading', phone: '0790000000' });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        supplier = created.body.data;
    });
    afterAll(() => pool.end());

    it('creates a supplier once per name and lists active suppliers', async () => {
        expect(supplier).toMatchObject({ name: 'Al Noor Trading', is_active: true });
        const duplicate = await api('post', '/suppliers').send({ name: 'al noor trading' });
        expect(duplicate.status).toBe(409);
        expect(duplicate.body.code).toBe('PURCHASE_SUPPLIER_DUPLICATE');
        const listed = await api('get', '/suppliers?active=1');
        expect(listed.body.data.map(row => row.name)).toContain('Al Noor Trading');
        const renamed = await api('put', `/suppliers/${supplier.id}`).send({ name: 'Al Noor Trading', phone: '0791111111', is_active: true });
        expect(renamed.body.data.phone).toBe('0791111111');
    });

    it('computes every amount on the server and ignores client totals', async () => {
        const invoice = await createDraft({ subtotal: 1, tax_total: 1, total: 1, lines: [cola(), box()].map(line => ({ ...line, line_total: 1, line_subtotal: 1 })) });
        expect(invoice).toMatchObject({ item_kind: 'product', status: 'draft', version: 1, subtotal: 66, tax_total: 9.6, total: 75.6, cost_includes_tax: null });
        expect(invoice.lines.map(line => [line.line_subtotal, line.line_tax, line.line_total])).toEqual([[60, 9.6, 69.6], [6, 0, 6]]);
        const ingredients = await createDraft(ingredientBody({ subtotal: 1, total: 1 }));
        expect(ingredients).toMatchObject({ item_kind: 'ingredient', subtotal: 18, tax_total: 2.88, total: 20.88 });
        expect(ingredients.lines.map(line => [line.line_subtotal, line.line_tax, line.line_total])).toEqual([[18, 2.88, 20.88]]);
        const rounding = await createDraft({ lines: [{ item_key: plain.key, qty: '1.333', unit_label: 'box', unit_factor: 1, unit_price: '0.3335', tax_rate: 4 }] });
        // 1.333 x 0.3335 = 0.4445555 -> 0.445; 4% of 0.445 = 0.0178 -> 0.018
        expect(rounding.lines[0]).toMatchObject({ line_subtotal: 0.445, line_tax: 0.018, line_total: 0.463 });
    });

    it('rejects malformed lines with clear codes', async () => {
        const bad = async (lineChange) => (await api('post', '/invoices').send(draftBody({ lines: [{ ...cola(), ...lineChange }] }))).body.code;
        expect(await bad({ tax_rate: 5 })).toBe('PURCHASE_INVOICE_LINES_INVALID');
        expect(await bad({ qty: 0 })).toBe('PURCHASE_INVOICE_LINES_INVALID');
        expect(await bad({ qty: '1.0001' })).toBe('PURCHASE_INVOICE_LINES_INVALID');
        expect(await bad({ unit_price: -1 })).toBe('PURCHASE_INVOICE_LINES_INVALID');
        expect(await bad({ item_key: 'product:999999' })).toBe('PURCHASE_ITEM_INVALID');
        expect(await bad({ item_key: 'nonsense' })).toBe('PURCHASE_INVOICE_LINES_INVALID');
        expect(await bad({ item_key: '12' })).toBe('PURCHASE_INVOICE_LINES_INVALID');
        expect((await api('post', '/invoices').send(draftBody({ lines: [] }))).body.code).toBe('PURCHASE_INVOICE_LINES_INVALID');
        expect((await api('post', '/invoices').send(draftBody({ lines: [cola(), cola()] }))).body.code).toBe('PURCHASE_INVOICE_LINES_INVALID');
    });

    it('returns the same draft for a retried create and rejects the same paper invoice entered twice', async () => {
        const body = draftBody();
        const first = await api('post', '/invoices').send(body);
        const retry = await api('post', '/invoices').send(body);
        expect(retry.status).toBe(200);
        expect(retry.body.data.id).toBe(first.body.data.id);
        const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM stock_documents WHERE create_key=?', [body.client_key]);
        expect(Number(total)).toBe(1);
        const twice = await api('post', '/invoices').send({ ...body, client_key: key() });
        expect(twice.status).toBe(409);
        expect(twice.body.code).toBe('PURCHASE_INVOICE_DUPLICATE');
    });

    it('updates a draft with its version, refuses a stale version, and deletes a draft', async () => {
        const invoice = await createDraft({ lines: [cola(), box()] });
        const edited = await api('put', `/invoices/${invoice.id}`).send({ ...draftBody({ supplier_invoice_no: invoice.supplier_invoice_no }), expected_version: 1, lines: [box()] });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        expect(edited.body.data).toMatchObject({ item_kind: 'product', version: 2, subtotal: 6, total: 6 });
        expect(edited.body.data.lines).toHaveLength(1);
        const stale = await api('put', `/invoices/${invoice.id}`).send({ ...draftBody({ supplier_invoice_no: invoice.supplier_invoice_no }), expected_version: 1 });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('PURCHASE_INVOICE_STALE');
        expect((await api('delete', `/invoices/${invoice.id}`).send({ expected_version: 1 })).body.code).toBe('PURCHASE_INVOICE_STALE');
        const removed = await api('delete', `/invoices/${invoice.id}`).send({ expected_version: 2 });
        expect(removed.body.data).toEqual({ id: invoice.id });
        expect((await api('get', `/invoices/${invoice.id}`)).status).toBe(404);
        expect((await pool.query('SELECT id FROM stock_document_lines WHERE document_id=?', [invoice.id]))[0]).toHaveLength(0);
    });

    describe('posting', () => {
        let posted, postedIngredients, productBefore, ingredientBefore;

        it('raises balances by quantity times factor in base units, with ex-tax cost for a sales-tax venue', async () => {
            await pool.query("UPDATE settings SET setting_value='sales_tax' WHERE setting_key='tax_registration_type'");
            productBefore = await balance(product.itemId);
            ingredientBefore = await balance(ingredient.itemId);
            expect(productBefore).toBe(10);
            const draft = await createDraft();
            const ingredientDraft = await createDraft(ingredientBody());
            const requestKey = key();
            const res = await post(draft, requestKey);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            posted = res.body.data;
            expect(posted).toMatchObject({ item_kind: 'product', status: 'posted', version: 2, cost_includes_tax: false });
            expect(await balance(product.itemId)).toBe(productBefore + 24);
            expect(await productStock()).toBe(productBefore + 24);
            // The product invoice moved no ingredient.
            expect(await balance(ingredient.itemId)).toBe(ingredientBefore);
            const ingredientKey = key();
            const received = await post(ingredientDraft, ingredientKey);
            expect(received.status, JSON.stringify(received.body)).toBe(200);
            postedIngredients = received.body.data;
            expect(postedIngredients).toMatchObject({ item_kind: 'ingredient', status: 'posted', cost_includes_tax: false });
            expect(await balance(ingredient.itemId)).toBe(ingredientBefore + 3000);
            expect(await balance(product.itemId)).toBe(productBefore + 24);
            // JD 18.000 ex tax over 3000 g
            expect(await receiptCost()).toEqual({ cost: 0.006, priced: 1, source: 'purchase' });
            const [audit] = await pool.query("SELECT id FROM audit_events WHERE event_type='purchase_invoice_posted' AND entity_id IN (?, ?)", [posted.id, postedIngredients.id]);
            expect(audit).toHaveLength(2);
            posted.requestKey = requestKey;
            postedIngredients.requestKey = ingredientKey;
        });

        it('replays the same request key without posting twice', async () => {
            const again = await api('post', `/invoices/${posted.id}/post`).send({ expected_version: 1, request_key: posted.requestKey });
            expect(again.status, JSON.stringify(again.body)).toBe(200);
            expect(again.body.data).toMatchObject({ id: posted.id, status: 'posted' });
            const againIngredients = await api('post', `/invoices/${postedIngredients.id}/post`).send({ expected_version: 1, request_key: postedIngredients.requestKey });
            expect(againIngredients.status, JSON.stringify(againIngredients.body)).toBe(200);
            expect(await balance(product.itemId)).toBe(productBefore + 24);
            expect(await balance(ingredient.itemId)).toBe(ingredientBefore + 3000);
            const [audit] = await pool.query("SELECT id FROM audit_events WHERE event_type='purchase_invoice_posted' AND entity_id IN (?, ?)", [posted.id, postedIngredients.id]);
            expect(audit).toHaveLength(2);
        });

        it('posts once when the same request is sent twice at the same time', async () => {
            const draft = await createDraft({ lines: [cola()] });
            const requestKey = key();
            const before = await balance(product.itemId);
            const both = await Promise.all([post(draft, requestKey), post(draft, requestKey)]);
            expect(both.map(res => res.status)).toEqual([200, 200]);
            expect(await balance(product.itemId)).toBe(before + 24);
        });

        it('refuses another post with a different key, and any edit or delete of a posted invoice', async () => {
            const other = await post({ id: posted.id, version: 1 }, key());
            expect(other.status).toBe(409);
            expect(other.body.code).toBe('PURCHASE_INVOICE_NOT_DRAFT');
            const update = await api('put', `/invoices/${posted.id}`).send({ ...draftBody(), expected_version: posted.version });
            expect(update.body.code).toBe('PURCHASE_INVOICE_NOT_DRAFT');
            const removed = await api('delete', `/invoices/${posted.id}`).send({ expected_version: posted.version });
            expect(removed.body.code).toBe('PURCHASE_INVOICE_NOT_DRAFT');
        });

        it('takes the tax-inclusive cost for an income-tax venue', async () => {
            await pool.query("UPDATE settings SET setting_value='income_tax' WHERE setting_key='tax_registration_type'");
            try {
                const draft = await createDraft(ingredientBody());
                const res = await post(draft);
                expect(res.body.data.cost_includes_tax).toBe(true);
                // JD 20.880 with tax over 3000 g
                expect((await receiptCost()).cost).toBe(0.00696);
            } finally {
                await pool.query("UPDATE settings SET setting_value='sales_tax' WHERE setting_key='tax_registration_type'");
            }
        });

        it('posts a simple-stock product by raising products.stock', async () => {
            const draft = await createDraft({ lines: [box()] });
            expect((await post(draft)).status).toBe(200);
            expect(await plainStock()).toBe(17);
        });

        it('rejects a duplicate supplier invoice number', async () => {
            const number = `DUP-${randomUUID().slice(0, 6)}`;
            await createDraft({ supplier_invoice_no: number });
            const res = await api('post', '/invoices').send(draftBody({ supplier_invoice_no: number }));
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('PURCHASE_INVOICE_DUPLICATE');
        });

        it('reverses once, restoring balances, and refuses a second reverse', async () => {
            // The ingredient receipt is tagged with its invoice, and the generic correction refuses it.
            const [[receipt]] = await pool.query(
                "SELECT id, source_label, source_id FROM stock_movements WHERE movement_type='ingredient' AND kind='receipt' AND ingredient_id=? AND source_id=?", [ingredient.id, postedIngredients.id]);
            expect(receipt).toMatchObject({ source_label: 'Purchase invoice', source_id: postedIngredients.id });
            const correct = await request(app).post(`/api/admin/ingredient-movements/${receipt.id}/amend`).set('Cookie', cookie)
                .send({ qty: 0, client_key: key(), note: 'try to change a posted invoice' });
            expect(correct.status).toBe(409);
            const productNow = await balance(product.itemId);
            const ingredientNow = await balance(ingredient.itemId);
            const requestKey = key();
            const res = await reverse(posted.id, requestKey);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.data.status).toBe('reversed');
            expect(await balance(product.itemId)).toBe(productNow - 24);
            expect(await productStock()).toBe(productNow - 24);
            expect(await balance(ingredient.itemId)).toBe(ingredientNow);
            const ingredientRequestKey = key();
            const undone = await reverse(postedIngredients.id, ingredientRequestKey);
            expect(undone.status, JSON.stringify(undone.body)).toBe(200);
            expect(undone.body.data).toMatchObject({ item_kind: 'ingredient', status: 'reversed' });
            expect(await balance(ingredient.itemId)).toBe(ingredientNow - 3000);
            const [audit] = await pool.query("SELECT id FROM audit_events WHERE event_type='purchase_invoice_reversed' AND entity_id IN (?, ?)", [posted.id, postedIngredients.id]);
            expect(audit).toHaveLength(2);
            expect((await reverse(posted.id, requestKey)).status).toBe(200);
            expect((await reverse(postedIngredients.id, ingredientRequestKey)).status).toBe(200);
            for (const id of [posted.id, postedIngredients.id]) {
                const second = await reverse(id, key());
                expect(second.status).toBe(409);
                expect(second.body.code).toBe('PURCHASE_INVOICE_NOT_POSTED');
            }
            expect(await balance(product.itemId)).toBe(productNow - 24);
            expect(await balance(ingredient.itemId)).toBe(ingredientNow - 3000);
        });

        it('refuses a reversal that would take a strict item below zero, and allows it for an estimate item', async () => {
            const draft = await createDraft({ lines: [cola()] });
            const res = await post(draft);
            await pool.query('UPDATE stock_balances SET quantity=3 WHERE stock_item_id=?', [product.itemId]);
            await pool.query('UPDATE products SET stock=3 WHERE id=?', [product.id]);
            const blocked = await reverse(res.body.data.id);
            expect(blocked.status).toBe(409);
            expect(blocked.body.code).toBe('PURCHASE_INVOICE_REVERSE_BLOCKED');
            expect(await balance(product.itemId)).toBe(3);
            expect((await api('get', `/invoices/${res.body.data.id}`)).body.data.status).toBe('posted');
            await pool.query("UPDATE stock_items SET availability_policy='estimate' WHERE id=?", [product.itemId]);
            const back = await reverse(res.body.data.id);
            expect(back.status, JSON.stringify(back.body)).toBe(200);
            expect(await balance(product.itemId)).toBe(-21);
        });
    });

    describe('lookups', () => {
        it('reports the previous posted price for an item, by supplier, and finds an item by exact barcode', async () => {
            const draft = await createDraft({ lines: [{ item_key: `product:${product.id}`, qty: 1, unit_label: 'Carton', unit_factor: 12, unit_price: 33, tax_rate: 16 }] });
            const before = await api('get', `/invoices/${draft.id}`);
            // the earlier posted invoice for this supplier priced the product at 30
            expect(before.body.data.lines[0].last_unit_price_before).toBe(30);
            await post(draft);
            const items = await api('get', `/items?kind=product&q=Purchased&supplier_id=${supplier.id}`);
            const colaItem = items.body.data.find(row => row.name === 'Purchased cola');
            expect(colaItem).toMatchObject({ kind: 'product', base_unit: 'unit', starts_tracking: false, last: { unit_label: 'Carton', unit_factor: 12, unit_price: 33, tax_rate: 16 } });
            expect(colaItem.packs[0]).toEqual({ label: 'unit', factor: 1 });
            expect(colaItem.packs).toContainEqual({ label: 'Carton', factor: 12 });
            const flourItem = (await api('get', '/items?kind=ingredient&q=Purchased')).body.data.find(row => row.name === 'Purchased flour');
            expect(flourItem).toMatchObject({ kind: 'ingredient', starts_tracking: false });
            expect(flourItem.packs).toContainEqual({ label: 'Sack', factor: 25000 });
            const other = await api('post', '/suppliers').send({ name: 'Other Supplier' });
            const scoped = await api('get', `/items?kind=product&q=cola&supplier_id=${other.body.data.id}`);
            expect(scoped.body.data[0].last).toBeNull();
            const byCode = await api('get', '/items?kind=product&barcode=6281000000017');
            expect(byCode.body.data).toHaveLength(1);
            expect(byCode.body.data[0].name).toBe('Purchased cola');
            expect((await api('get', '/items?kind=product&barcode=628100000001')).body.data).toHaveLength(0);
        });

        it('finds a product by an extra barcode and says which of its barcodes matched', async () => {
            await pool.query("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, '6281000000024')", [product.id]);
            try {
                const byExtra = (await api('get', '/items?kind=product&barcode=6281000000024')).body.data;
                expect(byExtra).toHaveLength(1);
                expect(byExtra[0]).toMatchObject({ item_key: `product:${product.id}`, name: 'Purchased cola', barcode: '6281000000017', matched_barcode: '6281000000024' });
                const byMain = (await api('get', '/items?kind=product&barcode=6281000000017')).body.data;
                expect(byMain.map(row => [row.name, row.matched_barcode])).toEqual([['Purchased cola', '6281000000017']]);
                // a barcode is an exact match only
                expect((await api('get', '/items?kind=product&barcode=62810000000')).body.data).toEqual([]);
                // the search box: an exact extra barcode ranks first; a name match reports no barcode
                const typed = (await api('get', '/items?kind=product&q=6281000000024')).body.data;
                expect(typed.map(row => [row.name, row.matched_barcode])).toEqual([['Purchased cola', '6281000000024']]);
                const byName = (await api('get', '/items?kind=product&q=Purchased')).body.data;
                expect(byName.find(row => row.name === 'Purchased cola').matched_barcode).toBeNull();
                const flour = (await api('get', '/items?kind=ingredient&q=Purchased')).body.data.find(row => row.name === 'Purchased flour');
                expect(flour.matched_barcode).toBeNull();
                expect((await api('get', '/items?kind=ingredient&barcode=6281000000024')).body.data).toEqual([]);
            } finally {
                await pool.query("DELETE FROM product_barcodes WHERE barcode = '6281000000024'");
            }
        });

        it('lists categories that hold stock items and pages invoices with drafts first', async () => {
            const draft = await createDraft();
            const page = await api('get', '/invoices?kind=product&limit=2');
            expect(page.body.data[0]).toMatchObject({ status: 'draft', item_kind: 'product' });
            expect(page.body.data.map(row => row.id)).toContain(draft.id);
            const second = await api('get', `/invoices?kind=product&limit=2&before_id=${page.body.next_before_id}`);
            const ids = new Set([...page.body.data, ...second.body.data].map(row => row.id));
            expect(ids.size).toBe(page.body.data.length + second.body.data.length);
            expect((await api('get', '/invoices?kind=product&status=reversed')).body.data.every(row => row.status === 'reversed')).toBe(true);
            expect((await api('get', '/categories')).status).toBe(200);
        });

        it('keeps paging older drafts after the cursor draft is posted', async () => {
            const own = (await api('post', '/suppliers').send({ name: `Cursor supplier ${randomUUID().slice(0, 6)}` })).body.data;
            const d1 = await createDraft({ supplier_id: own.id });
            const d2 = await createDraft({ supplier_id: own.id });
            await createDraft({ supplier_id: own.id });
            const first = await api('get', `/invoices?kind=product&supplier_id=${own.id}&limit=2`);
            expect(first.body.next_before_id).toBe(d2.id);
            expect(first.body.next_before_group).toBe('draft');
            expect((await post(d2)).status).toBe(200);
            const second = await api('get', `/invoices?kind=product&supplier_id=${own.id}&limit=2&before_id=${d2.id}&before_group=${first.body.next_before_group}`);
            expect(second.body.data.map(row => row.id)).toContain(d1.id);
            expect((await api('get', '/invoices?kind=product&before_group=nope&before_id=1')).status).toBe(400);
        });

        it('reports the previous price with the buying unit it was for', async () => {
            const own = (await api('post', '/suppliers').send({ name: `Pack supplier ${randomUUID().slice(0, 6)}` })).body.data;
            const carton = await createDraft({ supplier_id: own.id, lines: [cola()] });
            expect((await post(carton)).status).toBe(200);
            const single = await createDraft({ supplier_id: own.id, lines: [{ ...cola(), unit_label: 'Can', unit_factor: 1, unit_price: 3 }] });
            const read = await api('get', `/invoices/${single.id}`);
            expect(read.body.data.lines[0]).toMatchObject({ last_unit_price_before: 30, last_unit_factor_before: 12, last_unit_label_before: 'Carton' });
        });

        it("returns the supplier's last posted lines, or null when there is none", async () => {
            const last = await api('get', `/invoices/last?supplier_id=${supplier.id}&kind=product`);
            expect(last.status).toBe(200);
            expect(Array.isArray(last.body.data)).toBe(true);
            expect(last.body.data[0]).toMatchObject({ item_key: `product:${product.id}`, kind: 'product', product_id: product.id, unit_price: 33, last_unit_price_before: 33, starts_tracking: false });
            const nobody = await api('post', '/suppliers').send({ name: 'Never bought from' });
            const none = await api('get', `/invoices/last?supplier_id=${nobody.body.data.id}&kind=product`);
            expect(none.body.data).toBeNull();
        });
    });

    // An invoice holds products or ingredients, never both, and the side is fixed when it is created.
    describe('kinds', () => {
        const code = (res) => res.body.code;

        it('offers only products on a product invoice and only ingredients on an ingredient invoice', async () => {
            const products = (await api('get', '/items?kind=product&q=Purchased')).body.data;
            expect(products.map(row => row.name).sort()).toEqual(['Purchased cola', 'Purchased plain box']);
            expect(products.every(row => row.kind === 'product')).toBe(true);
            const ingredients = (await api('get', '/items?kind=ingredient&q=Purchased')).body.data;
            expect(ingredients.map(row => row.name)).toEqual(['Purchased flour']);
            expect((await api('get', '/items?kind=ingredient&barcode=6281000000017')).body.data).toEqual([]);
        });

        it('refuses a line of the other kind, on create, on update and at post', async () => {
            const wrongProduct = await api('post', '/invoices').send(draftBody({ lines: [cola(), flour()] }));
            expect(wrongProduct.status).toBe(400);
            expect(code(wrongProduct)).toBe('PURCHASE_ITEM_INVALID');
            expect(wrongProduct.body.message).toBe('Line 2: the item is missing or not active.');
            const wrongIngredient = await api('post', '/invoices').send(ingredientBody({ lines: [flour(), cola()] }));
            expect(wrongIngredient.status).toBe(400);
            expect(code(wrongIngredient)).toBe('PURCHASE_ITEM_INVALID');
            const invoice = await createDraft();
            // The stored kind decides; a kind in the body of an update is ignored.
            const toIngredient = await api('put', `/invoices/${invoice.id}`).send({ ...ingredientBody({ supplier_invoice_no: invoice.supplier_invoice_no }), expected_version: 1 });
            expect(toIngredient.status).toBe(400);
            expect(code(toIngredient)).toBe('PURCHASE_ITEM_INVALID');
            const stays = await api('put', `/invoices/${invoice.id}`).send({ ...draftBody({ kind: 'ingredient', supplier_invoice_no: invoice.supplier_invoice_no }), expected_version: 1 });
            expect(stays.status, JSON.stringify(stays.body)).toBe(200);
            expect(stays.body.data.item_kind).toBe('product');
            // A draft that already holds a line of the other kind (a mixed invoice from before the split) cannot be posted as it is.
            await pool.query('INSERT INTO stock_document_lines (document_id, line_no, ingredient_id, qty, unit_label, unit_factor, unit_price, tax_rate) VALUES (?, 2, ?, 1, \'kg\', 1000, 1, 0)',
                [invoice.id, ingredient.id]);
            const blocked = await post(stays.body.data);
            expect(blocked.status).toBe(409);
            expect(code(blocked)).toBe('PURCHASE_ITEM_INVALID');
            expect((await api('get', `/invoices/${invoice.id}`)).body.data.status).toBe('draft');
        });

        it('requires a valid kind to read or create invoices', async () => {
            for (const path of ['/items', '/invoices', `/invoices/last?supplier_id=${supplier.id}`]) {
                for (const query of ['', 'kind=', 'kind=both', 'kind=Product', 'kind=product&kind=ingredient']) {
                    const res = await api('get', `${path}${path.includes('?') ? '&' : '?'}${query}`);
                    expect(res.status, `${path} ${query}`).toBe(400);
                    expect(code(res)).toBe('PURCHASE_REQUEST_INVALID');
                    expect(res.body.message).toBe('kind is invalid.');
                }
            }
            for (const kind of [undefined, null, '', 'both', ['product'], 1]) {
                const body = draftBody({ kind });
                if (kind === undefined) delete body.kind;
                const res = await api('post', '/invoices').send(body);
                expect(res.status, String(kind)).toBe(400);
                expect(code(res)).toBe('PURCHASE_REQUEST_INVALID');
                expect(res.body.message).toBe('kind is invalid.');
            }
        });

        it('lists and finds the last invoice of the requested kind only', async () => {
            const own = (await api('post', '/suppliers').send({ name: `Kinds supplier ${randomUUID().slice(0, 6)}` })).body.data;
            const products = await createDraft({ supplier_id: own.id });
            const ingredients = await createDraft(ingredientBody({ supplier_id: own.id }));
            const ids = async (kind) => (await api('get', `/invoices?kind=${kind}&supplier_id=${own.id}`)).body.data.map(row => [row.id, row.item_kind]);
            expect(await ids('product')).toEqual([[products.id, 'product']]);
            expect(await ids('ingredient')).toEqual([[ingredients.id, 'ingredient']]);
            expect((await post(products)).status).toBe(200);
            expect((await post(ingredients)).status).toBe(200);
            const last = async (kind) => (await api('get', `/invoices/last?supplier_id=${own.id}&kind=${kind}`)).body;
            expect((await last('product')).invoice.id).toBe(products.id);
            expect((await last('ingredient')).invoice.id).toBe(ingredients.id);
            expect((await last('ingredient')).data.map(row => row.kind)).toEqual(['ingredient']);
            const detail = (await api('get', `/invoices/${ingredients.id}`)).body.data;
            expect(detail.item_kind).toBe('ingredient');
            expect(detail.lines).toHaveLength(1);
            // An invoice from before the split may hold both kinds; repeating it on one side copies only that side's lines.
            const [[flourLine]] = await pool.query('SELECT ingredient_id FROM stock_document_lines WHERE document_id = ?', [ingredients.id]);
            await pool.query(
                `INSERT INTO stock_document_lines (document_id, line_no, ingredient_id, qty, unit_label, unit_factor, unit_price, tax_rate)
                 VALUES (?, 99, ?, 1, 'g', 1, 1, 0)`, [products.id, flourLine.ingredient_id]);
            expect((await last('product')).data.map(row => row.kind)).toEqual(['product']);
            const none = (await api('post', '/suppliers').send({ name: `Kinds none ${randomUUID().slice(0, 6)}` })).body.data;
            await post(await createDraft({ supplier_id: none.id }));
            expect((await api('get', `/invoices/last?supplier_id=${none.id}&kind=ingredient`)).body.data).toBeNull();
        });

        it('lets one supplier invoice number be entered once per kind, and refuses it twice on one side', async () => {
            const number = `BOTH-${randomUUID().slice(0, 6)}`;
            const first = await api('post', '/invoices').send(draftBody({ supplier_invoice_no: number }));
            expect(first.status, JSON.stringify(first.body)).toBe(200);
            const other = await api('post', '/invoices').send(ingredientBody({ supplier_invoice_no: number }));
            expect(other.status, JSON.stringify(other.body)).toBe(200);
            expect(other.body.data.item_kind).toBe('ingredient');
            const again = await api('post', '/invoices').send(draftBody({ supplier_invoice_no: number }));
            expect(again.status).toBe(409);
            expect(code(again)).toBe('PURCHASE_INVOICE_DUPLICATE');
            const againOther = await api('post', '/invoices').send(ingredientBody({ supplier_invoice_no: number }));
            expect(againOther.status).toBe(409);
            expect(code(againOther)).toBe('PURCHASE_INVOICE_DUPLICATE');
        });

        it('replays a retried create only for the same kind', async () => {
            const body = ingredientBody();
            const first = await api('post', '/invoices').send(body);
            expect((await api('post', '/invoices').send(body)).body.data.id).toBe(first.body.data.id);
            const crossed = await api('post', '/invoices').send({ ...draftBody({ supplier_invoice_no: body.supplier_invoice_no }), client_key: body.client_key });
            expect(crossed.status).toBe(409);
            expect(code(crossed)).toBe('PURCHASE_INVOICE_KEY_REUSED');
        });

        it('lists product categories by what a purchase can receive, not by what a count lists', async () => {
            const category = (await pool.query("INSERT INTO categories(name,is_notes) VALUES ('Purchase only drinks',0)"))[0].insertId;
            const unlimited = (await pool.query('INSERT INTO products(name,price,stock,category_id) VALUES (?,1,NULL,?)', ['Purchase only cola', category]))[0].insertId;
            try {
                expect((await api('get', '/categories')).body.data).toContainEqual({ id: category, name: 'Purchase only drinks', item_count: 1 });
                const counts = await request(app).get('/api/admin/stock-counts/groups').set('Cookie', cookie);
                expect(counts.body.data.some(group => group.key === `category:${category}`)).toBe(false);
            } finally {
                await pool.query('DELETE FROM products WHERE id=?', [unlimited]);
                await pool.query('DELETE FROM categories WHERE id=?', [category]);
            }
        });
    });

    it('keeps the routes admin only', async () => {
        const cashier = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        const res = await request(app).get('/api/admin/purchases/suppliers').set('Cookie', cashier);
        expect(res.status).toBe(403);
    });
});
