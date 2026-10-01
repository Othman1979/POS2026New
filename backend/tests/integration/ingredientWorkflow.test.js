const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const L = require('../../services/RecipeLedgerService');
const { getBusinessDate } = require('../../utils/businessDate');

describe('continuous ingredient stock workflow', () => {
    let ids;
    const actor = { id: SEED.adminUser.id, name: SEED.adminUser.name };
    const businessDate = getBusinessDate();
    async function tx(work) {
        const conn = await pool.getConnection();
        try { await conn.beginTransaction(); const result = await work(conn); await conn.commit(); return result; }
        catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    }
    const batch = (kind, entries, clientKey) => tx(conn => L.recordStockBatch(conn, { kind, entries, clientKey, actor, businessDate }));
    const entry = (index, qty) => ({ ingredient_id: ids[index], qty, unit: 'kg' });
    beforeAll(async () => {
        await seedDatabase();
        ids = [];
        for (const name of ['Workflow chicken', 'Workflow potatoes']) {
            const [result] = await pool.query("INSERT INTO ingredients (name,measure,display_unit,is_active) VALUES (?,'weight','kg',1)", [name]);
            ids.push(result.insertId);
        }
    });
    afterAll(() => pool.end());
    it('establishes stock once, receives together, carries forward, and reconciles later counts', async () => {
        await batch('count', [entry(0, 10), entry(1, 0)], 'workflow-initial');
        const delivery = [entry(0, 2), entry(1, 5)];
        expect((await batch('receipt', delivery, 'workflow-delivery')).replay).toBe(false);
        expect((await batch('receipt', [...delivery].reverse(), 'workflow-delivery')).replay).toBe(true);
        const future = await L.getIngredientSummaries(pool, { businessDate: '2099-01-01' });
        expect(future.find(row => row.id === ids[0]).expected_remaining).toBe(12000);
        expect(future.find(row => row.id === ids[0]).today.opening).toBeNull();
        const count = await batch('count', [entry(0, 11)], 'workflow-recount');
        expect(Number(count.movements[0].expected_qty)).toBe(12000);
        expect(Number(count.movements[0].qty)).toBe(11000);
    });
    it('rejects changed batch membership or amounts on retry', async () => {
        await expect(batch('receipt', [entry(0, 2)], 'workflow-delivery')).rejects.toMatchObject({ statusCode: 409 });
        await expect(batch('receipt', [entry(0, 3), entry(1, 5)], 'workflow-delivery')).rejects.toMatchObject({ statusCode: 409 });
    });
    it('rolls back the entire delivery when a later row is invalid', async () => {
        const [[before]] = await pool.query("SELECT COUNT(*) AS n FROM stock_movements WHERE movement_type='ingredient' ");
        await expect(batch('receipt', [entry(0, 3), entry(1, -1)], 'workflow-invalid')).rejects.toMatchObject({ statusCode: 400 });
        const [[after]] = await pool.query("SELECT COUNT(*) AS n FROM stock_movements WHERE movement_type='ingredient' ");
        expect(after.n).toBe(before.n);
        await expect(batch('count', [entry(0, 1), entry(0, 2)], 'workflow-duplicate')).rejects.toMatchObject({ statusCode: 400 });
        await expect(batch('count', [entry(0, '')], 'workflow-blank')).rejects.toMatchObject({ statusCode: 400 });
    });
    it('serializes concurrent retries into one delivery', async () => {
        const entries = [entry(0, 1), entry(1, 1)];
        const results = await Promise.all([batch('receipt', entries, 'workflow-concurrent'), batch('receipt', entries, 'workflow-concurrent')]);
        expect(results.map(result => result.replay).sort()).toEqual([false, true]);
        expect(results[0].movements.map(row=>row.id)).toEqual(results[1].movements.map(row=>row.id));
    });
    it('keeps initialized receipt query cost constant from one to 100 ingredients', async () => {
        await pool.query('INSERT INTO ingredients(name,measure,display_unit) VALUES ?',[
            Array.from({length:100},(_,i)=>[`Budget ingredient ${i}`,'weight','kg'])
        ]);
        const [ingredients] = await pool.query("SELECT id FROM ingredients WHERE name LIKE 'Budget ingredient %' ORDER BY id");
        const entries = ingredients.map(row=>({ingredient_id:row.id,qty:0,unit:'kg'}));
        await batch('count',entries,'budget-initial-count');
        const counts=[];
        for(const size of [1,100]){
            let queries=0;
            const result=await tx(conn=>L.recordStockBatch({query:(...args)=>{queries++;return conn.query(...args);}},
                {kind:'receipt',entries:entries.slice(0,size).map(row=>({...row,qty:1})),clientKey:`workflow-budget-${size}`,actor,businessDate}));
            expect(result.movements).toHaveLength(size);
            expect(result.movements.every(row=>Number(row.qty)===1000)).toBe(true);
            counts.push(queries);
        }
        // Includes working-balance maintenance, authority lookup and dirty-day
        // publication, not only the original four movement queries.
        expect(counts[1]).toBe(counts[0]);
        expect(counts[1]).toBeLessThanOrEqual(9);
        const [balances]=await pool.query('SELECT working_quantity AS quantity FROM ingredients WHERE id IN (?) ORDER BY id',[ingredients.map(row=>row.id)]);
        expect(balances.map(row=>Number(row.quantity))).toEqual([2000,...Array(99).fill(1000)]);
    });
    it('preserves comparison when an older client submits another opening count', async () => {
        const before = (await L.getIngredientSummaries(pool, { businessDate })).find(row => row.id === ids[0]);
        const result = await tx(conn => L.recordOpeningCounts(conn, { entries: [entry(0, 9)], clientKey: 'workflow-legacy-recount', actor, businessDate }));
        expect(Number(result.movements[0].expected_qty)).toBe(before.expected_remaining);
    });
    it('amends a receipt once and leaves later physical counts authoritative', async () => {
        const original = await batch('receipt', [entry(0, 5)], 'amend-source');
        const movementId = original.movements[0].id;
        const before = (await L.getIngredientSummaries(pool, { businessDate })).find(row => row.id === ids[0]).expected_remaining;
        const args = { movementId, qty: 3, unit: 'kg', note: 'Supplier quantity entered incorrectly', clientKey: 'amend-once', actor, businessDate };
        const result = await tx(conn => L.amendManualMovement(conn, args));
        expect(Number(result.movement.qty)).toBe(-2000);
        expect((await tx(conn => L.amendManualMovement(conn, args))).replay).toBe(true);
        expect((await L.getIngredientSummaries(pool, { businessDate })).find(row => row.id === ids[0]).expected_remaining).toBe(before - 2000);
        await expect(tx(conn => L.amendManualMovement(conn, { ...args, qty: 4 }))).rejects.toMatchObject({ statusCode: 409 });
        const old = (await batch('receipt', [entry(1, 4)], 'amend-before-count')).movements[0];
        await batch('count', [entry(1, 8)], 'amend-count-anchor');
        await tx(conn => L.amendManualMovement(conn, { ...args, movementId: old.id, qty: 2, clientKey: 'amend-after-count' }));
        expect((await L.getIngredientSummaries(pool, { businessDate })).find(row => row.id === ids[1]).expected_remaining).toBe(8000);
        await expect(tx(conn => L.amendManualMovement(conn, { ...args, movementId: old.id, clientKey: 'amend-again' }))).rejects.toMatchObject({ statusCode: 409 });
    });
});
