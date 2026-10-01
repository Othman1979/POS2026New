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

import { createRequire } from 'node:module';
const { serviceChargeFee: backendFee } = createRequire(import.meta.url)('../../backend/services/ServiceChargeCalculator.js');

const modLine = { id: 1, name: 'Burger', price: 6, qty: 1, tax_rate: 16, cartId: 'm1', discountValue: 0, modifier_surcharge: 1, modifier_tax_amount: 0.137931 };
const plain = { id: 2, name: 'Tea', price: 10, qty: 1, tax_rate: 16, cartId: 'p1', discountValue: 0 };
const fee = { name: '10% Service Charge', note: 'Auto-Gratuity', price: 0, qty: 1, tax_rate: 0, product_id: null, cartId: 'fee' };

describe('income-tax effective line', () => {
    afterEach(() => { mocks.terminal.taxRegistrationType.value = 'sales_tax'; });

    it('rows, totals, typed amount and service charge agree under income tax', async () => {
        mocks.terminal.taxRegistrationType.value = 'income_tax';
        const s = useOrderSessionStore();
        s.cart = [{ ...modLine }, { ...plain }];
        expect(() => s.cartReceiptPresentation).not.toThrow();
        expect(s.cartReceiptPresentation.summary.subtotal).toBe(s.cartSubtotal);
        expect(s.getItemTotalGross(s.cart[1])).toBe(10); // typed 10 JD charges exactly 10
        expect(s.getItemTotalGross(s.cart[0]) + s.getItemTotalGross(s.cart[1])).toBe(s.cartTotal);
        s.serviceChargeSnapshot = { id: 1, version: 1, percentage: 10, taxRate: 0 };
        s.cart.push({ ...fee });
        s.updateServiceCharge();
        const expected = backendFee([modLine, plain], 10, { taxRegistrationType: 'income_tax' });
        expect(expected).toBe(1.6);
        expect(s.cart.find(i => i.note === 'Auto-Gratuity').price).toBe(expected);
    });

    it('sales-tax venues are unchanged', () => {
        const s = useOrderSessionStore();
        s.cart = [{ ...plain }];
        expect(s.getItemTotalGross(s.cart[0])).toBeCloseTo(11.6, 6);
        s.serviceChargeSnapshot = { id: 1, version: 1, percentage: 10, taxRate: 0 };
        s.cart.push({ ...fee });
        s.updateServiceCharge();
        expect(s.cart.find(i => i.note === 'Auto-Gratuity').price).toBe(backendFee([plain], 10, {}));
    });
});
