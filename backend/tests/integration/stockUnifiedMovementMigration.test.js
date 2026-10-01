const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');

describe('Unified movements upgrade', () => {
    const target = require('../../migrations/auto-manifest.json').migrations.find(row => row.name === '2026-09-12-unified-stock-movements-v1');
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations', target.file), 'utf8');
    let directory, manifestPath, ingredientId, stockBefore, ingredientBefore;
    beforeAll(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-unified-movements-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        fs.writeFileSync(path.join(directory, target.file), sql);
    });
    beforeEach(async () => {
        await seedDatabase({ legacyMovementSchema: true });
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,working_quantity,working_quantity_known,working_last_count_id,working_initialized) VALUES ('Historical ingredient','count','unit',109.123456,1,100,1)");
        ingredientId = ingredient.insertId;
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Historical item','count','unit','active')");
        const [op] = await pool.query("INSERT INTO stock_operations(request_key,payload_hash,kind,actor_id,business_date,result_json) VALUES ('historical-operation',REPEAT('a',64),'receipt',1,'2026-08-01','{\"historical\":true}')");
        await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known,version,last_operation_id) VALUES (?,109.123456,1,7,?)', [item.insertId,op.insertId]);
        await pool.query("INSERT INTO stock_movements(id,operation_id,line_ordinal,stock_item_id,quantity,unit_snapshot,business_date) VALUES (100,?,0,?,10.123456,'unit','2026-08-01'),(101,?,1,?,1,'unit','2026-08-01')", [op.insertId,item.insertId,op.insertId,item.insertId]);
        await pool.query(`INSERT INTO ingredient_movements(id,ingredient_id,kind,qty,unit_cost,source_type,source_id,source_label,user_id,user_name,business_date,occurred_at,note,client_key,corrects_movement_id,purchase_priced,cost_source) VALUES
            (100,?,'count',100,0,'manual',NULL,'Count',1,'Cashier','2026-08-01','2026-08-01 01:02:03','Zero cost','count-key',NULL,0,'reference'),
            (101,?,'receipt',10.123456,1.12345678,'manual',NULL,'Delivery',1,'Cashier','2026-08-01','2026-08-01 02:03:04','Exact price','receipt-key',NULL,1,'purchase'),
            (102,?,'usage',-2,1.12345678,'order',77,'Order 77',1,'Cashier','2026-08-01','2026-08-01 03:04:05',NULL,NULL,NULL,0,'purchase_average'),
            (103,?,'correction',1,1.12345678,'manual',101,'Correction',1,'Cashier','2026-08-02','2026-08-02 04:05:06','Preserve correction','correction-key',101,0,'reference')`, Array(4).fill(ingredientId));
        await pool.query('ALTER TABLE ingredient_movements AUTO_INCREMENT=9007199254740993');
        stockBefore = (await pool.query('SELECT * FROM stock_movements ORDER BY id'))[0];
        ingredientBefore = (await pool.query('SELECT * FROM ingredient_movements ORDER BY id'))[0];
    });
    afterAll(async () => {
        await pool.end();
        fs.rmSync(directory, {recursive:true,force:true});
    });
    const migrate = () => runPendingMigrations(pool,{manifestPath});
    async function executeUntil(stop) {
        const conn = await pool.getConnection();
        try {
            for (const statement of splitMysqlScript(sql)) {
                await conn.query(statement);
                if (stop(statement)) break;
            }
        } finally { conn.release(); }
    }
    async function preserved() {
        const project = (rows, old) => rows.map(row => Object.fromEntries(Object.keys(old[0]).map(key => [key,row[key]])));
        const stock = (await pool.query("SELECT * FROM stock_movements WHERE movement_type='stock' ORDER BY id"))[0];
        const ingredient = (await pool.query("SELECT * FROM stock_movements WHERE movement_type='ingredient' ORDER BY id"))[0];
        expect(project(stock,stockBefore)).toEqual(stockBefore);
        expect(project(ingredient,ingredientBefore)).toEqual(ingredientBefore);
        // Physical movements use their operation's posted_at. Adding ingredient
        // metadata must not assign old physical rows the migration's timestamp.
        expect(stock.every(row => row.occurred_at===null)).toBe(true);
        expect(ingredient.every(row => row.operation_id===null && row.quantity===null)).toBe(true);
        expect((await pool.query('SELECT working_last_count_id FROM ingredients WHERE id=?',[ingredientId]))[0][0].working_last_count_id).toBe(100);
    }
    test('preserves both ID domains, exact source rows, count boundaries and allocation high-water marks', async () => {
        expect((await migrate()).applied).toEqual([target.name]);
        await preserved();
        const [[identity]] = await pool.query("SELECT CAST(AUTO_INCREMENT AS CHAR) next_id FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements'");
        expect(identity.next_id).toBe('9007199254740993');
        expect((await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements'"))[0]).toHaveLength(0);
        expect((await migrate()).applied).toEqual([]);
        await preserved();
        const recipe=require('../../services/RecipeLedgerService');
        const [summary]=await recipe.getIngredientSummaries(pool,{businessDate:'2026-08-01',ids:[ingredientId]});
        expect(summary.expected_remaining).toBe(109.123456);
        expect(summary.last_count.qty).toBe(100);
        expect(summary.last_count.at).toEqual(ingredientBefore[0].occurred_at);
        const {rows}=await recipe.listMovements(pool,{ingredientId});
        expect(rows).toHaveLength(4);
        expect(rows.find(row=>row.id===103).original_qty).toBe('10.123456');
    });
    test.each(['copy','drop'])('resumes interruption after %s and a raw rerun leaves later writes intact', async stage => {
        let copied=false;
        await executeUntil(statement => {
            if (statement.includes('INSERT INTO stock_movements(movement_type,id')) copied=true;
            return stage==='drop' ? statement.trim()==='DROP TABLE IF EXISTS ingredient_movements' : copied && statement.trim()==='DEALLOCATE PREPARE unified_movement_stmt';
        });
        expect((await migrate()).applied).toEqual([target.name]);
        await preserved();
        await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,source_type,business_date,client_key) VALUES ('ingredient',?,'receipt',2,'manual','2026-08-03','after-upgrade')",[ingredientId]);
        await executeUntil(() => false);
        expect((await pool.query("SELECT CAST(id AS CHAR) id,qty FROM stock_movements WHERE client_key='after-upgrade'"))[0][0]).toEqual({id:'9007199254740993',qty:'2.000000'});
    });
    test('streams every physical fact across a page boundary with overlapping historical movement IDs', async () => {
        const operationId = stockBefore[0].operation_id, itemId = stockBefore[0].stock_item_id;
        await pool.query('INSERT INTO stock_movements(id,operation_id,line_ordinal,stock_item_id,quantity,unit_snapshot,business_date) VALUES ?',
            [Array.from({length:99},(_,i)=>[102+i,operationId,2+i,itemId,1,'unit','2026-08-01'])]);
        await pool.query('INSERT INTO ingredient_movements(id,ingredient_id,kind,qty,source_type,business_date,occurred_at) VALUES ?',
            [Array.from({length:97},(_,i)=>[104+i,ingredientId,'receipt',1,'manual','2026-08-01','2026-08-01 02:03:04'])]);
        await migrate();
        // Migrated ingredient rows have no physical operation. A new attached
        // ingredient effect uses the shared allocator above both old counters.
        await pool.query(`INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,source_type,business_date,
            operation_id,line_ordinal,stock_item_id,quantity,unit_snapshot)
            VALUES ('ingredient',?,'receipt',3,'manual','2026-08-01',?,101,?,3,'unit')`,[ingredientId,operationId,itemId]);
        const [[attached]] = await pool.query("SELECT CAST(id AS CHAR) id FROM stock_movements WHERE movement_type='ingredient' AND operation_id=?",[operationId]);
        expect(attached.id).toBe('9007199254740993');
        const physical = [];
        const scope = require('../../services/StockReportGenerationService').scopeFor('operation',operationId);
        await require('../../services/StockReportFactService').stream(pool,{day:'2026-08-01',scope_id:scope},async row=>{
            if(row.table==='daily' && row.values[0]===String(itemId))physical.push(row.values);
        });
        expect(physical).toHaveLength(102);
        expect(physical.reduce((sum,row)=>sum+Number(row[3]),0)).toBeCloseTo(113.123456,6);
        expect(physical.every(row=>Number(row[4])===0)).toBe(true);
    });
    test('rejects a conflicting partial copy without dropping the source or replacing its original metadata', async () => {
        let copied=false;
        await executeUntil(statement => {
            if (statement.includes('INSERT INTO stock_movements(movement_type,id')) copied=true;
            return copied && statement.trim()==='DEALLOCATE PREPARE unified_movement_stmt';
        });
        await pool.query("UPDATE stock_movements SET note='zero cost' WHERE movement_type='ingredient' AND id=100");
        await expect(migrate()).rejects.toThrow();
        expect((await pool.query('SELECT note FROM ingredient_movements WHERE id=100'))[0][0].note).toBe('Zero cost');
        expect((await pool.query("SELECT note FROM stock_movements WHERE movement_type='ingredient' AND id=100"))[0][0].note).toBe('zero cost');
    });
    test('checks the predecessor and target checksum before changing the source', async () => {
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[target.requires.name]);
        await expect(migrate()).rejects.toThrow();
        expect((await pool.query('SELECT id FROM ingredient_movements'))[0]).toHaveLength(4);
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?),(?,?)',[target.requires.name,target.requires.checksum,target.name,'f'.repeat(64)]);
        await expect(migrate()).rejects.toThrow();
        expect((await pool.query('SELECT id FROM ingredient_movements'))[0]).toHaveLength(4);
    });

    test('copies a populated 10000-row history without losing precision or resetting stock balances', async () => {
        const values=Array.from({length:10000},(_,i)=>[i+200,ingredientId,'usage','-0.000001','0.12345678','order','2026-08-01']);
        for(let offset=0;offset<values.length;offset+=500)await pool.query('INSERT INTO ingredient_movements(id,ingredient_id,kind,qty,unit_cost,source_type,business_date) VALUES ?',[values.slice(offset,offset+500)]);
        const before=(await pool.query('SELECT COUNT(*) n,SUM(qty) qty,SUM(qty*unit_cost) cost FROM ingredient_movements'))[0][0];
        const balances=(await pool.query('SELECT * FROM stock_balances'))[0];
        await migrate();
        expect((await pool.query("SELECT COUNT(*) n,SUM(qty) qty,SUM(qty*unit_cost) cost FROM stock_movements WHERE movement_type='ingredient'"))[0][0]).toEqual(before);
        expect((await pool.query('SELECT * FROM stock_balances'))[0]).toEqual(balances);
    });
});
