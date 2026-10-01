const { loadCheckoutSettings, hasUnfrozenPriceOverride, applyDatabasePrices } = require('../../services/OrderPricing');

describe('price override intent', () => {
    const product = { id: 1, price: 5, effective_price: 6, tax_rate: 0,
        modifiers: [{ name: 'Size', options: [{ name: 'Large', price: 0.5 }] }] };
    const products = new Map([[1, product]]);
    const line = () => ({ product_id: 1, qty: 1, price: 6.5,
        selectedModifiers: [{ group: 'Size', option: 'Large', price: 99 }] });

    it('uses the effective catalog price and canonical modifiers when deciding whether a PIN is needed', () => {
        const item = line();
        expect(hasUnfrozenPriceOverride([item], products)).toBe(false);
        applyDatabasePrices([item], products, { role: 'cashier', permissions: [] });
        expect(item.price).toBe(6.5);
        expect(item.modifier_surcharge).toBe(0.5);
    });

    it('detects a fresh manual price without changing the submitted line', () => {
        const item = { ...line(), price: 4 };
        expect(hasUnfrozenPriceOverride([item], products)).toBe(true);
        expect(item.price).toBe(4);
    });

    it('uses price-only approval without changing actor authority or later pricing', () => {
        const user = Object.freeze({ role: 'cashier', permissions: Object.freeze([]) });
        const approved = { ...line(), price: 4 };
        expect(applyDatabasePrices([approved], products, user, false, null, { priceOverrideApproved: true })).toHaveLength(1);
        expect(approved.price).toBe(4);
        const next = { ...line(), price: 4 };
        applyDatabasePrices([next], products, user);
        expect(next.price).toBe(6.5);
        expect(user.permissions).toEqual([]);
    });

    it('resets a manual price to the catalog price for a cashier with discount, tax-exempt and service-charge grants but not price override', () => {
        const item = { ...line(), price: 4 };
        const user = { role: 'cashier', permissions: ['pos.checkout', 'pos.discount', 'pos.tax_exempt', 'pos.service_charge'] };
        expect(applyDatabasePrices([item], products, user)).toEqual([]);
        expect(item.price).toBe(6.5);
    });

    it('does not ask for a fresh override for frozen saved lines', () => {
        const item = { ...line(), price: 4 };
        const frozen = new Map([['1|', 4]]);
        expect(hasUnfrozenPriceOverride([item], products, frozen)).toBe(false);
        applyDatabasePrices([item], products, { role: 'cashier', permissions: [] }, false, frozen);
        expect(item.price).toBe(4);
    });
});

describe('loadCheckoutSettings tax boundary', () => {
    let conn;

    beforeEach(() => {
        // The pricing service uses the real settings helper; return a MySQL-shaped
        // result from a tiny connection double so this test covers its boundary.
        conn = {
            query: vi.fn().mockResolvedValue([[
                { setting_key: 'stock_enabled', setting_value: '0' },
                { setting_key: 'tables_enabled', setting_value: '1' },
                { setting_key: 'tax_inclusive_pricing', setting_value: '1' },
                { setting_key: 'tax_registration_type', setting_value: 'sales_tax' },
                { setting_key: 'service_charge_enabled', setting_value: '0' },
                { setting_key: 'service_charge_percentage', setting_value: '10' },
                { setting_key: 'service_charge_tax_rate', setting_value: '16' },
                { setting_key: 'service_charge_jofotara_tax_category', setting_value: 'O' },
                { setting_key: 'auto_apply_service_charge', setting_value: '0' },
                { setting_key: 'default_order_type_id', setting_value: '1' }
            ]])
        };
    });

    it('exposes the setting only as a customer-receipt display preference', async () => {
        const settings = await loadCheckoutSettings(conn);

        expect(settings.receiptTaxInclusiveDisplay).toBe(true);
        expect(settings).not.toHaveProperty('taxInclusivePricing');
    });

});
