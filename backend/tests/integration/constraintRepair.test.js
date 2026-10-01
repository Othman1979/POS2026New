const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { repairMissingConstraints } = require('../../services/constraintRepair');

async function hasConstraint(table, name) {
    const [[row]] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, [table, name]);
    return Number(row.n) === 1;
}

describe('restoring constraints an imported database lost', () => {
    beforeEach(async () => { await seedDatabase(); });

    it('re-adds missing keys and rules, refuses one that existing rows break, and is idempotent', async () => {
        await pool.query('ALTER TABLE refunds DROP FOREIGN KEY fk_refunds_invoice');
        await pool.query('ALTER TABLE products DROP CONSTRAINT chk_products_jofotara_tax_category');
        await pool.query('ALTER TABLE restaurant_tables DROP FOREIGN KEY restaurant_tables_ibfk_1');
        const [[section]] = await pool.query("SELECT id FROM sections ORDER BY id LIMIT 1");
        const connection = await pool.getConnection();
        try {
            await connection.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
            await connection.query('INSERT INTO restaurant_tables (section_id, table_number) VALUES (?, 9901)', [987654]);
            await connection.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
        } finally { connection.release(); }

        const first = await repairMissingConstraints(pool);
        expect(first.changes).toEqual(expect.arrayContaining(['foreign key fk_refunds_invoice', 'check chk_products_jofotara_tax_category']));
        expect(await hasConstraint('refunds', 'fk_refunds_invoice')).toBe(true);
        expect(await hasConstraint('products', 'chk_products_jofotara_tax_category')).toBe(true);
        // A row pointing to a missing section blocks that key; the row is reported, not changed.
        expect(first.blocked).toEqual([expect.objectContaining({ constraint: 'restaurant_tables_ibfk_1', table: 'restaurant_tables' })]);
        expect(await hasConstraint('restaurant_tables', 'restaurant_tables_ibfk_1')).toBe(false);
        const [[kept]] = await pool.query('SELECT COUNT(*) AS n FROM restaurant_tables WHERE table_number = 9901');
        expect(Number(kept.n)).toBe(1);

        await pool.query('UPDATE restaurant_tables SET section_id = ? WHERE table_number = 9901', [section.id]);
        const second = await repairMissingConstraints(pool);
        expect(second.changes).toEqual(['foreign key restaurant_tables_ibfk_1']);
        expect((await repairMissingConstraints(pool)).changed).toBe(false);
    });
});

describe('a collation step that fails after dropping keys', () => {
    beforeEach(async () => { await seedDatabase(); });

    it('puts every dropped key back before reporting the failure', async () => {
        // Snapshot ids on the old collation, with the self-referencing key present (both sides match).
        await pool.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const [table, name] of [['orders', 'fk_orders_service_charge_snapshot'], ['held_orders', 'fk_held_service_charge_snapshot'], ['service_charge_snapshots', 'fk_scs_parent']]) {
            if (await hasConstraint(table, name)) await pool.query(`ALTER TABLE ${table} DROP FOREIGN KEY ${name}`);
        }
        await pool.query('ALTER TABLE service_charge_snapshots MODIFY id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL, MODIFY parent_snapshot_id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL');
        await pool.query('ALTER TABLE service_charge_snapshots ADD CONSTRAINT fk_scs_parent FOREIGN KEY (parent_snapshot_id) REFERENCES service_charge_snapshots (id)');
        await pool.query('SET FOREIGN_KEY_CHECKS = 1');
        const connection = await pool.getConnection();
        const failing = {
            query: (sql, values) => /CONVERT TO CHARACTER SET/.test(sql) && /service_charge_snapshots/.test(sql)
                ? Promise.reject(Object.assign(new Error('simulated collation failure'), { errno: 1062 }))
                : connection.query(sql, values),
            release: () => connection.release()
        };
        await expect(repairMissingConstraints({ getConnection: async () => failing })).rejects.toThrow('simulated collation failure');
        expect(await hasConstraint('service_charge_snapshots', 'fk_scs_parent')).toBe(true);
    });
});

describe('a blocked parent collation', () => {
    beforeEach(async () => { await seedDatabase(); });

    it('leaves the dependent snapshot-id columns and their keys unchanged', async () => {
        await pool.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const [table, name] of [['orders', 'fk_orders_service_charge_snapshot'], ['held_orders', 'fk_held_service_charge_snapshot'], ['service_charge_snapshots', 'fk_scs_parent']]) {
            if (await hasConstraint(table, name)) await pool.query(`ALTER TABLE ${table} DROP FOREIGN KEY ${name}`);
        }
        const unicode = 'char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
        await pool.query(`ALTER TABLE service_charge_snapshots MODIFY id ${unicode} NOT NULL, MODIFY parent_snapshot_id ${unicode} DEFAULT NULL`);
        await pool.query(`ALTER TABLE orders MODIFY service_charge_snapshot_id ${unicode} DEFAULT NULL`);
        await pool.query(`ALTER TABLE held_orders MODIFY service_charge_snapshot_id ${unicode} DEFAULT NULL`);
        await pool.query('ALTER TABLE service_charge_snapshots ADD CONSTRAINT fk_scs_parent FOREIGN KEY (parent_snapshot_id) REFERENCES service_charge_snapshots (id)');
        const [[user]] = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
        // A historical row whose parent snapshot no longer exists blocks the parent conversion.
        await pool.query(`INSERT INTO service_charge_snapshots (id, percentage, tax_rate, state, created_by, parent_snapshot_id)
            VALUES ('11111111-1111-4111-8111-111111111111', 10, 0, 'finalized', ?, '99999999-9999-4999-8999-999999999999')`, [user.id]);
        await pool.query('SET FOREIGN_KEY_CHECKS = 1');

        const result = await repairMissingConstraints(pool);
        expect(result.blocked).toEqual(expect.arrayContaining([expect.objectContaining({ constraint: 'fk_scs_parent' })]));
        expect(await hasConstraint('service_charge_snapshots', 'fk_scs_parent')).toBe(true);
        const [[column]] = await pool.query(`SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'service_charge_snapshot_id'`);
        expect(column.c).toBe('utf8mb4_unicode_ci');
        // Parent and children still share a collation, so their keys can still be added.
        expect(await hasConstraint('orders', 'fk_orders_service_charge_snapshot')).toBe(true);
        expect(await hasConstraint('held_orders', 'fk_held_service_charge_snapshot')).toBe(true);
    });
});

describe('an unexpected error while adding another key', () => {
    beforeEach(async () => { await seedDatabase(); });

    it('still puts back the keys dropped for a collation change', async () => {
        await pool.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const [table, name] of [['orders', 'fk_orders_service_charge_snapshot'], ['held_orders', 'fk_held_service_charge_snapshot'], ['service_charge_snapshots', 'fk_scs_parent']]) {
            if (await hasConstraint(table, name)) await pool.query(`ALTER TABLE ${table} DROP FOREIGN KEY ${name}`);
        }
        await pool.query('ALTER TABLE service_charge_snapshots MODIFY id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL, MODIFY parent_snapshot_id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL');
        await pool.query('ALTER TABLE service_charge_snapshots ADD CONSTRAINT fk_scs_parent FOREIGN KEY (parent_snapshot_id) REFERENCES service_charge_snapshots (id)');
        // A key earlier in the manifest than fk_scs_parent fails with an unplanned error.
        await pool.query('ALTER TABLE webauthn_recovery_codes DROP FOREIGN KEY fk_webauthn_recovery_user');
        await pool.query('SET FOREIGN_KEY_CHECKS = 1');
        const connection = await pool.getConnection();
        const failing = {
            query: (sql, values) => /ADD CONSTRAINT `fk_webauthn_recovery_user`/.test(sql)
                ? Promise.reject(Object.assign(new Error('simulated incompatible key'), { errno: 1005 }))
                : connection.query(sql, values),
            release: () => connection.release()
        };
        await expect(repairMissingConstraints({ getConnection: async () => failing })).rejects.toThrow('simulated incompatible key');
        expect(await hasConstraint('service_charge_snapshots', 'fk_scs_parent')).toBe(true);
        await pool.query('ALTER TABLE webauthn_recovery_codes ADD CONSTRAINT fk_webauthn_recovery_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE');
    });
});
