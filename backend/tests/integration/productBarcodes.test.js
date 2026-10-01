// integration/productBarcodes.test.js — a product has a main barcode plus extra barcodes; every code is unique across
// products and every exact match (POS lookup, scale labels, catalog search) finds a product by either kind.
const request = require('supertest');
const xlsx = require('xlsx');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('product barcodes', () => {
    let adminCookie;
    let cashierCookie;

    beforeAll(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
    });
    afterAll(() => pool.end());

    const create = (body) => request(app).post('/api/admin/products').set('Cookie', adminCookie).send({ price: '1.00', ...body });
    const update = (body) => request(app).put('/api/admin/products').set('Cookie', adminCookie).send(body);
    const extrasOf = async (id) => (await pool.query('SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY id', [id]))[0].map(row => row.barcode);
    const mainOf = async (id) => (await pool.query('SELECT barcode FROM products WHERE id = ?', [id]))[0][0].barcode;
    const makeProduct = async (name, barcode, extras = [], { active = 1 } = {}) => {
        const [product] = await pool.query(
            'INSERT INTO products (name, price, tax_rate, barcode, is_active, is_available, is_bundle) VALUES (?, 1, 0, ?, ?, 1, 0)', [name, barcode, active]);
        for (const code of extras) await pool.query('INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)', [product.insertId, code]);
        return product.insertId;
    };
    const lookup = (barcode) => request(app).get('/api/pos/product_lookup').query({ barcode, sales_context: 'register' }).set('Cookie', cashierCookie);
    const adminList = async (search) => (await request(app).get('/api/admin/products').query({ search }).set('Cookie', adminCookie)).body.products;

    describe('admin product API', () => {
        test('create and read round-trip the extra barcodes in the order entered, trimmed, empty entries dropped', async () => {
            const res = await create({ name: 'RT Cola', barcode: '  RT-MAIN  ', extra_barcodes: [' RT-X1 ', '', '   ', 'RT-X2'] });
            expect(res.statusCode).toBe(200);
            expect(await mainOf(res.body.id)).toBe('RT-MAIN');
            expect(await extrasOf(res.body.id)).toEqual(['RT-X1', 'RT-X2']);

            const [listed] = (await adminList('RT Cola')).filter(row => row.id === res.body.id);
            expect(listed.extra_barcodes).toEqual(['RT-X1', 'RT-X2']);
            expect(listed.barcode).toBe('RT-MAIN');
        });

        test('the product list gives every product its extras with one extra query, [] when it has none', async () => {
            const withExtras = await makeProduct('List with', 'LS-MAIN-1', ['LS-X1', 'LS-X2']);
            const without = await makeProduct('List without', 'LS-MAIN-2');
            const spy = vi.spyOn(pool, 'query');
            let barcodeQueries;
            try {
                const res = await request(app).get('/api/admin/products').query({ search: 'List w' }).set('Cookie', adminCookie);
                barcodeQueries = spy.mock.calls.filter(([sql]) => /FROM product_barcodes WHERE product_id IN/.test(String(sql?.sql ?? sql)));
                const byId = new Map(res.body.products.map(row => [row.id, row]));
                expect(byId.get(withExtras).extra_barcodes).toEqual(['LS-X1', 'LS-X2']);
                expect(byId.get(without).extra_barcodes).toEqual([]);
            } finally {
                spy.mockRestore();
            }
            expect(barcodeQueries).toHaveLength(1);
        });

        test('an update that omits extra_barcodes keeps them, [] clears them, a new list replaces them, and a resend changes nothing', async () => {
            const id = (await create({ name: 'Upd Cola', barcode: 'UP-MAIN', extra_barcodes: ['UP-X1', 'UP-X2'] })).body.id;

            expect((await update({ id, name: 'Upd Cola renamed', barcode: 'UP-MAIN-2' })).statusCode).toBe(200);
            expect(await extrasOf(id)).toEqual(['UP-X1', 'UP-X2']);
            expect(await mainOf(id)).toBe('UP-MAIN-2');

            const replacement = { id, extra_barcodes: ['UP-X2', 'UP-X3'] };
            expect((await update(replacement)).statusCode).toBe(200);
            expect(await extrasOf(id)).toEqual(['UP-X2', 'UP-X3']);
            // A reply lost in transit is a full replay of the same form: it ends in the same state.
            expect((await update(replacement)).statusCode).toBe(200);
            expect(await extrasOf(id)).toEqual(['UP-X2', 'UP-X3']);
            expect(await mainOf(id)).toBe('UP-MAIN-2');

            expect((await update({ id, extra_barcodes: [] })).statusCode).toBe(200);
            expect(await extrasOf(id)).toEqual([]);
            expect(await mainOf(id)).toBe('UP-MAIN-2');
        });

        test('a product can swap which code is main and which is extra in one save', async () => {
            const id = (await create({ name: 'Swap Cola', barcode: 'SW-A', extra_barcodes: ['SW-B'] })).body.id;
            expect((await update({ id, barcode: 'SW-B', extra_barcodes: ['SW-A'] })).statusCode).toBe(200);
            expect(await mainOf(id)).toBe('SW-B');
            expect(await extrasOf(id)).toEqual(['SW-A']);
        });

        test('an update of an unknown product answers 404 and writes nothing', async () => {
            const res = await update({ id: 987654, extra_barcodes: ['GHOST-1'] });
            expect(res.statusCode).toBe(404);
            expect((await pool.query("SELECT 1 FROM product_barcodes WHERE barcode = 'GHOST-1'"))[0]).toHaveLength(0);
        });

        test('deleting a product row deletes its extra barcodes', async () => {
            const id = await makeProduct('Cascade Cola', 'CA-MAIN', ['CA-X1', 'CA-X2']);
            await pool.query('DELETE FROM products WHERE id = ?', [id]);
            expect(await extrasOf(id)).toEqual([]);
            expect((await pool.query("SELECT 1 FROM product_barcodes WHERE barcode IN ('CA-X1','CA-X2')"))[0]).toHaveLength(0);
        });

        test.each([
            ['an extra over 50 characters', { extra_barcodes: ['E'.repeat(51)] }],
            ['a main barcode over 50 characters', { barcode: 'M'.repeat(51) }],
            ['more than 20 extras', { extra_barcodes: Array.from({ length: 21 }, (_, i) => `TOOMANY-${i}`) }],
            ['the main repeated as an extra', { barcode: 'DUP-MAIN', extra_barcodes: ['dup-main'] }],
            ['an extra repeated', { extra_barcodes: ['DUP-X', 'Dup-X'] }],
            ['a list that is not a list', { extra_barcodes: 'DUP-X' }],
            ['an entry that is not text', { extra_barcodes: [12345] }],
        ])('create answers 400 PRODUCT_BARCODE_INVALID for %s and saves nothing', async (_label, fields) => {
            const name = `Invalid ${_label}`;
            const res = await create({ name, ...fields });
            expect(res.statusCode).toBe(400);
            expect(res.body.code).toBe('PRODUCT_BARCODE_INVALID');
            expect((await pool.query('SELECT 1 FROM products WHERE name = ?', [name]))[0]).toHaveLength(0);
        });

        test('exactly 20 extras of exactly 50 characters are accepted', async () => {
            const extras = Array.from({ length: 20 }, (_, i) => `${i}`.padStart(2, '0').padEnd(50, 'X'));
            const res = await create({ name: 'Max Cola', barcode: 'M'.repeat(50), extra_barcodes: extras });
            expect(res.statusCode).toBe(200);
            expect(await extrasOf(res.body.id)).toEqual(extras);
        });

        test('update answers 400 PRODUCT_BARCODE_INVALID, including a new main that equals the product\'s own extra, and changes nothing', async () => {
            const id = (await create({ name: 'Upd invalid', barcode: 'UI-MAIN', extra_barcodes: ['UI-X1'] })).body.id;
            for (const body of [
                { id, extra_barcodes: ['E'.repeat(51)] },
                { id, extra_barcodes: ['UI-MAIN'] },
                { id, barcode: 'UI-X1' },
                { id, extra_barcodes: ['A', 'a'] },
            ]) {
                const res = await update(body);
                expect(res.statusCode, JSON.stringify(body)).toBe(400);
                expect(res.body.code).toBe('PRODUCT_BARCODE_INVALID');
            }
            expect(await mainOf(id)).toBe('UI-MAIN');
            expect(await extrasOf(id)).toEqual(['UI-X1']);
        });

        describe('create with a code another product holds', () => {
            beforeAll(async () => {
                await makeProduct('Holder One', 'TK-MAIN-1', ['TK-EXTRA-1']);
                await create({ name: 'Holder Two', barcode: 'TK-MAIN-2', extra_barcodes: ['TK-EXTRA-2'] });
            });
            // the message repeats the code as the admin typed it, whatever its case
            test.each([
                ['an extra held by another main', { extra_barcodes: ['tk-main-1'] }, 'tk-main-1', 'Holder One'],
                ['an extra held by another extra', { extra_barcodes: ['TK-EXTRA-1'] }, 'TK-EXTRA-1', 'Holder One'],
                ['a main held by another main', { barcode: 'TK-MAIN-1' }, 'TK-MAIN-1', 'Holder One'],
                ['a main held by another extra', { barcode: 'TK-EXTRA-2' }, 'TK-EXTRA-2', 'Holder Two'],
            ])('answers 409 PRODUCT_BARCODE_TAKEN naming the product for %s and saves nothing', async (label, fields, code, holder) => {
                const res = await create({ name: `Taker ${label}`, ...fields });
                expect(res.statusCode).toBe(409);
                expect(res.body.code).toBe('PRODUCT_BARCODE_TAKEN');
                expect(res.body.message).toBe(`Barcode ${code} is already used by ${holder}.`);
                expect((await pool.query('SELECT 1 FROM products WHERE name = ?', [`Taker ${label}`]))[0]).toHaveLength(0);
            });
        });

        describe('update to a code another product holds', () => {
            let id;
            beforeAll(async () => {
                await makeProduct('Owner One', 'UT-MAIN-1', ['UT-EXTRA-1']);
                id = (await create({ name: 'Updater', barcode: 'UT-MAIN-2', extra_barcodes: ['UT-EXTRA-2'] })).body.id;
            });
            test.each([
                ['a main held by another main', { barcode: 'UT-MAIN-1' }, 'UT-MAIN-1'],
                ['a main held by another extra', { barcode: 'UT-EXTRA-1' }, 'UT-EXTRA-1'],
                ['an extra held by another main', { extra_barcodes: ['UT-MAIN-1'] }, 'UT-MAIN-1'],
                ['one of several extras held by another extra', { extra_barcodes: ['UT-FREE', 'UT-EXTRA-1'] }, 'UT-EXTRA-1'],
            ])('answers 409 PRODUCT_BARCODE_TAKEN for %s and leaves the product as it was', async (_label, fields, code) => {
                const res = await update({ id, ...fields });
                expect(res.statusCode).toBe(409);
                expect(res.body.code).toBe('PRODUCT_BARCODE_TAKEN');
                expect(res.body.message).toBe(`Barcode ${code} is already used by Owner One.`);
                expect(await mainOf(id)).toBe('UT-MAIN-2');
                expect(await extrasOf(id)).toEqual(['UT-EXTRA-2']);
            });
        });

        test('two saves racing for the same code end with exactly one holder and one 409', async () => {
            const results = await Promise.all([
                create({ name: 'Racer A', barcode: 'RACE-MAIN-A', extra_barcodes: ['RACE-X'] }),
                create({ name: 'Racer B', barcode: 'RACE-MAIN-B', extra_barcodes: ['RACE-X'] }),
            ]);
            expect(results.map(res => res.statusCode).sort()).toEqual([200, 409]);
            expect(results.find(res => res.statusCode === 409).body.code).toBe('PRODUCT_BARCODE_TAKEN');
            expect((await pool.query("SELECT 1 FROM product_barcodes WHERE barcode = 'RACE-X'"))[0]).toHaveLength(1);
            const loser = results[0].statusCode === 409 ? 'Racer A' : 'Racer B';
            expect((await pool.query('SELECT 1 FROM products WHERE name = ?', [loser]))[0]).toHaveLength(0);
        });

        test('admin search finds a product by part of an extra barcode', async () => {
            const id = await makeProduct('Searchable', 'SR-MAIN', ['SR-EXTRA-98765']);
            const found = await adminList('EXTRA-987');
            expect(found.map(row => row.id)).toContain(id);
            expect((await adminList('EXTRA-98766')).map(row => row.id)).not.toContain(id);
        });

        test('a batch create treats a code that is another product\'s extra as already used', async () => {
            const holder = await makeProduct('Batch holder', 'BT-MAIN', ['BT-EXTRA']);
            const res = await request(app).post('/api/admin/products/batch').set('Cookie', adminCookie)
                .send({ category_id: SEED.category.id, products: [
                    { name: 'Batch free', price: '1.00', barcode: 'BT-FREE' },
                    { name: 'Batch taken', price: '1.00', barcode: 'bt-extra' },
                ] });
            expect(res.statusCode).toBe(409);
            expect(res.body.row_errors).toEqual([expect.objectContaining({ row: 1, field: 'barcode' })]);
            expect((await pool.query("SELECT 1 FROM products WHERE name IN ('Batch free', 'Batch taken')"))[0]).toHaveLength(0);
            expect(await extrasOf(holder)).toEqual(['BT-EXTRA']);

            const ok = await request(app).post('/api/admin/products/batch').set('Cookie', adminCookie)
                .send({ category_id: SEED.category.id, products: [{ name: 'Batch free', price: '1.00', barcode: 'BT-FREE' }] });
            expect(ok.statusCode).toBe(200);
        });

        test('batch create and import treat an accent or case variant of a held code as the same code', async () => {
            await makeProduct('Accent holder', 'AC-MAIN-É', ['CAFÉ-BT', 'CAFÉ-IM']);
            const batch = await request(app).post('/api/admin/products/batch').set('Cookie', adminCookie)
                .send({ category_id: SEED.category.id, products: [
                    { name: 'Accent batch extra', price: '1.00', barcode: 'cafe-bt' },
                    { name: 'Accent batch main', price: '1.00', barcode: 'ac-main-e' },
                ] });
            expect(batch.statusCode).toBe(409);
            expect(batch.body.row_errors.map(error => error.row)).toEqual([0, 1]);

            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{ Name: '_import_accent_category' }]), 'Categories');
            xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([
                { Name: 'Accent import taken', Category: '_import_accent_category', Price: 2, Barcode: 'CAFE-IM' },
                { Name: 'Accent import free', Category: '_import_accent_category', Price: 2, Barcode: 'CAFE-FREE' },
            ]), 'Products');
            const imported = await request(app).post('/api/admin/import/catalog').set('Cookie', adminCookie)
                .attach('file', xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'catalog.xlsx');
            expect(imported.statusCode).toBe(200);
            expect(imported.body.summary).toMatchObject({ products_imported: 1, products_skipped: 1 });
        });

        test('a catalog import skips a product whose barcode is another product\'s extra', async () => {
            await makeProduct('Import holder', 'IM-MAIN', ['IM-EXTRA']);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{ Name: '_import_barcode_category' }]), 'Categories');
            xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([
                { Name: 'Imported taken', Category: '_import_barcode_category', Price: 2, Barcode: 'im-extra' },
                { Name: 'Imported free', Category: '_import_barcode_category', Price: 2, Barcode: 'IM-FREE' },
            ]), 'Products');
            const imported = await request(app).post('/api/admin/import/catalog').set('Cookie', adminCookie)
                .attach('file', xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'catalog.xlsx');
            expect(imported.statusCode).toBe(200);
            expect(imported.body.summary).toMatchObject({ products_imported: 1, products_skipped: 1 });
            expect((await pool.query("SELECT name FROM products WHERE name IN ('Imported taken','Imported free')"))[0].map(row => row.name)).toEqual(['Imported free']);
        });
    });

    describe('POS lookup and catalog', () => {
        test('product_lookup finds a product by an extra barcode and by its main barcode', async () => {
            const id = await makeProduct('Lookup Cola', 'LK-MAIN', ['LK-EXTRA-1', 'LK-EXTRA-2']);
            for (const code of ['LK-EXTRA-1', 'lk-extra-2', 'LK-MAIN']) {
                const res = await lookup(code);
                expect(res.statusCode, code).toBe(200);
                expect(res.body.product, code).toMatchObject({ id, name: 'Lookup Cola', barcode: 'LK-MAIN' });
                expect(res.body.scale_total_cents, code).toBeNull();
            }
            expect((await lookup('LK-NOBODY')).body.product).toBeNull();
        });

        test('product_lookup does not return an inactive product found by an extra barcode', async () => {
            await makeProduct('Retired Cola', 'RT-LK-MAIN', ['RT-LK-EXTRA'], { active: 0 });
            expect((await lookup('RT-LK-EXTRA')).body.product).toBeNull();
        });

        test('a catalog search finds a product by an extra barcode typed exactly, not by part of it, and never ships extras', async () => {
            const id = await makeProduct('Findable Cola', 'FD-MAIN', ['FD-EXTRA-424242']);
            const search = (text) => request(app).get('/api/pos/products').query({ search: text, sales_context: 'register' }).set('Cookie', cashierCookie);
            const exact = await search('FD-EXTRA-424242');
            expect(exact.body.products.map(row => row.id)).toContain(id);
            expect(exact.body.products.every(row => !('extra_barcodes' in row))).toBe(true);
            expect((await search('FD-EXTRA-4242')).body.products.map(row => row.id)).not.toContain(id);
            // the main barcode keeps its substring match
            expect((await search('FD-MAI')).body.products.map(row => row.id)).toContain(id);
        });

        describe('scale labels', () => {
            afterEach(async () => { await pool.query("DELETE FROM products WHERE name LIKE 'Scale %'"); });
            // 0100000040591: item code 100000, total 4059. 2000010040599: item codes 000010, 200001, 2000010, 00010, total 4059.
            test.each(['0100000040591', '100000040591'])('resolves label %s through an item code kept as an extra barcode', async (label) => {
                const id = await makeProduct('Scale extra beef', 'SC-MAIN', ['100000']);
                const res = await lookup(label);
                expect(res.body.product).toMatchObject({ id, name: 'Scale extra beef', barcode: 'SC-MAIN' });
                expect(res.body.scale_total_cents).toBe(4059);
            });

            test('a product holding two readings of one label (main and extra) is not ambiguous', async () => {
                const id = await makeProduct('Scale both beef', '000010', ['200001']);
                const res = await lookup('2000010040599');
                expect(res.body.product).toMatchObject({ id, name: 'Scale both beef' });
                expect(res.body.scale_total_cents).toBe(4059);
            });

            test('does not guess between a product holding one reading as its main and another holding a competing reading as an extra', async () => {
                const first = await makeProduct('Scale main beef', '000010');
                const second = await makeProduct('Scale extra mutton', 'SC-OTHER', ['200001']);
                const res = await lookup('2000010040599');
                expect(res.statusCode).toBe(200);
                expect(res.body.product).toBeNull();
                expect(res.body.scale_total_cents).toBeNull();
            });

            test('an inactive product holding a reading as an extra still blocks the other readings', async () => {
                const retired = await makeProduct('Scale retired', 'SC-RETIRED', ['000010'], { active: 0 });
                const active = await makeProduct('Scale active', '200001');
                expect((await lookup('2000010040599')).body.product).toBeNull();
            });

            test('a product holding the whole label as an extra barcode wins over item-code readings and gets no price from the label', async () => {
                const reading = await makeProduct('Scale reading', '100000');
                const exact = await makeProduct('Scale exact', 'SC-EXACT', ['0100000040591']);
                const res = await lookup('0100000040591');
                expect(res.body.product).toMatchObject({ id: exact, name: 'Scale exact' });
                expect(res.body.scale_total_cents).toBeNull();
            });
        });
    });
});
