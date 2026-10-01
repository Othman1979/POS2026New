const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { getBusinessDate } = require('../../utils/businessDate');

// Stock counts: drafts seeded from groups, blind counting, and a post that keeps every sale made while
// the person was counting. Sales go through the real checkout path.
describe('stock counts', () => {
    let cookie, shiftId, cat;
    const p = {};
    const key = () => randomUUID();
    const api = (method, path) => request(app)[method](`/api/admin/stock-counts${path}`).set('Cookie', cookie);
    const flags = (stock, recipes) => pool.query("UPDATE settings SET setting_value=? WHERE setting_key='stock_enabled'", [stock])
        .then(() => pool.query("UPDATE settings SET setting_value=? WHERE setting_key='recipe_ledger_enabled'", [recipes]));

    const product = async (name, { stock = 10, category = cat, cost = 0 } = {}) => (await pool.query(
        'INSERT INTO products(name,price,stock,category_id,cost_price) VALUES (?,1,?,?,?)', [name, stock, category, cost]))[0].insertId;
    const linkedProduct = async (name, quantity = 20, cost = 0) => {
        const id = await product(name, { stock: quantity, cost });
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES (?,'count','unit','active')", [name]);
        await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) VALUES (?,?,1)', [item.insertId, quantity]);
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [id, item.insertId]);
        return { id, itemId: item.insertId };
    };
    const ingredient = async (name, { cost = 0.002, display = 'kg' } = {}) => (await pool.query(
        "INSERT INTO ingredients(name,measure,display_unit,pack_name,pack_size,unit_cost) VALUES (?,'weight',?,'Sack',25000,?)", [name, display, cost]))[0].insertId;
    const setIngredient = async (id, kg) => {
        const res = await request(app).post(`/api/admin/ingredients/${id}/movements`).set('Cookie', cookie).send({ kind: 'count', qty: kg, unit: 'kg', client_key: key() });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    const sell = async (productId, qty = 1) => {
        const res = await request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
            cart: [{ id: productId, qty, price: 1 }], shift_id: shiftId, subtotal: qty, tax: 0,
            total: qty, payment_method: 'cash', amount_tendered: qty, change_due: 0, idempotency_key: key(),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    };

    const stockOf = async (id) => Number((await pool.query('SELECT CAST(stock AS CHAR) AS stock FROM products WHERE id=?', [id]))[0][0].stock);
    const balanceOf = async (itemId) => Number((await pool.query('SELECT CAST(quantity AS CHAR) AS quantity FROM stock_balances WHERE stock_item_id=?', [itemId]))[0][0].quantity);
    const workingOf = async (id) => Number((await pool.query('SELECT CAST(working_quantity AS CHAR) AS quantity FROM ingredients WHERE id=?', [id]))[0][0].quantity);

    const clearOpen = async () => {
        const [rows] = await pool.query("SELECT id FROM stock_documents WHERE doc_type='count' AND status='draft'");
        for (const row of rows) await pool.query('DELETE FROM stock_documents WHERE id=?', [row.id]);
    };
    const createBody = (extra = {}) => ({ reference: 'Weekly', groups: [`category:${cat}`], request_key: key(), ...extra });
    const open = async (extra) => {
        await clearOpen();
        const res = await api('post', '/').send(createBody(extra));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body.data;
    };
    const lineOf = (count, itemKey) => {
        const found = count.lines.find((line) => line.item_key === itemKey);
        expect(found, `line ${itemKey}`).toBeTruthy();
        return found;
    };
    const entry = (line, qty, unit) => ({ id: line.id, qty: qty == null ? null : String(qty), unit_label: unit ? unit.label : line.unit_label, unit_factor: unit ? unit.factor : line.unit_factor });
    const save = (count, ...entries) => api('put', `/${count.id}/lines`).send({ lines: entries });
    const count = async (counted, line, qty, unit) => {
        const res = await save(counted, entry(line, qty, unit));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body.data;
    };
    const post = (counted, requestKey = key()) => api('post', `/${counted.id}/post`).send({ request_key: requestKey });
    const posted = async (counted) => {
        const res = await post(counted);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body.data;
    };
    const dbLine = async (id) => (await pool.query('SELECT CAST(qty AS CHAR) AS qty, CAST(expected_qty AS CHAR) AS expected, counted_at, counted_by FROM stock_document_lines WHERE id=?', [id]))[0][0];
    const kg = { label: 'kg', factor: '1000' };

    beforeAll(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await flags('1', '1');
        await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.adminUser.id, starting_cash: 0 });
        shiftId = (await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.adminUser.id]))[0][0].id;
        cat = (await pool.query("INSERT INTO categories(name,is_notes) VALUES ('Count drinks',0)"))[0].insertId;
        p.simple = await product('Count simple', { stock: 10, cost: 2 });
        p.linked = await linkedProduct('Count linked', 20, 1);
        p.other = await product('Count other', { stock: 7, category: null });
        p.flour = await ingredient('Count flour');
        p.sugar = await ingredient('Count sugar');
        // A recipe product uses 200 g of flour per sale; recipe products are never counted themselves.
        p.recipe = await product('Count recipe', { stock: null });
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,200)', [p.recipe, p.flour]);
        await setIngredient(p.flour, 10);
        // The setup count happened before any sheet; keep it clearly earlier than the lines counted in the tests.
        await pool.query("UPDATE stock_movements SET occurred_at = occurred_at - INTERVAL 1 HOUR WHERE movement_type='ingredient' AND kind='count'");
    });
    afterAll(() => pool.end());

    const keyOf = { simple: () => `product:${p.simple}`, linked: () => `product:${p.linked.id}`, other: () => `product:${p.other}`, flour: () => `ingredient:${p.flour}`, sugar: () => `ingredient:${p.sugar}` };

    describe('creating', () => {
        it('seeds one blank line per eligible item of the chosen groups, ordered by group then name', async () => {
            const counted = await open({ groups: [`category:${cat}`, 'ingredients', 'other'] });
            expect(counted).toMatchObject({ status: 'draft', reference: 'Weekly', count_date: getBusinessDate(), counted_count: 0, posted_at: null });
            const names = counted.lines.map((line) => line.name);
            expect(names.slice(0, 2)).toEqual(['Count linked', 'Count simple']);
            expect(counted.lines.map((line) => line.line_no)).toEqual(counted.lines.map((_, index) => index + 1));
            expect(counted.lines.every((line) => line.qty === null && line.counted_at === null)).toBe(true);
            expect(lineOf(counted, keyOf.simple())).toMatchObject({ group_key: `category:${cat}`, group_label: 'Count drinks', base_unit: 'unit', unit_label: 'unit', unit_factor: '1' });
            expect(lineOf(counted, keyOf.other())).toMatchObject({ group_key: 'other', group_label: 'Other items' });
            // Ingredients default to their display unit and offer base, display and pack units.
            expect(lineOf(counted, keyOf.flour())).toMatchObject({
                group_key: 'ingredients', base_unit: 'g', unit_label: 'kg', unit_factor: '1000',
                unit_options: [{ label: 'g', factor: '1' }, { label: 'kg', factor: '1000' }, { label: 'Sack', factor: '25000' }],
            });
            expect(counted.lines.some((line) => line.item_key === `product:${p.recipe}`)).toBe(false);
        });

        it("offers an 'other' group for eligible products without a category", async () => {
            const groups = (await api('get', '/groups')).body.data;
            expect(groups).toContainEqual({ key: 'other', label: 'Other items', item_count: expect.any(Number) });
            expect(groups).toContainEqual({ key: `category:${cat}`, label: 'Count drinks', item_count: 2 });
            expect(groups.find((group) => group.key === 'ingredients').item_count).toBe(2);
        });

        it('searches items with their group and units', async () => {
            const found = (await api('get', '/items?q=Count%20fl')).body.data;
            expect(found).toEqual([{
                item_key: keyOf.flour(), name: 'Count flour', group_key: 'ingredients', group_label: 'Ingredients', base_unit: 'g',
                unit_options: [{ label: 'g', factor: '1' }, { label: 'kg', factor: '1000' }, { label: 'Sack', factor: '25000' }],
            }]);
            expect((await api('get', '/items?q=Count%20oth')).body.data[0]).toMatchObject({ group_key: 'other', group_label: 'Other items' });
        });

        it('finds a product by an extra barcode typed in the search box, exact only', async () => {
            const id = await product('Count barcoded');
            await pool.query("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, 'CNT-EXTRA-1')", [id]);
            try {
                expect((await api('get', '/items?q=CNT-EXTRA-1')).body.data.map((row) => row.item_key)).toEqual([`product:${id}`]);
                expect((await api('get', '/items?q=CNT-EXTRA')).body.data).toEqual([]);
            } finally {
                await pool.query('DELETE FROM products WHERE id=?', [id]);
            }
        });

        it('allows one open count, then another once it is posted', async () => {
            const first = await open();
            const second = await api('post', '/').send(createBody());
            expect(second.status).toBe(409);
            expect(second.body).toEqual({ success: false, code: 'STOCK_COUNT_ALREADY_OPEN', message: expect.any(String), data: { open_id: first.id } });
            await count(first, lineOf(first, keyOf.simple()), 10);
            await posted(first);
            const third = await api('post', '/').send(createBody());
            expect(third.status, JSON.stringify(third.body)).toBe(200);
            expect(third.body.data.id).not.toBe(first.id);
        });

        it('replays a retried create and refuses a reused key with a different request', async () => {
            await clearOpen();
            const body = createBody();
            const first = await api('post', '/').send(body);
            const again = await api('post', '/').send(body);
            expect(again.status).toBe(200);
            expect(again.body.data.id).toBe(first.body.data.id);
            expect((await pool.query('SELECT COUNT(*) AS n FROM stock_documents WHERE create_key=?', [body.request_key]))[0][0].n).toBe(1);
            for (const change of [{ reference: 'Other name' }, { groups: ['ingredients'] }, { groups: ['all'] }]) {
                const reused = await api('post', '/').send({ ...body, ...change });
                expect(reused.status).toBe(409);
                expect(reused.body.code).toBe('STOCK_COUNT_KEY_REUSED');
            }
            // The replay still works after the count is posted (the open-count check does not shadow it).
            await count(first.body.data, lineOf(first.body.data, keyOf.simple()), 10);
            await posted(first.body.data);
            const later = await api('post', '/').send(body);
            expect(later.body.data.id).toBe(first.body.data.id);
        });

        it('dates a count with the business date: optional, and only today is accepted', async () => {
            const counted = await open({ count_date: getBusinessDate() });
            expect(counted.count_date).toBe(getBusinessDate());
            await count(counted, lineOf(counted, keyOf.simple()), await stockOf(p.simple));
            await pool.query("UPDATE stock_documents SET doc_date='2020-01-01' WHERE id=?", [counted.id]);
            expect((await posted(counted)).count_date).toBe(getBusinessDate());
        });

        it('validates the request', async () => {
            await clearOpen();
            for (const bad of [{ groups: [] }, { groups: ['nonsense'] }, { groups: 'all' }, { count_date: '2026-02-30' }, { count_date: 'today' }, { count_date: '2020-01-01' },
                { request_key: 'short' }, { reference: 'x'.repeat(61) }]) {
                const res = await api('post', '/').send(createBody(bad));
                expect(res.status).toBe(400);
                expect(res.body.code).toBe('STOCK_COUNT_INVALID');
            }
            expect((await pool.query("SELECT COUNT(*) AS n FROM stock_documents WHERE doc_type='count' AND status='draft'"))[0][0].n).toBe(0);
        });

        // Purchases may receive an unlimited product (that starts tracking it); a count never lists one.
        it('keeps an unlimited product off the sheet: not in the groups, the search, a seeded sheet or an added line', async () => {
            const unlimited = await product('Count unlimited', { stock: null });
            try {
                expect((await api('get', '/groups')).body.data).toContainEqual({ key: `category:${cat}`, label: 'Count drinks', item_count: 2 });
                expect((await api('get', '/items?q=Count%20unlim')).body.data).toEqual([]);
                const counted = await open({ groups: ['all'] });
                expect(counted.lines.some((line) => line.item_key === `product:${unlimited}`)).toBe(false);
                const added = await api('post', `/${counted.id}/lines`).send({ item_key: `product:${unlimited}` });
                expect(added.status).toBe(400);
                expect(added.body.code).toBe('STOCK_COUNT_LINES_INVALID');
            } finally {
                await clearOpen();
                await pool.query('DELETE FROM products WHERE id=?', [unlimited]);
            }
        });

        it("seeds every eligible item for 'all'", async () => {
            const counted = await open({ groups: ['all'] });
            for (const itemKey of [keyOf.simple(), keyOf.linked(), keyOf.other(), keyOf.flour(), keyOf.sugar()]) lineOf(counted, itemKey);
        });

        it('refuses a count over the item cap and leaves nothing behind', async () => {
            await clearOpen();
            const bulk = (await pool.query("INSERT INTO categories(name,is_notes) VALUES ('Count bulk',0)"))[0].insertId;
            await pool.query('INSERT INTO products(name,price,stock,category_id) VALUES ?', [Array.from({ length: 1001 }, (_, i) => [`Bulk ${i}`, 1, 1, bulk])]);
            const res = await api('post', '/').send(createBody({ groups: [`category:${bulk}`] }));
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('STOCK_COUNT_INVALID');
            expect(res.body.message).toMatch(/fewer groups/);
            expect((await pool.query("SELECT COUNT(*) AS n FROM stock_documents WHERE doc_type='count' AND status='draft'"))[0][0].n).toBe(0);
            await pool.query('DELETE FROM products WHERE category_id=?', [bulk]);
        });

        it('respects the stock settings', async () => {
            try {
                await flags('0', '1');
                expect((await api('get', '/groups')).body.data.map((group) => group.key)).toEqual(['ingredients']);
                const none = await api('post', '/').send(createBody());
                expect(none.status).toBe(400);
                expect(none.body.code).toBe('STOCK_COUNT_INVALID');
                await flags('1', '0');
                expect((await api('get', '/groups')).body.data.map((group) => group.key)).not.toContain('ingredients');
                expect((await api('get', '/items?q=Count%20fl')).body.data).toEqual([]);
            } finally {
                await flags('1', '1');
            }
        });
    });

    describe('counting', () => {
        it('stays blind while it is a draft and keeps the saved unit', async () => {
            const counted = await open({ groups: [`category:${cat}`, 'ingredients'] });
            const flour = lineOf(counted, keyOf.flour());
            const saved = await save(counted, entry(flour, '2.5', kg), entry(lineOf(counted, keyOf.simple()), 4));
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            expect(saved.body.data.counted_count).toBe(2);
            expect(saved.body.data.lines.find((line) => line.id === flour.id)).toMatchObject({ qty: '2.500', unit_label: 'kg', unit_factor: '1000', counted_by_name: SEED.adminUser.name });
            const fetched = await api('get', `/${counted.id}`);
            expect(fetched.body.data.counted_count).toBe(2);
            const text = JSON.stringify([saved.body, fetched.body]);
            for (const word of ['expected', 'variance', 'counted_base', 'unit_cost']) expect(text).not.toContain(word);
            // The stored expectation exists; it is only ever sent by the review.
            expect((await dbLine(flour.id)).expected).not.toBeNull();
        });

        it('keeps expected and counted_at on a same-value retry, re-captures on a change, and clears on null', async () => {
            const counted = await open({ groups: [`category:${cat}`, 'ingredients'] });
            const line = lineOf(counted, keyOf.simple());
            await count(counted, line, 4);
            const first = await dbLine(line.id);
            expect(Number(first.expected)).toBe(await stockOf(p.simple));
            await sell(p.simple);
            await pool.query("UPDATE stock_document_lines SET counted_at = counted_at - INTERVAL 1 HOUR WHERE id=?", [line.id]);
            const backdated = await dbLine(line.id);
            await count(counted, line, '4.000'); // the same quantity again: a retry after a lost reply
            const retried = await dbLine(line.id);
            expect(retried.expected).toBe(first.expected);
            expect(retried.counted_at).toEqual(backdated.counted_at);
            await count(counted, line, 5);
            const recounted = await dbLine(line.id);
            expect(Number(recounted.expected)).toBe(await stockOf(p.simple));
            expect(Number(recounted.expected)).toBe(Number(first.expected) - 1);
            expect(recounted.counted_at.getTime()).toBeGreaterThan(backdated.counted_at.getTime());
            // A different unit is a new count too.
            const flour = lineOf(counted, keyOf.flour());
            await count(counted, flour, 2000, { label: 'g', factor: '1' });
            const grams = await dbLine(flour.id);
            await sell(p.recipe);
            await count(counted, flour, 2, kg);
            const inKg = await dbLine(flour.id);
            expect(Number(inKg.expected)).toBe(Number(grams.expected) - 200);
            const cleared = await save(counted, entry(line, null));
            expect(cleared.body.data.counted_count).toBe(1);
            expect(await dbLine(line.id)).toEqual({ qty: null, expected: null, counted_at: null, counted_by: null });
            await sell(p.simple); // restore nothing: the sale stays; later tests read the live stock
        });

        it('rejects malformed lines', async () => {
            const counted = await open();
            const line = lineOf(counted, keyOf.simple());
            const bad = async (changes) => (await save(counted, { ...entry(line, 1), ...changes })).body.code;
            expect(await bad({ qty: '-1' })).toBe('STOCK_COUNT_LINES_INVALID');
            expect(await bad({ qty: '1.0001' })).toBe('STOCK_COUNT_LINES_INVALID');
            expect(await bad({ qty: 'abc' })).toBe('STOCK_COUNT_LINES_INVALID');
            expect(await bad({ unit_label: 'crate' })).toBe('STOCK_COUNT_LINES_INVALID');
            expect(await bad({ unit_factor: '12' })).toBe('STOCK_COUNT_LINES_INVALID');
            expect(await bad({ id: 999999999 })).toBe('STOCK_COUNT_LINES_INVALID');
            expect((await save(counted, entry(line, 1), entry(line, 2))).body.code).toBe('STOCK_COUNT_LINES_INVALID');
            expect((await api('put', `/${counted.id}/lines`).send({ lines: [] })).body.code).toBe('STOCK_COUNT_LINES_INVALID');
            expect((await api('put', `/${counted.id}/lines`).send({ lines: Array.from({ length: 101 }, (_, i) => ({ id: i + 1 })) })).body.code).toBe('STOCK_COUNT_LINES_INVALID');
            expect((await dbLine(line.id)).qty).toBeNull();
        });

        it('adds an eligible item once and hands back the existing line after that', async () => {
            const counted = await open();
            expect(counted.lines.some((line) => line.item_key === keyOf.other())).toBe(false);
            const added = await api('post', `/${counted.id}/lines`).send({ item_key: keyOf.other() });
            expect(added.status, JSON.stringify(added.body)).toBe(200);
            expect(added.body.data.existing).toBe(false);
            expect(added.body.data.line).toMatchObject({ item_key: keyOf.other(), line_no: counted.lines.length + 1, qty: null, group_key: 'other' });
            const again = await api('post', `/${counted.id}/lines`).send({ item_key: keyOf.other() });
            expect(again.body.data).toMatchObject({ existing: true, line: { id: added.body.data.line.id } });
            expect((await api('post', `/${counted.id}/lines`).send({ item_key: `product:${p.recipe}` })).body.code).toBe('STOCK_COUNT_LINES_INVALID');
            expect((await api('post', `/${counted.id}/lines`).send({ item_key: 'junk' })).body.code).toBe('STOCK_COUNT_LINES_INVALID');
            expect((await api('get', `/${counted.id}`)).body.data.line_count).toBe(counted.lines.length + 1);
        });
    });

    describe('posting keeps what happened after the count', () => {
        it('simple stock: counted + (current - expected)', async () => {
            const counted = await open();
            const line = lineOf(counted, keyOf.simple());
            const before = await stockOf(p.simple);
            await count(counted, line, 4);
            await sell(p.simple, 2);
            expect(await stockOf(p.simple)).toBe(before - 2);
            const result = await posted(counted);
            expect(await stockOf(p.simple)).toBe(4 + (before - 2 - before));
            const done = lineOf(result, keyOf.simple());
            expect(done).toMatchObject({ expected_qty: `${before}.000`, counted_base_qty: '4.000', variance_qty: `${4 - before}.000`, unit_cost: '2.000', variance_value: `${(4 - before) * 2}.000` });
            const [[operation]] = await pool.query("SELECT kind FROM stock_operations WHERE request_key LIKE 'sdoc-%' ORDER BY id DESC LIMIT 1");
            expect(operation.kind).toBe('count');
        });

        it('linked product: the ledger balance and the product mirror both keep the later sale', async () => {
            const counted = await open();
            const line = lineOf(counted, keyOf.linked());
            const before = await balanceOf(p.linked.itemId);
            await count(counted, line, 5);
            await sell(p.linked.id, 3);
            expect(await balanceOf(p.linked.itemId)).toBe(before - 3);
            const versionBefore = (await pool.query('SELECT stock_version AS v FROM products WHERE id=?', [p.linked.id]))[0][0].v;
            const result = await posted(counted);
            const expectedAfter = 5 + (-3);
            expect(await balanceOf(p.linked.itemId)).toBe(expectedAfter);
            expect(await stockOf(p.linked.id)).toBe(expectedAfter);
            expect(Number((await pool.query('SELECT stock_version AS v FROM products WHERE id=?', [p.linked.id]))[0][0].v)).toBeGreaterThan(Number(versionBefore));
            expect(lineOf(result, keyOf.linked())).toMatchObject({ expected_qty: `${before}.000`, variance_qty: `${5 - before}.000`, unit_cost: '1.000' });
            const [[movement]] = await pool.query(
                "SELECT m.quantity FROM stock_movements m JOIN stock_operations o ON o.id=m.operation_id WHERE o.kind='count' AND m.stock_item_id=? ORDER BY m.id DESC LIMIT 1", [p.linked.itemId]);
            expect(Number(movement.quantity)).toBe(expectedAfter - (before - 3));
        });

        it('ingredient: the later usage still applies, variance is counted minus expected', async () => {
            const counted = await open({ groups: ['ingredients'] });
            const line = lineOf(counted, keyOf.flour());
            const before = await workingOf(p.flour);
            await count(counted, line, 6, kg);
            await sell(p.recipe);
            expect(await workingOf(p.flour)).toBe(before - 200);
            const result = await posted(counted);
            expect(await workingOf(p.flour)).toBe(6000 - 200);
            expect(lineOf(result, keyOf.flour())).toMatchObject({
                expected_qty: `${before}.000`, counted_base_qty: '6000.000', variance_qty: `${6000 - before}.000`, unit_cost: '0.002',
                variance_value: `${((6000 - before) * 0.002).toFixed(3)}`,
            });
            const [[movement]] = await pool.query("SELECT kind, source_label FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? ORDER BY id DESC LIMIT 1", [p.flour]);
            expect(movement).toEqual({ kind: 'count', source_label: 'Stock count' });
        });

        it('ingredient already in the stock ledger: same rule through the ledger balance', async () => {
            const id = await ingredient('Count ledger oil');
            const preview = await request(app).get(`/api/admin/stock/ingredients/${id}/activation`).set('Cookie', cookie);
            const activated = await request(app).post(`/api/admin/stock/ingredients/${id}/activate`).set('Cookie', cookie).send({ observation_token: preview.body.observation_token, request_key: key() });
            expect(activated.status, JSON.stringify(activated.body)).toBe(200);
            const recipe = await product('Count oil recipe', { stock: null });
            await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,100)', [recipe, id]);
            const first = await open({ groups: ['ingredients'] });
            await count(first, lineOf(first, `ingredient:${id}`), 8, kg);
            await posted(first);
            expect(await workingOf(id)).toBe(8000);
            const counted = await open({ groups: ['ingredients'] });
            await count(counted, lineOf(counted, `ingredient:${id}`), 6, kg);
            await sell(recipe, 2);
            expect(await workingOf(id)).toBe(7800);
            const result = await posted(counted);
            expect(await workingOf(id)).toBe(5800);
            const [[balance]] = await pool.query('SELECT CAST(b.quantity AS CHAR) AS quantity FROM ingredients i JOIN stock_balances b ON b.stock_item_id=i.stock_item_id WHERE i.id=?', [id]);
            expect(Number(balance.quantity)).toBe(5800);
            expect(lineOf(result, `ingredient:${id}`)).toMatchObject({ expected_qty: '8000.000', variance_qty: '-2000.000' });
        });

        it('gives up with BUSY when a sale holds the stock, posting nothing, and posts once it is free', async () => {
            const counted = await open();
            const line = lineOf(counted, keyOf.simple());
            await count(counted, line, 1);
            const before = await stockOf(p.simple);
            const holder = await pool.getConnection();
            try {
                await holder.beginTransaction();
                await holder.query('SELECT id FROM products WHERE id=? FOR UPDATE', [p.simple]);
                const busy = await post(counted);
                expect(busy.status).toBe(409);
                expect(busy.body.code).toBe('STOCK_COUNT_BUSY');
            } finally {
                await holder.rollback();
                holder.release();
            }
            expect(await stockOf(p.simple)).toBe(before);
            expect((await pool.query('SELECT status, post_key FROM stock_documents WHERE id=?', [counted.id]))[0][0]).toEqual({ status: 'draft', post_key: null });
            await posted(counted);
            expect(await stockOf(p.simple)).toBe(1);
        }, 20000);


        it('first count of an unknown balance: the count becomes the balance and there is no variance', async () => {
            const counted = await open({ groups: ['ingredients'] });
            const line = lineOf(counted, keyOf.sugar());
            expect((await pool.query('SELECT working_quantity_known AS k FROM ingredients WHERE id=?', [p.sugar]))[0][0].k).toBe(0);
            await count(counted, line, 5, kg);
            // The raw running amount is kept even though the balance is unknown; it is never reported as expected.
            expect(Number((await dbLine(line.id)).expected)).toBe(0);
            expect(lineOf((await api('get', `/${counted.id}/review`)).body.data, keyOf.sugar())).toMatchObject({ expected_qty: null, variance_qty: null, variance_value: null });
            const result = await posted(counted);
            expect(await workingOf(p.sugar)).toBe(5000);
            expect(lineOf(result, keyOf.sugar())).toMatchObject({ expected_qty: null, counted_base_qty: '5000.000', variance_qty: null, variance_value: null });
        });

        it('an unknown balance still moves with usage: 5 kg counted, 200 g used before posting, 4.8 kg posted', async () => {
            const id = await ingredient('Count new stew');
            const recipe = await product('Count stew recipe', { stock: null });
            await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,200)', [recipe, id]);
            const counted = await open({ groups: ['ingredients'] });
            await count(counted, lineOf(counted, `ingredient:${id}`), 5, kg);
            await sell(recipe);
            expect(await workingOf(id)).toBe(-200);
            const review = (await api('get', `/${counted.id}/review`)).body.data;
            expect(review.lines.find((line) => line.item_key === `ingredient:${id}`)).toMatchObject({ counted_base_qty: '5000.000', expected_qty: null, variance_qty: null, variance_value: null });
            const result = await posted(counted);
            expect(await workingOf(id)).toBe(4800);
            expect(lineOf(result, `ingredient:${id}`)).toMatchObject({ expected_qty: null, variance_qty: null, variance_value: null });
        });

        it('linked product with an unknown balance: a sale between count and post still applies', async () => {
            const item = (await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state,availability_policy) VALUES ('Count unknown linked','count','unit','active','estimate')"))[0].insertId;
            await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) VALUES (?,20,0)', [item]);
            const id = await product('Count unknown linked', { stock: null });
            await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [id, item]);
            const counted = await open();
            await count(counted, lineOf(counted, `product:${id}`), 5);
            await sell(id, 3);
            expect(await balanceOf(item)).toBe(17);
            const result = await posted(counted);
            expect(await balanceOf(item)).toBe(2);
            expect(await stockOf(id)).toBe(2);
            expect(lineOf(result, `product:${id}`)).toMatchObject({ expected_qty: null, variance_qty: null, variance_value: null });
        });

        it('refuses a difference value too large to record and posts nothing', async () => {
            const big = await product('Count huge cost', { stock: 10, cost: 99999999 });
            const counted = await open();
            await count(counted, lineOf(counted, `product:${big}`), 9000000);
            const res = await post(counted);
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ code: 'STOCK_COUNT_VALUE_TOO_LARGE', message: 'A difference value is too large to record. Check the quantities and unit costs.' });
            expect(await stockOf(big)).toBe(10);
            expect((await pool.query('SELECT status, post_key FROM stock_documents WHERE id=?', [counted.id]))[0][0]).toEqual({ status: 'draft', post_key: null });
        });

        describe('an intervening count somewhere else', () => {
            // Backdate the other count so a re-save (counted_at = now) is clearly after it.
            const backdate = async (sql, params) => { await pool.query(sql, params); };

            it('ingredient: refuses, posts nothing, and posts after the line is counted again', async () => {
                const id = await ingredient('Count recount flour');
                await setIngredient(id, 7);
                const counted = await open({ groups: ['ingredients'] });
                const line = lineOf(counted, `ingredient:${id}`);
                await count(counted, line, 3, kg);
                await setIngredient(id, 9); // counted elsewhere after this sheet's line
                const res = await post(counted);
                expect(res.status).toBe(409);
                expect(res.body.code).toBe('STOCK_COUNT_RECOUNT_NEEDED');
                expect(res.body.message).toBe('Count recount flour was counted somewhere else after it was counted here. Enter its quantity again.');
                expect(await workingOf(id)).toBe(9000);
                expect((await pool.query('SELECT status, post_key FROM stock_documents WHERE id=?', [counted.id]))[0][0]).toEqual({ status: 'draft', post_key: null });
                await backdate("UPDATE stock_movements SET occurred_at = occurred_at - INTERVAL 1 HOUR WHERE movement_type='ingredient' AND kind='count' AND ingredient_id=?", [id]);
                await count(counted, line, 4, kg);
                await posted(counted);
                expect(await workingOf(id)).toBe(4000);
            });
        });

        it('posts 0, flagged, when the later sales exceed the count', async () => {
            const small = await product('Count clamp', { stock: 5 });
            const counted = await open({ groups: [`category:${cat}`] });
            await count(counted, lineOf(counted, `product:${small}`), 1);
            await sell(small, 3);
            expect(await stockOf(small)).toBe(2);
            await posted(counted);
            expect(await stockOf(small)).toBe(0);
            const [[header]] = await pool.query("SELECT stock_result FROM stock_documents WHERE id=?", [counted.id]);
            const result = typeof header.stock_result === 'string' ? JSON.parse(header.stock_result) : header.stock_result;
            expect(result.lines.find((line) => line.item_key === `product:${small}`)).toMatchObject({ counted: '1.000000', expected: '5.000000', current: '2.000000', adjusted: '0.000000', clamped: true });
            expect(result.lines.filter((line) => line.clamped)).toHaveLength(1);
        });

        it('skips uncounted lines, sets the header total and audits', async () => {
            const counted = await open({ groups: [`category:${cat}`, 'other'] });
            const untouched = await stockOf(p.other);
            const before = await stockOf(p.simple);
            await count(counted, lineOf(counted, keyOf.simple()), before - 1);
            const result = await posted(counted);
            expect(await stockOf(p.other)).toBe(untouched);
            expect(result).toMatchObject({ status: 'posted', counted_count: 1, posted_by_name: SEED.adminUser.name });
            expect(lineOf(result, keyOf.other())).toMatchObject({ qty: null, expected_qty: null, variance_value: null });
            expect(Number((await pool.query('SELECT total FROM stock_documents WHERE id=?', [counted.id]))[0][0].total)).toBe(-2);
            expect((await pool.query("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='stock_count_posted' AND entity_id=?", [String(counted.id)]))[0][0].n).toBe(1);
        });

        it('replays the same key, refuses another key, and never applies twice', async () => {
            const counted = await open();
            const line = lineOf(counted, keyOf.simple());
            await count(counted, line, 3);
            const requestKey = key();
            const first = await post(counted, requestKey);
            expect(first.status, JSON.stringify(first.body)).toBe(200);
            const stock = await stockOf(p.simple);
            const again = await post(counted, requestKey);
            expect(again.status).toBe(200);
            expect(again.body.data).toEqual(first.body.data);
            expect(await stockOf(p.simple)).toBe(stock);
            const other = await post(counted, key());
            expect(other.status).toBe(409);
            expect(other.body.code).toBe('STOCK_COUNT_NOT_DRAFT');
            const both = await Promise.all([post(counted, requestKey), post(counted, requestKey)]);
            expect(both.map((res) => res.status)).toEqual([200, 200]);
            expect(await stockOf(p.simple)).toBe(stock);
        });

        it('refuses to post nothing, and stays a draft', async () => {
            const counted = await open();
            const res = await post(counted);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('STOCK_COUNT_EMPTY');
            const [[header]] = await pool.query('SELECT status, post_key FROM stock_documents WHERE id=?', [counted.id]);
            expect(header).toEqual({ status: 'draft', post_key: null });
        });

        it('refuses a counted line whose item is no longer eligible, names it, and posts once it is cleared', async () => {
            const gone = await product('Count retired item', { stock: 9 });
            const counted = await open();
            const line = lineOf(counted, `product:${gone}`);
            await count(counted, line, 3);
            await count(counted, lineOf(counted, keyOf.simple()), 2);
            await pool.query('UPDATE products SET is_active=0 WHERE id=?', [gone]);
            const simpleBefore = await stockOf(p.simple);
            const res = await post(counted);
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('STOCK_COUNT_ITEM_UNSUPPORTED');
            expect(res.body.message).toContain('Count retired item');
            expect(res.body.message).toContain('Clear its quantity to skip it');
            expect(await stockOf(p.simple)).toBe(simpleBefore);
            expect(await stockOf(gone)).toBe(9);
            expect((await pool.query('SELECT post_key FROM stock_documents WHERE id=?', [counted.id]))[0][0].post_key).toBeNull();
            await count(counted, line, null);
            await posted(counted);
            expect(await stockOf(gone)).toBe(9);
        });

        it('refuses line saves, added lines and deletes once the count is posted or posting has started', async () => {
            const counted = await open();
            const line = lineOf(counted, keyOf.simple());
            await pool.query("UPDATE stock_documents SET post_key='in-flight' WHERE id=?", [counted.id]);
            for (const res of [await save(counted, entry(line, 1)), await api('post', `/${counted.id}/lines`).send({ item_key: keyOf.other() }), await api('delete', `/${counted.id}`)]) {
                expect(res.status).toBe(409);
                expect(res.body.code).toBe('STOCK_COUNT_NOT_DRAFT');
            }
            await pool.query('UPDATE stock_documents SET post_key=NULL WHERE id=?', [counted.id]);
            await count(counted, line, 3);
            await posted(counted);
            for (const res of [await save(counted, entry(line, 1)), await api('delete', `/${counted.id}`)]) {
                expect(res.status).toBe(409);
                expect(res.body.code).toBe('STOCK_COUNT_NOT_DRAFT');
            }
            expect((await api('get', '/99999999')).status).toBe(404);
            expect((await api('get', '/99999999')).body.code).toBe('STOCK_COUNT_NOT_FOUND');
        });

        it('deletes a draft with its lines', async () => {
            const counted = await open();
            const res = await api('delete', `/${counted.id}`);
            expect(res.body).toEqual({ success: true, data: { deleted: true } });
            expect((await pool.query('SELECT id FROM stock_document_lines WHERE document_id=?', [counted.id]))[0]).toHaveLength(0);
            expect((await api('get', `/${counted.id}`)).status).toBe(404);
        });
    });

    describe('review and list', () => {
        it('reveals expected and variance, sorts by value, and totals shortage and surplus', async () => {
            const freeCost = await product('Count no cost', { stock: 6, cost: 0 });
            const counted = await open({ groups: [`category:${cat}`, 'ingredients'] });
            const simple = await stockOf(p.simple);
            const linked = await balanceOf(p.linked.itemId);
            const flour = await workingOf(p.flour);
            await count(counted, lineOf(counted, keyOf.simple()), simple - 3); // -3 x 2.000 = -6.000
            await count(counted, lineOf(counted, keyOf.linked()), linked + 5); // +5 x 1.000 = +5.000
            await count(counted, lineOf(counted, keyOf.flour()), flour / 1000, kg); // no variance
            await count(counted, lineOf(counted, `product:${freeCost}`), 1); // cost unknown
            const res = await api('get', `/${counted.id}/review`);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const { lines, totals } = res.body.data;
            const counts = lines.filter((line) => line.counted_base_qty != null);
            expect(counts.map((line) => line.item_key)).toEqual([keyOf.simple(), keyOf.linked(), keyOf.flour(), `product:${freeCost}`]);
            expect(counts[0]).toMatchObject({ expected_qty: `${simple}.000`, variance_qty: '-3.000', unit_cost: '2.000', variance_value: '-6.000', group_label: 'Count drinks' });
            expect(counts[3]).toMatchObject({ variance_qty: '-5.000', unit_cost: null, variance_value: null });
            expect(lines.slice(counts.length).every((line) => line.counted_base_qty === null && line.variance_value === null)).toBe(true);
            expect(totals).toEqual({ counted_count: 4, uncounted_count: lines.length - 4, shortage_value: '-6.000', surplus_value: '5.000', net_value: '-1.000' });
            expect(res.body.data.lines.length).toBe(counted.lines.length);
        });

        it('lists counts newest first with their figures and pages with a cursor', async () => {
            await clearOpen();
            const before = (await api('get', '/')).body.data.length;
            const older = await open();
            await count(older, lineOf(older, keyOf.simple()), await stockOf(p.simple) - 1);
            await posted(older);
            const draft = await open();
            const all = await api('get', '/?limit=30');
            expect(all.status).toBe(200);
            expect(all.body.data.map((row) => row.id).slice(0, 2)).toEqual([draft.id, older.id]);
            expect(all.body.data[0]).toMatchObject({ status: 'draft', counted_count: 0, variance_value: null, posted_at: null, created_by_name: SEED.adminUser.name, count_date: getBusinessDate() });
            expect(all.body.data[1]).toMatchObject({ status: 'posted', counted_count: 1, variance_value: '-2.000' });
            expect(all.body.data.length).toBe(before + 2);
            const page = await api('get', '/?limit=1');
            expect(page.body.data.map((row) => row.id)).toEqual([draft.id]);
            expect(page.body.next_before_id).toBe(draft.id);
            const next = await api('get', `/?limit=1&before_id=${page.body.next_before_id}`);
            expect(next.body.data.map((row) => row.id)).toEqual([older.id]);
            expect((await api('get', '/?status=posted')).body.data.every((row) => row.status === 'posted')).toBe(true);
            expect((await api('get', '/?status=nonsense')).status).toBe(400);
        });
    });

    it('keeps the routes admin only', async () => {
        const cashier = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        expect((await request(app).get('/api/admin/stock-counts').set('Cookie', cashier)).status).toBe(403);
    });
});
