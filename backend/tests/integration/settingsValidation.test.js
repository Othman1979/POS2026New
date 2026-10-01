const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('POST /api/system/settings validation', () => {
    let adminCookie;
    beforeAll(async () => {
        await seedDatabase();
        const r = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = r.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    const post = (body) => request(app).post('/api/system/settings').set('Cookie', adminCookie).send(body);

    it('rejects non-numeric service_charge_percentage', async () => {
        const res = await post({ service_charge_percentage: 'abc' });
        expect(res.statusCode).toBe(400);
    });
    it('rejects out-of-range service_charge_percentage', async () => {
        expect((await post({ service_charge_percentage: '150' })).statusCode).toBe(400);
        expect((await post({ service_charge_percentage: '-5' })).statusCode).toBe(400);
    });
    it('rejects unknown table_mode', async () => {
        expect((await post({ table_mode: 'moon' })).statusCode).toBe(400);
    });
    it('rejects unknown print_method', async () => {
        expect((await post({ print_method: 'telepathy' })).statusCode).toBe(400);
    });
    it('defaults print_method to backend when the settings row is missing', async () => {
        await pool.query("DELETE FROM settings WHERE setting_key='print_method'");
        const settings = await request(app)
            .get('/api/system/settings')
            .set('Cookie', adminCookie);
        expect(settings.statusCode).toBe(200);
        expect(settings.body.print_method).toBe('backend');
    });
    it('defaults and persists the first-shift starting cash suggestion', async () => {
        await pool.query("DELETE FROM settings WHERE setting_key='first_shift_starting_cash'");
        try {
            const initial = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(initial.body.first_shift_starting_cash).toBe('0');

            const saved = await post({ first_shift_starting_cash: '100.25' });
            expect(saved.statusCode).toBe(200);

            const current = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(current.body.first_shift_starting_cash).toBe('100.25');
        } finally {
            await pool.query("DELETE FROM settings WHERE setting_key='first_shift_starting_cash'");
        }
    });
    it('rejects invalid first-shift starting cash suggestions', async () => {
        expect((await post({ first_shift_starting_cash: '-1' })).statusCode).toBe(400);
        expect((await post({ first_shift_starting_cash: 'not-money' })).statusCode).toBe(400);
        expect((await post({ first_shift_starting_cash: '100000000' })).statusCode).toBe(400);
    });
    it('defaults and persists quick numpad mode as a strict boolean setting', async () => {
        await pool.query("DELETE FROM settings WHERE setting_key='quick_numpad_mode'");
        try {
            const initial = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(initial.statusCode).toBe(200);
            expect(initial.body.quick_numpad_mode).toBe('0');

            const enabled = await post({ quick_numpad_mode: '1' });
            expect(enabled.statusCode).toBe(200);
            expect(global.__mockEmit__).toHaveBeenCalledWith(
                'settings_changed',
                { keys: ['quick_numpad_mode'] }
            );
            const [[saved]] = await pool.query(
                "SELECT setting_value FROM settings WHERE setting_key='quick_numpad_mode'"
            );
            expect(saved.setting_value).toBe('1');

            expect((await post({ store_name: 'Quick Numpad Partial Save' })).statusCode).toBe(200);

            const current = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(current.body.quick_numpad_mode).toBe('1');

            expect((await post({ quick_numpad_mode: '0' })).statusCode).toBe(200);
        } finally {
            await pool.query("DELETE FROM settings WHERE setting_key='quick_numpad_mode'");
        }
    });
    it('defaults and persists quantity presets as a strict boolean setting', async () => {
        await pool.query("DELETE FROM settings WHERE setting_key='quantity_presets_enabled'");
        try {
            const initial = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(initial.statusCode).toBe(200);
            expect(initial.body.quantity_presets_enabled).toBe('1');

            const disabled = await post({ quantity_presets_enabled: '0' });
            expect(disabled.statusCode).toBe(200);
            expect(global.__mockEmit__).toHaveBeenCalledWith(
                'settings_changed',
                { keys: ['quantity_presets_enabled'] }
            );
            const [[saved]] = await pool.query(
                "SELECT setting_value FROM settings WHERE setting_key='quantity_presets_enabled'"
            );
            expect(saved.setting_value).toBe('0');

            expect((await post({ store_name: 'Quantity Presets Partial Save' })).statusCode).toBe(200);
            const current = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(current.body.quantity_presets_enabled).toBe('0');
        } finally {
            await pool.query("DELETE FROM settings WHERE setting_key='quantity_presets_enabled'");
        }
    });
    it('persists the recipe ledger toggle on /api/system and audits the change', async () => {
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='recipe_ledger_enabled'");
        try {
            const initial = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(initial.statusCode).toBe(200);
            expect(initial.body.recipe_ledger_enabled).toBe('0');

            const enabled = await post({ recipe_ledger_enabled: '1' });
            expect(enabled.statusCode).toBe(200);

            const current = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(current.body.recipe_ledger_enabled).toBe('1');
            const [[saved]] = await pool.query(
                "SELECT setting_value FROM settings WHERE setting_key='recipe_ledger_enabled'"
            );
            expect(saved.setting_value).toBe('1');

            const [[audit]] = await pool.query(
                "SELECT event_type, old_value, new_value FROM audit_events WHERE event_type='recipe_ledger_toggled' ORDER BY id DESC LIMIT 1"
            );
            expect(audit).toBeTruthy();
            expect(JSON.parse(audit.old_value)).toMatchObject({ enabled: '0' });
            expect(JSON.parse(audit.new_value)).toMatchObject({ enabled: '1' });
        } finally {
            await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='recipe_ledger_enabled'");
        }
    });
    it('rejects malformed recipe ledger values', async () => {
        expect((await post({ recipe_ledger_enabled: 'yes' })).statusCode).toBe(400);
        expect((await post({ recipe_ledger_enabled: true })).statusCode).toBe(400);
        expect((await post({ recipe_ledger_enabled: 1 })).statusCode).toBe(400);
    });
    it('rejects malformed quick numpad mode values', async () => {
        expect((await post({ quick_numpad_mode: 'yes' })).statusCode).toBe(400);
        expect((await post({ quick_numpad_mode: true })).statusCode).toBe(400);
        expect((await post({ quick_numpad_mode: 1 })).statusCode).toBe(400);
    });
    it('rejects malformed quantity preset values', async () => {
        expect((await post({ quantity_presets_enabled: 'yes' })).statusCode).toBe(400);
        expect((await post({ quantity_presets_enabled: true })).statusCode).toBe(400);
        expect((await post({ quantity_presets_enabled: 1 })).statusCode).toBe(400);
    });
    it('rejects invalid automatic table service-charge values', async () => {
        expect((await post({ auto_apply_service_charge: 'yes' })).statusCode).toBe(400);
    });
    it('persists the automatic table service-charge toggle', async () => {
        const res = await post({ auto_apply_service_charge: '1' });
        expect(res.statusCode).toBe(200);
        const [[row]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='auto_apply_service_charge'");
        expect(row.setting_value).toBe('1');
    });
    it('turns automatic table charging off when its parent feature is disabled', async () => {
        await post({ tables_enabled: '1', service_charge_enabled: '1', auto_apply_service_charge: '1' });
        const res = await post({ service_charge_enabled: '0' });
        expect(res.statusCode).toBe(200);
        const [[row]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='auto_apply_service_charge'");
        expect(row.setting_value).toBe('0');
    });
    it('accepts valid values', async () => {
        const res = await post({ service_charge_percentage: '12.5', service_charge_tax_rate: '0', low_stock_threshold: '5', table_mode: 'dynamic', print_method: 'backend' });
        expect(res.statusCode).toBe(200);
        const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_percentage'");
        expect(rows[0].setting_value).toBe('12.5');
    });
    it('enforces representable service-charge precision', async () => {
        expect((await post({ service_charge_percentage: '12.3456' })).statusCode).toBe(200);
        let [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_percentage'");
        expect(rows[0].setting_value).toBe('12.3456');
        expect((await post({ service_charge_percentage: '12.34567' })).statusCode).toBe(400);
        [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_percentage'");
        expect(rows[0].setting_value).toBe('12.3456');
        expect((await post({ service_charge_tax_rate: '16.25' })).statusCode).toBe(200);
        [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_tax_rate'");
        expect(rows[0].setting_value).toBe('16.25');
        expect((await post({ service_charge_tax_rate: '16.255' })).statusCode).toBe(400);
        [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_tax_rate'");
        expect(rows[0].setting_value).toBe('16.25');
    });
    it('allows partial saves that omit service-charge fields', async () => {
        const before = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'service_charge_%'");
        const res = await post({ store_name: 'Partial Save' });
        expect(res.statusCode).toBe(200);
        const after = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'service_charge_%'");
        expect(after[0]).toEqual(before[0]);
    });
    it('stores O/Z for a zero-rate service charge and derives S for a positive rate', async () => {
        expect((await post({ service_charge_tax_rate: '0', service_charge_jofotara_tax_category: 'Z' })).statusCode).toBe(200);
        let [[row]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_jofotara_tax_category'");
        expect(row.setting_value).toBe('Z');
        expect((await post({ service_charge_tax_rate: '8' })).statusCode).toBe(200);
        [[row]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_jofotara_tax_category'");
        expect(row.setting_value).toBe('S');
        expect((await post({ service_charge_tax_rate: '0', service_charge_jofotara_tax_category: 'S' })).statusCode).toBe(400);
    });

    it('rejects enabling an unsupported service-charge sales-tax rate atomically', async () => {
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'tax_registration_type' THEN 'sales_tax'
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END
            WHERE setting_key IN ('jofotara_enabled','tax_registration_type','jofotara_sales_tax_client_id',
                'jofotara_sales_tax_secret_key','jofotara_sales_tax_income_source_sequence',
                'jofotara_sales_tax_seller_tax_number','jofotara_sales_tax_seller_registered_name')`);
        try {
            const before = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_tax_rate'");
            const res = await post({ service_charge_enabled: '1', service_charge_tax_rate: '6.5' });
            expect(res.statusCode).toBe(409);
            const after = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_tax_rate'");
            expect(after[0]).toEqual(before[0]);
        } finally {
            await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='jofotara_enabled'");
        }
    });
    it('stores, exposes, and clears the default order type', async () => {
        try {
            const saved = await post({ default_order_type_id: String(SEED.orderType.id) });
            expect(saved.statusCode).toBe(200);

            const settings = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(settings.body.default_order_type_id).toBe(String(SEED.orderType.id));

            const types = await request(app)
                .get('/api/admin/order_types')
                .set('Cookie', adminCookie);
            expect(types.body.data.find(type => type.id === SEED.orderType.id).is_default).toBe(1);

            const posTypes = await request(app)
                .get('/api/pos/order_types')
                .set('Cookie', adminCookie);
            expect(posTypes.body.data.find(type => type.id === SEED.orderType.id).is_default).toBe(1);

            const cleared = await post({ default_order_type_id: '' });
            expect(cleared.statusCode).toBe(200);
            const [[row]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='default_order_type_id'");
            expect(row.setting_value).toBe('');
        } finally {
            await pool.query(
                "INSERT INTO settings (setting_key, setting_value) VALUES ('default_order_type_id', '') ON DUPLICATE KEY UPDATE setting_value=''"
            );
        }
    });

    it('exposes the active tax registration type to POS pricing', async () => {
        await pool.query(
            "INSERT INTO settings (setting_key, setting_value) VALUES ('tax_registration_type', 'income_tax') ON DUPLICATE KEY UPDATE setting_value='income_tax'"
        );

        const settings = await request(app)
            .get('/api/system/settings')
            .set('Cookie', adminCookie);

        expect(settings.statusCode).toBe(200);
        expect(settings.body.tax_registration_type).toBe('income_tax');
    });
    it('rejects a malformed or unavailable default order type', async () => {
        expect((await post({ default_order_type_id: 'not-an-id' })).statusCode).toBe(400);
        expect((await post({ default_order_type_id: '999999' })).statusCode).toBe(400);
    });

    it('stores, exposes, and clears the Y order type', async () => {
        try {
            const saved = await post({ y_order_type_id: String(SEED.orderType.id) });
            expect(saved.statusCode).toBe(200);

            const settings = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);
            expect(settings.body.y_order_type_id).toBe(String(SEED.orderType.id));

            expect((await post({ y_order_type_id: '' })).statusCode).toBe(200);
            const [[row]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='y_order_type_id'");
            expect(row.setting_value).toBe('');
        } finally {
            await pool.query(
                "INSERT INTO settings (setting_key, setting_value) VALUES ('y_order_type_id', '') ON DUPLICATE KEY UPDATE setting_value=''"
            );
        }
    });

    it('rejects a malformed or unavailable Y order type', async () => {
        expect((await post({ y_order_type_id: 'not-an-id' })).statusCode).toBe(400);
        expect((await post({ y_order_type_id: '999999' })).statusCode).toBe(400);
    });

    it('keeps the default and Y order types distinct', async () => {
        await post({ default_order_type_id: String(SEED.orderType.id) });
        expect((await post({ y_order_type_id: String(SEED.orderType.id) })).statusCode).toBe(400);

        await post({ default_order_type_id: '', y_order_type_id: String(SEED.orderType.id) });
        expect((await post({ default_order_type_id: String(SEED.orderType.id) })).statusCode).toBe(400);

        await post({ default_order_type_id: '', y_order_type_id: '' });
    });
});
