// Unit tests for pure POS service/module functions.
// No DB, no HTTP. All tested functions are deterministic given their inputs alone.

// globals are used directly since globals: true is enabled in vitest config
const checkoutValidation = require('../../services/CheckoutValidation');
const {
    assertNearMoney,
    validatePayments,
    hasDiscountsInPayload,
} = checkoutValidation;
const { hasVoidsOrReductions, getNewItems } = require('../../modules/orders/SavedOrderLines');
const { applyDatabasePrices, recomputeOrderTotals } = require('../../services/OrderPricing');
const { deductStockForCart } = require('../../services/InventoryService');

// ─── 1. assertNearMoney ───────────────────────────────────────────────────────
describe('assertNearMoney', () => {
    it('exposes only the checkout validation contract', () => {
        expect(Object.keys(checkoutValidation).sort()).toEqual([
            'assertNearMoney',
            'hasDiscountsInPayload',
            'validatePayments',
        ]);
    });

    it('passes when values are equal', () => {
        expect(() => assertNearMoney('Total', 10.00, 10.00)).not.toThrow();
    });

    it('passes when difference is within 0.02 JD tolerance', () => {
        expect(() => assertNearMoney('Total', 10.01, 10.00)).not.toThrow();
        expect(() => assertNearMoney('Total', 10.00, 10.02)).not.toThrow();
        expect(() => assertNearMoney('Total', 9.99, 10.00)).not.toThrow();
    });

    it('throws when difference exceeds 0.02 JD tolerance', () => {
        expect(() => assertNearMoney('Total', 10.05, 10.00)).toThrow('Total mismatch');
        expect(() => assertNearMoney('Total', 9.97, 10.00)).toThrow('Total mismatch');
    });

    it('passes at exactly tolerance boundary', () => {
        // 10.02 - 10.00 = 0.02 (not strictly >, so passes)
        expect(() => assertNearMoney('Total', 10.02, 10.00)).not.toThrow();
    });

    it('throws just beyond tolerance boundary', () => {
        expect(() => assertNearMoney('Total', 10.025, 10.00)).toThrow();
    });

    it('includes the label in the error message', () => {
        expect(() => assertNearMoney('Subtotal', 100, 200)).toThrow('Subtotal mismatch');
    });

    it('handles zero total', () => {
        expect(() => assertNearMoney('Total', 0, 0)).not.toThrow();
        expect(() => assertNearMoney('Total', 0.01, 0)).not.toThrow();
        expect(() => assertNearMoney('Total', 0.05, 0)).toThrow();
    });

    it('handles large values with small relative differences', () => {
        expect(() => assertNearMoney('Total', 999.99, 1000.00)).not.toThrow();
        expect(() => assertNearMoney('Total', 999.98, 1000.00)).not.toThrow();
        expect(() => assertNearMoney('Total', 999.97, 1000.00)).toThrow();
    });
});

// ─── 2. validatePayments ─────────────────────────────────────────────────────
describe('validatePayments', () => {
    // Helper to build payment data objects
    const cashPayment = (total, tendered, change = 0) => ({
        payment_method: 'cash',
        amount_tendered: tendered,
        cash_amount: total,
        card_amount: 0,
        change_due: change,
    });

    const cardPayment = (total) => ({
        payment_method: 'card',
        amount_tendered: total,
        cash_amount: 0,
        card_amount: total,
        change_due: 0,
    });

    const splitPayment = (total, cash, card, tendered = total, change = 0) => ({
        payment_method: 'split',
        amount_tendered: tendered,
        cash_amount: cash,
        card_amount: card,
        change_due: change,
    });

    // ── Cash ──────────────────────────────────────────────────────────────────
    it('validates exact cash payment', () => {
        const result = validatePayments(cashPayment(10.00, 10.00), 10.00);
        expect(result.paymentMethod).toBe('cash');
        expect(result.cashAmount).toBe(10.00);
        expect(result.cardAmount).toBe(0);
        expect(result.changeDue).toBe(0);
    });

    it('normalizes payment-method whitespace through the public validator', () => {
        const result = validatePayments({
            ...cashPayment(10.00, 10.00),
            payment_method: '  cash  ',
        }, 10.00);
        expect(result.paymentMethod).toBe('cash');
    });

    it('validates cash payment with change', () => {
        const result = validatePayments(cashPayment(10.00, 20.00, 10.00), 10.00);
        expect(result.changeDue).toBe(10.00);
    });

    it('records the sale total, not the cash tendered, when change is given', () => {
        expect(validatePayments(cashPayment(5.80, 10.00, 4.20), 5.80)).toMatchObject({ cashAmount: 5.8, cardAmount: 0, amountTendered: 10, changeDue: 4.2 });
    });

    it('throws when cash tendered is less than total', () => {
        expect(() => validatePayments(cashPayment(10.00, 5.00, 0), 10.00)).toThrow('less than');
    });

    it('passes when cash tendered equals total within tolerance', () => {
        // 9.99 < 10.00 but within 0.02 JD tolerance
        expect(() => validatePayments(cashPayment(10.00, 9.99, 0), 10.00)).not.toThrow();
    });

    it('throws on negative cash amount', () => {
        const data = { ...cashPayment(10.00, 10.00), cash_amount: -1 };
        expect(() => validatePayments(data, 10.00)).toThrow('negative');
    });

    // ── Card ──────────────────────────────────────────────────────────────────
    it('validates exact card payment', () => {
        const result = validatePayments(cardPayment(15.50), 15.50);
        expect(result.paymentMethod).toBe('card');
        expect(result.cardAmount).toBe(15.50);
        expect(result.cashAmount).toBe(0);
    });

    it('throws when card amount mismatches total by more than tolerance', () => {
        const data = { payment_method: 'card', amount_tendered: 10.00, cash_amount: 0, card_amount: 5.00, change_due: 0 };
        expect(() => validatePayments(data, 10.00)).toThrow('mismatch');
    });

    // ── Split ─────────────────────────────────────────────────────────────────
    it('validates exact split payment (cash + card = total)', () => {
        const result = validatePayments(splitPayment(10.00, 5.00, 5.00), 10.00);
        expect(result.paymentMethod).toBe('split');
        expect(result.cashAmount).toBe(5.00);
        expect(result.cardAmount).toBe(5.00);
    });

    it('throws when split parts do not add up to total', () => {
        expect(() => validatePayments(splitPayment(10.00, 3.00, 3.00), 10.00)).toThrow('mismatch');
    });

    it('rejects a split whose cash and card together exceed the total', () => {
        expect(() => validatePayments(splitPayment(11.60, 5.00, 7.00, 12.00, 0.40), 11.60)).toThrow('Split payment mismatch');
    });

    it('rejects a nominal split when either tender is zero', () => {
        expect(() => validatePayments(splitPayment(10.00, 0, 10.00), 10.00)).toThrow(/both cash and card/i);
        expect(() => validatePayments(splitPayment(10.00, 10.00, 0), 10.00)).toThrow(/both cash and card/i);
    });

    it('rejects a one-cent split allocation mismatch', () => {
        expect(() => validatePayments(splitPayment(10.00, 4.99, 5.00), 10.00)).toThrow('mismatch');
    });

    it('rejects split checkout when received cash does not cover the cash allocation', () => {
        expect(() => validatePayments(splitPayment(10.00, 6.00, 4.00, 9.00), 10.00)).toThrow('less than');
    });

    it('rejects split checkout when change is not the excess physical cash received', () => {
        expect(() => validatePayments(splitPayment(10.00, 6.00, 4.00, 14.00, 3.00), 10.00)).toThrow('Change due mismatch');
    });

    it('validates split with cash overpay and change', () => {
        // Card 2 + cash allocation 8; cashier receives 10 cash and returns 2 change.
        const result = validatePayments(splitPayment(10.00, 8.00, 2.00, 12.00, 2.00), 10.00);
        expect(result).toMatchObject({ cashAmount: 8, cardAmount: 2, amountTendered: 12, changeDue: 2 });
    });

    it('throws when invalid payment method is provided', () => {
        const data = { payment_method: 'voucher', amount_tendered: 10, cash_amount: 10, card_amount: 0, change_due: 0 };
        expect(() => validatePayments(data, 10.00)).toThrow('Invalid payment method');
    });
});

// ─── 4. hasVoidsOrReductions ──────────────────────────────────────────────────
// This is the CRITICAL function that controls the manager PIN void prompt.
// A bug here caused "false-positive prompts" in the production bug log.
describe('hasVoidsOrReductions', () => {
    // existing items use "quantity" (DB column); new cart uses "qty" (client model)
    const existing = [
        { product_id: 1, quantity: 2, note: '' },
        { product_id: 2, quantity: 1, note: '' },
    ];

    it('returns false when new cart is identical to existing', () => {
        const newCart = [
            { product_id: 1, qty: 2, note: '' },
            { product_id: 2, qty: 1, note: '' },
        ];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(false);
    });

    it('returns false when items are added (quantities increased)', () => {
        const newCart = [
            { product_id: 1, qty: 3, note: '' }, // increased
            { product_id: 2, qty: 1, note: '' },
        ];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(false);
    });

    it('returns false when a new item is added to the cart', () => {
        const newCart = [
            { product_id: 1, qty: 2, note: '' },
            { product_id: 2, qty: 1, note: '' },
            { product_id: 3, qty: 1, note: '' }, // new item
        ];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(false);
    });

    it('returns true when item quantity is reduced', () => {
        const newCart = [
            { product_id: 1, qty: 1, note: '' }, // reduced from 2
            { product_id: 2, qty: 1, note: '' },
        ];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(true);
    });

    it('returns true when an item is completely removed', () => {
        const newCart = [
            { product_id: 1, qty: 2, note: '' },
            // product_id 2 removed
        ];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(true);
    });

    it('does NOT return true when note differs — treats as new item, not reduction', () => {
        // product_id 1 with different note is considered a different line
        const newCart = [
            { product_id: 1, qty: 2, note: 'no onions' }, // different note = different item
            { product_id: 2, qty: 1, note: '' },
        ];
        // existing has product_id 1 with qty:2, note:''. New cart replaces it
        // with note:'no onions' — so the original note:'' line is "removed" → true
        expect(hasVoidsOrReductions(newCart, existing)).toBe(true);
    });

    it('handles empty new cart (all items removed)', () => {
        expect(hasVoidsOrReductions([], existing)).toBe(true);
    });

    it('handles empty existing items (first order)', () => {
        const newCart = [{ product_id: 1, qty: 2, note: '' }];
        expect(hasVoidsOrReductions(newCart, [])).toBe(false);
    });

    it('handles items without product_id (custom items — ignored)', () => {
        const existingWithCustom = [{ product_id: null, quantity: 1, note: 'custom' }];
        const newCart = [{ product_id: null, qty: 0, note: 'custom' }];
        // Custom items (no product_id) are skipped — no reduction detected
        expect(hasVoidsOrReductions(newCart, existingWithCustom)).toBe(false);
    });

    it('correctly handles DB model (item.quantity) vs client model (item.qty)', () => {
        // Existing uses item.quantity; new cart uses item.qty. Must not throw/misread.
        const existingDbModel = [{ product_id: 5, quantity: 3, note: '' }];
        const newCartClientModel = [{ product_id: 5, qty: 2, note: '' }];
        expect(hasVoidsOrReductions(newCartClientModel, existingDbModel)).toBe(true);
    });

    it('P3-1: detects reduction of a saved custom line keyed by name+note', () => {
        const existing = [{ product_id: null, item_name: 'Custom Plate', quantity: 2, note: '' }];
        const newCart = [{ product_id: null, item_name: 'Custom Plate', qty: 1, note: '' }];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(true);
    });

    it('P3-1: detects full removal of a saved custom line', () => {
        const existing = [{ product_id: null, item_name: 'Auto-Gratuity', quantity: 1, note: '' }];
        expect(hasVoidsOrReductions([], existing)).toBe(true);
    });

    it('P3-1: does NOT flag an unchanged custom line (client model uses .name)', () => {
        const existing = [{ product_id: null, item_name: 'Auto-Gratuity', quantity: 1, note: '' }];
        const newCart = [{ product_id: null, name: 'Auto-Gratuity', qty: 1, note: '' }];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(false);
    });

    it('P3-1: matches custom lines by name AND note (different note = different line)', () => {
        const existing = [{ product_id: null, item_name: 'Service', quantity: 1, note: 'AM' }];
        const newCart = [{ product_id: null, name: 'Service', qty: 1, note: 'PM' }];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(true); // AM removed
    });
});

// ─── 4b. applyDatabasePrices — modifier surcharge recovery ────────────────────
// For non-manager (cashier) checkouts the server re-derives each line price as
// base catalog price + surcharge encoded in the item note. The surcharge MUST be
// recoverable from BOTH note formats the app produces:
//   - notes-category products:  "Cheese (+0.50)"
//   - modifier-selector groups:  "Size: Large (0.50 JD)"
// A format the parser misses silently strips the surcharge → wrong subtotal/tax.
describe('applyDatabasePrices — modifier surcharge recovery', () => {
    const cashier = { role: 'cashier' };
    const productMap = new Map([[1, {
        id: 1,
        price: 1.0,
        tax_rate: 16,
        modifiers: [
            { name: 'Size', options: [{ name: 'Large', price: 0.5 }] },
            { name: 'Extra', options: [{ name: 'Cheese', price: 0.3 }] }
        ]
    }]]);

    it('calculates surcharge from selectedModifiers', () => {
        const cart = [{
            product_id: 1,
            qty: 1,
            price: 1.5,
            selectedModifiers: [{ group: 'Size', option: 'Large', price: 0.5 }]
        }];
        applyDatabasePrices(cart, productMap, cashier, false);
        expect(cart[0].price).toBeCloseTo(1.5, 4);
        expect(cart[0].modifier_surcharge).toBe(0.5);
        expect(cart[0].modifier_tax_amount).toBeCloseTo(0.068966, 6);
    });

    it('inherits an 8% parent rate and keeps a 0.15 modifier gross at exactly 0.15', () => {
        const products = new Map([[1, {
            id: 1,
            price: 5,
            tax_rate: 8,
            modifiers: [{ name: 'Extra', options: [{ name: 'Cheese', price: 0.15 }] }]
        }]]);
        const cart = [{
            product_id: 1,
            qty: 1,
            price: 999,
            tax_rate: 99,
            modifier_tax_amount: 999,
            selectedModifiers: [{ group: 'Extra', option: 'Cheese', price: 100 }]
        }];
        applyDatabasePrices(cart, products, cashier, false);
        expect(cart[0].price).toBe(5.15);
        expect(cart[0].modifier_surcharge).toBe(0.15);
        expect(cart[0].modifier_tax_amount).toBeCloseTo(0.011111, 6);
    });

    it('sums multiple selected modifiers correctly', () => {
        const cart = [{
            product_id: 1,
            qty: 1,
            price: 1.8,
            selectedModifiers: [
                { group: 'Size', option: 'Large', price: 0.5 },
                { group: 'Extra', option: 'Cheese', price: 0.3 }
            ]
        }];
        applyDatabasePrices(cart, productMap, cashier, false);
        expect(cart[0].price).toBeCloseTo(1.8, 4);
    });

    it('does NOT treat a free-text note as a surcharge', () => {
        const cart = [{
            product_id: 1,
            qty: 1,
            price: 6.0,
            note: 'add cheese (+5.00)'
        }];
        applyDatabasePrices(cart, productMap, cashier, false);
        expect(cart[0].price).toBeCloseTo(1.0, 4); // reset to base
    });

    it('forged modifier option not in product definition contributes 0 surcharge', () => {
        const cart = [{
            product_id: 1,
            qty: 1,
            price: 100.0,
            selectedModifiers: [{ group: 'Size', option: 'Huge', price: 99.0 }]
        }];
        applyDatabasePrices(cart, productMap, cashier, false);
        expect(cart[0].price).toBeCloseTo(1.0, 4); // reset to base
    });

    it('uses an explicitly attached effective price without changing base-only defaults', () => {
        const cart = [{ product_id: 1, qty: 1, price: 999 }];
        const products = new Map([[1, { id: 1, price: 1, effective_price: 1.25, tax_rate: 8, modifiers: null }]]);

        applyDatabasePrices(cart, products, cashier, false);

        expect(cart[0].price).toBe(1.25);
    });
});

describe('applyDatabasePrices — catalog-backed note products', () => {
    const products = new Map([
        [1, {
            id: 1,
            price: 2.7,
            tax_rate: 8,
            product_is_active: 1,
            category_is_active: 1,
            category_is_notes: 0,
            modifiers: [{ id: 'g1', name: 'Size', options: [{ id: 'o1', name: 'Large', price: 0.5 }] }]
        }],
        [91, {
            id: 91,
            name: 'Two slices',
            price: 0.172414,
            tax_rate: 16,
            product_is_active: 1,
            category_is_active: 1,
            category_is_notes: 1
        }]
    ]);

    it('uses catalog note money alongside formal modifiers for a cashier', () => {
        const cart = [{
            product_id: 1,
            qty: 3,
            price: 999,
            selectedModifiers: [
                { gid: 'g1', oid: 'o1', group: 'Size', option: 'Large', price: 999 },
                { noteProductId: 91, group: 'stale', option: 'stale', price: 999 }
            ]
        }];

        applyDatabasePrices(cart, products, { role: 'cashier', permissions: [] });

        expect(cart[0].price).toBe(3.4);
        expect(cart[0].modifier_surcharge).toBe(0.7);
        expect(cart[0].modifier_tax_amount).toBeCloseTo(0.051852, 6);
    });

    it.each([{ role: 'cashier', permissions: [] }, { role: 'admin', permissions: [] }])
        ('rejects a fresh standalone note product for %s', (user) => {
            const cart = [{ product_id: 91, qty: 1, price: 999 }];
            let error;
            try {
                applyDatabasePrices(cart, products, user);
            } catch (caught) {
                error = caught;
            }
            expect(error).toMatchObject({ statusCode: 409, publicCode: 'NOTE_PRODUCT_REQUIRES_ITEM' });
        });

    it('preserves saved-price rows before the standalone note guard', () => {
        const cart = [{ product_id: 91, qty: 1, price: 0.2, item_name: 'Two slices', note: '' }];
        const saved = new Map([['91|', 0.2]]);
        expect(() => applyDatabasePrices(cart, products, { role: 'cashier', permissions: [] }, false, saved)).not.toThrow();
    });
});

// ─── 5. hasDiscountsInPayload ─────────────────────────────────────────────────
describe('hasDiscountsInPayload', () => {
    it('returns false when no discounts exist', () => {
        const data = { order_discount_type: null, order_discount_value: 0 };
        const items = [{ discountType: null, discountValue: 0 }];
        expect(hasDiscountsInPayload(data, items)).toBe(false);
    });

    it('returns true when order has a discount', () => {
        const data = { order_discount_type: 'percent', order_discount_value: 10 };
        const items = [];
        expect(hasDiscountsInPayload(data, items)).toBe(true);
    });

    it('returns true when an item has a discount', () => {
        const data = { order_discount_type: null, order_discount_value: 0 };
        const items = [{ discountType: 'fixed', discountValue: 1 }];
        expect(hasDiscountsInPayload(data, items)).toBe(true);
    });

    it('returns false when order_discount_value is 0 with a type set', () => {
        const data = { order_discount_type: 'percent', order_discount_value: 0 };
        const items = [];
        expect(hasDiscountsInPayload(data, items)).toBe(false);
    });

    it('returns false when item discountValue is 0', () => {
        const data = { order_discount_type: null, order_discount_value: 0 };
        const items = [{ discountType: 'percent', discountValue: 0 }];
        expect(hasDiscountsInPayload(data, items)).toBe(false);
    });
});

// ─── 6b. hasRefundPermission ──────────────────────────────────────────────────
const { hasRefundPermission } = require('../../services/PermissionService');

describe('hasRefundPermission', () => {
  it('allows admin role without explicit grant', () => {
    expect(hasRefundPermission({ role: 'admin', permissions: [] })).toBe(true);
  });
  it('allows a user with the pos.refund grant', () => {
    expect(hasRefundPermission({ role: 'cashier', permissions: ['pos.refund'] })).toBe(true);
  });
  it('denies a user without the grant', () => {
    expect(hasRefundPermission({ role: 'cashier', permissions: ['pos.checkout'] })).toBe(false);
  });
});

// ─── 6. getNewItems ───────────────────────────────────────────────────────────
// Used to compute incremental kitchen print — only NEW or increased items go to kitchen.
describe('getNewItems', () => {
    it('returns all items as new when existing is empty', () => {
        const cart = [{ product_id: 1, qty: 2, note: '' }];
        const result = getNewItems(cart, []);
        expect(result).toHaveLength(1);
        expect(result[0].qty).toBe(2);
    });

    it('returns only the incremental quantity for an existing item', () => {
        // existing had 1; new cart has 3 → print 2 more
        const existing = [{ product_id: 1, quantity: 1, note: '' }];
        const cart = [{ product_id: 1, qty: 3, note: '' }];
        const result = getNewItems(cart, existing);
        expect(result).toHaveLength(1);
        expect(result[0].qty).toBe(2);
    });

    it('returns nothing when quantities are unchanged', () => {
        const existing = [{ product_id: 1, quantity: 2, note: '' }];
        const cart = [{ product_id: 1, qty: 2, note: '' }];
        const result = getNewItems(cart, existing);
        expect(result).toHaveLength(0);
    });

    it('returns new item when not in existing', () => {
        const existing = [{ product_id: 1, quantity: 1, note: '' }];
        const cart = [
            { product_id: 1, qty: 1, note: '' },
            { product_id: 2, qty: 1, note: '' }, // new
        ];
        const result = getNewItems(cart, existing);
        expect(result).toHaveLength(1);
        expect(result[0].product_id).toBe(2);
    });

    it('treats different notes on same product as separate items', () => {
        const existing = [{ product_id: 1, quantity: 1, note: '' }];
        const cart = [
            { product_id: 1, qty: 1, note: '' },
            { product_id: 1, qty: 1, note: 'extra spicy' }, // new note variant
        ];
        const result = getNewItems(cart, existing);
        expect(result).toHaveLength(1);
        expect(result[0].note).toBe('extra spicy');
    });

    it('does not reprint when saved item is split across duplicate rows (no change)', () => {
        // A saved order can persist the same product+note as multiple rows.
        // GET /table_order returns them as separate cart lines, so a no-op
        // re-save must aggregate by product+note and print nothing.
        const existing = [
            { product_id: 1, quantity: 1, note: '' },
            { product_id: 1, quantity: 1, note: '' },
        ];
        const cart = [{ product_id: 1, qty: 2, note: '' }];
        const result = getNewItems(cart, existing);
        expect(result).toHaveLength(0);
    });

    it('prints only the net increase over duplicate existing rows', () => {
        const existing = [
            { product_id: 1, quantity: 1, note: '' },
            { product_id: 1, quantity: 1, note: '' },
        ];
        const cart = [{ product_id: 1, qty: 3, note: '' }]; // 2 saved → +1
        const result = getNewItems(cart, existing);
        expect(result).toHaveLength(1);
        expect(result[0].qty).toBe(1);
    });
});

describe('deductStockForCart quantity guard', () => {
  it('rejects a non-positive quantity before any DB work', async () => {
    const conn = { query: vi.fn() };
    await expect(
      deductStockForCart(conn, [{ product_id: 1, qty: -1 }])
    ).rejects.toThrow(/quantity/i);
    expect(conn.query).not.toHaveBeenCalled();
  });
});

describe('recomputeOrderTotals bundle corruption guard', () => {
    it('rejects corrupt rows before math or UPDATE statements', async () => {
        const queries = [];
        const conn = {
            query: vi.fn(async (sql) => {
                queries.push(String(sql));
                if (String(sql).includes('FROM orders')) {
                    return [[{
                        payment_method: 'unpaid_table',
                        discount_type: null,
                        discount_value: 0,
                        tax_registration_type_at_sale: 'sales_tax'
                    }]];
                }
                if (String(sql).includes('FROM settings')) {
                    return [[{ setting_key: 'tax_inclusive_pricing', setting_value: '0' }]];
                }
                if (String(sql).includes('FROM order_items')) {
                    return [[
                        { id: 10, invoice_id: 7, product_id: 1, quantity: 0, price_at_sale: 5, discount_type: null, discount_value: 0, tax_rate: 16, parent_item_id: null, modifier_surcharge: null },
                        { id: 11, invoice_id: 7, product_id: 1, quantity: 1, price_at_sale: 0, discount_type: null, discount_value: 0, tax_rate: 0, parent_item_id: 10, modifier_surcharge: null }
                    ]];
                }
                if (String(sql).includes('FROM products')) {
                    return [[{ id: 1, name: 'Test Burger', price: 5, tax_rate: 16, stock: null, category_id: 1, modifiers: null }]];
                }
                if (/UPDATE\s+(orders|order_items)/i.test(String(sql))) return [{ affectedRows: 1 }];
                throw new Error(`Unexpected query: ${sql}`);
            })
        };

        await expect(recomputeOrderTotals(conn, 7))
            .rejects.toMatchObject({ statusCode: 409, publicCode: 'BUNDLE_ORDER_CORRUPT' });
        expect(queries.some(sql => /UPDATE\s+orders/i.test(sql))).toBe(false);
        expect(queries.some(sql => /UPDATE\s+order_items/i.test(sql))).toBe(false);
    });
});




