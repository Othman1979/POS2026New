const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { tableActionIntent } = require('../fixtures/tableActionIntent');

describe('selected table item transfer', () => {
    let cookie;
    const post = (path, body) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const ok = res => { expect(res.statusCode, JSON.stringify(res.body)).toBe(200); return res.body; };
    const create = async (tableId, qty = 3, extra = {}) => ok(await post('table_order', {
        table_id: tableId, cart: [{ id: 2, name: 'Test Drink', qty, price: 2 }], subtotal: qty * 2, tax: 0, total: qty * 2, ...extra
    }));
    const read = async invoiceId => ok(await request(app).get(`/api/pos/table_order?order_id=${invoiceId}`).set('Cookie', cookie));
    const setup = async ({ busy = true, qty = 1 } = {}) => {
        const source = await create(1), target = busy ? await create(2, 2) : null;
        const order = await read(source.invoice_id);
        const intent = await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'move_items' });
        return { source, target, order, input: { ...intent, source_version: order.version,
            items: [{ order_item_id: order.cart[0].order_item_id, quantity: qty }] } };
    };
    const preview = async input => ok(await post('tables/transfer/preview', input));
    const confirm = (input, shown) => post('tables/transfer', { ...input, source_version: shown.source_version, target_version: shown.target_version });
    const state = async () => {
        const out = {};
        for (const table of ['orders', 'order_items', 'restaurant_tables', 'held_orders', 'products', 'stock_movements', 'recipe_ledger_lines', 'service_charge_snapshots', 'audit_events', 'print_queue', 'table_action_operations']) {
            out[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`))[0];
        }
        return out;
    };
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO restaurant_tables(id,section_id,table_number) VALUES(3,1,'3')");
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
    });
    afterAll(() => pool.end());

    it.each([true, false])('previews and moves one saved unit to a destination (busy=%s), then replays exactly once', async busy => {
        const { input, source, target } = await setup({ busy });
        const before = await state(), shown = await preview(input);
        expect(await state()).toEqual(before);
        expect(shown.source.before.total).toBe(6);
        expect(shown.source.after.total).toBe(4);
        expect(shown.target.before.total).toBe(busy ? 4 : 0);
        expect(shown.target.after.total).toBe(busy ? 6 : 2);
        const moved = ok(await confirm(input, shown));
        const after = await state();
        expect(ok(await confirm(input, shown))).toEqual(moved);
        expect(await state()).toEqual(after);
        expect(after.stock_movements).toEqual(before.stock_movements);
        expect(after.print_queue).toEqual(before.print_queue);
        expect(after.products).toEqual(before.products);
        const destination = after.restaurant_tables.find(t => t.id === 2).current_order_id;
        if (busy) expect(destination).toBe(target.invoice_id);
        const sources = after.order_items.filter(line => line.invoice_id === source.invoice_id);
        const targets = after.order_items.filter(line => line.invoice_id === destination);
        expect(sources.reduce((sum, line) => sum + Number(line.quantity), 0)).toBe(2);
        expect(targets.reduce((sum, line) => sum + Number(line.quantity), 0)).toBe(busy ? 3 : 1);
        expect(after.orders.find(row => row.invoice_id === source.invoice_id).version).toBe(shown.source_version + 1);
        expect(after.table_action_operations).toHaveLength(1);
    });

    it.each([true, false])('moves all items and releases the source (busy=%s)', async busy => {
        const data = await setup({ busy, qty: 3 }), shown = await preview(data.input);
        const before = await state(), result = ok(await confirm(data.input, shown)), after = await state();
        expect(result.source_released).toBe(true);
        expect(after.restaurant_tables.find(row => row.id === 1).current_order_id).toBeNull();
        expect(after.restaurant_tables.find(row => row.id === 2).current_order_id).toBe(busy ? data.target.invoice_id : data.source.invoice_id);
        expect(after.orders.filter(row => row.payment_method === 'unpaid_table')).toHaveLength(1);
        expect(after.stock_movements).toEqual(before.stock_movements);
        expect(after.print_queue).toEqual(before.print_queue);
        const saved = await read(result.target_invoice_id);
        expect(saved.cart.reduce((sum, row) => sum + row.qty, 0)).toBe(busy ? 5 : 3);
    });

    it.each([false, true])('rolls back or reconciles lost commit with recipe and fee ownership (committed=%s)', async committed => {
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Transfer ingredient','count','unit',0.35,1)");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('recipe_ledger_enabled','service_charge_enabled','auto_apply_service_charge')");
        await pool.query("UPDATE settings SET setting_value='10' WHERE setting_key='service_charge_percentage'");
        const data = await setup({ busy: false }), shown = await preview(data.input), before = await state();
        const acquire = pool.getConnection; let releases = 0;
        pool.getConnection = async function (...args) {
            const conn = await acquire.apply(this, args), commit = conn.commit, release = conn.release;
            conn.commit = async function () { if (committed) await commit.call(this); throw new Error('Injected item transfer commit loss'); };
            conn.release = function () { releases++; conn.commit = commit; conn.release = release; return release.call(this); };
            return conn;
        };
        try { expect((await confirm(data.input, shown)).statusCode).toBe(500); }
        finally { pool.getConnection = acquire; }
        expect(releases).toBe(1);
        const after = await state();
        if (!committed) expect(after).toEqual(before);
        const receipt = ok(await request(app).get(`/api/pos/tables/transfer/${data.input.operation_id}`).set('Cookie', cookie));
        expect(receipt.committed).toBe(committed);
        ok(await confirm(data.input, shown));
        if (committed) expect(await state()).toEqual(after);
        expect((await state()).table_action_operations).toHaveLength(1);
    });

    it('keeps exact replay evidence after later edits and refuses changed quantities with the same key', async () => {
        const data = await setup(), shown = await preview(data.input), result = ok(await confirm(data.input, shown));
        const saved = await read(data.target.invoice_id);
        ok(await post('table_order', { table_id: 2, current_order_id: data.target.invoice_id, expected_version: saved.version, cart: saved.cart, subtotal: 6, tax: 0, total: 6 }));
        const after = await state();
        expect(ok(await confirm(data.input, shown))).toEqual(result);
        const changed = await confirm({ ...data.input, items: [{ ...data.input.items[0], quantity: 2 }] }, shown);
        expect(changed.statusCode).toBe(409); expect(changed.body.code).toBe('TABLE_ACTION_KEY_CONFLICT');
        expect(await state()).toEqual(after);
    });

    it.each(['printed', 'replacement', 'paid split', 'permissions', 'fee mismatch'])('rejects %s without moving anything', async reason => {
        const data = await setup(), shown = await preview(data.input);
        if (reason === 'printed') await pool.query("UPDATE restaurant_tables SET status='printed' WHERE id=2");
        if (reason === 'replacement') {
            ok(await post('tables/transfer', await tableActionIntent(pool, { sourceTableId: 2, targetTableId: 3, action: 'transfer' })));
            await create(2, 1);
        }
        if (reason === 'paid split') await pool.query("INSERT INTO orders(user_id,parent_invoice_id,payment_method,subtotal,tax,total) VALUES(1,?,'cash',2,0,2)", [data.source.invoice_id]);
        if (reason === 'permissions') cookie = (await request(app).post('/api/auth/login').send({ user_number: '9003' })).headers['set-cookie'][0];
        if (reason === 'fee mismatch') {
            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('service_charge_enabled','auto_apply_service_charge')");
            ok(await post('tables/transfer', await tableActionIntent(pool, { sourceTableId: 2, targetTableId: 3, action: 'transfer' })));
            const target = await create(2, 2);
            Object.assign(data.input, await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'move_items' }));
            shown.target_version = (await read(target.invoice_id)).version;
        }
        const before = await state(), response = await confirm(data.input, shown);
        expect(response.statusCode, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
        expect(response.statusCode).toBeLessThan(500);
        expect(await state()).toEqual(before);
    });

    it('serializes two confirmations against the same bill revision', async () => {
        const data = await setup(), shown = await preview(data.input);
        const second = { ...data.input, operation_id: require('node:crypto').randomUUID() };
        const overlapping = pool.pool.config.connectionLimit > 1;
        let release, arrivals = 0;
        const gate = new Promise(resolve => { release = resolve; }), acquire = pool.getConnection;
        pool.getConnection = async function (...args) {
            const conn = await acquire.apply(this, args);
            // Start together before either request holds a receipt/transaction lock.
            if (overlapping) { if (++arrivals === 2) release(); await gate; }
            return conn;
        };
        let responses;
        try {
            // An early request failure must release its peer, and both requests
            // must finish before the next fixture can reset database tables.
            const results = await Promise.allSettled([confirm(data.input, shown), confirm(second, shown)]
                .map(attempt => Promise.resolve(attempt).finally(release)));
            expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
            responses = results.map(result => result.value);
        }
        finally { release(); pool.getConnection = acquire; }
        if (overlapping) expect(arrivals).toBe(2);
        expect(responses.map(res => res.statusCode).sort()).toEqual([200, 409]);
        expect((await state()).table_action_operations).toHaveLength(1);
        expect((await read(data.source.invoice_id)).cart.reduce((sum, row) => sum + row.qty, 0)).toBe(2);
    });

    it('keeps recorded stock mappings during transfer and restores them once when both bills are voided', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=20 WHERE id=2');
        const [stock] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,legacy_product_id,tracking_state) VALUES('Move fixture','count','unit',2,'active')");
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES(2,?,1)', [stock.insertId]);
        const conn = await pool.getConnection();
        try { await conn.beginTransaction(); await require('../../services/StockLedgerService').post(conn, { kind: 'opening', request_key: require('node:crypto').randomUUID(),
            business_date: require('../../utils/businessDate').getBusinessDate(), lines: [{ stock_item_id: stock.insertId, quantity: '20', expected_version: '0' }] }, 1); await conn.commit(); }
        catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
        const data = await setup(), shown = await preview(data.input);
        const before = await state(), balances = (await pool.query('SELECT * FROM stock_balances'))[0];
        await pool.query('UPDATE product_stock_links SET qty_per_sale=2,policy_version=2 WHERE product_id=2');
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
        ok(await confirm(data.input, shown));
        expect((await state()).stock_movements).toEqual(before.stock_movements);
        expect((await pool.query('SELECT * FROM stock_balances'))[0]).toEqual(balances);
        const [rows] = await pool.query('SELECT stock_snapshot FROM order_items WHERE product_id=2');
        expect(rows.every(row => row.stock_snapshot === before.order_items[0].stock_snapshot)).toBe(true);
        for (const bill of [data.source, data.target]) ok(await post('refunds', { invoice_id: bill.invoice_id, expected_version: await currentTableRevision(bill.invoice_id), intent: 'void', reason: 'Cancelled' }));
        expect(Number((await pool.query('SELECT quantity FROM stock_balances WHERE stock_item_id=?', [stock.insertId]))[0][0].quantity)).toBe(20);
    });

    it('rejects a source edit between item selection and preview', async () => {
        const { input, source } = await setup();
        await pool.query('UPDATE orders SET version=version+1 WHERE invoice_id=?', [source.invoice_id]);
        const before = await state();
        const res = await post('tables/transfer/preview', input);
        expect(res.statusCode).toBe(409); expect(res.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
        expect(await state()).toEqual(before);
    });

    it('preserves an order-wide discount on a pure whole-bill relocation to an empty table', async () => {
        const source = await create(1, 3, { order_discount_type: 'fixed', order_discount_value: 1, subtotal: 6, tax: 0, total: 5 });
        const saved = await read(source.invoice_id);
        const input = { ...await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'move_items' }),
            source_version: saved.version, items: [{ order_item_id: saved.cart[0].order_item_id, quantity: 3 }] };
        const before = await state(), shown = await preview(input), result = ok(await confirm(input, shown)), after = await state();
        expect(result.target_invoice_id).toBe(source.invoice_id);
        expect(after.order_items).toEqual(before.order_items);
        expect(after.orders.map(row => ({ ...row, table_id: 1 }))).toEqual(before.orders);
    });

    it('rejects an allocation that adds a payable cent through rounding', async () => {
        await pool.query('UPDATE products SET price=0.01 WHERE id=2');
        const source = await create(1, 1, { cart: [{ id: 2, qty: 1, price: 0.01 }], subtotal: 0.01, tax: 0, total: 0.01 });
        const saved = await read(source.invoice_id);
        const input = { ...await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'move_items' }),
            source_version: saved.version, items: [{ order_item_id: saved.cart[0].order_item_id, quantity: '0.5' }] };
        const before = await state(), result = await post('tables/transfer/preview', input);
        expect(result.statusCode).toBe(409); expect(result.body.code).toBe('TABLE_MONEY_CONSERVATION_CONFLICT');
        expect(await state()).toEqual(before);
    });

    it('retains a whole preparation key after closing its source and restores all ingredients on destination void', async () => {
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Whole preparation','count','unit',0.35,1)");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
        const data = await setup({ qty: 3 }), shown = await preview(data.input), before = await state();
        ok(await confirm(data.input, shown));
        expect((await state()).stock_movements).toEqual(before.stock_movements);
        ok(await post('refunds', { invoice_id: data.target.invoice_id, expected_version: await currentTableRevision(data.target.invoice_id), intent: 'void', reason: 'Cancelled' }));
        const [[balance]] = await pool.query("SELECT SUM(qty) quantity,SUM(qty*unit_cost) cost FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=?", [ingredient.insertId]);
        expect(Number(balance.quantity)).toBe(0); expect(Number(balance.cost)).toBe(0);
    });

    it.each(['source', 'target'])('rejects a changed %s bill after preview without moving food', async side => {
        const data = await setup(), shown = await preview(data.input);
        await pool.query('UPDATE orders SET version=version+1 WHERE invoice_id=?', [data[side].invoice_id]);
        const before = await state();
        const res = await confirm(data.input, shown);
        expect(res.statusCode).toBe(409); expect(res.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
        expect(await state()).toEqual(before);
    });

    it.each([0, -1, 4, '1.0000001', true, null])('rejects an invalid or excessive quantity (%j)', async quantity => {
        const { input } = await setup(); input.items[0].quantity = quantity;
        const before = await state();
        expect((await post('tables/transfer/preview', input)).statusCode).toBeGreaterThanOrEqual(400);
        expect(await state()).toEqual(before);
    });

    it('preserves both bills when an order-wide discount cannot be allocated safely', async () => {
        const data = await setup();
        await pool.query("UPDATE orders SET discount_type='fixed',discount_value=1,total=total-1 WHERE invoice_id=?", [data.source.invoice_id]);
        const before = await state();
        const res = await post('tables/transfer/preview', data.input);
        expect(res.statusCode).toBe(409); expect(res.body.code).toBe('ORDER_DISCOUNT_MERGE_CONFLICT');
        expect(await state()).toEqual(before);
    });

    it('moves a partial preparation at its recorded cost, then edits and voids the bills independently', async () => {
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Drink ingredient','count','unit',0.35,1)");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
        const data = await setup(), shown = await preview(data.input);
        const ledger = async () => (await pool.query("SELECT line_key,SUM(qty) qty,SUM(qty*unit_cost) cost FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? GROUP BY line_key ORDER BY line_key", [ingredient.insertId]))[0];
        const before = await ledger();
        await pool.query('UPDATE ingredients SET unit_cost=0.9 WHERE id=?', [ingredient.insertId]);
        ok(await confirm(data.input, shown));
        const after = await ledger();
        expect(after.reduce((sum, row) => sum + Number(row.qty), 0)).toBe(-5);
        expect(after.reduce((sum, row) => sum + Number(row.cost), 0)).toBeCloseTo(before.reduce((sum, row) => sum + Number(row.cost), 0), 8);
        expect(after).toHaveLength(3);
        const newKey = after.find(row => !before.some(old => old.line_key === row.line_key));
        expect(Number(newKey.qty)).toBe(-1); expect(Number(newKey.cost)).toBeCloseTo(-0.35, 8);
        const source = await read(data.source.invoice_id);
        ok(await post('table_order', { table_id: 1, current_order_id: data.source.invoice_id, expected_version: source.version,
            cart: source.cart.map(row => ({ ...row, qty: 3 })), subtotal: 6, tax: 0, total: 6 }));
        const destination = await read(data.target.invoice_id);
        ok(await post('table_order', { table_id: 2, current_order_id: data.target.invoice_id, expected_version: destination.version,
            cart: destination.cart, subtotal: 6, tax: 0, total: 6 }));
        expect((await ledger()).reduce((sum, row) => sum + Number(row.qty), 0)).toBe(-6);
        ok(await post('refunds', { invoice_id: data.source.invoice_id, expected_version: await currentTableRevision(data.source.invoice_id), intent: 'void', reason: 'Cancelled' }));
        expect((await ledger()).reduce((sum, row) => sum + Number(row.qty), 0)).toBe(-3);
        ok(await post('refunds', { invoice_id: data.target.invoice_id, expected_version: await currentTableRevision(data.target.invoice_id), intent: 'void', reason: 'Cancelled' }));
        expect((await ledger()).every(row => Number(row.qty) === 0 && Math.abs(Number(row.cost)) < 1e-8)).toBe(true);
    });

    it.each([true, false])('preserves matching saved service charges (busy=%s) and their holder revisions', async busy => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('service_charge_enabled','auto_apply_service_charge')");
        await pool.query("UPDATE settings SET setting_value='10' WHERE setting_key='service_charge_percentage'");
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='service_charge_tax_rate'");
        const data = await setup({ busy }), shown = await preview(data.input);
        expect(shown.source.after.total).toBe(4.4);
        expect(shown.target.after.total).toBe(busy ? 6.6 : 2.2);
        const before = await state();
        ok(await confirm(data.input, shown));
        const after = await state();
        expect(after.stock_movements).toEqual(before.stock_movements);
        const targetId = after.restaurant_tables.find(row => row.id === 2).current_order_id;
        const saved = await read(targetId);
        const snapshot = saved.service_charge_snapshot;
        expect(snapshot).toBeTruthy();
        const [[holder]] = await pool.query('SELECT holder_id,state,version,percentage FROM service_charge_snapshots WHERE id=?', [snapshot.id]);
        expect(String(holder.holder_id)).toBe(String(targetId));
        expect(holder.state).toBe('open_order'); expect(Number(holder.percentage)).toBe(10);
        expect(Number(holder.version)).toBe(busy ? Number(before.service_charge_snapshots.find(row => row.id === snapshot.id).version) + 1 : 1);
        ok(await post('table_order', { table_id: 2, current_order_id: targetId, expected_version: saved.version,
            cart: saved.cart, subtotal: shown.target.after.subtotal, tax: shown.target.after.tax, total: shown.target.after.total,
            service_charge_snapshot: { id: snapshot.id, version: snapshot.version } }));
        expect(Number((await pool.query('SELECT total FROM orders WHERE invoice_id=?', [targetId]))[0][0].total)).toBe(shown.target.after.total);
    });

    it('keeps distinct saved rates and line discounts after a catalog change, move and reload/save', async () => {
        const source = await create(1, 2, { cart: [{ id: 1, name: 'Test Burger', qty: 2, price: 5, discountType: 'fixed', discountValue: 1 }], subtotal: 8, tax: 1.28, total: 9.28 });
        await pool.query('UPDATE products SET tax_rate=8 WHERE id=1');
        const target = await create(2, 1, { cart: [{ id: 1, name: 'Test Burger', qty: 1, price: 5, discountType: 'percent', discountValue: 10 }], subtotal: 4.5, tax: 0.36, total: 4.86 });
        const saved = await read(source.invoice_id);
        const input = { ...await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'move_items' }),
            source_version: saved.version, items: [{ order_item_id: saved.cart[0].order_item_id, quantity: 1 }] };
        const shown = await preview(input); expect(shown.source.after.total).toBe(4.64); expect(shown.target.after.total).toBe(9.5);
        ok(await confirm(input, shown));
        await pool.query('UPDATE products SET price=20,tax_rate=0 WHERE id=1');
        const destination = await read(target.invoice_id);
        ok(await post('table_order', { table_id: 2, current_order_id: target.invoice_id, expected_version: destination.version,
            cart: destination.cart, ...shown.target.after }));
        const [rows] = await pool.query('SELECT price_at_sale,tax_rate,discount_type,discount_value FROM order_items WHERE invoice_id=? ORDER BY tax_rate', [target.invoice_id]);
        expect(rows.map(row => [Number(row.price_at_sale), Number(row.tax_rate), row.discount_type, Number(row.discount_value)])).toEqual([[5, 8, 'percent', 10], [5, 16, 'fixed', 1]]);
    });

    it('moves priced modifiers without changing their saved snapshots or the combined payable cents', async () => {
        await pool.query('UPDATE products SET tax_rate=16 WHERE id=10');
        const cart = qty => [{ id: 10, name: 'Modifier Product', qty, price: 7, selectedModifiers: [{ group: 'Size', option: 'Large' }] }];
        const source = await create(1, 3, { cart: cart(3), subtotal: 20.17, tax: 3.23, total: 23.4 });
        const target = await create(2, 1, { cart: cart(1), subtotal: 6.72, tax: 1.08, total: 7.8 });
        const saved = await read(source.invoice_id), input = { ...await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'move_items' }),
            source_version: saved.version, items: [{ order_item_id: saved.cart[0].order_item_id, quantity: 1 }] };
        const shown = await preview(input); expect(shown.source.after.total).toBe(15.6); expect(shown.target.after.total).toBe(15.6);
        const [[original]] = await pool.query('SELECT selected_modifiers,modifier_surcharge,modifier_tax_amount FROM order_items WHERE invoice_id=?', [source.invoice_id]);
        ok(await confirm(input, shown));
        const [rows] = await pool.query('SELECT selected_modifiers,modifier_surcharge,modifier_tax_amount FROM order_items WHERE invoice_id IN (?,?)', [source.invoice_id, target.invoice_id]);
        expect(rows.every(row => JSON.stringify(row) === JSON.stringify(original))).toBe(true);
    });

    it('moves a fractional bundle with its saved component quantities and notes after the live bundle changes', async () => {
        const source = await create(1, 2, { cart: [{ id: 4, name: 'Family Package', qty: 2, price: 10,
            bundleItems: [{ product_id: 1, qty: 1, note: 'No salt' }, { product_id: 2, qty: 1, note: 'No ice' }] }], subtotal: 20, tax: 3.2, total: 23.2 });
        const target = await create(2, 2);
        const sourceBill = await read(source.invoice_id), input = { ...await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'move_items' }),
            source_version: sourceBill.version, items: [{ order_item_id: sourceBill.cart[0].order_item_id, quantity: '0.5' }] };
        await pool.query('DELETE FROM product_bundle_items WHERE bundle_id=4');
        const shown = await preview(input); expect(shown.source.after.total).toBe(17.4); expect(shown.target.after.total).toBe(9.8);
        ok(await confirm(input, shown));
        const [children] = await pool.query('SELECT invoice_id,product_id,quantity,note FROM order_items WHERE parent_item_id IS NOT NULL ORDER BY invoice_id,product_id');
        expect(children.map(row => [row.invoice_id, row.product_id, Number(row.quantity), row.note])).toEqual([
            [source.invoice_id, 1, 1.5, 'No salt'], [source.invoice_id, 2, 1.5, 'No ice'],
            [target.invoice_id, 1, 0.5, 'No salt'], [target.invoice_id, 2, 0.5, 'No ice']
        ]);
        const reloaded = await read(target.invoice_id);
        ok(await post('table_order', { table_id: 2, current_order_id: target.invoice_id, expected_version: reloaded.version, cart: reloaded.cart, ...shown.target.after }));
        expect((await pool.query('SELECT quantity,note FROM order_items WHERE invoice_id=? AND parent_item_id IS NOT NULL ORDER BY product_id', [target.invoice_id]))[0].map(row => [Number(row.quantity), row.note])).toEqual([[0.5, 'No salt'], [0.5, 'No ice']]);
    });
});
