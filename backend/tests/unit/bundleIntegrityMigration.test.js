import { describe, expect, it } from 'vitest';

const {
    scanBundleIntegrity,
    readBundleConstraintState,
    applyBundleIntegrityConstraints
} = require('../../migrations/apply-bundle-integrity-constraints');

const indexRows = indexes => indexes.flatMap(index => index.columns.map((column, position) => ({
    INDEX_NAME: index.name,
    NON_UNIQUE: index.unique ? 0 : 1,
    SEQ_IN_INDEX: position + 1,
    COLUMN_NAME: column
})));

const foreignKeyRows = foreignKeys => foreignKeys.flatMap(foreignKey => foreignKey.columns.map((column, position) => ({
    CONSTRAINT_NAME: foreignKey.name,
    COLUMN_NAME: column,
    REFERENCED_TABLE_NAME: foreignKey.referencedTable,
    REFERENCED_COLUMN_NAME: foreignKey.referencedColumns[position],
    DELETE_RULE: foreignKey.deleteRule || 'RESTRICT',
    ORDINAL_POSITION: position + 1
})));

function createConnection({ relational = [], held = [], catalog = [], state } = {}) {
    const calls = [];
    const alters = [];
    const schema = state || {
        indexes: [
            { name: 'PRIMARY', unique: true, columns: ['id'] },
            { name: 'uq_custom_id_invoice', unique: true, columns: ['id', 'invoice_id'] },
            { name: 'legacy_parent_index', unique: false, columns: ['parent_item_id'] }
        ],
        foreignKeys: [{
            name: 'actual_legacy_self_fk',
            columns: ['parent_item_id'],
            referencedTable: 'order_items',
            referencedColumns: ['id'],
            deleteRule: 'CASCADE'
        }],
        checks: []
    };

    const conn = {
        calls,
        alters,
        async query(sql) {
            calls.push(sql);
            if (sql.includes("'non_positive_quantity'")) return [relational];
            if (sql.includes('FROM held_orders')) return [held];
            if (sql.includes('FROM product_bundle_items')) return [catalog];
            if (sql.includes('information_schema.STATISTICS')) return [indexRows(schema.indexes)];
            if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [foreignKeyRows(schema.foreignKeys)];
            if (sql.includes('information_schema.TABLE_CONSTRAINTS')) return [schema.checks.map(check => ({
                CONSTRAINT_NAME: check.name,
                CHECK_CLAUSE: check.clause
            }))];
            if (!sql.includes('ALTER TABLE')) throw new Error(`Unexpected SQL: ${sql}`);

            alters.push(sql.replace(/\s+/g, ' ').trim());
            if (sql.includes('ADD UNIQUE KEY `uq_order_items_id_invoice`')) {
                schema.indexes.push({ name: 'uq_order_items_id_invoice', unique: true, columns: ['id', 'invoice_id'] });
            }
            if (sql.includes('ADD KEY `idx_order_items_parent_invoice`')) {
                schema.indexes.push({ name: 'idx_order_items_parent_invoice', unique: false, columns: ['parent_item_id', 'invoice_id'] });
            }
            if (sql.includes('ADD CONSTRAINT `chk_order_items_quantity_positive`')) {
                schema.checks.push({ name: 'chk_order_items_quantity_positive', clause: '`quantity` > 0' });
            }
            const droppedForeignKey = sql.match(/DROP FOREIGN KEY `([^`]+)`/);
            if (droppedForeignKey) {
                schema.foreignKeys = schema.foreignKeys.filter(foreignKey => foreignKey.name !== droppedForeignKey[1]);
            }
            const droppedIndex = sql.match(/DROP INDEX `([^`]+)`/);
            if (droppedIndex) {
                schema.indexes = schema.indexes.filter(index => index.name !== droppedIndex[1]);
            }
            if (sql.includes('ADD CONSTRAINT `fk_order_items_parent_invoice`')) {
                schema.foreignKeys.push({
                    name: 'fk_order_items_parent_invoice',
                    columns: ['parent_item_id', 'invoice_id'],
                    referencedTable: 'order_items',
                    referencedColumns: ['id', 'invoice_id'],
                    deleteRule: 'CASCADE'
                });
            }
            return [[]];
        }
    };
    return conn;
}

describe('bundle integrity migration', () => {
    it('scans all relational, held-cart, and catalog corruption reasons', async () => {
        const conn = createConnection({
            relational: [
                { reason: 'non_positive_quantity', invoice_id: 1, row_id: 11, parent_id: null },
                { reason: 'missing_same_invoice_parent', invoice_id: 1, row_id: 12, parent_id: 91 },
                { reason: 'cross_invoice_parent', invoice_id: 2, row_id: 13, parent_id: 10 },
                { reason: 'nested_parent', invoice_id: 2, row_id: 14, parent_id: 13 }
            ],
            held: [
                { id: 20, cart_data: JSON.stringify([{ cartId: 'legacy', qty: 0, bundleItems: [{ product_id: 1, qty: 1 }] }]) },
                { id: 21, cart_data: JSON.stringify({ items: [{ cartId: 'current', qty: 1, bundleItems: [{ product_id: 2, qty: 0 }] }] }) },
                { id: 22, cart_data: JSON.stringify({ items: 'not-an-array' }) },
                { id: 23, cart_data: '{not-valid-json' },
                { id: 24, cart_data: JSON.stringify([null]) },
                { id: 25, cart_data: JSON.stringify({ items: [{ cartId: 'invalid-children', bundleItems: {} }] }) }
            ],
            catalog: [
                { reason: 'non_positive_bundle_definition_quantity', bundle_id: 4, product_id: 1, qty: 0 },
                { reason: 'missing_bundle_product', bundle_id: 190, product_id: 1, qty: 1 },
                { reason: 'missing_component_product', bundle_id: 4, product_id: 191, qty: 1 }
            ]
        });

        await expect(scanBundleIntegrity(conn)).resolves.toEqual(expect.arrayContaining([
            { entity: 'order_item', reason: 'non_positive_quantity', invoiceId: 1, rowId: 11, parentId: null },
            { entity: 'order_item', reason: 'missing_same_invoice_parent', invoiceId: 1, rowId: 12, parentId: 91 },
            { entity: 'order_item', reason: 'cross_invoice_parent', invoiceId: 2, rowId: 13, parentId: 10 },
            { entity: 'order_item', reason: 'nested_parent', invoiceId: 2, rowId: 14, parentId: 13 },
            expect.objectContaining({ entity: 'held_order', heldOrderId: 20, reason: 'non_positive_parent_quantity' }),
            expect.objectContaining({ entity: 'held_order', heldOrderId: 21, reason: 'non_positive_child_quantity' }),
            expect.objectContaining({ entity: 'held_order', heldOrderId: 22, reason: 'invalid_held_cart_data' }),
            expect.objectContaining({ entity: 'held_order', heldOrderId: 23, reason: 'invalid_held_cart_data' }),
            expect.objectContaining({ entity: 'held_order', heldOrderId: 24, reason: 'invalid_held_cart_data', context: { shape: 'invalid_item', itemIndex: 0 } }),
            expect.objectContaining({ entity: 'held_order', heldOrderId: 25, reason: 'invalid_held_cart_data', context: { shape: 'bundle_items_not_array', itemIndex: 0 } }),
            { entity: 'product_bundle_item', reason: 'non_positive_bundle_definition_quantity', bundleId: 4, productId: 1, quantity: 0 },
            { entity: 'product_bundle_item', reason: 'missing_bundle_product', bundleId: 190, productId: 1, quantity: 1 },
            { entity: 'product_bundle_item', reason: 'missing_component_product', bundleId: 4, productId: 191, quantity: 1 }
        ]));

        const scanSql = conn.calls.find(sql => sql.includes("'non_positive_quantity'"));
        expect(scanSql).toContain("'missing_same_invoice_parent'");
        expect(scanSql).toContain("'cross_invoice_parent'");
        expect(scanSql).toContain("'nested_parent'");
    });

    it('blocks every ALTER when scanner finds corruption', async () => {
        const conn = createConnection({
            relational: [{ reason: 'non_positive_quantity', invoice_id: 1, row_id: 11, parent_id: null }]
        });

        await expect(applyBundleIntegrityConstraints(conn)).rejects.toThrow('Bundle integrity scan found 1 finding');
        expect(conn.alters).toEqual([]);
    });

    it('blocks every ALTER when held or catalog scanner findings exist', async () => {
        const heldConnection = createConnection({
            held: [{ id: 42, cart_data: JSON.stringify([null]) }]
        });
        const catalogConnection = createConnection({
            catalog: [{ bundle_id: 4, product_id: 1, qty: 0 }]
        });

        await expect(applyBundleIntegrityConstraints(heldConnection)).rejects.toThrow('Bundle integrity scan found 1 finding');
        expect(heldConnection.alters).toEqual([]);
        await expect(applyBundleIntegrityConstraints(catalogConnection)).rejects.toThrow('Bundle integrity scan found 1 finding');
        expect(catalogConnection.alters).toEqual([]);
    });

    it('reuses equivalent indexes, discovers legacy FK names, stages DDL, and becomes idempotent', async () => {
        const conn = createConnection();

        const initial = await readBundleConstraintState(conn);
        expect(initial.referencedUniqueIndex.name).toBe('uq_custom_id_invoice');
        expect(initial.legacySelfForeignKeys.map(foreignKey => foreignKey.name)).toEqual(['actual_legacy_self_fk']);

        await applyBundleIntegrityConstraints(conn);

        expect(conn.alters).toHaveLength(2);
        expect(conn.alters[0]).toContain('ADD KEY `idx_order_items_parent_invoice` (`parent_item_id`, `invoice_id`)');
        expect(conn.alters[0]).toContain('ADD CONSTRAINT `chk_order_items_quantity_positive` CHECK (`quantity` > 0)');
        expect(conn.alters[0]).not.toContain('ADD UNIQUE KEY `uq_order_items_id_invoice`');
        expect(conn.alters[1]).toContain('DROP FOREIGN KEY `actual_legacy_self_fk`');
        expect(conn.alters[1]).toContain('DROP INDEX `legacy_parent_index`');
        expect(conn.alters[1]).toContain('ADD CONSTRAINT `fk_order_items_parent_invoice` FOREIGN KEY (`parent_item_id`, `invoice_id`) REFERENCES `order_items` (`id`, `invoice_id`) ON DELETE CASCADE');

        const finalState = await readBundleConstraintState(conn);
        expect(finalState.referencedUniqueIndex).toBeTruthy();
        expect(finalState.childIndex).toBeTruthy();
        expect(finalState.quantityCheck).toBeTruthy();
        expect(finalState.compositeSelfForeignKey).toBeTruthy();
        expect(finalState.legacySelfForeignKeys).toEqual([]);

        await applyBundleIntegrityConstraints(conn);
        expect(conn.alters).toHaveLength(2);
    });

    it('adds the named cascading composite FK when stage one exists but no self FK remains', async () => {
        const conn = createConnection({
            state: {
                indexes: [
                    { name: 'PRIMARY', unique: true, columns: ['id'] },
                    { name: 'uq_order_items_id_invoice', unique: true, columns: ['id', 'invoice_id'] },
                    { name: 'idx_order_items_parent_invoice', unique: false, columns: ['parent_item_id', 'invoice_id'] }
                ],
                foreignKeys: [],
                checks: [{ name: 'chk_order_items_quantity_positive', clause: '(`quantity` > 0)' }]
            }
        });

        await applyBundleIntegrityConstraints(conn);

        expect(conn.alters).toHaveLength(1);
        expect(conn.alters[0]).toContain(
            'ADD CONSTRAINT `fk_order_items_parent_invoice` FOREIGN KEY (`parent_item_id`, `invoice_id`) REFERENCES `order_items` (`id`, `invoice_id`) ON DELETE CASCADE'
        );
        expect((await readBundleConstraintState(conn)).compositeSelfForeignKey).toMatchObject({
            name: 'fk_order_items_parent_invoice',
            deleteRule: 'CASCADE'
        });

        await applyBundleIntegrityConstraints(conn);
        expect(conn.alters).toHaveLength(1);
    });

    it('resumes from complete stage 1 without duplicate DDL and keeps a parent index used by another FK', async () => {
        const conn = createConnection({
            state: {
                indexes: [
                    { name: 'PRIMARY', unique: true, columns: ['id'] },
                    { name: 'uq_order_items_id_invoice', unique: true, columns: ['id', 'invoice_id'] },
                    { name: 'idx_order_items_parent_invoice', unique: false, columns: ['parent_item_id', 'invoice_id'] },
                    { name: 'legacy_parent_index', unique: false, columns: ['parent_item_id'] }
                ],
                foreignKeys: [
                    { name: 'legacy_fk', columns: ['parent_item_id'], referencedTable: 'order_items', referencedColumns: ['id'] },
                    { name: 'other_fk_needing_parent_index', columns: ['parent_item_id'], referencedTable: 'elsewhere', referencedColumns: ['id'] }
                ],
                checks: [{ name: 'chk_order_items_quantity_positive', clause: '(`quantity` > 0)' }]
            }
        });

        await applyBundleIntegrityConstraints(conn);

        expect(conn.alters).toHaveLength(1);
        expect(conn.alters[0]).toContain('DROP FOREIGN KEY `legacy_fk`');
        expect(conn.alters[0]).not.toContain('DROP INDEX `legacy_parent_index`');
        expect(conn.alters[0]).not.toContain('ADD KEY `idx_order_items_parent_invoice`');
    });

    it('refuses a non-cascading composite self FK instead of accepting an incomplete final state', async () => {
        const conn = createConnection({
            state: {
                indexes: [
                    { name: 'PRIMARY', unique: true, columns: ['id'] },
                    { name: 'uq_order_items_id_invoice', unique: true, columns: ['id', 'invoice_id'] },
                    { name: 'idx_order_items_parent_invoice', unique: false, columns: ['parent_item_id', 'invoice_id'] }
                ],
                foreignKeys: [{
                    name: 'fk_order_items_parent_invoice',
                    columns: ['parent_item_id', 'invoice_id'],
                    referencedTable: 'order_items',
                    referencedColumns: ['id', 'invoice_id'],
                    deleteRule: 'RESTRICT'
                }],
                checks: [{ name: 'chk_order_items_quantity_positive', clause: '(`quantity` > 0)' }]
            }
        });

        await expect(applyBundleIntegrityConstraints(conn)).rejects.toThrow('ON DELETE CASCADE');
        expect(conn.alters).toEqual([]);
    });
});
