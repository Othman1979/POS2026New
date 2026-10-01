import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import A4Receipt from '../A4Receipt.vue';
import DeliveryInvoice from '../DeliveryInvoice.vue';

const order = {
    invoice_id: 42,
    invoice_display_no: '42',
    order_id: 42,
    order_display_no: '42',
    cashier_name: 'Maya',
    order_type_name: 'Delivery',
    payment_method: 'cash',
    tax_registration_type_at_sale: 'income_tax',
    created_at: '2026-09-16 10:00:00',
    subtotal: 5,
    tax: 0,
    total: 5
};

const settings = {
    store_name: 'Tax Cafe',
    tax_registration_type: 'sales_tax',
    jofotara_sales_tax_seller_tax_number: 'SALES-123',
    jofotara_income_tax_seller_tax_number: 'INCOME-456'
};

async function render(component, storeSettings = settings) {
    const app = createSSRApp({ render: () => h(component, { order, items: [], storeSettings }) });
    app.config.globalProperties.$t = text => text;
    return renderToString(app);
}

describe('invoice seller tax number', () => {
    it.each([A4Receipt, DeliveryInvoice])('uses the invoice profile in %s', async component => {
        const html = await render(component);
        expect(html).toContain('Seller tax number');
        expect(html).toContain('INCOME-456');
        expect(html).not.toContain('SALES-123');
    });

    it.each([A4Receipt, DeliveryInvoice])('omits the row from %s when the number is blank', async component => {
        const html = await render(component, { ...settings, jofotara_income_tax_seller_tax_number: null });
        expect(html).not.toContain('Seller tax number');
        expect(html).not.toContain('INCOME-456');
    });
});
