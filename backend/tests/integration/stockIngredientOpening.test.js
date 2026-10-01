const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const activation = require('../../services/StockActivationService');
const { randomUUID } = require('node:crypto');

describe('Ingredient authority opening evidence', () => {
    let ingredientId;
    beforeAll(() => seedDatabase());
    beforeEach(async () => {
        const [row] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES (?,'weight','g')", [`Chicken ${randomUUID()}`]);
        ingredientId = row.insertId;
    });
    afterAll(() => pool.end());
    async function movement(kind, qty, corrects = null) {
        const [row] = await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,source_type,business_date,corrects_movement_id)\n            VALUES ('ingredient',?,?,?,'manual','2026-09-08',?)", [ingredientId, kind, qty, corrects]);
        return String(row.insertId);
    }
    async function opening() {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await activation.readIngredientOpening(conn, ingredientId);
            await conn.commit();
            return result;
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    }
    test('distinguishes no observations, unknown movement deltas and an explicit zero count', async () => {
        expect(await opening()).toMatchObject({ quantity: null, quantity_known: false, running_delta: '0.000000', movement_watermark: '0', count_id: null });
        await movement('receipt', '100');
        const usage = await movement('usage', '-125.125001');
        expect(await opening()).toMatchObject({ quantity: null, quantity_known: false, running_delta: '-25.125001', movement_watermark: usage, count_id: null });
        const count = await movement('count', '0');
        expect(await opening()).toMatchObject({ quantity: '0.000000', quantity_known: true, running_delta: '0.000000', movement_watermark: count, count_id: count });
    });
    test('a later physical count supersedes earlier receipts and their later corrections', async () => {
        const oldReceipt = await movement('receipt', '100');
        await movement('count', '40');
        await movement('usage', '-4');
        const lastCount = await movement('count', '30');
        await movement('correction', '-100', oldReceipt);
        const newReceipt = await movement('receipt', '10');
        await movement('correction', '-3', newReceipt);
        const last = await movement('usage', '-50');
        expect(await opening()).toMatchObject({ quantity: '-13.000000', quantity_known: true, running_delta: '-43.000000', movement_watermark: last, count_id: lastCount });
    });
    test('preserves six-place quantities beyond the exact binary-number range', async () => {
        await movement('count', '9999999999.000001');
        await movement('usage', '-0.000001');
        expect((await opening()).quantity).toBe('9999999999.000000');
    });
    test('current reads include committed movements even when the caller already has an older snapshot', async () => {
        await movement('count', '10');
        const conn = await pool.getConnection();
        try {
            await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await conn.beginTransaction();
            await conn.query("SELECT id FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=?", [ingredientId]);
            const latest = await movement('usage', '-2');
            expect(await activation.readIngredientOpening(conn, ingredientId)).toMatchObject({ quantity: '8.000000', movement_watermark: latest });
        } finally { await conn.rollback(); conn.release(); }
    });
    test('rejects missing and invalid identities without creating stock authority', async () => {
        await expect(activation.readIngredientOpening(pool, '1 OR 1')).rejects.toMatchObject({ statusCode: 400 });
        await expect(activation.readIngredientOpening(pool, 2147483647)).rejects.toMatchObject({ statusCode: 404 });
        expect((await pool.query('SELECT id FROM stock_items WHERE legacy_ingredient_id=?', [ingredientId]))[0]).toHaveLength(0);
    });
    test('holds the ingredient writer lock until the caller commits the cutover transaction', async () => {
        await movement('count', '5');
        const owner = await pool.getConnection();
        const writer = await pool.getConnection();
        try {
            await owner.beginTransaction();
            await activation.readIngredientOpening(owner, ingredientId);
            await writer.query('SET SESSION innodb_lock_wait_timeout=1');
            await writer.beginTransaction();
            await expect(writer.query('SELECT id FROM ingredients WHERE id=? FOR UPDATE', [ingredientId]))
                .rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });
            await writer.rollback();
            await owner.commit();
            await writer.beginTransaction();
            expect((await writer.query('SELECT id FROM ingredients WHERE id=? FOR UPDATE', [ingredientId]))[0]).toHaveLength(1);
        } finally {
            await owner.rollback(); await writer.rollback();
            await writer.query('SET SESSION innodb_lock_wait_timeout=DEFAULT');
            owner.release(); writer.release();
        }
    });
    test('rejects an out-of-range known balance rather than rounding or truncating it for activation', async () => {
        await movement('count', '9999999999.999999');
        await movement('receipt', '0.000001');
        await expect(opening()).rejects.toMatchObject({ statusCode: 409 });
    });
    test('changes the observation token for new evidence even when the resulting balance is unchanged', async () => {
        await movement('count', '10');
        const first = await opening();
        expect(first.observation_token).toMatch(/^[a-f0-9]{64}$/);
        expect((await opening()).observation_token).toBe(first.observation_token);
        await movement('receipt', '1');
        await movement('usage', '-1');
        const second = await opening();
        expect(second.quantity).toBe(first.quantity);
        expect(second.observation_token).not.toBe(first.observation_token);
        await pool.query('UPDATE ingredients SET is_active=0 WHERE id=?', [ingredientId]);
        expect((await opening()).observation_token).not.toBe(second.observation_token);
    });
});
