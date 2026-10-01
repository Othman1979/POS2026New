const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { splitMysqlScript } = require('../../migrations/runPendingMigrations');
const ledger = require('../../services/StockLedgerService');
const { journalProductDeltas } = require('../../services/StockProductAdapter');
const { deductStockForCart, restoreStockForCart } = require('../../services/InventoryService');

describe('Stock ledger quantity authority', () => {
    let key;
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations/2026-09-12-stock-item-identity-v1.sql'), 'utf8');
    beforeAll(() => seedDatabase());
    beforeEach(async () => {
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Ledger fixture','count','unit','active')");

        key = { stock_item_id: item.insertId };
    });
    afterAll(() => pool.end());
    function input(kind, amount, extra = {}) {
        return { kind, request_key: randomUUID(), business_date: '2026-09-08', lines: [{ ...key, quantity: amount, ...(kind === 'opening' ? { expected_version: '0' } : {}) }], ...extra };
    }
    async function post(intent) {
        for (let attempt = 0; ; attempt++) {
            const conn = await pool.getConnection();
            try { await conn.beginTransaction(); const result = await ledger.post(conn, intent, 1); await conn.commit(); return result; }
            catch (error) { await conn.rollback(); if (!['ER_LOCK_DEADLOCK', 'ER_DUP_ENTRY'].includes(error.code) || attempt === 2) throw error; }
            finally { conn.release(); }
        }
    }
    async function balance() {
        return (await pool.query('SELECT CAST(quantity AS CHAR) AS quantity,quantity_known,version FROM stock_balances WHERE stock_item_id=?', Object.values(key)))[0][0];
    }
    test('exact opening, issue and receipt reconcile with the append-only journal', async () => {
        await post(input('opening', '9999999999.000001'));
        await post(input('issue', '-0.000001'));
        await post(input('receipt', '0.000002'));
        expect((await balance()).quantity).toBe('9999999999.000002');
        const [[sum]] = await pool.query('SELECT CAST(SUM(quantity) AS CHAR) AS quantity FROM stock_movements WHERE stock_item_id=?', [key.stock_item_id]);
        expect(sum.quantity).toBe((await balance()).quantity);
    });
    test('unknown receipts do not invent an opening balance; a count establishes it', async () => {
        await post(input('receipt', '5'));
        expect(Number((await balance()).quantity_known)).toBe(0);
        await expect(post(input('issue', '-1'))).rejects.toMatchObject({ statusCode: 409 });
        await post(input('count', '3', { lines: [{ ...key, quantity: '3', expected_version: '1' }] }));
        expect((await balance()).quantity).toBe('3.000000');
        expect(Number((await balance()).quantity_known)).toBe(1);
    });
    test('concurrent same-key counts replay before checking the now-stale observation', async () => {
        const intent = input('opening', '10');
        const [first, second] = await Promise.all([post(intent), post(intent)]);
        expect(first.operation_id).toBe(second.operation_id);
        expect(Number((await balance()).version)).toBe(1);
        await expect(post({ ...intent, lines: [{ ...intent.lines[0], quantity: '11' }] })).rejects.toMatchObject({ statusCode: 409 });
    });
    test('two competing issues cannot consume the same last unit', async () => {
        await post(input('opening', '1'));
        const results = await Promise.allSettled([post(input('issue', '-1')), post(input('issue', '-1'))]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect((await balance()).quantity).toBe('0.000000');
    });
    test('a stale count cannot erase an intervening receipt', async () => {
        await post(input('opening', '10'));
        await post(input('receipt', '5'));
        await expect(post(input('count', '8', { lines: [{ ...key, quantity: '8', expected_version: '1' }] }))).rejects.toMatchObject({ statusCode: 409 });
        expect((await balance()).quantity).toBe('15.000000');
    });
    test('caller rollback removes the operation, movements and balance changes together', async () => {
        const intent = input('opening', '10');
        const conn = await pool.getConnection();
        try { await conn.beginTransaction(); await ledger.post(conn, intent, 1); await conn.rollback(); }
        finally { conn.release(); }
        expect(await balance()).toBeUndefined();
        expect((await pool.query('SELECT id FROM stock_operations WHERE request_key=?', [intent.request_key]))[0]).toHaveLength(0);
    });
    test('rejects unrecognized legacy identity instead of crediting unrelated stock', async () => {
        await post(input('opening', '10'));
        await expect(post(input('return', '2', { lines: [{ ...key, location_id: '777', lot_id: '888', quantity: '2' }] }))).rejects.toMatchObject({statusCode:409});
        expect((await balance()).quantity).toBe('10.000000');
    });
    test('waste deducts exactly once and keeps strict shortage checks', async () => {
        await post(input('opening', '10'));
        const intent = input('waste', '-2');
        await post(intent); await post(intent);
        expect((await balance()).quantity).toBe('8.000000');
        await expect(post(input('waste', '-9'))).rejects.toMatchObject({statusCode:409});
    });
    test('rejects unsupported precision and an oversized operation without writes', async () => {
        await expect(post(input('receipt', '0.0000001'))).rejects.toMatchObject({ statusCode: 400 });
        await expect(post(input('receipt', '1', { lines: Array.from({ length: 101 }, () => ({ ...key, quantity: '1' })) }))).rejects.toMatchObject({ statusCode: 400 });
        expect(await balance()).toBeUndefined();
    });
    test('rejects an unsafe numeric reference before acquiring any database locks', async () => {
        const query = vi.fn();
        await expect(ledger.post({ query }, input('receipt', '1', { lines: [{ ...key, stock_item_id: Number.MAX_SAFE_INTEGER + 1, quantity: '1' }] }), 1))
            .rejects.toMatchObject({ statusCode: 400 });
        expect(query).not.toHaveBeenCalled();
    });
    test('rejects forged legacy identities and duplicate stock keys without a partial balance', async () => {
        const [other] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Other','count','unit','active')");
        await expect(post(input('receipt', '1', { lines: [{ stock_item_id: other.insertId, location_id: '777', lot_id: '888', quantity: '1' }] }))).rejects.toMatchObject({ statusCode: 409 });
        await expect(post(input('receipt', '1', { lines: [{ ...key, quantity: '1' }, { ...key, quantity: '2' }] }))).rejects.toMatchObject({ statusCode: 400 });
        expect(await balance()).toBeUndefined();
    });
    test('quantity overflow rolls back and explicit zero remains a known count', async () => {
        await post(input('opening', '9999999999.999999'));
        await expect(post(input('receipt', '0.000001'))).rejects.toMatchObject({ statusCode: 400 });
        expect((await balance()).quantity).toBe('9999999999.999999');
        await post(input('count', '0', { lines: [{ ...key, quantity: '0', expected_version: '1' }] }));
        expect((await balance()).quantity).toBe('0.000000');
        expect(Number((await balance()).quantity_known)).toBe(1);
    });
    test('core DDL reruns without changing posted history', async () => {
        await post(input('opening', '7'));
        const conn = await pool.getConnection();
        try { for (const statement of splitMysqlScript(sql)) await conn.query(statement); }
        finally { conn.release(); }
        expect((await balance()).quantity).toBe('7.000000');
    });
    test('rejects retired transfer and preparation operations without changing stock', async () => {
        await post(input('opening', '5'));
        for (const kind of ['transfer','preparation']) {
            await expect(post(input(kind, '-2'))).rejects.toMatchObject({statusCode:400});
        }
        expect((await balance()).quantity).toBe('5.000000');
        const [[row]] = await pool.query('SELECT COUNT(*) count FROM stock_movements WHERE stock_item_id=?',[key.stock_item_id]);
        expect(row.count).toBe(1);
    });
    test('a hundred-line opening posts in the same bounded number of statements', async () => {
        const prefix = randomUUID();
        await pool.query('INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ?',
            [Array.from({ length: 100 }, (_, index) => [`${prefix}-${index}`, 'count', 'unit', 'active'])]);
        const [items] = await pool.query('SELECT id FROM stock_items WHERE name LIKE ? ORDER BY id', [`${prefix}%`]);

        const intent = input('opening', '0', { lines: items.map(item => ({ stock_item_id: item.id, quantity: '1.000001', expected_version: '0' })) });
        const conn = await pool.getConnection();
        let queries = 0;
        try {
            await conn.beginTransaction();
            const result = await ledger.post({ query: (...args) => { queries++; return conn.query(...args); } }, intent, 1);
            expect(result.lines).toHaveLength(100);
            expect(result.lines.every(line => line.quantity === '1.000001')).toBe(true);
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
        const single = await pool.getConnection();
        let singleQueries = 0;
        try {
            await single.beginTransaction();
            await ledger.post({ query: (...args) => { singleQueries++; return single.query(...args); } }, input('opening', '1'), 1);
            await single.commit();
        } catch (error) { await single.rollback(); throw error; }
        finally { single.release(); }
        expect(queries).toBe(singleQueries);
        const [[journal]] = await pool.query('SELECT COUNT(*) AS count,CAST(SUM(quantity) AS CHAR) AS quantity FROM stock_movements WHERE stock_item_id IN (?)', [items.map(item => item.id)]);
        expect(Number(journal.count)).toBe(100);
        expect(journal.quantity).toBe('100.000100');
    });
    test.each([false, true])('product adapter proves stock parity and rejects a mismatched writer (mismatch=%s)', async mismatch => {
        const [insert] = await pool.query("INSERT INTO products(name,price,stock) VALUES ('Adapter fixture',1,10)");
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [insert.insertId, key.stock_item_id]);
        await post(input('opening', '10'));
        const conn = await pool.getConnection();
        let outcome;
        try {
            await conn.beginTransaction();
            const [before] = await conn.query('SELECT id,CAST(stock AS CHAR) AS stock,CAST(stock_version AS CHAR) AS stock_version FROM products WHERE id=? FOR UPDATE', [insert.insertId]);
            if (mismatch) await conn.query('UPDATE products SET stock=stock-3,stock_version=stock_version+1 WHERE id=?', [insert.insertId]);
            outcome = journalProductDeltas(conn, { before, deltas: new Map([[insert.insertId, '-2']]), kind: 'issue',
                source: { type: 'invoice', id: '42' }, businessDate: '2026-09-08', actorId: 1 });
            if (mismatch) {
                await expect(outcome).rejects.toMatchObject({ statusCode: 409 });
                await conn.rollback();
            } else {
                expect((await outcome).lines[0].quantity).toBe('8.000000');
                await conn.commit();
            }
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
        const [[product]] = await pool.query('SELECT CAST(stock AS CHAR) AS stock FROM products WHERE id=?', [insert.insertId]);
        expect(product.stock).toBe(mismatch ? '10.000000' : '8.000000');
        expect((await balance()).quantity).toBe(product.stock);
    });
    test('stock service sale and return journal their source and preserve exact product parity', async () => {
        const [insert] = await pool.query("INSERT INTO products(name,price,stock) VALUES ('Service adapter fixture',1,10)");
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [insert.insertId, key.stock_item_id]);
        await post(input('opening', '10'));
        const conn = await pool.getConnection();
        const cart = [{ product_id: insert.insertId, qty: 0.217391 }];
        try {
            await conn.beginTransaction();
            await deductStockForCart(conn, cart, { source: { type: 'invoice', id: '51' }, businessDate: '2026-09-08', actorId: 1 });
            await conn.commit();
            expect((await balance()).quantity).toBe('9.782609');
            await conn.beginTransaction();
            await restoreStockForCart(conn, cart, { source: { type: 'refund', id: '52' }, businessDate: '2026-09-08', actorId: 1 });
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
        const [[product]] = await pool.query('SELECT CAST(stock AS CHAR) AS stock,stock_version FROM products WHERE id=?', [insert.insertId]);
        expect(product.stock).toBe('10.000000');
        expect(Number(product.stock_version)).toBe(2);
        expect((await balance()).quantity).toBe(product.stock);
        const [movements] = await pool.query('SELECT source_line FROM stock_movements WHERE stock_item_id=? AND source_line IS NOT NULL ORDER BY id', [key.stock_item_id]);
        expect(movements.map(row => row.source_line)).toEqual([`invoice:51:product:${insert.insertId}`, `refund:52:product:${insert.insertId}`]);
    });
    test('a linked product cannot silently revert to untracked stock', async () => {
        const [insert] = await pool.query("INSERT INTO products(name,price,stock) VALUES ('Broken projection',1,NULL)");
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [insert.insertId, key.stock_item_id]);
        await post(input('opening', '10'));
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const saved = await deductStockForCart(conn, [{ product_id: insert.insertId, qty: 1 }], {
                source: { type: 'invoice', id: '53' }, businessDate: '2026-09-08', actorId: 1
            });
            expect(saved.get(insert.insertId).authority).toBe('product');
            await conn.commit();
        } finally { conn.release(); }
        expect((await balance()).quantity).toBe('9.000000');
        const [[projection]] = await pool.query('SELECT CAST(stock AS CHAR) stock FROM products WHERE id=?', [insert.insertId]);
        expect(projection.stock).toBe('9.000000');
    });
});
