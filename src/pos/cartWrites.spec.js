import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({
    auth: { activeUser: { value: { id: 1, name: 'Cashier', role: 'cashier', permissions: ['pos.void_item', 'pos.void_printed_item'] } }, activeShift: { value: { id: 9 } }, isTempAdmin: { value: false } },
    terminal: { lastOrder: { value: null }, printReceipt: vi.fn(), dispatchToNodeSpooler: vi.fn(), printMethod: { value: 'frontend' }, taxInclusivePricing: { value: false }, receiptTaxInclusiveDisplay: { value: false }, taxRegistrationType: { value: 'sales_tax' } },
    api: { checkoutOrder: vi.fn(), getOrderDetails: vi.fn(), holdOrder: vi.fn(), releaseHeldOrder: vi.fn(), getTableDraft: vi.fn(), splitTable: vi.fn(), updateTableSplits: vi.fn(), getTableSplits: vi.fn(), followUpHeldOrder: vi.fn(), confirmHeldKitchenBaseline: vi.fn(), cancelHeldOrder: vi.fn(), voidTableItems: vi.fn() }
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => mocks.terminal }));
vi.mock('@/pos/useProducts.js', () => ({ useProducts: () => ({ products: { value: [] }, settings: { value: { stock_enabled: '0', service_charge_enabled: '0' } } }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true, hasDirect: () => true }) }));
vi.mock('@/pos/stores/orderSession/orderSessionApi.js', () => mocks.api);

import { useOrderSessionStore } from './stores/orderSessionStore.js';
import { useOrderUiStore } from './stores/orderUiStore.js';

const line = (id = 1) => ({ id, name: `Item ${id}`, price: 10, qty: 1, tax_rate: 0, cartId: `line-${id}`, discountValue: 0 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const ok = data => ({ response: { ok: true, status: 200 }, data: { success: true, ...data } });
let storage;
beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    storage = new Map();
    vi.stubGlobal('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) });
    vi.stubGlobal('window', { showPosAlert: vi.fn(), showPosToast: vi.fn(), showPosPrompt: vi.fn().mockResolvedValue('Lunch'), showPosConfirm: vi.fn().mockResolvedValue(true), history: { replaceState: vi.fn() }, location: { href: '', pathname: '/pos' } });
    vi.stubGlobal('document', { documentElement: { dir: 'ltr' } });
    mocks.terminal.lastOrder.value = null;
    mocks.terminal.ensureSettings = vi.fn().mockResolvedValue(true);
    mocks.terminal.settingsLoaded = { value: true };
    mocks.terminal.printReceipt.mockResolvedValue(true);
    mocks.terminal.printMethod.value = 'frontend';
    mocks.terminal.duplicateCustomerReceipt = { value: false };
    mocks.api.releaseHeldOrder.mockResolvedValue(ok({}));
});

import { POS_ORDER_KEYS } from './stores/orderSession/orderSessionPersistence.js';
import { createRequire } from 'node:module';
const { serviceChargeFee: backendFee } = createRequire(import.meta.url)('../../backend/services/ServiceChargeCalculator.js');

const plain = { id: 2, name: 'Tea', price: 10, qty: 1, tax_rate: 16, cartId: 'p1', discountValue: 0 };
const fee = { name: '10% Service Charge', note: 'Auto-Gratuity', price: 1, qty: 1, tax_rate: 0, product_id: null, cartId: 'fee' };

describe('cart writes', () => {
    it('a quantity edit on a cart with a service charge refreshes the fee and persists the cart once', async () => {
        const s = useOrderSessionStore();
        s.serviceChargeSnapshot = { id: 1, version: 1, percentage: 10, taxRate: 0 };
        s.cart = [{ ...plain }, { ...fee }];
        await nextTick(); await nextTick();
        const writes = [];
        const set = localStorage.setItem;
        localStorage.setItem = (k, v) => { if (k === POS_ORDER_KEYS.cart) writes.push(JSON.parse(v)); set(k, v); };
        s.cart[0].qty = 3;
        await nextTick(); await nextTick(); await nextTick();
        const expected = backendFee([{ ...plain, qty: 3 }], 10, {});
        expect(s.cart[1].price).toBe(expected);
        expect(writes).toHaveLength(1);
        expect(writes[0][1].price).toBe(expected);
    });

    it('a catalog line keeps what the cart, receipt and server read and drops the catalog-only columns', async () => {
        const s = useOrderSessionStore();
        const modifiers = JSON.stringify([{ id: 'g1', name: 'Size', options: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, name: `Option ${i}`, price: i })) }]);
        const product = {
            id: 7, category_id: 3, barcode: '6251234567890', name: 'Burger', price: 5, modifiers,
            price_override_locked: 1, tax_rate: 16, jofotara_tax_category: 'S', stock: 40, background_color: '#ff0000',
            is_bundle: 0, is_available: 1, can_sell: 1, category_name: 'Mains', category_is_notes: 0, category_is_active: 1,
            base_price: 5, price_list_root_id: null, price_list_root_name: null, has_price_override: 0
        };
        for (let i = 0; i < 10; i++) await s.addToCart({ ...product, id: 7 + i }, { source: 'barcode' });
        await nextTick();
        const line = s.cart[0];
        for (const key of ['modifiers', 'parsedMods', 'barcode', 'stock', 'background_color', 'category_name', 'category_is_active', 'base_price', 'price_list_root_id', 'price_list_root_name', 'has_price_override']) {
            expect(line).not.toHaveProperty(key);
        }
        expect(line).toMatchObject({ id: 7, name: 'Burger', price: 5, tax_rate: 16, jofotara_tax_category: 'S', price_override_locked: 1, is_available: 1, can_sell: 1, category_id: 3, category_is_notes: 0, qty: 1 });
    });
});

describe('quick numpad amounts', () => {
    const nuts = { id: 5, name: 'Nuts', price: 2.5, tax_rate: 0, stock: null };
    const tapNuts = store => store.addToCart(nuts, { source: 'catalog', useQuickAmount: true });
    beforeEach(() => { mocks.terminal.quickNumpadMode = { value: true }; });
    afterEach(() => { delete mocks.terminal.quickNumpadMode; });

    it('adds the quantity a typed amount buys when a product is tapped', async () => {
        const store = useOrderSessionStore(), ui = useOrderUiStore();
        ui.numpadInput = '5';
        await tapNuts(store);
        expect(store.cart.map(item => item.qty)).toEqual([2]);
        expect(ui.numpadInput).toBe('');
    });

    it('adds a typed number as a quantity once after the multiplier is pressed', async () => {
        const store = useOrderSessionStore(), ui = useOrderUiStore();
        ui.numpadInput = '3';
        expect(store.armQuickAmount()).toBe(true);
        await tapNuts(store);
        expect(store.cart.map(item => item.qty)).toEqual([3]);
        expect(ui.quickTargetAmount).toBeNull();
    });
});
