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
afterEach(() => vi.unstubAllGlobals());

describe('split restore to payment', () => {
    it.each(['raw server row', 'processed split card'])('preserves edited revision and tax snapshots from a %s', async kind => {
        const store = useOrderSessionStore();
        store.tableWorkspaceLoaded = true;
        store.restaurantTables = [{ id: 7, table_number: '7' }];
        const payload = { items: [line()], parent_invoice_id: 70, parent_order_id: 71, is_split: true,
            split_revision: 3, split_money_cents: { subtotal: 1000, discount: 0, tax: 0, total: 1000 }, tax_exempt_at_hold: true, tax_registration_type_at_hold: 'income_tax',
            tax_inclusive_at_sale: 1, receipt_tax_inclusive_at_hold: 1 };
        const check = { id: 80, table_id: 7, reference_name: 'Table 7 - Check 2', cart_data: JSON.stringify(payload) };
        if (kind === 'processed split card') Object.assign(check, { items: payload.items, parent_invoice_id: 70, parent_order_id: 71, split_revision: 3 });
        expect(await store.restoreTableSplit(check, { router: { push: vi.fn() } })).toBe(true);
        expect(store.activeTable.split_revision).toBe(3);
        expect(store.isTaxExempt).toBe(true);
        expect(store.taxRegistrationType).toBe('income_tax');
        await nextTick();
        setActivePinia(createPinia());
        const reloaded = useOrderSessionStore();
        reloaded.loadSavedOrder();
        await reloaded.activateTableFromStorage('pos_active_table');
        expect(reloaded.activeTable.split_revision).toBe(3);
        expect(reloaded.taxRegistrationType).toBe('income_tax');
        expect(reloaded.taxInclusivePricing).toBe(true);
        expect(reloaded.receiptTaxInclusiveDisplay).toBe(true);
        expect(reloaded.cart).toHaveLength(1);
        mocks.api.checkoutOrder.mockResolvedValue(ok({ invoice_id: 81, order_id: 82 }));
        await reloaded.processCheckout();
        expect(mocks.api.checkoutOrder.mock.calls[0][0]).toMatchObject({ split_revision: 3, split_check_id: 80, tax_exempt: true });
    });
});

describe('register draft ownership', () => {
    it.each(['success', 'failure'])('keeps a newer draft and checkout retry key after an older payment %s', async outcome => {
        const store = useOrderSessionStore();
        const ui = useOrderUiStore();
        store.cart = [line()];
        const payment = deferred();
        mocks.api.checkoutOrder.mockReturnValue(payment.promise);
        const pending = store.processCheckout();
        store.restoreHeldOrder({ items: [line(2)], customer_name: 'New customer' });
        ui.activeIdempotencyKey = 'NEW-ATTEMPT';
        storage.set('pos_checkout_attempt', 'new retry cache');
        payment.resolve(outcome === 'success' ? ok({ invoice_id: 10, order_id: 11 }) : { response: { status: 400 }, data: { success: false, message: 'Old payment declined' } });
        await pending;
        expect(store.cart.map(item => item.id)).toEqual([2]);
        expect(store.customerName).toBe('New customer');
        expect(storage.get('pos_checkout_attempt')).toBe('new retry cache');
        expect(ui.activeIdempotencyKey).toBe('NEW-ATTEMPT');
        expect(ui.checkoutError).toBe('');
    });

    it('keeps a new register draft after an older hold response', async () => {
        const store = useOrderSessionStore();
        store.cart = [line()];
        const hold = deferred();
        mocks.api.holdOrder.mockReturnValue(hold.promise);
        const pending = store.holdCurrentOrder();
        await vi.waitFor(() => expect(mocks.api.holdOrder).toHaveBeenCalledOnce());
        store.restoreHeldOrder({ items: [line(2)] });
        hold.resolve(ok({}));
        await pending;
        expect(store.cart.map(item => item.id)).toEqual([2]);
    });

    it('ignores an invoice load completed after restoring another draft', async () => {
        const store = useOrderSessionStore();
        const invoice = deferred();
        mocks.api.getOrderDetails.mockReturnValue(invoice.promise);
        const pending = store.loadOrderForEditing(10);
        store.restoreHeldOrder({ items: [line(2)], customer_name: 'New customer' });
        invoice.resolve(ok({ order: { invoice_id: 10, order_id: 11 }, items: [{ product_id: 1, price_at_sale: 10, quantity: 1 }] }));
        await pending;
        expect(store.cart.map(item => item.id)).toEqual([2]);
        expect(store.editingInvoiceId).toBe(null);
        expect(store.customerName).toBe('New customer');
    });

    it('uses the checkout held snapshot when deciding whether the kitchen was already fired', async () => {
        const store = useOrderSessionStore();
        store.restoreHeldOrder({ items: [line()], held_order_context: { id: 10, version: 1, claimToken: 'claim', kitchenFired: true } });
        const payment = deferred();
        mocks.api.checkoutOrder.mockReturnValue(payment.promise);
        const pending = store.processCheckout();
        store.restoreHeldOrder({ items: [line(2)] });
        payment.resolve(ok({ invoice_id: 10, order_id: 11 }));
        await pending;
        expect(mocks.terminal.dispatchToNodeSpooler).not.toHaveBeenCalled();
    });

    it('prints a duplicate from the completed sale while a later sale owns the receipt preview', async () => {
        const store = useOrderSessionStore();
        store.cart = [line()];
        mocks.terminal.printMethod.value = 'backend';
        mocks.terminal.duplicateCustomerReceipt.value = true;
        const printing = deferred();
        mocks.terminal.printReceipt.mockReturnValue(printing.promise);
        mocks.api.checkoutOrder.mockResolvedValue(ok({ invoice_id: 10, order_id: 11 }));
        const pending = store.processCheckout();
        await vi.waitFor(() => expect(mocks.terminal.printReceipt).toHaveBeenCalledOnce());
        mocks.terminal.lastOrder.value = { invoice_id: 20, order_id: 21, items: [line(2)] };
        printing.resolve(true);
        await pending;
        expect(mocks.terminal.dispatchToNodeSpooler).toHaveBeenLastCalledWith('receipt', expect.objectContaining({ invoice_id: 10 }), { saved: true });
    });

    it('releases the hold button after saving the current draft', async () => {
        const store = useOrderSessionStore();
        store.cart = [line()];
        mocks.api.holdOrder.mockResolvedValue(ok({}));
        expect(await store.holdCurrentOrder()).toBe(true);
        expect(store.cart).toEqual([]);
        expect(useOrderUiStore().isHolding).toBe(false);
    });

    it('releases a cleared draft busy flag without unlocking a newer pending hold', async () => {
        const store = useOrderSessionStore();
        const ui = useOrderUiStore();
        const oldHold = deferred();
        const nextHold = deferred();
        mocks.api.holdOrder.mockReturnValueOnce(oldHold.promise).mockReturnValueOnce(nextHold.promise);
        store.cart = [line()];
        const oldPending = store.holdCurrentOrder();
        await vi.waitFor(() => expect(mocks.api.holdOrder).toHaveBeenCalledTimes(1));
        await store.clearCart({ skipConfirm: true });
        expect(ui.isHolding).toBe(false);
        store.cart = [line(2)];
        const nextPending = store.holdCurrentOrder();
        await vi.waitFor(() => expect(mocks.api.holdOrder).toHaveBeenCalledTimes(2));
        oldHold.resolve(ok({}));
        await oldPending;
        expect(ui.isHolding).toBe(true);
        expect(store.cart.map(item => item.id)).toEqual([2]);
        nextHold.resolve(ok({}));
        await nextPending;
        expect(ui.isHolding).toBe(false);
        expect(store.cart).toEqual([]);
    });

    it.each([
        ['sendHeldOrderFollowUp', 'followUpHeldOrder'],
        ['confirmHeldKitchenBaseline', 'confirmHeldKitchenBaseline'],
        ['clearCart', 'cancelHeldOrder'],
    ])('preserves another draft after %s completes', async (action, api) => {
        const store = useOrderSessionStore();
        store.restoreHeldOrder({ items: [line()], held_order_context: { id: 10, version: 1, claimToken: 'claim', kitchenFired: true } });
        const operation = deferred();
        mocks.api[api].mockReturnValue(operation.promise);
        const pending = store[action]({ skipConfirm: true });
        await vi.waitFor(() => expect(mocks.api[api]).toHaveBeenCalledOnce());
        store.restoreHeldOrder({ items: [line(2)] });
        operation.resolve(ok({}));
        await pending;
        expect(store.cart.map(item => item.id)).toEqual([2]);
    });

    it('keeps another table open after the previous table void completes', async () => {
        const store = useOrderSessionStore();
        store.loadTableOrder({ id: 7, table_number: '7', status: 'occupied', current_order_id: 70 }, [{ ...line(), originalQty: 1, order_item_id: 71 }]);
        const operation = deferred();
        mocks.api.voidTableItems.mockReturnValue(operation.promise);
        const pending = store.clearCart();
        await vi.waitFor(() => expect(mocks.api.voidTableItems).toHaveBeenCalledOnce());
        store.invalidateTableSession();
        store.loadTableOrder({ id: 8, table_number: '8', status: 'available' }, [line(2)]);
        operation.resolve(ok({ table_freed: true }));
        await pending;
        expect(store.activeTable?.id).toBe(8);
        expect(store.cart.map(item => item.id)).toEqual([2]);
    });
});

describe('table exits stay inside the SPA', () => {
    it('routes a freed-table Clear and Remove through the router, not a page reload', async () => {
        for (const act of [(store, router) => store.clearCart({ router }), (store, router) => { store.selectedCartIndex = 0; return store.removeSelectedCartItem({ router }); }]) {
            setActivePinia(createPinia());
            window.location.href = '';
            const store = useOrderSessionStore();
            store.loadTableOrder({ id: 7, table_number: '7', status: 'occupied', current_order_id: 70, version: 4 }, [{ ...line(), originalQty: 1, order_item_id: 71 }]);
            mocks.api.voidTableItems.mockResolvedValue(ok({ table_freed: true }));
            const router = { push: vi.fn() };
            expect(await act(store, router)).toBe(true);
            expect(router.push).toHaveBeenCalledWith('/tables');
            expect(window.location.href).toBe('');
        }
    });
});

describe('table void revision and uncertain response recovery', () => {
    const open = () => {
        const store = useOrderSessionStore();
        store.loadTableOrder({ id: 7, table_number: '7', status: 'occupied', current_order_id: 70, version: 4 },
            [{ ...line(), originalQty: 1, order_item_id: 71 }]);
        return store;
    };
    const conflict = () => ({ response: { ok: false, status: 409 }, data: { success: false, code: 'TABLE_ORDER_VERSION_CONFLICT', message: 'Reopen the changed table.' } });
    it('binds Clear to the version captured before its confirmation opens', async () => {
        const store = open(), confirmation = deferred();
        window.showPosConfirm.mockReturnValue(confirmation.promise);
        mocks.api.voidTableItems.mockResolvedValue(conflict());
        const pending = store.clearCart();
        store.activeTable.version = 5;
        confirmation.resolve(true);
        expect(await pending).toBe(false);
        expect(mocks.api.voidTableItems).toHaveBeenCalledWith({ invoice_id: 70, intent: 'void', expected_version: 4 });
        expect(store.cart).toHaveLength(1); expect(store.activeTable.current_order_id).toBe(70);
    });
    it('preserves the selected saved row and unsaved draft when Remove conflicts', async () => {
        const store = open(); store.cart.push({ ...line(2), originalQty: 0 }); store.selectedCartIndex = 0;
        const before = JSON.parse(JSON.stringify(store.cart));
        mocks.api.voidTableItems.mockResolvedValue(conflict());
        expect(await store.removeSelectedCartItem()).toBe(false);
        expect(mocks.api.voidTableItems).toHaveBeenCalledWith({ invoice_id: 70, intent: 'void', expected_version: 4, items: [{ order_item_id: 71, qty: 1 }] });
        expect(store.cart).toEqual(before); expect(store.activeTable.version).toBe(4);
    });
    it('retains the original version after a lost reply and rejects a blind retry without clearing the draft', async () => {
        const store = open();
        mocks.api.voidTableItems.mockRejectedValueOnce(new Error('response disconnected')).mockResolvedValue(conflict());
        expect(await store.clearCart()).toBe(false);
        expect(window.showPosToast).toHaveBeenLastCalledWith(expect.stringMatching(/confirm.*Reopen/), 'error');
        expect(store.activeTable.version).toBe(4); expect(store.cart).toHaveLength(1);
        expect(await store.clearCart()).toBe(false);
        expect(mocks.api.voidTableItems.mock.calls[1][0]).toEqual(mocks.api.voidTableItems.mock.calls[0][0]);
        expect(store.cart).toHaveLength(1);
    });
});

describe('split submission ownership', () => {
    it('returns to the split board after saving edited checks', async () => {
        const store = useOrderSessionStore();
        const ui = useOrderUiStore();
        ui.splitSeats = [{ id: 2, name: 'Check 2', items: [line()] }];
        ui.splitEditContext = { splitId: 80, table: { id: 7, current_order_id: 70 }, parentTotals: { subtotal: 10, tax: 0, discount: 0, total: 10 }, expectedChecks: [{ id: 80, revision: 2 }] };
        mocks.api.updateTableSplits.mockResolvedValue(ok({}));
        mocks.api.getTableSplits.mockResolvedValue(ok({ data: [] }));
        const router = { push: vi.fn() };
        await store.confirmSplit({ router });
        expect(router.push).toHaveBeenCalledWith('/table-splits');
        // The split board reads its own list on mount.
        expect(mocks.api.getTableSplits).not.toHaveBeenCalled();
        expect(ui.isProcessing).toBe(false);
    });

    it('opens the split board after successful creation without a router argument', async () => {
        const store = useOrderSessionStore();
        const ui = useOrderUiStore();
        store.loadTableOrder({ id: 7, table_number: '7', status: 'occupied', current_order_id: 70 }, [line()]);
        store.openSplitModal();
        store.moveAllItemToSeat(ui.unassignedSplitItems[0], 0);
        mocks.api.splitTable.mockResolvedValue(ok({}));
        await store.confirmSplit();
        expect(window.location.href).toBe('/table-splits');
        expect(store.activeTable).toBe(null);
        expect(ui.isProcessing).toBe(false);
    });

    it('submits once and leaves a newer table untouched when the split completes', async () => {
        const store = useOrderSessionStore();
        const ui = useOrderUiStore();
        store.loadTableOrder({ id: 7, table_number: '7', status: 'occupied', current_order_id: 70 }, [line()]);
        store.openSplitModal();
        store.moveAllItemToSeat(ui.unassignedSplitItems[0], 0);
        const split = deferred();
        mocks.api.splitTable.mockReturnValue(split.promise);
        const router = { push: vi.fn() };
        const pending = store.confirmSplit({ router });
        const repeated = store.confirmSplit({ router });
        expect(mocks.api.splitTable).toHaveBeenCalledOnce();
        store.invalidateTableSession();
        store.loadTableOrder({ id: 8, table_number: '8', status: 'available' }, [line(2)]);
        split.resolve(ok({}));
        await Promise.all([pending, repeated]);
        expect(store.cart.map(item => item.id)).toEqual([2]);
        expect(store.activeTable.id).toBe(8);
        expect(router.push).not.toHaveBeenCalled();
    });
});
