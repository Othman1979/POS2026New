const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const activation = require('../../services/StockActivationService');
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const { app } = require('../../../server');

describe('Ingredient cutover held recipes', () => {
    let ingredientId;
    beforeEach(async () => {
        await seedDatabase();
        const [item] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Chicken','weight','g')");
        ingredientId = item.insertId;
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (1,?,1)', [ingredientId]);
    });
    afterAll(() => pool.end());
    async function hold(cart) {
        return (await pool.query("INSERT INTO held_orders(user_id,reference_name,cart_data) VALUES (1,'Held recipe',?)", [typeof cart === 'string' ? cart : JSON.stringify(cart)]))[0].insertId;
    }
    test.each([[{id:1,qty:1}], {items:[{product_id:'1',qty:1}]}].map(cart=>({cart})))('finds current held compositions in supported cart shapes: %j', async ({cart}) => {
        const id = await hold(cart);
        expect(await activation.findIngredientHeldOrder(pool, ingredientId)).toMatchObject({held_order_id:id,code:'held_order'});
    });
    test('uses frozen split compositions instead of interpreting the current product recipe', async () => {
        const key = randomBytes(16).toString('hex');
        await pool.query("INSERT INTO recipe_ledger_lines(line_key,ingredient_ids) VALUES (?,'[]')", [key]);
        await hold([{product_id:1,qty:1,recipe_line_key:key}]);
        expect(await activation.findIngredientHeldOrder(pool, ingredientId)).toBeNull();
        const oldKey = randomBytes(16).toString('hex');
        await pool.query('INSERT INTO recipe_ledger_lines(line_key,ingredient_ids) VALUES (?,?)', [oldKey, JSON.stringify([ingredientId])]);
        const id = await hold([{product_id:2,qty:1,recipe_line_key:oldKey}]);
        expect(await activation.findIngredientHeldOrder(pool, ingredientId)).toMatchObject({held_order_id:id,code:'held_order'});
    });
    test.each(['{broken', '{}', '[null]', '[{"recipe_line_key":"missing","product_id":2}]'])('fails closed on unreadable held evidence: %s', async (cart) => {
        const id = await hold(cart);
        expect(await activation.findIngredientHeldOrder(pool, ingredientId)).toMatchObject({held_order_id:id,code:'invalid_held_recipe'});
    });
    test('finds a matching cart beyond the first bounded page', async () => {
        for(let i=0;i<26;i++) await hold([{id:2,qty:1}]);
        const id = await hold([{id:1,qty:1}]);
        expect(await activation.findIngredientHeldOrder(pool, ingredientId)).toMatchObject({held_order_id:id});
    });
    test('checks a large repeated cart with bounded recipe queries and still examines the final batch', async () => {
        const lines = Array.from({length:205},()=>({id:2,qty:1}));
        const id = await hold(lines);
        let queries = 0;
        const measured = {query: (...args) => { queries++; return pool.query(...args); }};
        expect(await activation.findIngredientHeldOrder(measured, ingredientId)).toBeNull();
        // Repeated products reuse verified evidence; count actual executed SQL.
        expect(queries).toBeLessThanOrEqual(5);
        lines[204] = {id:1,qty:1};
        await pool.query('UPDATE held_orders SET cart_data=? WHERE id=?', [JSON.stringify(lines),id]);
        expect(await activation.findIngredientHeldOrder(pool, ingredientId)).toMatchObject({held_order_id:id});
    });
    test('reuses verified recipe lookups across holds without skipping a later matching cart', async () => {
        const key = randomBytes(16).toString('hex');
        await pool.query("INSERT INTO recipe_ledger_lines(line_key,ingredient_ids) VALUES (?,'[]')", [key]);
        const cart = JSON.stringify(Array.from({length:100}, (_, i) => i % 2 ? {id:2,qty:1} : {id:1,qty:1,recipe_line_key:key}));
        await pool.query('INSERT INTO held_orders(user_id,reference_name,cart_data) VALUES ?', [Array.from({length:100}, () => [1,'Repeated cart',cart])]);
        let queries = 0;
        const measured = {query: (...args) => { queries++; return pool.query(...args); }};
        expect(await activation.findIngredientHeldOrder(measured, ingredientId)).toBeNull();
        // Five bounded held pages and one lookup for each kind of recipe evidence.
        expect(queries).toBeLessThanOrEqual(7);
        const id = await hold([{id:1,qty:1}]);
        expect(await activation.findIngredientHeldOrder(pool, ingredientId)).toMatchObject({held_order_id:id,code:'held_order'});
        // A subsequent activation/preflight must re-read changed current recipes.
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (2,?,1)', [ingredientId]);
        expect((await activation.findIngredientHeldOrder(pool, ingredientId)).held_order_id).not.toBe(id);
    });
    test.each([
        {method:'put',path:'/api/admin/products/4/bundle-items',body:{items:[{product_id:2,qty:3}]}},
        {method:'put',path:'/api/admin/products/4/recipe',body:{lines:[]}},
        {method:'post',path:'/api/admin/audit-reports/restore-y'}
    ])('serializes held composition writers with the ingredient activation fence: $path', async ({method,path,body}) => {
        const login = await request(app).post('/api/auth/login').send({user_number:'9001'});
        expect(login.status, JSON.stringify(login.body)).toBe(200);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (4,?,1)', [ingredientId]);
        if(method==='post'){
            const held = [{id:700,user_id:1,reference_name:'Recovery',cart_data:JSON.stringify([{id:1,qty:1}]),subtotal:5,created_at:new Date().toISOString()}];
            const [archive]=await pool.query(`INSERT INTO master_held(business_start_at,business_end_at,report_payload,held_orders_payload,expires_at)
                VALUES (NOW(),NOW(),'{}',?,DATE_ADD(NOW(),INTERVAL 1 DAY))`,[JSON.stringify(held)]);
            body={archive_id:archive.insertId};
        }
        const owner = await pool.getConnection();
        let pending, response, settled = false;
        try {
            await owner.beginTransaction();
            await owner.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' FOR UPDATE");
            const [[thread]] = await owner.query('SELECT CONNECTION_ID() id');
            pending = request(app)[method](path).set('Cookie',login.headers['set-cookie'][0]).send(body)
                .then(result => { settled = true; response = result; return result; });
            // Observe a real InnoDB wait, then verify the write after release.
            // Leave time between reads for InnoDB's diagnostic snapshot to refresh.
            await vi.waitFor(async () => {
                expect(settled, response && JSON.stringify({status:response.status,body:response.body})).toBe(false);
                const [[waits]] = await pool.query(`SELECT COUNT(*) n FROM information_schema.INNODB_LOCK_WAITS w
                    JOIN information_schema.INNODB_TRX t ON t.trx_id=w.blocking_trx_id
                    WHERE t.trx_mysql_thread_id=?`,[thread.id]);
                expect(Number(waits.n)).toBeGreaterThan(0);
                expect(settled).toBe(false);
            }, {timeout:3000,interval:200});
        } finally { await owner.rollback(); owner.release(); if(pending)response=await pending; }
        expect(response.status,JSON.stringify(response.body)).toBe(200);
        if (path.endsWith('bundle-items')) {
            const [rows] = await pool.query('SELECT product_id,qty FROM product_bundle_items WHERE bundle_id=4');
            expect(rows.map(row=>({product_id:row.product_id,qty:Number(row.qty)}))).toEqual([{product_id:2,qty:3}]);
        } else if (method==='put') {
            const [rows] = await pool.query('SELECT ingredient_id FROM product_recipe_lines WHERE product_id=4');
            expect(rows).toHaveLength(0);
        } else {
            const [[held]] = await pool.query('SELECT cart_data FROM held_orders WHERE id=700');
            expect(JSON.parse(held.cart_data)).toEqual([{id:1,qty:1}]);
            const [[archive]] = await pool.query('SELECT restored_at FROM master_held WHERE id=?',[body.archive_id]);
            expect(archive.restored_at).not.toBeNull();
        }
    });
});
