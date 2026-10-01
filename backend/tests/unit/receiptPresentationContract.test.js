import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vue templates are not type-checked and the production build cannot detect a
// reference to a nonexistent receipt_display_v1 field — `undefined.toFixed(2)`
// only throws when a cashier opens the preview. This contract test scans every
// v1-consuming component source for summary-field accesses and asserts each one
// exists in the model, so a renamed/mistyped field fails in CI instead of at
// the register (regression: isBundleChild/roundingAmount/serviceChargeAmount).

const V1_SUMMARY_FIELDS = new Set([
    'subtotal', 'orderDiscountAmount', 'orderDiscountLabel',
    'taxAmount', 'taxLabel', 'roundingAdjustment', 'total'
]);
const FORBIDDEN_TOKENS = ['isBundleChild', 'roundingAmount', 'serviceChargeAmount'];

const CONSUMERS = [
    'src/components/OrderNotes.vue',
    'src/components/TableSplits.vue',
    'src/components/PosTerminal.vue',
    'src/components/pos/ReceiptPreviewModal.vue',
    'src/print/PrintReceiptApp.vue',
    'src/admin/components/A4Receipt.vue',
    'src/admin/components/DeliveryInvoice.vue',
    'src/admin/pages/Orders.vue'
];

const root = resolve(__dirname, '../../..');
const ORDER_DISCOUNT_LABEL_CONSUMERS = [
    'src/components/pos/ReceiptPreviewModal.vue',
    'src/print/PrintReceiptApp.vue'
];

// ReceiptPreviewModal and ReceiptPrintLayout are rendered in receiptPreviewRender.spec.js.
const CUSTOMER_SUMMARY_CONSUMERS = [
    'src/print/PrintReceiptApp.vue',
    'src/admin/components/A4Receipt.vue',
    'src/admin/components/DeliveryInvoice.vue',
    'src/components/OrderNotes.vue',
    'src/components/TableSplits.vue'
];

describe('receipt_display_v1 component contract', () => {
    it.each(CONSUMERS)('%s references only real v1 summary fields', (file) => {
        const source = readFileSync(resolve(root, file), 'utf8');
        const offenders = [];
        // Only audit summary accesses reached through a v1 accessor chain —
        // PrintReceiptApp also renders audit-report payloads with their own
        // unrelated `summary` object (gross_sales etc.).
        for (const match of source.matchAll(/([\w$.]*)\.summary\.([A-Za-z_$][\w$]*)/g)) {
            const chain = match[1];
            if (!/presentation|receipt_display_v1/i.test(chain)) continue;
            if (!V1_SUMMARY_FIELDS.has(match[2])) offenders.push(match[2]);
        }
        for (const token of FORBIDDEN_TOKENS) {
            if (source.includes(token)) offenders.push(token);
        }
        expect(offenders).toEqual([]);
    });

    it.each(ORDER_DISCOUNT_LABEL_CONSUMERS)('%s renders the order discount rule label', (file) => {
        const source = readFileSync(resolve(root, file), 'utf8');
        expect(source).toContain('orderDiscountLabel');
    });

    it.each(CUSTOMER_SUMMARY_CONSUMERS)('%s hides subtotal and tax rows for inclusive customer copies', (file) => {
        const source = readFileSync(resolve(root, file), 'utf8');
        const guard = file.includes('OrderNotes.vue') || file.includes('TableSplits.vue')
            ? "selectedPresentation.presentation.taxMode !== 'inclusive'"
            : "presentation.taxMode !== 'inclusive'";
        expect(source.split(guard).length - 1).toBeGreaterThanOrEqual(2);
    });

    it('POS product cards omit the tax suffix and cart row totals use their gross amount', () => {
        const catalogSource = readFileSync(resolve(root, 'src/components/pos/PosCatalogWorkspace.vue'), 'utf8');
        const cartSource = readFileSync(resolve(root, 'src/components/pos/PosCartWorkspace.vue'), 'utf8');
        const renderModelSource = readFileSync(resolve(root, 'src/components/pos/cartRenderModel.js'), 'utf8');

        expect(catalogSource).not.toMatch(/<template v-if="!taxInclusivePricing">\s*\{\{ \$t\('incl\. tax'\) \}\}<\/template>/);
        expect(cartSource).not.toContain('?.netAmount.toFixed(2) ?? getItemTotalGross(item).toFixed(2)');
        expect(cartSource).toContain('{{ row.grossTotal.toFixed(2) }}');
        expect(renderModelSource).toContain('grossTotal: getGrossTotal(item)');
    });

    it('POS cart treats the service-charge marker as internal-only', () => {
        const source = readFileSync(resolve(root, 'src/components/pos/PosCartWorkspace.vue'), 'utf8');
        const renderModelSource = readFileSync(resolve(root, 'src/components/pos/cartRenderModel.js'), 'utf8');
        expect(source).toContain("v-if=\"row.item.note && row.item.note !== 'Auto-Gratuity'\"");
        expect(renderModelSource).toContain("item?.note === 'Auto-Gratuity'");
    });

    it('OrderNotes reads the flat held-kitchen response count', () => {
        const source = readFileSync(resolve(root, 'src/components/OrderNotes.vue'), 'utf8');
        expect(source).toContain('const count = Number(data.count) || 0;');
        expect(source).not.toContain('data.data?.count');
    });

    it('OrderNotes uses the frozen held receipt total before its legacy calculator', () => {
        const source = readFileSync(resolve(root, 'src/components/OrderNotes.vue'), 'utf8');
        expect(source).toMatch(/o\.receipt_display_v1\?\.summary\?\.total\s*\?\?\s*heldOrderTotal/);
        expect(source).not.toContain('heldOrderTotal(items, order_discount, taxInclusive.value)');
    });

    it.each([
        'src/components/pos/ReceiptPreviewModal.vue',
        'src/print/PrintReceiptApp.vue'
    ])('%s hides the internal service-charge marker on customer receipts', (file) => {
        const source = readFileSync(resolve(root, file), 'utf8');
        expect(source).toContain("v-if=\"item.note && item.note !== 'Auto-Gratuity'\"");
    });

    it.each([
        'src/components/pos/PosCartWorkspace.vue',
        'src/components/pos/ReceiptPreviewModal.vue',
        'src/print/PrintReceiptApp.vue'
    ])('%s localizes the service-charge display name', (file) => {
        const source = readFileSync(resolve(root, file), 'utf8');
        expect(source).toContain('serviceChargeDisplayName');
    });
});
