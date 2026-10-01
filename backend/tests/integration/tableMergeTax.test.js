const { tableActionIntent } = require('../fixtures/tableActionIntent');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('table merge saved-tax boundary', () => {
    let cookie;
    const burger = { id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 };
    const post = (path, body) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const ok = response => {
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        return response.body;
    };
    const save = async (tableId, cart = [burger], money = [5, 0.8, 5.8], extra = {}) => ok(await post('table_order', {
        table_id: tableId, cart, subtotal: money[0], tax: money[1], total: money[2], ...extra
    })).invoice_id;
    const merge = async () => post('tables/transfer', await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'merge' }));
    const bill = async invoiceId => {
        const [[order]] = await pool.query('SELECT * FROM orders WHERE invoice_id=?', [invoiceId]);
        const [items] = await pool.query('SELECT * FROM order_items WHERE invoice_id=? ORDER BY id', [invoiceId]);
        return { order, items };
    };
    const expectMoney = (order, subtotal, tax, total) => {
        expect([order.subtotal, order.tax, order.total].map(Number)).toEqual([subtotal, tax, total]);
    };
    const state = async () => {
        const [orders] = await pool.query('SELECT * FROM orders ORDER BY invoice_id');
        const [items] = await pool.query('SELECT * FROM order_items ORDER BY id');
        const [tables] = await pool.query('SELECT * FROM restaurant_tables ORDER BY id');
        const [audits] = await pool.query("SELECT * FROM audit_events WHERE event_type='table_merge' ORDER BY id");
        return { orders, items, tables, audits };
    };
    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number }))
            .headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    it('keeps two saved 16% bills at 11.60 after catalog tax becomes 8%', async () => {
        await save(1);
        const target = await save(2);
        await pool.query('UPDATE products SET tax_rate=8 WHERE id=1');

        ok(await merge());

        const { order, items } = await bill(target);
        expectMoney(order, 10, 1.6, 11.6);
        expect(items).toHaveLength(1);
        expect([items[0].quantity, items[0].tax_rate, items[0].tax_amount].map(Number)).toEqual([2, 16, 1.6]);
        expect(items[0].jofotara_tax_category).toBe('S');
    });

    it('keeps distinct saved rates for the same product through merge, reload, save and payment', async () => {
        ok(await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie)
            .send({ user_id: SEED.adminUser.id, starting_cash: 20 }));
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.adminUser.id]);
        await save(1);
        await pool.query('UPDATE products SET tax_rate=8 WHERE id=1');
        const target = await save(2, [{ ...burger, tax_rate: 8 }], [5, 0.4, 5.4]);
        await pool.query("UPDATE products SET tax_rate=0, jofotara_tax_category='Z' WHERE id=1");

        ok(await merge());
        const merged = await bill(target);
        expectMoney(merged.order, 10, 1.2, 11.2);
        expect(merged.items.map(item => Number(item.tax_rate)).sort((a, b) => a - b)).toEqual([8, 16]);
        expect(merged.items.map(item => Number(item.tax_amount)).sort((a, b) => a - b)).toEqual([0.4, 0.8]);

        // A committed merge whose response was lost must not be applied twice.
        const beforeRetry = await state();
        expect((await merge()).statusCode).toBe(400);
        expect(await state()).toEqual(beforeRetry);
        let loaded = ok(await request(app).get(`/api/pos/table_order?order_id=${target}`).set('Cookie', cookie));
        await save(2, loaded.cart, [10, 1.2, 11.2], { current_order_id: target, expected_version: loaded.version });
        loaded = ok(await request(app).get(`/api/pos/table_order?order_id=${target}`).set('Cookie', cookie));
        ok(await post('checkout', {
            edit_invoice_id: target, table_id: 2, shift_id: shift.id, cart: loaded.cart,
            subtotal: 10, tax: 1.2, total: 11.2, payment_method: 'cash', amount_tendered: 11.2, change_due: 0
        }));
        const paid = await bill(target);
        expectMoney(paid.order, 10, 1.2, 11.2);
        expect(paid.order.payment_method).toBe('cash');
        expect(paid.items.map(item => Number(item.tax_rate)).sort((a, b) => a - b)).toEqual([8, 16]);
        expect((await state()).tables.every(table => table.current_order_id == null && table.status === 'available')).toBe(true);
        ok(await request(app).put('/api/auth/shifts?action=close').set('Cookie', cookie)
            .send({ shift_id: shift.id, actual_cash: 31.2 }));
        const [[closed]] = await pool.query('SELECT expected_cash, actual_cash FROM shifts WHERE id=?', [shift.id]);
        expect([closed.expected_cash, closed.actual_cash].map(Number)).toEqual([31.2, 31.2]);
    });

    it('keeps zero-rated and exempt categories distinct when the catalog becomes taxable', async () => {
        const drink = { id: 2, qty: 1, price: 2, tax_rate: 0 };
        await save(1, [drink], [2, 0, 2]);
        await pool.query("UPDATE products SET jofotara_tax_category='Z' WHERE id=2");
        const target = await save(2, [drink], [2, 0, 2]);
        await pool.query("UPDATE products SET tax_rate=16, jofotara_tax_category='S' WHERE id=2");

        ok(await merge());

        const { order, items } = await bill(target);
        expectMoney(order, 4, 0, 4);
        expect(items.map(item => item.jofotara_tax_category).sort()).toEqual(['O', 'Z']);
        expect(items.every(item => Number(item.tax_rate) === 0 && Number(item.tax_amount) === 0)).toBe(true);
    });

    it('keeps saved modifier tax and line discounts when catalog tax and modifiers change', async () => {
        const line = { id: 10, qty: 1, price: 7, tax_rate: 16, note: 'Size: Large',
            selectedModifiers: [{ group: 'Size', option: 'Large', price: 2 }], discountType: 'percent', discountValue: 50 };
        await save(1, [line], [3.36, 0.54, 3.9]);
        const target = await save(2, [line], [3.36, 0.54, 3.9]);
        const before = (await bill(target)).items[0];
        await pool.query('UPDATE products SET tax_rate=8, modifiers=NULL WHERE id=10');

        ok(await merge());

        const { order, items } = await bill(target);
        expectMoney(order, 6.72, 1.08, 7.8);
        expect(items).toHaveLength(1);
        expect(Number(items[0].quantity)).toBe(2);
        expect(items[0]).toMatchObject({ tax_rate: before.tax_rate,
            jofotara_tax_category: before.jofotara_tax_category, price_at_sale: before.price_at_sale,
            modifier_surcharge: before.modifier_surcharge, modifier_tax_amount: before.modifier_tax_amount,
            selected_modifiers: before.selected_modifiers, discount_type: before.discount_type, discount_value: before.discount_value });
        expect(Number(items[0].tax_amount)).toBeCloseTo(1.075862, 6);
    });

    it('keeps saved bundle parent tax and persisted zero-price children after catalog changes', async () => {
        const bundle = { id: 4, qty: 1, price: 10, tax_rate: 16, is_bundle: true, bundleItems: [
            { product_id: 1, qty: 1, removed: false }, { product_id: 2, qty: 1, removed: false }
        ] };
        const source = await save(1, [bundle], [10, 1.6, 11.6]);
        const target = await save(2, [bundle], [10, 1.6, 11.6]);
        const original = await bill(source);
        await pool.query('UPDATE products SET tax_rate=8 WHERE id IN (1,4)');
        await pool.query('DELETE FROM product_bundle_items WHERE bundle_id=4');

        ok(await merge());

        const { order, items } = await bill(target);
        expectMoney(order, 20, 3.2, 23.2);
        const parents = items.filter(item => item.parent_item_id == null);
        expect(parents).toHaveLength(2);
        expect(parents.every(item => Number(item.tax_rate) === 16 && Number(item.tax_amount) === 1.6)).toBe(true);
        for (const parent of parents) {
            const children = items.filter(item => item.parent_item_id === parent.id);
            expect(children.map(item => item.product_id).sort()).toEqual([1, 2]);
            for (const child of children) {
                const saved = original.items.find(item => item.parent_item_id != null && item.product_id === child.product_id);
                expect(child).toMatchObject({ quantity: saved.quantity, price_at_sale: saved.price_at_sale,
                    tax_rate: saved.tax_rate, tax_amount: saved.tax_amount, jofotara_tax_category: saved.jofotara_tax_category });
            }
        }
    });

    it.each(['sales_tax', 'income_tax'])('retains the saved %s registration after settings change', async profile => {
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='tax_registration_type'", [profile]);
        const money = profile === 'sales_tax' ? [5, 0.8, 5.8] : [5, 0, 5];
        await save(1, [burger], money);
        const target = await save(2, [burger], money);
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='tax_registration_type'",
            [profile === 'sales_tax' ? 'income_tax' : 'sales_tax']);
        await pool.query('UPDATE products SET tax_rate=8 WHERE id=1');
        ok(await merge());
        const { order, items } = await bill(target);
        expectMoney(order, ...money.map(value => value * 2));
        expect(order.tax_registration_type_at_sale).toBe(profile);
        expect(items.every(item => item.jofotara_tax_category === (profile === 'sales_tax' ? 'S' : 'O'))).toBe(true);
    });

    it('preserves exempt saved prices and tax context after catalog tax changes', async () => {
        await save(1, [burger], [5, 0, 5], { tax_exempt: true });
        const target = await save(2, [burger], [5, 0, 5], { tax_exempt: true });
        const before = (await bill(target)).items[0];
        await pool.query('UPDATE products SET tax_rate=8 WHERE id=1');
        ok(await merge());
        const { order, items } = await bill(target);
        expectMoney(order, 10, 0, 10);
        expect(order.tax_exempt_at_sale).toBe(1);
        expect(items[0]).toMatchObject({ tax_rate: before.tax_rate, jofotara_tax_category: 'Z',
            price_at_sale: before.price_at_sale, price_before_tax_exemption: before.price_before_tax_exemption });
    });

    it.each([1, 2])('rejects incompatible registration when bill %i uses income tax', async incomeTable => {
        for (const tableId of [1, 2]) {
            const income = tableId === incomeTable;
            await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='tax_registration_type'", [income ? 'income_tax' : 'sales_tax']);
            await save(tableId, [burger], income ? [5, 0, 5] : [5, 0.8, 5.8]);
        }
        const before = await state();
        global.__mockEmit__.mockClear();
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await merge();
            expect(response.statusCode, JSON.stringify(response.body)).toBe(409);
            expect(response.body.code).toBe('TAX_REGISTRATION_CONTEXT_MISMATCH');
        }
        expect(await state()).toEqual(before);
        expect(global.__mockEmit__).not.toHaveBeenCalled();
    });

    it.each([1, 2])('rejects incompatible legacy accounting when bill %i has inclusive prices', async inclusiveTable => {
        await save(1);
        await save(2);
        // Only historical accounting rows use this mode. The current receipt
        // display setting does not create inclusive-accounting orders.
        await pool.query('UPDATE orders SET tax_inclusive_at_sale=1, tax=0, total=5 WHERE table_id=?', [inclusiveTable]);
        await pool.query('UPDATE order_items SET tax_amount=0 WHERE invoice_id=(SELECT invoice_id FROM orders WHERE table_id=?)', [inclusiveTable]);
        const before = await state();
        global.__mockEmit__.mockClear();
        const response = await merge();
        expect(response.statusCode, JSON.stringify(response.body)).toBe(409);
        expect(response.body.code).toBe('TAX_ACCOUNTING_CONTEXT_MISMATCH');
        expect(await state()).toEqual(before);
        expect(global.__mockEmit__).not.toHaveBeenCalled();
    });

    it('still combines matching historical inclusive-accounting bills without converting their prices', async () => {
        await save(1);
        const target = await save(2);
        await pool.query('UPDATE orders SET tax_inclusive_at_sale=1, tax=0, total=5');
        await pool.query('UPDATE order_items SET tax_amount=0');
        await pool.query('UPDATE products SET tax_rate=8 WHERE id=1');
        ok(await merge());
        const { order, items } = await bill(target);
        expectMoney(order, 10, 0, 10);
        expect(order.tax_inclusive_at_sale).toBe(1);
        expect(items[0]).toMatchObject({ tax_rate: '16.00', jofotara_tax_category: 'S' });
        expect(Number(items[0].tax_amount)).toBe(0);
    });

    it.each([1, 2])('still rejects incompatible exemption when bill %i is exempt', async exemptTable => {
        for (const tableId of [1, 2]) {
            const exempt = tableId === exemptTable;
            await save(tableId, [burger], exempt ? [5, 0, 5] : [5, 0.8, 5.8], { tax_exempt: exempt });
        }
        const before = await state();
        global.__mockEmit__.mockClear();
        const response = await merge();
        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('TAX_EXEMPT_CONTEXT_MISMATCH');
        expect(await state()).toEqual(before);
        expect(global.__mockEmit__).not.toHaveBeenCalled();
    });

    it.each([false, true])('ignores receipt display changes with nullable legacy accounting = %s', async legacy => {
        await save(1);
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'");
        const target = await save(2);
        if (legacy) await pool.query('UPDATE orders SET tax_inclusive_at_sale=NULL');
        await pool.query('UPDATE products SET tax_rate=8 WHERE id=1');
        ok(await merge());
        expectMoney((await bill(target)).order, 10, 1.6, 11.6);
    });
});
