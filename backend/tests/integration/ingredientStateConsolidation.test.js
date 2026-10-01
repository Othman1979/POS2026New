const { randomUUID } = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const recipe = require('../../services/RecipeLedgerService');

describe('Ingredient state on its catalog identity', () => {
    beforeAll(() => seedDatabase());
    afterAll(() => pool.end());

    test('count zero, receive a fraction and retry without exposing internal state in the picker', async () => {
        const [created] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,updated_at) VALUES ('Merged ingredient','count','unit','2026-08-01 12:00:00')");
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const base = { ingredientId: created.insertId, unit: 'unit', businessDate: '2026-09-12', actor: { id: 1 } };
            await recipe.recordManualMovement(conn, { ...base, kind: 'count', qty: 0, clientKey: randomUUID() });
            const input = { ...base, kind: 'receipt', qty: 0.125, clientKey: randomUUID() };
            await recipe.recordManualMovement(conn, input);
            expect((await recipe.recordManualMovement(conn, input)).replay).toBe(true);
            const [[state]] = await conn.query('SELECT working_quantity,working_quantity_known,working_initialized,stock_item_id FROM ingredients WHERE id=?', [created.insertId]);
            expect(state).toMatchObject({ working_quantity: '0.125000', working_quantity_known: 1, working_initialized: 1, stock_item_id: null });
            const [[catalog]] = await conn.query("SELECT DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s') updated_at FROM ingredients WHERE id=?", [created.insertId]);
            expect(catalog.updated_at).toBe('2026-08-01 12:00:00');
            const { items: [visible] } = await recipe.listIngredientPage(conn, { q: 'Merged ingredient', view: 'picker' });
            expect(visible.expected_remaining).toBe(0.125);
            expect(Object.keys(visible).filter(key => key.startsWith('stock_') || key.startsWith('working_'))).toEqual([]);
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    });

    test('keeps ingredient state on its catalog row and movement history in the shared table', async () => {
        const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('stock_ingredient_links','ingredient_working_balances','ingredient_movements','stock_movements') ORDER BY TABLE_NAME");
        expect(tables.map(row => row.name)).toEqual(['stock_movements']);
    });
});
