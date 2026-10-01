const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');

describe('Ingredient state upgrade preserves its source data', () => {
    const target = require('../../migrations/auto-manifest.json').migrations.find(row => row.name === '2026-09-12-ingredient-state-v1');
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations', target.file), 'utf8');
    let directory, manifestPath, ingredientId, itemId;
    beforeAll(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-ingredient-state-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        fs.writeFileSync(path.join(directory, target.file), sql);
    });
    beforeEach(async () => {
        await seedDatabase({ legacyIngredientState: true });
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,updated_at) VALUES ('Preserved ingredient','count','unit','2026-08-01 12:00:00')");
        ingredientId = ingredient.insertId;
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Physical ingredient','count','unit','active')");
        itemId = item.insertId;
        const [op] = await pool.query("INSERT INTO stock_operations(request_key,payload_hash,kind,actor_id,business_date) VALUES ('historical-activation',REPEAT('a',64),'activation',1,'2026-08-01')");
        await pool.query(`INSERT INTO stock_ingredient_links(ingredient_id,stock_item_id,operation_id,movement_watermark,count_id,observation_token,quantity,quantity_known,request_key,activated_at)
            VALUES (?,?,?,99,88,REPEAT('b',64),0,1,'historical-activation','2026-08-01 12:34:56.123456')`, [ingredientId,itemId,op.insertId]);
        await pool.query(`INSERT INTO ingredient_working_balances(ingredient_id,quantity,quantity_known,last_count_id,period_usage,variance_qty,initialized)
            VALUES (?,'1234567890123456789012.123456',1,101,'1234567890123456789011.654321','-0.000001',1)`, [ingredientId]);
    });
    afterAll(async () => {
        await pool.end();
        for (const file of ['manifest.json', target.file]) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });
    const migrate = () => runPendingMigrations(pool, { manifestPath });
    const state = async () => (await pool.query(`SELECT CAST(working_quantity AS CHAR) quantity,working_quantity_known known,working_initialized initialized,
        CAST(working_period_usage AS CHAR) period_usage,CAST(working_variance_qty AS CHAR) variance_qty,working_last_count_id count_id,
        CAST(stock_activation_quantity AS CHAR) activation_quantity,stock_activation_quantity_known activation_known,stock_movement_watermark watermark,
        DATE_FORMAT(stock_activated_at,'%Y-%m-%d %H:%i:%s.%f') activated_at,DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s') updated_at FROM ingredients WHERE id=?`, [ingredientId]))[0][0];

    test('copies exact decimals, zero observations, count IDs and original timestamps, with the same uniqueness', async () => {
        expect((await migrate()).applied).toEqual([target.name]);
        expect(await state()).toEqual({ quantity:'1234567890123456789012.123456',known:1,initialized:1,period_usage:'1234567890123456789011.654321',variance_qty:'-0.000001',count_id:101,
            activation_quantity:'0.000000',activation_known:1,watermark:99,activated_at:'2026-08-01 12:34:56.123456',updated_at:'2026-08-01 12:00:00' });
        await expect(pool.query('DELETE FROM stock_items WHERE id=?', [itemId])).rejects.toMatchObject({code:'ER_ROW_IS_REFERENCED_2'});
        const [other] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Other ingredient','count','unit')");
        await expect(pool.query(`UPDATE ingredients i JOIN ingredients s ON s.id=?
            SET i.stock_item_id=s.stock_item_id,i.stock_activation_operation_id=s.stock_activation_operation_id,
            i.stock_movement_watermark=s.stock_movement_watermark,i.stock_activation_count_id=s.stock_activation_count_id,
            i.stock_observation_token=s.stock_observation_token,i.stock_activation_quantity=s.stock_activation_quantity,
            i.stock_activation_quantity_known=s.stock_activation_quantity_known,
            i.stock_activation_request_key='different-request',i.stock_activated_at=s.stock_activated_at WHERE i.id=?`,
            [ingredientId,other.insertId])).rejects.toMatchObject({code:'ER_DUP_ENTRY'});
        expect((await migrate()).applied).toEqual([]);
    });

    test('keeps absent and explicitly unknown working state distinct from a known zero', async () => {
        const [unknown] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Unknown','count','unit')");
        const [absent] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Uninitialized','count','unit')");
        await pool.query('INSERT INTO ingredient_working_balances(ingredient_id,quantity_known,initialized) VALUES (?,0,1)', [unknown.insertId]);
        await pool.query('UPDATE ingredient_working_balances SET quantity=0 WHERE ingredient_id=?', [ingredientId]);
        await migrate();
        const [rows] = await pool.query('SELECT working_quantity_known known,working_initialized initialized FROM ingredients ORDER BY id');
        expect(rows).toEqual([{known:1,initialized:1},{known:0,initialized:1},{known:0,initialized:0}]);
        const [[unlinked]] = await pool.query('SELECT stock_item_id FROM ingredients WHERE id=?', [absent.insertId]);
        expect(unlinked.stock_item_id).toBeNull();
    });

    test('rejects orphan activation data before adding columns or dropping either source', async () => {
        await pool.query('UPDATE stock_ingredient_links SET ingredient_id=999999 WHERE ingredient_id=?', [ingredientId]);
        await expect(migrate()).rejects.toThrow();
        const [columns] = await pool.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND COLUMN_NAME='stock_item_id'");
        expect(columns).toHaveLength(0);
        expect((await pool.query('SELECT ingredient_id FROM stock_ingredient_links'))[0]).toEqual([{ingredient_id:999999}]);
        expect((await pool.query('SELECT ingredient_id FROM ingredient_working_balances'))[0]).toHaveLength(1);
    });

    test('resumes after the first source table drop, then replay never resets newer state', async () => {
        const conn = await pool.getConnection();
        try {
            for (const statement of splitMysqlScript(sql)) {
                await conn.query(statement);
                if (statement.trim() === 'DROP TABLE IF EXISTS stock_ingredient_links') break;
            }
        } finally { conn.release(); }
        // No ledger stamp was written: startup must finish the interrupted DDL.
        expect((await migrate()).applied).toEqual([target.name]);
        expect((await state()).quantity).toBe('1234567890123456789012.123456');
        await pool.query('UPDATE ingredients SET working_quantity=17 WHERE id=?', [ingredientId]);
        const replay = await pool.getConnection();
        try { for (const statement of splitMysqlScript(sql)) await replay.query(statement); }
        finally { replay.release(); }
        expect((await state()).quantity).toBe('17.000000');
        expect((await state()).activated_at).toBe('2026-08-01 12:34:56.123456');
    });
});
