import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope, h, nextTick, reactive } from 'vue';
import { renderToString } from 'vue/server-renderer';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn(), fetchJsonResponse: vi.fn() }));
import Component from '../ProductModal.vue';
import { fetchJson } from '@/shared/http.js';
import { currentLanguage } from '@/shared/i18n.js';

const flush = async () => { for (let i = 0; i < 4; i++) await nextTick(); };
let scope, props, state, emit;

async function openModal(product) {
    props.product = product;
    props.show = true;
    await flush();
}
const sentBody = () => JSON.parse(fetchJson.mock.calls.at(-1)[1].body);
const typeExtra = (value) => { state.extraBarcodeInput.value = value; };
const enter = () => { const event = { preventDefault: vi.fn() }; state.onExtraBarcodeEnter(event); return event; };
const extras = () => state.productForm.value.extra_barcodes;
const cola = (overrides = {}) => ({ id: 5, name: 'Cola', price: 1, is_active: 1, barcode: '111', extra_barcodes: ['222', '333'], ...overrides });

beforeEach(() => {
    vi.stubGlobal('window', { showAdminToast: vi.fn(), showAdminAlert: vi.fn() });
    fetchJson.mockReset();
    fetchJson.mockResolvedValue({ success: true });
    emit = vi.fn();
    props = reactive({ show: false, product: null, initialTab: 'general' });
    scope = effectScope();
    state = scope.run(() => Component.setup(props, { emit }));
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

describe('extra barcodes in the product editor', () => {
    it('loads the product\'s extra barcodes and leaves them out of a save that did not change them', async () => {
        await openModal(cola());
        expect(extras()).toEqual(['222', '333']);
        await state.saveProduct();
        expect(sentBody()).not.toHaveProperty('extra_barcodes');
        expect(emit).toHaveBeenCalledWith('saved');
    });

    it('sends an empty extra_barcodes list for a new product', async () => {
        await openModal(null);
        state.productForm.value.name = 'Cola';
        state.productForm.value.price = '1.00';
        await state.saveProduct();
        expect(sentBody().extra_barcodes).toEqual([]);
    });

    it.each([
        ['a product without any', cola({ extra_barcodes: [] })],
        ['a row from a list that has no extras field', cola({ extra_barcodes: undefined })],
    ])('leaves extra_barcodes out of an unchanged save of %s', async (_, product) => {
        await openModal(product);
        await state.saveProduct();
        expect(sentBody()).not.toHaveProperty('extra_barcodes');
    });

    it('does not carry one product\'s extras into the next one opened', async () => {
        await openModal(cola());
        props.show = false; await flush();
        await openModal(null);
        expect(extras()).toEqual([]);
        props.show = false; await flush();
        await openModal(cola({ id: 6, extra_barcodes: ['999'] }));
        expect(extras()).toEqual(['999']);
    });

    describe('adding', () => {
        beforeEach(async () => { await openModal(cola({ extra_barcodes: [] })); });

        it('adds the typed code on Enter without submitting the product form', () => {
            typeExtra('  8901234  ');
            const event = enter();
            expect(event.preventDefault).toHaveBeenCalled();
            expect(extras()).toEqual(['8901234']);
            expect(state.extraBarcodeInput.value).toBe('');
            expect(state.extraBarcodeMessage.value).toBe('');
            expect(fetchJson).not.toHaveBeenCalled();
        });

        it('ignores an empty entry', () => {
            typeExtra('   ');
            enter();
            expect(extras()).toEqual([]);
            expect(state.extraBarcodeMessage.value).toBe('');
        });

        it('keeps the order codes were added in, so a scanner can add several in a row', () => {
            for (const code of ['A1', 'B2', 'C3']) { typeExtra(code); enter(); }
            expect(extras()).toEqual(['A1', 'B2', 'C3']);
        });

        it.each([
            ['a code already in the list', { main: '111', list: ['AA-1'], typed: 'aa-1' }],
            ['the main barcode', { main: '111', list: [], typed: '111' }],
            ['the main barcode in another letter case', { main: '1A1', list: [], typed: '1a1' }],
        ])('refuses %s and says why', (_, { main, list, typed }) => {
            state.productForm.value.barcode = main;
            state.productForm.value.extra_barcodes = [...list];
            typeExtra(typed);
            enter();
            expect(extras()).toEqual(list);
            expect(state.extraBarcodeMessage.value).not.toBe('');
            expect(state.extraBarcodeInput.value).toBe(typed);
        });

        it('stops at 20 extra barcodes', () => {
            for (let i = 1; i <= 20; i++) { typeExtra(`CODE-${i}`); enter(); }
            expect(extras()).toHaveLength(20);
            typeExtra('CODE-21');
            enter();
            expect(extras()).toHaveLength(20);
            expect(extras()).not.toContain('CODE-21');
            expect(state.extraBarcodeMessage.value).not.toBe('');
        });

        it('refuses a code over 50 characters instead of cutting it short', () => {
            typeExtra('9'.repeat(50)); enter();
            expect(extras()).toEqual(['9'.repeat(50)]);
            typeExtra('8'.repeat(51)); enter();
            expect(extras()).toEqual(['9'.repeat(50)]);
            expect(state.extraBarcodeMessage.value).not.toBe('');
        });

        it('clears the refusal once the next code is accepted', () => {
            typeExtra('111'); enter();
            expect(state.extraBarcodeMessage.value).not.toBe('');
            typeExtra('555'); enter();
            expect(state.extraBarcodeMessage.value).toBe('');
            expect(extras()).toEqual(['555']);
        });
    });

    describe('removing', () => {
        it('drops only that code, and the save no longer sends it', async () => {
            await openModal(cola({ extra_barcodes: ['222', '333', '444'] }));
            state.removeExtraBarcode('333');
            expect(extras()).toEqual(['222', '444']);
            await state.saveProduct();
            expect(sentBody().extra_barcodes).toEqual(['222', '444']);
        });

        it('lets the freed code be added again', async () => {
            await openModal(cola({ extra_barcodes: ['222'] }));
            state.removeExtraBarcode('222');
            typeExtra('222'); enter();
            expect(extras()).toEqual(['222']);
        });

        it('sends an empty list when the last code is removed, which clears them on the server', async () => {
            await openModal(cola({ extra_barcodes: ['222'] }));
            state.removeExtraBarcode('222');
            await state.saveProduct();
            expect(sentBody().extra_barcodes).toEqual([]);
        });
    });

    describe('saving with a code typed but not added', () => {
        it('adds it first, so it is not lost', async () => {
            await openModal(cola({ extra_barcodes: [] }));
            typeExtra('777');
            await state.saveProduct();
            expect(sentBody().extra_barcodes).toEqual(['777']);
        });

        it('does not save while that code is refused, and shows the Details tab with the reason', async () => {
            await openModal(cola({ extra_barcodes: ['222'] }));
            state.productModalTab.value = 'modifiers';
            typeExtra('222');
            await state.saveProduct();
            expect(fetchJson).not.toHaveBeenCalled();
            expect(state.extraBarcodeMessage.value).not.toBe('');
            expect(state.productModalTab.value).toBe('general');
        });
    });

    describe('server barcode refusals', () => {
        it.each([
            ['PRODUCT_BARCODE_TAKEN', 409, 'Barcode 222 is already used by Fanta.'],
            ['PRODUCT_BARCODE_INVALID', 400, 'A product can have at most 20 extra barcodes.'],
        ])('shows %s next to the barcode fields instead of an alert, and keeps the form open', async (code, _status, message) => {
            await openModal(cola());
            state.productModalTab.value = 'modifiers';
            fetchJson.mockResolvedValue({ success: false, code, message });
            await state.saveProduct();
            expect(state.barcodeError.value).toBe(message);
            expect(state.productModalTab.value).toBe('general');
            expect(window.showAdminAlert).not.toHaveBeenCalled();
            expect(emit).not.toHaveBeenCalledWith('saved');
            expect(extras()).toEqual(['222', '333']);
        });

        it('shows the server refusal in Arabic on an Arabic screen', async () => {
            const before = currentLanguage.value;
            currentLanguage.value = 'ar';
            try {
                await openModal(cola());
                fetchJson.mockResolvedValue({ success: false, code: 'PRODUCT_BARCODE_TAKEN', message: 'Barcode 222 is already used by Fanta.' });
                await state.saveProduct();
                expect(state.barcodeError.value).toBe('الباركود 222 مستخدم بالفعل في المنتج Fanta.');
            } finally {
                currentLanguage.value = before;
            }
        });

        it('forgets the message when the editor is opened again', async () => {
            await openModal(cola());
            fetchJson.mockResolvedValue({ success: false, code: 'PRODUCT_BARCODE_TAKEN', message: 'Barcode 111 is already used by Fanta.' });
            await state.saveProduct();
            expect(state.barcodeError.value).not.toBe('');
            props.show = false; await flush();
            await openModal(cola());
            expect(state.barcodeError.value).toBe('');
        });

        it('keeps using the alert for any other refusal', async () => {
            await openModal(cola());
            fetchJson.mockResolvedValue({ success: false, code: 'SOMETHING_ELSE', message: 'Nope.' });
            await state.saveProduct();
            expect(window.showAdminAlert).toHaveBeenCalledWith('Nope.');
            expect(state.barcodeError.value).toBe('');
        });
    });
});

describe('extra barcodes as the admin sees them', () => {
    const Empty = { render: () => null };
    const ModalShell = { setup: (_, { slots }) => () => h('div', [slots.default?.()]) };
    async function render(prepare) {
        const app = createSSRApp({
            ...Component,
            components: { ModalShell, ProductRecipeEditor: Empty, StockActivationPanel: Empty },
            setup(componentProps, ctx) { const bindings = Component.setup(componentProps, ctx); prepare(bindings); return bindings; },
        }, { show: true, product: null });
        app.config.globalProperties.$t = key => key;
        return renderToString(app);
    }

    it('lists each code with its own labelled remove button', async () => {
        const html = await render(bindings => { bindings.productForm.value.extra_barcodes = ['222', '333']; });
        for (const code of ['222', '333']) {
            expect(html).toContain(`>${code}<`);
            expect(html).toContain(`aria-label="Remove barcode ${code}"`);
        }
        expect(html).toMatch(/>2\/20</);
    });

    it('shows no list and no counter for a product without extras', async () => {
        const html = await render(() => {});
        expect(html).not.toContain('Remove barcode');
        expect(html).not.toMatch(/\d+\/20</);
        expect(html).toContain('Extra barcodes');
    });

    it('shows the inline refusal and the server message with a wrapper, marking the barcode invalid', async () => {
        const html = await render(bindings => {
            bindings.extraBarcodeMessage.value = 'This barcode is already on this product.';
            bindings.barcodeError.value = 'Barcode 222 is already used by Fanta.';
        });
        expect(html).toContain('This barcode is already on this product.');
        expect(html).toContain('The product was not saved.');
        expect(html).toContain('Barcode 222 is already used by Fanta.');
        expect(html).toContain('aria-invalid="true"');
    });
});
