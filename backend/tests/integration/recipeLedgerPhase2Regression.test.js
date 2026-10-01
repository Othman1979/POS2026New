const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const crypto = require('crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { getBusinessDate } = require('../../utils/businessDate');
const L = require('../../services/RecipeLedgerService');

describe('recipe ledger Phase 2 adversarial regressions', () => {
    let cookie, chicken;
    const key = () => crypto.randomBytes(16).toString('hex');
    const http = (method, url, body) => request(app)[method](url).set('Cookie', cookie).send(body);
    const burger = (qty = 1, extra = {}) => ({ id: SEED.product1.id, qty, price: 5, ...extra });
    const money = cart => {
        const subtotal = cart.reduce((sum, row) => sum + row.qty * row.price, 0);
        const tax = Math.round(subtotal * 16) / 100;
        return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
    };
    beforeEach(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        cookie = login.headers['set-cookie'][0];
        const [created] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Phase 2 chicken','weight','g',0.0045)");
        chicken = created.insertId;
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,200)', [SEED.product1.id, chicken]);
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
    });
    afterAll(async () => pool.end());
    async function savedLines(invoiceId) {
        const [rows] = await pool.query('SELECT * FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL ORDER BY id', [invoiceId]);
        return rows;
    }
    async function save(cart, invoiceId = null) {
        const result = await http('post', '/api/pos/table_order', {
            table_id: SEED.table.id, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), cart, ...money(cart)
        });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body.invoice_id || result.body.order_id;
    }
    async function checkout(cart) {
        const totals = money(cart);
        const result = await http('post', '/api/pos/checkout', {
            cart, ...totals, payment_method: 'cash', amount_tendered: totals.total,
            change_due: 0, idempotency_key: key()
        });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body.invoice_id;
    }
    async function refund(invoiceId, lineId, qty) {
        const result = await http('post', '/api/pos/refunds', {
            invoice_id: invoiceId, intent: 'refund', refund_method: 'cash',
            items: [{ order_item_id: lineId, qty }]
        });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result;
    }
    async function net(lineKey) {
        const [[row]] = await pool.query("SELECT SUM(qty) qty,SUM(product_qty) product_qty,SUM(qty*unit_cost) money FROM stock_movements WHERE movement_type='ingredient' AND line_key=?", [lineKey]);
        return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Number(value)]));
    }
    async function split(invoiceId, itemsBySeat) {
        const [[parent]] = await pool.query('SELECT total FROM orders WHERE invoice_id=?', [invoiceId]);
        const totalCents = Math.round(Number(parent.total) * 100);
        const perSeat = Math.floor(totalCents / itemsBySeat.length);
        const result = await http('post', '/api/pos/table_splits/split', {
            tableId: SEED.table.id, currentOrderId: invoiceId,
            splits: itemsBySeat.map((items, index) => ({
                referenceName: 'Phase 2 seat ' + index, items,
                subtotal: (perSeat + (index < totalCents % itemsBySeat.length ? 1 : 0)) / 100
            }))
        });
        return result;
    }
    async function settleSeats() {
        const [held] = await pool.query('SELECT id,cart_data FROM held_orders ORDER BY id');
        const children = [];
        for (const row of held) {
            const payload = JSON.parse(row.cart_data), m = payload.split_money_cents;
            const result = await http('post', '/api/pos/checkout', {
                split_check_id: row.id, table_id: SEED.table.id, cart: payload.items,
                split_revision: payload.split_revision,
                subtotal: m.subtotal / 100, tax: m.tax / 100, total: m.total / 100,
                payment_method: 'cash', amount_tendered: m.total / 100, change_due: 0, idempotency_key: key()
            });
            expect(result.status, JSON.stringify(result.body)).toBe(200);
            children.push({ invoiceId: result.body.invoice_id, lines: await savedLines(result.body.invoice_id) });
        }
        return children;
    }

    it('refunds at the original usage cost after the ingredient cost changes', async () => {
        const invoiceId = await checkout([burger()]);
        const [line] = await savedLines(invoiceId);
        await pool.query('UPDATE ingredients SET unit_cost=0.009 WHERE id=?', [chicken]);
        await refund(invoiceId, line.id, 1);
        const [[reversal]] = await pool.query("SELECT unit_cost FROM stock_movements WHERE movement_type='ingredient' AND line_key=? AND kind='reversal'", [line.recipe_line_key]);
        expect(Number(reversal.unit_cost)).toBe(0.0045);
        expect(await net(line.recipe_line_key)).toMatchObject({ qty: 0, money: 0 });
    });

    it('keeps an originally unknown cost unknown on reversal', async () => {
        await pool.query('UPDATE ingredients SET unit_cost=NULL WHERE id=?', [chicken]);
        const invoiceId = await checkout([burger()]);
        const [line] = await savedLines(invoiceId);
        await pool.query('UPDATE ingredients SET unit_cost=0.009 WHERE id=?', [chicken]);
        await refund(invoiceId, line.id, 1);
        const [[reversal]] = await pool.query("SELECT unit_cost FROM stock_movements WHERE movement_type='ingredient' AND line_key=? AND kind='reversal'", [line.recipe_line_key]);
        expect(reversal.unit_cost).toBeNull();
    });

    it('unwinds multiple usage cost snapshots exactly and emits once for a multi-row reversal', async () => {
        const invoiceId = await save([burger()]);
        let [line] = await savedLines(invoiceId);
        await pool.query('UPDATE ingredients SET unit_cost=0.009 WHERE id=?', [chicken]);
        await save([burger(2, { order_item_id: line.id })], invoiceId);
        [line] = await savedLines(invoiceId);
        const paid = await http('post', '/api/pos/checkout', {
            edit_invoice_id: invoiceId, table_id: SEED.table.id,
            cart: [burger(2, { order_item_id: line.id })], ...money([burger(2)]),
            payment_method: 'cash', amount_tendered: 11.6, change_due: 0, idempotency_key: key()
        });
        expect(paid.status, JSON.stringify(paid.body)).toBe(200);
        [line] = await savedLines(invoiceId);
        await refund(invoiceId, line.id, 0.5);
        const [firstReversal] = await pool.query("SELECT unit_cost,qty FROM stock_movements WHERE movement_type='ingredient' AND line_key=? AND kind='reversal'", [line.recipe_line_key]);
        expect(firstReversal.map(row => [Number(row.unit_cost), Number(row.qty)])).toEqual([[0.009, 100]]);
        global.__mockEmit__.mockClear();
        await refund(invoiceId, line.id, 1.5);
        expect(await net(line.recipe_line_key)).toMatchObject({ qty: 0, product_qty: 0, money: 0 });
        const [costs] = await pool.query("SELECT unit_cost,SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient' AND line_key=? AND kind='reversal' GROUP BY unit_cost ORDER BY unit_cost", [line.recipe_line_key]);
        expect(costs.map(row => [Number(row.unit_cost), Number(row.qty)])).toEqual([[0.0045, 200], [0.009, 200]]);
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'ingredients_changed')).toEqual([
            ['ingredients_changed', { ingredientIds: [chicken] }]
        ]);
    });

    it('fully reverses all three fractional split children', async () => {
        const invoiceId = await save([burger()]);
        const [line] = await savedLines(invoiceId);
        const created = await split(invoiceId, Array.from({ length: 3 }, () => [burger(1 / 3, { tax_rate: 16, order_item_id: line.id })]));
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const children = await settleSeats();
        for (const child of children) {
            for (const item of child.lines) await refund(child.invoiceId, item.id, Number(item.quantity));
        }
        expect(await net(line.recipe_line_key)).toMatchObject({ qty: 0, product_qty: 0 });
    });

    it('keeps tracked and legacy lines separate through merge, resave, settlement, and refund', async () => {
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='recipe_ledger_enabled'");
        const legacyId = await save([burger()]);
        const [legacy] = await savedLines(legacyId);
        expect(legacy.recipe_line_key).toBeNull();
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
        const target = await http('post', '/api/pos/table_order', { table_id: SEED.table2.id, cart: [burger()], ...money([burger()]) });
        expect(target.status, JSON.stringify(target.body)).toBe(200);
        const targetId = target.body.invoice_id || target.body.order_id;
        const [tracked] = await savedLines(targetId);
        const merged = await http('post', '/api/pos/tables/transfer', await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: 'merge' }));
        expect(merged.status, JSON.stringify(merged.body)).toBe(200);
        let lines = await savedLines(targetId);
        expect(lines).toHaveLength(2);
        expect(lines.filter(row => row.recipe_line_key === tracked.recipe_line_key)).toHaveLength(1);
        let cart = lines.map(row => burger(Number(row.quantity), { order_item_id: row.id }));
        const resaved = await http('post', '/api/pos/table_order', { table_id: SEED.table2.id, current_order_id: targetId, expected_version: await currentTableRevision(targetId), cart, ...money(cart) });
        expect(resaved.status, JSON.stringify(resaved.body)).toBe(200);
        lines = await savedLines(targetId);
        cart = lines.map(row => burger(Number(row.quantity), { order_item_id: row.id }));
        const settled = await http('post', '/api/pos/checkout', { edit_invoice_id: targetId, table_id: SEED.table2.id, cart, ...money(cart), payment_method: 'cash', amount_tendered: 11.6, change_due: 0, idempotency_key: key() });
        expect(settled.status, JSON.stringify(settled.body)).toBe(200);
        lines = await savedLines(targetId);
        await refund(targetId, lines.find(row => !row.recipe_line_key).id, 1);
        expect(await net(tracked.recipe_line_key)).toMatchObject({ qty: -200, product_qty: 1 });
        await refund(targetId, lines.find(row => row.recipe_line_key).id, 1);
        expect(await net(tracked.recipe_line_key)).toMatchObject({ qty: 0, product_qty: 0 });
    });

    it('keeps an empty composition empty after a recipe is added and the saved line grows', async () => {
        await pool.query('DELETE FROM product_recipe_lines WHERE product_id=?', [SEED.product1.id]);
        const invoiceId = await save([burger()]);
        const [line] = await savedLines(invoiceId);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,250)', [SEED.product1.id, chicken]);
        await save([burger(2, { order_item_id: line.id })], invoiceId);
        const [[movements]] = await pool.query("SELECT COUNT(*) n FROM stock_movements WHERE movement_type='ingredient' ");
        expect(Number(movements.n)).toBe(0);
        expect((await savedLines(invoiceId))[0].recipe_line_key).toBe(line.recipe_line_key);
    });

    it('rejects split allocations that borrow quantity from a different saved line', async () => {
        const invoiceId = await save([burger(), burger()]);
        const [first] = await savedLines(invoiceId);
        const result = await split(invoiceId, [
            [burger(1, { order_item_id: first.id })],
            [burger(1, { order_item_id: first.id })]
        ]);
        expect(result.status).toBeGreaterThanOrEqual(400);
        const [[held]] = await pool.query('SELECT COUNT(*) n FROM held_orders');
        expect(Number(held.n)).toBe(0);
    });

    it('does not duplicate a saved recipe key when the same saved item id occurs twice', async () => {
        const invoiceId = await save([burger()]);
        const [first] = await savedLines(invoiceId);
        const result = await http('post', '/api/pos/table_order', {
            table_id: SEED.table.id, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
            cart: [burger(1, { order_item_id: first.id }), burger(1, { order_item_id: first.id })],
            ...money([burger(2)])
        });
        // A duplicate identifier cannot represent two independent saved lines.
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(await net(first.recipe_line_key)).toMatchObject({ qty: -200, product_qty: 1 });
    });

    it('rejects duplicate saved identities during checkout even when aggregate quantity matches', async () => {
        const invoiceId = await save([burger(2)]);
        const [first] = await savedLines(invoiceId);
        const cart = [burger(1, { order_item_id: first.id }), burger(1, { order_item_id: first.id })];
        const result = await http('post', '/api/pos/checkout', {
            edit_invoice_id: invoiceId, table_id: SEED.table.id, cart, ...money(cart),
            payment_method: 'cash', amount_tendered: 11.6, change_due: 0, idempotency_key: key()
        });
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(await net(first.recipe_line_key)).toMatchObject({ qty: -400, product_qty: 2 });
    });

    it('rejects ambiguous recipe identities when saved ids are omitted', async () => {
        const invoiceId = await save([burger()]);
        const [first] = await savedLines(invoiceId);
        await pool.query('UPDATE product_recipe_lines SET qty_per_unit=250 WHERE product_id=?', [SEED.product1.id]);
        await save([burger(1, { order_item_id: first.id }), burger()], invoiceId);
        const cart = [burger(), burger()];
        const result = await http('post', '/api/pos/table_order', {
            table_id: SEED.table.id, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), cart, ...money(cart)
        });
        expect(result.status).toBe(409);
        const [[remaining]] = await pool.query("SELECT SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient' ");
        expect(Number(remaining.qty)).toBe(-450);
    });

    it('reverses removed tracked lines while disabled without charging newly added lines', async () => {
        const invoiceId = await save([burger(), burger(1, { note: 'second' })]);
        const [removed, retained] = await savedLines(invoiceId);
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='recipe_ledger_enabled'");
        const voided = await http('post', '/api/pos/refunds', {
            invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: removed.id, qty: 1 }]
        });
        expect(voided.status, JSON.stringify(voided.body)).toBe(200);
        await save([burger(1, { note: 'second', order_item_id: retained.id }), burger(1, { note: 'new while disabled' })], invoiceId);
        expect(await net(removed.recipe_line_key)).toMatchObject({ qty: 0, product_qty: 0 });
        const current = await savedLines(invoiceId);
        expect(current.find(row => row.note === 'new while disabled').recipe_line_key).toBeNull();
        expect(await net(retained.recipe_line_key)).toMatchObject({ qty: -200, product_qty: 1 });
    });

    it('serializes reversals of one shared line despite an older caller snapshot', async () => {
        await pool.query('UPDATE product_recipe_lines SET qty_per_unit=0.000001 WHERE product_id=?', [SEED.product1.id]);
        const invoiceId = await checkout([burger()]);
        const [line] = await savedLines(invoiceId);
        const writer = await pool.getConnection(), reader = await pool.getConnection();
        const args = { lineKey: line.recipe_line_key, qty: 0.5, sourceType: 'refund', sourceId: invoiceId, businessDate: getBusinessDate() };
        try {
            await reader.beginTransaction();
            await reader.query("SELECT COUNT(*) FROM stock_movements WHERE movement_type='ingredient' ");
            await writer.beginTransaction();
            await L.reverseLineUsage(writer, args);
            const second = L.reverseLineUsage(reader, args);
            await writer.commit();
            await second;
            await reader.commit();
            expect(await net(line.recipe_line_key)).toMatchObject({ qty: 0, product_qty: 0 });
        } finally {
            await writer.rollback(); await reader.rollback(); writer.release(); reader.release();
        }
    });

    it('fully refunds two split children concurrently through HTTP', async () => {
        await pool.query('UPDATE product_recipe_lines SET qty_per_unit=0.000001 WHERE product_id=?', [SEED.product1.id]);
        const invoiceId = await save([burger()]);
        const [line] = await savedLines(invoiceId);
        const created = await split(invoiceId, [
            [burger(0.5, { order_item_id: line.id })], [burger(0.5, { order_item_id: line.id })]
        ]);
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const children = await settleSeats();
        await Promise.all(children.map(child => refund(child.invoiceId, child.lines[0].id, 0.5)));
        expect(await net(line.recipe_line_key)).toMatchObject({ qty: 0, product_qty: 0 });
    });

    it('preserves server-owned recipe identity through a split-board rewrite and all refunds', async () => {
        const invoiceId = await save([burger(2)]);
        const [line] = await savedLines(invoiceId);
        const created = await split(invoiceId, [[burger(1, { order_item_id: line.id })], [burger(1, { order_item_id: line.id })]]);
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const [before] = await pool.query('SELECT id,cart_data FROM held_orders ORDER BY id');
        const changed = await http('put', '/api/pos/table_splits', {
            splitId: before[0].id,
            expectedChecks: before.map(row => ({ id: row.id, revision: JSON.parse(row.cart_data).split_revision })),
            splits: [0.5, 0.5, 1].map((qty, index) => ({
                ...(before[index] ? { id: before[index].id } : {}),
                items: [burger(qty, { order_item_id: line.id, recipe_line_key: 'f'.repeat(32), price: 0 })]
            }))
        });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        const [after] = await pool.query('SELECT cart_data FROM held_orders ORDER BY id');
        expect(after).toHaveLength(3);
        for (const row of after) expect(JSON.parse(row.cart_data).items[0].recipe_line_key).toBe(line.recipe_line_key);
        expect(await net(line.recipe_line_key)).toMatchObject({ qty: -400, product_qty: 2 });
        const children = await settleSeats();
        for (const child of children) await refund(child.invoiceId, child.lines[0].id, Number(child.lines[0].quantity));
        expect(await net(line.recipe_line_key)).toMatchObject({ qty: 0, product_qty: 0 });
    });

    it('sees a frozen composition committed after the caller established its snapshot', async () => {
        const reader = await pool.getConnection();
        try {
            await reader.beginTransaction();
            await reader.query("SELECT COUNT(*) FROM stock_movements WHERE movement_type='ingredient' ");
            const invoiceId = await checkout([burger()]);
            const [line] = await savedLines(invoiceId);
            await L.reverseLineUsage(reader, { lineKey: line.recipe_line_key, qty: 1, sourceType: 'refund', sourceId: invoiceId, businessDate: getBusinessDate() });
            await reader.commit();
            expect(await net(line.recipe_line_key)).toMatchObject({ qty: 0, product_qty: 0 });
        } finally { await reader.rollback(); reader.release(); }
    });

    it('allows independent new recipe writes while another ingredient transaction remains open', async () => {
        const [created] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Independent drink','count','unit')");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,1)', [SEED.product2.id, created.insertId]);
        const source = require('../../services/StockReportInvalidation');
        const first = await source.getConnection(pool), second = await source.getConnection(pool);
        try {
            await first.beginTransaction(); await second.beginTransaction();
            await second.query('SET innodb_lock_wait_timeout=1');
            await L.syncOrderLines(first, { sourceId: 1, lines: [{ key: key(), product_id: SEED.product1.id, qty: 1, isNew: true }], businessDate: getBusinessDate() });
            const written = await L.syncOrderLines(second, { sourceId: 2, lines: [{ key: key(), product_id: SEED.product2.id, qty: 1, isNew: true }], businessDate: getBusinessDate() });
            expect(written.written).toBe(1);
            await second.commit(); await first.commit();
        } finally {
            await first.rollback(); await second.rollback();
            await second.query('SET innodb_lock_wait_timeout=DEFAULT'); first.release(); second.release();
        }
    });

    it('rolls back order, stock, and ledger together when a usage insert fails', async () => {
        const [[before]] = await pool.query('SELECT (SELECT COUNT(*) FROM orders) orders_count,(SELECT stock FROM products WHERE id=?) stock', [SEED.product1.id]);
        await pool.query("CREATE TRIGGER phase2_reject_usage BEFORE INSERT ON stock_movements FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Phase 2 injected usage failure'");
        try {
            const result = await http('post', '/api/pos/table_order', { table_id: SEED.table.id, cart: [burger()], ...money([burger()]) });
            expect(result.status).toBe(500);
            const [[after]] = await pool.query('SELECT (SELECT COUNT(*) FROM orders) orders_count,(SELECT stock FROM products WHERE id=?) stock', [SEED.product1.id]);
            expect(after).toEqual(before);
            const [[table]] = await pool.query('SELECT current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
            expect(table.current_order_id).toBeNull();
            const [[registry]] = await pool.query('SELECT COUNT(*) n FROM recipe_ledger_lines');
            expect(Number(registry.n)).toBe(0);
            expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'ingredients_changed')).toHaveLength(0);
        } finally { await pool.query('DROP TRIGGER phase2_reject_usage'); }
    });

    it('rolls back the settings batch when its recipe-toggle audit cannot be written', async () => {
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='recipe_ledger_enabled'");
        const [[original]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='store_name'");
        await pool.query(`CREATE TRIGGER phase2_reject_toggle_audit BEFORE INSERT ON audit_events FOR EACH ROW
            BEGIN IF NEW.event_type='recipe_ledger_toggled' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Phase 2 injected audit failure'; END IF; END`);
        try {
            const result = await http('post', '/api/system/settings', { recipe_ledger_enabled: '1', store_name: 'Failed toggle must roll back' });
            expect(result.status).toBe(500);
            const [rows] = await pool.query("SELECT setting_key,setting_value FROM settings WHERE setting_key IN ('recipe_ledger_enabled','store_name')");
            const stored = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
            expect(stored.recipe_ledger_enabled).toBe('0');
            expect(stored.store_name).toBe(original?.setting_value);
            expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'settings_changed')).toHaveLength(0);
        } finally { await pool.query('DROP TRIGGER phase2_reject_toggle_audit'); }
    });

    it('audits one transition for two simultaneous identical setting updates', async () => {
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='recipe_ledger_enabled'");
        const results = await Promise.all([0, 1].map(() => http('post', '/api/system/settings', { recipe_ledger_enabled: '1' })));
        expect(results.map(result => result.status)).toEqual([200, 200]);
        const [audits] = await pool.query("SELECT old_value,new_value FROM audit_events WHERE event_type='recipe_ledger_toggled'");
        expect(audits).toHaveLength(1);
        expect(JSON.parse(audits[0].old_value)).toEqual({ enabled: '0' });
        expect(JSON.parse(audits[0].new_value)).toEqual({ enabled: '1' });
    });
});
