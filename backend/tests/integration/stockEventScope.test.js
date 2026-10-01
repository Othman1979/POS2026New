const pool = require('../../config/db');
const logger = require('../../config/logger');
const { seedDatabase } = require('../fixtures/seed');
const { MAX_STOCK_EVENT_PRODUCT_IDS, resolveStockAffectedProductIds, emitStockChangedEvent, announceStockChanged } = require('../../services/StockEventScope');

describe('stock event scope', () => {
    let sold, sibling, ingredientLinked, unrelated, ingredientId;

    const newProduct = async (name) => (await pool.query('INSERT INTO products(name,price,stock) VALUES (?,1,10)', [name]))[0].insertId;
    const newStockItem = async (name) => (await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES (?,'count','unit','active')", [name]))[0].insertId;
    const capture = () => {
        const emit = vi.fn();
        return { io: { to: vi.fn(() => ({ emit })) }, emit };
    };

    // The one-lookup gate is process-wide: wait until a finished test's lookup has released it.
    const settleGate = async () => {
        await vi.waitFor(async () => {
            const probe = capture();
            await emitStockChangedEvent(probe.io, { productIds: [unrelated] });
            expect(probe.emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock', productIds: [unrelated] });
        }, { timeout: 3000 });
    };

    beforeAll(async () => {
        await seedDatabase();
        sold = await newProduct('Scope sold');
        sibling = await newProduct('Scope sibling');
        ingredientLinked = await newProduct('Scope ingredient linked');
        unrelated = await newProduct('Scope unrelated');
        const sharedItem = await newStockItem('Scope shared item');
        const ingredientItem = await newStockItem('Scope ingredient item');
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1),(?,?,1),(?,?,1)',
            [sold, sharedItem, sibling, sharedItem, ingredientLinked, ingredientItem]);
        // Only the link matters here, so skip the activation-operation foreign key on this one insert.
        const conn = await pool.getConnection();
        try {
            await conn.query('SET FOREIGN_KEY_CHECKS=0');
            [{ insertId: ingredientId }] = await conn.query(
                `INSERT INTO ingredients(name,measure,display_unit,unit_cost,stock_item_id,stock_activation_operation_id,stock_movement_watermark,
                    stock_observation_token,stock_activation_request_key,stock_activated_at,stock_activation_quantity_known)
                 VALUES ('Scope flour','weight','g',0.001,?,999999,0,REPEAT('a',64),'scope-flour',NOW(),0)`, [ingredientItem]);
        } finally {
            await conn.query('SET FOREIGN_KEY_CHECKS=1');
            conn.release();
        }
    });
    afterAll(() => pool.end());

    it('includes the sold product and every product sharing its stock item', async () => {
        expect(await resolveStockAffectedProductIds(pool, { productIds: [sold] })).toEqual([sold, sibling]);
    });

    it('keeps a legacy-stock product with no link as just itself', async () => {
        expect(await resolveStockAffectedProductIds(pool, { productIds: [unrelated] })).toEqual([unrelated]);
    });

    it('finds products whose availability moves because a recipe ingredient moved', async () => {
        expect(await resolveStockAffectedProductIds(pool, { productIds: [unrelated], ingredientIds: [ingredientId] }))
            .toEqual([ingredientLinked, unrelated]);
        expect(await resolveStockAffectedProductIds(pool, { ingredientIds: [ingredientId] })).toEqual([ingredientLinked]);
    });

    it('reports an unknown set when nothing identifies a product', async () => {
        expect(await resolveStockAffectedProductIds(pool, {})).toBeNull();
    });

    it('reports an unknown set above the id cap without querying', async () => {
        const query = vi.fn();
        const many = Array.from({ length: MAX_STOCK_EVENT_PRODUCT_IDS + 1 }, (_, index) => index + 1);
        expect(await resolveStockAffectedProductIds({ query }, { productIds: many })).toBeNull();
        expect(query).not.toHaveBeenCalled();
    });

    it('bounds the ingredient and stock item lists too, without querying', async () => {
        const query = vi.fn();
        const many = Array.from({ length: MAX_STOCK_EVENT_PRODUCT_IDS + 1 }, (_, index) => index + 1);
        expect(await resolveStockAffectedProductIds({ query }, { productIds: [1], ingredientIds: many })).toBeNull();
        expect(await resolveStockAffectedProductIds({ query }, { productIds: [1], stockItemIds: many.map(String) })).toBeNull();
        expect(query).not.toHaveBeenCalled();
    });

    it('sends the unscoped event when the lookup stalls past its deadline', async () => {
        const stalled = capture();
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        let settle;
        try {
            await emitStockChangedEvent(stalled.io, { productIds: [sold], timeoutMs: 20, db: { query: () => new Promise(resolve => { settle = resolve; }) } });
        } finally {
            logSpy.mockRestore();
        }
        expect(stalled.emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock' });
        settle([[]]);
        await settleGate();
    });

    it('cannot queue a second lookup behind a stalled one, and the server deadline ends the stalled read and frees its connection', async () => {
        const holder = await pool.getConnection();
        const baseline = pool.connectionTelemetrySnapshot().inUse;
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        try {
            // A table write lock stalls the real lookup on the server.
            await holder.query('LOCK TABLES product_stock_links WRITE');
            const first = capture();
            await emitStockChangedEvent(first.io, { productIds: [sold], timeoutMs: 400 });
            expect(first.emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock' });
            // The abandoned read is still the one in flight and still holds its connection.
            expect(pool.connectionTelemetrySnapshot().inUse).toBe(baseline + 1);

            // Every sale during the stall goes out unscoped at once and adds no query or connection.
            const query = vi.fn();
            const second = capture();
            await emitStockChangedEvent(second.io, { productIds: [sold], db: { query } });
            expect(second.emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock' });
            expect(query).not.toHaveBeenCalled();
            expect(pool.connectionTelemetrySnapshot().inUse).toBe(baseline + 1);

            // The server ends the read at its deadline, so the connection is released without the lock going away.
            await vi.waitFor(() => expect(pool.connectionTelemetrySnapshot().inUse).toBe(baseline), { timeout: 3000 });
        } finally {
            await holder.query('UNLOCK TABLES');
            holder.release();
            logSpy.mockRestore();
        }
        // The gate is open again: the next sale is scoped.
        const next = capture();
        await emitStockChangedEvent(next.io, { productIds: [sold] });
        expect(next.emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock', productIds: [sold, sibling] });
    });

    it('announceStockChanged returns before a stalled lookup settles', async () => {
        const io = capture();
        let settle;
        announceStockChanged(io.io, { productIds: [sold], timeoutMs: 20, db: { query: () => new Promise(resolve => { settle = resolve; }) } });
        expect(io.emit).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(io.emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock' }));
        settle([[]]);
        await settleGate();
    });

    it('logs the order context when the emit itself fails', async () => {
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        try {
            const io = { to: () => { throw new Error('socket gone'); } };
            announceStockChanged(io, { productIds: [sold], logContext: { route: '/api/pos/table_order', invoiceId: 7, tableId: 3 } });
            await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(
                expect.objectContaining({ route: '/api/pos/table_order', invoiceId: 7, tableId: 3 }), 'Stock event emit failed.'));
        } finally {
            logSpy.mockRestore();
        }
        await settleGate();
    });

    it('reports an unknown set when linked siblings push the result past the cap', async () => {
        const rows = Array.from({ length: MAX_STOCK_EVENT_PRODUCT_IDS + 5 }, (_, index) => ({ product_id: index + 1 }));
        expect(await resolveStockAffectedProductIds({ query: async () => [rows] }, { productIds: [1] })).toBeNull();
    });

    it('resolves with one bounded read', async () => {
        const query = vi.fn(async () => [[{ product_id: 2 }]]);
        await resolveStockAffectedProductIds({ query }, { productIds: [1], ingredientIds: [3] });
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('names products through a saved stock item that the product no longer links to', async () => {
        const oldItem = await newStockItem('Scope old item');
        const stayed = await newProduct('Scope stayed on old item');
        const relinked = await newProduct('Scope relinked');
        const newItem = await newStockItem('Scope new item');
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1),(?,?,1)', [stayed, oldItem, relinked, newItem]);
        // A restore posts back to oldItem (saved on the sale) although relinked now points at newItem.
        expect(await resolveStockAffectedProductIds(pool, { productIds: [relinked], stockItemIds: [String(oldItem)] }))
            .toEqual([stayed, relinked]);
        expect(await resolveStockAffectedProductIds(pool, { productIds: [relinked] })).toEqual([relinked]);
    });

    it('sends nothing when the resolved set is empty, because an empty list would read as unscoped', async () => {
        const [{ insertId: unlinked }] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Scope unlinked','count','unit',1,1)");
        const quiet = capture();
        await emitStockChangedEvent(quiet.io, { ingredientIds: [unlinked] });
        expect(quiet.emit).not.toHaveBeenCalled();
    });

    it('reports an unknown set when a saved stock item id cannot be named exactly', async () => {
        expect(await resolveStockAffectedProductIds(pool, { productIds: [sold], stockItemIds: ['9223372036854775807'] })).toBeNull();
    });

    it('emits the ids to staff, and falls back to the legacy payload without them or when the lookup fails', async () => {
        const scoped = capture();
        await emitStockChangedEvent(scoped.io, { productIds: [sold] });
        expect(scoped.io.to).toHaveBeenCalledWith('staff');
        expect(scoped.emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock', productIds: [sold, sibling] });

        const unscoped = capture();
        await emitStockChangedEvent(unscoped.io, {});
        expect(unscoped.emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock' });

        const failing = capture();
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        try {
            await emitStockChangedEvent(failing.io, { productIds: [sold], db: { query: async () => { throw new Error('db down'); } } });
        } finally {
            logSpy.mockRestore();
        }
        expect(failing.emit).toHaveBeenCalledWith('inventory_changed', { scope: 'stock' });
    });
});
