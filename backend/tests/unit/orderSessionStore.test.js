// backend/tests/unit/orderSessionStore.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createSSRApp, nextTick } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { routerKey } from 'vue-router';
import CheckoutModal from '@/components/pos/CheckoutModal.vue';

// Set up browser/DOM mock globals before importing Vue or Vue composables
const store = {};
const mockLocalStorage = {
    getItem: vi.fn(key => store[key] || null),
    setItem: vi.fn((key, value) => { store[key] = String(value); }),
    removeItem: vi.fn(key => { delete store[key]; }),
    clear: vi.fn(() => { for (const k in store) delete store[k]; })
};

global.window = {
    localStorage: mockLocalStorage,
    showPosAlert: vi.fn(),
    showPosConfirm: vi.fn(() => Promise.resolve(true)),
    showPosPrompt: vi.fn(() => Promise.resolve('')),
    showPosToast: vi.fn(),
    location: { href: '' },
    history: { replaceState: vi.fn() }
};

global.localStorage = mockLocalStorage;

global.document = {
    documentElement: { dir: 'ltr' }
};

const mockTerminalState = vi.hoisted(() => ({
  settingsLoaded: { value: true },
  ensureSettings: vi.fn().mockResolvedValue(true),
  quickNumpadMode: { value: false },
  receiptTaxInclusiveDisplay: { value: false },
  taxRegistrationType: { value: 'sales_tax' },
  lastOrder: { value: null },
  printReceipt: vi.fn().mockResolvedValue(true),
  printMethod: { value: 'frontend' },
  duplicateCustomerReceipt: { value: false },
  dispatchToNodeSpooler: vi.fn()
}));

const mockPermissionsState = vi.hoisted(() => ({
  can: vi.fn(() => true),
  hasDirect: vi.fn(() => true),
}));
const tableWorkflowActor = (permissions = [
  'tables.access',
  'tables.save',
  'waiter.edit_locked',
  'pos.void_item',
  'pos.void_printed_item',
  'pos.checkout'
]) => ({ id: 1, name: 'Cashier', role: 'cashier', permissions, table_access_scope: 'all' });
const mockAuthState = vi.hoisted(() => ({
  activeUser: { value: { id: 1, role: 'cashier', permissions: [] } },
  activeShift: { value: { id: 9 } },
  showOverrideModal: { value: false }
}));
const mockProductsState = vi.hoisted(() => ({
  products: { value: [] },
  settings: { value: {
    stock_enabled: '0',
    tables_enabled: '1',
    service_charge_enabled: '0',
    auto_apply_service_charge: '0'
  } }
}));

vi.mock('@/shared/i18n.js', () => ({ t: (k) => k }));
vi.mock('@/pos/useAuth.js', () => ({
  useAuth: () => mockAuthState,
}));
vi.mock('@/pos/useTerminal.js', () => ({
  useTerminal: () => mockTerminalState,
}));
vi.mock('@/pos/useProducts.js', () => ({
  useProducts: () => mockProductsState,
}));
vi.mock('@/pos/usePermissions.js', () => ({
  usePermissions: () => mockPermissionsState,
}));
import { useOrderSessionStore } from '@/pos/stores/orderSessionStore.js';
import { useOrderUiStore } from '@/pos/stores/orderUiStore.js';
import { useCart } from '@/pos/useCart.js';
import * as orderSessionApi from '@/pos/stores/orderSession/orderSessionApi.js';

describe('useOrderSessionStore — cash drawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockAuthState.activeUser.value = { id: 1, role: 'cashier', permissions: [] };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues the selected receipt printer without prompting the cashier for a manager PIN', async () => {
    const request = vi.spyOn(orderSessionApi, 'logDrawerPop').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, printer_id: 17 },
    });
    const ui = useOrderUiStore();
    ui.showMoreActionsModal = true;

    await expect(useOrderSessionStore().openCashDrawer('17')).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith({
      receipt_printer_id: '17',
      reason: 'No sale / Manual drawer open',
    });
    expect(window.showPosPrompt).not.toHaveBeenCalled();
    expect(ui.showMoreActionsModal).toBe(false);
  });
});


describe('useOrderSessionStore — money getters', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockProductsState.products.value = [];
    mockTerminalState.receiptTaxInclusiveDisplay.value = false;
    mockTerminalState.taxRegistrationType.value = 'sales_tax';
  });

  it('computes subtotal, tax and total (discount before tax)', () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 10, qty: 2, tax_rate: 10, discountType: null, discountValue: 0 }];
    expect(s.cartSubtotal).toBe(20);
    expect(s.cartTax).toBe(2);
    expect(s.cartTotal).toBe(22);
  });

  it('keeps product quantity lookups current after cart mutations', () => {
    const s = useOrderSessionStore();
    s.cart = [
      { id: 7, qty: 1, price: 1, tax_rate: 0 },
      { id: '7', qty: 0.5, price: 1, tax_rate: 0 },
      { id: 7, qty: 9, price: 1, tax_rate: 0, is_custom: true },
    ];

    expect(s.getQtyInCart(7)).toBe(1.5);
    expect(s.getQtyInCart(8)).toBe(0);
    s.cart[0].qty = 2.25;
    expect(s.getQtyInCart('7')).toBe(2.75);
    s.cart.splice(1, 1);
    expect(s.getQtyInCart(7)).toBe(2.25);
  });

  it('switches settlement through the checkout facade without missing actions or stale tender', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    const checkout = useCart();
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0 }];
    s.orderTypes = [{ id: 3, name: 'Platform', is_deferred_settlement: 1 }];
    s.selectedOrderType = 3;
    ui.paymentMethod = 'split';
    ui.splitCardAmount = 2;
    ui.splitCashTendered = 3;
    checkout.syncCheckoutPaymentForOrderType();
    expect(ui.paymentMethod).toBe('platform');
    expect(ui.amountTendered).toBe(0);
    expect(ui.splitCardAmount).toBeNull();
    expect(ui.splitCashTendered).toBeNull();
    checkout.selectedOrderType.value = null;
    checkout.syncCheckoutPaymentForOrderType();
    expect(ui.paymentMethod).toBe('cash');
    expect(ui.amountTendered).toBe(5);
  });

  it.each(['platform', 'clear', 'table'])('renders checkout after its actual order-type handler runs: %s', async (scenario) => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    const type = { id: 3, name: 'Platform', is_deferred_settlement: 1 };
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0 }];
    s.orderTypes = [type];
    s.selectedOrderType = scenario === 'clear' ? 3 : null;
    if (scenario === 'table') s.activeTable = { id: 7, current_order_id: 123 };
    ui.showCheckoutModal = true;
    const app = createSSRApp(CheckoutModal);
    app.provide(routerKey, { push: vi.fn() });
    app.config.globalProperties.$t = text => text;
    const warnings = [];
    app.config.warnHandler = message => warnings.push(message);
    const selected = vi.fn();
    app.mixin({ created() {
      if (typeof this.$.setupState.toggleOrderType === 'function') {
        this.$.setupState.toggleOrderType(type);
        selected();
      }
    } });
    const html = await renderToString(app);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
    expect(html).toContain('checkout-dialog');
    expect(ui.paymentMethod).toBe(scenario === 'platform' ? 'platform' : 'cash');
    if (scenario === 'platform') expect(html).toContain('Platform sales are revenue');
    expect(ui.checkoutError).toBe('');
  });

  it('opens a deferred order type as a platform payment with no tender', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.orderTypes = [{ id: 3, name: 'Talabat', is_deferred_settlement: 1 }];
    s.selectedOrderType = 3;

    s.openCheckoutModal();

    expect(ui.paymentMethod).toBe('platform');
    expect(ui.amountTendered).toBe(0);
  });

  it('refreshes stale order-type settlement and keeps the cart for an explicit retry', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.orderTypes = [{ id: 3, name: 'Talabat', is_deferred_settlement: 0 }];
    s.selectedOrderType = 3;
    s.openCheckoutModal();
    expect(ui.paymentMethod).toBe('cash');

    const checkout = vi.spyOn(orderSessionApi, 'checkoutOrder').mockResolvedValue({
      response: { ok: false, status: 409 },
      data: {
        success: false,
        code: 'ORDER_TYPE_SETTLEMENT_CHANGED',
        message: 'Order type settlement changed. Review payment and try again.',
      },
    });
    const refresh = vi.spyOn(orderSessionApi, 'getOrderTypes').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, data: [{ id: 3, name: 'Talabat', is_deferred_settlement: 1 }] },
    });

    try {
      await s.processCheckout();
      expect(checkout).toHaveBeenCalledWith(expect.objectContaining({
        order_type_id: 3,
        order_type_is_deferred_settlement: false,
        payment_method: 'cash',
      }));
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(s.cart).toHaveLength(1);
      expect(ui.paymentMethod).toBe('platform');
      expect(ui.amountTendered).toBe(0);
      expect(ui.checkoutError).toMatch(/settlement changed/i);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('clears a removed order type when live authority returns an empty list', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.orderTypes = [{ id: 3, name: 'Former Platform', is_deferred_settlement: 1 }];
    s.selectedOrderType = 3;
    s.openCheckoutModal();

    vi.spyOn(orderSessionApi, 'checkoutOrder').mockResolvedValue({
      response: { ok: false, status: 409 },
      data: {
        success: false,
        code: 'ORDER_TYPE_UNAVAILABLE',
        message: 'The selected order type is no longer available.',
      },
    });
    const refresh = vi.spyOn(orderSessionApi, 'getOrderTypes').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, data: [] },
    });

    try {
      await s.processCheckout();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(s.cart).toHaveLength(1);
      expect(s.orderTypes).toEqual([]);
      expect(s.selectedOrderType).toBe('');
      expect(ui.paymentMethod).toBe('cash');
      expect(ui.amountTendered).toBe(5);
      expect(ui.checkoutError).toMatch(/no longer available/i);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps a deferred order type on the ordinary payment path for a table checkout', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.orderTypes = [{ id: 3, name: 'Talabat', is_deferred_settlement: 1 }];
    s.selectedOrderType = 3;
    s.activeTable = { id: 7, current_order_id: 9 };

    s.openCheckoutModal();

    expect(ui.paymentMethod).toBe('cash');
    expect(ui.amountTendered).toBe(5);
  });

  it('keeps a deferred order type on the ordinary payment path while editing an invoice', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.orderTypes = [{ id: 3, name: 'Talabat', is_deferred_settlement: 1 }];
    s.selectedOrderType = 3;
    s.editingInvoiceId = 44;

    s.openCheckoutModal();

    expect(ui.paymentMethod).toBe('cash');
    expect(ui.amountTendered).toBe(5);
  });

  it('does not treat temporary manager access as table-save discount authority', () => {
    mockPermissionsState.can.mockReturnValue(true);
    mockPermissionsState.hasDirect.mockReturnValue(false);
    const s = useOrderSessionStore();

    expect(s.canApplyDiscount).toBe(true);
    s.activeTable = { id: 7, current_order_id: 9 };
    expect(s.canApplyDiscount).toBe(false);
    mockPermissionsState.hasDirect.mockReturnValue(true);
  });

  it('uses entered prices and zero sales tax for an income-tax cart', () => {
    mockTerminalState.taxRegistrationType.value = 'income_tax';
    const s = useOrderSessionStore();
    s.cart = [{ price: 12, qty: 1, tax_rate: 16, modifier_surcharge: 2, modifier_tax_amount: 0.275862, discountType: 'fixed', discountValue: 1 }];
    s.orderDiscount = { type: 'fixed', value: 1 };
    expect(s.cartSubtotal).toBe(11);
    expect(s.cartTax).toBe(0);
    expect(s.cartTotal).toBe(10);
    expect(s.cart[0].tax_rate).toBe(16);
  });

  it('applies an order-level percent discount before tax', () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 100, qty: 1, tax_rate: 10, discountType: null, discountValue: 0 }];
    s.orderDiscount = { type: 'percent', value: 10 };
    expect(s.cartOrderDiscountAmount).toBe(10);
    expect(s.cartTotal).toBe(99); // 90 + 10% tax on 90
  });

  it('caps displayed fixed order discount at the subtotal actually discounted', () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.orderDiscount = { type: 'fixed', value: 100 };
    expect(s.cartOrderDiscountAmount).toBe(5);
    expect(s.cartTotal).toBe(0);
  });

  it('preserves half-cent discount display while charging from raw values', () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 5, qty: 3, tax_rate: 16, discountType: null, discountValue: 0 }];
    s.orderDiscount = { type: 'percent', value: 0.5 };

    expect(s.cartOrderDiscountAmount).toBe(0.08);
    expect(s.cartTax).toBe(2.39);
    expect(s.cartTotal).toBe(17.31);
  });

  it('exposes a permission-gated tax-exempt state and action', () => {
    const s = useOrderSessionStore();
    expect(s.isTaxExempt).toBe(false);
    expect(s.canTaxExempt).toBe(true);
    expect(s.toggleTaxExempt()).toBe(false);
    expect(s.isTaxExempt).toBe(false);
  });

  it('keeps a new tax-exempt cart on normal net accounting regardless of receipt preference', () => {
    mockTerminalState.receiptTaxInclusiveDisplay.value = true;
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, name: 'Meal', price: 20, qty: 1, tax_rate: 16, discountType: null, discountValue: 0 }];

    expect(s.toggleTaxExempt()).toBe(true);
    expect(s.isTaxExempt).toBe(true);
    expect(s.cartSubtotal).toBe(20);
    expect(s.cartTax).toBe(0);
    expect(s.cartTotal).toBe(20);
    expect(s.cartReceiptPresentation.rows[0].unitPrice).toBe(20);

    expect(s.toggleTaxExempt()).toBe(true);
    expect(s.isTaxExempt).toBe(false);
    expect(s.cartSubtotal).toBe(20);
    expect(s.cartTotal).toBe(23.2);
  });

  it('refuses standalone note products and QR drafts before cart mutation', async () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, name: 'Burger', price: 5, qty: 1, tax_rate: 0 }];
    const noteProduct = { id: 91, name: 'Extra sauce', price: 0.2, category_is_notes: 1 };

    await expect(s.addToCart(noteProduct)).resolves.toBe(false);
    expect(s.cart).toHaveLength(1);

    s.activeQrDraft = [{ product_id: 91, qty: 1 }];
    await expect(s.importQrDraftItems([noteProduct])).resolves.toEqual({ success: false, imported: 0, reason: 'note_product' });
    expect(s.cart).toHaveLength(1);
  });

  it('keeps cashier subtotal and tax explicit when only customer receipts are inclusive', () => {
    mockTerminalState.receiptTaxInclusiveDisplay.value = true;
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, name: 'Meal', price: 10, qty: 1, tax_rate: 16, discountType: null, discountValue: 0 }];

    expect(s.cartReceiptPresentation.taxMode).toBe('exclusive');
    expect(s.cartReceiptPresentation.summary).toMatchObject({ subtotal: 10, taxAmount: 1.6, total: 11.6 });
  });

  it('shows a surcharged line at its full unit price on a tax-inclusive order', () => {
    const s = useOrderSessionStore();
    s.activeOrderTaxInclusive = true;
    s.cart = [{ id: 1, name: 'Burger', price: 5.5, qty: 1, tax_rate: 16, modifier_surcharge: 0.5, modifier_tax_amount: 0.069 }];

    expect(s.cartReceiptPresentation).toMatchObject({ rows: [{ unitPrice: 5.5 }], summary: { total: 5.5 } });
  });

  it('charges a split check the server-frozen discount instead of recomputing it', () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 7, is_split: true, split_money_cents: { subtotal: 1000, discount: 150, tax: 136, total: 986 } };
    s.cart = [{ id: 1, name: 'Share', price: 10, qty: 1, tax_rate: 16 }];

    expect(s.cartOrderDiscountAmount).toBe(1.5);
    expect(s.discountedSubtotal).toBe(8.5);
    expect(s.cartTotal).toBe(9.86);
  });

  it('restores only an explicit held exemption and clears it on a new order', () => {
    const s = useOrderSessionStore();
    s.restoreHeldOrder({ items: [{ id: 1, price: 20, qty: 1, tax_rate: 16 }], tax_exempt_at_hold: 1 });
    expect(s.isTaxExempt).toBe(true);

    s.restoreHeldOrder({ items: [{ id: 2, price: 10, qty: 1, tax_rate: 16 }], tax_exempt_at_hold: 'true' });
    expect(s.isTaxExempt).toBe(false);

    s.startNewOrder();
    expect(s.isTaxExempt).toBe(false);
  });

  it('cashShortfall tracks insufficient cash while changeDue remains display-clamped', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    ui.paymentMethod = 'cash';

    ui.amountTendered = '';
    expect(s.cashShortfall).toBe(10);
    expect(s.changeDue).toBe(0);

    ui.amountTendered = 6;
    expect(s.cashShortfall).toBe(4);
    expect(s.changeDue).toBe(0);

    ui.amountTendered = 10;
    expect(s.cashShortfall).toBe(0);

    ui.paymentMethod = 'card';
    ui.amountTendered = 0;
    expect(s.cashShortfall).toBe(0);
  });
});

describe('checkout JoFotara API ownership', () => {
  it('posts finalization and read-only status through the existing API owner', async () => {
    const previousFetch = global.fetch;
    const calls = [];
    global.fetch = vi.fn((url, options) => {
      calls.push({ url, options });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });
    await orderSessionApi.finalizeJofotaraCheckout({ idempotency_key: 'checkout-1', shift_id: 9 });
    await orderSessionApi.getJofotaraCheckoutStatus({ idempotency_key: 'checkout-1', shift_id: 9 });
    expect(calls.map(call => call.url)).toEqual(['api/pos/checkout/jofotara', 'api/pos/checkout/jofotara/status']);
    global.fetch = previousFetch;
  });
});
describe('useOrderSessionStore — intent actions', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('startNewOrder clears persistent order + transient, keeps config', () => {
    const s = useOrderSessionStore();
    s.orderTypes = [{ id: 1, name: 'Dine In' }];
    s.cart = [{ id: 1, price: 5, qty: 1 }];
    s.customerName = 'Jane';
    s.restoredHeldReference = 'REF-1';
    s.startNewOrder();
    expect(s.cart).toEqual([]);
    expect(s.customerName).toBe('');
    expect(s.restoredHeldReference).toBe('');
    expect(s.orderTypes).toHaveLength(1); // config preserved
  });

  it('restoreHeldOrder populates persistent slice and clears transient', () => {
    const s = useOrderSessionStore();
    s.restoreHeldOrder({
      items: [{ id: 2, name: 'Tea', price: 3, qty: 2 }],
      customer_name: 'Sam', customer_phone: '079', customer_address: 'Amman',
      order_type_id: 4, hash_number: 'H1', order_discount: { type: 'fixed', value: 1 },
      reference_name: 'REF-9',
    });
    expect(s.cart).toHaveLength(1);
    expect(s.customerName).toBe('Sam');
    expect(s.selectedOrderType).toBe(4);
    expect(s.hashNumber).toBe('H1');
    expect(s.restoredHeldReference).toBe('REF-9');
  });

  it('consumes a server-canonical restore marker exactly once', () => {
    const s = useOrderSessionStore();

    expect(s.consumeServerCanonicalRestore()).toBe(false);
    s.markServerCanonicalRestore();
    expect(s.consumeServerCanonicalRestore()).toBe(true);
    expect(s.consumeServerCanonicalRestore()).toBe(false);
  });

  it('reports a local-fallback restore once and never as server-canonical', () => {
    const s = useOrderSessionStore();
    s.markLocalFallbackRestore();
    expect(s.consumeRestoreSource()).toBe('local');
    expect(s.consumeRestoreSource()).toBe(null);
    s.markLocalFallbackRestore();
    expect(s.consumeServerCanonicalRestore()).toBe(false);
    expect(s.consumeRestoreSource()).toBe(null);
    s.markServerCanonicalRestore();
    expect(s.consumeRestoreSource()).toBe('server');
  });

  it('clears a stale server-canonical marker when a different order session replaces it', () => {
    const s = useOrderSessionStore();
    s.markServerCanonicalRestore();
    s.restoreHeldOrder({ items: [{ id: 2, name: 'Tea', price: 3, qty: 1 }] });
    expect(s.consumeServerCanonicalRestore()).toBe(false);
  });

  it('confirms a fired legacy baseline through the durable held-order API', async () => {
    const s = useOrderSessionStore();
    s.restoreHeldOrder({
      items: [{ id: 2, name: 'Tea', price: 3, qty: 2 }],
      customer_name: 'Sam',
      held_order_context: {
        id: 19,
        version: 4,
        claimToken: 'b'.repeat(64),
        kitchenFired: true,
        baselineUnknown: true,
      },
    });
    const confirm = vi.spyOn(orderSessionApi, 'confirmHeldKitchenBaseline').mockResolvedValue({
      response: { ok: true },
      data: { success: true },
    });

    await expect(s.confirmHeldKitchenBaseline()).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(19, expect.objectContaining({
      claim_token: 'b'.repeat(64),
      expected_version: 4,
      confirmed: true,
      cart: expect.objectContaining({ items: expect.any(Array) }),
    }));
    expect(s.restoredHeldOrder).toBeNull();
    expect(s.cart).toEqual([]);
    confirm.mockRestore();
  });

  it('reuses the same follow-up operation id after an uncertain network response', async () => {
    const s = useOrderSessionStore();
    s.restoreHeldOrder({
      items: [{ id: 2, name: 'Tea', price: 3, qty: 2 }],
      reference_name: 'Phone 17',
      held_order_context: {
        id: 17,
        version: 4,
        claimToken: 'd'.repeat(64),
        kitchenFired: true,
        baselineUnknown: false,
      },
    });
    const followUp = vi.spyOn(orderSessionApi, 'followUpHeldOrder')
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce({ response: { ok: true }, data: { success: true, version: 5 } });

    await expect(s.sendHeldOrderFollowUp()).resolves.toBe(false);
    await expect(s.sendHeldOrderFollowUp()).resolves.toBe(true);

    expect(followUp.mock.calls[0][1].operation_id).toBe(followUp.mock.calls[1][1].operation_id);
    followUp.mockRestore();
  });

  it('reuses the same follow-up operation id after an uncertain server error', async () => {
    const s = useOrderSessionStore();
    s.restoreHeldOrder({
      items: [{ id: 2, name: 'Tea', price: 3, qty: 2 }],
      reference_name: 'Phone 17',
      held_order_context: {
        id: 17,
        version: 4,
        claimToken: 'd'.repeat(64),
        kitchenFired: true,
        baselineUnknown: false,
      },
    });
    const followUp = vi.spyOn(orderSessionApi, 'followUpHeldOrder')
      .mockResolvedValueOnce({
        response: { ok: false, status: 503 },
        data: { success: false, message: 'Temporarily unavailable' },
      })
      .mockResolvedValueOnce({ response: { ok: true, status: 200 }, data: { success: true, version: 5 } });

    await expect(s.sendHeldOrderFollowUp()).resolves.toBe(false);
    await expect(s.sendHeldOrderFollowUp()).resolves.toBe(true);

    expect(followUp.mock.calls[0][1].operation_id).toBe(followUp.mock.calls[1][1].operation_id);
    followUp.mockRestore();
  });

  it('reuses the same save operation id after an uncertain server error', async () => {
    const s = useOrderSessionStore();
    s.restoreHeldOrder({
      items: [{ id: 2, name: 'Tea', price: 3, qty: 2 }],
      reference_name: 'Phone 17',
      held_order_context: {
        id: 17,
        version: 4,
        claimToken: 'd'.repeat(64),
        kitchenFired: false,
        baselineUnknown: false,
      },
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ success: false, message: 'Temporarily unavailable' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, version: 5 }),
      });

    await s.holdCurrentOrder();
    await s.holdCurrentOrder();

    const first = JSON.parse(global.fetch.mock.calls[0][1].body);
    const second = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(first.operation_id).toBe(second.operation_id);
  });

  it('loadTableOrder sets activeTable and clears restored-hold state', () => {
    const s = useOrderSessionStore();
    s.restoredHeldReference = 'X';
    s.loadTableOrder({ id: 7, table_number: '12', status: 'occupied' }, [{ id: 1, price: 5, qty: 1 }]);
    expect(s.activeTable.id).toBe(7);
    expect(s.cart).toHaveLength(1);
    expect(s.restoredHeldReference).toBe('');
  });

  it('loadTableOrder preserves public ticket display fields on activeTable', () => {
    const s = useOrderSessionStore();
    s.loadTableOrder(
      {
        id: 7,
        table_number: '12',
        status: 'occupied',
        current_order_id: 99,
        order_id: 11,
        invoice_display_no: null,
        order_display_no: '11',
        ticket_display_no: '11'
      },
      [{ id: 1, price: 5, qty: 1 }],
      99,
      11
    );

    expect(s.activeTable.current_order_id).toBe(99);
    expect(s.activeTable.order_id).toBe(11);
    expect(s.activeTable.invoice_display_no).toBeNull();
    expect(s.activeTable.order_display_no).toBe('11');
    expect(s.activeTable.ticket_display_no).toBe('11');
  });

  it('closeTable clears activeTable + order slice', () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 3 };
    s.cart = [{ id: 1, price: 5, qty: 1 }];
    s.closeTable(); // no router → window.location fallback (jsdom-free node: just sets href on global.window if present)
    expect(s.activeTable).toBe(null);
    expect(s.cart).toEqual([]);
  });

  it('finalizeCheckout resets persistent order + transient', () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 5, qty: 1 }];
    s.editingInvoiceId = 55;
    s.finalizeCheckout();
    expect(s.cart).toEqual([]);
    expect(s.editingInvoiceId).toBe(null);
  });

  it('startNewOrder clears selectedOrderType and preserves config (C3 fix)', () => {
    const s = useOrderSessionStore();
    s.orderTypes = [{ id: 1, name: 'Dine In' }];
    s.selectedOrderType = 1;
    s.cart = [{ id: 1, price: 5, qty: 1 }];
    s.customerName = 'Jane';
    s.startNewOrder();
    // order slice cleared
    expect(s.cart).toEqual([]);
    expect(s.customerName).toBe('');
    // selectedOrderType is now cleared — must not leak into next order (C3)
    expect(s.selectedOrderType).toBe('');
    // reference/config untouched
    expect(s.orderTypes).toHaveLength(1);
  });

  // A1: clearOrderSlice resets selectedOrderType (C3)
  it('clearOrderSlice resets selectedOrderType so it cannot leak into the next order', () => {
    const store = useOrderSessionStore();
    store.selectedOrderType = 5;   // e.g. "Delivery"
    store.startNewOrder();         // calls clearOrderSlice
    expect(store.selectedOrderType).toBe('');
  });
});

describe('useOrderSessionStore — call-center boundary', () => {
  const restorePhoneDraft = (s, context = {}) => {
    s.restoreHeldOrder({
      items: [{ id: 1, product_id: 1, name: 'Burger', price: 5, qty: 1, tax_rate: 16 }],
      customer_name: 'Maya',
      customer_phone: '0791234567',
      customer_address: 'Amman',
      order_type_id: 1,
      held_order_context: {
        id: 55,
        version: 3,
        claimToken: 'x'.repeat(64),
        claimExpiresAt: '2026-08-11T14:00:00.000Z',
        kitchenFired: false,
        ...context,
      },
    });
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    mockLocalStorage.clear();
    mockAuthState.activeUser.value = { id: 31, role: 'call_center', permissions: ['pos.checkout', 'tables.access'] };
    mockAuthState.activeShift.value = { id: 99 };
  });

  afterEach(() => {
    mockAuthState.activeUser.value = { id: 1, role: 'cashier', permissions: [] };
    mockAuthState.activeShift.value = { id: 9 };
    vi.restoreAllMocks();
  });

  it('clears a shared-terminal cashier draft and legacy shift before restore', () => {
    store.pos_cart = JSON.stringify([{ id: 8, qty: 1, price: 3 }]);
    store.pos_active_table = JSON.stringify({ id: 4, table_number: '4' });
    store.pos_order_context = JSON.stringify({ version: 2, scope: { kind: 'register', id: null } });
    const ui = useOrderUiStore();
    ui.showMoreActionsModal = true;
    ui.showSplitModal = true;
    ui.paymentMethod = 'card';
    const s = useOrderSessionStore();

    expect(s.initializeCallCenterSession(mockAuthState.activeUser.value)).toBe(true);
    expect(s.cart).toEqual([]);
    expect(s.callCenterSession.started).toBe(false);
    expect(mockAuthState.activeShift.value).toBeNull();
    expect(store.pos_cart).toBeUndefined();
    expect(store.pos_active_table).toBeUndefined();
    expect(ui.showMoreActionsModal).toBe(false);
    expect(ui.showSplitModal).toBe(false);
    expect(ui.paymentMethod).toBe('cash');
  });

  it('does not hydrate cashier order types into an offline call-center session', async () => {
    localStorage.setItem('pos_backup_order_types', JSON.stringify({
      data: [{ id: 9, name: 'Platform', is_deferred: 1 }],
      savedAt: Date.now(),
      role: 'cashier',
    }));
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const s = useOrderSessionStore();

    s.initializeCallCenterSession(mockAuthState.activeUser.value);
    await s.fetchOrderTypes();

    expect(s.orderTypes).toEqual([]);
    expect(s.selectedOrderType).toBe('');
  });

  it('warns about ambiguous customer records but still searches active phone orders', async () => {
    const lookup = vi.spyOn(orderSessionApi, 'getCustomerByPhone').mockResolvedValue({
      response: { ok: false, status: 409 },
      data: {
        success: false,
        code: 'CUSTOMER_PHONE_AMBIGUOUS',
        message: 'More than one customer uses this phone number. Enter the details manually.',
      },
    });
    const matches = vi.spyOn(orderSessionApi, 'findPhoneHeldOrders').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, data: [] },
    });
    const s = useOrderSessionStore();
    s.initializeCallCenterSession(mockAuthState.activeUser.value);
    s.customerPhone = '0791234567';

    await s.findCallCenterOrders();

    expect(window.showPosToast).toHaveBeenCalledWith(
      'More than one customer uses this phone number. Enter the details manually.',
      'warning',
    );
    expect(matches).toHaveBeenCalledWith('0791234567');
    lookup.mockRestore();
    matches.mockRestore();
  });

  it('finds and starts phone orders for a short customer number', async () => {
    const lookup = vi.spyOn(orderSessionApi, 'getCustomerByPhone').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, customer: null },
    });
    const matches = vi.spyOn(orderSessionApi, 'findPhoneHeldOrders').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, data: [] },
    });
    const s = useOrderSessionStore();
    s.initializeCallCenterSession(mockAuthState.activeUser.value);
    s.customerPhone = '123';

    await s.findCallCenterOrders();

    expect(matches).toHaveBeenCalledWith('123');
    expect(s.callCenterSession.error).toBe('');
    s.customerName = 'Maya';
    s.customerAddress = 'House 5';
    expect(s.startCallCenterOrder()).toBe(true);
    lookup.mockRestore();
    matches.mockRestore();
  });

  it('uses the server phone rule: separators may lead, letters never pass', async () => {
    const lookup = vi.spyOn(orderSessionApi, 'getCustomerByPhone').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, customer: null },
    });
    const matches = vi.spyOn(orderSessionApi, 'findPhoneHeldOrders').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, data: [] },
    });
    const s = useOrderSessionStore();
    s.initializeCallCenterSession(mockAuthState.activeUser.value);
    s.customerName = 'Maya';
    s.customerAddress = 'House 5';

    s.customerPhone = '(123)';
    await s.findCallCenterOrders();
    expect(matches).toHaveBeenCalledWith('(123)');
    expect(s.startCallCenterOrder()).toBe(true);

    matches.mockClear();
    s.callCenterSession = { ...s.callCenterSession, started: false };
    s.customerPhone = 'abc1';
    await s.findCallCenterOrders();
    expect(matches).not.toHaveBeenCalled();
    expect(s.startCallCenterOrder()).toBe(false);
    lookup.mockRestore();
    matches.mockRestore();
  });

  it('persists a started empty phone draft without inventing another storage key', async () => {
    const s = useOrderSessionStore();
    s.initializeCallCenterSession(mockAuthState.activeUser.value);
    s.customerPhone = '0790000000';
    s.customerName = 'Maya';
    s.customerAddress = 'Amman';

    expect(s.startCallCenterOrder()).toBe(true);
    await nextTick();

    expect(s.cart).toEqual([]);
    expect(JSON.parse(store.pos_order_context)).toMatchObject({
      scope: { kind: 'register', id: null },
      callCenter: { started: true, userId: 31, mode: 'new' },
      customerPhone: '0790000000',
    });
    expect(Object.keys(store).some(key => key.startsWith('pos_call_center_'))).toBe(false);
  });

  it('omits zero discount and service-charge authority from a new phone hold', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, id: 91, version: 1 }),
    });
    const s = useOrderSessionStore();
    s.initializeCallCenterSession(mockAuthState.activeUser.value);
    s.customerPhone = '0790000000';
    s.customerName = 'Maya';
    s.customerAddress = 'Amman';
    expect(s.startCallCenterOrder()).toBe(true);
    s.cart = [{ id: 1, product_id: 1, name: 'Meal', price: 5, qty: 1, tax_rate: 16 }];
    s.selectedOrderType = 1;

    expect(await s.sendCallCenterOrder()).toBe(true);

    const request = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(request.cart).not.toHaveProperty('order_discount');
    expect(request).not.toHaveProperty('service_charge_snapshot');
  });

  it('omits only the synthetic zero discount from a phone follow-up', async () => {
    const followUp = vi.spyOn(orderSessionApi, 'followUpHeldOrder').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, version: 5 },
    });
    const s = useOrderSessionStore();
    s.restoreHeldOrder({
      items: [{ id: 1, product_id: 1, name: 'Meal', price: 5, qty: 2, tax_rate: 16 }],
      customer_name: 'Maya',
      customer_phone: '0790000000',
      customer_address: 'Amman',
      order_type_id: 1,
      held_order_context: {
        id: 17,
        version: 4,
        claimToken: 'd'.repeat(64),
        kitchenFired: true,
        baselineUnknown: false,
      },
    });

    expect(await s.sendHeldOrderFollowUp()).toBe(true);
    expect(followUp.mock.calls[0][1].cart).not.toHaveProperty('order_discount');
    followUp.mockRestore();
  });

  it('preserves a real cashier-authored discount in a phone follow-up', async () => {
    const followUp = vi.spyOn(orderSessionApi, 'followUpHeldOrder').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, version: 5 },
    });
    const s = useOrderSessionStore();
    s.restoreHeldOrder({
      items: [{ id: 1, product_id: 1, name: 'Meal', price: 5, qty: 2, tax_rate: 16 }],
      customer_name: 'Maya',
      customer_phone: '0790000000',
      customer_address: 'Amman',
      order_type_id: 1,
      order_discount: { type: 'fixed', value: 1 },
      held_order_context: {
        id: 17,
        version: 4,
        claimToken: 'd'.repeat(64),
        kitchenFired: true,
        baselineUnknown: false,
      },
    });

    expect(await s.sendHeldOrderFollowUp()).toBe(true);
    expect(followUp.mock.calls[0][1].cart.order_discount).toEqual({ type: 'fixed', value: 1 });
    followUp.mockRestore();
  });

  it('sends an explicit zero discount for a register follow-up', async () => {
    mockAuthState.activeUser.value = { id: 1, role: 'cashier', permissions: [] };
    const followUp = vi.spyOn(orderSessionApi, 'followUpHeldOrder').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, version: 5 },
    });
    const s = useOrderSessionStore();
    s.restoreHeldOrder({
      items: [{ id: 1, product_id: 1, name: 'Meal', price: 5, qty: 2, tax_rate: 16 }],
      customer_name: 'Maya',
      customer_phone: '0790000000',
      customer_address: 'Amman',
      order_type_id: 1,
      order_discount: { type: 'percent', value: 10 },
      held_order_context: {
        id: 17,
        version: 4,
        claimToken: 'd'.repeat(64),
        kitchenFired: true,
        baselineUnknown: false,
      },
    });
    s.orderDiscount = { type: 'percent', value: 0 };

    expect(await s.sendHeldOrderFollowUp()).toBe(true);
    expect(followUp.mock.calls[0][1].cart.order_discount).toEqual({ type: 'percent', value: 0 });
    followUp.mockRestore();
  });

  it('reconnect reclaims at the stored version and keeps local cart edits', async () => {
    const s = useOrderSessionStore();
    restorePhoneDraft(s);
    s.cart.push({ id: 2, product_id: 2, name: 'Cola', price: 2, qty: 1, tax_rate: 0 });
    const claim = vi.spyOn(orderSessionApi, 'claimHeldOrder').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: {
        success: true,
        order: {},
        claim: { version: 4, claimToken: 'y'.repeat(64), claimExpiresAt: '2026-08-11T14:05:00.000Z' },
      },
    });

    // '' means re-claimed; the hold's own token lets the server replay or re-lease it.
    expect(await s.reconnectHeldOrder()).toBe('');
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({
      id: 55,
      claimToken: 'x'.repeat(64),
      expectedVersion: 3,
      customerPhone: '0791234567',
    }));
    expect(s.cart.map(item => item.name)).toEqual(['Burger', 'Cola']);
    expect(s.restoredHeldOrder).toMatchObject({
      id: 55,
      version: 4,
      claimToken: 'y'.repeat(64),
      claimExpiresAt: '2026-08-11T14:05:00.000Z',
    });
    claim.mockRestore();
  });

  it('reconnect version conflict preserves the draft and refreshes exact-phone matches', async () => {
    const s = useOrderSessionStore();
    restorePhoneDraft(s);
    s.cart.push({ id: 2, product_id: 2, name: 'Cola', price: 2, qty: 1, tax_rate: 0 });
    const claim = vi.spyOn(orderSessionApi, 'claimHeldOrder').mockResolvedValue({
      response: { ok: false, status: 409 },
      data: { success: false, code: 'HELD_VERSION_CONFLICT', message: 'changed' },
    });
    const customerLookup = vi.spyOn(orderSessionApi, 'getCustomerByPhone').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, customer: null },
    });
    const matches = vi.spyOn(orderSessionApi, 'findPhoneHeldOrders').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, data: [] },
    });

    expect(await s.reconnectHeldOrder()).toBe('This phone order changed on the server. Your draft is preserved.');
    expect(s.cart.map(item => item.name)).toEqual(['Burger', 'Cola']);
    expect(s.restoredHeldOrder.version).toBe(3);
    expect(customerLookup).toHaveBeenCalledWith('0791234567', { privateBody: true });
    expect(matches).toHaveBeenCalledWith('0791234567');
    claim.mockRestore();
    customerLookup.mockRestore();
    matches.mockRestore();
  });

  it('lost cancellation response keeps the draft when same-token claim proves the row remains', async () => {
    const s = useOrderSessionStore();
    restorePhoneDraft(s);
    const originalCart = s.cart.map(item => ({ ...item }));
    const cancel = vi.spyOn(orderSessionApi, 'cancelHeldOrder').mockRejectedValue(new TypeError('network lost'));
    const claim = vi.spyOn(orderSessionApi, 'claimHeldOrder').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: {
        success: true,
        order: {},
        claim: { version: 3, claimToken: 'x'.repeat(64), claimExpiresAt: '2026-08-11T14:10:00.000Z' },
      },
    });

    expect(await s.cancelCallCenterOrder('customer_changed_mind')).toBe(false);
    expect(claim).toHaveBeenCalledWith({
      id: 55,
      claimToken: 'x'.repeat(64),
      expectedVersion: 3,
      customerPhone: '0791234567',
    });
    expect(s.cart).toEqual(originalCart);
    expect(s.restoredHeldOrder).toMatchObject({ id: 55, version: 3, claimToken: 'x'.repeat(64) });
    cancel.mockRestore();
    claim.mockRestore();
  });

  it('lost cancellation response clears the draft only when claim returns 404', async () => {
    const s = useOrderSessionStore();
    restorePhoneDraft(s);
    const cancel = vi.spyOn(orderSessionApi, 'cancelHeldOrder').mockRejectedValue(new TypeError('network lost'));
    const claim = vi.spyOn(orderSessionApi, 'claimHeldOrder').mockResolvedValue({
      response: { ok: false, status: 404 },
      data: { success: false, code: 'CALL_CENTER_HELD_ORDER_NOT_FOUND' },
    });

    expect(await s.cancelCallCenterOrder('customer_changed_mind')).toBe(true);
    expect(s.cart).toEqual([]);
    expect(s.callCenterSession.started).toBe(false);
    expect(window.showPosToast).toHaveBeenCalledWith('Order cancelled', 'success');
    cancel.mockRestore();
    claim.mockRestore();
  });

  it('lost cancellation response with a claim conflict preserves the draft and refreshes matches', async () => {
    const s = useOrderSessionStore();
    restorePhoneDraft(s);
    const cancel = vi.spyOn(orderSessionApi, 'cancelHeldOrder').mockRejectedValue(new TypeError('network lost'));
    const claim = vi.spyOn(orderSessionApi, 'claimHeldOrder').mockResolvedValue({
      response: { ok: false, status: 409 },
      data: { success: false, code: 'HELD_IN_USE' },
    });
    vi.spyOn(orderSessionApi, 'getCustomerByPhone').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, customer: null },
    });
    const matches = vi.spyOn(orderSessionApi, 'findPhoneHeldOrders').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true, data: [] },
    });

    expect(await s.cancelCallCenterOrder('customer_changed_mind')).toBe(false);
    expect(s.cart).toHaveLength(1);
    expect(s.restoredHeldOrder).toMatchObject({ id: 55, version: 3 });
    expect(JSON.parse(store.pos_held_pending_operation)['cancel:55']).toBeTruthy();
    expect(matches).toHaveBeenCalledWith('0791234567');
    cancel.mockRestore();
    claim.mockRestore();
    matches.mockRestore();
  });
});

describe('useOrderSessionStore — cart actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockAuthState.activeUser.value = tableWorkflowActor();
    mockProductsState.settings.value = {
      stock_enabled: '0', tables_enabled: '1', service_charge_enabled: '0', auto_apply_service_charge: '0'
    };
    mockProductsState.products.value = [];
    window.showPosAlert = vi.fn();
    window.showPosToast = vi.fn();
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, snapshot: { id: 's1', percentage: 10, taxRate: 5, version: 1 } })
    }));
  });

  it('startNewOrder best-effort abandons a draft and clears local state', () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 10, qty: 1 }];
    s.serviceChargeSnapshot = { id: 's1', percentage: 10, taxRate: 5, version: 1 };

    s.startNewOrder();

    expect(global.fetch).toHaveBeenCalledWith(
      'api/pos/service_charge_snapshots/s1',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(s.cart).toEqual([]);
    expect(s.serviceChargeSnapshot).toBeNull();
    expect(localStorage.removeItem).toHaveBeenCalledWith('pos_service_charge_snapshot');
  });

  it('startNewOrder abandons a claimed snapshot with its one-time token', () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 10, qty: 1 }];
    s.serviceChargeSnapshot = { id: 's1', percentage: 10, taxRate: 5, version: 3, claimToken: 'secret' };

    s.startNewOrder();

    expect(global.fetch).toHaveBeenCalledWith(
      'api/pos/service_charge_snapshots/s1',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ version: 3, claim_token: 'secret' })
      })
    );
    expect(s.serviceChargeSnapshot).toBeNull();
  });

  it('addServiceCharge adds one FEE_ line when permitted', async () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 100, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    await s.addServiceCharge();
    const fees = s.cart.filter(i => String(i.id).startsWith('FEE_'));
    expect(fees).toHaveLength(1);
  });

  it('automatically adds one frozen service charge to a new table and keeps it last', async () => {
    mockProductsState.settings.value = {
      stock_enabled: '0', tables_enabled: '1', service_charge_enabled: '1',
      auto_apply_service_charge: '1', service_charge_percentage: '10', service_charge_tax_rate: '5'
    };
    const s = useOrderSessionStore();
    s.activeTable = { id: 7, current_order_id: null };

    s.processFinalAddToCart({ id: 1, name: 'Tea', price: 10, tax_rate: 0 }, 1, 10, '');
    await vi.waitFor(() => expect(s.cart.some(item => item.note === 'Auto-Gratuity')).toBe(true));
    s.processFinalAddToCart({ id: 2, name: 'Cake', price: 5, tax_rate: 0 }, 1, 5, '');
    await nextTick(); await nextTick();

    expect(s.cart.filter(item => item.note === 'Auto-Gratuity')).toHaveLength(1);
    expect(s.cart.at(-1).note).toBe('Auto-Gratuity');
    expect(global.fetch).toHaveBeenCalledWith('api/pos/service_charge_snapshots', expect.objectContaining({
      body: JSON.stringify({ auto_table: true, table_id: 7 })
    }));
  });

  it('does not let a table A snapshot populate table B', async () => {
    mockProductsState.settings.value = {
      stock_enabled: '0', tables_enabled: '1', service_charge_enabled: '1',
      auto_apply_service_charge: '1', service_charge_percentage: '8',
      service_charge_tax_rate: '8'
    };
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, table_number: 1, status: 'available', current_order_id: null };
    s.cart = [{ id: 1, product_id: 1, name: 'Burger', price: 10, qty: 1, tax_rate: 0 }];

    let resolveSnapshot;
    let savePosts = 0;
    global.fetch = vi.fn((url, options = {}) => {
      const target = String(url);
      if (target.includes('service_charge_snapshots')) {
        return new Promise(resolve => { resolveSnapshot = resolve; });
      }
      if (target === 'api/pos/table_order' && options.method === 'POST') {
        savePosts++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, order_id: 202, invoice_id: 202, table_id: 2, table_number: 2
        }) });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const saveA = s.updateActiveTableOrder();
    s.activeTable = { id: 2, table_number: 2, status: 'available', current_order_id: null };
    s.tableSessionSeq++;
    resolveSnapshot({ ok: true, json: () => Promise.resolve({
      success: true,
      snapshot: { id: 's81', percentage: 8, taxRate: 8, version: 1 }
    }) });
    await saveA;

    expect(s.serviceChargeSnapshot).toBeNull();
    expect(s.cart.some(item => item.note === 'Auto-Gratuity')).toBe(false);
    expect(savePosts).toBe(0);
  });

  it('deduplicates automatic snapshot creation only within the same table session', async () => {
    mockProductsState.settings.value = {
      stock_enabled: '0', tables_enabled: '1', service_charge_enabled: '1',
      auto_apply_service_charge: '1', service_charge_percentage: '8',
      service_charge_tax_rate: '8'
    };
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, table_number: 1, status: 'available', current_order_id: null };
    s.cart = [{ id: 1, product_id: 1, name: 'Burger', price: 10, qty: 1, tax_rate: 0 }];

    let snapshotPosts = 0;
    global.fetch = vi.fn((url, options = {}) => {
      const target = String(url);
      if (target.includes('service_charge_snapshots')) {
        snapshotPosts++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, snapshot: { id: 's1', percentage: 8, taxRate: 8, version: 1 }
        }) });
      }
      if (target === 'api/pos/table_order' && options.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, order_id: 101, invoice_id: 101, table_id: 1, table_number: 1
        }) });
      }
      if (target.includes('table-draft')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      }
      if (target.includes('table_order?order_id=101')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, invoice_id: 101, cart: [], order_discount_type: null,
          order_discount_value: 0
        }) });
      }
      if (target.includes('get_tables')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, sections: [], tables: [], settings: {}
        }) });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const first = s.updateActiveTableOrder();
    const second = s.updateActiveTableOrder();
    await Promise.all([first, second]);

    expect(snapshotPosts).toBe(1);
  });

  it('does not auto-add a service charge to an existing open table', async () => {
    mockProductsState.settings.value = {
      stock_enabled: '0', tables_enabled: '1', service_charge_enabled: '1', auto_apply_service_charge: '1'
    };
    const s = useOrderSessionStore();
    s.activeTable = { id: 7, current_order_id: 99 };

    s.processFinalAddToCart({ id: 1, name: 'Tea', price: 10, tax_rate: 0 }, 1, 10, '');
    await nextTick(); await nextTick();

    expect(s.cart.some(item => item.note === 'Auto-Gratuity')).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reopens a charged table with its latest snapshot before saving added items', async () => {
    const s = useOrderSessionStore();
    const postBodies = [];
    global.fetch = vi.fn((url, options = {}) => {
      const target = String(url);
      if (target.includes('table-draft')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      }
      if (target === 'api/pos/table_order?order_id=99') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true,
          invoice_id: 99,
          order_id: null,
          cart: [
            { id: 1, product_id: 1, name: 'Tea', price: 10, qty: 1, tax_rate: 0 },
            { id: 'FEE', product_id: null, name: '10% Service Charge', price: 1, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
          ],
          service_charge_snapshot: { id: 'bound-99', percentage: 10, taxRate: 5, version: 7 }
        }) });
      }
      if (target === 'api/pos/table_order' && options.method === 'POST') {
        postBodies.push(JSON.parse(options.body));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true,
          invoice_id: 99,
          table_id: 7,
          table_number: 7,
          service_charge_snapshot: { id: 'bound-99', percentage: 10, taxRate: 5, version: 8 }
        }) });
      }
      if (target.includes('get_tables')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, sections: [], tables: [], settings: {}
        }) });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    await s.loadActiveTableOrder({ id: 7, table_number: 7, status: 'occupied', current_order_id: 99 });
    s.processFinalAddToCart({ id: 2, name: 'Water', price: 2, tax_rate: 0 }, 1, 2, '');
    await s.updateActiveTableOrder();

    expect(postBodies).toHaveLength(1);
    expect(postBodies[0].service_charge_snapshot).toEqual({ id: 'bound-99', version: 7 });
  });

  it('recalculates a reopened table charge before sending newly added items', async () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 7, table_number: 7, status: 'occupied', current_order_id: 99 };
    s.serviceChargeSnapshot = { id: 'bound-99', percentage: 8, taxRate: 8, version: 7 };
    s.cart = [
      { id: 1, product_id: 1, name: 'Meal A', price: 5.092593, qty: 1, tax_rate: 8 },
      { id: 2, product_id: 2, name: 'Meal B', price: 4.398148, qty: 1, tax_rate: 8 },
      { id: 'FEE', product_id: null, name: '8% Service Charge', price: 0.76, qty: 1, tax_rate: 8, note: 'Auto-Gratuity' }
    ];
    // Simulates a product added immediately before Save, before Vue's deferred
    // cart watcher gets a chance to refresh the fee line.
    s.cart.push({ id: 3, product_id: 3, name: 'Water', price: 2, qty: 1, tax_rate: 0 });

    let sentPayload;
    global.fetch = vi.fn((url, options = {}) => {
      const target = String(url);
      if (target === 'api/pos/table_order' && options.method === 'POST') {
        sentPayload = JSON.parse(options.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true,
          invoice_id: 99,
          table_id: 7,
          table_number: 7,
          service_charge_snapshot: { id: 'bound-99', percentage: 8, taxRate: 8, version: 8 }
        }) });
      }
      if (target.includes('table-draft')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      }
      if (target === 'api/pos/table_order?order_id=99') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true,
          invoice_id: 99,
          cart: [],
          service_charge_snapshot: { id: 'bound-99', percentage: 8, taxRate: 8, version: 8 }
        }) });
      }
      if (target.includes('get_tables')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, sections: [], tables: [], settings: {}
        }) });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    await s.updateActiveTableOrder({ skipAutoServiceChargeEnsure: true });

    expect(sentPayload.cart.find(item => item.note === 'Auto-Gratuity').price).toBe(0.92);
    expect(sentPayload.subtotal).toBe(12.41);
  });

  it('does not send concurrent saves for the same table snapshot', async () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 7, table_number: 7, status: 'occupied', current_order_id: 99 };
    s.cart = [
      { id: 1, product_id: 1, name: 'Tea', price: 10, qty: 1, tax_rate: 0 },
      { id: 'FEE', product_id: null, name: '10% Service Charge', price: 1, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
    ];
    s.serviceChargeSnapshot = { id: 'bound-99', percentage: 10, taxRate: 5, version: 7 };

    let resolveSave;
    let savePosts = 0;
    global.fetch = vi.fn((url, options = {}) => {
      const target = String(url);
      if (target === 'api/pos/table_order' && options.method === 'POST') {
        savePosts++;
        return new Promise(resolve => { resolveSave = resolve; });
      }
      if (target.includes('table-draft')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      }
      if (target === 'api/pos/table_order?order_id=99') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true,
          invoice_id: 99,
          cart: [],
          service_charge_snapshot: { id: 'bound-99', percentage: 10, taxRate: 5, version: 8 }
        }) });
      }
      if (target.includes('get_tables')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, sections: [], tables: [], settings: {}
        }) });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const first = s.updateActiveTableOrder({ silent: true });
    const second = s.updateActiveTableOrder({ silent: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(savePosts).toBe(1);
    resolveSave({ ok: true, json: () => Promise.resolve({
      success: true,
      invoice_id: 99,
      table_id: 7,
      table_number: 7,
      service_charge_snapshot: { id: 'bound-99', percentage: 10, taxRate: 5, version: 8 }
    }) });

    await expect(second).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
    expect(savePosts).toBe(1);
  });

  it('allows only an admin or programmer to remove an automatic service charge', async () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 7, current_order_id: null };
    s.cart = [
      { id: 1, price: 10, qty: 1 },
      { id: 'FEE_1', price: 1, qty: 1, note: 'Auto-Gratuity' }
    ];
    s.serviceChargeSnapshot = { id: 's1', percentage: 10, taxRate: 5, version: 1 };

    expect(await s.removeAutoServiceCharge()).toBe(false);
    expect(s.cart.some(item => item.note === 'Auto-Gratuity')).toBe(true);

    mockAuthState.activeUser.value = { id: 2, role: 'admin', permissions: [] };
    expect(await s.removeAutoServiceCharge()).toBe(true);
    expect(s.cart.some(item => item.note === 'Auto-Gratuity')).toBe(false);
    expect(s.serviceChargeSnapshot).toBeNull();
  });

  it('addServiceCharge uses the canonical raw non-fee base', async () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 0.045, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    await s.addServiceCharge();

    expect(s.cart.find(i => String(i.id).startsWith('FEE_'))).toBeUndefined();
    expect(s.serviceChargeSnapshot.id).toBe('s1');
  });

  it('updateServiceCharge uses the canonical raw non-fee base', () => {
    const s = useOrderSessionStore();
    s.serviceChargeSnapshot = { id: 's1', percentage: 10, taxRate: 5, version: 1 };
    s.cart = [
      { id: 1, price: 0.045, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 },
      { id: 'FEE_1', name: '10% Service Charge', price: 1, qty: 1, tax_rate: 0, note: 'Auto-Gratuity' }
    ];

    s.updateServiceCharge();

    expect(s.cart.find(item => item.note === 'Auto-Gratuity')).toBeUndefined();
  });

  it('deduplicates concurrent snapshot creation and fee insertion', async () => {
    let resolvePost;
    global.fetch = vi.fn(() => new Promise(resolve => { resolvePost = resolve; }));
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 10, qty: 1 }];
    const first = s.addServiceCharge();
    const second = s.addServiceCharge();
    resolvePost({ ok: true, json: () => Promise.resolve({
      success: true, snapshot: { id: 's1', percentage: 10, taxRate: 5, version: 1 }
    }) });
    await Promise.all([first, second]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(s.cart.filter(item => item.note === 'Auto-Gratuity')).toHaveLength(1);
  });

  it('keeps goods unchanged when snapshot creation fails', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ success: false, message: 'Snapshot unavailable' })
    }));
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 10, qty: 1 }];
    await s.addServiceCharge();
    expect(s.cart).toEqual([{ id: 1, price: 10, qty: 1 }]);
    expect(window.showPosAlert).toHaveBeenCalledWith('Snapshot unavailable');
  });

  it('recomputes from frozen rates through the deep cart watcher without another POST', async () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 10, qty: 1, discountType: null, discountValue: 0 }];
    await s.addServiceCharge();
    expect(s.cart.find(item => item.note === 'Auto-Gratuity').price).toBe(1);

    s.cart[0].qty = 2;
    await nextTick(); await nextTick();
    expect(s.cart.find(item => item.note === 'Auto-Gratuity').price).toBe(2);
    s.cart[0].discountType = 'fixed';
    s.cart[0].discountValue = 2;
    await nextTick(); await nextTick();
    expect(s.cart.find(item => item.note === 'Auto-Gratuity').price).toBe(1.6);
    s.cart[0].discountType = 'percent';
    s.cart[0].discountValue = 50;
    await nextTick(); await nextTick();
    expect(s.cart.find(item => item.note === 'Auto-Gratuity').price).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retains the frozen snapshot after zero base and reuses it when goods return', async () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 10, qty: 1 }];
    await s.addServiceCharge();
    s.cart[0].price = 0;
    await nextTick(); await nextTick();
    expect(s.cart.find(item => item.note === 'Auto-Gratuity')).toBeUndefined();
    expect(s.serviceChargeSnapshot.id).toBe('s1');
    s.cart[0].price = 20;
    await s.addServiceCharge();
    expect(s.cart.find(item => item.note === 'Auto-Gratuity').price).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('builds an ID/version-only snapshot payload with optional claim token', () => {
    const s = useOrderSessionStore();
    s.serviceChargeSnapshot = { id: 's1', percentage: 10, taxRate: 5, version: 1 };
    expect(s.serviceChargeSnapshotPayload()).toEqual({ id: 's1', version: 1 });
    s.serviceChargeSnapshot.claimToken = 'secret';
    expect(s.serviceChargeSnapshotPayload()).toEqual({ id: 's1', version: 1, claim_token: 'secret' });
  });

  it('clears an expired draft and fee but preserves goods', async () => {
    const s = useOrderSessionStore();
    s.serviceChargeSnapshot = { id: 's1', percentage: 10, taxRate: 5, version: 1 };
    s.cart = [
      { id: 1, price: 10, qty: 1 },
      { id: 'FEE_1', price: 1, qty: 1, note: 'Auto-Gratuity' }
    ];
    window.showPosToast = vi.fn();
    await expect(s.handleServiceChargeSnapshotConflict(409, {
      code: 'SERVICE_CHARGE_SNAPSHOT_EXPIRED'
    })).resolves.toBe(true);
    expect(s.cart).toEqual([{ id: 1, price: 10, qty: 1 }]);
    expect(s.serviceChargeSnapshot).toBeNull();
    expect(window.showPosToast).toHaveBeenCalledWith(
      'Service charge expired. Add it again before checkout.', 'warning'
    );
  });

  it('treats a blank item price as zero', () => {
    const s = useOrderSessionStore();
    expect(s.getItemTotal({ price: '', qty: 2, discountType: 'fixed', discountValue: 1 })).toBe(0);
  });

  it('keeps new-cart gross row math independent from the receipt preference', () => {
    const s = useOrderSessionStore();
    mockTerminalState.receiptTaxInclusiveDisplay.value = true;

    expect(s.getItemTotalGross({ price: 10, qty: 1, tax_rate: 16 })).toBe(11.6);

    mockTerminalState.receiptTaxInclusiveDisplay.value = false;
  });

  it('processFinalAddToCart appends an item', () => {
    const s = useOrderSessionStore();
    s.cart = [];
    s.processFinalAddToCart({ id: 5, name: 'X', price: 2 }, 3, 2, '');
    expect(s.cart).toHaveLength(1);
    expect(s.cart[0].qty).toBe(3);
  });

  it('uses an armed fractional numpad quantity once and clears it after adding', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [];
    ui.numpadInput = '0.125';

    await s.addToCart({ id: 5, name: 'Weighted item', price: 2 });

    expect(s.cart[0].qty).toBe(0.125);
    expect(ui.numpadInput).toBe('');
  });

  it('rejects new additions when the catalog marks a product sold out', async () => {
    const s = useOrderSessionStore();
    mockProductsState.products.value = [{ id: 5, can_sell: 0 }];
    s.cart = [];

    await s.addToCart({ id: 5, name: 'Sold out item', price: 2, can_sell: 0 });

    expect(s.cart).toEqual([]);
    expect(window.showPosAlert).toHaveBeenCalledWith('This product is sold out.');
  });

  it('keeps an existing sold-out line but blocks increasing its quantity', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    mockProductsState.products.value = [{ id: 5, can_sell: 0 }];
    s.cart = [{ id: 5, name: 'Sold out item', price: 2, qty: 2 }];
    s.selectedCartIndex = 0;
    ui.setNumpadMode('qty');
    ui.numpadInput = '';

    s.appendNumpad('3');

    expect(s.cart[0].qty).toBe(2);
    expect(window.showPosToast).toHaveBeenCalledWith('This product is sold out. You can keep the current quantity, but cannot add more.', 'warning');
  });

  it('processFinalAddToCart carries server-authored modifier surcharge and grosses only the base', () => {
    const s = useOrderSessionStore();
    s.cart = [];

    s.processFinalAddToCart(
      { id: 5, name: 'Modifier Product', price: 5, tax_rate: 16 },
      1,
      7,
      'Size: Large (2.00 JD)',
      { modifierSurcharge: 2 }
    );

    expect(s.cart[0].modifier_surcharge).toBe(2);
    expect(s.getItemTotalGross(s.cart[0])).toBeCloseTo(7.80, 5);
    expect(s.cartTax).toBeCloseTo(0.80, 5);
    expect(s.cartTotal).toBeCloseTo(7.80, 5);
  });

  it('confirmModifiers writes modifier_surcharge so live cart totals match backend activation', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.activeModifierProduct = {
      id: 5,
      name: 'Modifier Product',
      price: 5,
      tax_rate: 16,
      parsedMods: [{
        id: 'g_size',
        name: 'Size',
        required: false,
        options: [{ id: 'o_large', name: 'Large', price: 2 }]
      }]
    };
    ui.activeModifierQty = 1;
    ui.selectedModifiers = { 0: [0] };

    await s.confirmModifiers();

    expect(s.cart).toHaveLength(1);
    expect(s.cart[0].price).toBe(7);
    expect(s.cart[0].modifier_surcharge).toBe(2);
    expect(s.cart[0].modifier_tax_amount).toBeCloseTo(0.275862, 5);
    expect(s.cartTax).toBe(1.08);
    expect(s.cartTotal).toBeCloseTo(7.80, 5);
  });

  it('uses the backend four-decimal modifier fold before computing live totals', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.activeModifierProduct = {
      id: 5,
      name: 'Modifier Product',
      price: 2.85,
      tax_rate: 5,
      parsedMods: [
        { id: 'g1', name: 'One', required: false, options: [{ id: 'o1', name: 'A', price: 4.54 }] },
        { id: 'g2', name: 'Two', required: false, options: [{ id: 'o2', name: 'B', price: 0.81 }] },
        { id: 'g3', name: 'Three', required: false, options: [{ id: 'o3', name: 'C', price: 1.68 }] }
      ]
    };
    ui.activeModifierQty = 10;
    ui.selectedModifiers = { 0: [0], 1: [0], 2: [0] };

    await s.confirmModifiers();

    expect(s.cart[0].price).toBe(9.88);
    expect(s.cart[0].modifier_surcharge).toBe(7.03);
    expect(s.cart[0].modifier_tax_amount).toBeCloseTo(0.334762, 5);
    expect(s.cartTax).toBe(4.77);
    expect(s.cartTotal).toBe(100.22);
  });

  it('drops only legacy local carts whose modifier lines lack surcharge metadata', () => {
    const s = useOrderSessionStore();
    localStorage.clear();
    s.cart = [{ id: 99, price: 1, qty: 1 }];
    window.showPosToast = vi.fn();
    localStorage.setItem('pos_cart', JSON.stringify([{
      id: 5,
      price: 7,
      qty: 1,
      tax_rate: 16,
      selectedModifiers: [{ group: 'Size', option: 'Large', price: 2 }]
    }]));

    s.loadSavedOrder();

    expect(s.cart).toEqual([]);
    expect(localStorage.getItem('pos_cart')).toBeNull();
    expect(window.showPosToast).toHaveBeenCalledWith(
      'Saved cart predates modifier tax update. Re-add its items before checkout.',
      'warning'
    );

    localStorage.setItem('pos_cart', JSON.stringify([{
      id: 5,
      price: 5,
      qty: 1,
      selectedModifiers: [{ group: 'Size', option: 'Regular', price: 0 }],
      modifier_surcharge: null
    }]));
    s.loadSavedOrder();
    expect(s.cart).toHaveLength(1);
  });
});

describe('useOrderSessionStore — table helpers', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('getSeatTotal sums a seat with a percent discount', () => {
    const s = useOrderSessionStore();
    const seat = { items: [{ price: 10, qty: 2, discountType: 'percent', discountValue: 50 }] };
    expect(s.getSeatTotal(seat)).toBe('10.00');
  });

  it('shows complementary allocated cents for fractional split seats and rows', () => {
    mockTerminalState.receiptTaxInclusiveDisplay.value = true;
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 4.75, qty: 1, tax_rate: 16 }];
    ui.unassignedSplitItems = [];
    ui.splitSeats = [
      { id: 1, name: 'Seat 1', items: [{ id: 1, price: 4.75, qty: 0.5, tax_rate: 16 }] },
      { id: 2, name: 'Seat 2', items: [{ id: 1, price: 4.75, qty: 0.5, tax_rate: 16 }] },
    ];

    expect(ui.splitSeats.map((seat) => s.getSeatTotal(seat))).toEqual(['2.76', '2.75']);
    expect(ui.splitSeats.map((seat) => s.getSplitItemTotal(seat.id, 0))).toEqual([2.76, 2.75]);
    mockTerminalState.receiptTaxInclusiveDisplay.value = false;
  });

  it('persistActiveTable writes and clears localStorage', () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, table_number: '5' };
    s.persistActiveTable();
    expect(localStorage.getItem('pos_active_table')).toContain('"id":1');
    s.activeTable = null;
    s.persistActiveTable();
    expect(localStorage.getItem('pos_active_table')).toBe(null);
  });
});

// ─── A2: loadTableOrder resets residue, restores table discount ───────────────
describe('useOrderSessionStore — A2: loadTableOrder state isolation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('loadTableOrder clears a leaked order discount (no phantom discount on a table)', () => {
    const store = useOrderSessionStore();
    store.orderDiscount = { type: 'fixed', value: 1.70 };
    store.orderNote = 'prev note';
    store.customerName = 'Prev Customer';
    store.selectedOrderType = 9;
    const table = { id: 1, table_number: '5', status: 'occupied' };
    store.loadTableOrder(table, [{ id: 10, price: 5, qty: 2, tax_rate: 8 }], 100, 200);
    expect(store.orderDiscount).toEqual({ type: 'percent', value: 0 });
    expect(store.orderNote).toBe('');
    expect(store.customerName).toBe('');
    expect(store.selectedOrderType).toBe('');
    expect(store.cart.length).toBe(1);
    expect(store.editingInvoiceId).toBe(100);
  });

  it("loadTableOrder restores the table's own persisted discount via opts", () => {
    const store = useOrderSessionStore();
    const table = { id: 1, table_number: '5', status: 'occupied' };
    store.loadTableOrder(table, [{ id: 10, price: 5, qty: 2, tax_rate: 8 }], 100, 200,
      { orderDiscount: { type: 'percent', value: 10 } });
    expect(store.orderDiscount).toEqual({ type: 'percent', value: 10 });
  });

  it('restores the frozen customer-receipt mode returned by the table API', () => {
    const store = useOrderSessionStore();
    store.loadTableOrder(
      { id: 7, table_number: '7', status: 'occupied' },
      [{ id: 10, price: 10, qty: 1, tax_rate: 16 }],
      100,
      200,
      { taxInclusiveAtSale: 0, receiptTaxInclusiveAtSale: 1 }
    );

    expect(store.activeOrderTaxInclusive).toBe(false);
    expect(store.activeOrderReceiptTaxInclusive).toBe(true);
  });

  it('loadTableOrder merges only matching table checkout context after server state', () => {
    const store = useOrderSessionStore();
    store.loadTableOrder(
      { id: 7, table_number: '5', status: 'occupied', current_order_id: 100, tax_registration_type_at_sale: 'sales_tax', tax_exempt_at_sale: 0 },
      [{ id: 10, price: 5, qty: 2, tax_rate: 8 }],
      100,
      200,
      {
        orderDiscount: { type: 'percent', value: 10 },
        serviceChargeSnapshot: { id: 5, percentage: 10, taxRate: 8, version: 1 },
        orderNote: 'Table note',
        persistedOrderSnapshot: {
          note: 'Table note',
          context: {
            version: 2,
            scope: { kind: 'table', id: '7', orderId: '100', splitCheckId: null, tableNumber: '5' },
            selectedOrderType: 4,
            hashNumber: 'TABLE-HASH',
            customerPhone: '0790000000',
            customerName: 'Table Guest',
            customerAddress: 'Amman',
            orderDate: '2026-08-01T12:30',
            restoredHeldReference: '',
            taxRegistrationType: 'income_tax',
            subscriptionPurchase: null,
          }
        }
      }
    );

    expect(store.cart[0].price).toBe(5);
    expect(store.orderDiscount).toEqual({ type: 'percent', value: 10 });
    expect(store.serviceChargeSnapshot).toEqual({ id: 5, percentage: 10, taxRate: 8, version: 1 });
    expect(store.orderNote).toBe('Table note');
    expect(store.selectedOrderType).toBe(4);
    expect(store.hashNumber).toBe('TABLE-HASH');
    expect(store.customerName).toBe('Table Guest');
    expect(store.customerPhone).toBe('0790000000');
    expect(store.customerAddress).toBe('Amman');
    expect(store.orderDate).toBe('2026-08-01T12:30');
    expect(store.taxRegistrationType).toBe('sales_tax');
    expect(store.isTaxExempt).toBe(false);
  });

  it('ignores a persisted context belonging to another table', () => {
    const store = useOrderSessionStore();
    store.loadTableOrder(
      { id: 8, table_number: '6', status: 'occupied' },
      [{ id: 10, price: 5, qty: 1, tax_rate: 8 }],
      null,
      null,
      { persistedOrderSnapshot: { context: { scope: { kind: 'table', id: '7', orderId: null, splitCheckId: null, tableNumber: '5' } } } }
    );

    expect(store.selectedOrderType).toBe('');
    expect(store.customerName).toBe('');
    expect(store.orderDate).toBe('');
  });

  it('does not merge checkout context from another split check on the same parent table', () => {
    const store = useOrderSessionStore();
    store.loadTableOrder(
      { id: 7, table_number: 'A7-2', status: 'occupied', is_split: true, split_check_id: 78 },
      [{ id: 10, price: 5, qty: 1, tax_rate: 8 }],
      null,
      null,
      {
        persistedOrderSnapshot: {
          context: {
            version: 2,
            scope: { kind: 'table', id: '7', orderId: null, splitCheckId: '77', tableNumber: 'A7-1' },
            selectedOrderType: 4,
            hashNumber: 'WRONG-SPLIT',
            customerPhone: '0790000000',
            customerName: 'Wrong Split Guest',
            customerAddress: 'Amman',
            orderDate: '2026-08-01T12:30',
          }
        }
      }
    );

    expect(store.selectedOrderType).toBe('');
    expect(store.hashNumber).toBe('');
    expect(store.customerName).toBe('');
  });

  it('merges checkout context for the exact split check only', () => {
    const store = useOrderSessionStore();
    store.loadTableOrder(
      { id: 7, table_number: 'A7-1', status: 'occupied', is_split: true, split_check_id: 77 },
      [{ id: 10, price: 5, qty: 1, tax_rate: 8 }],
      null,
      null,
      {
        persistedOrderSnapshot: {
          context: {
            version: 2,
            scope: { kind: 'table', id: '7', orderId: null, splitCheckId: '77', tableNumber: 'A7-1' },
            selectedOrderType: 4,
            hashNumber: 'EXACT-SPLIT',
            customerPhone: '',
            customerName: 'Split Guest',
            customerAddress: '',
            orderDate: '',
          }
        }
      }
    );

    expect(store.selectedOrderType).toBe(4);
    expect(store.hashNumber).toBe('EXACT-SPLIT');
    expect(store.customerName).toBe('Split Guest');
  });

  it('keeps saved-table money and tax state authoritative over the captured local snapshot', () => {
    const store = useOrderSessionStore();
    store.loadTableOrder(
      { id: 7, table_number: '7', status: 'occupied', current_order_id: 707, tax_exempt_at_sale: 0 },
      [{ id: 70, name: 'Server item', price: 8, qty: 1, originalQty: 1, tax_rate: 8 }],
      707,
      77,
      {
        orderDiscount: { type: 'percent', value: 5 },
        serviceChargeSnapshot: { id: 2, percentage: 5, taxRate: 8, version: 1 },
        taxInclusiveAtSale: 0,
        taxExemptAtSale: 0,
        taxRegistrationTypeAtSale: 'sales_tax',
        persistedOrderSnapshot: {
          cart: [{ id: 1, name: 'Local item', price: 99, qty: 9 }],
          discount: { type: 'fixed', value: 99 },
          serviceChargeSnapshot: { id: 99, percentage: 99, taxRate: 99, version: 1 },
          taxExempt: true,
          context: {
            version: 2,
            scope: { kind: 'table', id: '7', orderId: '707', splitCheckId: null, tableNumber: '7' },
            selectedOrderType: 4,
            hashNumber: 'SERVER-SAFE',
            customerPhone: '',
            customerName: 'Table Guest',
            customerAddress: '',
            orderDate: '',
          }
        }
      }
    );

    expect(store.cart.map(item => item.name)).toEqual(['Server item']);
    expect(store.orderDiscount).toEqual({ type: 'percent', value: 5 });
    expect(store.serviceChargeSnapshot).toEqual({ id: 2, percentage: 5, taxRate: 8, version: 1 });
    expect(store.isTaxExempt).toBe(false);
    expect(store.taxRegistrationType).toBe('sales_tax');
    expect(store.originalSavedItems[0].name).toBe('Server item');
    expect(store.customerName).toBe('Table Guest');
  });
});

// ─── A3: loadActiveTableOrder passes persisted discount to loadTableOrder ─────
describe('useOrderSessionStore — A3: loadActiveTableOrder restores discount', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('loadActiveTableOrder restores persisted table discount from GET response', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('table-draft')) {
        return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
      }
      // table_order GET
      return Promise.resolve({
        json: () => Promise.resolve({
          success: true,
          cart: [{ id: 10, price: 5, qty: 1, tax_rate: 8, originalQty: 1, discountValue: 0 }],
          invoice_id: 100,
          order_id: 200,
          waiter_id: 9,
          order_discount_type: 'percent',
          order_discount_value: 10
        })
      });
    });

    const store = useOrderSessionStore();
    const table = { id: 7, table_number: '3', status: 'occupied', current_order_id: 99 };
    await store.loadActiveTableOrder(table);
    expect(store.orderDiscount).toEqual({ type: 'percent', value: 10 });
    expect(store.activeTable.waiter_id).toBe(9);
  });
});

// ─── Bug #1: discount leaks after cart emptied item-by-item ───────────────────
describe('useOrderSessionStore — Bug #1: discount leak on cart empty', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('resets orderDiscount + orderNote (and clears localStorage) when last item removed via removeSelectedCartItem', () => {
    const s = useOrderSessionStore();
    localStorage.setItem('pos_order_discount', JSON.stringify({ type: 'percent', value: 50 }));
    localStorage.setItem('pos_order_note', 'VIP note');
    s.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.orderDiscount = { type: 'percent', value: 50 };
    s.orderNote = 'VIP note';
    s.selectedCartIndex = 0;
    s.removeSelectedCartItem();
    expect(s.cart).toHaveLength(0);
    expect(s.orderDiscount).toEqual({ type: 'percent', value: 0 });
    expect(s.orderNote).toBe('');
    expect(localStorage.getItem('pos_order_discount')).toBe(null);
    expect(localStorage.getItem('pos_order_note')).toBe(null);
  });

  it('does NOT reset orderDiscount when cart still has items after removal', () => {
    const s = useOrderSessionStore();
    s.cart = [
      { id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 },
      { id: 2, price: 20, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }
    ];
    s.orderDiscount = { type: 'percent', value: 50 };
    s.selectedCartIndex = 0;
    s.removeSelectedCartItem();
    expect(s.cart).toHaveLength(1);
    expect(s.orderDiscount).toEqual({ type: 'percent', value: 50 });
  });
});

// ─── A4: loadOrderForEditing resets leaked tax exemption (C4) ────────────────
// ─── A5: empty cart clears isTaxExempt (C5) ──────────────────────────────────
describe('useOrderSessionStore — A5: held-order persistence cleanup', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('holdCurrentOrder success clears pos_held_kitchen_fired from localStorage', async () => {
    localStorage.setItem('pos_held_kitchen_fired', '1');
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({ success: true })
    }));
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    await store.holdCurrentOrder();
    expect(localStorage.getItem('pos_held_kitchen_fired')).toBe(null);
  });
});

// ─── Bug #6: stale edit/exempt residue survives hold + restore ────────────────
describe('useOrderSessionStore — Bug #6: stale edit residue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('restoreHeldOrder clears editingInvoiceId, editingOrderId, and originalSavedItems', () => {
    const s = useOrderSessionStore();
    s.editingInvoiceId = 42;
    s.editingOrderId = 99;
    s.originalSavedItems = [{ id: 1 }];
    s.restoreHeldOrder({ items: [], customer_name: 'Test' });
    expect(s.editingInvoiceId).toBe(null);
    expect(s.editingOrderId).toBe(null);
    expect(s.originalSavedItems).toEqual([]);
  });

  it('holdCurrentOrder success clears editingInvoiceId, editingOrderId, and originalSavedItems', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({ success: true })
    }));
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.editingInvoiceId = 42;
    s.editingOrderId = 99;
    s.originalSavedItems = [{ id: 1 }];
    await s.holdCurrentOrder();
    expect(s.editingInvoiceId).toBe(null);
    expect(s.editingOrderId).toBe(null);
    expect(s.originalSavedItems).toEqual([]);
  });
});

// ─── B2: lastOrder uses server totals ────────────────────────────────────────
describe('useOrderSessionStore — B2: lastOrder uses server totals', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockAuthState.activeUser.value = { id: 1, role: 'cashier', permissions: [] };
    mockAuthState.activeShift.value = { id: 9 };
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockClear();
    mockTerminalState.dispatchToNodeSpooler.mockClear();
    mockTerminalState.printMethod.value = 'frontend';
    mockTerminalState.duplicateCustomerReceipt.value = false;
  });

  it('online processCheckout sets lastOrder.total from server response, not stale cart', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({
        success: true,
        invoice_id: 42,
        order_id: 1,
        subtotal: 17.15,
        tax: 1.70,
        total: 18.85,
        discount: 0,
        payment_method: 'cash',
        amount_tendered: 20.00,
        change_due: 1.15
      })
    }));
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, price: 17.15, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    await store.processCheckout({ payment_method: 'cash', amount_tendered: 20.00, change_due: 1.15 });
    expect(mockTerminalState.lastOrder.value).not.toBeNull();
    expect(mockTerminalState.lastOrder.value.total).toBe(18.85);
    expect(mockTerminalState.lastOrder.value.tax).toBe(1.70);
  });

  it('ignores duplicate checkout submissions while the first request is processing', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({
        success: true,
        invoice_id: 43,
        order_id: 2,
        invoice_number: 1001,
        invoice_display_no: '1001',
        subtotal: 5,
        tax: 0,
        total: 5,
        discount: 0,
        payment_method: 'cash',
        amount_tendered: 5,
        change_due: 0
      })
    }));
    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    store.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    ui.activeIdempotencyKey = 'TXN-double-submit';
    ui.amountTendered = 5;

    await Promise.all([store.processCheckout(), store.processCheckout()]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockTerminalState.printReceipt).toHaveBeenCalledTimes(1);
  });

  it('reuses a persisted checkout idempotency key for the same checkout attempt after reload', () => {
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    store.openCheckoutModal();
    const firstKey = useOrderUiStore().activeIdempotencyKey;
    expect(firstKey).toMatch(/^TXN-\d+-\d+$/);

    setActivePinia(createPinia());
    const reloadedStore = useOrderSessionStore();
    reloadedStore.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    reloadedStore.openCheckoutModal();

    expect(useOrderUiStore().activeIdempotencyKey).toBe(firstKey);
  });

  it('rotates the persisted checkout key when only tax exemption changes', () => {
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Zero-rated tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    store.openCheckoutModal();
    const firstKey = useOrderUiStore().activeIdempotencyKey;

    expect(store.toggleTaxExempt()).toBe(true);
    store.openCheckoutModal();

    expect(useOrderUiStore().activeIdempotencyKey).not.toBe(firstKey);
  });

  it('rotates the persisted checkout idempotency key when the cart changes', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({ success: false, message: 'stop before side effects' })
    }));
    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    store.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    store.openCheckoutModal();
    const firstKey = ui.activeIdempotencyKey;

    store.cart = [{ id: 1, name: 'Tea', price: 5, qty: 2, tax_rate: 0, discountType: null, discountValue: 0 }];
    await store.processCheckout();

    expect(ui.activeIdempotencyKey).not.toBe(firstKey);
  });

  it('does not reuse a persisted checkout key after the cashier changes', () => {
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    store.openCheckoutModal();
    const firstKey = useOrderUiStore().activeIdempotencyKey;

    mockAuthState.activeUser.value = { id: 2, role: 'cashier', permissions: [] };
    setActivePinia(createPinia());
    const nextStore = useOrderSessionStore();
    nextStore.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    nextStore.openCheckoutModal();

    expect(useOrderUiStore().activeIdempotencyKey).not.toBe(firstKey);
  });

  it('does not reuse a persisted checkout key after the active shift changes', () => {
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    store.openCheckoutModal();
    const firstKey = useOrderUiStore().activeIdempotencyKey;

    mockAuthState.activeShift.value = { id: 10 };
    setActivePinia(createPinia());
    const nextStore = useOrderSessionStore();
    nextStore.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    nextStore.openCheckoutModal();

    expect(useOrderUiStore().activeIdempotencyKey).not.toBe(firstKey);
  });

  it('does not reuse a persisted checkout key after the order note changes', () => {
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    store.orderNote = 'No sugar';
    store.openCheckoutModal();
    const firstKey = useOrderUiStore().activeIdempotencyKey;

    setActivePinia(createPinia());
    const nextStore = useOrderSessionStore();
    nextStore.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    nextStore.orderNote = 'Extra sugar';
    nextStore.openCheckoutModal();

    expect(useOrderUiStore().activeIdempotencyKey).not.toBe(firstKey);
  });

  it('stores only a hashed checkout fingerprint without raw cart or customer data', () => {
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Secret Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    store.customerName = 'Jane Sensitive';
    store.customerPhone = '0790000000';
    store.customerAddress = 'Hidden Street';

    store.openCheckoutModal();

    const raw = localStorage.getItem('pos_checkout_attempt');
    expect(raw).toContain('"key"');
    expect(raw).toContain('"fingerprint":"v2:');
    expect(raw).not.toContain('Secret Tea');
    expect(raw).not.toContain('Jane Sensitive');
    expect(raw).not.toContain('0790000000');
    expect(raw).not.toContain('Hidden Street');
  });

  it('rotates an expired persisted checkout idempotency key', () => {
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    store.openCheckoutModal();
    const firstKey = useOrderUiStore().activeIdempotencyKey;
    const cached = JSON.parse(localStorage.getItem('pos_checkout_attempt'));
    cached.savedAt = Date.now() - (13 * 60 * 60 * 1000);
    localStorage.setItem('pos_checkout_attempt', JSON.stringify(cached));

    setActivePinia(createPinia());
    const reloadedStore = useOrderSessionStore();
    reloadedStore.cart = [{ id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    reloadedStore.openCheckoutModal();

    expect(useOrderUiStore().activeIdempotencyKey).not.toBe(firstKey);
  });
});

describe('useOrderSessionStore — duplicate customer receipt on checkout', () => {
  const checkoutFetchMock = () => vi.fn(() => Promise.resolve({
    json: () => Promise.resolve({
      success: true,
      invoice_id: 77,
      order_id: 5,
      subtotal: 10,
      tax: 0,
      total: 10,
      discount: 0,
      payment_method: 'cash',
      amount_tendered: 10,
      change_due: 0
    })
  }));

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockClear();
    mockTerminalState.dispatchToNodeSpooler.mockClear();
    mockTerminalState.printMethod.value = 'frontend';
    mockTerminalState.duplicateCustomerReceipt.value = false;
  });

  it('fires one extra dispatchToNodeSpooler("receipt", ...) when backend + flag are on', async () => {
    mockTerminalState.printMethod.value = 'backend';
    mockTerminalState.duplicateCustomerReceipt.value = true;
    global.fetch = checkoutFetchMock();
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });

    const receiptCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(c => c[0] === 'receipt');
    expect(receiptCalls.length).toBe(1);
    // Each copy carries its own checkout receipt id, so the server treats both as the sale's first print.
    expect(receiptCalls[0][1]).toMatchObject({ invoice_id: 77, order_id: 5, print_request_id: 'checkout-receipt:77:duplicate' });
    expect(mockTerminalState.printReceipt).toHaveBeenCalledWith(
      { ...receiptCalls[0][1], print_request_id: 'checkout-receipt:77:primary' },
      { saved: true }
    );
    expect(mockTerminalState.printReceipt).toHaveBeenCalledTimes(1);
  });

  it('does not fire the extra dispatch when the flag is off', async () => {
    mockTerminalState.printMethod.value = 'backend';
    mockTerminalState.duplicateCustomerReceipt.value = false;
    global.fetch = checkoutFetchMock();
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });

    const receiptCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(c => c[0] === 'receipt');
    expect(receiptCalls.length).toBe(0);
  });

  it('does not fire the extra dispatch on browser print method, even if the flag is on', async () => {
    mockTerminalState.printMethod.value = 'frontend';
    mockTerminalState.duplicateCustomerReceipt.value = true;
    global.fetch = checkoutFetchMock();
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });

    const receiptCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(c => c[0] === 'receipt');
    expect(receiptCalls.length).toBe(0);
  });
});

describe('useOrderSessionStore — bounded automatic JoFotara receipt path', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockAuthState.activeUser.value = { id: 1, name: 'Cashier', role: 'cashier', permissions: [] };
    mockAuthState.activeShift.value = { id: 9 };
    mockTerminalState.printMethod.value = 'backend';
    mockTerminalState.duplicateCustomerReceipt.value = false;
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockReset();
    mockTerminalState.dispatchToNodeSpooler.mockReset().mockResolvedValue({ success: true });
  });

  it('relies on transactional server kitchen admission and queues one QR-capable primary receipt', async () => {
    const events = [];
    global.fetch = vi.fn((url) => {
      events.push(url);
      if (url === 'api/pos/checkout') return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true, invoice_id: 42, order_id: 7, invoice_number: 1001, invoice_display_no: '1001',
        subtotal: 10, tax: 0, total: 10, discount: 0, payment_method: 'cash', amount_tendered: 10, change_due: 0,
        jofotara: { required: true, status: 'pending' }
      }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true, required: true, status: 'accepted', document: { qr_text: 'official-qr' }
      }) });
    });
    mockTerminalState.dispatchToNodeSpooler.mockImplementation(async (type, payload) => {
      events.push(type);
      return { success: true };
    });
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    expect(events).not.toContain('kitchen');
    expect(events).toContain('api/pos/checkout/jofotara');
    const receiptCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(call => call[0] === 'receipt');
    expect(receiptCalls).toHaveLength(1);
    expect(receiptCalls[0][1].print_request_id).toBe('checkout-receipt:42:primary');
    expect(mockTerminalState.printReceipt).not.toHaveBeenCalled();
  });

  it('performs one bounded status read at the ten-second deadline and prints once without blocking checkout', async () => {
    vi.useFakeTimers();
    const urls = [];
    global.fetch = vi.fn((url) => {
      urls.push(url);
      if (url === 'api/pos/checkout') return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true, invoice_id: 43, order_id: 8, invoice_number: 1002, invoice_display_no: '1002',
        subtotal: 10, tax: 0, total: 10, discount: 0, payment_method: 'cash', amount_tendered: 10, change_due: 0,
        jofotara: { required: true, status: 'pending' }
      }) });
      if (url === 'api/pos/checkout/jofotara') return new Promise(() => {});
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true, required: true, status: 'unknown', document: null
      }) });
    });
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });
    expect(mockTerminalState.printReceipt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
    expect(urls.filter(url => url === 'api/pos/checkout/jofotara/status')).toHaveLength(1);
    const receipts = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(call => call[0] === 'receipt');
    expect(receipts).toHaveLength(1);
    expect(window.showPosToast).toHaveBeenCalledWith(expect.stringContaining('JoFotara'), 'warning');
    vi.useRealTimers();
  });

  it('still finalizes automatic JoFotara when browser receipt printing is selected', async () => {
    const urls = [];
    mockTerminalState.printMethod.value = 'browser';
    mockTerminalState.printReceipt.mockResolvedValue(true);
    global.fetch = vi.fn((url) => {
      urls.push(url);
      if (url === 'api/pos/checkout') return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true, invoice_id: 44, order_id: 9, invoice_number: 1003, invoice_display_no: '1003',
        subtotal: 10, tax: 0, total: 10, discount: 0, payment_method: 'cash', amount_tendered: 10, change_due: 0,
        jofotara: { required: true, status: 'pending' }
      }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true, required: true, status: 'accepted', document: { qr_text: 'official-qr' }
      }) });
    });
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    expect(mockTerminalState.printReceipt).toHaveBeenCalledTimes(1);
    expect(urls).toContain('api/pos/checkout/jofotara');
    expect(mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(call => call[0] === 'receipt')).toHaveLength(0);
  });

  it('does not send the configured duplicate after the primary receipt dispatch fails', async () => {
    mockTerminalState.duplicateCustomerReceipt.value = true;
    global.fetch = vi.fn((url) => {
      if (url === 'api/pos/checkout') return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true, invoice_id: 45, order_id: 10, invoice_number: 1004, invoice_display_no: '1004',
        subtotal: 10, tax: 0, total: 10, discount: 0, payment_method: 'cash', amount_tendered: 10, change_due: 0,
        jofotara: { required: true, status: 'pending' }
      }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true, required: true, status: 'accepted', document: { qr_text: 'official-qr' }
      }) });
    });
    mockTerminalState.dispatchToNodeSpooler.mockImplementation(async (type, payload) => {
      if (type === 'receipt' && payload.print_request_id.endsWith(':primary')) return { success: false };
      return { success: true };
    });
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    const receipts = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(call => call[0] === 'receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0][1].print_request_id).toBe('checkout-receipt:45:primary');
  });
});

describe('useOrderSessionStore — kitchen admission is server-owned', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockAuthState.activeUser.value = { id: 1, name: 'Cashier', role: 'cashier', permissions: [] };
    mockAuthState.activeShift.value = { id: 9 };
    mockTerminalState.printMethod.value = 'browser';
    mockTerminalState.duplicateCustomerReceipt.value = false;
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockReset().mockResolvedValue(true);
    mockTerminalState.dispatchToNodeSpooler.mockReset().mockResolvedValue({ success: true });
    global.fetch = vi.fn((url) => {
      if (url === 'api/pos/checkout') return Promise.resolve({ ok: true, json: () => Promise.resolve({
        success: true, invoice_id: 50, order_id: 11, invoice_number: 1010, invoice_display_no: '1010',
        subtotal: 10, tax: 0, total: 10, discount: 0, payment_method: 'cash', amount_tendered: 10, change_due: 0
      }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });
  });

  it('does not issue a second browser kitchen request after a plain checkout', async () => {
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });
    const kitchenCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(c => c[0] === 'kitchen');
    expect(kitchenCalls).toHaveLength(0);
  });

  it('does not dispatch a kitchen ticket for a table order', async () => {
    const store = useOrderSessionStore();
    store.activeTable = { id: 1, table_number: '5', status: 'occupied', current_order_id: 99 };
    store.cart = [{ id: 1, name: 'Tea', price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });
    const kitchenCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(c => c[0] === 'kitchen');
    expect(kitchenCalls).toHaveLength(0);
  });

  it('does not issue a browser kitchen request when the held order already fired', async () => {
    const store = useOrderSessionStore();
    store.restoreHeldOrder({
      items: [{ id: 1, name: 'Tea', price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }],
      held_order_context: { id: 21, version: 2, claimToken: 'c'.repeat(64), kitchenFired: true, baselineUnknown: false },
    });
    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });
    const kitchenCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(c => c[0] === 'kitchen');
    expect(kitchenCalls).toHaveLength(0);
  });
});

describe('useOrderSessionStore — guest check identity', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockReset().mockResolvedValue(true);
    mockPermissionsState.can.mockImplementation((key) => key === 'pos.checkout');
    global.requestAnimationFrame = (cb) => cb();
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({
        success: true,
        tables: [],
        sections: [],
        settings: { tables_enabled: true, table_mode: 'fixed' }
      })
    }));
  });

  it('printGuestCheck uses the table number as identity, not a ticket/order number', async () => {
    const store = useOrderSessionStore();
    store.activeTable = {
      id: 1,
      table_number: '5',
      status: 'occupied',
      current_order_id: 99,
      order_id: 11,
      order_display_no: '11',
      ticket_display_no: '11'
    };
    store.orderTypes = [{ id: 1, name: 'Dine In' }];
    store.selectedOrderType = 1;
    store.cart = [{ id: 1, name: 'Burger', price: 5, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    // printReceipt renders lastOrder while it runs; the previous sale is restored after.
    let printed = null;
    mockTerminalState.printReceipt.mockImplementation(async () => {
      printed = { ...mockTerminalState.lastOrder.value };
      return true;
    });
    await store.printGuestCheck();

    expect(mockTerminalState.printReceipt).toHaveBeenCalledTimes(1);
    expect(printed.order_id).toBeNull();
    expect(printed.order_display_no).toBeNull();
    expect(printed.ticket_display_no).toBeNull();
    expect(printed.invoice_display_no).toBeNull();
    expect(printed.table_display_no).toBe('5');
    expect(printed.table_number).toBe('5');
    expect(printed.source_invoice_id).toBe(99);
    expect(printed.order_taken_at).toBeTruthy();
    expect(mockTerminalState.lastOrder.value).toBeNull();
  });
});

describe('useOrderSessionStore - truthful guest check status', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockAuthState.activeUser.value = { id: 2, name: 'Cashier', role: 'cashier', permissions: [] };
    mockProductsState.settings.value = {
      stock_enabled: '0', tables_enabled: '1', service_charge_enabled: '0', auto_apply_service_charge: '0'
    };
    mockPermissionsState.can.mockReset();
    mockPermissionsState.can.mockImplementation(key => key === 'pos.checkout');
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockReset();
    global.requestAnimationFrame = callback => callback();
    global.window.showPosToast = vi.fn();
  });

  const seatOrder = () => ({
    id: 1,
    table_number: 1,
    status: 'occupied',
    current_order_id: 101
  });

  const addGuestItem = store => {
    store.orderTypes = [{ id: 1, name: 'Dine In' }];
    store.selectedOrderType = 1;
    store.cart = [{
      id: 1,
      product_id: 1,
      name: 'Burger',
      price: 5,
      qty: 1,
      tax_rate: 0,
      discountType: null,
      discountValue: 0
    }];
  };

  it('never marks the table printed when guest-check printing fails', async () => {
    mockTerminalState.printReceipt.mockResolvedValueOnce(false);
    const store = useOrderSessionStore();
    store.activeTable = seatOrder();
    store.restaurantTables = [{ ...store.activeTable }];
    addGuestItem(store);
    global.fetch = vi.fn();

    await expect(store.printGuestCheck()).resolves.toBe(false);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(store.activeTable.status).toBe('occupied');
  });

  it('patches the printed table group locally without a workspace request', async () => {
    mockTerminalState.printReceipt.mockResolvedValueOnce(true);
    const store = useOrderSessionStore();
    store.activeTable = seatOrder();
    store.restaurantTables = [
      { ...store.activeTable },
      { id: 2, table_number: 2, status: 'occupied', current_order_id: 101, parent_table_id: 1 }
    ];
    addGuestItem(store);
    global.fetch = vi.fn((url, options = {}) => {
      if (String(url) === 'api/pos/table_order' && options.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true,
          table_ids: [1, 2],
          status: 'printed',
          invoice_id: 101
        }) });
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });

    await expect(store.printGuestCheck()).resolves.toBe(true);

    expect(store.restaurantTables.every(table => table.status === 'printed')).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      action: 'mark_printed',
      table_id: 1,
      expected_invoice_id: 101
    });
  });

  it('keeps local table state red when mark-printed is rejected', async () => {
    mockTerminalState.printReceipt.mockResolvedValueOnce(true);
    const store = useOrderSessionStore();
    store.activeTable = seatOrder();
    store.restaurantTables = [{ ...store.activeTable }];
    addGuestItem(store);
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ success: false, code: 'TABLE_SESSION_CONFLICT' })
    });

    await expect(store.printGuestCheck()).resolves.toBe(false);

    expect(store.activeTable.status).toBe('occupied');
    expect(store.restaurantTables[0].status).toBe('occupied');
  });

  it('never marks a live table from a restored split guest check', async () => {
    mockTerminalState.printReceipt.mockResolvedValueOnce(true);
    const store = useOrderSessionStore();
    store.activeTable = {
      id: 77,
      table_number: 'Table 1 - Seat 1',
      status: 'occupied',
      current_order_id: 101,
      is_split: true,
      split_check_id: 77
    };
    addGuestItem(store);
    global.fetch = vi.fn();

    await expect(store.printGuestCheck()).resolves.toBe(true);

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('useOrderSessionStore — saved table void actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockTerminalState.lastOrder.value = null;
    global.window.location.href = '';
    global.window.showPosToast = vi.fn();
    global.window.showPosConfirm = vi.fn(() => Promise.resolve(true));
    mockPermissionsState.can.mockReset();
    mockPermissionsState.can.mockReturnValue(true);
    mockAuthState.activeUser.value = tableWorkflowActor();
  });

  afterEach(() => {
    mockPermissionsState.can.mockReset();
    mockPermissionsState.can.mockReturnValue(true);
  });

  const tableVoidFetch = ({
    refund = { success: true, table_freed: false, refund_status: 'partial' },
    cart = []
  } = {}) => vi.fn((url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('/api/pos/refunds')) {
      return Promise.resolve({
        ok: refund.success !== false,
        json: () => Promise.resolve(refund)
      });
    }
    if (requestUrl.includes('api/pos/table-draft/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, cart: [] }) });
    }
    if (requestUrl.includes('api/pos/table_order?order_id=99')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          cart,
          invoice_id: 99,
          version: 5,
          order_id: null,
          order_discount_type: null,
          order_discount_value: 0
        })
      });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${requestUrl}`));
  });

  it('removes an unsaved row locally without a request', async () => {
    global.fetch = vi.fn();
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Tea', qty: 1, price: 2 }];
    store.selectedCartIndex = 0;

    await store.removeSelectedCartItem();

    expect(store.cart).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('voids a saved red-table row immediately with its original quantity', async () => {
    mockPermissionsState.can.mockImplementation((key) => key === 'pos.void_item');
    global.fetch = tableVoidFetch({
      cart: [{ id: 11, order_item_id: 502, name: 'Fries', price: 3, qty: 1, originalQty: 1 }]
    });
    const store = useOrderSessionStore();
    store.activeTable = { id: 1, table_number: '5', status: 'occupied', current_order_id: 99, version: 4 };
    store.cart = [
      { id: 10, order_item_id: 501, name: 'Burger', price: 5, qty: 3, originalQty: 2 },
      { id: 11, order_item_id: 502, name: 'Fries', price: 3, qty: 2, originalQty: 1 },
      { id: 12, name: 'Tea', price: 2, qty: 1 }
    ];
    store.selectedCartIndex = 0;

    await store.removeSelectedCartItem();

    const refundCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/pos/refunds'));
    expect(JSON.parse(refundCall[1].body)).toEqual({
      invoice_id: 99,
      expected_version: 4,
      intent: 'void',
      items: [{ order_item_id: 501, qty: 2 }]
    });
    expect(global.window.showPosConfirm).not.toHaveBeenCalled();
    expect(store.cart.find(item => item.order_item_id === 501)).toBeUndefined();
    expect(store.cart.find(item => item.order_item_id === 502).qty).toBe(2);
    expect(store.cart.find(item => item.id === 12).qty).toBe(1);
  });

  it('requires the printed-void permission on a blue table', async () => {
    mockPermissionsState.can.mockImplementation((key) => key === 'pos.void_item');
    mockAuthState.activeUser.value = tableWorkflowActor(['tables.access', 'pos.void_item']);
    global.fetch = vi.fn();
    const store = useOrderSessionStore();
    store.activeTable = { id: 1, table_number: '5', status: 'printed', current_order_id: 99, version: 4 };
    store.cart = [{ id: 10, order_item_id: 501, name: 'Burger', price: 5, qty: 1, originalQty: 1 }];
    store.selectedCartIndex = 0;

    await store.removeSelectedCartItem();

    expect(store.cart).toHaveLength(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(global.window.showPosToast).toHaveBeenCalledWith(
      'You do not have permission to void saved items.',
      'error'
    );
  });

  it('keeps the cart untouched when the void request fails', async () => {
    global.fetch = tableVoidFetch({ refund: { success: false, message: 'Void denied' } });
    const store = useOrderSessionStore();
    store.activeTable = { id: 1, table_number: '5', status: 'occupied', current_order_id: 99, version: 4 };
    store.cart = [
      { id: 10, order_item_id: 501, name: 'Burger', price: 5, qty: 1, originalQty: 1 },
      { id: 12, name: 'Tea', price: 2, qty: 1 }
    ];
    store.selectedCartIndex = 0;

    await store.removeSelectedCartItem();

    expect(store.cart).toHaveLength(2);
    expect(store.selectedCartIndex).toBe(0);
    expect(global.window.showPosToast).toHaveBeenCalledWith('Void denied', 'error');
  });

  it('frees the table when its final saved row is removed', async () => {
    global.fetch = tableVoidFetch({ refund: { success: true, table_freed: true, refund_status: 'full' } });
    const store = useOrderSessionStore();
    store.activeTable = { id: 1, table_number: '5', status: 'occupied', current_order_id: 99, version: 4 };
    store.cart = [{ id: 10, order_item_id: 501, name: 'Burger', price: 5, qty: 1, originalQty: 1 }];
    store.selectedCartIndex = 0;

    await store.removeSelectedCartItem();

    expect(store.activeTable).toBeNull();
    expect(store.cart).toEqual([]);
    expect(global.window.location.href).toBe('/tables');
  });

  it('clears a saved table through a confirmed whole-order void', async () => {
    mockPermissionsState.can.mockImplementation((key) => key === 'pos.void_item');
    global.fetch = tableVoidFetch({ refund: { success: true, table_freed: true, refund_status: 'full' } });
    const store = useOrderSessionStore();
    store.activeTable = { id: 1, table_number: '5', status: 'occupied', current_order_id: 99, version: 4 };
    store.cart = [
      { id: 10, order_item_id: 501, name: 'Burger', price: 5, qty: 1, originalQty: 1 },
      { id: 12, name: 'Tea', price: 2, qty: 1 }
    ];

    await store.clearCart();

    expect(global.window.showPosConfirm).toHaveBeenCalledWith(
      'Clear Table 5? This will cancel all saved items.'
    );
    const refundCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/pos/refunds'));
    expect(JSON.parse(refundCall[1].body)).toEqual({ invoice_id: 99, expected_version: 4, intent: 'void' });
    expect(store.activeTable).toBeNull();
    expect(store.cart).toEqual([]);
  });

  it('keeps a saved table unchanged when clear is cancelled', async () => {
    global.window.showPosConfirm.mockResolvedValue(false);
    global.fetch = vi.fn();
    const store = useOrderSessionStore();
    store.activeTable = { id: 1, table_number: '5', status: 'occupied', current_order_id: 99, version: 4 };
    store.cart = [{ id: 10, order_item_id: 501, name: 'Burger', price: 5, qty: 1, originalQty: 1 }];

    await store.clearCart();

    expect(store.cart).toHaveLength(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('clears the active table/cart if partial-void resync fails after commit', async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).includes('/api/pos/refunds')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, table_freed: false, refund_status: 'partial' })
        });
      }
      if (String(url).includes('api/pos/table_order')) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ success: false, message: 'temporary resync failure' })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });

    const store = useOrderSessionStore();
    store.activeTable = { id: 1, table_number: '5', status: 'occupied', current_order_id: 99, version: 4 };
    store.cart = [{ id: 1, order_item_id: 10, name: 'Burger', price: 5, qty: 2, originalQty: 2, tax_rate: 0 }];
    store.selectedCartIndex = 0;
    localStorage.setItem('pos_active_table', JSON.stringify(store.activeTable));
    localStorage.setItem('pos_cart', JSON.stringify(store.cart));

    await store.removeSelectedCartItem();

    expect(store.activeTable).toBeNull();
    expect(store.cart).toEqual([]);
    expect(localStorage.getItem('pos_active_table')).toBeNull();
    expect(localStorage.getItem('pos_cart')).toBeNull();
    expect(global.window.location.href).toBe('/tables');
  });
});

describe('useOrderSessionStore - table save metadata resync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockAuthState.activeUser.value = tableWorkflowActor();
  });

  it('reloads the saved table rows after save so cart lines carry DB metadata', async () => {
    mockPermissionsState.can.mockReturnValue(true);
    global.window.setTimeout = vi.fn((fn) => fn());
    global.fetch = vi.fn((url, options = {}) => {
      const u = String(url);
      if (u === 'api/pos/table_order' && options.method === 'POST') {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            order_id: 99,
            invoice_id: 99,
            table_id: 7,
            table_number: '3',
            invoice_display_no: null,
            order_display_no: null,
            ticket_display_no: null,
            table_display_no: '3'
          })
        });
      }
      if (u.includes('table-draft')) {
        return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
      }
      if (u.includes('api/pos/table_order?order_id=99')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            cart: [{
              id: 10,
              name: 'Saved burger',
              price: 5,
              qty: 2,
              originalQty: 2,
              tax_rate: 8,
              discountValue: 0,
              order_item_id: 501
            }],
            invoice_id: 99,
            order_id: null,
            invoice_display_no: null,
            order_display_no: null,
            ticket_display_no: null,
            table_display_no: '3',
            order_discount_type: null,
            order_discount_value: 0
          })
        });
      }
      if (u.includes('api/pos/get_tables')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            settings: { tables_enabled: true, table_mode: 'fixed' },
            sections: [],
            tables: [{ id: 7, table_number: '3', status: 'occupied', current_order_id: 99 }]
          })
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${u}`));
    });

    const store = useOrderSessionStore();
    store.activeTable = { id: 7, table_number: '3', status: 'available', current_order_id: null };
    store.orderTypes = [{ id: 4, name: 'Delivery', is_active: 1 }];
    store.selectedOrderType = 4;
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 2, tax_rate: 8 }];

    const saved = await store.updateActiveTableOrder();

    expect(saved).toBe(true);
    const [, saveOptions] = global.fetch.mock.calls.find(([url, options]) => url === 'api/pos/table_order' && options?.method === 'POST');
    expect(JSON.parse(saveOptions.body).order_type_id).toBe(4);
    expect(store.selectedOrderType).toBe(4);
    expect(store.activeTable.order_type_id).toBe(4);
    expect(store.cart).toHaveLength(1);
    expect(store.cart[0].order_item_id).toBe(501);
    expect(store.cart[0].originalQty).toBe(2);
    expect(store.originalSavedItems[0].order_item_id).toBe(501);
    expect(store.activeTable.current_order_id).toBe(99);
    expect(store.activeTable.order_id).toBeNull();
    expect(store.activeTable.order_display_no).toBeNull();
    expect(store.activeTable.ticket_display_no).toBeNull();
    expect(store.activeTable.table_display_no).toBe('3');
  });

  it('saves a saved-item reduction without showing the void reason prompt', async () => {
    mockPermissionsState.can.mockReturnValue(true);
    global.window.showPosPrompt = vi.fn(() => Promise.resolve('should-not-be-used'));
    global.window.setTimeout = vi.fn((fn) => fn());
    let postedPayload = null;

    global.fetch = vi.fn((url, options = {}) => {
      const u = String(url);
      if (u === 'api/pos/table_order' && options.method === 'POST') {
        postedPayload = JSON.parse(options.body);
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            order_id: 99,
            invoice_id: 99,
            table_id: 7,
            table_number: '3'
          })
        });
      }
      if (u.includes('table-draft')) {
        return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
      }
      if (u.includes('api/pos/table_order?order_id=99')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            cart: [{
              id: 10,
              name: 'Saved burger',
              price: 5,
              qty: 1,
              originalQty: 1,
              tax_rate: 8,
              discountValue: 0,
              order_item_id: 501
            }],
            invoice_id: 99,
            order_id: null,
            order_discount_type: null,
            order_discount_value: 0
          })
        });
      }
      if (u.includes('api/pos/get_tables')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            settings: { tables_enabled: true, table_mode: 'fixed' },
            sections: [],
            tables: [{ id: 7, table_number: '3', status: 'occupied', current_order_id: 99 }]
          })
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${u}`));
    });

    const store = useOrderSessionStore();
    store.activeTable = { id: 7, table_number: '3', status: 'occupied', current_order_id: 99 };
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 1, tax_rate: 8, originalQty: 1 }];
    store.originalSavedItems = [{ id: 10, name: 'Burger', price: 5, qty: 2, tax_rate: 8, originalQty: 2 }];

    const saved = await store.updateActiveTableOrder();

    expect(saved).toBe(true);
    expect(global.window.showPosPrompt).not.toHaveBeenCalled();
    expect(postedPayload.void_reason).toBeNull();
  });
});

describe('active-table split authorization', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockAuthState.activeUser.value = { id: 3, role: 'waiter', permissions: [] };
  });

  afterEach(() => {
    mockPermissionsState.can.mockReset();
    mockPermissionsState.can.mockReturnValue(true);
  });

  it('allows a waiter with split permission on their own red table', () => {
    mockPermissionsState.can.mockImplementation((key) => key === 'pos.split_checks');
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, status: 'occupied', current_order_id: 10, waiter_id: 3 };

    expect(s.canSplitActiveTable).toBe(true);
  });

  it('requires override permission for another waiter\'s red table', () => {
    mockPermissionsState.can.mockImplementation((key) => key === 'pos.split_checks');
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, status: 'occupied', current_order_id: 10, waiter_id: 9 };
    expect(s.canSplitActiveTable).toBe(false);

    mockPermissionsState.can.mockImplementation((key) => (
      key === 'pos.split_checks' || key === 'waiter.override_tables'
    ));
    s.activeTable = { ...s.activeTable };
    expect(s.canSplitActiveTable).toBe(true);
  });

  it('blocks a waiter from a blue table even with split and override permissions', () => {
    mockPermissionsState.can.mockReturnValue(true);
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, status: 'printed', current_order_id: 10, waiter_id: 3 };

    expect(s.canSplitActiveTable).toBe(false);
  });

  it('allows an admin to split a blue table', () => {
    mockAuthState.activeUser.value = { id: 1, role: 'admin', permissions: [] };
    mockPermissionsState.can.mockReturnValue(false);
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, status: 'printed', current_order_id: 10, waiter_id: 3 };

    expect(s.canSplitActiveTable).toBe(true);
  });

  it('preserves the waiter owner when loading a table order', () => {
    const s = useOrderSessionStore();
    s.loadTableOrder(
      { id: 1, status: 'occupied', current_order_id: 10, waiter_id: 3 },
      [{ id: 2, price: 2, qty: 1 }]
    );

    expect(s.activeTable.waiter_id).toBe(3);
  });
});

describe('saved-line quantity rules', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    global.window.showPosToast = vi.fn();
    mockAuthState.activeUser.value = tableWorkflowActor(['tables.access', 'waiter.edit_locked']);
    mockProductsState.products.value = [];
    mockProductsState.settings.value = { stock_enabled: '0', tables_enabled: '1' };
  });
  afterEach(() => {
    mockPermissionsState.can.mockReset();
    mockPermissionsState.can.mockReturnValue(true);
  });

  it('allows increasing a saved line with edit access', () => {
    mockPermissionsState.can.mockImplementation((key) => ['tables.access', 'waiter.edit_locked'].includes(key));
    const store = useOrderSessionStore();
    store.activeTable = { id: 7, status: 'occupied', current_order_id: 99 };
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 1, originalQty: 1 }];
    store.selectedCartIndex = 0;
    const ui = useOrderUiStore();
    ui.numpadMode = 'qty';
    ui.numpadInput = '2';

    store.applyLiveNumpad();

    expect(store.cart[0].qty).toBe(2);
    expect(global.window.showPosToast).not.toHaveBeenCalled();
  });

  it('blocks decreasing a saved line even with all permissions', () => {
    mockPermissionsState.can.mockReturnValue(true);
    const store = useOrderSessionStore();
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 3, originalQty: 3 }];
    store.selectedCartIndex = 0;
    const ui = useOrderUiStore();
    ui.numpadMode = 'qty';
    ui.numpadInput = '2';

    store.applyLiveNumpad();

    expect(store.cart[0].qty).toBe(3);
    expect(global.window.showPosToast).toHaveBeenCalledWith(
      'Use Remove to remove a saved item.',
      'error'
    );
  });
});

describe('clearCart and store resets (C1 + H9)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('clearCart clears customer, order type, delivery date, and saved items', async () => {
    const store = useOrderSessionStore();
    store.customerName = 'Jane'; store.customerPhone = '0790000000'; store.customerAddress = 'Amman';
    store.selectedOrderType = 'delivery'; store.orderDate = '2026-07-01';
    store.originalSavedItems = [{ id: 1 }];
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 2 }];

    await store.clearCart({ skipConfirm: true });

    expect(store.customerName).toBe('');
    expect(store.customerPhone).toBe('');
    expect(store.customerAddress).toBe('');
    expect(store.selectedOrderType).toBe('');
    expect(store.orderDate).toBeFalsy();
    expect(store.originalSavedItems).toEqual([]);
    expect(store.cart).toEqual([]);
  });

  it('cancels a recalled held order on the server before clearing its local cart', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, canceled: true }),
    }));
    const store = useOrderSessionStore();
    store.restoreHeldOrder({
      items: [{ id: 10, name: 'Burger', price: 5, qty: 1 }],
      held_order_context: {
        id: 17,
        version: 3,
        claimToken: 'a'.repeat(64),
        kitchenFired: false,
      },
    });

    const cleared = await store.clearCart();

    expect(cleared).toBe(true);
    expect(global.window.showPosConfirm).toHaveBeenCalledWith(
      'Cancel this suspended order? This cannot be undone.'
    );
    const cancelCall = global.fetch.mock.calls.find(([url]) => String(url).includes('api/pos/held_orders/17'));
    expect(cancelCall[1].method).toBe('DELETE');
    expect(JSON.parse(cancelCall[1].body)).toMatchObject({
      claim_token: 'a'.repeat(64),
      expected_version: 3,
      reason_code: 'customer_changed_mind',
      confirmed: true,
    });
    expect(store.cart).toEqual([]);
    expect(store.restoredHeldOrder).toBeNull();
  });
});

describe('lookupCustomer race guard and null tolerance (Task C1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('lookupCustomer ignores a response for a phone that changed during the await', async () => {
    let resolveFetch;
    const fetchPromise = new Promise(resolve => {
      resolveFetch = resolve;
    });

    global.fetch = vi.fn(() => fetchPromise.then(() => ({
      json: () => Promise.resolve({
        success: true,
        customer: { name: 'A-Name', address: 'A-Addr' }
      })
    })));

    const store = useOrderSessionStore();
    store.customerPhone = '07900000001';

    const p = store.lookupCustomer();
    store.customerPhone = '07900000002'; // user typed a new phone mid-flight

    resolveFetch();
    await p;

    expect(store.customerName).not.toBe('A-Name');
  });

  it('lookupCustomer clears the loading flag even if the phone is shortened mid-request', async () => {
    let resolveFetch;
    const fetchPromise = new Promise(resolve => { resolveFetch = resolve; });
    global.fetch = vi.fn(() => fetchPromise.then(() => ({
      json: () => Promise.resolve({ success: true, customer: { name: 'A', address: 'B' } })
    })));

    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    store.customerPhone = '07900000001';

    const p = store.lookupCustomer();
    store.customerPhone = '079'; // changed mid-request; this response must not fill the form

    resolveFetch();
    await p;

    expect(ui.isCustomerLoading).toBe(false);
  });
});

describe('lookupCustomer accepts any number', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('finds a returning customer by a short number and skips a field with no digits', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({ success: true, customer: { name: 'Short', address: 'House 5' } })
    }));
    const store = useOrderSessionStore();
    store.customerPhone = '123';
    await store.lookupCustomer();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(store.customerName).toBe('Short');

    global.fetch.mockClear();
    store.customerPhone = ' - ';
    await store.lookupCustomer();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('saveDiscount clamping (Task C2)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('clamps order-level percent discount between 0 and 100', () => {
    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    
    // Test upper bound
    ui.modalTarget = 'order';
    ui.tempDiscount = { type: 'percent', value: 150 };
    store.saveDiscount();
    expect(store.orderDiscount.value).toBe(100);

    // Test lower bound
    ui.modalTarget = 'order';
    ui.tempDiscount = { type: 'percent', value: -10 };
    store.saveDiscount();
    expect(store.orderDiscount.value).toBe(0);
  });

  it('clamps order-level fixed discount between 0 and rawSubtotal', () => {
    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    store.cart = [{ id: 1, price: 50, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    // Test upper bound
    ui.modalTarget = 'order';
    ui.tempDiscount = { type: 'fixed', value: 75 };
    store.saveDiscount();
    expect(store.orderDiscount.value).toBe(50); // rawSubtotal is 50

    // Test lower bound
    ui.modalTarget = 'order';
    ui.tempDiscount = { type: 'fixed', value: -5 };
    store.saveDiscount();
    expect(store.orderDiscount.value).toBe(0);
  });

  it('clamps item-level percent discount between 0 and 100', () => {
    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    store.cart = [{ id: 1, price: 50, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    store.selectedCartIndex = 0;

    // Test upper bound
    ui.modalTarget = 'item';
    ui.tempDiscount = { type: 'percent', value: 120 };
    store.saveDiscount();
    expect(store.cart[0].discountValue).toBe(100);

    // Test lower bound
    ui.modalTarget = 'item';
    ui.tempDiscount = { type: 'percent', value: -20 };
    store.saveDiscount();
    expect(store.cart[0].discountValue).toBe(0);
  });

  it('clamps item-level fixed discount between 0 and item price', () => {
    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    store.cart = [{ id: 1, price: 50, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    store.selectedCartIndex = 0;

    // Test upper bound
    ui.modalTarget = 'item';
    ui.tempDiscount = { type: 'fixed', value: 60 };
    store.saveDiscount();
    expect(store.cart[0].discountValue).toBe(50); // item price is 50

    // Test lower bound
    ui.modalTarget = 'item';
    ui.tempDiscount = { type: 'fixed', value: -10 };
    store.saveDiscount();
    expect(store.cart[0].discountValue).toBe(0);
  });
});

describe('useOrderSessionStore — split distributes the order-level discount (P2-3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('distributes a 10% order discount so Σ(seat subtotals) == the discounted total (90), not 100', async () => {
    let splitBody = null;
    global.fetch = vi.fn((url, options = {}) => {
      const u = String(url);
      if (u.includes('api/pos/table_splits/split') && options.method === 'POST') {
        splitBody = JSON.parse(options.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, message: 'Bill split successfully.' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) });
    });

    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.orderDiscount = { type: 'percent', value: 10 };   // parent order-level discount
    s.cart = [{ id: 1, price: 10, qty: 10, discountType: null, discountValue: 0, note: '', tax_rate: 0 }];
    s.activeTable = { id: 1, table_number: '1', status: 'occupied', current_order_id: 100, waiter_id: 3 };
    ui.unassignedSplitItems = [];
    ui.splitSeats = [
      { id: 1, name: 'Seat 1', items: [{ id: 1, price: 10, qty: 5, discountType: null, discountValue: 0, note: '', tax_rate: 0 }] },
      { id: 2, name: 'Seat 2', items: [{ id: 2, price: 10, qty: 5, discountType: null, discountValue: 0, note: '', tax_rate: 0 }] }
    ];

    await s.confirmSplit();

    expect(splitBody).not.toBeNull();
    expect(splitBody.splits).toHaveLength(2);
    const sum = splitBody.splits.reduce((acc, seat) => acc + Number(seat.subtotal), 0);
    expect(Number(sum.toFixed(2))).toBe(90);
    expect(splitBody.splits[0].subtotal).toBe(45);
    expect(splitBody.splits[1].subtotal).toBe(45);
    expect(splitBody.splits[0].order_discount).toEqual({ type: 'percent', value: 10 });
    expect(splitBody.splits[1].order_discount).toEqual({ type: 'percent', value: 10 });
  });

  it('B2: fractional split conserves total qty (last piece absorbs the rounding residue)', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.unassignedSplitItems = [{ id: 1, price: 10, qty: 1, discountType: null, discountValue: 0, note: '', tax_rate: 0 }];

    s.splitItemFractionally(0, 6); // naive toFixed(4) would give 6*0.1667 = 1.0002 → backend rejects

    expect(ui.unassignedSplitItems).toHaveLength(6);
    const totalQty = ui.unassignedSplitItems.reduce((sum, it) => sum + Number(it.qty), 0);
    // Must be within the backend split-conservation tolerance (0.0001), else the split is rejected.
    expect(Math.abs(totalQty - 1)).toBeLessThanOrEqual(0.0001);
  });

  it('opens with one empty destination while the order remains on Remaining Check', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 10, qty: 2, tax_rate: 0 }];
    s.activeTable = { id: 1, table_number: '1', status: 'occupied', current_order_id: 100, waiter_id: 3 };

    s.openSplitModal();

    expect(ui.unassignedSplitItems).toEqual(s.cart);
    expect(ui.splitSeats).toEqual([{ id: 2, name: 'Check 2', items: [] }]);
    expect(ui.activeSplitSeat).toBe(2);
  });

  it('restores every unpaid sibling into one editable split group', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    const payload = (role, revision, qty) => JSON.stringify({
      progressive_split_version: 2,
      split_role: role,
      split_revision: revision,
      items: [{ id: 8, order_item_id: 44, name: 'Tea', price: 2, qty, tax_rate: 0 }]
    });
    const group = {
      tableNumber: 'A1',
      splits: [
        { id: 10, table_id: 3, parent_invoice_id: 90, cart_data: payload('remainder', 2, 1) },
        { id: 11, table_id: 3, parent_invoice_id: 90, cart_data: payload('check', 3, 2) }
      ]
    };

    expect(s.editSplitGroup(group)).toBe(true);
    expect(ui.unassignedSplitItems[0].qty).toBe(1);
    expect(ui.splitSeats).toMatchObject([{ id: 2, heldId: 11, name: 'Check 2', items: [{ qty: 2 }] }]);
    expect(ui.splitEditContext).toMatchObject({
      splitId: 10,
      remainingCheckId: 10,
      expectedChecks: [{ id: 10, revision: 2 }, { id: 11, revision: 3 }]
    });
  });

  it('saves an edited unpaid group through the revision-guarded PUT contract', async () => {
    const s = useOrderSessionStore();
    const payload = (role, revision, qty) => JSON.stringify({
      progressive_split_version: 2,
      split_role: role,
      split_revision: revision,
      split_money_cents: { subtotal: qty * 200, discount: 0, tax: 0, total: qty * 200 },
      tax_inclusive_at_sale: 0,
      tax_exempt_at_hold: false,
      items: [{ id: 8, order_item_id: 44, name: 'Tea', price: 2, qty, tax_rate: 0 }]
    });
    s.editSplitGroup({
      tableNumber: 'A1',
      splits: [
        { id: 10, table_id: 3, parent_invoice_id: 90, cart_data: payload('remainder', 2, 1) },
        { id: 11, table_id: 3, parent_invoice_id: 90, cart_data: payload('check', 3, 2) }
      ]
    });
    const update = vi.spyOn(orderSessionApi, 'updateTableSplits').mockResolvedValue({
      response: { ok: true }, data: { success: true }
    });
    vi.spyOn(orderSessionApi, 'getTableSplits').mockResolvedValue({ data: { success: true, data: [] } });

    await s.confirmSplit();

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      splitId: 10,
      expectedChecks: [{ id: 10, revision: 2 }, { id: 11, revision: 3 }]
    }));
    expect(update.mock.calls[0][0].splits.map(split => split.id)).toEqual([10, 11]);
  });

  it('removes only empty added seats and keeps the active destination valid', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.splitSeats = [
      { id: 2, name: 'Check 2', items: [] },
      { id: 3, name: 'Check 3', items: [] },
      { id: 4, name: 'Check 4', items: [{ id: 1, qty: 1, price: 5 }] },
    ];
    ui.activeSplitSeat = 3;

    s.removeSplitSeat(3);
    s.removeSplitSeat(2);
    s.removeSplitSeat(4);

    expect(ui.splitSeats.map((seat) => seat.id)).toEqual([4]);
    expect(ui.activeSplitSeat).toBe(4);
  });

  it('keeps added seat ids unique after removing a middle seat', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.splitSeats = [
      { id: 2, name: 'Check 2', items: [] },
      { id: 3, name: 'Check 3', items: [] },
      { id: 4, name: 'Check 4', items: [] },
    ];

    s.removeSplitSeat(3);
    s.addSplitSeat();

    expect(ui.splitSeats.map((seat) => seat.id)).toEqual([2, 4, 5]);
  });

  it('does not open split modal outside an active table session', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    window.showPosToast = vi.fn();
    s.activeTable = null;
    s.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0 }];

    s.openSplitModal();

    expect(ui.showSplitModal).toBe(false);
    expect(ui.splitSeats).toEqual([]);
    expect(ui.unassignedSplitItems).toEqual([]);
    expect(window.showPosToast).toHaveBeenCalledWith(
      'Split checks must start from an active table.',
      'error'
    );
  });

  it('does not submit parentless split checks', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
    global.fetch = fetchSpy;
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    window.showPosAlert = vi.fn();
    s.activeTable = null;
    ui.unassignedSplitItems = [];
    ui.splitSeats = [
      { id: 1, name: 'Seat 1', items: [{ id: 1, price: 10, qty: 1, discountType: null, discountValue: 0, note: '', tax_rate: 0 }] }
    ];

    await s.confirmSplit();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.showPosAlert).toHaveBeenCalledWith('Split checks must start from an active table.');
  });

  it('restores the persisted split discount when reopening a held split check', async () => {
    global.fetch = vi.fn((url) => {
      const u = String(url);
      if (u.includes('api/pos/get_tables')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            settings: { tables_enabled: true, table_mode: 'fixed' },
            sections: [],
            tables: [{ id: 1, table_number: '1', status: 'available' }]
          })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) });
    });

    const s = useOrderSessionStore();
    await s.restoreTableSplit({
      id: 77,
      table_id: 1,
      reference_name: 'Table 1 - Seat A',
      cart_data: JSON.stringify({
        items: [{ id: 2, name: 'Test Drink', price: 2, qty: 25, tax_rate: 0 }],
        order_discount: { type: 'percent', value: 10 },
        parent_invoice_id: 100,
        parent_order_id: 12,
        is_split: true
      })
    });

    expect(s.orderDiscount).toEqual({ type: 'percent', value: 10 });
    expect(s.cartSubtotal).toBe(50);
    expect(s.cartTotal).toBe(45);
    expect(s.activeTable.split_check_id).toBe(77);
  });

  it('restores trusted split money into every checkout total', async () => {
    mockTerminalState.receiptTaxInclusiveDisplay.value = false;
    global.fetch = vi.fn((url) => {
      if (String(url).includes('api/pos/get_tables')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            settings: { tables_enabled: true, table_mode: 'fixed' },
            sections: [],
            tables: [{ id: 1, table_number: '1', status: 'available' }]
          })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) });
    });

    const s = useOrderSessionStore();
    const restored = await s.restoreTableSplit({
      id: 79,
      table_id: 1,
      reference_name: 'Table 1 - Seat C',
      // TableSplits.vue exposes parsed items while retaining the original cart_data.
      items: [{ id: 1, name: 'Half item', price: 4.092, qty: 0.5, tax_rate: 16 }],
      cart_data: JSON.stringify({
        items: [{ id: 1, name: 'Half item', price: 4.092, qty: 0.5, tax_rate: 16 }],
        parent_invoice_id: 102,
        is_split: true,
        tax_inclusive_at_sale: 0,
        split_money_cents: { subtotal: 204, discount: 0, tax: 33, total: 237 }
      })
    });

    expect(restored).toBe(true);
    expect(s.activeTable.split_money_cents).toEqual({ subtotal: 204, discount: 0, tax: 33, total: 237 });
    expect(s.cartSubtotal).toBe(2.04);
    expect(s.cartOrderDiscountAmount).toBe(0);
    expect(s.discountedSubtotal).toBe(2.04);
    expect(s.cartTax).toBe(0.33);
    expect(s.cartTotal).toBe(2.37);
    expect(s.cartReceiptPresentation.rows[0].netAmount).toBe(2.04);

    setActivePinia(createPinia());
    const resumed = useOrderSessionStore();
    expect(await resumed.activateTableFromStorage('pos_active_table')).toBe(true);
    expect(resumed.activeTable.split_money_cents).toEqual({ subtotal: 204, discount: 0, tax: 33, total: 237 });
  });

  it('blocks restoration when persisted split money is present but invalid', async () => {
    window.showPosAlert.mockClear();
    const s = useOrderSessionStore();
    const restored = await s.restoreTableSplit({
      id: 80,
      reference_name: 'Table 1 - Seat D',
      cart_data: JSON.stringify({
        items: [{ id: 1, name: 'Half item', price: 4.092, qty: 0.5, tax_rate: 16 }],
        parent_invoice_id: 103,
        is_split: true,
        split_money_cents: { subtotal: 204, discount: 0, tax: 33, total: 238 }
      })
    });

    expect(restored).toBe(false);
    expect(s.activeTable).toBeNull();
    expect(window.showPosAlert).toHaveBeenCalledWith(expect.stringMatching(/split money allocation is invalid/i));
  });

  it('restoring a split frozen as tax-inclusive computes totals inclusively on an exclusive terminal, and a reset falls back to the terminal mode', async () => {
    mockTerminalState.receiptTaxInclusiveDisplay.value = false; // customer-copy preference is now exclusive
    global.fetch = vi.fn((url) => {
      const u = String(url);
      if (u.includes('api/pos/get_tables')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            settings: { tables_enabled: true, table_mode: 'fixed' },
            sections: [],
            tables: [{ id: 1, table_number: '1', status: 'available' }]
          })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) });
    });

    const s = useOrderSessionStore();
    await s.restoreTableSplit({
      id: 78,
      table_id: 1,
      reference_name: 'Table 1 - Seat B',
      cart_data: JSON.stringify({
        items: [{ id: 3, name: 'Incl Meal', price: 11.60, qty: 1, tax_rate: 16 }],
        parent_invoice_id: 101,
        parent_order_id: 13,
        is_split: true,
        tax_inclusive_at_sale: 1
      })
    });

    // Live cart must honor the FROZEN inclusive mode, not the terminal's exclusive mode,
    // or split settle (frozen payload) and checkout's Total assertion diverge → 400.
    expect(s.activeOrderTaxInclusive).toBe(true);
    expect(s.cartTax).toBe(0);
    expect(s.cartTotal).toBe(11.60); // total == discounted subtotal under inclusive pricing

    // Leaving the order (clearOrderSlice via startNewOrder) drops the freeze → terminal mode again.
    s.startNewOrder();
    expect(s.activeOrderTaxInclusive).toBe(null);
    s.cart = [{ id: 3, name: 'Incl Meal', price: 11.60, qty: 1, tax_rate: 16 }];
    expect(s.cartTax).toBe(1.86); // exclusive terminal mode: 16% added on top
    expect(s.cartTotal).toBe(13.46);
  });
});

describe('useOrderSessionStore — updateActiveTableOrder clears isProcessing on success (P2-8)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockAuthState.activeUser.value = tableWorkflowActor();
  });

  it('resets ui.isProcessing to false after a successful save', async () => {
    mockPermissionsState.can.mockReturnValue(true);
    global.window.showPosToast.mockClear();
    global.window.setTimeout = vi.fn((fn) => fn());
    global.fetch = vi.fn((url, options = {}) => {
      const u = String(url);
      if (u === 'api/pos/table_order' && options.method === 'POST') {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true, order_id: 99, invoice_id: 99, table_id: 7, table_number: '3',
            invoice_display_no: null, order_display_no: null, ticket_display_no: null, table_display_no: '3'
          })
        });
      }
      if (u.includes('table-draft')) {
        return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
      }
      if (u.includes('api/pos/table_order?order_id=99')) {
        return Promise.reject(new Error('Simulated reload failure'));
      }
      if (u.includes('api/pos/get_tables')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            settings: { tables_enabled: true, table_mode: 'fixed' },
            sections: [],
            tables: [{ id: 7, table_number: '3', status: 'occupied', current_order_id: 99 }]
          })
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${u}`));
    });

    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    store.activeTable = { id: 7, table_number: '3', status: 'available', current_order_id: null };
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 2, tax_rate: 8 }];

    const saved = await store.updateActiveTableOrder();

    expect(saved).toBe(true);
    expect(global.window.showPosToast).toHaveBeenCalledWith(
      'Table saved. Reopen the table to continue.',
      'warning'
    );
    expect(ui.isProcessing).toBe(false); // was stuck true — the reload self-bumped tableSessionSeq
  });
});

describe('confirmed table save refresh recovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); localStorage.clear(); vi.clearAllMocks();
    mockPermissionsState.can.mockReturnValue(true);
    mockAuthState.activeUser.value = { id: 1, role: 'admin' };
    mockProductsState.settings.value = { tables_enabled: '1', stock_enabled: '0', service_charge_enabled: '0' };
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  function setup() {
    const s = useOrderSessionStore();
    s.activeTable = { id: 7, table_number: '3', status: 'occupied', current_order_id: 99, version: 2 };
    s.cart = [{ id: 2, name: 'Tea', qty: 1, price: 2, tax_rate: 0, note: 'No sugar', order_item_id: 5 }];
    s.orderNote = 'Keep this note';
    s.orderDiscount = { type: 'percent', value: 10 };
    const canonical = { success: true, invoice_id: 99, version: 3, cart: [{ ...s.cart[0], order_item_id: 50 }] };
    const save = vi.spyOn(orderSessionApi, 'saveTableOrder').mockResolvedValue({ data: { success: true, invoice_id: 99, table_id: 7, version: 3 } });
    vi.spyOn(orderSessionApi, 'getTableDraft').mockResolvedValue({ data: { success: true, cart: [] } });
    vi.spyOn(orderSessionApi, 'getTables').mockResolvedValue({ data: { success: true, settings: { tables_enabled: true }, tables: [{ id: 7, current_order_id: 99, status: 'occupied' }] } });
    let resolve, reject;
    const read = vi.spyOn(orderSessionApi, 'getTableOrder').mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    return { s, save, read, canonical, resolve: data => resolve({ data }), reject: error => reject(error) };
  }
  it('staying on the table: resolves after the POST and the order read, without a QR draft read or waiting on get_tables', async () => {
    const h = setup();
    orderSessionApi.getTables.mockImplementation(() => new Promise(() => {}));
    h.read.mockResolvedValue({ data: h.canonical });
    expect(await h.s.updateActiveTableOrder({ silent: true })).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(orderSessionApi.getTableDraft).not.toHaveBeenCalled();
    expect(orderSessionApi.getTables).toHaveBeenCalledTimes(1);
    expect(h.s.cart[0].order_item_id).toBe(50);
  });
  it('keeps the QR draft banner across the save refresh', async () => {
    const h = setup();
    const draft = [{ product_id: 1, qty: 1, name: 'Burger' }];
    h.s.activeQrDraft = draft;
    h.read.mockResolvedValue({ data: h.canonical });
    expect(await h.s.updateActiveTableOrder({ silent: true })).toBe(true);
    expect(h.s.activeQrDraft).toEqual(draft);
  });
  it('leaving for the floor: resolves on the committed POST with no follow-up reads', async () => {
    const h = setup();
    expect(await h.s.updateActiveTableOrder({ leaving: true, keepProcessingOnSuccess: true })).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.read).not.toHaveBeenCalled();
    expect(orderSessionApi.getTableDraft).not.toHaveBeenCalled();
    expect(orderSessionApi.getTables).not.toHaveBeenCalled();
    expect(h.s.activeTable).toMatchObject({ current_order_id: 99, version: 3 });
  });
  it('opening a table starts the QR draft read and the order read together', async () => {
    const h = setup(); let finishDraft;
    orderSessionApi.getTableDraft.mockImplementation(() => new Promise(resolve => { finishDraft = resolve; }));
    const opening = h.s.loadActiveTableOrder({ id: 8, current_order_id: 88, status: 'occupied', table_number: '8' });
    await vi.waitFor(() => expect(orderSessionApi.getTableDraft).toHaveBeenCalledTimes(1));
    expect(h.read).toHaveBeenCalledWith(88);
    h.resolve({ success: true, invoice_id: 88, version: 1, cart: [{ id: 1, name: 'Other table', qty: 1, price: 5, tax_rate: 0 }] });
    finishDraft({ data: { success: true, cart: [{ product_id: 1, qty: 1 }] } });
    await opening;
    expect(h.s.cart[0].name).toBe('Other table');
    expect(h.s.activeQrDraft).toEqual([{ product_id: 1, qty: 1 }]);
  });
  it('keeps the acknowledged cart, note, discount and durable table identity when the follow-up read aborts', async () => {
    const h = setup(), before = JSON.stringify(h.s.cart);
    const saving = h.s.updateActiveTableOrder({ silent: true });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(h.s.cart)).toBe(before);
    expect(JSON.parse(localStorage.getItem('pos_active_table'))).toMatchObject({ current_order_id: 99, version: 3 });
    h.reject(new Error('Read aborted by reload'));
    expect(await saving).toBe(true); await nextTick();
    expect(JSON.stringify(h.s.cart)).toBe(before);
    expect(h.s.orderNote).toBe('Keep this note');
    expect(h.s.orderDiscount).toEqual({ type: 'percent', value: 10 });
    expect(h.s.activeTable).toMatchObject({ current_order_id: 99, version: 3 });
    expect(JSON.parse(localStorage.getItem('pos_active_table'))).toMatchObject({ current_order_id: 99, version: 3 });
    expect(JSON.parse(localStorage.getItem('pos_cart'))).toEqual(h.s.cart);
    expect(h.save).toHaveBeenCalledTimes(1);
  });
  it('keeps edits made during a slow refresh and never advances their bill revision from that read', async () => {
    const h = setup();
    const saving = h.s.updateActiveTableOrder({ silent: true });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.s.cart.push({ id: 1, name: 'New food', qty: 1, price: 5, tax_rate: 16 });
    h.s.orderNote = 'Added while refreshing';
    h.resolve({ ...h.canonical, version: 4 });
    expect(await saving).toBe(true);
    expect(h.s.cart.map(row => row.name)).toEqual(['Tea', 'New food']);
    expect(h.s.orderNote).toBe('Added while refreshing');
    expect(h.s.activeTable.version).toBe(3);
  });
  it('does not reclaim a newer table session when the old saved refresh fails', async () => {
    const h = setup();
    const saving = h.s.updateActiveTableOrder({ silent: true });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.read.mockResolvedValueOnce({ data: { success: true, invoice_id: 88, version: 1, cart: [{ id: 1, name: 'Other table', qty: 1, price: 5, tax_rate: 0 }] } });
    await h.s.loadActiveTableOrder({ id: 8, current_order_id: 88, status: 'occupied', table_number: '8' });
    h.reject(new Error('Old request aborted')); expect(await saving).toBe(true);
    expect(h.s.activeTable.current_order_id).toBe(88);
    expect(h.s.cart[0].name).toBe('Other table');
  });
  it.each(['headers', 'body'])('bounds a saved-order %s stall without erasing the acknowledged draft', async stage => {
    vi.useFakeTimers();
    const h = setup(); h.read.mockRestore();
    let signal;
    global.fetch = vi.fn((url, options) => {
      signal = options?.signal;
      return stage === 'headers' ? new Promise(() => {}) : Promise.resolve({ json: () => new Promise(() => {}) });
    });
    let finished = false;
    const saving = h.s.updateActiveTableOrder({ silent: true }).then(value => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(15000);
    expect(finished).toBe(true); expect(await saving).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(h.s.cart[0].note).toBe('No sugar');
    expect(h.s.activeTable).toMatchObject({ current_order_id: 99, version: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['headers', 'body'])('bounds an optional QR %s stall while opening a table and still loads the order', async stage => {
    vi.useFakeTimers();
    const h = setup();
    orderSessionApi.getTableDraft.mockRestore();
    h.read.mockResolvedValue({ data: h.canonical });
    let signal;
    global.fetch = vi.fn((url, options) => {
      signal = options?.signal;
      return stage === 'headers' ? new Promise(() => {}) : Promise.resolve({ json: () => new Promise(() => {}) });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let finished = false;
    const opening = h.s.loadActiveTableOrder({ id: 7, table_number: '3', status: 'occupied', current_order_id: 99 }).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(15000);
    expect(finished).toBe(true); await opening;
    expect(signal.aborted).toBe(true); expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.s.cart[0].order_item_id).toBe(50);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('drops a delayed QR draft from a table the operator already left', async () => {
    const h = setup(); let finishDraft;
    orderSessionApi.getTableDraft.mockImplementationOnce(() => new Promise(resolve => { finishDraft = resolve; }));
    const opening = h.s.loadActiveTableOrder({ id: 7, table_number: '3', status: 'occupied', current_order_id: 99 });
    await vi.waitFor(() => expect(orderSessionApi.getTableDraft).toHaveBeenCalledTimes(1));
    h.read.mockResolvedValueOnce({ data: { success: true, invoice_id: 88, version: 1, cart: [{ id: 1, name: 'Other table', qty: 1, price: 5, tax_rate: 0 }] } });
    await h.s.loadActiveTableOrder({ id: 8, current_order_id: 88, status: 'occupied', table_number: '8' });
    finishDraft({ data: { success: true, cart: [{ product_id: 1, qty: 1 }] } });
    h.resolve(h.canonical); await opening;
    expect(h.s.activeTable.current_order_id).toBe(88);
    expect(h.s.cart[0].name).toBe('Other table');
    expect(h.s.activeQrDraft).toBeNull();
  });
  it('cannot move a draft back to the old seat after the same bill is relocated during refresh', async () => {
    const h = setup();
    const saving = h.s.updateActiveTableOrder({ silent: true });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.s.activeTable = { ...h.s.activeTable, id: 8, table_number: '8' };
    orderSessionApi.getTables.mockResolvedValue({ data: { success: true, settings: { tables_enabled: true }, tables: [{ id: 8, current_order_id: 99, status: 'occupied' }] } });
    h.resolve(h.canonical); expect(await saving).toBe(true);
    expect(h.s.activeTable).toMatchObject({ id: 8, current_order_id: 99, version: 3 });
    expect(h.s.cart[0].note).toBe('No sugar');
  });
});

describe('useOrderSessionStore — dismissActiveQrDraft session guard (P3-13)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('does not null a newer session draft when an older DELETE resolves late', async () => {
    let resolveDelete;
    const deletePromise = new Promise(r => { resolveDelete = r; });
    global.fetch = vi.fn(() => deletePromise.then(() => ({ json: () => Promise.resolve({ success: true }) })));

    const store = useOrderSessionStore();
    // Session A begins dismissing table 7's draft.
    const p = store.dismissActiveQrDraft(7);
    // Operator switches to table B mid-flight: the token bumps and B loads its own draft banner.
    store.invalidateTableSession();
    store.activeQrDraft = [{ product_id: 1, name: 'B-draft' }];

    resolveDelete();
    await p;

    // A's late DELETE must NOT clear B's freshly-loaded draft.
    expect(store.activeQrDraft).toEqual([{ product_id: 1, name: 'B-draft' }]);
  });
});

describe('restoreHeldOrder clears edit residue (Task 1 regression)', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('nulls editing IDs when restoring a held order', () => {
    const s = useOrderSessionStore();
    // Simulate leftover edit residue from a prior /pos?edit_invoice=123 session.
    s.editingInvoiceId = 123;
    s.editingOrderId = 456;
    s.originalSavedItems = [{ id: 1 }];

    s.restoreHeldOrder({ items: [{ id: 7, price: '2.50', qty: '1', tax_rate: '16' }], customer_name: 'Held Cust' });

    expect(s.editingInvoiceId).toBe(null);
    expect(s.editingOrderId).toBe(null);
    expect(s.originalSavedItems).toEqual([]);
    expect(s.customerName).toBe('Held Cust');
    // numeric normalization from the canonical path
    expect(s.cart[0].price).toBe(2.5);
    expect(s.cart[0].qty).toBe(1);
  });
});

describe('holdCurrentOrder double-submit guard (Task 3)', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('does not fire a second hold request while one is in flight', async () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0 }];

    const resolvers = [];   // collect so we can settle every pending fetch in cleanup
    const fetchSpy = vi.fn(() => new Promise(r => {
      resolvers.push(() => r({ json: () => Promise.resolve({ success: true }) }));
    }));
    global.fetch = fetchSpy;
    global.window.showPosPrompt = vi.fn(() => Promise.resolve('ref-1'));

    const first = s.holdCurrentOrder();   // enters, awaits the prompt, then fetch
    await Promise.resolve();               // resume first past the (resolved) prompt await...
    await Promise.resolve();               // ...through to its fetch() call (fetchSpy now 1)
    const second = s.holdCurrentOrder();   // FIXED: guard early-returns. UNFIXED: awaits prompt.
    // CRITICAL: flush microtasks AFTER starting second, BEFORE asserting. On the UNFIXED code
    // the second call is still parked at `await showPosPrompt` at this point and has NOT reached
    // fetch yet — asserting now would FALSE-PASS. These flushes let the unfixed second call
    // resume past the prompt and call fetch, so the count assertion actually catches the bug.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);   // UNFIXED -> 2 (fails, correct); FIXED -> 1 (passes)

    // Drain every pending fetch (1 resolver on fixed, 2 on unfixed) so nothing hangs.
    while (resolvers.length) resolvers.shift()();
    await Promise.all([first, second]);
  });

  it('refuses to hold while a checkout is processing', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 5, qty: 1, tax_rate: 0 }];
    ui.isProcessing = true;
    global.fetch = vi.fn();

    await s.holdCurrentOrder();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('processCheckout freezes the receipt snapshot (Task 4)', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('builds lastOrder.items from the pre-fetch snapshot, not the mutated cart', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, name: 'Charged Item', price: 10, qty: 1, tax_rate: 0 }];
    ui.paymentMethod = 'cash';
    ui.amountTendered = s.cartTotal;

    global.fetch = vi.fn(() => {
      // Simulate a barcode scan landing mid-request:
      s.cart.push({ id: 99, name: 'Late Scan', price: 5, qty: 1, tax_rate: 0 });
      return Promise.resolve({ json: () => Promise.resolve({ success: true, invoice_id: 555, order_id: 555 }) });
    });

    await s.processCheckout();

    const receipt = mockTerminalState.lastOrder.value;
    // Items are frozen to the pre-fetch snapshot:
    expect(receipt.items).toHaveLength(1);
    expect(receipt.items[0].name).toBe('Charged Item');
    expect(receipt.items.find(i => i.name === 'Late Scan')).toBeUndefined();
    // Totals fallback is ALSO frozen: the mock response omits subtotal/tax/total, so the
    // receipt falls back to the snapshot. Without the totals fix this would read the
    // mutated cart (15) instead of the charged snapshot (10).
    expect(receipt.total).toBe(10);
    expect(receipt.subtotal).toBe(10);
    expect(s.cart).toEqual([]);
  });
});

describe('processCheckout owns its table session until response handling completes', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockReset().mockResolvedValue();
    mockAuthState.activeUser.value = tableWorkflowActor();
  });

  it('keeps table A receipt identity when its socket update clears the session first', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.activeTable = {
      id: 7,
      table_number: 'A7',
      current_order_id: 70,
      status: 'occupied',
      order_taken_at: '2026-07-15 12:00:00'
    };
    s.cart = [{ id: 1, name: 'A item', price: 5, qty: 1, tax_rate: 0 }];
    ui.paymentMethod = 'cash';
    ui.amountTendered = 5;

    let resolveCheckout;
    global.fetch = vi.fn(() => new Promise(resolve => {
      resolveCheckout = () => resolve({
        json: () => Promise.resolve({ success: true, invoice_id: 700, order_id: 700 })
      });
    }));

    const pending = s.processCheckout();
    s.clearActiveTableSession({ clearCart: true });
    resolveCheckout();
    await pending;

    expect(mockTerminalState.lastOrder.value.table_number).toBe('A7');
    expect(mockTerminalState.lastOrder.value.order_taken_at).toBe('2026-07-15 12:00:00');
    expect(mockTerminalState.lastOrder.value.items).toEqual([
      expect.objectContaining({ name: 'A item' })
    ]);
  });

  it('does not clear table B when table A checkout resolves late', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.activeTable = { id: 7, table_number: 'A7', current_order_id: 70, status: 'occupied' };
    s.cart = [{ id: 1, name: 'A item', price: 5, qty: 1, tax_rate: 0 }];
    ui.paymentMethod = 'cash';
    ui.amountTendered = 5;

    let resolveCheckout;
    global.fetch = vi.fn(() => new Promise(resolve => {
      resolveCheckout = () => resolve({
        json: () => Promise.resolve({ success: true, invoice_id: 700, order_id: 700 })
      });
    }));

    const pending = s.processCheckout();
    s.invalidateTableSession();
    s.activeTable = { id: 8, table_number: 'B8', current_order_id: 80, status: 'occupied' };
    s.cart = [{ id: 2, name: 'B item', price: 9, qty: 1, tax_rate: 0 }];
    resolveCheckout();
    await pending;

    expect(mockTerminalState.lastOrder.value.table_number).toBe('A7');
    expect(s.activeTable).toMatchObject({ id: 8, table_number: 'B8', current_order_id: 80 });
    expect(s.cart).toEqual([expect.objectContaining({ name: 'B item' })]);
  });

  it('defers table B checkout until table A has resolved', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.activeTable = { id: 7, table_number: 'A7', current_order_id: 70, status: 'occupied' };
    s.cart = [{ id: 1, name: 'A item', price: 5, qty: 1, tax_rate: 0 }];
    ui.paymentMethod = 'cash';
    ui.amountTendered = 5;

    const resolvers = [];
    global.fetch = vi.fn(() => new Promise(resolve => { resolvers.push(resolve); }));
    const checkoutA = s.processCheckout();

    s.clearActiveTableSession({ clearCart: true });
    s.activeTable = { id: 8, table_number: 'B8', current_order_id: 80, status: 'occupied' };
    s.cart = [{ id: 2, name: 'B item', price: 9, qty: 1, tax_rate: 0 }];
    ui.paymentMethod = 'cash';
    ui.amountTendered = 9;
    const checkoutB = s.processCheckout();

    resolvers[0]({ json: () => Promise.resolve({ success: true, invoice_id: 700, order_id: 700 }) });
    await checkoutA;

    expect(resolvers).toHaveLength(1);
    await checkoutB;
    const retryB = s.processCheckout();
    expect(ui.isProcessing).toBe(true);
    resolvers[1]({ json: () => Promise.resolve({ success: true, invoice_id: 800, order_id: 800 }) });
    await retryB;
    expect(ui.isProcessing).toBe(false);
  });
});

describe('restore + edit residue resets (Task 6)', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('nulls selectedCartIndex when restoring a held order', () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
    s.selectedCartIndex = 5;

    s.restoreHeldOrder({ items: [{ id: 7, price: '1', qty: '1' }, { id: 8, price: '1', qty: '1' }] });

    expect(s.selectedCartIndex).toBe(null);
  });

  it('loadOrderForEditing clears stale residue and keeps current product price-lock metadata', async () => {
    const s = useOrderSessionStore();
    // Prior residue on the terminal:
    s.orderDate = '2026-01-01T12:00';
    s.selectedOrderType = 7;

    global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({
      success: true,
      order: { invoice_id: 1, order_id: 1, note: '', discount_type: 'percent', discount_value: 0,
               customer_name: '', customer_phone: '', customer_address: '',
               delivery_date: null, order_type_id: null, hash_number: '' },
      items: [{ id: 10, product_id: 2, product_name: 'Locked', price_at_sale: 5, quantity: 1, price_override_locked: 1 }]
    }) }));

    await s.loadOrderForEditing(1);

    expect(s.orderDate).toBe('');
    expect(s.selectedOrderType).toBe('');
    expect(s.cart[0]).toMatchObject({ id: 2, price: 5, price_override_locked: 1 });
  });
});

describe('processCheckout isolates a receipt-print failure from the charge (Task 5 hardening)', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('does not surface a checkout error when printReceipt rejects on an already-charged order', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, name: 'X', price: 10, qty: 1, tax_rate: 0 }];
    ui.paymentMethod = 'cash';
    ui.amountTendered = s.cartTotal;

    global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ success: true, invoice_id: 1, order_id: 1 }) }));
    // Simulate a browser-mode window.print() failure (kiosk lockdown / popup blocked) AFTER the
    // server already confirmed the sale. The order is charged + finalized; a print failure must
    // NOT be rethrown into the checkout catch (which would flash a false "Network error").
    mockTerminalState.printReceipt.mockRejectedValueOnce(new Error('window.print blocked'));

    await s.processCheckout();

    expect(mockTerminalState.printReceipt).toHaveBeenCalled(); // proves we reached the success path
    expect(ui.checkoutError).toBe('');                          // NOT "Network error. Could not connect."
  });
});

describe('cartTax / cartTotal parity is preserved by the shared rawCartTax refactor (Task 3)', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('computes identical tax and total across normal, discounted, multi-rate and exempt carts', () => {
    const s = useOrderSessionStore();

    // normal, single rate
    s.cart = [{ id: 1, price: 10, qty: 2, tax_rate: 16, discountType: null, discountValue: 0 }];
    expect(s.cartTax).toBeCloseTo(3.2, 5);
    expect(s.cartTotal).toBeCloseTo(23.2, 5);

    // per-line percent discount + a second rate
    s.cart = [
      { id: 1, price: 10, qty: 1, tax_rate: 16, discountType: 'percent', discountValue: 10 },
      { id: 2, price: 5, qty: 3, tax_rate: 0, discountType: null, discountValue: 0 }
    ];
    const taxA = s.cartTax, totalA = s.cartTotal;
    expect(taxA).toBeCloseTo(1.44, 5);     // 9 * 16%
    expect(totalA).toBeCloseTo(25.44, 5);  // (9 + 15) + 1.44

    // order-level percent discount (exercises discountRatio)
    s.orderDiscount = { type: 'percent', value: 10 };
    expect(s.cartTax).toBeCloseTo(1.3, 5);   // tax scales by the 0.9 ratio
    expect(s.cartTotal).toBeCloseTo(22.9, 5);
    s.orderDiscount = { type: 'percent', value: 0 };

  });
});

describe('Future-proofing Tasks (Tasks 4, 5, 6, 7)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockPermissionsState.can.mockReturnValue(true);
    global.requestAnimationFrame = (cb) => cb();
  });

  it('clamps numpad live discount to 100 max (Task 4)', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.selectedCartIndex = 0;
    ui.numpadMode = 'discount';
    ui.numpadInput = '150';
    s.applyLiveNumpad();
    expect(s.cart[0].discountValue).toBe(100);
  });

  it('leaves item price unchanged when numpad price is cleared (Task 5)', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 12.5, qty: 1, tax_rate: 0 }];
    s.selectedCartIndex = 0;
    ui.numpadMode = 'price';
    ui.numpadInput = '';          // cleared field -> parseFloat NaN
    s.applyLiveNumpad();
    expect(s.cart[0].price).toBe(12.5);   // NOT zeroed
  });

  it('turns a requested line amount into quantity while preserving the unit price', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 23, qty: 1, tax_rate: 0 }];
    s.selectedCartIndex = 0;
    ui.numpadMode = 'price';
    ui.numpadInput = '5';

    s.applyLiveNumpad();

    expect(s.cart[0]).toMatchObject({ price: 23, qty: 0.217391 });
    expect(s.cartTotal).toBe(5);
    expect(s.cart[0].manual_price_override).toBeUndefined();
  });

  it('restores the quantity from before amount entry when C is pressed', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 20, qty: 1, tax_rate: 0 }];
    s.selectedCartIndex = 0;
    ui.numpadMode = 'price';
    ui.numpadInput = '14';

    s.applyLiveNumpad();
    expect(s.cart[0].qty).toBe(0.7);

    s.clearNumpad();

    expect(s.cart[0]).toMatchObject({ price: 20, qty: 1 });
    expect(ui.numpadInput).toBe('');
  });

  it('derives quantity from the tax-inclusive selling amount', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 20, qty: 1, tax_rate: 16, discountType: null, discountValue: 0 }];
    s.selectedCartIndex = 0;
    ui.numpadMode = 'price';
    ui.numpadInput = '11.60';

    s.applyLiveNumpad();

    expect(s.cart[0]).toMatchObject({ price: 20, qty: 0.5 });
    expect(s.getItemTotalGross(s.cart[0])).toBeCloseTo(11.6, 5);
  });

  it('does not use amount entry to reduce an already-saved table quantity', () => {
    window.showPosToast.mockClear();
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 20, qty: 1, originalQty: 1, tax_rate: 0 }];
    s.selectedCartIndex = 0;
    ui.numpadMode = 'price';
    ui.numpadInput = '14';

    s.applyLiveNumpad();

    expect(s.cart[0]).toMatchObject({ price: 20, qty: 1 });
    expect(window.showPosToast).toHaveBeenCalledWith('Use Remove to remove a saved item.', 'error');
  });

  it('printGuestCheck does not clobber a checkout that completes within 2s (Task 6)', async () => {
    vi.useFakeTimers();
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, name: 'X', price: 5, qty: 1, tax_rate: 0 }];
    mockTerminalState.lastOrder.value = { invoice_id: 'PREV' };

    const p = s.printGuestCheck();
    await vi.advanceTimersByTimeAsync(0);   // let rAF/print run

    // Simulate a real checkout landing during the window:
    mockTerminalState.lastOrder.value = { invoice_id: 'REAL-PAID' };

    await vi.advanceTimersByTimeAsync(2000); // fire the stale restore timer
    expect(mockTerminalState.lastOrder.value.invoice_id).toBe('REAL-PAID'); // not clobbered back to PREV
    vi.useRealTimers();
    await p;
  });

  it('clears hashNumber when switching between two hash-requiring types (Task 7)', async () => {
    const s = useOrderSessionStore();
    s.hashNumber = 'OLD-HASH';
    // mock document focus/getElementById to be safe in jsdom-less env
    if (!global.document.getElementById) {
      global.document.getElementById = () => null;
    }
    await s.handleOrderTypeSelection({ id: 3, requires_hash: 1 });
    expect(s.hashNumber).toBe('');   // must not carry OLD-HASH into the new hash type
  });
});

describe('useOrderSessionStore — quick numpad mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
    mockProductsState.products.value = [];
    mockProductsState.settings.value = {
      stock_enabled: '0',
      tables_enabled: '1',
      service_charge_enabled: '0',
      auto_apply_service_charge: '0'
    };
    mockPermissionsState.can.mockReturnValue(true);
    mockTerminalState.quickNumpadMode.value = true;
  });

  afterEach(() => {
    mockTerminalState.quickNumpadMode.value = false;
  });

  it('uses plain input as target money and X input as literal quantity', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    const product = { id: 50, name: '23 JD item', price: 23, tax_rate: 0 };

    ui.numpadInput = '5';
    await s.addToCart(product, { source: 'catalog', useQuickAmount: true });
    expect(s.cart[0]).toMatchObject({ price: 23, qty: 0.217391 });
    expect(s.cartTotal).toBe(5);

    s.cart = [];
    ui.numpadInput = '5';
    expect(s.armQuickAmount()).toBe(true);
    await s.addToCart(product, { source: 'catalog', useQuickAmount: true });
    expect(s.cart[0]).toMatchObject({ price: 23, qty: 5 });
    expect(s.cartTotal).toBe(115);

    s.cart = [];
    ui.numpadInput = '0.125';
    expect(s.armQuickAmount()).toBe(true);
    await s.addToCart(product, { source: 'catalog', useQuickAmount: true });
    expect(s.cart[0].qty).toBe(0.125);
  });

  it('uses a preset as the next product quantity in quick mode', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();

    expect(s.applyQuantityPreset('0.125')).toBe(true);
    expect(ui.numpadInput).toBe('0.125');
    expect(ui.quickTargetAmount).toBe(0.125);

    await s.addToCart(
      { id: 52, name: '23 JD item', price: 23, tax_rate: 0 },
      { source: 'catalog', useQuickAmount: true }
    );

    expect(s.cart[0]).toMatchObject({ price: 23, qty: 0.125 });
    expect(ui.numpadInput).toBe('');
    expect(ui.quickTargetAmount).toBe(null);
  });

  it('applies a preset to a selected quantity without leaving quick amount state', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 53, name: '23 JD item', price: 23, tax_rate: 0, qty: 1 }];
    s.selectedCartIndex = 0;

    ui.numpadInput = '5';
    s.applyLiveNumpad();
    expect(s.cart[0].qty).toBe(0.217391);

    expect(s.applyQuantityPreset('0.5')).toBe(true);

    expect(s.cart[0]).toMatchObject({ price: 23, qty: 0.5 });
    expect(ui.numpadMode).toBe('qty');
    expect(ui.numpadInput).toBe('');
    expect(ui.quickTargetAmount).toBe(null);
  });

  it('forces preset quantity behavior from another standard numpad mode', () => {
    mockTerminalState.quickNumpadMode.value = false;
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 54, name: 'Item', price: 10, tax_rate: 0, qty: 1 }];
    s.selectedCartIndex = 0;
    ui.numpadMode = 'price';
    ui.numpadInput = '99';

    expect(s.applyQuantityPreset('0.75')).toBe(true);

    expect(s.cart[0]).toMatchObject({ price: 10, qty: 0.75 });
    expect(ui.numpadMode).toBe('qty');
    expect(ui.numpadInput).toBe('');
  });

  it('uses plain input as target money for an already selected line', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 51, name: '23 JD item', price: 23, tax_rate: 0, qty: 1 }];
    s.selectedCartIndex = 0;

    ui.numpadInput = '5';
    s.applyLiveNumpad();

    expect(s.cart[0].qty).toBe(0.217391);
    expect(s.cartTotal).toBe(5);

    s.clearNumpad();
    expect(s.cart[0].qty).toBe(1);
    expect(ui.numpadInput).toBe('');
  });

  it('arms only a positive quantity for the next product and never a selected row', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '6';
    expect(s.armQuickAmount()).toBe(true);
    expect(ui.quickTargetAmount).toBe(6);

    s.cart = [{ id: 1, price: 10, qty: 1 }];
    s.selectedCartIndex = 0;
    ui.numpadInput = '8';
    expect(s.armQuickAmount()).toBe(false);
    expect(ui.quickTargetAmount).toBe(null);

    ui.numpadInput = '0';
    expect(s.armQuickAmount()).toBe(false);
    expect(ui.quickTargetAmount).toBe(null);
  });

  it('turns gross target money into a precise quantity without overriding price', async () => {
    mockPermissionsState.can.mockReturnValue(false);
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '11.60';

    await s.addToCart(
      { id: 1, name: 'Taxed item', price: 20, tax_rate: 16, price_override_locked: 1 },
      { source: 'catalog', useQuickAmount: true }
    );

    expect(s.cart[0]).toMatchObject({ price: 20, qty: 0.5 });
    expect(s.cart[0].manual_price_override).toBeUndefined();
    expect(s.getItemTotalGross(s.cart[0])).toBeCloseTo(11.6, 5);
    expect(ui.quickTargetAmount).toBe(null);
    expect(ui.numpadInput).toBe('');
  });

  it('keeps an awkward quick amount exact at money precision', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '5';

    await s.addToCart(
      { id: 23, name: '23 JD item', price: 23, tax_rate: 0 },
      { source: 'catalog', useQuickAmount: true }
    );

    expect(s.cart[0]).toMatchObject({ price: 23, qty: 0.217391 });
    expect(s.cartTotal).toBe(5);
  });

  it.each([
    [40.59, 11, 3.69],
    [54.36, 12, 4.53]
  ])('turns scale total %s at unit price %s into a normal fractional line', async (targetAmount, price, expectedQty) => {
    const s = useOrderSessionStore();

    await s.addToCart(
      { id: 30, name: 'Scale item', price, tax_rate: 0, can_sell: 1 },
      { source: 'barcode', targetAmount }
    );

    expect(s.cart[0]).toMatchObject({ price, qty: expectedQty });
    expect(s.cartTotal).toBe(targetAmount);
    expect(s.cart[0].manual_price_override).toBeUndefined();
  });

  it('derives a scale quantity from tax-inclusive unit value', async () => {
    const s = useOrderSessionStore();

    await s.addToCart(
      { id: 31, name: 'Taxed scale item', price: 10, tax_rate: 16, can_sell: 1 },
      { source: 'barcode', targetAmount: 5.8 }
    );

    expect(s.cart[0]).toMatchObject({ price: 10, qty: 0.5 });
    expect(s.cartTotal).toBe(5.8);
  });

  it('rejects rather than silently changing encoded cents at the six-decimal boundary', async () => {
    const s = useOrderSessionStore();

    await expect(s.addToCart(
      { id: 37, name: 'High-value scale item', price: 9769.688295, tax_rate: 16, can_sell: 1 },
      { source: 'barcode', targetAmount: 602.21 }
    )).resolves.toBe(false);

    expect(s.cart).toEqual([]);
  });

  it('fails closed for invalid scale amounts, zero price, stock, and sub-precision quantities', async () => {
    const s = useOrderSessionStore();

    await expect(s.addToCart(
      { id: 32, name: 'Scale item', price: 10, tax_rate: 0, can_sell: 1 },
      { source: 'barcode', targetAmount: 0 }
    )).resolves.toBe(false);
    await expect(s.addToCart(
      { id: 33, name: 'Free item', price: 0, tax_rate: 0, can_sell: 1 },
      { source: 'barcode', targetAmount: 5 }
    )).resolves.toBe(false);
    await expect(s.addToCart(
      { id: 34, name: 'Tiny quantity', price: 100000, tax_rate: 0, can_sell: 1 },
      { source: 'barcode', targetAmount: 0.01 }
    )).resolves.toBe(false);

    mockProductsState.settings.value.stock_enabled = '1';
    await expect(s.addToCart(
      { id: 35, name: 'Low stock', price: 11, tax_rate: 0, stock: 3, can_sell: 1 },
      { source: 'barcode', targetAmount: 40.59 }
    )).resolves.toBe(false);

    expect(s.cart).toEqual([]);
  });

  it('merges repeated scale scans without losing six-decimal quantity', async () => {
    const s = useOrderSessionStore();
    const product = { id: 36, name: 'Awkward scale item', price: 23, tax_rate: 0, can_sell: 1 };

    await s.addToCart(product, { source: 'barcode', targetAmount: 5 });
    await s.addToCart(product, { source: 'barcode', targetAmount: 5 });

    expect(s.cart).toHaveLength(1);
    expect(s.cart[0]).toMatchObject({ price: 23, qty: 0.434782 });
    expect(s.cartTotal).toBe(10);
  });

  it('uses canonical base price before modifiers and applies the derived quantity once', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '5';

    await s.addToCart({
      id: 2,
      name: 'Configured item',
      price: 10,
      tax_rate: 0,
      modifiers: JSON.stringify([{ id: 'g', name: 'Size', options: [{ id: 'o', name: 'Extra', price: 2 }] }])
    }, { source: 'catalog', useQuickAmount: true });

    expect(ui.activeModifierQty).toBe(0.5);
    expect(ui.quickTargetAmount).toBe(null);
    ui.selectedModifiers = { 0: [0] };
    await expect(s.confirmModifiers()).resolves.toBe(true);
    expect(s.cart[0]).toMatchObject({ price: 12, qty: 0.5 });
    expect(s.cartTotal).toBe(6);
    expect(ui.showModifierModal).toBe(false);
    expect(ui.activeModifierProduct).toBe(null);
    expect(ui.activeModifierQty).toBe(1);
    expect(ui.selectedModifiers).toEqual({});
  });

  it('cancels a modifier draft without leaving modal or quick state behind', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '5';

    await s.addToCart({
      id: 9,
      name: 'Configured item',
      price: 10,
      tax_rate: 0,
      modifiers: JSON.stringify([{ id: 'g', name: 'Size', options: [{ id: 'o', name: 'Extra', price: 2 }] }])
    }, { source: 'catalog', useQuickAmount: true });
    ui.selectedModifiers = { 0: [0] };

    s.cancelModifiers();

    expect(s.cart).toEqual([]);
    expect(ui.showModifierModal).toBe(false);
    expect(ui.activeModifierProduct).toBe(null);
    expect(ui.activeModifierQty).toBe(1);
    expect(ui.selectedModifiers).toEqual({});
    expect(ui.quickTargetAmount).toBe(null);
    expect(ui.numpadInput).toBe('');
  });

  it('consumes quick input on sold-out, zero-price, stock, and barcode attempts', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    const arm = (amount = '6') => {
      ui.numpadInput = amount;
      expect(s.armQuickAmount()).toBe(true);
    };

    arm();
    await s.addToCart({ id: 3, price: 10, can_sell: 0 }, { source: 'catalog', useQuickAmount: true });
    expect(ui.quickTargetAmount).toBe(null);

    ui.numpadInput = '6';
    await s.addToCart({ id: 4, price: 0, can_sell: 1 }, { source: 'catalog', useQuickAmount: true });
    expect(s.cart).toEqual([]);
    expect(ui.quickTargetAmount).toBe(null);

    mockProductsState.settings.value.stock_enabled = '1';
    ui.numpadInput = '5';
    await s.addToCart({ id: 5, price: 10, stock: 0.4, can_sell: 1 }, { source: 'catalog', useQuickAmount: true });
    expect(s.cart).toEqual([]);
    expect(ui.quickTargetAmount).toBe(null);

    mockProductsState.settings.value.stock_enabled = '0';
    arm();
    await s.addToCart({ id: 6, price: 2, can_sell: 1 }, { source: 'barcode' });
    expect(s.cart.at(-1).qty).toBe(1);
    expect(ui.quickTargetAmount).toBe(null);
  });

  it('rejects a derived quantity below six-decimal precision and preserves the next normal add', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '0.01';

    await expect(s.addToCart(
      { id: 7, price: 100000, tax_rate: 0 },
      { source: 'catalog', useQuickAmount: true }
    )).resolves.toBe(false);
    expect(s.cart).toEqual([]);
    expect(ui.quickTargetAmount).toBe(null);

    await s.addToCart({ id: 8, price: 10, tax_rate: 0 }, { source: 'catalog', useQuickAmount: true });
    expect(s.cart[0]).toMatchObject({ id: 8, price: 10, qty: 1 });
  });

  it('clears armed input through numeric editing, C, DEL, reset, and saved-order restore', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    const arm = () => {
      ui.numpadInput = '6';
      expect(s.armQuickAmount()).toBe(true);
    };

    arm();
    s.appendNumpad('2');
    expect(ui.quickTargetAmount).toBe(null);
    expect(ui.numpadInput).toBe('2');

    arm();
    s.clearNumpad();
    expect(ui.quickTargetAmount).toBe(null);
    expect(ui.numpadInput).toBe('');

    arm();
    s.backspaceNumpad();
    expect(ui.quickTargetAmount).toBe(null);

    arm();
    ui.resetTransient();
    expect(ui.quickTargetAmount).toBe(null);
    expect(ui.numpadInput).toBe('');

    arm();
    s.loadSavedOrder();
    expect(ui.quickTargetAmount).toBe(null);
    expect(JSON.stringify([...Object.entries(store)])).not.toContain('quickTargetAmount');
  });

  it('clears the arm after successful cart, hold, follow-up, and baseline boundaries', async () => {
    let s = useOrderSessionStore();
    let ui = useOrderUiStore();
    const arm = () => {
      ui.numpadInput = '6';
      expect(s.armQuickAmount()).toBe(true);
    };

    s.cart = [{ id: 1, price: 10, qty: 1 }];
    arm();
    await expect(s.clearCart({ skipConfirm: true })).resolves.toBe(true);
    expect(ui.quickTargetAmount).toBe(null);

    setActivePinia(createPinia());
    s = useOrderSessionStore();
    ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 10, qty: 1 }];
    arm();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true })
    });
    await expect(s.holdCurrentOrder()).resolves.toBe(true);
    expect(ui.quickTargetAmount).toBe(null);

    s.restoreHeldOrder({
      items: [{ id: 2, price: 3, qty: 1 }],
      held_order_context: {
        id: 17,
        version: 4,
        claimToken: 'd'.repeat(64),
        kitchenFired: true,
        baselineUnknown: false
      }
    });
    arm();
    const followUp = vi.spyOn(orderSessionApi, 'followUpHeldOrder').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true }
    });
    await expect(s.sendHeldOrderFollowUp()).resolves.toBe(true);
    expect(ui.quickTargetAmount).toBe(null);
    followUp.mockRestore();

    s.restoreHeldOrder({
      items: [{ id: 2, price: 3, qty: 1 }],
      held_order_context: {
        id: 18,
        version: 4,
        claimToken: 'b'.repeat(64),
        kitchenFired: true,
        baselineUnknown: true
      }
    });
    arm();
    const baseline = vi.spyOn(orderSessionApi, 'confirmHeldKitchenBaseline').mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { success: true }
    });
    await expect(s.confirmHeldKitchenBaseline()).resolves.toBe(true);
    expect(ui.quickTargetAmount).toBe(null);
    baseline.mockRestore();
  });

  it('keeps the arm when a hold fails and the current draft remains editable', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.cart = [{ id: 1, price: 10, qty: 1 }];
    ui.numpadInput = '6';
    s.armQuickAmount();
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(s.holdCurrentOrder()).resolves.toBe(false);

    expect(s.cart).toHaveLength(1);
    expect(ui.quickTargetAmount).toBe(6);
  });

  it('clears the arm when an empty order receives a direct clear action', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '6';
    s.armQuickAmount();

    await expect(s.clearCart()).resolves.toBe(false);

    expect(ui.quickTargetAmount).toBe(null);
    expect(ui.numpadInput).toBe('');
  });
});

describe('Task 5 Store-integration tests', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockPermissionsState.can.mockReturnValue(true);
    global.requestAnimationFrame = (cb) => cb();
  });

  it('a live exclusive cart with a line discount has net rows summing to cartSubtotal', () => {
    const s = useOrderSessionStore();
    s.activeOrderTaxInclusive = false;
    s.cart = [{
      id: 1,
      name: 'Prod1',
      price: 10.00,
      qty: 2,
      tax_rate: 16,
      discountType: 'fixed',
      discountValue: 1.00
    }];
    expect(s.cartReceiptPresentation).toBeDefined();
    const rows = s.cartReceiptPresentation.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].netAmount).toBe(18.00);
    expect(s.cartReceiptPresentation.summary.subtotal).toBe(18.00);
  });

  it('keeps same-product cart lines distinct by cartId', () => {
    const s = useOrderSessionStore();
    s.activeOrderTaxInclusive = false;
    s.cart = [
      { id: 1, cartId: 'burger-plain', name: 'Burger', note: '', price: 5, qty: 1, tax_rate: 16 },
      { id: 1, cartId: 'burger-cheese', name: 'Burger', note: 'Cheese', price: 5, qty: 1, tax_rate: 16 }
    ];

    expect(s.cartReceiptPresentation.rows.map(row => row.key)).toEqual([
      'burger-plain',
      'burger-cheese'
    ]);
  });

  it('guest check with a 20% order discount foots exactly', () => {
    const s = useOrderSessionStore();
    s.activeOrderTaxInclusive = false;
    s.cart = [{
      id: 1,
      name: 'Prod1',
      price: 10.00,
      qty: 1,
      tax_rate: 16
    }];
    s.orderDiscount = { type: 'percent', value: 20 };
    expect(s.cartReceiptPresentation.summary.subtotal).toBe(10.00);
    expect(s.cartReceiptPresentation.summary.orderDiscountAmount).toBe(2.00);
    expect(s.cartReceiptPresentation.summary.taxAmount).toBe(1.28);
    expect(s.cartReceiptPresentation.summary.total).toBe(9.28);
  });

  it('inclusive guest check does not gross line tax a second time', () => {
    const s = useOrderSessionStore();
    s.activeOrderTaxInclusive = true;
    s.cart = [{
      id: 1,
      name: 'Prod1',
      price: 11.60,
      qty: 1,
      tax_rate: 16
    }];
    expect(s.cartReceiptPresentation.summary.subtotal).toBe(11.60);
    expect(s.cartReceiptPresentation.summary.taxAmount).toBe(0.00);
    expect(s.cartReceiptPresentation.summary.total).toBe(11.60);
  });

    it('checkout stores the server-returned v1 object unchanged even if the cart snapshot differs', async () => {
    const mockV1 = {
      version: 1,
      taxMode: 'exclusive',
      status: 'original',
      currency: 'JD',
      decimals: 2,
      rows: [{ key: '1', kind: 'item', name: 'Item', qty: 1, unitPrice: 10, extendedPrice: 10, lineDiscountAmount: 0, netAmount: 10 }],
      summary: { subtotal: 10, orderDiscountAmount: 0, taxAmount: 0, roundingAdjustment: 0, total: 10 }
    };
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({
        success: true,
        invoice_id: 42,
        order_id: 1,
        subtotal: 10,
        tax: 0,
        total: 10,
        discount: 0,
        payment_method: 'cash',
        amount_tendered: 10.00,
        change_due: 0,
        receipt_display_v1: mockV1
      })
    }));
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, price: 10.00, qty: 1, tax_rate: 0 }];
    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10.00, change_due: 0 });
    expect(mockTerminalState.lastOrder.value).not.toBeNull();
    expect(mockTerminalState.lastOrder.value.receipt_display_v1).toEqual(mockV1);
  });

  it('restoreTableSplit re-attaches selectedModifiers from split items', async () => {
    const store = useOrderSessionStore();
    store.orderTypes = [{id:1,name:'Dine In'},{id:4,name:'Delivery'}];
    store.selectedOrderType = 1;
    const splitCheck = {
        id: 77, table_id: 5,
        order_type_id: 4,
        reference_name: 'Table 5 - Seat 1',
        items: [{
            id: 1, name: 'Burger', price: 5.5, qty: 1, note: 'Size: Large (0.50 JD)',
            order_item_id: 42,
            selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }]
        }],
        parent_invoice_id: 9, parent_order_id: 3
    };
    await store.restoreTableSplit(splitCheck, {});
    expect(store.cart[0].selectedModifiers).toEqual(splitCheck.items[0].selectedModifiers);
    expect(store.selectedOrderType).toBe(4);
  });
});

describe('order draft context persistence across refresh', () => {
  const cart = [{ id: 1, product_id: 1, name: 'Tea', price: 5, qty: 1, tax_rate: 8, discountType: null, discountValue: 0 }];
  const context = (overrides = {}) => ({
    version: 2,
    scope: { kind: 'register', id: null },
    selectedOrderType: 4,
    hashNumber: 'HASH-7',
    customerPhone: '0790000000',
    customerName: 'Jane',
    customerAddress: 'Amman',
    orderDate: '2026-08-01T12:30',
    restoredHeldReference: '',
    taxRegistrationType: null,
    subscriptionPurchase: null,
    ...overrides,
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({ success: true, data: [] })
    }));
    window.showPosToast = vi.fn();
  });

  it('persists and refreshes the complete active-table identity', async () => {
    const s = useOrderSessionStore();
    s.activeTable = {
      id: 7,
      current_order_id: 707,
      split_check_id: null,
      table_number: 'A7',
      is_split: false,
    };
    s.cart = [...cart];
    await nextTick();

    expect(JSON.parse(localStorage.getItem('pos_order_context'))).toMatchObject({
      version: 2,
      scope: { kind: 'table', id: '7', orderId: '707', splitCheckId: null, tableNumber: 'A7' },
    });

    s.activeTable.current_order_id = 808;
    s.activeTable.split_check_id = 77;
    s.activeTable.table_number = 'A7-1';
    s.activeTable.is_split = true;
    await nextTick();

    expect(JSON.parse(localStorage.getItem('pos_order_context')).scope).toEqual({
      kind: 'table', id: '7', orderId: '808', splitCheckId: '77', tableNumber: 'A7-1'
    });
  });

  it('hydrates a split draft only when active storage identifies the same split check', () => {
    const splitContext = context({
      scope: { kind: 'table', id: '7', orderId: null, splitCheckId: '77', tableNumber: 'A7-1' },
      customerName: 'Split Guest',
    });
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_order_context', JSON.stringify(splitContext));
    localStorage.setItem('pos_active_table', JSON.stringify({
      id: 7, table_number: 'A7-2', is_split: true, split_check_id: 78
    }));
    const wrongSplit = useOrderSessionStore();
    wrongSplit.loadSavedOrder();
    expect(wrongSplit.cart).toEqual([]);

    setActivePinia(createPinia());
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_order_context', JSON.stringify(splitContext));
    localStorage.setItem('pos_active_table', JSON.stringify({
      id: 7, table_number: 'A7-1', is_split: true, split_check_id: 77
    }));
    const exactSplit = useOrderSessionStore();
    exactSplit.loadSavedOrder();
    expect(exactSplit.cart).toEqual(cart);
    expect(exactSplit.customerName).toBe('Split Guest');
  });

  it('applies the configured default to a legacy cart that has no saved context', async () => {
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    const s = useOrderSessionStore();
    s.loadSavedOrder();
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({ success: true, data: [{ id: 1, name: 'Dine In', is_default: true }] })
    }));

    await s.fetchOrderTypes();

    expect(s.selectedOrderType).toBe(1);
  });

  it('restores manual checkout context and a held tax registration after refresh', () => {
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_order_context', JSON.stringify(context({
      scope: { kind: 'held', id: 'REF-7' },
      restoredHeldReference: 'REF-7',
      taxRegistrationType: 'income_tax'
    })));

    const s = useOrderSessionStore();
    s.loadSavedOrder();

    expect(s.selectedOrderType).toBe(4);
    expect(s.hashNumber).toBe('HASH-7');
    expect(s.customerPhone).toBe('0790000000');
    expect(s.customerName).toBe('Jane');
    expect(s.customerAddress).toBe('Amman');
    expect(s.orderDate).toBe('2026-08-01T12:30');
    expect(s.restoredHeldReference).toBe('REF-7');
    expect(s.taxRegistrationType).toBe('income_tax');
  });

  it('replaces a removed selected order type and clears its hash', async () => {
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_order_context', JSON.stringify(context()));
    const s = useOrderSessionStore();
    s.loadSavedOrder();
    global.fetch = vi.fn(() => Promise.resolve({
      json: () => Promise.resolve({ success: true, data: [{ id: 1, name: 'Dine In', is_default: true }] })
    }));

    await s.fetchOrderTypes();

    expect(s.selectedOrderType).toBe(1);
    expect(s.hashNumber).toBe('');
    expect(window.showPosToast).toHaveBeenCalledTimes(1);
  });

  it('does not let a fallback cache invalidate a saved register order type', async () => {
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_order_context', JSON.stringify(context()));
    localStorage.setItem('pos_backup_order_types', JSON.stringify({
      data: [{ id: 1, name: 'Dine In', is_default: true }],
      savedAt: Date.now(),
    }));
    const s = useOrderSessionStore();
    s.loadSavedOrder();
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

    await s.fetchOrderTypes();

    expect(s.selectedOrderType).toBe(4);
    expect(s.hashNumber).toBe('HASH-7');
    expect(window.showPosToast).not.toHaveBeenCalled();
  });

  it('treats malformed live order-type data as unavailable fallback data', async () => {
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_order_context', JSON.stringify(context()));
    localStorage.setItem('pos_backup_order_types', JSON.stringify({
      data: [{ id: 1, name: 'Dine In', is_default: true }],
      savedAt: Date.now(),
    }));
    const s = useOrderSessionStore();
    s.loadSavedOrder();
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: { id: 1 } })
    });

    await s.fetchOrderTypes();

    expect(s.orderTypes).toEqual([{ id: 1, name: 'Dine In', is_default: true }]);
    expect(s.selectedOrderType).toBe(4);
    expect(s.hashNumber).toBe('HASH-7');
  });

  it.each(['types-first', 'table-first'])('reconciles stale table context from live authority (%s)', async (ordering) => {
    const s = useOrderSessionStore();
    const loadTableContext = () => s.loadTableOrder(
      { id: 7, table_number: '7', status: 'occupied', current_order_id: 707 },
      [{ id: 70, name: 'Server item', price: 5, qty: 1, tax_rate: 8 }],
      707,
      77,
      {
        persistedOrderSnapshot: {
          context: context({
            scope: { kind: 'table', id: '7', orderId: '707', splitCheckId: null, tableNumber: '7' },
            selectedOrderType: 999,
            hashNumber: 'STALE-HASH',
          })
        }
      }
    );
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: [{ id: 1, name: 'Dine In', is_default: true }] })
    });

    if (ordering === 'types-first') await s.fetchOrderTypes();
    loadTableContext();
    if (ordering === 'table-first') await s.fetchOrderTypes();

    expect(s.selectedOrderType).toBe('');
    expect(s.hashNumber).toBe('');
    expect(window.showPosToast).toHaveBeenCalledTimes(1);
  });

  it('does not let cached types invalidate table context after cache-first hydration', async () => {
    localStorage.setItem('pos_backup_order_types', JSON.stringify({
      data: [{ id: 1, name: 'Dine In', is_default: true }],
      savedAt: Date.now(),
    }));
    const s = useOrderSessionStore();
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    await s.fetchOrderTypes();

    s.loadTableOrder(
      { id: 7, table_number: '7', status: 'occupied', current_order_id: 707 },
      [{ id: 70, name: 'Server item', price: 5, qty: 1, tax_rate: 8 }],
      707,
      77,
      {
        persistedOrderSnapshot: {
          context: context({
            scope: { kind: 'table', id: '7', orderId: '707', splitCheckId: null, tableNumber: '7' },
            selectedOrderType: 4,
            hashNumber: 'VALID-HASH',
          })
        }
      }
    );

    expect(s.selectedOrderType).toBe(4);
    expect(s.hashNumber).toBe('VALID-HASH');
    expect(window.showPosToast).not.toHaveBeenCalled();
  });

  it('reconciles a stale held-order type from a successful live response', async () => {
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_order_context', JSON.stringify(context({
      scope: { kind: 'held', id: 'REF-7' },
      restoredHeldReference: 'REF-7',
      selectedOrderType: 999,
      hashNumber: 'STALE-HASH',
    })));
    const s = useOrderSessionStore();
    s.loadSavedOrder();
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: [{ id: 1, name: 'Dine In', is_default: true }] })
    });

    await s.fetchOrderTypes();

    expect(s.selectedOrderType).toBe(1);
    expect(s.hashNumber).toBe('');
    expect(window.showPosToast).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile order type while editing a non-table invoice', async () => {
    const s = useOrderSessionStore();
    s.editingInvoiceId = 707;
    s.selectedOrderType = 999;
    s.hashNumber = 'EDIT-HASH';
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: [{ id: 1, name: 'Dine In', is_default: true }] })
    });

    await s.fetchOrderTypes();

    expect(s.selectedOrderType).toBe(999);
    expect(s.hashNumber).toBe('EDIT-HASH');
    expect(window.showPosToast).not.toHaveBeenCalled();
  });

  it('does not clear orphan order fields when the saved cart is invalid', () => {
    localStorage.setItem('pos_order_note', 'stale note');
    localStorage.setItem('pos_order_discount', JSON.stringify({ type: 'fixed', value: 2 }));
    localStorage.setItem('pos_service_charge_snapshot', JSON.stringify({ id: 9 }));
    localStorage.setItem('pos_order_context', JSON.stringify(context()));
    localStorage.setItem('pos_cart', JSON.stringify({ id: 1 }));
    const s = useOrderSessionStore();
    s.loadSavedOrder();

    expect(s.cart).toEqual([]);
    expect(localStorage.getItem('pos_order_note')).toBeNull();
    expect(localStorage.getItem('pos_order_discount')).toBeNull();
    expect(localStorage.getItem('pos_service_charge_snapshot')).toBeNull();
    expect(localStorage.getItem('pos_order_context')).toBeNull();
  });

  it('keeps the checkout fingerprint stable while transient payment input resets', () => {
    localStorage.setItem('pos_cart', JSON.stringify(cart));
    localStorage.setItem('pos_order_context', JSON.stringify(context()));
    const first = useOrderSessionStore();
    first.loadSavedOrder();
    const firstUi = useOrderUiStore();
    firstUi.paymentMethod = 'card';
    firstUi.amountTendered = 99;
    firstUi.splitCardAmount = 2;
    first.openCheckoutModal();
    const firstKey = firstUi.activeIdempotencyKey;
    firstUi.closeCheckoutModal();

    setActivePinia(createPinia());
    const second = useOrderSessionStore();
    second.loadSavedOrder();
    second.openCheckoutModal();
    const secondUi = useOrderUiStore();

    expect(secondUi.activeIdempotencyKey).toBe(firstKey);
    expect(secondUi.paymentMethod).toBe('cash');
    expect(secondUi.amountTendered).toBe(5.4);
    expect(secondUi.splitCardAmount).toBeNull();
  });
});








describe('checkout audit recovery regressions', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); localStorage.clear(); vi.clearAllMocks();
    mockAuthState.activeUser.value = { id: 1, name: 'Cashier', role: 'cashier' };
    mockAuthState.activeShift.value = { id: 9 };
    mockProductsState.settings.value = { stock_enabled: '0', tables_enabled: '1', service_charge_enabled: '0' };
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockResolvedValue(true);
    mockTerminalState.dispatchToNodeSpooler.mockResolvedValue({ success: true });
    mockTerminalState.printMethod.value = 'frontend';
  });
  afterEach(() => vi.restoreAllMocks());
  const sale = extra => ({ response: { ok: true, status: 200 }, data: { success: true, invoice_id: 901, order_id: 7, subtotal: 5, tax: 0, total: 5, discount: 0, payment_method: 'cash', ...extra } });
  const prepare = () => { const s = useOrderSessionStore(); s.cart = [{ id: 1, name: 'Coffee', qty: 1, price: 5, tax_rate: 0 }]; s.openCheckoutModal(); return s; };
  it.each([
    ['cash', null],
    ['platform', 'Platform sale recorded · No payment was collected.'],
    ['receivable', 'Receivable Issued · No payment was collected.'],
  ])('does not flash a blocking success dialog after %s checkout', async (paymentMethod, message) => {
    vi.spyOn(orderSessionApi, 'checkoutOrder').mockResolvedValue(sale({ payment_method: paymentMethod }));
    const s = prepare();
    await s.processCheckout();
    expect(useOrderUiStore().showCheckoutModal).toBe(false);
    expect(window.showPosAlert).not.toHaveBeenCalled();
    if (message) expect(window.showPosToast).toHaveBeenCalledWith(message, 'success');
    else expect(window.showPosToast).not.toHaveBeenCalled();
  });
  it('does not flash a success notification before leaving a paid table', async () => {
    mockAuthState.activeUser.value = { id: 1, name: 'Manager', role: 'admin' };
    window.location.href = '';
    vi.spyOn(orderSessionApi, 'checkoutOrder').mockResolvedValue(sale({ payment_method: 'platform' }));
    const s = useOrderSessionStore();
    s.activeTable = { id: 7, table_number: '7', status: 'occupied', current_order_id: 70 };
    s.cart = [{ id: 1, name: 'Coffee', qty: 1, price: 5, tax_rate: 0 }];
    s.openCheckoutModal();

    await s.processCheckout();

    expect(window.location.href).toBe('/tables');
    expect(window.showPosAlert).not.toHaveBeenCalled();
    expect(window.showPosToast).not.toHaveBeenCalledWith(
      expect.stringContaining('Platform sale recorded'), 'success'
    );
  });
  it.each([
    ['backend', true],
    ['browser', false],
  ])('leaves a paid table through the router (%s printing leaves before the print settles: %s)', async (method, leavesAtOnce) => {
    const previousMethod = mockTerminalState.printMethod.value;
    mockTerminalState.printMethod.value = method;
    try {
      mockAuthState.activeUser.value = { id: 1, name: 'Manager', role: 'admin' };
      window.location.href = '';
      let finishPrint;
      mockTerminalState.printReceipt.mockImplementationOnce(() => new Promise((resolve) => { finishPrint = resolve; }));
      vi.spyOn(orderSessionApi, 'checkoutOrder').mockResolvedValue(sale());
      const router = { push: vi.fn() };
      const s = useOrderSessionStore();
      s.activeTable = { id: 7, table_number: '7', status: 'occupied', current_order_id: 70 };
      s.cart = [{ id: 1, name: 'Coffee', qty: 1, price: 5, tax_rate: 0 }];
      s.openCheckoutModal();

      await s.processCheckout({ router });

      // Spooler fetches survive an SPA navigation; the browser print renders inside the POS view.
      expect(router.push).toHaveBeenCalledTimes(leavesAtOnce ? 1 : 0);
      finishPrint(true);
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
      expect(router.push).toHaveBeenCalledWith('/tables');
      expect(window.location.href).toBe('');
    } finally {
      mockTerminalState.printMethod.value = previousMethod;
    }
  });
  it('finalizes a committed sale with invalid receipt data without a second Pay or misleading network error', async () => {
    const request = vi.spyOn(orderSessionApi, 'checkoutOrder').mockResolvedValue(sale({ receipt_display_v1: { rows: [] } }));
    const s = prepare(); await s.processCheckout();
    expect(s.cart).toEqual([]); expect(useOrderUiStore().checkoutError).toBe('');
    expect(mockTerminalState.lastOrder.value.receipt_display_error).toBeTruthy();
    expect(mockTerminalState.printReceipt).not.toHaveBeenCalled();
    await s.processCheckout(); expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['cash', 'split'])('retries the exact submitted %s request after timeout, modal reset, and store reload', async method => {
    const request = vi.spyOn(orderSessionApi, 'checkoutOrder').mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(sale());
    let s = prepare(); let ui = useOrderUiStore(); ui.paymentMethod = method; ui.amountTendered = 20; ui.splitCardAmount = 2; ui.splitCashTendered = 10;
    await s.processCheckout(); const original = request.mock.calls[0][0];
    ui.closeCheckoutModal(); await nextTick(); setActivePinia(createPinia()); s = useOrderSessionStore(); s.loadSavedOrder(); s.openCheckoutModal();
    await s.processCheckout(); expect(request.mock.calls[1][0]).toEqual(original); expect(s.cart).toEqual([]);
  });
  it('recovers the old sale without charging or clearing a changed cart', async () => {
    const request = vi.spyOn(orderSessionApi, 'checkoutOrder').mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(sale());
    const s = prepare(); await s.processCheckout(); s.startNewOrder(); s.cart = [{ id: 2, name: 'New sale', qty: 2, price: 5, tax_rate: 0 }];
    await s.processCheckout(); expect(request.mock.calls[1][0]).toEqual(request.mock.calls[0][0]); expect(s.cart[0].qty).toBe(2);
    expect(window.showPosToast).toHaveBeenCalledWith('Previous sale completed. Your current draft was kept.', 'warning');
  });
  it('blocks Pay during hold and remains busy if activation clears the UI flag', async () => {
    let release; const request = vi.spyOn(orderSessionApi, 'checkoutOrder').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const s = prepare(), ui = useOrderUiStore(); ui.isHolding = true; await s.processCheckout(); expect(request).not.toHaveBeenCalled();
    ui.isHolding = false; const first = s.processCheckout(); ui.isProcessing = false; await s.processCheckout(); expect(request).toHaveBeenCalledTimes(1);
    release(sale()); await first;
  });
  it('keeps an authoritative split table id even without its floor row', async () => {
    const s = useOrderSessionStore(); s.restaurantTables = [{ id: 999, table_number: 'Other' }];
    expect(await s.restoreTableSplit({ id: 80, table_id: 7, parent_invoice_id: 100, split_revision: 3, reference_name: 'Renamed table', items: [{ id: 1, price: 5, qty: 1 }] }, { router: { push: vi.fn() } })).toBe(true);
    expect(s.activeTable).toMatchObject({ id: 7, parent_invoice_id: 100, split_check_id: 80, split_revision: 3 });
  });
  it('never restores a check to a table inferred from its display name', async () => {
    const s = prepare();
    s.restaurantTables = [{ id: 7, table_number: '1', current_order_id: 200 }];
    const before = JSON.stringify(s.cart);
    expect(await s.restoreTableSplit({ id: 80, parent_invoice_id: 100, reference_name: 'Table 1 - Seat 1', items: [{ id: 1, price: 5, qty: 1 }] })).toBe(false);
    expect(JSON.stringify(s.cart)).toBe(before);
    expect(s.activeTable).toBeNull();
    expect(window.showPosAlert).toHaveBeenCalledWith('This check has no table identity. Reload the Split Board.');
  });
  it('keeps the structured split-parent error available to floor navigation', async () => {
    const s = prepare();
    vi.spyOn(orderSessionApi, 'getTableDraft').mockResolvedValue({ data: { success: true, cart: [] } });
    vi.spyOn(orderSessionApi, 'getTableOrder').mockResolvedValue({ data: { success: false, code: 'SPLIT_CHECKS_OPEN', message: 'Unpaid splits' } });
    await expect(s.loadActiveTableOrder({ id: 7, current_order_id: 100, table_number: '1', status: 'occupied' })).rejects.toMatchObject({ code: 'SPLIT_CHECKS_OPEN' });
  });
  it('keeps the public order-type action safe for clearing and synchronizes settlement', async () => {
    const s = prepare();
    s.orderTypes = [{ id: 3, is_deferred_settlement: 1 }];
    await s.handleOrderTypeSelection(s.orderTypes[0]);
    expect(useOrderUiStore().paymentMethod).toBe('platform');
    await s.handleOrderTypeSelection(null);
    expect(s.selectedOrderType).toBeNull();
    expect(useOrderUiStore().paymentMethod).toBe('cash');
  });
  it('offers recovery even when the cashier has cleared the register draft', async () => {
    const request = vi.spyOn(orderSessionApi, 'checkoutOrder').mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(sale());
    const s = prepare();
    await s.processCheckout();
    s.startNewOrder();
    s.openCheckoutModal();
    expect(useOrderUiStore().showCheckoutModal).toBe(true);
    expect(s.pendingCheckout.frozen.payload.total).toBe(5);
    await s.processCheckout();
    expect(request.mock.calls[1][0]).toEqual(request.mock.calls[0][0]);
    expect(s.pendingCheckout).toBeNull();
    expect(localStorage.getItem('pos_pending_checkout:1')).toBeNull();
  });
  it('does not discard an uncertain request when retry loses authorization', async () => {
    const request = vi.spyOn(orderSessionApi, 'checkoutOrder')
      .mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValueOnce({ response: { ok: false, status: 403 }, data: { success: false, message: 'Sign in again' } })
      .mockResolvedValueOnce(sale());
    const s = prepare();
    await s.processCheckout();
    await s.processCheckout();
    expect(s.pendingCheckout).not.toBeNull();
    await s.processCheckout();
    expect(request.mock.calls[2][0]).toEqual(request.mock.calls[0][0]);
    expect(s.pendingCheckout).toBeNull();
  });
  it('keeps manager credentials out of recovery storage and requires fresh authority on retry', async () => {
    mockAuthState.isTempAdmin = { value: true };
    mockAuthState.activeManagerPin = { value: 'test-only-pin' };
    const request = vi.spyOn(orderSessionApi, 'checkoutOrder').mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(sale());
    try {
      const s = prepare();
      await s.processCheckout();
      expect(localStorage.getItem('pos_pending_checkout:1')).toBeTruthy();
      expect(localStorage.getItem('pos_pending_checkout:1')).not.toContain('test-only-pin');
      mockAuthState.activeManagerPin.value = 'renewed-test-pin';
      await s.processCheckout();
      expect(request.mock.calls[1][0].manager_pin).toBe('renewed-test-pin');
      expect(request.mock.calls[1][0].idempotency_key).toBe(request.mock.calls[0][0].idempotency_key);
    } finally {
      delete mockAuthState.isTempAdmin;
      delete mockAuthState.activeManagerPin;
    }
  });
  it('does not let a delayed split restore replace a newer register draft', async () => {
    let release;
    vi.spyOn(orderSessionApi, 'getTables').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const s = useOrderSessionStore();
    const check = { id: 90, reference_name: 'Table 7 - Check 1', items: [{ id: 1, qty: 1, price: 5 }] };
    const first = s.restoreTableSplit(check, { router: { push: vi.fn() } });
    await nextTick();
    expect(await s.restoreTableSplit({ ...check, id: 91 })).toBe(false);
    s.startNewOrder();
    s.cart = [{ id: 2, name: 'New draft', qty: 1, price: 6 }];
    release({ data: { success: true, tables: [{ id: 7, table_number: '7' }] } });
    expect(await first).toBe(false);
    expect(s.activeTable).toBeNull();
    expect(s.cart[0].name).toBe('New draft');
  });
});
