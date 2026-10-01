import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }),
    onMounted: vi.fn(), onActivated: vi.fn(), onDeactivated: vi.fn(), onUnmounted: vi.fn() }));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('@/shared/systemSettings.js', () => ({ getSystemSettings: async () => ({ success: true }) }));
for (const name of ['ImportModal', 'ProductModal', 'CategoryModal', 'CategoryPriceListModal', 'CategoryCopyModal', 'BatchProductWorkspace', 'StockWorkingList']) {
    vi.doMock(`../../components/${name}.vue`, () => ({ default: { render: () => null } }));
}
const { default: Inventory } = await import('../Inventory.vue');

const PRODUCTS = [
    { id: 1, name: 'Cola', barcode: '111', extra_barcodes: ['222', '333'], category_id: null, price: 1.5, tax_rate: 0, is_active: 1, modifiers: '[]' },
    { id: 2, name: 'Tea "Hot"', barcode: '444', extra_barcodes: ['5,5', 'say "hi"'], category_id: null, price: 2, tax_rate: 0, is_active: 1, modifiers: '[]' },
    { id: 3, name: 'Water', barcode: '555', extra_barcodes: [], category_id: null, price: 0.5, tax_rate: 0, is_active: 1, modifiers: '[]' },
    { id: 4, name: 'Juice', barcode: '', category_id: null, price: 3, tax_rate: 0, is_active: 0, modifiers: '[]' },
];

let scope;
beforeEach(() => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { showAdminToast: vi.fn(), showAdminAlert: vi.fn() }));
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    scope = effectScope();
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

describe('extra barcodes in the product list', () => {
    async function renderList() {
        const app = createSSRApp({
            ...Inventory,
            setup(props, ctx) { const bindings = scope.run(() => Inventory.setup(props, ctx)); bindings.products.value = PRODUCTS; return bindings; },
        });
        app.config.globalProperties.$t = key => key;
        return renderToString(app);
    }
    // The desktop table row of one product.
    const rowOf = (html, name) => html.split('<tr').find(part => part.includes(`>${name}<`)) || '';

    it('shows +N next to the barcode of a product with extras, and lists them on hover', async () => {
        const row = rowOf(await renderList(), 'Cola');
        expect(row).toContain('>+2<');
        expect(row).toContain('title="Extra barcodes: 222 | 333"');
    });

    it('shows nothing extra for a product without extras, or one from a row without the field', async () => {
        const html = await renderList();
        expect(rowOf(html, 'Water')).not.toMatch(/>\+\d/);
        expect(rowOf(html, 'Juice')).not.toMatch(/>\+\d/);
        expect(rowOf(html, 'Juice')).toContain('No Barcode');
    });
});

describe('product CSV export', () => {
    let csv;
    beforeEach(() => {
        csv = null;
        const link = { setAttribute: vi.fn(), click: vi.fn() };
        vi.stubGlobal('document', { createElement: () => link, body: { appendChild: vi.fn(), removeChild: vi.fn() } });
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { csv = blob; return 'blob:test'; });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, products: PRODUCTS, pagination: { total: PRODUCTS.length } }) })));
    });
    afterEach(() => vi.restoreAllMocks());

    it('has an Extra barcodes column, joined with " | " and quoted', async () => {
        const page = scope.run(() => Inventory.setup());
        await page.exportToCSV();
        const lines = (await csv.text()).split('\n');
        expect(lines[0].split(',').slice(0, 4)).toEqual(['Product ID', 'Name', 'Barcode', 'Extra barcodes']);
        expect(lines[1].startsWith('1,"Cola",111,"222 | 333",')).toBe(true);
        expect(lines[2].startsWith('2,"Tea ""Hot""",444,"5,5 | say ""hi""",')).toBe(true);
    });

    it('leaves the column empty for a product without extras', async () => {
        const page = scope.run(() => Inventory.setup());
        await page.exportToCSV();
        const lines = (await csv.text()).split('\n');
        expect(lines[3].startsWith('3,"Water",555,"",')).toBe(true);
        expect(lines[4].startsWith('4,"Juice",,"",')).toBe(true);
    });
});
