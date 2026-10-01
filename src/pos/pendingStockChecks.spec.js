import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
    auth: { activeUser: { value: { id: 1, name: 'Cashier', role: 'cashier', permissions: [] } }, activeShift: { value: { id: 9 } }, isTempAdmin: { value: false } },
    terminal: { lastOrder: { value: null }, printMethod: { value: 'frontend' }, taxInclusivePricing: { value: false }, receiptTaxInclusiveDisplay: { value: false }, taxRegistrationType: { value: 'sales_tax' }, quickNumpadMode: { value: false } },
    products: { products: { value: [] }, settings: { value: { stock_enabled: '1', service_charge_enabled: '0' } } },
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => mocks.terminal }));
vi.mock('@/pos/useProducts.js', () => ({ useProducts: () => mocks.products }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true, hasDirect: () => true }) }));
vi.mock('@/pos/stores/orderSession/orderSessionApi.js', () => ({}));
vi.mock('vue-router', () => ({ useRouter: () => null }));

import { useOrderSessionStore } from './stores/orderSessionStore.js';
import { useOrderUiStore } from './stores/orderUiStore.js';
import { useCart } from './useCart.js';

const product = { id: 1, name: 'Burger', price: 10, tax_rate: 0, stock: 5, can_sell: 1 };
const savedLine = qty => ({ id: 1, name: 'Burger', price: 10, qty, originalQty: qty, order_item_id: 71, tax_rate: 0, cartId: 'saved', discountValue: 0 });

beforeEach(() => {
    setActivePinia(createPinia());
    mocks.products.products.value = [product];
    mocks.products.settings.value.stock_enabled = '1';
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('window', { showPosAlert: vi.fn().mockResolvedValue(), showPosToast: vi.fn(), history: { replaceState: vi.fn() }, location: { href: '', pathname: '/pos' } });
    vi.stubGlobal('document', { documentElement: { dir: 'ltr' } });
});
afterEach(() => vi.unstubAllGlobals());

const reopenTable = (store, qty) => store.loadTableOrder({ id: 7, table_number: '7', status: 'occupied', current_order_id: 70 }, [savedLine(qty)]);
const qtyInCart = store => store.cart.filter(item => item.id === 1).reduce((sum, item) => sum + Number(item.qty), 0);

describe('stock checks count only unsaved quantity', () => {
    it('keeps the register limit when nothing is saved', async () => {
        const store = useOrderSessionStore();
        for (let i = 0; i < 5; i++) await store.addToCart(product);
        expect(qtyInCart(store)).toBe(5);
        expect(await store.addToCart(product)).toBe(false);
        expect(qtyInCart(store)).toBe(5);
        expect(window.showPosAlert).toHaveBeenCalledWith('Insufficient stock! Only {stock} remaining (you have {cartQty} in your cart).'.replace('{stock}', 0).replace('{cartQty}', 5));
    });

    it('lets a reopened saved table add up to the stock the server still holds', async () => {
        const store = useOrderSessionStore();
        reopenTable(store, 5); // server already deducted these 5; stock 5 is what remains
        for (let i = 0; i < 5; i++) expect(await store.addToCart(product)).not.toBe(false);
        expect(qtyInCart(store)).toBe(10);
        expect(await store.addToCart(product)).toBe(false);
        expect(store.getPendingQtyInCart(1)).toBe(5);
        expect(store.getQtyInCart(1)).toBe(10);
    });

    // The product grid reads the pending quantity through the cart facade when stock is on; a store-only
    // check missed that the facade never exposed it, and every stocked tile then failed to render.
    it('gives the product grid the unsaved quantity through the cart facade', async () => {
        const store = useOrderSessionStore();
        reopenTable(store, 5);
        await store.addToCart(product);
        const cart = useCart();
        expect(cart.getPendingQtyInCart(1)).toBe(1);
        expect(cart.getQtyInCart(1)).toBe(6);
    });

    it('rejects a numpad or preset increase past the remaining stock', () => {
        const store = useOrderSessionStore();
        const ui = useOrderUiStore();
        reopenTable(store, 2);
        store.cart.push({ ...product, qty: 1, cartId: 'new', discountValue: 0 });
        store.selectedCartIndex = 1;
        ui.setNumpadMode('qty');
        ui.numpadInput = '6';
        store.applyLiveNumpad();
        expect(store.cart[1].qty).toBe(1);
        expect(window.showPosToast).toHaveBeenCalledWith(expect.stringContaining('Insufficient stock'), 'error');
        ui.numpadInput = '5';
        store.applyLiveNumpad();
        expect(store.cart[1].qty).toBe(5);
        store.applyQuantityPreset(6);
        expect(store.cart[1].qty).not.toBe(6); // preset first clears to 1 (existing behaviour), then 6 is refused
        store.applyQuantityPreset(5);
        expect(store.cart[1].qty).toBe(5);
        // the saved line itself may grow only by what is left (0 now)
        store.selectedCartIndex = 0;
        ui.numpadInput = '3';
        store.applyLiveNumpad();
        expect(store.cart[0].qty).toBe(2);
    });

    it('skips the check when stock tracking is off or the product is not loaded', () => {
        const store = useOrderSessionStore();
        const ui = useOrderUiStore();
        store.cart.push({ ...product, qty: 1, cartId: 'new', discountValue: 0 });
        store.selectedCartIndex = 0;
        ui.setNumpadMode('qty');
        mocks.products.products.value = [];
        ui.numpadInput = '9';
        store.applyLiveNumpad();
        expect(store.cart[0].qty).toBe(9);
    });
});
