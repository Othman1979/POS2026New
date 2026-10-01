const { randomUUID } = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const recipe = require('../../services/RecipeLedgerService');
const activation = require('../../services/StockActivationService');

describe('Unified movement contract', () => {
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('stock_enabled','recipe_ledger_enabled')");
    });
    afterAll(() => pool.end());
    async function tx(work) {
        const conn = await pool.getConnection();
        try { await conn.beginTransaction(); const result = await work(conn); await conn.commit(); return result; }
        catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    }
    async function ingredient(name) {
        const [row] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES (?,'count','unit',1)", [name]);
        return row.insertId;
    }
    const day = '2026-09-12', actor = {id:1,name:'Fixture'};
    const manual = (id,kind,qty,extra={}) => tx(conn => recipe.recordManualMovement(conn,{
        ingredientId:id,kind,qty,unit:'unit',clientKey:randomUUID(),businessDate:day,actor,...extra
    }));
    async function activate(id) {
        const preview = await activation.inspectIngredient(pool,id);
        return tx(conn => activation.activateIngredient(conn,id,{observation_token:preview.observation_token,request_key:randomUUID()},1));
    }
    const physical = async id => (await pool.query('SELECT CAST(b.quantity AS CHAR) quantity,b.quantity_known known FROM stock_balances b JOIN ingredients i ON i.stock_item_id=b.stock_item_id WHERE i.id=?',[id]))[0][0];

    test('preserves counts, priced receipts, shared usage, partial returns and corrections across a newer count', async () => {
        const id = await ingredient('Contract ingredient');
        await manual(id,'count',100);
        const delivery = await manual(id,'receipt',20,{unitCost:2});
        await activate(id);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (1,?,2)',[id]);
        const key = 'a'.repeat(32);
        await tx(conn => recipe.syncOrderLines(conn,{sourceId:901,sourceLabel:'Contract',lines:[{key,isNew:true,product_id:1,qty:3}],removedKeys:[],actor,businessDate:day,enabled:true}));
        expect(await physical(id)).toEqual({quantity:'114.000000',known:1});
        await tx(conn => recipe.reverseLineUsage(conn,{lineKey:key,qty:1,sourceType:'refund',sourceId:902,actor,businessDate:day}));
        expect(await physical(id)).toEqual({quantity:'116.000000',known:1});
        await tx(conn => recipe.amendManualMovement(conn,{movementId:delivery.movement.id,qty:10,unit:'unit',note:'Correct receipt',clientKey:randomUUID(),actor,businessDate:day}));
        expect(await physical(id)).toEqual({quantity:'106.000000',known:1});
        const earlier = await manual(id,'receipt',5,{unitCost:0});
        const counted = await manual(id,'count',90);
        expect(Number(counted.movement.expected_qty)).toBe(111);
        expect(Number(counted.movement.period_usage_qty)).toBe(4);
        await tx(conn => recipe.amendManualMovement(conn,{movementId:earlier.movement.id,qty:3,unit:'unit',note:'Before count',clientKey:randomUUID(),actor,businessDate:'2026-09-13'}));
        expect(await physical(id)).toEqual({quantity:'90.000000',known:1});
        const [summary] = await recipe.getIngredientSummaries(pool,{businessDate:day,ids:[id]});
        expect(summary.expected_remaining).toBe(90);
        expect(summary.last_count.variance_qty).toBe(-21);
        expect(summary.today.used).toBe(4);
        expect(summary.today.used_cost).toBe(8);
    });

    test('preserves unactivated stock and unknown activated running quantities', async () => {
        const unlinked = await ingredient('No physical activation');
        await manual(unlinked,'count',0);
        const input = {clientKey:randomUUID()};
        await manual(unlinked,'receipt',0.25,input);
        expect((await manual(unlinked,'receipt',0.25,input)).replay).toBe(true);
        const unknown = await ingredient('Unknown physical');
        await activate(unknown);
        await manual(unknown,'waste',5,{reason:'other'});
        await manual(unknown,'receipt',3);
        expect(await physical(unknown)).toEqual({quantity:'-2.000000',known:0});
        await manual(unknown,'count',4);
        expect(await physical(unknown)).toEqual({quantity:'4.000000',known:1});
        const [summary] = await recipe.getIngredientSummaries(pool,{businessDate:day,ids:[unlinked]});
        expect(summary.expected_remaining).toBe(0.25);
    });

    test('MariaDB can retain overlapping historical IDs and allocate above both domains', async () => {
        await pool.query("CREATE TABLE unified_identity_probe (movement_type ENUM('stock','ingredient') NOT NULL,id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,PRIMARY KEY(movement_type,id),KEY(id)) ENGINE=InnoDB");
        try {
            await pool.query("INSERT INTO unified_identity_probe VALUES ('stock',7),('ingredient',7),('ingredient',9000)");
            const [next] = await pool.query("INSERT INTO unified_identity_probe(movement_type) VALUES ('stock')");
            expect(next.insertId).toBe(9001);
            expect((await pool.query('SELECT * FROM unified_identity_probe WHERE id=7'))[0]).toHaveLength(2);
        } finally { await pool.query('DROP TABLE unified_identity_probe'); }
    });

    test('a linked ingredient operation has one durable row containing its count and physical delta', async () => {
        const id = await ingredient('Single movement');
        await manual(id,'count',100);
        await activate(id);
        const count = await manual(id,'count',80);
        const [[row]] = await pool.query("SELECT qty,quantity FROM stock_movements WHERE movement_type='ingredient' AND id=?",[count.movement.id]);
        expect(Number(row.qty)).toBe(80);
        expect(Number(row.quantity)).toBe(-20);
        const [tables] = await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements'");
        expect(tables).toHaveLength(0);
    });

    test('a failure after attaching physical effects rolls back movement, quantities and report invalidation together', async () => {
        const id = await ingredient('Rollback');
        await manual(id,'count',10);
        await activate(id);
        const snapshot = async () => ({
            physical:await physical(id),
            working:(await pool.query('SELECT working_quantity,working_last_count_id FROM ingredients WHERE id=?',[id]))[0],
            movements:(await pool.query('SELECT * FROM stock_movements ORDER BY movement_type,id'))[0],
            operations:(await pool.query('SELECT * FROM stock_operations ORDER BY id'))[0],
            sources:(await pool.query('SELECT * FROM stock_operation_sources ORDER BY operation_id,line_ordinal'))[0],
            dirty:(await pool.query('SELECT * FROM stock_report_dirty ORDER BY day,scope_id'))[0]
        });
        const before = await snapshot();
        let injected=false;
        await expect(tx(conn => recipe.recordManualMovement({async query(sql,...args) {
            const result=await conn.query(sql,...args);
            if(sql.startsWith('INSERT INTO stock_operation_sources')) {injected=true;throw new Error('Injected after physical effect');}
            return result;
        }},{ingredientId:id,kind:'receipt',qty:2,unit:'unit',clientKey:randomUUID(),businessDate:day,actor}))).rejects.toThrow('Injected after physical effect');
        expect(injected).toBe(true);
        expect(await snapshot()).toEqual(before);
    });

    test('retry after a lost committed response returns the original row and applies the physical effect once', async () => {
        const id=await ingredient('Response loss');
        await manual(id,'count',10);
        await activate(id);
        const clientKey=randomUUID();
        const committed=await manual(id,'receipt',2,{clientKey});
        // The first caller never consumes its response. Its next request uses a
        // fresh transaction with the same durable key, as a network retry would.
        const retried=await manual(id,'receipt',2,{clientKey});
        expect(retried.replay).toBe(true);
        expect(retried.movement).toEqual(committed.movement);
        expect(retried.movement).not.toHaveProperty('movement_type');
        expect(retried.movement).not.toHaveProperty('quantity');
        expect(await physical(id)).toEqual({quantity:'12.000000',known:1});
        const [[rows]]=await pool.query('SELECT COUNT(*) n FROM stock_movements WHERE client_key=?',[clientKey]);
        expect(rows.n).toBe(1);
        await expect(manual(id,'receipt',3,{clientKey})).rejects.toMatchObject({statusCode:409});
        expect(await physical(id)).toEqual({quantity:'12.000000',known:1});
    });

    test('a stale transaction replay cannot commit a second physical effect before the unique client key rejects it', async () => {
        const id=await ingredient('Concurrent response loss');
        await manual(id,'count',10);
        await activate(id);
        const clientKey=randomUUID(),reader=await pool.getConnection();
        try {
            await reader.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await reader.beginTransaction();
            await reader.query('SELECT COUNT(*) FROM stock_movements');
            const winner=await manual(id,'receipt',2,{clientKey});
            const replay=await recipe.recordManualMovement(reader,{ingredientId:id,kind:'receipt',qty:2,unit:'unit',clientKey,businessDate:day,actor});
            expect(replay.replay).toBe(true);
            expect(replay.movement).toEqual(winner.movement);
            await reader.commit();
        } catch(error) {await reader.rollback();throw error;} finally {reader.release();}
        expect(await physical(id)).toEqual({quantity:'12.000000',known:1});
        const [[operations]]=await pool.query('SELECT COUNT(*) n FROM stock_operations');
        expect(operations.n).toBe(2);
        const [[working]]=await pool.query('SELECT working_quantity FROM ingredients WHERE id=?',[id]);
        expect(Number(working.working_quantity)).toBe(12);
    });
});
