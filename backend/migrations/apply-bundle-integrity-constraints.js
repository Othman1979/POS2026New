'use strict';

const path = require('path');
const mysql = require('mysql2/promise');
const { assertNestedBundleIntegrity, BUNDLE_ORDER_CORRUPT } = require('../services/bundleIntegrity');

const TABLE = 'order_items';
const CHECK_NAME = 'chk_order_items_quantity_positive';
const UNIQUE_INDEX = 'uq_order_items_id_invoice';
const CHILD_INDEX = 'idx_order_items_parent_invoice';
const COMPOSITE_FK = 'fk_order_items_parent_invoice';

const ident = value => `\`${String(value).replaceAll('`', '``')}\``;
const sameColumns = (actual, expected) => actual.length === expected.length && actual.every((column, index) => column === expected[index]);
const normaliseCheck = clause => String(clause || '').replace(/[\s`()]/g, '').toLowerCase();
const isPositiveQuantityCheck = clause => normaliseCheck(clause) === 'quantity>0';

function manualIntervention(message) {
    return new Error(`Manual intervention required: ${message}`);
}

function invalidHeldCartData(context) {
    const error = new Error('Held order cart data is invalid.');
    error.code = 'INVALID_HELD_CART_DATA';
    error.reason = 'invalid_held_cart_data';
    error.context = context;
    return error;
}

function parseHeldItems(cartData) {
    let parsed;
    try {
        parsed = typeof cartData === 'string' ? JSON.parse(cartData) : cartData;
    } catch (error) {
        throw invalidHeldCartData({ shape: 'invalid_json' });
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) return parsed.items;
    throw invalidHeldCartData({ shape: 'expected_array_or_object_items_array' });
}

function assertHeldItemsStructure(items) {
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        const isObject = item !== null && typeof item === 'object' && !Array.isArray(item);
        const prototype = isObject ? Object.getPrototypeOf(item) : undefined;
        if (!isObject || (prototype !== Object.prototype && prototype !== null)) {
            throw invalidHeldCartData({ shape: 'invalid_item', itemIndex });
        }
        if (Object.prototype.hasOwnProperty.call(item, 'bundleItems') && !Array.isArray(item.bundleItems)) {
            throw invalidHeldCartData({ shape: 'bundle_items_not_array', itemIndex });
        }
    }
    return items;
}

async function scanBundleIntegrity(conn) {
    const [relationalRows] = await conn.query(`
        SELECT 'non_positive_quantity' reason, oi.invoice_id, oi.id row_id, oi.parent_item_id parent_id
          FROM order_items oi
         WHERE NOT (oi.quantity > 0)
        UNION ALL
        SELECT 'missing_same_invoice_parent', c.invoice_id, c.id, c.parent_item_id
          FROM order_items c
          LEFT JOIN order_items p ON p.id = c.parent_item_id
         WHERE c.parent_item_id IS NOT NULL AND p.id IS NULL
        UNION ALL
        SELECT 'cross_invoice_parent', c.invoice_id, c.id, c.parent_item_id
          FROM order_items c
          JOIN order_items p ON p.id = c.parent_item_id
         WHERE c.invoice_id <> p.invoice_id
        UNION ALL
        SELECT 'nested_parent', c.invoice_id, c.id, c.parent_item_id
          FROM order_items c
          JOIN order_items p ON p.id = c.parent_item_id
         WHERE p.parent_item_id IS NOT NULL
        ORDER BY invoice_id, row_id, reason
    `);
    const findings = relationalRows.map(row => ({
        entity: 'order_item',
        reason: row.reason,
        invoiceId: row.invoice_id,
        rowId: row.row_id,
        parentId: row.parent_id
    }));

    const [heldRows] = await conn.query('SELECT id, cart_data FROM held_orders ORDER BY id');
    for (const held of heldRows) {
        try {
            const items = parseHeldItems(held.cart_data);
            assertHeldItemsStructure(items);
            assertNestedBundleIntegrity(items);
        } catch (error) {
            if (error.publicCode !== BUNDLE_ORDER_CORRUPT && error.code !== 'INVALID_HELD_CART_DATA') throw error;
            findings.push({
                entity: 'held_order',
                heldOrderId: held.id,
                reason: error.integrityReason || error.reason,
                context: error.integrityContext || error.context
            });
        }
    }

    const [catalogRows] = await conn.query(`
        SELECT CASE
                   WHEN bundle.id IS NULL THEN 'missing_bundle_product'
                   WHEN component.id IS NULL THEN 'missing_component_product'
                   ELSE 'non_positive_bundle_definition_quantity'
               END reason,
               definition.bundle_id,
               definition.product_id,
               definition.qty
          FROM product_bundle_items definition
          LEFT JOIN products bundle ON bundle.id = definition.bundle_id
          LEFT JOIN products component ON component.id = definition.product_id
         WHERE NOT (definition.qty > 0)
            OR bundle.id IS NULL
            OR component.id IS NULL
         ORDER BY definition.bundle_id, definition.product_id
    `);
    findings.push(...catalogRows.map(row => ({
        entity: 'product_bundle_item',
        reason: row.reason,
        bundleId: row.bundle_id,
        productId: row.product_id,
        quantity: row.qty
    })));
    return findings;
}

function groupIndexes(rows) {
    const indexes = new Map();
    for (const row of rows) {
        const name = row.INDEX_NAME;
        if (!indexes.has(name)) indexes.set(name, { name, unique: Number(row.NON_UNIQUE) === 0, columns: [] });
        indexes.get(name).columns.push({ position: Number(row.SEQ_IN_INDEX), column: row.COLUMN_NAME });
    }
    return [...indexes.values()].map(index => ({
        ...index,
        columns: index.columns.sort((a, b) => a.position - b.position).map(column => column.column)
    }));
}

function groupForeignKeys(rows) {
    const foreignKeys = new Map();
    for (const row of rows) {
        const name = row.CONSTRAINT_NAME;
        if (!foreignKeys.has(name)) {
            foreignKeys.set(name, {
                name,
                columns: [],
                referencedTable: row.REFERENCED_TABLE_NAME,
                referencedColumns: [],
                deleteRule: String(row.DELETE_RULE || '').toUpperCase()
            });
        }
        foreignKeys.get(name).columns.push({ position: Number(row.ORDINAL_POSITION), column: row.COLUMN_NAME });
        foreignKeys.get(name).referencedColumns.push({ position: Number(row.ORDINAL_POSITION), column: row.REFERENCED_COLUMN_NAME });
    }
    return [...foreignKeys.values()].map(foreignKey => ({
        ...foreignKey,
        columns: foreignKey.columns.sort((a, b) => a.position - b.position).map(column => column.column),
        referencedColumns: foreignKey.referencedColumns.sort((a, b) => a.position - b.position).map(column => column.column)
    }));
}

function assertNoDesiredNameConflicts({ indexes, foreignKeys, checks }) {
    const namedUnique = indexes.find(index => index.name === UNIQUE_INDEX);
    if (namedUnique && (!namedUnique.unique || !sameColumns(namedUnique.columns, ['id', 'invoice_id']))) {
        throw manualIntervention(`${UNIQUE_INDEX} is not unique (id, invoice_id).`);
    }
    const namedChild = indexes.find(index => index.name === CHILD_INDEX);
    if (namedChild && !sameColumns(namedChild.columns, ['parent_item_id', 'invoice_id'])) {
        throw manualIntervention(`${CHILD_INDEX} is not (parent_item_id, invoice_id).`);
    }
    const namedCheck = checks.find(check => check.name === CHECK_NAME);
    if (namedCheck && !isPositiveQuantityCheck(namedCheck.clause)) {
        throw manualIntervention(`${CHECK_NAME} is not quantity > 0.`);
    }
    const namedForeignKey = foreignKeys.find(foreignKey => foreignKey.name === COMPOSITE_FK);
    if (namedForeignKey && !(sameColumns(namedForeignKey.columns, ['parent_item_id', 'invoice_id']) &&
        namedForeignKey.referencedTable === TABLE && sameColumns(namedForeignKey.referencedColumns, ['id', 'invoice_id']))) {
        throw manualIntervention(`${COMPOSITE_FK} is not the required same-invoice self foreign key.`);
    }
    if (namedForeignKey && namedForeignKey.deleteRule !== 'CASCADE') {
        throw manualIntervention(`${COMPOSITE_FK} must use ON DELETE CASCADE.`);
    }
}

async function readBundleConstraintState(conn) {
    const [indexRows] = await conn.query(`
        SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
         ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `);
    const [foreignKeyRows] = await conn.query(`
        SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME,
               kcu.REFERENCED_COLUMN_NAME, kcu.ORDINAL_POSITION, rc.DELETE_RULE
          FROM information_schema.KEY_COLUMN_USAGE kcu
          JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
            ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
           AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
           AND kcu.TABLE_NAME = 'order_items'
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `);
    const [checkRows] = await conn.query(`
        SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
          FROM information_schema.TABLE_CONSTRAINTS tc
          JOIN information_schema.CHECK_CONSTRAINTS cc
            ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
           AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
         WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
           AND tc.TABLE_NAME = 'order_items'
           AND tc.CONSTRAINT_TYPE = 'CHECK'
         ORDER BY tc.CONSTRAINT_NAME
    `);
    const indexes = groupIndexes(indexRows);
    const foreignKeys = groupForeignKeys(foreignKeyRows);
    const checks = checkRows.map(row => ({ name: row.CONSTRAINT_NAME, clause: row.CHECK_CLAUSE }));
    assertNoDesiredNameConflicts({ indexes, foreignKeys, checks });

    const isLegacySelfForeignKey = foreignKey => foreignKey.referencedTable === TABLE &&
        sameColumns(foreignKey.columns, ['parent_item_id']) && sameColumns(foreignKey.referencedColumns, ['id']);
    const isCompositeSelfForeignKeyShape = foreignKey => foreignKey.referencedTable === TABLE &&
        sameColumns(foreignKey.columns, ['parent_item_id', 'invoice_id']) &&
        sameColumns(foreignKey.referencedColumns, ['id', 'invoice_id']);
    const isCompositeSelfForeignKey = foreignKey => isCompositeSelfForeignKeyShape(foreignKey) && foreignKey.deleteRule === 'CASCADE';

    return {
        indexes,
        foreignKeys,
        checks,
        referencedUniqueIndex: indexes.find(index => index.unique && sameColumns(index.columns, ['id', 'invoice_id'])) || null,
        childIndex: indexes.find(index => sameColumns(index.columns, ['parent_item_id', 'invoice_id'])) || null,
        quantityCheck: checks.find(check => check.name === CHECK_NAME && isPositiveQuantityCheck(check.clause)) || null,
        legacySelfForeignKeys: foreignKeys.filter(isLegacySelfForeignKey),
        compositeSelfForeignKey: foreignKeys.find(isCompositeSelfForeignKey) || null,
        compositeSelfForeignKeys: foreignKeys.filter(isCompositeSelfForeignKey),
        nonCascadingCompositeSelfForeignKeys: foreignKeys.filter(foreignKey =>
            isCompositeSelfForeignKeyShape(foreignKey) && foreignKey.deleteRule !== 'CASCADE'
        )
    };
}

function assertForeignKeyStateIsUnambiguous(state) {
    if (state.legacySelfForeignKeys.length > 1) {
        throw manualIntervention(`multiple legacy ${TABLE} self foreign keys found: ${state.legacySelfForeignKeys.map(foreignKey => foreignKey.name).join(', ')}.`);
    }
    if (state.compositeSelfForeignKeys.length > 1) {
        throw manualIntervention(`multiple composite ${TABLE} self foreign keys found: ${state.compositeSelfForeignKeys.map(foreignKey => foreignKey.name).join(', ')}.`);
    }
    if (state.nonCascadingCompositeSelfForeignKeys.length > 0) {
        throw manualIntervention(`same-invoice ${TABLE} self foreign key must use ON DELETE CASCADE: ${state.nonCascadingCompositeSelfForeignKeys.map(foreignKey => foreignKey.name).join(', ')}.`);
    }
}

function disposableLegacyParentIndex(state, legacyForeignKey) {
    if (!state.childIndex) return null;
    const candidates = state.indexes.filter(index => index.name !== 'PRIMARY' && !index.unique && sameColumns(index.columns, ['parent_item_id']));
    if (candidates.length !== 1) return null;
    const requiredByAnotherForeignKey = state.foreignKeys.some(foreignKey => foreignKey.name !== legacyForeignKey.name &&
        sameColumns(foreignKey.columns, ['parent_item_id']));
    return requiredByAnotherForeignKey ? null : candidates[0];
}

function assertFinalState(state) {
    assertForeignKeyStateIsUnambiguous(state);
    if (!state.referencedUniqueIndex) throw manualIntervention(`missing unique (id, invoice_id) index on ${TABLE}.`);
    if (!state.childIndex) throw manualIntervention(`missing child (parent_item_id, invoice_id) index on ${TABLE}.`);
    if (!state.quantityCheck) throw manualIntervention(`missing ${CHECK_NAME} check constraint.`);
    if (!state.compositeSelfForeignKey) throw manualIntervention(`missing same-invoice ${TABLE} self foreign key.`);
    if (state.legacySelfForeignKeys.length !== 0) throw manualIntervention(`legacy ${TABLE} self foreign key remains.`);
}

async function applyBundleIntegrityConstraints(conn) {
    const findings = await scanBundleIntegrity(conn);
    if (findings.length > 0) {
        throw new Error(`Bundle integrity scan found ${findings.length} finding(s). Fix findings before DDL.`);
    }

    let state = await readBundleConstraintState(conn);
    assertForeignKeyStateIsUnambiguous(state);
    const stageOneClauses = [];
    if (!state.referencedUniqueIndex) {
        stageOneClauses.push(`ADD UNIQUE KEY ${ident(UNIQUE_INDEX)} (${ident('id')}, ${ident('invoice_id')})`);
    }
    if (!state.childIndex) {
        stageOneClauses.push(`ADD KEY ${ident(CHILD_INDEX)} (${ident('parent_item_id')}, ${ident('invoice_id')})`);
    }
    if (!state.quantityCheck) {
        stageOneClauses.push(`ADD CONSTRAINT ${ident(CHECK_NAME)} CHECK (${ident('quantity')} > 0)`);
    }
    if (stageOneClauses.length > 0) {
        await conn.query(`ALTER TABLE ${ident(TABLE)}\n  ${stageOneClauses.join(',\n  ')}`);
    }

    state = await readBundleConstraintState(conn);
    assertForeignKeyStateIsUnambiguous(state);
    const legacyForeignKey = state.legacySelfForeignKeys[0];
    if (legacyForeignKey) {
        const legacyParentIndex = disposableLegacyParentIndex(state, legacyForeignKey);
        const stageTwoClauses = [`DROP FOREIGN KEY ${ident(legacyForeignKey.name)}`];
        if (legacyParentIndex) stageTwoClauses.push(`DROP INDEX ${ident(legacyParentIndex.name)}`);
        if (!state.compositeSelfForeignKey) {
            stageTwoClauses.push(
                `ADD CONSTRAINT ${ident(COMPOSITE_FK)} FOREIGN KEY (${ident('parent_item_id')}, ${ident('invoice_id')}) ` +
                `REFERENCES ${ident(TABLE)} (${ident('id')}, ${ident('invoice_id')}) ON DELETE CASCADE`
            );
        }
        await conn.query(`ALTER TABLE ${ident(TABLE)}\n  ${stageTwoClauses.join(',\n  ')}`);
    } else if (!state.compositeSelfForeignKey) {
        await conn.query(
            `ALTER TABLE ${ident(TABLE)}\n  ADD CONSTRAINT ${ident(COMPOSITE_FK)} ` +
            `FOREIGN KEY (${ident('parent_item_id')}, ${ident('invoice_id')}) ` +
            `REFERENCES ${ident(TABLE)} (${ident('id')}, ${ident('invoice_id')}) ON DELETE CASCADE`
        );
    }

    const finalState = await readBundleConstraintState(conn);
    assertFinalState(finalState);
    return finalState;
}

async function run() {
    const envFile = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
    require('dotenv').config({ path: path.join(__dirname, envFile), override: true });
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'posapp',
        charset: 'utf8mb4'
    });
    try {
        const [[metadata]] = await conn.query('SELECT DATABASE() AS database_name, VERSION() AS version');
        const databaseName = metadata.database_name;
        console.log(`Connected to ${databaseName} (${metadata.version}).`);
        const findings = await scanBundleIntegrity(conn);
        for (const finding of findings) console.error(JSON.stringify(finding));
        if (findings.length > 0) {
            console.error(`Scan found ${findings.length} finding(s); no DDL applied.`);
            process.exitCode = 1;
            return;
        }
        if (process.env.BUNDLE_INTEGRITY_MIGRATION_CONFIRM !== databaseName) {
            console.log('Scan clean; no DDL applied.');
            return;
        }
        await applyBundleIntegrityConstraints(conn);
        console.log('Bundle integrity constraints applied.');
    } finally {
        await conn.end();
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { scanBundleIntegrity, readBundleConstraintState, applyBundleIntegrityConstraints };
