const { seedDatabase } = require('../fixtures/seed');
const pool = require('../../config/db');

describe('recipe ledger fixture schema', () => {
    beforeAll(async () => {
        await seedDatabase();
    });

    async function column(table, name) {
        const [[row]] = await pool.query(`
            SELECT COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATA_TYPE
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = ?
               AND COLUMN_NAME = ?
        `, [table, name]);
        return row;
    }

    it('stores movement quantities and costs at the planned precision', async () => {
        const qty = await column('stock_movements', 'qty');
        const unitCost = await column('stock_movements', 'unit_cost');
        const expected = await column('stock_movements', 'expected_qty');
        const reason = await column('stock_movements', 'reason');

        expect(qty).toMatchObject({ DATA_TYPE: 'decimal', NUMERIC_PRECISION: 16, NUMERIC_SCALE: 6 });
        expect(unitCost).toMatchObject({ DATA_TYPE: 'decimal', NUMERIC_PRECISION: 16, NUMERIC_SCALE: 8 });
        expect(expected).toMatchObject({ DATA_TYPE: 'decimal', NUMERIC_PRECISION: 16, NUMERIC_SCALE: 6 });
        expect(String(reason.COLUMN_TYPE)).toContain('spoiled');
        expect(String(reason.COLUMN_TYPE)).toContain('expired');
        expect(String(reason.COLUMN_TYPE)).toContain('dropped_or_burnt');
        expect(String(reason.COLUMN_TYPE)).toContain('over_prepared');
        expect(String(reason.COLUMN_TYPE)).toContain('staff_meal');
        expect(String(reason.COLUMN_TYPE)).toContain('other');
    });

    it('stores recipe_line_key as char(32) on order lines', async () => {
        const orderItem = await column('order_items', 'recipe_line_key');
        expect(orderItem).toMatchObject({ DATA_TYPE: 'char', CHARACTER_MAXIMUM_LENGTH: 32 });
        expect(await column('subscription_redemption_items', 'recipe_line_key')).toBeUndefined();
    });
});
