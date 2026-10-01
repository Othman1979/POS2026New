const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { getBusinessDate } = require('../../utils/businessDate');
const L = require('../../services/RecipeLedgerService');

describe('RecipeLedgerService writes and reads', () => {
    let chicken;
    let pepsi;
    let k1;
    let k2;
    const actor = { id: SEED.adminUser.id, name: SEED.adminUser.name };
    const businessDate = getBusinessDate();

    async function tx(fn) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await fn(conn);
            await conn.commit();
            return result;
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    }

    async function net(ingredientId, lineKey) {
        const [[row]] = await pool.query(
            "SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND line_key=?",
            [ingredientId, lineKey]
        );
        return L.roundSix(row.qty);
    }

    async function summary(ingredientId) {
        const rows = await L.getIngredientSummaries(pool, { businessDate, includeInactive: true });
        return rows.find((row) => row.id === ingredientId);
    }

    async function idOf(clientKey) {
        const [[row]] = await pool.query("SELECT id FROM stock_movements WHERE movement_type='ingredient' AND client_key=?", [clientKey]);
        return row.id;
    }

    beforeAll(async () => {
        await seedDatabase();
        await pool.query(
            "UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'"
        );
        const [chickenResult] = await pool.query(`
            INSERT INTO ingredients
              (name, measure, display_unit, unit_cost, par_qty, pack_name, pack_size, is_active)
            VALUES ('Chicken', 'weight', 'kg', 0.0045, 5000, 'sack', 10000, 1)
        `);
        const [pepsiResult] = await pool.query(`
            INSERT INTO ingredients
              (name, measure, display_unit, unit_cost, par_qty, pack_name, pack_size, is_active)
            VALUES ('Pepsi', 'count', 'unit', 0.35, NULL, 'carton', 24, 1)
        `);
        chicken = chickenResult.insertId;
        pepsi = pepsiResult.insertId;
        await pool.query(`
            INSERT INTO product_recipe_lines (product_id, ingredient_id, qty_per_unit, sort_order)
            VALUES (?, ?, 200, 0), (?, ?, 1, 0)
        `, [SEED.product1.id, chicken, SEED.product2.id, pepsi]);
        k1 = L.newLineKey();
        k2 = L.newLineKey();
    });

    it('sync writes usage for new lines only, snapshots cost, and is idempotent', async () => {
        const lines = [
            { key: k1, product_id: 1, product_name: 'B', qty: 3, isNew: true },
            { key: k2, product_id: 2, product_name: 'D', qty: 2, isNew: true },
        ];
        await tx(async conn => {
            expect((await L.syncOrderLines(conn, { sourceId: 9001, sourceLabel: 'Table 1', lines, removedKeys: [], actor, businessDate })).written).toBe(2);
        });
        await tx(async conn => {
            expect((await L.syncOrderLines(conn, { sourceId: 9001, sourceLabel: 'Table 1', lines: lines.map(l => ({ ...l, isNew: false })), removedKeys: [], actor, businessDate })).written).toBe(0);
        });
        await tx(async conn => {
            expect((await L.syncOrderLines(conn, { sourceId: 9001, sourceLabel: 'Table 1', lines: [{ ...lines[0], qty: 4, isNew: false }, { ...lines[1], isNew: false }], removedKeys: [], actor, businessDate })).written).toBe(1);
        });
        expect(await net(chicken, k1)).toBe(-800);
        const [[row]] = await pool.query("SELECT unit_cost FROM stock_movements WHERE movement_type='ingredient' AND line_key = ? ORDER BY id LIMIT 1", [k1]);
        expect(Number(row.unit_cost)).toBe(0.0045);
    });

    it('a recipe change after the first save does not touch the saved line', async () => {
        await pool.query('UPDATE product_recipe_lines SET qty_per_unit = 250 WHERE product_id = 1');
        await tx(async conn => {
            expect((await L.syncOrderLines(conn, { sourceId: 9001, sourceLabel: 'Table 1', lines: [{ key: k1, product_id: 1, qty: 5, isNew: false }], removedKeys: [], actor, businessDate })).written).toBe(1);
        });
        expect(await net(chicken, k1)).toBe(-1000);
        await pool.query('UPDATE product_recipe_lines SET qty_per_unit = 200 WHERE product_id = 1');
    });

    it('reverseLineUsage is bounded and exact', async () => {
        await tx(conn => L.reverseLineUsage(conn, { lineKey: k1, qty: 2, sourceType: 'refund', sourceId: 77, sourceLabel: 'Refund #77', actor, businessDate }));
        await tx(conn => L.reverseLineUsage(conn, { lineKey: k1, qty: 10, sourceType: 'refund', sourceId: 78, sourceLabel: 'Refund #78', actor, businessDate }));
        expect(await net(chicken, k1)).toBe(0);
    });

    it('counts store expected and period usage; corrections respect count order', async () => {
        let s = await summary(pepsi);
        expect(s.today.used).toBe(2);
        expect(s.expected_remaining).toBeNull();
        expect(s.last_count).toBeNull();
        await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'receipt', qty: 10, unit: 'unit', clientKey: 'r0', actor, businessDate }));
        const opening = await tx(conn => L.recordOpeningCounts(conn, { entries: [{ ingredientId: pepsi, qty: 4, unit: 'unit', packs: 4 }], clientKey: 'open1', actor, businessDate }));
        expect(Number(opening.movements[0].qty)).toBe(100);
        expect(opening.movements[0].expected_qty).toBeNull();
        await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'receipt', qty: 1, unit: 'unit', packs: 1, unitCost: 0.30, clientKey: 'k1', actor, businessDate }));
        const replay = await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'receipt', qty: 1, unit: 'unit', packs: 1, unitCost: 0.30, clientKey: 'k1', actor, businessDate }));
        expect(replay.replay).toBe(true);
        await expect(tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'receipt', qty: 26, unit: 'unit', clientKey: 'k1', actor, businessDate }))).rejects.toMatchObject({ statusCode: 409 });
        await expect(tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'waste', qty: 4, unit: 'unit', clientKey: 'w0', actor, businessDate }))).rejects.toMatchObject({ statusCode: 400 });
        await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'waste', qty: 4, unit: 'unit', reason: 'expired', clientKey: 'w1', actor, businessDate }));
        await tx(conn => L.syncOrderLines(conn, { sourceId: 9002, sourceLabel: 'Order #2', lines: [{ key: L.newLineKey(), product_id: 2, product_name: 'D', qty: 6, isNew: true }], removedKeys: [], actor, businessDate }));
        s = await summary(pepsi);
        expect(s.today.opening).toBe(100);
        expect(s.expected_remaining).toBe(115);
        // The priced receipt (0.30 each) now supplies the purchase-weighted cost.
        expect(s.today.waste_cost).toBeCloseTo(1.2, 6);
        const count = await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'count', qty: 112, unit: 'unit', clientKey: 'c1', actor, businessDate }));
        expect(Number(count.movement.expected_qty)).toBe(115);
        expect(Number(count.movement.period_usage_qty)).toBe(6);
        s = await summary(pepsi);
        expect(s.last_count.variance_qty).toBe(-3);
        expect(s.last_count.variance_pct).toBeCloseTo(-0.5, 6);
        expect(s.expected_remaining).toBe(112);
        const receiptId = await idOf('r0');
        await tx(conn => L.correctManualMovement(conn, { movementId: receiptId, note: 'typo', clientKey: 'x0', actor, businessDate }));
        expect((await summary(pepsi)).expected_remaining).toBe(112);
        await expect(tx(conn => L.correctManualMovement(conn, { movementId: receiptId, note: 'again', clientKey: 'x1', actor, businessDate }))).rejects.toMatchObject({ statusCode: 409 });
        expect(Number((await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'count', qty: 0, unit: 'unit', clientKey: 'z', actor, businessDate }))).movement.qty)).toBe(0);
    });

    it('portions use expected remaining', async () => {
        expect((await L.getPortionsReport(pool)).find(p => p.product_id === 1)?.portions_possible ?? null).toBeNull();
        await tx(conn => L.recordManualMovement(conn, { ingredientId: chicken, kind: 'count', qty: 4.7, unit: 'kg', clientKey: 'ch', actor, businessDate }));
        expect((await L.getPortionsReport(pool)).find(p => p.product_id === 1)).toMatchObject({ portions_possible: 23, limiting_ingredient: expect.anything() });
    });

    it('history running balance includes hidden prefix rows', async () => {
        const { rows } = await L.listMovements(pool, { ingredientId: pepsi, beforeId: null, limit: 2 });
        const [all] = await pool.query(
            "SELECT id, kind, qty, corrects_movement_id FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? ORDER BY id",
            [pepsi]
        );
        expect(rows).toHaveLength(2);
        expect(rows[0].id).toBeGreaterThan(rows[1].id);
        for (const row of rows) {
            const prefix = all.filter((movement) => Number(movement.id) <= Number(row.id));
            const count = [...prefix].reverse().find((movement) => movement.kind === 'count');
            expect(row.running_balance).toBe(L.effectiveBalance(prefix, count.id));
        }
    });
});
