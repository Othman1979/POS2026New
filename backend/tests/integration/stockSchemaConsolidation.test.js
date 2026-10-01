const { randomUUID } = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const ledger = require('../../services/StockLedgerService');
const snapshots = require('../../services/StockSaleSnapshots');

describe('POS stock identity without warehouse dimensions', () => {
    beforeAll(() => seedDatabase());
    afterAll(() => pool.end());

    test('a stock item can be counted and consumed without a location or lot', async () => {
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Single balance','count','unit','active')");
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const input = { request_key: randomUUID(), kind: 'opening', business_date: '2026-09-12',
                lines: [{ stock_item_id: item.insertId, quantity: '10.000001', expected_version: '0' }] };
            await ledger.post(conn, input, 1);
            await ledger.post(conn, { ...input, request_key: randomUUID(), kind: 'issue',
                lines: [{ stock_item_id: item.insertId, quantity: '-0.000001' }] }, 1);
            const [[balance]] = await conn.query('SELECT CAST(quantity AS CHAR) quantity,quantity_known,version FROM stock_balances WHERE stock_item_id=?', [item.insertId]);
            expect(balance).toMatchObject({ quantity: '10.000000', quantity_known: 1, version: 2 });
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    });

    test('version 3 sale snapshots preserve stock composition without warehouse IDs', () => {
        const saved = { version: 3, components: [{ stock_item_id: '7', qty_per_sale: '0.250000', policy_version: '1' }] };
        expect(snapshots.read({ stock_authority: 'product', stock_snapshot: JSON.stringify(saved) })).toEqual({ ...saved, authority: 'product' });
        expect(() => snapshots.read({ stock_authority: 'product', stock_snapshot: { ...saved, components: [saved.components[0], saved.components[0]] } })).toThrow();
    });
});
